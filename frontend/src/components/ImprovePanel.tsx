import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Eye, History, Loader2, RotateCcw, Sparkles, X } from 'lucide-react'
import type {
  EvalRunSummary,
  ImprovementSuggestion,
  SkillVersion,
} from '../types'
import {
  createSkillVersion,
  listEvalRuns,
  listSkillVersions,
  restoreSkillVersion,
  suggestImprovements,
} from '../api'
import DiffModal from './DiffModal'

interface Props {
  sessionId: string
  skillBody: string
  onSkillBodyChange: (body: string) => void
  /** Navigate back to Evaluations tab — shown as a CTA after saving a new version. */
  onRequestEvaluate?: () => void
  /** When true, the panel kicks off 'Analyze this run' on the latest completed
   *  run automatically on mount. Parent resets after consumption. */
  autoAnalyze?: boolean
  onAutoAnalyzeConsumed?: () => void
}

interface ProposedEdit {
  suggestion: ImprovementSuggestion
  /** null = couldn't locate `find` in the current body */
  appliedBody: string | null
}

/**
 * Apply a single suggestion to the current skill body. Returns the new body,
 * or null if the find string couldn't be located (so we can flag it in the UI).
 *
 * Empty `find` means append — we add two newlines and the replacement.
 */
function applySuggestion(body: string, s: ImprovementSuggestion): string | null {
  if (!s.find) {
    const sep = body.endsWith('\n') ? '\n' : '\n\n'
    return body + sep + s.replacement
  }
  const idx = body.indexOf(s.find)
  if (idx === -1) return null
  return body.slice(0, idx) + s.replacement + body.slice(idx + s.find.length)
}

/**
 * Apply a batch of accepted suggestions in order. Skips any whose find strings
 * don't appear in the current (possibly already-modified) body.
 */
function applyBatch(
  body: string,
  suggestions: ImprovementSuggestion[],
): { body: string; skipped: string[] } {
  let cur = body
  const skipped: string[] = []
  for (const s of suggestions) {
    const next = applySuggestion(cur, s)
    if (next === null) {
      skipped.push(s.id)
      continue
    }
    cur = next
  }
  return { body: cur, skipped }
}

function confidenceColor(c: ImprovementSuggestion['confidence']): string {
  if (c === 'high') return 'bg-success/15 text-success'
  if (c === 'medium') return 'bg-warning/15 text-warning'
  return 'bg-muted text-muted-foreground'
}

function whenLabel(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString()
}

export default function ImprovePanel({
  sessionId,
  skillBody,
  onSkillBodyChange,
  onRequestEvaluate,
  autoAnalyze,
  onAutoAnalyzeConsumed,
}: Props) {
  // --- Runs ---
  const [runs, setRuns] = useState<EvalRunSummary[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  // --- Suggestions ---
  const [summary, setSummary] = useState('')
  const [suggestions, setSuggestions] = useState<ImprovementSuggestion[]>([])
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [suggesting, setSuggesting] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)

  // --- Versions ---
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [diffVs, setDiffVs] = useState<{
    title: string
    subtitle?: string
    oldLabel: string
    newLabel: string
    oldText: string
    newText: string
  } | null>(null)

  // --- Save ---
  const [savingNotes, setSavingNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Surfaces the "Run evaluations" CTA after a successful save. Cleared when
  // the user generates fresh suggestions or navigates away.
  const [justSaved, setJustSaved] = useState<SkillVersion | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [r, v] = await Promise.all([
        listEvalRuns(sessionId),
        listSkillVersions(sessionId),
      ])
      setRuns(r)
      setVersions(v)
      if (!selectedRunId) {
        const latestDone = r.find((x) => x.status === 'done')
        if (latestDone) setSelectedRunId(latestDone.run_id)
      }
    } catch {
      // non-fatal
    }
  }, [sessionId, selectedRunId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const selectedRun = useMemo(
    () => runs.find((r) => r.run_id === selectedRunId) || null,
    [runs, selectedRunId],
  )

  // When the selected run changes, hydrate the suggestions panel from the
  // run's persisted analysis if any. Survives reload and tab-switching.
  useEffect(() => {
    if (!selectedRun) {
      setSuggestions([])
      setSummary('')
      return
    }
    const persisted = selectedRun.improvement_suggestions
    if (persisted && persisted.length > 0) {
      setSuggestions(persisted)
      setSummary(selectedRun.improvement_summary || '')
      setSuggestError(null)
    } else if (persisted && persisted.length === 0) {
      // Analyzed but no patterns — remember that so we don't re-analyze.
      setSuggestions([])
      setSummary(selectedRun.improvement_summary || '')
      setSuggestError('No systematic patterns found on this run.')
    } else {
      // Never analyzed; clear local state so we start fresh.
      setSuggestions([])
      setSummary('')
      setSuggestError(null)
    }
    setAccepted(new Set())
    setDismissed(new Set())
  }, [selectedRun])

  const handleSuggest = async () => {
    if (!selectedRunId) return
    setSuggesting(true)
    setSuggestError(null)
    setSummary('')
    setSuggestions([])
    setAccepted(new Set())
    setDismissed(new Set())
    setJustSaved(null)
    try {
      const res = await suggestImprovements(sessionId, selectedRunId)
      setSuggestions(res.suggestions)
      setSummary(res.summary || '')
      if (res.suggestions.length === 0) {
        setSuggestError('No systematic patterns found. Either the skill is working or the dataset is too small — try more rows.')
      }
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : 'Failed to generate suggestions')
    } finally {
      setSuggesting(false)
    }
  }

  // Auto-trigger analyze when arriving from "Improve skill" on EvaluatePanel.
  // Skip the LLM call if the run already has persisted suggestions — those
  // are already loaded by the effect above. Saves tokens + time.
  const autoAnalyzeConsumedRef = useRef(false)
  useEffect(() => {
    if (!autoAnalyze || autoAnalyzeConsumedRef.current) return
    if (!selectedRunId || suggesting) return
    if (selectedRun?.improvement_suggestions !== null && selectedRun?.improvement_suggestions !== undefined) {
      autoAnalyzeConsumedRef.current = true
      onAutoAnalyzeConsumed?.()
      return
    }
    autoAnalyzeConsumedRef.current = true
    handleSuggest().then(() => {
      onAutoAnalyzeConsumed?.()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAnalyze, selectedRunId, suggesting, selectedRun])

  const acceptedSuggestions = useMemo(
    () => suggestions.filter((s) => accepted.has(s.id)),
    [suggestions, accepted],
  )

  const preview: ProposedEdit[] = useMemo(() => {
    // For each accepted suggestion, compute what the body would look like if
    // applied cumulatively in order.
    const result: ProposedEdit[] = []
    let cur = skillBody
    for (const s of suggestions) {
      if (!accepted.has(s.id)) continue
      const next = applySuggestion(cur, s)
      result.push({ suggestion: s, appliedBody: next })
      if (next !== null) cur = next
    }
    return result
  }, [suggestions, accepted, skillBody])

  const finalBody = useMemo(() => {
    const { body } = applyBatch(skillBody, acceptedSuggestions)
    return body
  }, [skillBody, acceptedSuggestions])

  const finalChanged = finalBody !== skillBody

  const toggleAccept = (id: string) => {
    setDismissed((d) => {
      const next = new Set(d)
      next.delete(id)
      return next
    })
    setAccepted((a) => {
      const next = new Set(a)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleDismiss = (id: string) => {
    setAccepted((a) => {
      const next = new Set(a)
      next.delete(id)
      return next
    })
    setDismissed((d) => {
      const next = new Set(d)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSaveVersion = async () => {
    if (!finalChanged || acceptedSuggestions.length === 0) return
    setSaving(true)
    setSaveError(null)
    try {
      const { body, skipped } = applyBatch(skillBody, acceptedSuggestions)
      const noteParts = [
        `Applied ${acceptedSuggestions.length - skipped.length} of ${acceptedSuggestions.length} suggestions`,
        savingNotes.trim(),
      ].filter(Boolean)
      const newVersion = await createSkillVersion(sessionId, {
        body,
        notes: noteParts.join(' · ') || undefined,
        created_from: 'suggestion',
        applied_suggestion_ids: acceptedSuggestions
          .filter((s) => !skipped.includes(s.id))
          .map((s) => s.id),
      })
      onSkillBodyChange(body)
      setVersions((prev) => [newVersion, ...prev])
      setSuggestions([])
      setAccepted(new Set())
      setDismissed(new Set())
      setSummary('')
      setSavingNotes('')
      setJustSaved(newVersion)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save new version')
    } finally {
      setSaving(false)
    }
  }

  const handleRestore = async (v: SkillVersion) => {
    if (!confirm(`Restore v${v.version} as active? The current body will stay in history.`)) return
    try {
      await restoreSkillVersion(sessionId, v.id)
      onSkillBodyChange(v.body)
      refresh()
    } catch (err) {
      console.error('Restore failed', err)
    }
  }

  const doneRuns = runs.filter((r) => r.status === 'done')
  const hasSuggestions = suggestions.length > 0
  const activeVersion = versions[0] // list is newest-first per backend

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 h-12 border-b border-border bg-surface-raised flex items-center justify-between flex-shrink-0">
        <h2 className="text-sm font-semibold text-foreground">Improve</h2>
        {activeVersion && (
          <span className="text-[11px] font-mono text-muted-foreground">
            active: v{activeVersion.version}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl space-y-8">
          {/* --- Generate suggestions --- */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 bg-accent/10 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-accent" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Suggest improvements</h3>
                <p className="text-xs text-muted-foreground">
                  Analyzes failures in an eval run and proposes targeted edits to your SKILL.md.
                  Accept the ones you like — a new version is created.
                </p>
              </div>
            </div>

            {doneRuns.length === 0 ? (
              <div className="px-3 py-2 bg-warning/10 border border-warning/30 text-xs text-foreground">
                No completed eval runs yet. Go to Evaluations and run one first.
              </div>
            ) : (
              <>
                <div className="mb-3">
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                    Based on eval run
                  </label>
                  <select
                    value={selectedRunId || ''}
                    onChange={(e) => setSelectedRunId(e.target.value || null)}
                    className="w-full text-xs bg-background border border-border px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    {doneRuns.map((r) => {
                      const avg = Object.values(r.scorer_averages || {})
                      const mean =
                        avg.length > 0 ? avg.reduce((a, b) => a + b, 0) / avg.length : 0
                      return (
                        <option key={r.run_id} value={r.run_id}>
                          {r.project}
                          {r.experiment_name ? ` · ${r.experiment_name}` : ''} · v
                          {r.skill_version_number ?? '?'} · avg {(mean * 100).toFixed(0)}% ·{' '}
                          {whenLabel(r.started_at)}
                        </option>
                      )
                    })}
                  </select>
                </div>

                <button
                  onClick={handleSuggest}
                  disabled={!selectedRunId || suggesting}
                  className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium ${
                    selectedRunId && !suggesting
                      ? 'bg-accent text-accent-foreground hover:opacity-90 cursor-pointer'
                      : 'bg-muted text-muted-foreground cursor-not-allowed'
                  }`}
                >
                  {suggesting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4" />
                  )}
                  Analyze this run
                </button>
                {suggestError && (
                  <p className="mt-2 text-xs text-danger">{suggestError}</p>
                )}
              </>
            )}
          </section>

          {/* --- Post-save CTA --- */}
          {justSaved && (
            <section className="border border-success p-4 bg-success/5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    v{justSaved.version} saved. Your SKILL.md is updated.
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Run the evaluation again to see if scores improved —
                    {justSaved.applied_suggestion_ids.length > 0 && (
                      <> this version applied {justSaved.applied_suggestion_ids.length} suggestion
                        {justSaved.applied_suggestion_ids.length === 1 ? '' : 's'}.</>
                    )}
                  </p>
                </div>
                {onRequestEvaluate && (
                  <button
                    onClick={() => {
                      setJustSaved(null)
                      onRequestEvaluate()
                    }}
                    className="flex-shrink-0 px-3 py-1.5 text-xs font-medium bg-accent text-accent-foreground hover:opacity-90"
                  >
                    Run evaluations
                  </button>
                )}
              </div>
            </section>
          )}

          {/* --- Suggestions list --- */}
          {hasSuggestions && (
            <section>
              {summary && (
                <p className="text-sm text-foreground bg-muted/20 p-3 mb-3 border-l-2 border-accent">
                  {summary}
                </p>
              )}

              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Proposed edits ({suggestions.length})
              </p>

              <ul className="space-y-2">
                {suggestions.map((s) => {
                  const isAccepted = accepted.has(s.id)
                  const isDismissed = dismissed.has(s.id)
                  const isCollapsed = isAccepted || isDismissed
                  const applied = applySuggestion(skillBody, s)
                  const findable = applied !== null

                  // COLLAPSED: one-line summary when accepted or dismissed.
                  // The user can re-open by clicking the status pill.
                  if (isCollapsed) {
                    const shortFind =
                      s.find.length > 40 ? s.find.slice(0, 40) + '…' : s.find
                    const shortRepl =
                      s.replacement.length > 40
                        ? s.replacement.slice(0, 40) + '…'
                        : s.replacement
                    return (
                      <li
                        key={s.id}
                        className={`border px-3 py-2 text-xs flex items-center gap-2 ${
                          isAccepted
                            ? 'border-accent bg-accent/5'
                            : 'border-border bg-muted/10 opacity-60'
                        }`}
                      >
                        <span
                          className={`font-mono text-[10px] uppercase px-1.5 py-0.5 flex-shrink-0 ${
                            isAccepted
                              ? 'bg-accent/20 text-accent'
                              : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {isAccepted ? 'accepted' : 'dismissed'}
                        </span>
                        <span className="text-foreground truncate flex-1">
                          {s.find ? (
                            <>
                              <span className="font-mono line-through text-muted-foreground">
                                {shortFind}
                              </span>{' '}
                              →{' '}
                              <span className="font-mono text-foreground">
                                {shortRepl}
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="text-muted-foreground">append</span>{' '}
                              <span className="font-mono text-foreground">
                                {shortRepl}
                              </span>
                            </>
                          )}
                        </span>
                        <div className="flex gap-1 flex-shrink-0">
                          <button
                            onClick={() =>
                              setDiffVs({
                                title: s.summary,
                                subtitle: s.rationale,
                                oldLabel: 'current SKILL.md',
                                newLabel: 'after this edit',
                                oldText: skillBody,
                                newText: applied || skillBody,
                              })
                            }
                            className="p-1 text-muted-foreground hover:text-foreground"
                            title="Preview diff"
                            disabled={!findable}
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() =>
                              isAccepted ? toggleAccept(s.id) : toggleDismiss(s.id)
                            }
                            className="p-1 text-muted-foreground hover:text-foreground"
                            title="Undo"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </li>
                    )
                  }

                  // EXPANDED: full suggestion card, pending user decision.
                  return (
                    <li
                      key={s.id}
                      className="border border-border bg-surface-raised p-3 text-xs"
                    >
                      <div className="flex items-start gap-2 mb-2">
                        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                          {s.kind.replace('_', ' ')}
                        </span>
                        <span className={`font-mono text-[10px] uppercase px-1.5 py-0.5 ${confidenceColor(s.confidence)}`}>
                          {s.confidence}
                        </span>
                        {!findable && (
                          <span className="font-mono text-[10px] uppercase px-1.5 py-0.5 bg-warning/15 text-warning">
                            find not in current body
                          </span>
                        )}
                        <div className="ml-auto flex gap-1 flex-shrink-0">
                          <button
                            onClick={() => setDiffVs({
                              title: s.summary,
                              subtitle: s.rationale,
                              oldLabel: 'current SKILL.md',
                              newLabel: 'after this edit',
                              oldText: skillBody,
                              newText: applied || skillBody,
                            })}
                            className="p-1 text-muted-foreground hover:text-foreground"
                            title="Preview diff"
                            disabled={!findable}
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => toggleAccept(s.id)}
                            className="p-1 text-muted-foreground hover:text-success"
                            title="Accept"
                            disabled={!findable}
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => toggleDismiss(s.id)}
                            className="p-1 text-muted-foreground hover:text-danger"
                            title="Dismiss"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <p className="text-sm font-medium text-foreground mb-1">{s.summary}</p>
                      <p className="text-xs text-muted-foreground mb-2">{s.rationale}</p>

                      {s.find && (
                        <details className="mb-1">
                          <summary className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide cursor-pointer">
                            Replace
                          </summary>
                          <pre className="mt-1 p-2 bg-danger/5 text-foreground whitespace-pre-wrap break-words font-mono text-[11px]">
                            {s.find}
                          </pre>
                        </details>
                      )}
                      <details>
                        <summary className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide cursor-pointer">
                          {s.find ? 'With' : 'Append'}
                        </summary>
                        <pre className="mt-1 p-2 bg-success/5 text-foreground whitespace-pre-wrap break-words font-mono text-[11px]">
                          {s.replacement}
                        </pre>
                      </details>

                      {(s.source_row_ids.length > 0 || s.source_scorer_names.length > 0) && (
                        <div className="mt-2 pt-2 border-t border-border/50 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                          {s.source_scorer_names.map((n) => (
                            <span key={n} className="font-mono px-1.5 py-0.5 bg-muted/50">
                              {n}
                            </span>
                          ))}
                          {s.source_row_ids.slice(0, 5).map((id) => (
                            <span key={id} className="font-mono px-1.5 py-0.5 bg-muted/50">
                              {id.slice(0, 8)}
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>

              {/* --- Save block --- */}
              {acceptedSuggestions.length > 0 && (
                <div className="mt-4 border border-accent p-3 bg-accent/5">
                  <p className="text-sm font-medium text-foreground mb-1">
                    Ready to save v{(activeVersion?.version ?? 0) + 1}
                  </p>
                  <p className="text-xs text-muted-foreground mb-3">
                    {acceptedSuggestions.length} suggestion
                    {acceptedSuggestions.length === 1 ? '' : 's'} accepted ·{' '}
                    {preview.filter((p) => p.appliedBody === null).length} couldn't be applied (find
                    text not in SKILL.md).
                  </p>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={savingNotes}
                      onChange={(e) => setSavingNotes(e.target.value)}
                      placeholder="Optional note about this version..."
                      className="flex-1 text-xs bg-background border border-border px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                    <button
                      onClick={() =>
                        setDiffVs({
                          title: `Preview v${(activeVersion?.version ?? 0) + 1}`,
                          oldLabel: `v${activeVersion?.version ?? 0}`,
                          newLabel: `v${(activeVersion?.version ?? 0) + 1} (preview)`,
                          oldText: skillBody,
                          newText: finalBody,
                        })
                      }
                      className="px-3 py-1.5 text-xs font-medium bg-muted text-foreground hover:bg-muted/70"
                    >
                      <Eye className="w-3.5 h-3.5 inline" /> Preview combined diff
                    </button>
                    <button
                      onClick={handleSaveVersion}
                      disabled={saving || !finalChanged}
                      className={`px-3 py-1.5 text-xs font-medium ${
                        finalChanged && !saving
                          ? 'bg-accent text-accent-foreground hover:opacity-90'
                          : 'bg-muted text-muted-foreground cursor-not-allowed'
                      }`}
                    >
                      {saving && <Loader2 className="w-3.5 h-3.5 animate-spin inline" />}
                      Save new version
                    </button>
                  </div>
                  {saveError && <p className="text-xs text-danger">{saveError}</p>}
                </div>
              )}
            </section>
          )}

          {/* --- Version history --- */}
          {versions.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <History className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold text-foreground">Version history</h3>
                <span className="text-xs text-muted-foreground">
                  ({versions.length} version{versions.length === 1 ? '' : 's'})
                </span>
              </div>
              <ul className="space-y-1">
                {versions.map((v, i) => {
                  const prev = versions[i + 1] // next older
                  const isActive = v.id === activeVersion?.id
                  return (
                    <li
                      key={v.id}
                      className={`flex items-center gap-3 px-3 py-2 text-xs border border-border ${
                        isActive ? 'bg-accent/5 border-accent' : 'bg-muted/10'
                      }`}
                    >
                      <span className="font-mono text-foreground">v{v.version}</span>
                      {isActive && (
                        <span className="font-mono text-[10px] uppercase px-1.5 py-0.5 bg-accent/20 text-accent">
                          active
                        </span>
                      )}
                      <span className="font-mono text-[10px] text-muted-foreground uppercase">
                        {v.created_from}
                      </span>
                      <span className="text-muted-foreground truncate flex-1">
                        {v.notes || '—'}
                      </span>
                      <span className="text-muted-foreground flex-shrink-0">
                        {whenLabel(v.created_at)}
                      </span>
                      <div className="flex gap-1 flex-shrink-0">
                        {prev && (
                          <button
                            onClick={() =>
                              setDiffVs({
                                title: `v${prev.version} → v${v.version}`,
                                subtitle: v.notes || undefined,
                                oldLabel: `v${prev.version}`,
                                newLabel: `v${v.version}`,
                                oldText: prev.body,
                                newText: v.body,
                              })
                            }
                            className="p-1 text-muted-foreground hover:text-foreground"
                            title={`Diff vs v${prev.version}`}
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {!isActive && (
                          <button
                            onClick={() => handleRestore(v)}
                            className="p-1 text-muted-foreground hover:text-foreground"
                            title="Restore as active"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </div>
      </div>

      {diffVs && (
        <DiffModal
          title={diffVs.title}
          subtitle={diffVs.subtitle}
          oldLabel={diffVs.oldLabel}
          newLabel={diffVs.newLabel}
          oldText={diffVs.oldText}
          newText={diffVs.newText}
          onClose={() => setDiffVs(null)}
        />
      )}
    </div>
  )
}
