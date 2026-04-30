import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Eye, ExternalLink, FileText, KeyRound, Loader2, RotateCcw, Settings as SettingsIcon, Sparkles, X } from 'lucide-react'
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

export default function EvaluatePanel({
  sessionId,
  dataset,
  scorerCount,
  hasSkillBody,
  isPromptEval = false,
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
  // Initial-load gate for the version stack. We start true so the panel
  // doesn't flash an empty stack on mount; the first refreshSkillVersions
  // flips it to false. The fetch usually takes ~1-2s.
  const [versionsLoading, setVersionsLoading] = useState(true)
  const [startError, setStartError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const pollTimerRef = useRef<number | null>(null)

  const [runsError, setRunsError] = useState<string | null>(null)
  // Tracks an in-flight promote/discard so the buttons disable during the
  // request and the user gets a clear failure if it 4xx's.
  const [candidateActionBusy, setCandidateActionBusy] = useState(false)
  const [candidateActionError, setCandidateActionError] = useState<string | null>(null)
  // Toggles the older-versions list under the version stack at the top of
  // the main column. Defaults to collapsed — most users only care about
  // candidate + active.
  const [showAllVersions, setShowAllVersions] = useState(false)
  // Skill version filter — clicking a card in the version stack pins the
  // run history below to that version's runs only, and auto-opens the
  // latest run for it. Null means "show all versions" (the default before
  // the user clicks). When candidate exists, we pre-select it so the user
  // immediately sees the runs that gate promotion.
  const [selectedSkillVersionId, setSelectedSkillVersionId] = useState<
    string | null
  >(null)
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
    } finally {
      setVersionsLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    refreshSkillVersions()
  }, [refreshSkillVersions])

  // Seed the version filter exactly once on first load. Pre-pick the
  // candidate (user's most likely focus); otherwise the active version.
  // The ref guard is critical: without it, the effect re-fires every time
  // selectedSkillVersionId becomes null — including the user clicking
  // "Show all versions" — and instantly snaps the filter back. With the
  // ref, a user-initiated null is sticky.
  const versionSeededRef = useRef(false)
  useEffect(() => {
    if (versionSeededRef.current) return
    if (skillVersions.length === 0) return
    versionSeededRef.current = true
    setSelectedSkillVersionId(candidateVersionId || activeVersionId || null)
  }, [skillVersions, candidateVersionId, activeVersionId])

  // When the version filter changes (or runs load), auto-open the most
  // recent terminal run on the selected version. If the active run still
  // matches the new filter, keep it; otherwise switch to the latest run on
  // this version. Picking null shows all runs and keeps the active run as-is.
  useEffect(() => {
    if (!selectedSkillVersionId) return
    if (runs.length === 0) return
    const filtered = runs.filter((r) => r.skill_version_id === selectedSkillVersionId)
    if (filtered.length === 0) return
    if (activeRun && filtered.some((r) => r.run_id === activeRun.run_id)) return
    // runs come back newest-first from the API, so filtered[0] is latest.
    setActiveRun(filtered[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSkillVersionId, runs])

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
  // Caller can pin a specific run id; otherwise we analyze the currently-open
  // run, or fall back to the latest done/failed run. The in-context "Analyze
  // this run" button at the bottom of the active-run section passes the
  // active run's id explicitly so the analysis targets what the user is
  // looking at, not the most recent run globally.
  const handleSuggest = async (runId?: string) => {
    const targetRunId =
      runId ||
      (activeRun && (activeRun.status === 'done' || activeRun.status === 'failed')
        ? activeRun.run_id
        : runs.find((r) => r.status === 'done' || r.status === 'failed')?.run_id)
    if (!targetRunId) return
    setSuggesting(true)
    setSuggestError(null)
    setSummary('')
    setSuggestions([])
    setAccepted(new Set())
    setDismissed(new Set())
    setJustSaved(null)
    try {
      const res = await suggestImprovements(sessionId, targetRunId)
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

  // Improve sidebar — sits in the right rail, mirrors the SuggestionBox
  // pattern used by Goals/Users/Charter (sparkle header + refresh + body).
  // Visible whenever there's a completed run to analyze or any in-flight
  // suggestion state. The previous Improve content lived inline in the
  // main column; the new Figma design moves it to a persistent right
  // column so the user can iterate on the candidate without losing the
  // run results context.
  const doneRunForImprove = runs.find((r) => r.status === 'done' || r.status === 'failed')
  const newSkillVersionNumber = (skillVersions[0]?.version ?? 0) + 1
  const couldNotApplyCount = preview.filter((p) => p.mode === 'appended').length
  const improveRight = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-fg-primary" />
          <span className="text-base font-semibold text-fg-contrast">Improve skill</span>
        </div>
        {doneRunForImprove && (
          <button
            onClick={handleSuggest}
            disabled={suggesting}
            className="p-1.5 text-fg-dim hover:text-fg-contrast disabled:opacity-50"
            title={suggesting ? 'Analyzing…' : 'Re-analyze the latest run'}
          >
            {suggesting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RotateCcw className="w-4 h-4" />
            )}
          </button>
        )}
      </div>

      {!doneRunForImprove && (
        <p className="text-xs text-fg-dim">
          Run an evaluation first. The "Analyze this run" button below the
          run details proposes targeted SKILL.md edits from the run's failures.
        </p>
      )}

      {doneRunForImprove && !suggestions.length && !suggesting && !suggestError && !summary && (
        <p className="text-xs text-fg-dim">
          Use "Analyze this run" at the bottom of the run details to propose targeted SKILL.md edits.
        </p>
      )}

      {suggesting && !suggestions.length && (
        <div className="flex items-center gap-2 text-xs text-fg-dim">
          <Loader2 className="w-4 h-4 animate-spin" />
          Analyzing failures…
        </div>
      )}

      {suggestError && <p className="text-xs text-danger">{suggestError}</p>}

      {summary && (
        <p className="text-sm text-fg-contrast leading-relaxed">{summary}</p>
      )}

      {suggestions.length > 0 && (
        <>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-dim">
            Proposed edits ({suggestions.length})
          </p>

          <ul className="space-y-2">
            {suggestions.map((s) => {
              const isAccepted = accepted.has(s.id)
              const isDismissed = dismissed.has(s.id)
              const { body: applied } = applySuggestion(skillBody, s)
              const matchKind = getMatchKind(skillBody, s)
              const willAppend = matchKind === 'appended' && !!s.find

              return (
                <li
                  key={s.id}
                  className={`p-3 text-sm space-y-2 ${
                    isAccepted
                      ? 'bg-fill-primary/5 border border-fill-primary/40'
                      : isDismissed
                        ? 'bg-fill-neutral/30 opacity-60'
                        : 'bg-fill-neutral/40'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <p className="flex-1 text-sm text-fg-contrast leading-snug">
                      {s.summary}
                    </p>
                    <div className="flex gap-1 flex-shrink-0">
                      <button
                        onClick={() =>
                          setDiffVs({
                            title: s.summary,
                            subtitle: s.rationale,
                            oldLabel: 'current SKILL.md',
                            newLabel: 'after this edit',
                            oldText: skillBody,
                            newText: applied,
                          })
                        }
                        className="p-1 text-fg-dim hover:text-fg-contrast"
                        title="Preview diff"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      {!isAccepted && !isDismissed && (
                        <>
                          <button
                            onClick={() => toggleAccept(s.id)}
                            className="p-1 text-fg-dim hover:text-success"
                            title={
                              willAppend
                                ? "Accept (couldn't locate snippet — will append)"
                                : 'Accept'
                            }
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => toggleDismiss(s.id)}
                            className="p-1 text-fg-dim hover:text-danger"
                            title="Dismiss"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                      {(isAccepted || isDismissed) && (
                        <button
                          onClick={() =>
                            isAccepted ? toggleAccept(s.id) : toggleDismiss(s.id)
                          }
                          className="p-1 text-fg-dim hover:text-fg-contrast"
                          title="Undo"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {willAppend && (
                    <p className="text-[10px] uppercase tracking-wide text-warning">
                      Will append (snippet drift)
                    </p>
                  )}

                  <p className="text-xs text-fg-dim leading-relaxed">{s.rationale}</p>

                  {s.find && (
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-dim">
                        Replace
                      </p>
                      <pre className="px-2 py-1.5 bg-success/15 text-success whitespace-pre-wrap break-words font-mono text-xs leading-snug">
                        {s.find}
                      </pre>
                    </div>
                  )}
                  <div className="space-y-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-dim">
                      {s.find ? 'With' : 'Append'}
                    </p>
                    <pre className="px-2 py-1.5 bg-danger/15 text-danger whitespace-pre-wrap break-words font-mono text-xs leading-snug">
                      {s.replacement}
                    </pre>
                  </div>
                </li>
              )
            })}
          </ul>

          {acceptedSuggestions.length > 0 && (
            <div className="border border-fill-primary/40 bg-fill-primary/5 p-3 space-y-2">
              <p className="text-sm font-semibold text-fg-contrast">
                Ready to save v{newSkillVersionNumber}
              </p>
              <p className="text-xs text-fg-dim">
                {acceptedSuggestions.length} accepted
                {couldNotApplyCount > 0 && (
                  <> · {couldNotApplyCount} appended due to drift</>
                )}
              </p>
              <input
                type="text"
                value={savingNotes}
                onChange={(e) => setSavingNotes(e.target.value)}
                placeholder="Optional note about this version…"
                className="w-full text-xs bg-fill-dip border border-border-hint px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-fill-primary"
              />
              <div className="flex gap-2">
                <button
                  onClick={() =>
                    setDiffVs({
                      title: `Preview v${newSkillVersionNumber}`,
                      oldLabel: `v${skillVersions[0]?.version ?? 0}`,
                      newLabel: `v${newSkillVersionNumber} (preview)`,
                      oldText: skillBody,
                      newText: finalBody,
                    })
                  }
                  className="px-2.5 py-1 text-xs font-medium border border-border-hint text-fg-contrast hover:bg-fill-neutral/30"
                >
                  <Eye className="w-3.5 h-3.5 inline mr-1" />
                  Preview
                </button>
                <button
                  onClick={async () => {
                    const ok = await handleSaveVersion()
                    if (ok) setJustSaved(null)
                  }}
                  disabled={saving || !finalChanged}
                  className={`flex-1 px-3 py-1 text-xs font-medium ${
                    finalChanged && !saving
                      ? 'bg-fill-primary text-bg-default hover:opacity-90'
                      : 'bg-fill-neutral text-fg-dim cursor-not-allowed'
                  }`}
                >
                  {saving && <Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1" />}
                  Save as v{newSkillVersionNumber}
                </button>
              </div>
              {saveError && <p className="text-xs text-danger">{saveError}</p>}
            </div>
          )}
        </>
      )}

      {justSaved && (
        <div className="border border-warning/40 bg-warning/5 p-3 space-y-2">
          <p className="text-sm font-semibold text-fg-contrast">
            v{justSaved.version} ready as a candidate.
          </p>
          <p className="text-xs text-fg-dim">
            Evaluate the new version to see if it actually improves things.
          </p>
          <button
            onClick={async () => {
              setJustSaved(null)
              const run = await onRunEval({})
              if (run) setActiveRun(run as EvalRunSummary)
            }}
            className="w-full px-3 py-1.5 text-xs font-medium bg-fill-primary text-bg-default hover:opacity-90"
          >
            Evaluate new version
          </button>
        </div>
      )}
    </div>
  )

  return (
    <PanelLayout
      title="Evaluations"
      subtitle={
        isPromptEval
          ? "Replays the prompt under test against each sampled turn snapshot, scores with the project's scorers, streams results into Braintrust."
          : "Runs each approved dataset row through Claude with your SKILL.md as system prompt, scores with the project's scorers, streams results into Braintrust."
      }
      right={improveRight}
    >
        <div className="space-y-8">
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

          {/* Compact version stack — pinned set is {selected, latest}.
              Older + active fold into "+ N more" expanders so the section
              stays small unless the user explicitly opens it. Shows +X/-Y
              row-regression pills on the candidate vs active baseline. */}
          <h3 className="text-base font-semibold text-fg-contrast mb-3">
            Skill versions
          </h3>
          {versionsLoading && skillVersions.length === 0 && (
            <div className="mb-6 space-y-0.5" aria-busy="true" aria-live="polite">
              {/* Skeleton preloader — matches the row shape so the layout
                  doesn't shift when real data lands. The first version
                  list fetch usually takes ~1-2s; an empty area looked like
                  "no versions" instead of "loading". */}
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 px-3 py-3 bg-fill-neutral/40 animate-pulse"
                >
                  <span className="w-8 h-4 bg-fill-neutral/60" />
                  <span className="w-20 h-4 bg-fill-neutral/60" />
                  <span className="flex-1" />
                  <span className="w-24 h-6 bg-fill-neutral/60" />
                </div>
              ))}
            </div>
          )}
          {(() => {
            if (skillVersions.length === 0) return null

            // Find the candidate + currently-active records explicitly.
            const candidateVer = candidateVersionId
              ? skillVersions.find((v) => v.id === candidateVersionId)
              : null
            const activeVer = activeVersionId
              ? skillVersions.find((v) => v.id === activeVersionId)
              : skillVersions[0]
            if (!candidateVer && !activeVer) return null

            // Latest run per version for the +X/-Y pill computation.
            const latestRunFor = (verId: string) =>
              runs.find(
                (r) =>
                  r.skill_version_id === verId &&
                  (r.status === 'done' || r.status === 'failed'),
              ) || null

            // Compute row-diff stats vs the previous-active baseline.
            const PASS_THRESHOLD = 0.8
            const meanScore = (scores: Record<string, number> | undefined): number | null => {
              if (!scores) return null
              const vals = Object.values(scores)
              if (!vals.length) return null
              return vals.reduce((a, b) => a + b, 0) / vals.length
            }
            const computeDiff = (run: EvalRunSummary | null, baseline: EvalRunSummary | null) => {
              if (!run) return null
              if (!baseline) return null
              const baselineByRow = new Map<string, number>()
              for (const r of baseline.per_row) {
                const id = (r.metadata as Record<string, unknown> | undefined)?.id as string | undefined
                const m = meanScore(r.scores)
                if (id && m !== null) baselineByRow.set(id, m)
              }
              let improved = 0
              let regressed = 0
              for (const r of run.per_row) {
                const id = (r.metadata as Record<string, unknown> | undefined)?.id as string | undefined
                if (!id) continue
                const after = meanScore(r.scores)
                const before = baselineByRow.get(id)
                if (before === undefined || after === null) continue
                const wasPassing = before >= PASS_THRESHOLD
                const isPassing = after >= PASS_THRESHOLD
                if (wasPassing && !isPassing) regressed++
                else if (!wasPassing && isPassing) improved++
              }
              return { improved, regressed }
            }

            const candidateRun = candidateVer ? latestRunFor(candidateVer.id) : null
            const activeRunForVer = activeVer ? latestRunFor(activeVer.id) : null
            const candidateDiff = computeDiff(candidateRun, activeRunForVer)

            const onDiscardCandidate = async () => {
              if (!candidateVersionId) return
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
            const onPromoteCandidate = async () => {
              if (!candidateVersionId) return
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

            const renderVersionRow = (
              v: SkillVersion,
              opts: {
                badge: 'candidate' | 'active' | 'history'
                actions?: React.ReactNode
                diff?: { improved: number; regressed: number } | null
              },
            ) => {
              const summaryText =
                v.notes ||
                (v.applied_suggestion_ids?.length
                  ? `Applied ${v.applied_suggestion_ids.length} of ${v.applied_suggestion_ids.length} suggestions`
                  : `Created from ${v.created_from}`)
              const isCandidate = opts.badge === 'candidate'
              const isHistory = opts.badge === 'history'
              const isSelected = selectedSkillVersionId === v.id
              return (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedSkillVersionId(v.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelectedSkillVersionId(v.id)
                    }
                  }}
                  className={`flex items-center gap-3 px-3 py-3 transition-colors cursor-pointer ${
                    isSelected
                      ? 'border-2 border-fill-primary bg-transparent'
                      : `border-2 border-transparent hover:bg-fill-neutral/50 ${
                          isHistory ? 'bg-fill-neutral/20' : 'bg-fill-neutral/40'
                        }`
                  }`}
                  aria-pressed={isSelected}
                >
                  <span className="text-base text-fg-contrast flex-shrink-0">v{v.version}</span>
                  <span
                    className={`font-mono text-[10px] uppercase px-1.5 py-0.5 flex-shrink-0 ${
                      opts.badge === 'candidate'
                        ? 'bg-fill-neutral text-fg-dim'
                        : opts.badge === 'active'
                          ? 'bg-bg-default text-fg-dim'
                          : 'bg-fill-neutral/60 text-fg-dim'
                    }`}
                  >
                    {opts.badge === 'candidate'
                      ? 'Candidate'
                      : opts.badge === 'active'
                        ? 'Active'
                        : v.created_from}
                  </span>
                  {opts.diff && (opts.diff.improved > 0 || opts.diff.regressed > 0) && (
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <span className="font-mono text-xs px-1.5 py-0.5 bg-success/20 text-success">
                        +{opts.diff.improved}
                      </span>
                      <span className="font-mono text-xs px-1.5 py-0.5 bg-danger/20 text-danger">
                        -{opts.diff.regressed}
                      </span>
                    </div>
                  )}
                  <span className="text-xs text-fg-dim truncate flex-1 min-w-0">{summaryText}</span>
                  {opts.actions && <div className="flex gap-1 flex-shrink-0">{opts.actions}</div>}
                </div>
              )
            }

            // Sort newest-first. Pinned set is selected ± 1 — selected
            // plus its immediate neighbours, so the user can hop one step
            // either way without expanding — PLUS candidate and active
            // whenever they exist. Always pinning candidate + active means
            // the Discard / Make active / Restore buttons never disappear
            // behind a "see more" expander, even when the user is poking
            // through unrelated history rows. When selected sits at the
            // ends or shares a slot with candidate/active, the pinned set
            // collapses naturally (Set dedupes).
            //
            // Defensive fallback: if selectedSkillVersionId references a
            // version that no longer exists (got discarded from another
            // tab, etc.), findIndex returns -1; treat that as anchor=0
            // (latest) so we don't render a lone "+ N older versions"
            // expander with nothing above it.
            const sortedDesc = [...skillVersions].sort((a, b) => b.version - a.version)
            const rawAnchor = selectedSkillVersionId
              ? sortedDesc.findIndex((v) => v.id === selectedSkillVersionId)
              : 0
            const anchorIdx = rawAnchor === -1 ? 0 : rawAnchor
            const pinnedIds = new Set<string>()
            if (sortedDesc.length > 0) {
              pinnedIds.add(sortedDesc[anchorIdx].id)
              if (anchorIdx - 1 >= 0) pinnedIds.add(sortedDesc[anchorIdx - 1].id)
              if (anchorIdx + 1 < sortedDesc.length) pinnedIds.add(sortedDesc[anchorIdx + 1].id)
            }
            // Candidate + active stay pinned regardless of selection so
            // their action buttons (Discard/Make active/Restore) are
            // always reachable without expanding.
            if (candidateVersionId) pinnedIds.add(candidateVersionId)
            if (activeVersionId) pinnedIds.add(activeVersionId)

            const renderRow = (v: SkillVersion) => {
              const isCandidate = v.id === candidateVer?.id
              const isActive = v.id === activeVer?.id
              const badge: 'candidate' | 'active' | 'history' = isCandidate
                ? 'candidate'
                : isActive
                  ? 'active'
                  : 'history'
              const diff = isCandidate ? candidateDiff : null
              let actions: React.ReactNode = null
              if (isCandidate) {
                actions = (
                  <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onDiscardCandidate()
                      }}
                      disabled={candidateActionBusy}
                      className="px-2.5 py-1 text-xs font-medium border border-border-hint text-fg-contrast hover:bg-fill-neutral/30 disabled:opacity-50"
                      title="Revert SKILL.md to active. The candidate stays in history."
                    >
                      Discard
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onPromoteCandidate()
                      }}
                      disabled={candidateActionBusy}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-fill-primary text-bg-default hover:opacity-90 disabled:opacity-50"
                      title="Promote candidate to active SKILL.md."
                    >
                      <Check className="w-3.5 h-3.5" />
                      Make active
                    </button>
                  </>
                )
              } else if (!isActive && !candidateVersionId) {
                actions = (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRestore(v)
                    }}
                    className="p-1 text-fg-dim hover:text-fg-contrast"
                    title="Restore as active"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )
              }
              return (
                <div key={v.id}>{renderVersionRow(v, { badge, diff, actions })}</div>
              )
            }

            // Build the visible list by walking the sorted list and either
            // emitting the row (when pinned or showAllVersions) or counting
            // it as "skipped" until we hit the next pinned row. The trailing
            // skipped count is rendered after the loop.
            const items: React.ReactNode[] = []
            let skipped = 0
            sortedDesc.forEach((v, idx) => {
              const include = showAllVersions || pinnedIds.has(v.id)
              if (include) {
                if (skipped > 0) {
                  items.push(
                    <button
                      key={`gap-${idx}`}
                      onClick={() => setShowAllVersions(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg-dim hover:text-fg-contrast"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                      {skipped} more version{skipped === 1 ? '' : 's'}
                    </button>,
                  )
                  skipped = 0
                }
                items.push(renderRow(v))
              } else {
                skipped++
              }
            })
            if (skipped > 0) {
              items.push(
                <button
                  key="gap-end"
                  onClick={() => setShowAllVersions(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg-dim hover:text-fg-contrast"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                  {skipped} older version{skipped === 1 ? '' : 's'}
                </button>,
              )
            }
            // Hide-toggle visible whenever we're in expanded mode.
            const expandToggle = showAllVersions ? (
              <button
                onClick={() => setShowAllVersions(false)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg-dim hover:text-fg-contrast"
              >
                <ChevronUp className="w-3.5 h-3.5" />
                Show less
              </button>
            ) : null

            return (
              <div className="mb-6 space-y-0.5">
                {items}
                {expandToggle}
                {candidateActionError && (
                  <p className="text-xs text-danger px-3 py-1">{candidateActionError}</p>
                )}
              </div>
            )
          })()}

          {/* --- Run settings — single horizontal strip with the three
              fields the user actually changes (limit, judge, off-target),
              big purple Run button on the right. PROJECT/EXPERIMENT moved
              to "More options" since they have sensible defaults the user
              rarely touches. */}
          <h3 className="text-base font-semibold text-fg-contrast mb-3">
            Run settings
          </h3>
          <section className="space-y-3 mb-8">
            {/* Readiness — list of missing preconditions with fix-it buttons */}
            {blockers.length > 0 && (
              <ul className="space-y-1">
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
              <div className="flex items-center justify-between gap-3 px-3 py-2 bg-warning/10 border border-warning/30 text-xs">
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

            {/* Compact run-config row */}
            <div className="flex items-end gap-4 flex-wrap">
              <div className="flex flex-col gap-1.5 w-[140px]">
                <label className="text-[10px] font-semibold text-fg-dim uppercase tracking-wide">
                  Limit (rows)
                </label>
                <input
                  type="number"
                  min={1}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  placeholder={`${approvedCount} approved`}
                  className="w-full text-sm bg-fill-dip border border-border-hint px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-fill-primary"
                />
              </div>

              <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
                <label
                  className="text-[10px] font-semibold text-fg-dim uppercase tracking-wide"
                  title="Model used to grade scorer outputs. Anthropic judges work out of the box; non-Claude (OpenRouter) options require an sk-or-... key in Settings."
                >
                  Judge model
                </label>
                <select
                  value={judgeModel}
                  onChange={(e) => updateJudgeModel(e.target.value)}
                  className="w-full text-sm bg-fill-dip border border-border-hint px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-fill-primary"
                >
                  {JUDGE_MODEL_OPTIONS.map((opt) => {
                    const needsOR = opt.provider === 'openrouter'
                    const disabled = needsOR && !hasOpenRouterKey
                    return (
                      <option key={opt.label} value={opt.value ?? ''} disabled={disabled}>
                        {opt.label}
                      </option>
                    )
                  })}
                </select>
              </div>

              {!isPromptEval && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-semibold text-fg-dim uppercase tracking-wide">
                    Off-target rows
                  </label>
                  <div className="inline-flex border border-border-hint p-0.5">
                    <button
                      type="button"
                      onClick={() => setIncludeTriggering(false)}
                      className={`px-3 py-2 text-sm font-medium ${
                        !includeTriggering
                          ? 'bg-fill-neutral text-fg-contrast'
                          : 'text-fg-dim hover:text-fg-contrast'
                      }`}
                    >
                      Exclude
                    </button>
                    <button
                      type="button"
                      onClick={() => setIncludeTriggering(true)}
                      className={`px-3 py-2 text-sm font-medium ${
                        includeTriggering
                          ? 'bg-fill-neutral text-fg-contrast'
                          : 'text-fg-dim hover:text-fg-contrast'
                      }`}
                    >
                      Include
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={handleRun}
                disabled={!canRun}
                className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold ${
                  canRun
                    ? 'bg-fill-primary text-bg-default hover:opacity-90 cursor-pointer'
                    : 'bg-fill-neutral text-fg-dim cursor-not-allowed'
                }`}
              >
                {starting || (activeRun && !TERMINAL_STATUSES.has(activeRun.status)) ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                Run evaluation
              </button>
            </div>

            {/* Judge routing hint sits under the row so it doesn't widen any column */}
            {(() => {
              const selectedOpt =
                JUDGE_MODEL_OPTIONS.find((o) => (o.value ?? '') === judgeModel) ||
                JUDGE_MODEL_OPTIONS[0]
              if (hasOpenRouterKey) {
                return (
                  <p className="text-[10px] text-fg-dim">
                    Routes via OpenRouter (your stored API key is sk-or-…).
                  </p>
                )
              }
              if (selectedOpt.provider === 'openrouter') {
                return (
                  <button
                    onClick={onOpenSettings}
                    className="inline-flex items-center gap-1 text-[10px] text-warning hover:text-fg-contrast"
                  >
                    <SettingsIcon className="w-3 h-3" />
                    This judge needs an OpenRouter key — add one in Settings.
                  </button>
                )
              }
              return (
                <p className="text-[10px] text-fg-dim">
                  Routes direct to Anthropic. Add an OpenRouter key in Settings to also evaluate with GPT, Gemini, Llama.
                </p>
              )
            })()}

            {/* Project + experiment overrides — collapsed by default */}
            <details className="text-xs">
              <summary className="cursor-pointer text-fg-dim hover:text-fg-contrast inline-flex items-center gap-1.5">
                <ChevronDown className="w-3.5 h-3.5" />
                More options (project, experiment name)
              </summary>
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div>
                  <label className="text-[10px] font-semibold text-fg-dim uppercase tracking-wide block mb-1">
                    Project
                  </label>
                  <input
                    type="text"
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                    placeholder="northstar-eval"
                    className="w-full text-sm bg-fill-dip border border-border-hint px-3 py-2 focus:outline-none focus:ring-1 focus:ring-fill-primary"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-fg-dim uppercase tracking-wide block mb-1">
                    Experiment (optional)
                  </label>
                  <input
                    type="text"
                    value={experiment}
                    onChange={(e) => setExperiment(e.target.value)}
                    placeholder="auto"
                    className="w-full text-sm bg-fill-dip border border-border-hint px-3 py-2 focus:outline-none focus:ring-1 focus:ring-fill-primary"
                  />
                </div>
              </div>
            </details>

            {startError && <p className="text-xs text-danger">{startError}</p>}
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

                  {/* Promote/Discard banner + version timeline moved to the top of the column (see version stack above). Per-row regression details are still surfaced via the per-row results expander below when an active run is selected. */}

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

                  {/* Improve flow lives in the right rail (improveRight) — see top of return. */}

                  {/* Suggestions list, save block, post-save CTA all moved
                      to the right rail (improveRight). */}

                  {/* In-context Analyze CTA — sits at the end of the open
                      run section so the user can trigger improvement
                      analysis right from the results they're looking at,
                      without scrolling up to the right rail. The right rail
                      still renders the resulting summary + suggestions; this
                      is just the trigger. Only enabled for terminal runs
                      with rows to analyze. */}
                  {(activeRun.status === 'done' || activeRun.status === 'failed') && (
                    <div className="mt-4 pt-4 border-t border-border-hint flex items-center justify-between gap-3">
                      <p className="text-xs text-fg-dim">
                        Analyze the failures from this run to get proposed SKILL.md edits.
                      </p>
                      <button
                        onClick={() => handleSuggest(activeRun.run_id)}
                        disabled={suggesting}
                        className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm font-semibold ${
                          suggesting
                            ? 'bg-fill-neutral text-fg-dim cursor-not-allowed'
                            : 'bg-fill-primary text-bg-default hover:opacity-90'
                        }`}
                      >
                        {suggesting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Sparkles className="w-4 h-4" />
                        )}
                        Analyze this run
                      </button>
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

          {/* --- Run history --- restyled to status-dot + name + score
               percentage, with inline metadata (Skill: vN, Judge: model)
               below each run name. Click a row to make it active and see
               its per-scorer table inline (the active-run details section
               above renders against activeRun). */}
          <section>
            {(() => {
              // Filter run history to runs that match the selected version
              // card. When the user hasn't picked one (selectedSkillVersionId
              // is null), show all runs. The selected-version label below
              // tells the user what they're looking at.
              const filteredRuns = selectedSkillVersionId
                ? runs.filter((r) => r.skill_version_id === selectedSkillVersionId)
                : runs
              const selectedVer =
                selectedSkillVersionId &&
                skillVersions.find((v) => v.id === selectedSkillVersionId)
              return (
                <>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-base font-semibold text-fg-contrast">
                      Run history
                      {selectedVer && (
                        <span className="ml-2 text-fg-dim font-normal">
                          v{selectedVer.version}
                        </span>
                      )}
                    </h3>
                    <div className="flex items-center gap-3">
                      {selectedSkillVersionId && (
                        <button
                          onClick={() => setSelectedSkillVersionId(null)}
                          className="text-[10px] uppercase tracking-wide text-fg-dim hover:text-fg-contrast"
                          title="Show runs from every skill version"
                        >
                          Show all versions
                        </button>
                      )}
                      <button
                        onClick={() => refreshRuns()}
                        className="text-[10px] uppercase tracking-wide text-fg-dim hover:text-fg-contrast"
                        title="Refresh history from the server"
                      >
                        Refresh
                      </button>
                    </div>
                  </div>
                  {runsError && (
                    <div className="px-3 py-2 mb-2 bg-danger/10 border border-danger/30 text-xs text-danger">
                      {runsError}
                    </div>
                  )}
                  {filteredRuns.length === 0 && !runsError && (
                    <p className="text-xs text-fg-dim italic">
                      {selectedSkillVersionId
                        ? `No runs on v${selectedVer?.version ?? '?'} yet — run an evaluation above to see it here.`
                        : 'No runs yet — start one above.'}
                    </p>
                  )}
                  {filteredRuns.length > 0 && (
                    <ul className="space-y-0.5">
                      {filteredRuns.map((r) => {
                  const isActive = activeRun?.run_id === r.run_id
                  // Status dot color — green dot for healthy runs, red for
                  // any errored/cancelled state, yellow while running.
                  const dotColor =
                    r.status === 'done'
                      ? 'bg-success'
                      : r.status === 'error' || r.status === 'failed'
                        ? 'bg-danger'
                        : r.status === 'cancelled'
                          ? 'bg-fg-dim'
                          : 'bg-warning'
                  // Avg score (mean of per-scorer averages) — drives the
                  // colored badge on the right.
                  const meanScore = (() => {
                    if (r.status !== 'done') return null
                    const vals = Object.values(r.scorer_averages)
                    if (!vals.length) return null
                    return vals.reduce((a, b) => a + b, 0) / vals.length
                  })()
                  const scoreBadgeBg =
                    meanScore == null
                      ? 'bg-fill-neutral text-fg-dim'
                      : meanScore >= 0.8
                        ? 'bg-success/20 text-success'
                        : meanScore >= 0.5
                          ? 'bg-warning/20 text-warning'
                          : 'bg-danger/20 text-danger'
                  // Skill version → derive Active/Candidate/Latest tag the way
                  // the design shows it.
                  const skillTag =
                    r.skill_version_id === candidateVersionId
                      ? 'Candidate'
                      : r.skill_version_id === activeVersionId
                        ? 'Active'
                        : null
                  return (
                    <li
                      key={r.run_id}
                      onClick={() => setActiveRun(r)}
                      className={`px-4 py-3 cursor-pointer ${
                        isActive
                          ? 'bg-fill-neutral/40'
                          : 'bg-fill-neutral/20 hover:bg-fill-neutral/30'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`}
                          title={r.status}
                        />
                        <span className="text-sm font-semibold text-fg-contrast truncate flex-1">
                          {r.project}
                          {r.experiment_name && (
                            <span className="text-fg-dim font-normal"> · {r.experiment_name}</span>
                          )}
                        </span>
                        <span className="text-sm text-fg-dim/70 flex-shrink-0">
                          {r.rows_evaluated}/{r.rows_total} rows
                        </span>
                        <span
                          className={`font-mono text-sm font-semibold px-2 py-0.5 flex-shrink-0 ${scoreBadgeBg}`}
                        >
                          {meanScore == null
                            ? r.status.toUpperCase()
                            : `${(meanScore * 100).toFixed(0)}%`}
                        </span>
                      </div>

                      <div className="flex items-center gap-4 mt-1.5 ml-5 text-xs text-fg-dim flex-wrap">
                        {r.skill_version_number != null && (
                          <span className="text-fg-contrast">
                            <span className="text-fg-dim">Skill:</span>{' '}
                            <span className="font-semibold">v{r.skill_version_number}</span>
                            {skillTag && (
                              <span className="ml-1 font-mono text-[10px] uppercase px-1 py-0.5 bg-fill-neutral/60 text-fg-dim">
                                {skillTag}
                              </span>
                            )}
                          </span>
                        )}
                        {judgeLabel(r.judge_model_used) && (
                          <span className="text-fg-contrast">
                            <span className="text-fg-dim">Judge:</span>{' '}
                            <span className="font-semibold">
                              {judgeLabel(r.judge_model_used)}
                            </span>
                          </span>
                        )}
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
                            className="inline-flex items-center gap-1 font-mono text-fg-dim hover:text-fg-contrast"
                            title="View the charter this run evaluated"
                          >
                            <FileText className="w-3.5 h-3.5" />
                            View charter
                          </button>
                        )}
                        {r.experiment_url && (
                          <a
                            href={r.experiment_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 font-mono text-fg-dim hover:text-fg-contrast"
                          >
                            View in braintrust
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </div>
                    </li>
                  )
                })}
                    </ul>
                  )}
                </>
              )
            })()}
          </section>

          {/* Download moved to the Dataset page — that's where the user
              builds the dataset, so they can download from there. */}

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
