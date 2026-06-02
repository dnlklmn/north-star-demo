import { useCallback, useEffect, useState } from 'react'
import { Sparkles, ChevronRight, Copy, Download, Loader2, ArrowRight, Check, Upload } from 'lucide-react'
import type { Seed, ScorerDef } from '../types'
import {
  getBraintrustScorerPrompt,
  suggestScorerIdeas,
  type ScorerIdea,
} from '../api'
import { AIIcon } from './ui/Icons'
import PanelLayout from './PanelLayout'
import SuggestionBox, { SuggestionCard } from './SuggestionBox'
import { getAutoGenerateSuggestions } from '../utils/uiPrefs'

interface Props {
  seed: Seed
  hasDataset: boolean
  sessionId: string
  scorers?: ScorerDef[]
  onScorersChange?: (scorers: ScorerDef[]) => void
  onNavigateToEvaluate?: () => void
  /** Parent-owned generating flag. Was previously local to this panel, but
   *  that made the spinner die on tab switch (panel unmounts → state lost)
   *  and made Polaris-triggered generation race the panel's mount. Now the
   *  parent owns it and the panel is purely presentational for this state. */
  externalGenerating?: boolean
  /** Parent-owned error from the last generation attempt. Survives tab
   *  switches the same way `externalGenerating` does. */
  externalError?: string | null
  /** Parent-supplied generate handler. Replaces the panel's own fetch.
   *  Called by the "Generate scorers" / "Regenerate" buttons. */
  onGenerate?: () => Promise<void> | void
  /** Read-only when false: generate/regenerate, save and download buttons hide. */
  canEdit?: boolean
}

export default function ScorersPanel({ seed, hasDataset: _hasDataset, sessionId, scorers: externalScorers, onScorersChange, onNavigateToEvaluate, externalGenerating, externalError, onGenerate, canEdit = true }: Props) {
  const [localScorers, setLocalScorers] = useState<ScorerDef[]>([])
  const scorers = externalScorers ?? localScorers
  // Memoized so callbacks that depend on it stay stable across renders.
  const setScorers = useCallback(
    (s: ScorerDef[]) => {
      setLocalScorers(s)
      onScorersChange?.(s)
    },
    [onScorersChange],
  )
  // Generation is parent-owned now — no local flag, no local error. Both
  // survive tab switches and stay coherent across Polaris-triggered and
  // button-triggered paths.
  const generating = !!externalGenerating
  // The regenerate-button busy state is the same generation flag — losing
  // the per-button distinction is the cost of a single source of truth,
  // which is worth it for surviving tab switches.
  const headerRegenBusy = generating

  // Expected scorer count = one per seed criterion, roughly. Surfaced
  // in the empty-state spinner copy so the user sees rough progress
  // ("Generating ~6 scorers…") instead of an open-ended spinner.
  const expectedScorerCount = (() => {
    const cov = seed.coverage?.criteria?.length || 0
    const offTarget = seed.coverage?.negative_criteria?.length || 0
    const bal = seed.balance?.criteria?.length || 0
    const align = seed.alignment?.length || 0
    const rot = seed.rot?.criteria?.length || 0
    const safety = seed.safety?.criteria?.length || 0
    return Math.max(cov + offTarget + bal + align + rot + safety, 1)
  })()
  const [expandedScorer, setExpandedScorer] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Per-scorer ephemeral state for the Braintrust export button. The success
  // tick decays after a short delay so the button reverts to its idle label,
  // matching how the Copy button behaves elsewhere in the app.
  const [exportingName, setExportingName] = useState<string | null>(null)
  const [exportedName, setExportedName] = useState<string | null>(null)

  // --- Right rail: scorer-idea suggestions ---
  // Soft prompts for new scorers the user might add. These are pitches
  // only — promoting one into a real scorer goes through the existing
  // generate-scorers pass.
  const [suggestions, setSuggestions] = useState<ScorerIdea[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const [dismissedIdeas, setDismissedIdeas] = useState<Set<string>>(new Set())
  const fetchSuggestions = useCallback(async () => {
    if (!sessionId) return
    setSuggestionsLoading(true)
    try {
      const res = await suggestScorerIdeas(sessionId)
      setSuggestions(
        res.suggestions.filter((s) => !dismissedIdeas.has(s.summary)),
      )
    } catch (err) {
      console.warn('Failed to fetch scorer ideas:', err)
    } finally {
      setSuggestionsLoading(false)
    }
  }, [sessionId, dismissedIdeas])

  // Auto-fetch when the user lands on the Scorers page with at least one
  // scorer present — and only if auto-generate-suggestions is on. Without
  // existing scorers the suggestions aren't grounded in much; we skip then
  // so the empty-state CTA stays the focus.
  useEffect(() => {
    if (!getAutoGenerateSuggestions()) return
    if (scorers.length === 0) return
    if (suggestions.length > 0) return
    if (suggestionsLoading) return
    fetchSuggestions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scorers.length])

  const handleToggleEnabled = (scorer: ScorerDef) => {
    const next = scorers.map((s) =>
      s.name === scorer.name
        ? { ...s, enabled: s.enabled === false }
        : s,
    )
    setScorers(next)
  }

  const hasCriteria = seed.coverage.criteria.length > 0
    || seed.balance.criteria.length > 0
    || seed.alignment.length > 0
    || seed.rot.criteria.length > 0

  // Generation is delegated to the parent (ProjectWorkspace) so the
  // generating + error state survives tab switches and Polaris-triggered
  // and button-triggered paths share the same flow. The regenerate
  // confirm dialog lives in the parent now too.
  const handleGenerate = async () => {
    console.log("[scorers] panel button clicked", {
      hasOnGenerate: typeof onGenerate === "function",
      hasCriteria,
      scorerCount: scorers.length,
      generating,
    })
    if (!onGenerate) {
      console.error("[scorers] onGenerate prop is missing — generation cannot run")
      return
    }
    await onGenerate()
  }

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code)
  }

  /** Fetch the Mustache-templated prompt for one scorer and copy it to the
   *  clipboard. The user pastes it into Braintrust's online-scorer editor.
   *  Filter expression is included as a trailing hint comment so it travels
   *  with the prompt — the user reads it once when configuring the trigger
   *  in the Braintrust UI, then strips it. */
  const handleExportToBraintrust = async (scorerName: string) => {
    setExportingName(scorerName)
    setError(null)
    try {
      const result = await getBraintrustScorerPrompt(sessionId, scorerName)
      const clipboardText = result.filter
        ? `${result.prompt}\n<!-- Braintrust trigger filter: ${result.filter} -->\n`
        : result.prompt
      await navigator.clipboard.writeText(clipboardText)
      setExportedName(scorerName)
      window.setTimeout(() => {
        setExportedName((current) => (current === scorerName ? null : current))
      }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build Braintrust prompt')
    } finally {
      setExportingName(null)
    }
  }

  const handleDownloadAll = () => {
    const allCode = scorers.map(s => `# ${s.name}\n# ${s.description}\n${s.code}`).join('\n\n')
    const blob = new Blob([allCode], { type: 'text/python' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'scorers.py'
    a.click()
    URL.revokeObjectURL(url)
  }

  const typeColors: Record<string, string> = {
    coverage: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    alignment: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    balance: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    rot: 'bg-red-500/10 text-red-400 border-red-500/20',
  }

  // Parent-owned generate error first (survives tab switch), then the
  // panel-local Braintrust-prompt error.
  const errorBanner = (externalError || error) ? (
    <div className="mb-4 p-3 bg-danger/10 border border-danger/20 text-xs text-danger">
      {externalError || error}
    </div>
  ) : null

  // Idle/empty layout mirrors the dataset page so the two generation
  // steps feel like the same kind of screen: centered, no side rail.
  if (scorers.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-y-auto p-6 flex flex-col">
          {errorBanner}
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-6 max-w-md text-center">
              <div>
                <h2 className="text-xl font-semibold text-fg-contrast mb-1">
                  Generate your scorers
                </h2>
                <p className="text-sm text-fg-dim">
                  Generate scorers based on your seed.
                </p>
              </div>
              {canEdit && (
                <button
                  onClick={handleGenerate}
                  disabled={!hasCriteria || generating}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-accent text-accent-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {generating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Generating ~{expectedScorerCount} scorer
                      {expectedScorerCount === 1 ? "" : "s"}…
                    </>
                  ) : (
                    <>
                      <AIIcon width={16} height={16} />
                      Generate scorers
                    </>
                  )}
                </button>
              )}
              {!canEdit && (
                <p className="text-xs text-fg-dim">
                  No scorers yet. The project owner needs to generate them.
                </p>
              )}
              {!hasCriteria && (
                <p className="text-xs text-fg-dim">
                  Build a seed first — scorers are derived from its criteria.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const enabledCount = scorers.filter((s) => s.enabled !== false).length
  const countText =
    enabledCount === scorers.length
      ? `${scorers.length} scorer${scorers.length === 1 ? '' : 's'}.`
      : `${enabledCount} of ${scorers.length} enabled.`

  // Right rail — scorer-idea suggestions, rendered through the shared
  // PanelLayout right column so the sidebar matches Skill / Seed /
  // Goals (same resizable width, same border treatment).
  const suggestionsRail = canEdit ? (
    <SuggestionBox
      label="Scorer ideas"
      onRefresh={fetchSuggestions}
      loading={suggestionsLoading}
      emptyText={
        getAutoGenerateSuggestions()
          ? "Press refresh to get scorer ideas."
          : "Auto-generate is off — click below to fetch ideas."
      }
      showGetButton={!getAutoGenerateSuggestions()}
      getButtonLabel="Get scorer ideas"
    >
      {suggestions.length > 0
        ? suggestions.map((idea, i) => (
            <SuggestionCard
              key={i}
              onAccept={() => {
                // No code-generation for an idea yet — accept just
                // dismisses for now. The user will refine later.
                setSuggestions((prev) =>
                  prev.filter((s) => s.summary !== idea.summary),
                )
                setDismissedIdeas((prev) => new Set(prev).add(idea.summary))
              }}
              onDismiss={() => {
                setSuggestions((prev) =>
                  prev.filter((s) => s.summary !== idea.summary),
                )
                setDismissedIdeas((prev) => new Set(prev).add(idea.summary))
              }}
            >
              <div className="flex flex-col gap-2">
                {idea.type && (
                  <span className="self-start bg-fill-primary/10 text-fg-primary text-[11px] font-mono uppercase tracking-wide px-1.5 py-0.5">
                    {idea.type}
                  </span>
                )}
                <span>{idea.summary}</span>
              </div>
            </SuggestionCard>
          ))
        : null}
    </SuggestionBox>
  ) : undefined

  return (
    <PanelLayout
      title="Scorers"
      subtitle={`Code that grades each row against your seed. ${countText}`}
      titleAction={
        <div className="flex items-center gap-2 flex-wrap">
          {/* Download is read-only (export of public state) so we keep
              it for everyone, including viewers. */}
          <button
            onClick={handleDownloadAll}
            className="px-2 py-1 text-xs text-fg-dim hover:text-fg-contrast border border-border-hint transition-colors flex items-center gap-1"
            title="Download all scorers"
          >
            <Download className="w-3 h-3" />
            Download all
          </button>
          {canEdit && (
            <button
              onClick={handleGenerate}
              disabled={!hasCriteria || headerRegenBusy}
              className="px-2 py-1 text-xs border border-border-hint hover:bg-fill-neutral transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {headerRegenBusy ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <Sparkles className="w-3 h-3" />
                  Regenerate
                </>
              )}
            </button>
          )}
          {onNavigateToEvaluate && (
            <button
              onClick={onNavigateToEvaluate}
              className="px-2.5 py-1 text-xs bg-fill-primary text-bg-default hover:bg-fill-primary-hover transition-colors inline-flex items-center gap-1.5"
            >
              Evaluate
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      }
      right={suggestionsRail}
    >
      {errorBanner}
      <div className="max-w-2xl space-y-2">
            {scorers.map(scorer => {
              const isEnabled = scorer.enabled !== false
              return (
              <div
                key={scorer.name}
                className={`border border-border bg-surface-raised ${
                  isEnabled ? '' : 'opacity-60'
                }`}
              >
                {/* Row layout uses flex of three siblings instead of one big
                    button containing two more — nested <button>s are invalid
                    HTML and React 19 flags them as hydration errors. The
                    chevron + name area is the toggle (a <button>); the
                    enabled-switch + Braintrust + Copy actions live alongside
                    as their own real <button>s. */}
                <div className="flex items-stretch">
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => handleToggleEnabled(scorer)}
                      role="switch"
                      aria-checked={isEnabled}
                      title={
                        isEnabled
                          ? 'Disable this scorer (skip in evals)'
                          : 'Enable this scorer'
                      }
                      className="flex items-center justify-center px-3 hover:bg-muted/50 transition-colors"
                    >
                      <span
                        className={`relative inline-flex h-4 w-7 items-center transition-colors ${
                          isEnabled ? 'bg-accent' : 'bg-muted'
                        }`}
                      >
                        <span
                          className={`inline-block h-3 w-3 transform bg-white transition-transform ${
                            isEnabled ? 'translate-x-3.5' : 'translate-x-0.5'
                          }`}
                        />
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setExpandedScorer(expandedScorer === scorer.name ? null : scorer.name)}
                    className="flex-1 flex items-center gap-2 p-3 hover:bg-muted/50 transition-colors text-left"
                  >
                    <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${expandedScorer === scorer.name ? 'rotate-90' : ''}`} />
                    <code className="text-sm font-medium text-foreground">{scorer.name}</code>
                    <span className={`text-[10px] px-1.5 py-0.5 border ${typeColors[scorer.type]}`}>
                      {scorer.type}
                    </span>
                  </button>
                  <div className="flex items-center gap-2 px-3">
                    <button
                      type="button"
                      onClick={() => handleExportToBraintrust(scorer.name)}
                      disabled={exportingName === scorer.name}
                      title="Copy Braintrust online-scorer prompt to clipboard"
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait"
                    >
                      {exportingName === scorer.name ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : exportedName === scorer.name ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span className="text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Upload className="w-3 h-3" />
                          <span>Braintrust</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCopy(scorer.code)}
                      title="Copy Python scorer code"
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                {expandedScorer === scorer.name && (
                  <div className="px-3 pb-3">
                    <p className="text-xs text-muted-foreground mb-2">{scorer.description}</p>
                    <pre className="text-xs bg-background p-3 overflow-x-auto text-foreground/80 font-mono">
                      {scorer.code}
                    </pre>
                  </div>
                )}
              </div>
              )
            })}
      </div>
    </PanelLayout>
  )
}
