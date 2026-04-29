import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, Eye, ExternalLink, FileText, History, KeyRound, Loader2, PlayCircle, RotateCcw, Settings as SettingsIcon, Sparkles, X } from 'lucide-react'
import type { Charter, Dataset, EvalRunSummary, ImprovementSuggestion, SkillVersion } from '../types'
import CharterDocument from './CharterDocument'
import DiffModal from './DiffModal'
import PanelLayout from './PanelLayout'
import {
  cancelEvalRun,
  createSkillVersion,
  discardSkillVersion,
  getApiKey,
  getEvalRun,
  hasBraintrustApiKey,
  listEvalRuns,
  listSkillVersions,
  promoteSkillVersion,
  restoreSkillVersion,
  runEval,
  suggestImprovements,
} from '../api'
import {
  JUDGE_MODEL_OPTIONS,
  getDefaultBraintrustProject,
  getDefaultJudgeModel,
  setDefaultJudgeModel,
} from '../utils/evalDefaults'

interface Props {
  sessionId: string
  dataset: Dataset | null
  scorerCount: number
  hasSkillBody: boolean
  /** True for kind=prompt projects. Skips skill_body precondition + reframes
   *  copy ("the chosen prompt builder" instead of "your SKILL.md"). */
  isPromptEval?: boolean
  onExport: () => void
  skillBody: string
  onSkillBodyChange: (body: string) => void
  /** Trigger a new eval run from the post-save CTA. Called with optional
   *  overrides for project/experiment/limit/include_triggering. */
  onRunEval: (overrides?: { project?: string; experiment_name?: string; limit?: number; include_triggering?: boolean }) => Promise<unknown>
  /** When set to true, the panel kicks off a run on mount using the most-recent
   *  run's config (project + flags). Parent should reset this flag after. */
  autoRun?: boolean
  /** Called after an auto-run has been started so the parent can clear autoRun. */
  onAutoRunConsumed?: () => void
  /** Blocker actions — each missing precondition becomes an actionable button
   *  rather than a label that tells the user where to go manually. */
  onGoToSkill?: () => void
  onGoToDataset?: () => void
  onGoToScorers?: () => void
  /** Inline regeneration — same as navigating to Scorers + pressing Generate,
   *  but done in place so the user doesn't lose context. */
  onGenerateScorersInline?: () => Promise<void>
  /** Opens the Settings modal so the user can add missing API keys
   *  (Braintrust for running evals, OpenRouter for non-Claude judges). */
  onOpenSettings?: () => void
  /** Called when an eval run reaches a terminal state. Parent should refetch
   *  the dataset so badges that change at run-completion (e.g. the "new"
   *  tags the backend clears post-run) drop off the UI immediately. */
  onRunTerminal?: () => void
  /** Pointer to the SKILL version awaiting promote/discard. When set and
   *  the active run was evaluated on this version, we surface promote/
   *  discard buttons + per-row regression diff vs the previous active. */
  candidateVersionId?: string | null
  /** Pointer to the currently-active SKILL version. Used to compute the
   *  baseline run for the row-by-row regression diff. */
  activeVersionId?: string | null
  /** Called after Promote/Discard so the parent can refresh session state.
   *  Without this the candidate badge would linger after the action. */
  onCandidateChanged?: () => Promise<void> | void
  /** Called after a new SkillVersion is created (suggestion-accept) so the
   *  parent can refetch session state. */
  onSessionChanged?: () => Promise<void> | void
}

const POLL_INTERVAL_MS = 2000
const TERMINAL_STATUSES = new Set<EvalRunSummary['status']>([
  'done',
  'error',
  'failed',
  'cancelled',
])


function scoreColor(score: number): string {
  if (score >= 0.8) return 'text-success'
  if (score >= 0.5) return 'text-warning'
  return 'text-danger'
}

/** Map the raw judge model ID stored on a run to a friendly label.
 *  Falls back to the raw ID for models that aren't in our known list
 *  (e.g. older runs predating an option update). */
function judgeLabel(modelId: string | null | undefined): string | null {
  if (!modelId) return null
  const opt = JUDGE_MODEL_OPTIONS.find((o) => o.value === modelId)
  if (opt) return opt.label.replace(' (OpenRouter)', '').replace('Default (', '').replace(')', '')
  return modelId
}

function formatWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString()
}

/** How an Accept resolved against the current SKILL.md body.
 *  - exact: substring match, indent and whitespace preserved literally.
 *  - normalized: whitespace-tolerant match, safe (unique, didn't cross a
 *    paragraph break or fenced code block the find doesn't itself contain).
 *  - appended: couldn't safely match, replacement appended to the end. UI
 *    surfaces a chip so the user can move it manually.
 *  - none: only used by `getMatchKind` before apply. `applySuggestion`
 *    always upgrades none to appended. */
type MatchKind = 'exact' | 'normalized' | 'appended' | 'none'

interface ProposedEdit {
  suggestion: ImprovementSuggestion
  appliedBody: string
  mode: MatchKind
}

/** Locate `find` in `body` tolerating LLM whitespace drift, but refusing
 *  matches that would silently produce wrong replacements:
 *  - multiple normalized hits with no exact hit → ambiguous, reject
 *  - matched span crosses `\n\n` (paragraph break) when `find` doesn't →
 *    reject (the LLM almost certainly meant a single paragraph)
 *  - matched span crosses a triple-backtick fence when `find` doesn't →
 *    reject (we'd be replacing across a code block boundary)
 *
 *  Returns [start, end, kind] on safe match, null otherwise. */
function findRange(
  body: string,
  find: string,
): { start: number; end: number; kind: 'exact' | 'normalized' } | null {
  const exact = body.indexOf(find)
  if (exact !== -1) {
    return { start: exact, end: exact + find.length, kind: 'exact' }
  }

  const trimmed = find.trim()
  if (!trimmed) return null
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()
  const needle = normalize(trimmed)
  if (!needle) return null

  let normalizedBody = ''
  const offsets: number[] = []
  let inWs = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (/\s/.test(ch)) {
      if (!inWs && normalizedBody.length > 0) {
        normalizedBody += ' '
        offsets.push(i)
      }
      inWs = true
    } else {
      normalizedBody += ch
      offsets.push(i)
      inWs = false
    }
  }
  const normIdx = normalizedBody.indexOf(needle)
  if (normIdx === -1) return null

  // Ambiguous: same needle appears more than once. We don't know which one
  // the LLM meant — refuse rather than first-occurrence-wins.
  const secondIdx = normalizedBody.indexOf(needle, normIdx + 1)
  if (secondIdx !== -1) return null

  const start = offsets[normIdx]
  const lastNormIdx = normIdx + needle.length - 1
  const lastChar = offsets[lastNormIdx]
  const endChar = body[lastChar]
  const end = /\s/.test(endChar) ? lastChar : lastChar + 1
  const matched = body.slice(start, end)

  // Refuse to match across structural boundaries the LLM almost certainly
  // didn't intend to span. The find string itself can contain them — that's
  // legitimate; we only reject when the match crosses a boundary that
  // *isn't* in the find string.
  if (!find.includes('\n\n') && matched.includes('\n\n')) return null
  if (!find.includes('```') && matched.includes('```')) return null

  return { start, end, kind: 'normalized' }
}

/** Apply a single suggestion. Always returns a new body — when no safe
 *  match exists we append to the end rather than refuse. The `mode`
 *  field tells the caller which path was taken so the UI can show
 *  "applied as edit" vs "appended due to drift". */
function applySuggestion(
  body: string,
  s: ImprovementSuggestion,
): { body: string; mode: MatchKind } {
  if (!s.find) {
    const sep = body.endsWith('\n') ? '\n' : '\n\n'
    return { body: body + sep + s.replacement, mode: 'appended' }
  }
  const match = findRange(body, s.find)
  if (match === null) {
    const sep = body.endsWith('\n') ? '\n' : '\n\n'
    return { body: body + sep + s.replacement, mode: 'appended' }
  }
  return {
    body: body.slice(0, match.start) + s.replacement + body.slice(match.end),
    mode: match.kind,
  }
}

/** Inspect (without applying) what would happen if `s` were accepted. Used
 *  by the per-suggestion UI to decide whether to show the "will append"
 *  drift chip. */
function getMatchKind(body: string, s: ImprovementSuggestion): MatchKind {
  if (!s.find) return 'appended'
  const match = findRange(body, s.find)
  return match === null ? 'appended' : match.kind
}

/** Apply a batch of accepted suggestions in order. Returns the final body
 *  plus a per-suggestion map of how each one resolved (so the save card
 *  can label "3 applied as edits, 2 appended due to drift"). */
function applyBatch(
  body: string,
  suggestions: ImprovementSuggestion[],
): { body: string; modes: Record<string, MatchKind> } {
  let cur = body
  const modes: Record<string, MatchKind> = {}
  for (const s of suggestions) {
    const { body: next, mode } = applySuggestion(cur, s)
    cur = next
    modes[s.id] = mode
  }
  return { body: cur, modes }
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

export default function EvaluatePanel({
  sessionId,
  dataset,
  scorerCount,
  hasSkillBody,
  isPromptEval = false,
  onExport,
  skillBody,
  onSkillBodyChange,
  onRunEval,
  autoRun,
  onAutoRunConsumed,
  onGoToSkill,
  onGoToDataset,
  onGoToScorers,
  onGenerateScorersInline,
  onOpenSettings,
  onRunTerminal,
  candidateVersionId,
  activeVersionId,
  onCandidateChanged,
  onSessionChanged,
}: Props) {
  const [inlineGenScorers, setInlineGenScorers] = useState(false)
  const exampleCount = dataset?.examples?.length || 0
  const approvedCount = (dataset?.examples || []).filter(
    (e) => e.review_status === 'approved',
  ).length
  // Rows tagged "new" — added by the prompt-eval auto-refresh from turns.
  // We show a notice on this tab so the user knows the dataset has grown
  // since the last eval run and a re-run would cover the new evidence.
  const newSinceRefresh = (dataset?.examples || []).filter(
    (e) => (e.coverage_tags || []).includes('new'),
  ).length

  // --- Braintrust key (managed in Settings now; we only check presence) ---
  const keySaved = hasBraintrustApiKey()

  // --- OpenRouter detection — gates the judge-model picker ---
  // The stored API key doubles as the OpenRouter key when it's prefixed with
  // sk-or-. Non-Claude judges require OpenRouter, so the picker is disabled
  // until the user configures one in Settings.
  const hasOpenRouterKey = getApiKey().startsWith('sk-or-')

  // --- Run config — seeded from per-user Settings defaults ---
  const [project, setProject] = useState(() => getDefaultBraintrustProject())
  const [experiment, setExperiment] = useState('')
  const [limit, setLimit] = useState<string>('') // empty = no limit
  const [includeTriggering, setIncludeTriggering] = useState(false)
  // Empty string in state means "use server default" (no judge_model override).
  const [judgeModel, setJudgeModel] = useState<string>(() => getDefaultJudgeModel())
  const updateJudgeModel = (value: string) => {
    setJudgeModel(value)
    setDefaultJudgeModel(value)
  }

  // --- Active run + history ---
  const [activeRun, setActiveRun] = useState<EvalRunSummary | null>(null)
  const [runs, setRuns] = useState<EvalRunSummary[]>([])
  // Skill versions for the version-timeline section. Lets the eval page show
  // "v1 (seed) → v2 (suggestion) → v3 (restore from v1)" alongside each
  // version's best eval avg, so the user sees iteration progress without
  // hopping back to the Skill tab.
  const [skillVersions, setSkillVersions] = useState<SkillVersion[]>([])
  const [startError, setStartError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const pollTimerRef = useRef<number | null>(null)

  const [runsError, setRunsError] = useState<string | null>(null)
  // Tracks an in-flight promote/discard so the buttons disable during the
  // request and the user gets a clear failure if it 4xx's.
  const [candidateActionBusy, setCandidateActionBusy] = useState(false)
  const [candidateActionError, setCandidateActionError] = useState<string | null>(null)
  // When set, opens the CharterDocument modal showing exactly what the
  // user clicked "View charter" for — either a run's snapshot or the live one.
  const [viewingCharter, setViewingCharter] = useState<{
    charter: Charter
    title: string
    subtitle?: string
  } | null>(null)

  // --- Suggestions (merged from ImprovePanel) ---
  const [summary, setSummary] = useState('')
  const [suggestions, setSuggestions] = useState<ImprovementSuggestion[]>([])
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [suggesting, setSuggesting] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)

  // --- Save ---
  const [savingNotes, setSavingNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState<SkillVersion | null>(null)

  const [diffVs, setDiffVs] = useState<{
    title: string
    subtitle?: string
    oldLabel: string
    newLabel: string
    oldText: string
    newText: string
  } | null>(null)
  const refreshRuns = useCallback(async () => {
    try {
      const list = await listEvalRuns(sessionId)
      setRuns(list)
      setRunsError(null)
    } catch (err) {
      setRunsError(err instanceof Error ? err.message : 'Failed to load run history')
    }
  }, [sessionId])

  useEffect(() => {
    refreshRuns()
  }, [refreshRuns])

  // Pull skill versions on mount + after every terminal run, so the timeline
  // reflects newly-saved versions (manual edits, accepted suggestions,
  // restores). Failure is non-fatal — the rest of the panel still works.
  const refreshSkillVersions = useCallback(async () => {
    try {
      const list = await listSkillVersions(sessionId)
      setSkillVersions(list)
    } catch {
      /* non-fatal */
    }
  }, [sessionId])

  useEffect(() => {
    refreshSkillVersions()
  }, [refreshSkillVersions])

  // Poll the active run until it reaches a terminal state.
  useEffect(() => {
    if (!activeRun || TERMINAL_STATUSES.has(activeRun.status)) {
      return
    }
    const tick = async () => {
      try {
        const fresh = await getEvalRun(sessionId, activeRun.run_id)
        setActiveRun(fresh)
        if (TERMINAL_STATUSES.has(fresh.status)) {
          refreshRuns()
          refreshSkillVersions()
          // Tell the parent so it can refetch the dataset — backend clears
          // "new" tags from rows that participated in the run, and we want
          // the "X new rows" banner to drop without a manual reload.
          onRunTerminal?.()
        }
      } catch {
        // transient — try again next tick
      }
    }
    pollTimerRef.current = window.setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [activeRun, sessionId, refreshRuns])

  const canRun =
    keySaved &&
    (isPromptEval || hasSkillBody) &&
    scorerCount > 0 &&
    approvedCount > 0 &&
    !starting &&
    (!activeRun || TERMINAL_STATUSES.has(activeRun.status))

  const runWithConfig = useCallback(
    async (overrides?: { project?: string; experiment_name?: string; limit?: number; include_triggering?: boolean }) => {
      setStartError(null)
      setStarting(true)
      try {
        const run = await runEval(sessionId, {
          project: (overrides?.project ?? project).trim() || 'northstar-eval',
          experiment_name: overrides?.experiment_name ?? (experiment.trim() || undefined),
          limit: overrides?.limit ?? (limit.trim() ? parseInt(limit, 10) : undefined),
          include_triggering: overrides?.include_triggering ?? includeTriggering,
          // Forward a judge_model override whenever it's set, but suppress
          // it for OpenRouter slugs when no OR key is configured — those
          // would 404 on the backend. Anthropic IDs (no slash) always go
          // through.
          judge_model:
            judgeModel
              ? (judgeModel.includes('/') && !hasOpenRouterKey
                  ? undefined
                  : judgeModel)
              : undefined,
        })
        setActiveRun(run)
        // Refresh immediately so the pending row shows up in history, and
        // again after the poll would naturally update us (belt & suspenders).
        refreshRuns()
        return run
      } catch (err) {
        setStartError(err instanceof Error ? err.message : 'Failed to start eval')
        return null
      } finally {
        setStarting(false)
      }
    },
    [sessionId, project, experiment, limit, includeTriggering, judgeModel, refreshRuns],
  )

  const handleRun = async () => {
    if (!canRun) return
    await runWithConfig()
  }

  // --- Improvement handlers (merged from ImprovePanel) ---
  const handleSuggest = async () => {
    const doneRun = runs.find((r) => r.status === 'done')
    if (!doneRun) return
    setSuggesting(true)
    setSuggestError(null)
    setSummary('')
    setSuggestions([])
    setAccepted(new Set())
    setDismissed(new Set())
    setJustSaved(null)
    try {
      const res = await suggestImprovements(sessionId, doneRun.run_id)
      setSuggestions(res.suggestions)
      setSummary(res.summary || '')
      if (res.suggestions.length === 0) {
        setSuggestError(
          res.summary?.trim()
            ? null
            : 'No systematic patterns found. Either the skill is working or the dataset is too small — try more rows.',
        )
      }
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : 'Failed to generate suggestions')
    } finally {
      setSuggesting(false)
    }
  }

  const acceptedSuggestions = useMemo(
    () => suggestions.filter((s) => accepted.has(s.id)),
    [suggestions, accepted],
  )

  const preview: ProposedEdit[] = useMemo(() => {
    const result: ProposedEdit[] = []
    let cur = skillBody
    for (const s of suggestions) {
      if (!accepted.has(s.id)) continue
      const { body: next, mode } = applySuggestion(cur, s)
      result.push({ suggestion: s, appliedBody: next, mode })
      cur = next
    }
    return result
  }, [suggestions, accepted, skillBody])

  // Final body + per-suggestion mode map. The mode map drives the save-card
  // copy ("3 applied, 2 appended due to drift") and the per-row chip.
  const { body: finalBody, modes: finalModes } = useMemo(
    () => applyBatch(skillBody, acceptedSuggestions),
    [skillBody, acceptedSuggestions],
  )

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

  const handleSaveVersion = async (): Promise<boolean> => {
    if (!finalChanged || acceptedSuggestions.length === 0) return false
    setSaving(true)
    setSaveError(null)
    try {
      const { body, modes } = applyBatch(skillBody, acceptedSuggestions)
      const editedCount = acceptedSuggestions.filter(
        (s) => modes[s.id] === 'exact' || modes[s.id] === 'normalized',
      ).length
      const appendedCount = acceptedSuggestions.length - editedCount
      const summary =
        appendedCount > 0
          ? `Applied ${editedCount} as edits, appended ${appendedCount} due to snippet drift`
          : `Applied ${acceptedSuggestions.length} suggestion${acceptedSuggestions.length === 1 ? '' : 's'}`
      const noteParts = [summary, savingNotes.trim()].filter(Boolean)
      const newVersion = await createSkillVersion(sessionId, {
        body,
        notes: noteParts.join(' · ') || undefined,
        created_from: 'suggestion',
        applied_suggestion_ids: acceptedSuggestions.map((s) => s.id),
      })
      onSkillBodyChange(body)
      setSkillVersions((prev) => [newVersion, ...prev])
      setSuggestions([])
      setAccepted(new Set())
      setDismissed(new Set())
      setSummary('')
      setSavingNotes('')
      setJustSaved(newVersion)
      await onSessionChanged?.()
      return true
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save new version')
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleRestore = async (v: SkillVersion) => {
    if (!confirm(`Restore v${v.version} as active? The current body will stay in history.`)) return
    try {
      await restoreSkillVersion(sessionId, v.id)
      onSkillBodyChange(v.body)
      refreshRuns()
      refreshSkillVersions()
    } catch (err) {
      console.error('Restore failed', err)
    }
  }

  // Auto-trigger when the parent passes autoRun=true (e.g. user clicked
  // "Run evaluations" on the Improve tab). Reuses the most recent run's
  // config as defaults so they don't have to re-enter project name etc.
  const autoRunConsumedRef = useRef(false)
  useEffect(() => {
    if (!autoRun || autoRunConsumedRef.current) return
    if (!canRun) return
    autoRunConsumedRef.current = true
    const previous = runs.find((r) => r.status === 'done') || runs[0]
    runWithConfig({
      project: previous?.project || project,
      experiment_name: undefined, // let Braintrust auto-name so it doesn't clash
      limit: limit.trim() ? parseInt(limit, 10) : undefined,
      include_triggering: includeTriggering,
    }).then(() => {
      onAutoRunConsumed?.()
    })
  }, [autoRun, canRun, runs, runWithConfig, project, limit, includeTriggering, onAutoRunConsumed])

  // Readiness — each missing precondition renders as a one-click action
  // the user can take in-place. Old UX was a text list ("Need: scorers");
  // new UX turns each missing item into a button so the user never has to
  // find their way to the right tab.
  type Blocker = {
    id: string
    label: string
    action?: { label: string; onClick: () => void; loading?: boolean }
  }
  const blockers: Blocker[] = []
  if (!keySaved) {
    blockers.push({ id: 'key', label: 'Braintrust API key required (enter below)' })
  }
  if (!isPromptEval && !hasSkillBody) {
    blockers.push({
      id: 'skill',
      label: 'Paste a SKILL.md to seed the session',
      action: onGoToSkill ? { label: 'Go to Skill', onClick: onGoToSkill } : undefined,
    })
  }
  if (scorerCount === 0) {
    const generateInline = onGenerateScorersInline
      ? async () => {
          setInlineGenScorers(true)
          try {
            await onGenerateScorersInline()
          } finally {
            setInlineGenScorers(false)
          }
        }
      : undefined
    blockers.push({
      id: 'scorers',
      label: 'No scorers yet',
      action: generateInline
        ? { label: 'Generate scorers', onClick: generateInline, loading: inlineGenScorers }
        : onGoToScorers
          ? { label: 'Go to Scorers', onClick: onGoToScorers }
          : undefined,
    })
  }
  if (approvedCount === 0) {
    blockers.push({
      id: 'dataset',
      label: exampleCount === 0 ? 'No dataset examples' : 'No approved examples — review the dataset',
      action: onGoToDataset ? { label: 'Go to Dataset', onClick: onGoToDataset } : undefined,
    })
  }

  const versionHistoryRight = skillVersions.length > 0 ? (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <History className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Version history
        </h3>
        <span className="text-xs text-muted-foreground">
          ({skillVersions.length} version{skillVersions.length === 1 ? '' : 's'})
        </span>
      </div>
      <ul className="space-y-1">
        {skillVersions.map((v, i) => {
          const isActive = v.id === (activeVersionId || skillVersions[0]?.id)
          const olderVersions = skillVersions.slice(i + 1)
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
                {olderVersions.length > 0 && (
                  <select
                    className="text-[10px] bg-background border border-border px-1 py-0.5 focus:outline-none"
                    value=""
                    onChange={(e) => {
                      if (!e.target.value) return
                      const oldV = skillVersions.find((x) => x.id === e.target.value)
                      if (!oldV) return
                      setDiffVs({
                        title: `v${oldV.version} → v${v.version}`,
                        subtitle: v.notes || undefined,
                        oldLabel: `v${oldV.version}`,
                        newLabel: `v${v.version}`,
                        oldText: oldV.body,
                        newText: v.body,
                      })
                    }}
                    title="Diff against a previous version"
                  >
                    <option value="" disabled>Diff vs…</option>
                    {olderVersions.map((o) => (
                      <option key={o.id} value={o.id}>v{o.version}</option>
                    ))}
                  </select>
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
    </div>
  ) : null

  return (
    <PanelLayout
      title="Evaluate"
      right={versionHistoryRight}
    >
        <div className="max-w-2xl space-y-8">
          {isPromptEval && newSinceRefresh > 0 && (
            <div className="flex items-start gap-3 px-3 py-2 bg-accent/10 border border-accent/30 text-xs">
              <Sparkles className="w-4 h-4 text-accent flex-shrink-0 mt-0.5" />
              <div className="text-foreground">
                <span className="font-medium">
                  {newSinceRefresh} new {newSinceRefresh === 1 ? 'row' : 'rows'} added
                </span>{' '}
                since the last eval run — turns landed in production and were
                auto-imported into the dataset. Run the eval to score them.
              </div>
            </div>
          )}

          {/* Pending-candidate banner — visible whenever a candidate
              exists, regardless of run state. Tells the user "you have a
              proposed change waiting; run an eval to test it, or discard
              it now". The richer Promote/Discard banner with row-by-row
              diff appears only after a run lands; this is the always-on
              entry point that reminds the user the candidate exists. */}
          {(() => {
            if (!candidateVersionId) return null
            const candidate = skillVersions.find((v) => v.id === candidateVersionId)
            if (!candidate) return null
            return (
              <div className="mb-3 flex items-center justify-between gap-3 border border-warning/40 bg-warning/5 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    Candidate v{candidate.version} pending — run an eval to compare it to the active version.
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {candidate.notes || 'New SKILL.md from accepted suggestions.'}
                  </p>
                </div>
                <button
                  onClick={async () => {
                    setCandidateActionError(null)
                    setCandidateActionBusy(true)
                    try {
                      await discardSkillVersion(sessionId, candidateVersionId)
                      await refreshSkillVersions()
                      await onCandidateChanged?.()
                    } catch (err) {
                      setCandidateActionError(err instanceof Error ? err.message : 'Failed to discard')
                    } finally {
                      setCandidateActionBusy(false)
                    }
                  }}
                  disabled={candidateActionBusy}
                  className="flex-shrink-0 px-3 py-1.5 text-xs font-medium border border-border bg-surface hover:bg-muted/30 disabled:opacity-50"
                  title="Discard the candidate without running an eval. Reverts SKILL.md to the active version. The candidate stays in history."
                >
                  Discard candidate
                </button>
              </div>
            )
          })()}

          {/* --- Braintrust run section --- */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 bg-accent/10 flex items-center justify-center">
                <PlayCircle className="w-4 h-4 text-accent" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Run with Braintrust</h3>
                <p className="text-xs text-muted-foreground">
                  {isPromptEval
                    ? "Replays the prompt under test against each sampled turn snapshot, scores with the project's scorers, streams results into Braintrust."
                    : "Runs each approved dataset row through Claude with your SKILL.md as system prompt, scores with the charter's scorers, streams results into Braintrust."}
                </p>
              </div>
            </div>

            {/* Readiness — list of missing preconditions with fix-it buttons */}
            {blockers.length > 0 && (
              <ul className="mb-3 space-y-1">
                {blockers.map((b) => (
                  <li
                    key={b.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 bg-warning/10 border border-warning/30 text-xs text-foreground"
                  >
                    <span className="truncate">{b.label}</span>
                    {b.action && (
                      <button
                        onClick={b.action.onClick}
                        disabled={b.action.loading}
                        className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-warning/20 text-warning hover:bg-warning/30 disabled:opacity-50"
                      >
                        {b.action.loading && <Loader2 className="w-3 h-3 animate-spin" />}
                        {b.action.label}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* Missing Braintrust key — full-width banner routes the user to
                Settings rather than cluttering the run panel with a key input. */}
            {!keySaved && (
              <div className="mb-3 flex items-center justify-between gap-3 px-3 py-2 bg-warning/10 border border-warning/30 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <KeyRound className="w-3.5 h-3.5 text-warning flex-shrink-0" />
                  <span className="text-foreground truncate">
                    A Braintrust API key is required to run evaluations.
                  </span>
                </div>
                {onOpenSettings && (
                  <button
                    onClick={onOpenSettings}
                    className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-warning/20 text-warning hover:bg-warning/30"
                  >
                    <SettingsIcon className="w-3 h-3" />
                    Add in Settings
                  </button>
                )}
              </div>
            )}

            {/* Run config */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                  Project
                </label>
                <input
                  type="text"
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  placeholder="northstar-eval"
                  className="w-full text-xs bg-background border border-border px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div>
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                  Experiment (optional)
                </label>
                <input
                  type="text"
                  value={experiment}
                  onChange={(e) => setExperiment(e.target.value)}
                  placeholder="auto"
                  className="w-full text-xs bg-background border border-border px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div>
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                  Limit (rows)
                </label>
                <input
                  type="number"
                  min={1}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  placeholder={`${approvedCount} approved`}
                  className="w-full text-xs bg-background border border-border px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              {!isPromptEval && (
                <div className="flex items-end">
                  <label
                    className="flex items-center gap-2 text-xs text-foreground cursor-pointer"
                    title="Off-target rows have no expected_output — this will just log what Claude produces, not score it. Use skill-creator for proper routing evals."
                  >
                    <input
                      type="checkbox"
                      checked={includeTriggering}
                      onChange={(e) => setIncludeTriggering(e.target.checked)}
                      className="w-3.5 h-3.5"
                    />
                    Include off-target rows (should NOT trigger)
                  </label>
                </div>
              )}
              <div className="col-span-2">
                <label
                  className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1"
                  title="Model used to grade scorer outputs. Anthropic judges work out of the box; non-Claude (OpenRouter) options require an sk-or-... key in Settings."
                >
                  Judge model
                </label>
                {/* Always show the picker — Anthropic judges work without an
                    OpenRouter key. Non-Anthropic options stay disabled until
                    an sk-or-... key is configured. Routing for the selected
                    model (direct Anthropic vs via OpenRouter) is summarized
                    in the status line below. */}
                <select
                  value={judgeModel}
                  onChange={(e) => updateJudgeModel(e.target.value)}
                  className="w-full text-xs bg-background border border-border px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  {JUDGE_MODEL_OPTIONS.map((opt) => {
                    const needsOR = opt.provider === 'openrouter'
                    const disabled = needsOR && !hasOpenRouterKey
                    return (
                      <option
                        key={opt.label}
                        value={opt.value ?? ''}
                        disabled={disabled}
                      >
                        {opt.label}
                      </option>
                    )
                  })}
                </select>
                {(() => {
                  // Tell the user which API the selected judge will hit:
                  //   - With an sk-or-... key, EVERY model routes via OpenRouter
                  //     (Anthropic ones included — OpenRouter proxies them).
                  //   - Without one, only Anthropic-native options work; OR
                  //     options are disabled and we surface the upgrade path.
                  const selectedOpt = JUDGE_MODEL_OPTIONS.find(o => (o.value ?? '') === judgeModel) || JUDGE_MODEL_OPTIONS[0]
                  if (hasOpenRouterKey) {
                    return (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Routes via OpenRouter (your stored API key is sk-or-…).
                      </p>
                    )
                  }
                  if (selectedOpt.provider === 'openrouter') {
                    return (
                      <button
                        onClick={onOpenSettings}
                        className="mt-1 inline-flex items-center gap-1 text-[10px] text-warning hover:text-foreground"
                      >
                        <SettingsIcon className="w-3 h-3" />
                        This judge needs an OpenRouter key — add one in Settings.
                      </button>
                    )
                  }
                  return (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Routes direct to Anthropic. Add an OpenRouter key in Settings to also evaluate with GPT, Gemini, Llama.
                    </p>
                  )
                })()}
              </div>
            </div>

            <button
              onClick={handleRun}
              disabled={!canRun}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium ${
                canRun
                  ? 'bg-accent text-accent-foreground hover:opacity-90 cursor-pointer'
                  : 'bg-muted text-muted-foreground cursor-not-allowed'
              }`}
            >
              {starting || (activeRun && !TERMINAL_STATUSES.has(activeRun.status)) ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <PlayCircle className="w-4 h-4" />
              )}
              Run evaluation
            </button>
            {startError && (
              <p className="mt-2 text-xs text-danger">{startError}</p>
            )}
          </section>

          {/* --- Active run status --- */}
          {activeRun && (
            <section className="border border-border p-4 bg-surface-raised">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-foreground">
                      {activeRun.project}
                      {activeRun.experiment_name && ` · ${activeRun.experiment_name}`}
                    </p>
                    {activeRun.skill_version_number != null && (
                      <span
                        className="font-mono text-[10px] uppercase px-1.5 py-0.5 bg-muted text-muted-foreground"
                        title="Which SKILL.md version this run evaluated against"
                      >
                        SKILL v{activeRun.skill_version_number}
                      </span>
                    )}
                    {judgeLabel(activeRun.judge_model_used) && (
                      <span
                        className="font-mono text-[10px] uppercase px-1.5 py-0.5 bg-muted text-muted-foreground"
                        title="Judge model used to grade this run"
                      >
                        JUDGE: {judgeLabel(activeRun.judge_model_used)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {activeRun.status === 'pending' && 'Queued...'}
                    {activeRun.status === 'running' && 'Running — this may take a few minutes.'}
                    {activeRun.status === 'done' &&
                      `Done. Evaluated ${activeRun.rows_evaluated}/${activeRun.rows_total} rows.`}
                    {activeRun.status === 'failed' && 'Failed — every row errored. See details below.'}
                    {activeRun.status === 'error' && 'Failed to start the run.'}
                    {activeRun.status === 'cancelled' && 'Cancelled.'}
                  </p>
                </div>
                {(activeRun.status === 'pending' || activeRun.status === 'running') && (
                  <button
                    onClick={async () => {
                      try {
                        const fresh = await cancelEvalRun(sessionId, activeRun.run_id)
                        setActiveRun(fresh)
                        await refreshRuns()
                      } catch (err) {
                        setStartError(err instanceof Error ? err.message : 'Failed to cancel')
                      }
                    }}
                    className="px-2 py-1 text-xs font-medium border border-border bg-surface hover:bg-danger/10 hover:text-danger hover:border-danger/40"
                    title="Stop this eval run. The Braintrust task can't be killed mid-flight, so it'll finish in the background — but we'll drop the results."
                  >
                    Stop
                  </button>
                )}
                <span
                  className={`text-xs font-mono uppercase px-2 py-0.5 ${
                    activeRun.status === 'done'
                      ? 'bg-success/15 text-success'
                      : activeRun.status === 'error' || activeRun.status === 'failed'
                        ? 'bg-danger/15 text-danger'
                        : activeRun.status === 'cancelled'
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-accent/15 text-accent'
                  }`}
                >
                  {activeRun.status}
                </span>
              </div>

              {(activeRun.status === 'error' || activeRun.status === 'failed') && activeRun.error && (
                <pre className="text-xs text-danger whitespace-pre-wrap bg-danger/5 p-2 border border-danger/20">
                  {activeRun.error}
                </pre>
              )}
              {activeRun.status === 'done' && activeRun.error && (
                <pre className="text-xs text-warning whitespace-pre-wrap bg-warning/5 p-2 border border-warning/20">
                  {activeRun.error}
                </pre>
              )}

              {activeRun.status === 'done' && (
                <>
                  <div className="flex items-center gap-3 mb-3 flex-wrap">
                    {activeRun.experiment_url && (
                      <a
                        href={activeRun.experiment_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
                      >
                        View in Braintrust <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {activeRun.charter_snapshot && (
                      <button
                        onClick={() =>
                          setViewingCharter({
                            charter: activeRun.charter_snapshot as Charter,
                            title: `Charter used for this run`,
                            subtitle: `${activeRun.project}${activeRun.experiment_name ? ' · ' + activeRun.experiment_name : ''}${activeRun.skill_version_number != null ? ' · SKILL v' + activeRun.skill_version_number : ''}`,
                          })
                        }
                        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        View charter
                      </button>
                    )}
                  </div>

                  {/* Promote / Discard banner — visible only when the
                      active run was evaluated against the candidate version.
                      Lets the user commit (promote) or revert (discard)
                      based on the run results, instead of the candidate
                      silently becoming the new active. Also shows per-row
                      regression diff vs the most recent active-version run. */}
                  {candidateVersionId &&
                    activeRun.skill_version_id === candidateVersionId &&
                    (() => {
                      // Find the latest active-version run as the baseline
                      // for the row-by-row delta. Same project so scorer set
                      // matches; same status so we have real numbers.
                      const baseline = runs.find(
                        (r) =>
                          r.run_id !== activeRun.run_id &&
                          r.project === activeRun.project &&
                          r.skill_version_id === activeVersionId &&
                          r.status === 'done',
                      )
                      // Per-row diff. Match by metadata.id; compute mean
                      // score per row across scorers.
                      const PASS_THRESHOLD = 0.8
                      const meanScore = (
                        scores: Record<string, number> | undefined,
                      ): number | null => {
                        if (!scores) return null
                        const vals = Object.values(scores)
                        if (!vals.length) return null
                        return vals.reduce((a, b) => a + b, 0) / vals.length
                      }
                      const baselineByRow = new Map<string, number>()
                      if (baseline) {
                        for (const r of baseline.per_row) {
                          const id = (r.metadata as Record<string, unknown> | undefined)?.id as string | undefined
                          const m = meanScore(r.scores)
                          if (id && m !== null) baselineByRow.set(id, m)
                        }
                      }
                      const regressed: { id: string; before: number; after: number }[] = []
                      const improved: { id: string; before: number; after: number }[] = []
                      for (const r of activeRun.per_row) {
                        const id = (r.metadata as Record<string, unknown> | undefined)?.id as string | undefined
                        if (!id) continue
                        const after = meanScore(r.scores)
                        const before = baselineByRow.get(id)
                        if (before === undefined || after === null) continue
                        const wasPassing = before >= PASS_THRESHOLD
                        const isPassing = after >= PASS_THRESHOLD
                        if (wasPassing && !isPassing) regressed.push({ id, before, after })
                        else if (!wasPassing && isPassing) improved.push({ id, before, after })
                      }
                      const onPromote = async () => {
                        setCandidateActionError(null)
                        setCandidateActionBusy(true)
                        try {
                          await promoteSkillVersion(sessionId, candidateVersionId)
                          await refreshSkillVersions()
                          await onCandidateChanged?.()
                        } catch (err) {
                          setCandidateActionError(err instanceof Error ? err.message : 'Failed to promote')
                        } finally {
                          setCandidateActionBusy(false)
                        }
                      }
                      const onDiscard = async () => {
                        setCandidateActionError(null)
                        setCandidateActionBusy(true)
                        try {
                          await discardSkillVersion(sessionId, candidateVersionId)
                          await refreshSkillVersions()
                          await onCandidateChanged?.()
                        } catch (err) {
                          setCandidateActionError(err instanceof Error ? err.message : 'Failed to discard')
                        } finally {
                          setCandidateActionBusy(false)
                        }
                      }
                      return (
                        <div className="mb-4 border border-warning/40 bg-warning/5 p-3">
                          <div className="flex items-start gap-3 flex-wrap">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-foreground">
                                This run evaluated a candidate version
                                {activeRun.skill_version_number != null && (
                                  <> (v{activeRun.skill_version_number})</>
                                )}
                                .
                              </p>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {baseline
                                  ? `Compared to v${baseline.skill_version_number ?? '?'} (the active version): ${improved.length} row${improved.length === 1 ? '' : 's'} improved, ${regressed.length} regressed.`
                                  : 'No prior run on the active version to compare against — promote based on overall scores.'}
                              </p>
                            </div>
                            <div className="flex gap-2 flex-shrink-0">
                              <button
                                onClick={onDiscard}
                                disabled={candidateActionBusy}
                                className="px-3 py-1.5 text-xs font-medium border border-border bg-surface hover:bg-muted/30 disabled:opacity-50"
                                title="Revert to the previous active version. The candidate stays in history but isn't the body the next eval runs against."
                              >
                                Discard candidate
                              </button>
                              <button
                                onClick={onPromote}
                                disabled={candidateActionBusy}
                                className="px-3 py-1.5 text-xs font-medium bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50"
                                title="Make this candidate the new active SKILL.md."
                              >
                                Promote to active
                              </button>
                            </div>
                          </div>
                          {candidateActionError && (
                            <p className="mt-2 text-xs text-danger">{candidateActionError}</p>
                          )}
                          {regressed.length > 0 && (
                            <details className="mt-3">
                              <summary className="text-[10px] font-medium text-danger uppercase tracking-wide cursor-pointer">
                                {regressed.length} regressed row{regressed.length === 1 ? '' : 's'} (was passing, now failing)
                              </summary>
                              <ul className="mt-2 space-y-1">
                                {regressed.slice(0, 20).map((r) => (
                                  <li
                                    key={r.id}
                                    className="flex items-center gap-2 text-[11px] font-mono px-2 py-1 bg-danger/5"
                                  >
                                    <span className="text-foreground truncate flex-1">{r.id.slice(0, 16)}</span>
                                    <span className="text-muted-foreground">{(r.before * 100).toFixed(0)}%</span>
                                    <span className="text-danger">→</span>
                                    <span className="text-danger">{(r.after * 100).toFixed(0)}%</span>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                          {improved.length > 0 && (
                            <details className="mt-2">
                              <summary className="text-[10px] font-medium text-success uppercase tracking-wide cursor-pointer">
                                {improved.length} improved row{improved.length === 1 ? '' : 's'} (was failing, now passing)
                              </summary>
                              <ul className="mt-2 space-y-1">
                                {improved.slice(0, 20).map((r) => (
                                  <li
                                    key={r.id}
                                    className="flex items-center gap-2 text-[11px] font-mono px-2 py-1 bg-success/5"
                                  >
                                    <span className="text-foreground truncate flex-1">{r.id.slice(0, 16)}</span>
                                    <span className="text-muted-foreground">{(r.before * 100).toFixed(0)}%</span>
                                    <span className="text-success">→</span>
                                    <span className="text-success">{(r.after * 100).toFixed(0)}%</span>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </div>
                      )
                    })()}

                  {skillVersions.length > 0 && (() => {
                    // Skill version timeline — one row per version, with the
                    // best eval avg achieved on that version. Scoped to the
                    // active run's project so a different scorer set on
                    // another project doesn't pollute the comparison. Active
                    // version (the one this run evaluated) is highlighted.
                    const bestAvgFor = (versionId: string): number | null => {
                      const versionRuns = runs.filter(
                        (r) =>
                          r.skill_version_id === versionId &&
                          r.project === activeRun.project &&
                          r.status === 'done',
                      )
                      const avgs = versionRuns
                        .map((r) => {
                          const vals = Object.values(r.scorer_averages)
                          if (!vals.length) return null
                          return vals.reduce((a, b) => a + b, 0) / vals.length
                        })
                        .filter((x): x is number => x !== null)
                      if (!avgs.length) return null
                      return Math.max(...avgs)
                    }
                    const sorted = [...skillVersions].sort((a, b) => a.version - b.version)
                    return (
                      <div className="mb-4">
                        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                          Skill version timeline
                        </p>
                        <ul className="space-y-1">
                          {sorted.map((v) => {
                            const avg = bestAvgFor(v.id)
                            const isActiveVersion = v.id === activeRun.skill_version_id
                            const isCandidate = v.id === candidateVersionId
                            const isActive = v.id === activeVersionId
                            return (
                              <li
                                key={v.id}
                                className={`flex items-center gap-2 text-xs px-2 py-1 ${
                                  isActiveVersion ? 'bg-accent/5 border-l-2 border-accent' : 'bg-muted/20'
                                }`}
                              >
                                <span className="font-mono text-foreground flex-shrink-0">v{v.version}</span>
                                {isActive && (
                                  <span className="font-mono text-[10px] uppercase px-1 py-0.5 bg-accent/20 text-accent flex-shrink-0">
                                    active
                                  </span>
                                )}
                                {isCandidate && (
                                  <span className="font-mono text-[10px] uppercase px-1 py-0.5 bg-warning/15 text-warning flex-shrink-0">
                                    candidate
                                  </span>
                                )}
                                <span
                                  className={`font-mono text-[10px] uppercase px-1 py-0.5 flex-shrink-0 ${
                                    v.created_from === 'restore'
                                      ? 'bg-warning/15 text-warning'
                                      : v.created_from === 'suggestion'
                                        ? 'bg-accent/15 text-accent'
                                        : v.created_from === 'seed'
                                          ? 'bg-success/15 text-success'
                                          : 'bg-muted/30 text-muted-foreground'
                                  }`}
                                >
                                  {v.created_from}
                                </span>
                                <span className="text-muted-foreground truncate flex-1">
                                  {v.notes || '—'}
                                </span>
                                <span className="font-mono flex-shrink-0">
                                  {avg !== null ? (
                                    <span className={scoreColor(avg)}>{(avg * 100).toFixed(0)}%</span>
                                  ) : (
                                    <span
                                      className="text-muted-foreground"
                                      title={
                                        isCandidate
                                          ? "No eval has run on this candidate yet — use the 'Run with Braintrust' panel above to test it."
                                          : 'No completed run for this version in this project.'
                                      }
                                    >
                                      no run
                                    </span>
                                  )}
                                </span>
                                {isCandidate && (
                                  <div className="flex gap-1 flex-shrink-0">
                                    <button
                                      onClick={async () => {
                                        setCandidateActionError(null)
                                        setCandidateActionBusy(true)
                                        try {
                                          await discardSkillVersion(sessionId, v.id)
                                          await refreshSkillVersions()
                                          await onCandidateChanged?.()
                                        } catch (err) {
                                          setCandidateActionError(
                                            err instanceof Error ? err.message : 'Failed to discard',
                                          )
                                        } finally {
                                          setCandidateActionBusy(false)
                                        }
                                      }}
                                      disabled={candidateActionBusy}
                                      className="px-2 py-0.5 text-[10px] font-medium border border-border bg-surface hover:bg-muted/30 disabled:opacity-50"
                                      title="Discard candidate without running an eval. Reverts SKILL.md to the active version."
                                    >
                                      Discard
                                    </button>
                                    <button
                                      onClick={async () => {
                                        setCandidateActionError(null)
                                        setCandidateActionBusy(true)
                                        try {
                                          await promoteSkillVersion(sessionId, v.id)
                                          await refreshSkillVersions()
                                          await onCandidateChanged?.()
                                        } catch (err) {
                                          setCandidateActionError(
                                            err instanceof Error ? err.message : 'Failed to promote',
                                          )
                                        } finally {
                                          setCandidateActionBusy(false)
                                        }
                                      }}
                                      disabled={candidateActionBusy}
                                      className="px-2 py-0.5 text-[10px] font-medium bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50"
                                      title="Promote this candidate to the active version (you can do this without running an eval, but the whole point of the candidate flow is to gate on a confirming run)."
                                    >
                                      Promote
                                    </button>
                                  </div>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )
                  })()}

                  {Object.keys(activeRun.scorer_averages).length > 0 && (() => {
                    // Find both:
                    //   - previous run (most recent older than this one)
                    //   - original run (earliest done run on SKILL v1 — what
                    //     the user started with). Lets the user see whether
                    //     iteration is paying off vs the seed skill, not just
                    //     vs the last edit.
                    // `runs` comes back sorted newest-first from the backend.
                    const activeStart = activeRun.started_at || activeRun.finished_at
                    const olderDone = runs.filter(
                      (r) =>
                        r.run_id !== activeRun.run_id &&
                        r.status === 'done' &&
                        (!activeStart ||
                          !r.started_at ||
                          new Date(r.started_at).getTime() < new Date(activeStart).getTime()),
                    )
                    const previousRun =
                      olderDone.find((r) => r.project === activeRun.project) || olderDone[0] || null
                    // Original = oldest done run on SKILL v1 in this project.
                    // Fall back to oldest done run overall if no v1 run exists
                    // (e.g. legacy runs without skill_version_number).
                    const v1Runs = olderDone
                      .filter((r) => r.project === activeRun.project && r.skill_version_number === 1)
                      .sort((a, b) => {
                        const at = a.started_at ? new Date(a.started_at).getTime() : 0
                        const bt = b.started_at ? new Date(b.started_at).getTime() : 0
                        return at - bt
                      })
                    const fallbackOldest = [...olderDone].sort((a, b) => {
                      const at = a.started_at ? new Date(a.started_at).getTime() : 0
                      const bt = b.started_at ? new Date(b.started_at).getTime() : 0
                      return at - bt
                    })[0] || null
                    let originalRun = v1Runs[0] || fallbackOldest
                    // Don't double-count: if "original" is the same row as
                    // "previous", drop it — the column would just duplicate.
                    if (originalRun && previousRun && originalRun.run_id === previousRun.run_id) {
                      originalRun = null
                    }
                    // And don't compare the run to itself.
                    if (originalRun && originalRun.run_id === activeRun.run_id) {
                      originalRun = null
                    }
                    const previousLabel = previousRun
                      ? previousRun.skill_version_number != null
                        ? `SKILL v${previousRun.skill_version_number}`
                        : previousRun.experiment_name || 'previous'
                      : null
                    const originalLabel = originalRun
                      ? originalRun.skill_version_number != null
                        ? `SKILL v${originalRun.skill_version_number}`
                        : 'original'
                      : null
                    return (
                      <div className="mb-4">
                        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-2 flex-wrap">
                          <span>Per-scorer averages</span>
                          {previousLabel && (
                            <span className="font-mono normal-case text-muted-foreground/70">
                              vs prev ({previousLabel})
                            </span>
                          )}
                          {originalLabel && (
                            <span className="font-mono normal-case text-muted-foreground/70">
                              · vs original ({originalLabel})
                            </span>
                          )}
                        </p>
                        <ul className="space-y-1">
                          {Object.entries(activeRun.scorer_averages).map(([name, avg]) => {
                            const prev = previousRun?.scorer_averages?.[name]
                            const orig = originalRun?.scorer_averages?.[name]
                            const prevDelta = prev !== undefined ? avg - prev : null
                            const origDelta = orig !== undefined ? avg - orig : null
                            const deltaClass = (d: number) =>
                              Math.abs(d) < 0.01
                                ? 'text-muted-foreground'
                                : d > 0
                                  ? 'text-success'
                                  : 'text-danger'
                            return (
                              <li
                                key={name}
                                className="flex items-center justify-between text-xs bg-muted/30 px-2 py-1 gap-3"
                              >
                                <span className="font-mono text-foreground truncate flex-1">{name}</span>
                                <div className="flex items-center gap-2 flex-shrink-0">
                                  {prevDelta !== null && (
                                    <span
                                      className={`font-mono ${deltaClass(prevDelta)}`}
                                      title={`vs prev: ${(prev! * 100).toFixed(0)}%`}
                                    >
                                      {prevDelta > 0 ? '+' : ''}
                                      {(prevDelta * 100).toFixed(0)}pp
                                    </span>
                                  )}
                                  {origDelta !== null && (
                                    <span
                                      className={`font-mono ${deltaClass(origDelta)}`}
                                      title={`vs original: ${(orig! * 100).toFixed(0)}%`}
                                    >
                                      ({origDelta > 0 ? '+' : ''}
                                      {(origDelta * 100).toFixed(0)}pp)
                                    </span>
                                  )}
                                  <span className={`font-mono font-medium ${scoreColor(avg)}`}>
                                    {(avg * 100).toFixed(0)}%
                                  </span>
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )
                  })()}

                  {/* --- Suggest improvements --- */}
                  <div className="mb-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Sparkles className="w-4 h-4 text-accent" />
                      <h4 className="text-sm font-semibold text-foreground">Suggest improvements</h4>
                    </div>
                    {(() => {
                      const doneRun = runs.find((r) => r.status === 'done')
                      if (!doneRun) {
                        return (
                          <div className="px-3 py-2 bg-warning/10 border border-warning/30 text-xs text-foreground">
                            No completed eval runs yet. Run one first.
                          </div>
                        )
                      }
                      return (
                        <>
                          <button
                            onClick={handleSuggest}
                            disabled={suggesting}
                            className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium ${
                              !suggesting
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
                          {!suggestions.length && summary && (
                            <p className="mt-2 text-xs text-foreground bg-muted/20 p-2 border-l-2 border-accent">
                              {summary}
                            </p>
                          )}
                        </>
                      )
                    })()}
                  </div>

                  {/* --- Suggestions list --- */}
                  {suggestions.length > 0 && (
                    <div className="mb-4">
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
                          // Show the per-suggestion preview against the
                          // *current* body, independent of other accepts.
                          // The save flow uses applyBatch for sequential
                          // application, but here we just want to know
                          // what this single suggestion would do.
                          const { body: applied } = applySuggestion(skillBody, s)
                          const matchKind = getMatchKind(skillBody, s)
                          // 'exact' or 'normalized' means we found a real
                          // edit point; 'appended' means the find drifted
                          // and we'll tack the replacement onto the end.
                          const findMatched = matchKind !== 'appended' || !s.find

                          if (isCollapsed) {
                            const shortFind = s.find.length > 40 ? s.find.slice(0, 40) + '…' : s.find
                            const shortRepl = s.replacement.length > 40 ? s.replacement.slice(0, 40) + '…' : s.replacement
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
                                      <span className="font-mono line-through text-muted-foreground">{shortFind}</span>{' '}
                                      →{' '}
                                      <span className="font-mono text-foreground">{shortRepl}</span>
                                    </>
                                  ) : (
                                    <>
                                      <span className="text-muted-foreground">append</span>{' '}
                                      <span className="font-mono text-foreground">{shortRepl}</span>
                                    </>
                                  )}
                                </span>
                                <div className="flex gap-1 flex-shrink-0">
                                  <button
                                    onClick={() => setDiffVs({
                                      title: s.summary,
                                      subtitle: s.rationale,
                                      oldLabel: 'current SKILL.md',
                                      newLabel: 'after this edit',
                                      oldText: skillBody,
                                      newText: applied,
                                    })}
                                    className="p-1 text-muted-foreground hover:text-foreground"
                                    title="Preview diff"
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => isAccepted ? toggleAccept(s.id) : toggleDismiss(s.id)}
                                    className="p-1 text-muted-foreground hover:text-foreground"
                                    title="Undo"
                                  >
                                    <RotateCcw className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </li>
                            )
                          }

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
                                {!findMatched && s.find && (
                                  <span
                                    className="font-mono text-[10px] uppercase px-1.5 py-0.5 bg-warning/15 text-warning"
                                    title="The model quoted a snippet that doesn't appear verbatim in the current SKILL.md (probably whitespace drift). Accepting will append the new text to the end of the file instead."
                                  >
                                    will append (snippet drift)
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
                                      newText: applied,
                                    })}
                                    className="p-1 text-muted-foreground hover:text-foreground"
                                    title="Preview diff"
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => toggleAccept(s.id)}
                                    className="p-1 text-muted-foreground hover:text-success"
                                    title={findMatched ? 'Accept' : "Accept (couldn't locate snippet — will append)"}
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
                                    <span key={n} className="font-mono px-1.5 py-0.5 bg-muted/50">{n}</span>
                                  ))}
                                  {s.source_row_ids.slice(0, 5).map((id) => (
                                    <span key={id} className="font-mono px-1.5 py-0.5 bg-muted/50">{id.slice(0, 8)}</span>
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
                            Ready to save v{(skillVersions[0]?.version ?? 0) + 1}
                          </p>
                          <p className="text-xs text-muted-foreground mb-3">
                            {acceptedSuggestions.length} suggestion{acceptedSuggestions.length === 1 ? '' : 's'} accepted ·{' '}
                            {preview.filter((p) => p.appliedBody === null).length} couldn't be applied (find text not in SKILL.md).
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
                              onClick={() => setDiffVs({
                                title: `Preview v${(skillVersions[0]?.version ?? 0) + 1}`,
                                oldLabel: `v${skillVersions[0]?.version ?? 0}`,
                                newLabel: `v${(skillVersions[0]?.version ?? 0) + 1} (preview)`,
                                oldText: skillBody,
                                newText: finalBody,
                              })}
                              className="px-3 py-1.5 text-xs font-medium bg-muted text-foreground hover:bg-muted/70"
                            >
                              <Eye className="w-3.5 h-3.5 inline" /> Preview combined diff
                            </button>
                            <button
                              onClick={async () => {
                                const saved = await handleSaveVersion()
                                if (saved) {
                                  setJustSaved(null)
                                }
                              }}
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
                    </div>
                  )}

                  {/* --- Post-save CTA --- */}
                  {justSaved && (
                    <div className="mb-4 border border-warning bg-warning/5 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground">
                            v{justSaved.version} ready as a candidate.
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Evaluate the new version to see if it actually improves things.
                            {justSaved.applied_suggestion_ids.length > 0 && (
                              <> Applied {justSaved.applied_suggestion_ids.length} suggestion{justSaved.applied_suggestion_ids.length === 1 ? '' : 's'}.</>
                            )}
                          </p>
                        </div>
                        <button
                          onClick={async () => {
                            setJustSaved(null)
                            const run = await onRunEval({})
                            if (run) setActiveRun(run as EvalRunSummary)
                          }}
                          className="flex-shrink-0 px-3 py-1.5 text-xs font-medium bg-accent text-accent-foreground hover:opacity-90"
                        >
                          Evaluate new version
                        </button>
                      </div>
                    </div>
                  )}

                  {activeRun.per_row.length > 0 && (
                    <details className="mt-2">
                      <summary className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide cursor-pointer mb-2">
                        Per-row results ({activeRun.per_row.length})
                      </summary>
                      <ul className="space-y-3 mt-2">
                        {activeRun.per_row.map((row, i) => {
                          const metadata = (row.metadata || {}) as Record<string, unknown>
                          const inputStr =
                            typeof row.input === 'object' && row.input !== null
                              ? ((row.input as Record<string, unknown>).input as string) || JSON.stringify(row.input)
                              : String(row.input ?? '')
                          const outputStr = typeof row.output === 'string' ? row.output : JSON.stringify(row.output, null, 2)
                          const expectedStr = typeof row.expected === 'string' ? row.expected : JSON.stringify(row.expected, null, 2)
                          return (
                            <li key={i} className="border border-border p-3 bg-muted/10 text-xs space-y-2">
                              <div className="flex flex-wrap gap-1">
                                {Object.entries(row.scores).map(([name, score]) => (
                                  <span
                                    key={name}
                                    className={`font-mono px-1.5 py-0.5 bg-background ${scoreColor(score)}`}
                                  >
                                    {name}: {(score * 100).toFixed(0)}%
                                  </span>
                                ))}
                              </div>
                              {row.error && (
                                <div className="text-danger">Error: {row.error}</div>
                              )}
                              <div>
                                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Input</span>
                                <pre className="whitespace-pre-wrap break-words text-foreground mt-0.5">{inputStr}</pre>
                              </div>
                              <div>
                                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Output</span>
                                <pre className="whitespace-pre-wrap break-words text-foreground mt-0.5">{outputStr}</pre>
                              </div>
                              {expectedStr && (
                                <details>
                                  <summary className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide cursor-pointer">
                                    Expected
                                  </summary>
                                  <pre className="whitespace-pre-wrap break-words text-foreground mt-0.5">{expectedStr}</pre>
                                </details>
                              )}
                              {(metadata.feature_area as string) && (
                                <div className="text-[10px] text-muted-foreground">
                                  feature_area: {metadata.feature_area as string}
                                </div>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    </details>
                  )}
                </>
              )}
                     </section>
          )}

          {/* --- Run history --- always visible once the user has an API
               key saved, so they can see runs from this session and tell
               immediately if fetching failed. Shows all runs including the
               currently-viewed one (marked as 'viewing'). */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Run history
              </h3>
              <button
                onClick={() => refreshRuns()}
                className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                title="Refresh history from the server"
              >
                Refresh
              </button>
            </div>
            {runsError && (
              <div className="px-3 py-2 mb-2 bg-danger/10 border border-danger/30 text-xs text-danger">
                {runsError}
              </div>
            )}
            {runs.length === 0 && !runsError && (
              <p className="text-xs text-muted-foreground/70 italic">
                No runs yet — start one above.
              </p>
            )}
            {runs.length > 0 && (
              <ul className="space-y-1">
                {runs.map((r) => {
                  const isActive = activeRun?.run_id === r.run_id
                  return (
                    <li
                      key={r.run_id}
                      onClick={() => setActiveRun(r)}
                      className={`flex items-center justify-between text-xs px-3 py-2 cursor-pointer ${
                        isActive
                          ? 'bg-accent/10 border-l-2 border-accent'
                          : 'bg-muted/20 hover:bg-muted/40'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-foreground truncate flex items-center gap-2 flex-wrap">
                          {isActive && (
                            <span className="font-mono text-[10px] uppercase px-1 bg-accent/20 text-accent">
                              viewing
                            </span>
                          )}
                          <span>{r.project}</span>
                          {r.experiment_name && <span>· {r.experiment_name}</span>}
                          {r.skill_version_number != null && (
                            <span className="font-mono text-[10px] uppercase px-1 bg-muted/40 text-muted-foreground">
                              SKILL v{r.skill_version_number}
                            </span>
                          )}
                          {judgeLabel(r.judge_model_used) && (
                            <span
                              className="font-mono text-[10px] uppercase px-1 bg-muted/40 text-muted-foreground"
                              title="Judge model used to grade this run"
                            >
                              JUDGE: {judgeLabel(r.judge_model_used)}
                            </span>
                          )}
                        </p>
                        <p className="text-muted-foreground">
                          {formatWhen(r.started_at)} · {r.rows_evaluated}/{r.rows_total} rows
                          {r.status === 'done' && Object.keys(r.scorer_averages).length > 0 && (() => {
                            const vals = Object.values(r.scorer_averages)
                            const mean = vals.reduce((a, b) => a + b, 0) / vals.length
                            return <> · avg {(mean * 100).toFixed(0)}%</>
                          })()}
                        </p>
                      </div>
                      {r.charter_snapshot && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setViewingCharter({
                              charter: r.charter_snapshot as Charter,
                              title: `Charter used for this run`,
                              subtitle: `${r.project}${r.experiment_name ? ' · ' + r.experiment_name : ''}${r.skill_version_number != null ? ' · SKILL v' + r.skill_version_number : ''}`,
                            })
                          }}
                          className="ml-2 p-1 text-muted-foreground hover:text-foreground"
                          title="View the charter this run evaluated"
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <span
                        className={`ml-3 font-mono text-[10px] uppercase px-1.5 py-0.5 ${
                          r.status === 'done'
                            ? 'bg-success/15 text-success'
                            : r.status === 'error'
                              ? 'bg-danger/15 text-danger'
                              : 'bg-accent/15 text-accent'
                        }`}
                      >
                        {r.status}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* --- Direct download (kept from before) --- */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Download
            </h3>
            <button
              onClick={onExport}
              disabled={!dataset}
              className={`w-full flex items-center gap-3 p-4 border border-border transition-colors ${
                dataset ? 'hover:bg-muted/50 cursor-pointer' : 'opacity-50 cursor-not-allowed'
              }`}
            >
              <div className="w-10 h-10 bg-accent/10 flex items-center justify-center flex-shrink-0">
                <Download className="w-5 h-5 text-accent" />
              </div>
              <div className="text-left">
                <p className="text-sm font-medium text-foreground">Download JSON</p>
                <p className="text-xs text-muted-foreground">
                  Raw dataset — {exampleCount} examples — for use outside Braintrust
                </p>
              </div>
            </button>
          </section>

          {viewingCharter && (
            <CharterDocument
              charter={viewingCharter.charter}
              title={viewingCharter.title}
              subtitle={viewingCharter.subtitle}
              onClose={() => setViewingCharter(null)}
            />
          )}

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
    </PanelLayout>
  )
}
