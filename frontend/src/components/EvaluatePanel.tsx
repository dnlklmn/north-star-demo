import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Eye, ExternalLink, FileText, KeyRound, Loader2, RotateCcw, Settings as SettingsIcon, Sparkles, X } from 'lucide-react'
import type { Seed, Dataset, EvalRunSummary, ImprovementSuggestion, SkillVersion, ScorerDef } from '../types'
import { countScorerKinds } from '../utils/scorerKind'
import { notePolarisActivity } from '../polaris/activity'
import SeedDocument from './SeedDocument'
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
  setEvalRunRowNote,
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
  /** Full scorer list for this session. EvaluatePanel uses it only to count
   *  judge vs deterministic so the run-config row can tell the user how many
   *  scorers the judge-model picker actually affects. `scorerCount` stays as
   *  the canonical "are there any?" check; this is purely for the hint. Pass
   *  the same array the Scorers tab uses so the two pages can't drift. */
  scorers?: ScorerDef[]
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
  /** Take the user to the Seed tab — used by the "Open in Seed"
   *  button on the unmapped-rows banner so they can add the missing
   *  alignment dimension or rename one to fit the synthesized rows. */
  onGoToSeed?: () => void
  /** Take the user to the Dataset tab with the feature_area filter
   *  pre-set to the synthetic "(unmapped)" value, so they land directly
   *  on the rows that need re-tagging. */
  onGoToUnmappedRows?: () => void
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

export default function EvaluatePanel({
  sessionId,
  dataset,
  scorerCount,
  scorers,
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
  onGoToSeed,
  onGoToUnmappedRows,
  onGenerateScorersInline,
  onOpenSettings,
  onRunTerminal,
  candidateVersionId,
  activeVersionId,
  onCandidateChanged,
  onSessionChanged,
}: Props) {
  const [inlineGenScorers, setInlineGenScorers] = useState(false)
  // Judge-model picker only affects judge scorers — deterministic ones run
  // pure Python and never invoke the judge client (see
  // backend/app/eval_runner.py::compile_scorers — call_judge is injected but
  // deterministic code doesn't reference it). Surface the split as a
  // subtitle below the dropdown so the user knows the picker isn't gating
  // their whole eval.
  const scorerKinds = useMemo(() => countScorerKinds(scorers), [scorers])
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
  // "Advanced" modal — project + experiment overrides. Defaults are sensible
  // enough that the modal stays closed >99% of the time.
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [limit, setLimit] = useState<string>('') // empty = no limit
  const [includeTriggering, setIncludeTriggering] = useState(false)
  // Agent mode: run the skill in a real tool-use loop with a sandboxed
  // filesystem instead of bare messages.create(). Required for honest
  // evaluation of tool-using skills (docx, pdf, xlsx, web fetch, image gen).
  const [agentMode, setAgentMode] = useState(false)
  const [allowBash, setAllowBash] = useState(false)
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
  // Run ids we've already auto-analyzed. The poll tick that detects a
  // terminal transition uses this to fire the analysis exactly once per
  // run, even if an extra tick slips through before the effect tears down.
  const autoAnalyzedRunsRef = useRef<Set<string>>(new Set())

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
  // When set, opens the SeedDocument modal showing exactly what the
  // user clicked "View seed" for — either a run's snapshot or the live one.
  const [viewingSeed, setViewingSeed] = useState<{
    seed: Seed
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

  // Per-row filter — clicking a scorer in per-scorer averages narrows the
  // per-row table to rows that aren't green (>=0.8) for that scorer. Reset
  // via the explicit button next to the per-row header.
  const [scorerFilter, setScorerFilter] = useState<string | null>(null)
  // Filter the per-row table to a single failure-mode cluster's row_ids —
  // mutually exclusive with scorerFilter so the user always sees one
  // narrowing at a time. Setting either clears the other.
  const [clusterFilter, setClusterFilter] = useState<string | null>(null)
  const [perRowOpen, setPerRowOpen] = useState(false)
  // Per-row reveal of judge reasoning. Keyed by `${exampleId}:${scorerName}`
  // so multiple rows can have different scorers expanded at once. Click a
  // score chip to toggle.
  const [expandedScorers, setExpandedScorers] = useState<Set<string>>(new Set())
  // Reset filters whenever the active run changes — a filter that survived
  // a run switch would silently hide rows on the new run.
  useEffect(() => {
    setScorerFilter(null)
    setClusterFilter(null)
  }, [activeRun?.run_id])

  // Per-row notes — textarea is always editable, Save/Cancel buttons only
  // appear when the draft differs from the persisted note. `noteDrafts`
  // holds keystroke-level state per example_id; absence of an entry means
  // the row is in sync with what's persisted.
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [noteSaving, setNoteSaving] = useState<Record<string, boolean>>({})
  const [noteError, setNoteError] = useState<Record<string, string>>({})
  // Reset drafts when switching runs — a draft on run A shouldn't survive
  // into run B's view.
  useEffect(() => {
    setNoteDrafts({})
    setNoteError({})
  }, [activeRun?.run_id])

  const updateNoteDraft = useCallback((exampleId: string, value: string) => {
    setNoteDrafts((d) => ({ ...d, [exampleId]: value }))
  }, [])

  const cancelNoteEdit = useCallback((exampleId: string) => {
    setNoteDrafts((d) => {
      if (!(exampleId in d)) return d
      const next = { ...d }
      delete next[exampleId]
      return next
    })
    setNoteError((e) => {
      if (!(exampleId in e)) return e
      const next = { ...e }
      delete next[exampleId]
      return next
    })
  }, [])

  const saveNote = useCallback(
    async (exampleId: string) => {
      if (!activeRun) return
      const draft = noteDrafts[exampleId]
      if (draft === undefined) return
      const runId = activeRun.run_id
      setNoteSaving((s) => ({ ...s, [exampleId]: true }))
      setNoteError((e) => {
        if (!(exampleId in e)) return e
        const next = { ...e }
        delete next[exampleId]
        return next
      })
      try {
        const updated = await setEvalRunRowNote(sessionId, runId, exampleId, draft)
        // Only apply the response if the user is still on the same run —
        // a slow PATCH that lands after a run switch would otherwise
        // overwrite the now-active run's state with the previous run's data.
        setActiveRun((cur) => (cur && cur.run_id === runId ? updated : cur))
        setRuns((rs) => rs.map((r) => (r.run_id === runId ? updated : r)))
        // Clear the draft — the textarea will now read from persistedNote
        // directly, matching the saved value.
        setNoteDrafts((d) => {
          const next = { ...d }
          delete next[exampleId]
          return next
        })
      } catch (err) {
        setNoteError((e) => ({
          ...e,
          [exampleId]: err instanceof Error ? err.message : 'Failed to save note',
        }))
      } finally {
        setNoteSaving((s) => {
          const next = { ...s }
          delete next[exampleId]
          return next
        })
      }
    },
    [activeRun, sessionId, noteDrafts],
  )

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
  const versionImportedRef = useRef(false)
  useEffect(() => {
    if (versionImportedRef.current) return
    if (skillVersions.length === 0) return
    versionImportedRef.current = true
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
          // Auto-analyze the moment a run finishes so the Evaluation
          // analysis sidebar populates without the user clicking "Analyze
          // this run". Only done/failed runs carry results worth analyzing;
          // the per-run guard keeps a stray extra tick from double-firing.
          if (
            (fresh.status === 'done' || fresh.status === 'failed') &&
            !autoAnalyzedRunsRef.current.has(fresh.run_id)
          ) {
            autoAnalyzedRunsRef.current.add(fresh.run_id)
            void handleSuggestRef.current(fresh.run_id)
          }
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
  }, [activeRun, sessionId, refreshRuns, refreshSkillVersions, onRunTerminal])

  const canRun =
    keySaved &&
    (isPromptEval || hasSkillBody) &&
    scorerCount > 0 &&
    approvedCount > 0 &&
    !starting &&
    (!activeRun || TERMINAL_STATUSES.has(activeRun.status))

  const runWithConfig = useCallback(
    async (overrides?: { project?: string; experiment_name?: string; limit?: number; include_triggering?: boolean; agent_mode?: boolean; allow_bash?: boolean }) => {
      setStartError(null)
      setStarting(true)
      notePolarisActivity('started eval run')
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
          agent_mode: overrides?.agent_mode ?? agentMode,
          allow_bash: (overrides?.agent_mode ?? agentMode) ? (overrides?.allow_bash ?? allowBash) : false,
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
    [sessionId, project, experiment, limit, includeTriggering, judgeModel, refreshRuns, hasOpenRouterKey, agentMode, allowBash],
  )

  const handleRun = async () => {
    if (!canRun) return
    await runWithConfig()
  }

  // Polaris-triggered start: same handler the manual "Start Run" button
  // calls, with the panel's current config. If `canRun` is false (no key,
  // no scorers, etc.) we silently no-op — the user will already see the
  // setup gates in the UI.
  useEffect(() => {
    const handler = async () => {
      if (!canRun) return
      const run = await runWithConfig()
      if (run) setActiveRun(run)
    }
    window.addEventListener('polaris:start-eval', handler)
    return () => window.removeEventListener('polaris:start-eval', handler)
  }, [canRun, runWithConfig])

  // The remaining Polaris-triggered handlers (analyze / cancel / promote /
  // discard) need access to state + handlers that are defined further down
  // in this file. They're wired in a single useEffect at the bottom of the
  // hooks section — see "Polaris event listeners".

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

  // --- Polaris event listeners ---
  // Each Polaris-triggered nav target (analyze / cancel / promote / discard)
  // fires a window event after switching to the Evaluate tab. We refresh
  // refs to the latest handlers + state on every render so the listeners
  // capture current values without re-binding the event listener.
  const handleSuggestRef = useRef(handleSuggest)
  handleSuggestRef.current = handleSuggest
  const activeRunRef = useRef(activeRun)
  activeRunRef.current = activeRun
  const candidateVersionIdRef = useRef(candidateVersionId)
  candidateVersionIdRef.current = candidateVersionId
  useEffect(() => {
    const onAnalyze = (e: Event) => {
      const runId =
        (e as CustomEvent<{ run_id?: string }>).detail?.run_id ||
        activeRunRef.current?.run_id
      void handleSuggestRef.current(runId)
    }
    const onCancel = async (e: Event) => {
      const runId =
        (e as CustomEvent<{ run_id?: string }>).detail?.run_id ||
        activeRunRef.current?.run_id
      if (!runId) return
      try {
        const fresh = await cancelEvalRun(sessionId, runId)
        setActiveRun(fresh)
        await refreshRuns()
      } catch (err) {
        setStartError(err instanceof Error ? err.message : 'Failed to cancel')
      }
    }
    const onPromote = async (e: Event) => {
      const id =
        (e as CustomEvent<{ version_id?: string }>).detail?.version_id ||
        candidateVersionIdRef.current
      if (!id) return
      setCandidateActionError(null)
      setCandidateActionBusy(true)
      try {
        await promoteSkillVersion(sessionId, id)
        await refreshSkillVersions()
        await onCandidateChanged?.()
      } catch (err) {
        setCandidateActionError(err instanceof Error ? err.message : 'Failed to promote')
      } finally {
        setCandidateActionBusy(false)
      }
    }
    const onDiscard = async (e: Event) => {
      const id =
        (e as CustomEvent<{ version_id?: string }>).detail?.version_id ||
        candidateVersionIdRef.current
      if (!id) return
      setCandidateActionError(null)
      setCandidateActionBusy(true)
      try {
        await discardSkillVersion(sessionId, id)
        await refreshSkillVersions()
        await onCandidateChanged?.()
      } catch (err) {
        setCandidateActionError(err instanceof Error ? err.message : 'Failed to discard')
      } finally {
        setCandidateActionBusy(false)
      }
    }
    window.addEventListener('polaris:analyze-run', onAnalyze)
    window.addEventListener('polaris:cancel-run', onCancel)
    window.addEventListener('polaris:promote-skill-version', onPromote)
    window.addEventListener('polaris:discard-skill-version', onDiscard)
    return () => {
      window.removeEventListener('polaris:analyze-run', onAnalyze)
      window.removeEventListener('polaris:cancel-run', onCancel)
      window.removeEventListener('polaris:promote-skill-version', onPromote)
      window.removeEventListener('polaris:discard-skill-version', onDiscard)
    }
  }, [sessionId, refreshRuns, refreshSkillVersions, onCandidateChanged])

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
  const { body: finalBody } = useMemo(
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
      // Select the freshly-saved version so the version stack + run
      // history snap to it — the user can fire a new eval straight away
      // without first hunting for the new version (candidate or not).
      setSelectedSkillVersionId(newVersion.id)
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
  // The missing-key case is surfaced by the dedicated full-width banner below
  // (with an "Add in Settings" button), so it intentionally isn't repeated here.
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
  // pattern used by Goals/Users/Seed (sparkle header + refresh + body).
  // Visible whenever there's a completed run to analyze or any in-flight
  // suggestion state. The previous Improve content lived inline in the
  // main column; the new Figma design moves it to a persistent right
  // column so the user can iterate on the candidate without losing the
  // run results context.
  const doneRunForImprove = runs.find((r) => r.status === 'done' || r.status === 'failed')
  const newSkillVersionNumber = (skillVersions[0]?.version ?? 0) + 1
  const couldNotApplyCount = preview.filter((p) => p.mode === 'appended').length
  // Dismissed suggestions disappear from the list entirely; accepted ones
  // stay but render collapsed. Pending + accepted = visible.
  const visibleSuggestions = suggestions.filter((s) => !dismissed.has(s.id))
  const improveRight = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-fg-primary" />
          <span className="text-base font-semibold text-fg-contrast">Evaluation analysis</span>
        </div>
        {doneRunForImprove && (
          <button
            onClick={() => handleSuggest()}
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
          Run an evaluation — the analysis runs automatically once it
          finishes and proposes targeted SKILL.md edits from the failures.
        </p>
      )}

      {doneRunForImprove && !suggestions.length && !suggesting && !suggestError && !summary && (
        <p className="text-xs text-fg-dim">
          Analysis runs automatically when an evaluation finishes. Use the
          refresh button above to re-analyze the latest run.
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

      {visibleSuggestions.length > 0 && (
        <>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-dim">
            Proposed edits ({visibleSuggestions.length})
          </p>

          {(() => {
            // Group suggestions by their cluster target_label so the user
            // can scan "fixes for over_triggers_on_greeting" as a unit
            // instead of decoding rationale text line by line. When no
            // suggestion has a target_label (analysis ran without notes,
            // or the model couldn't pin any) the result collapses to a
            // single ungrouped section, which renders identically to the
            // pre-cluster behavior.
            const groups: { label: string | null; items: ImprovementSuggestion[] }[] = []
            const indexByLabel = new Map<string, number>()
            for (const s of visibleSuggestions) {
              const raw = (s.target_label ?? '').trim()
              const label = raw || null
              const key = label ?? ''
              const idx = indexByLabel.get(key)
              if (idx === undefined) {
                indexByLabel.set(key, groups.length)
                groups.push({ label, items: [s] })
              } else {
                groups[idx].items.push(s)
              }
            }
            // Pin the unlabeled group last so labeled fixes lead — they're
            // the ones the user already framed as a named bucket and is
            // most likely scanning for.
            groups.sort((a, b) => {
              if (a.label === null && b.label !== null) return 1
              if (a.label !== null && b.label === null) return -1
              return 0
            })
            const showHeaders = groups.some((g) => g.label !== null)

            const renderItem = (s: ImprovementSuggestion) => {
              const isAccepted = accepted.has(s.id)
              const { body: applied } = applySuggestion(skillBody, s)
              const matchKind = getMatchKind(skillBody, s)
              const willAppend = matchKind === 'appended' && !!s.find

              // Accepted → collapse to a one-line row. The user has already
              // decided, so the rationale, citations and diff just take up
              // space. Dismissed suggestions never reach here — they're
              // filtered out of visibleSuggestions and vanish from the list.
              if (isAccepted) {
                return (
                  <li
                    key={s.id}
                    className="px-3 py-2 text-sm flex items-center gap-2 bg-fill-primary/5 border border-fill-primary/40"
                  >
                    <Check className="w-3.5 h-3.5 text-fg-primary flex-shrink-0" />
                    <p
                      className="flex-1 text-sm text-fg-contrast leading-snug truncate"
                      title={s.summary}
                    >
                      {s.summary}
                    </p>
                    <button
                      onClick={() => toggleAccept(s.id)}
                      className="p-1 text-fg-dim hover:text-fg-contrast flex-shrink-0"
                      title="Undo — remove this edit"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  </li>
                )
              }

              return (
                <li key={s.id} className="p-3 text-sm space-y-2 bg-fill-neutral/40">
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
                    </div>
                  </div>

                  {willAppend && (
                    <p className="text-[10px] uppercase tracking-wide text-warning">
                      Will append (snippet drift)
                    </p>
                  )}

                  <p className="text-xs text-fg-dim leading-relaxed">{s.rationale}</p>

                  {/* Citation strip: tells the user which scorers and which
                      rows the LLM was looking at when it wrote this
                      suggestion. Source row ids match per_row[i].metadata.id,
                      so clicking one scrolls the per-row table to the
                      cited row and highlights it briefly. Without this
                      strip the user has to take the rationale's word for
                      what's failing — these chips let them verify. */}
                  {(s.source_scorer_names?.length || s.source_row_ids?.length) ? (
                    <div className="flex flex-col gap-1 text-[11px]">
                      {s.source_scorer_names && s.source_scorer_names.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-[10px] uppercase tracking-wide text-fg-dim">
                            Failing scorers
                          </span>
                          {s.source_scorer_names.map((name) => (
                            <span
                              key={name}
                              className="font-mono text-[10px] px-1.5 py-0.5 bg-warning/15 text-warning"
                            >
                              {name}
                            </span>
                          ))}
                        </div>
                      )}
                      {s.source_row_ids && s.source_row_ids.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-[10px] uppercase tracking-wide text-fg-dim">
                            From rows
                          </span>
                          {s.source_row_ids.map((rowId, idx) => (
                            <button
                              key={rowId}
                              type="button"
                              onClick={() => {
                                setPerRowOpen(true)
                                // Defer to next frame so the per-row list
                                // is mounted before we try to scroll into it.
                                requestAnimationFrame(() => {
                                  const el = document.querySelector(
                                    `[data-row-id="${CSS.escape(rowId)}"]`,
                                  )
                                  if (el && 'scrollIntoView' in el) {
                                    ;(el as HTMLElement).scrollIntoView({
                                      behavior: 'smooth',
                                      block: 'center',
                                    })
                                    el.classList.add('ring-2', 'ring-accent')
                                    window.setTimeout(() => {
                                      el.classList.remove('ring-2', 'ring-accent')
                                    }, 1600)
                                  }
                                })
                              }}
                              className="font-mono text-[10px] px-1.5 py-0.5 bg-fill-neutral/40 hover:bg-fill-neutral/70 text-foreground"
                              title={`Click to jump to row ${rowId}`}
                            >
                              row {idx + 1}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}

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
            }

            return (
              <div className="space-y-3">
                {groups.map((g, gi) => (
                  <div key={g.label ?? `__none_${gi}`} className="space-y-2">
                    {showHeaders && (
                      <p className="text-[10px] font-mono font-semibold uppercase tracking-wide text-muted-foreground">
                        {g.label ? (
                          <>
                            Fixes for <span className="text-foreground">{g.label}</span>
                            <span className="text-muted-foreground/70"> · {g.items.length}</span>
                          </>
                        ) : (
                          <>Other ({g.items.length})</>
                        )}
                      </p>
                    )}
                    <ul className="space-y-2">{g.items.map(renderItem)}</ul>
                  </div>
                ))}
              </div>
            )
          })()}
        </>
      )}
    </div>
  )

  // Sticky bottom of the sidebar — pinned below the scrollable analysis
  // list so the save action never scrolls out of reach. After a save it
  // flips to the "evaluate the candidate" card, so the user can re-run
  // straight away on the version they just created.
  const improveBottom = justSaved ? (
    <div className="p-4 space-y-2 bg-warning/5">
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
  ) : visibleSuggestions.length > 0 ? (
    <div className="p-4 space-y-2 bg-fill-primary/5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-fg-contrast">
          Save as new skill
        </p>
        <p className="text-xs text-fg-dim">
          {acceptedSuggestions.length > 0
            ? `${acceptedSuggestions.length} accepted`
            : 'No edits added yet'}
          {couldNotApplyCount > 0 && <> · {couldNotApplyCount} appended</>}
        </p>
      </div>
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
          disabled={acceptedSuggestions.length === 0}
          className="px-2.5 py-1 text-xs font-medium border border-border-hint text-fg-contrast hover:bg-fill-neutral/30 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Eye className="w-3.5 h-3.5 inline mr-1" />
          Preview
        </button>
        <button
          onClick={() => {
            void handleSaveVersion()
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
  ) : undefined

  return (
    <PanelLayout
      title="Evaluations"
      subtitle={
        isPromptEval
          ? "Replays the prompt under test against each sampled turn snapshot, scores with the project's scorers, streams results into Braintrust."
          : "Runs each approved dataset row through Claude with your SKILL.md as system prompt, scores with the project's scorers, streams results into Braintrust."
      }
      right={improveRight}
      rightBottom={improveBottom}
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
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-semibold text-fg-contrast">
              Run settings
            </h3>
            <button
              onClick={() => setShowAdvanced(true)}
              className="inline-flex items-center gap-1.5 text-xs text-fg-dim hover:text-fg-contrast"
            >
              <SettingsIcon className="w-3.5 h-3.5" />
              Advanced
            </button>
          </div>
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
                {/* Honest hint about what the picker actually drives. Only
                    judge scorers call the model; deterministic ones run as
                    pure Python alongside (see
                    backend/app/eval_runner.py::compile_scorers). Without
                    this hint the picker reads like "the LLM that scores
                    your eval", which over-states its role on hybrid
                    sessions. Hidden when we don't yet know the scorer
                    list (scorers prop undefined) — better silent than
                    showing a misleading "0/0" before the parent loads. */}
                {scorers !== undefined && scorerKinds.total > 0 && (
                  <p className="text-[10px] text-fg-dim leading-snug">
                    {scorerKinds.judge === 0 ? (
                      <>
                        No judge scorers — model unused. All{' '}
                        {scorerKinds.deterministic} scorer
                        {scorerKinds.deterministic === 1 ? '' : 's'} are
                        deterministic.
                      </>
                    ) : scorerKinds.deterministic === 0 ? (
                      <>
                        Grades all {scorerKinds.judge} scorer
                        {scorerKinds.judge === 1 ? '' : 's'}.
                      </>
                    ) : (
                      <>
                        Grades {scorerKinds.judge} judge scorer
                        {scorerKinds.judge === 1 ? '' : 's'} ·{' '}
                        {scorerKinds.deterministic} deterministic scorer
                        {scorerKinds.deterministic === 1 ? '' : 's'} run
                        without an LLM call
                      </>
                    )}
                  </p>
                )}
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

              {!isPromptEval && (
                <div className="flex flex-col gap-1.5" data-testid="agent-mode-toggle">
                  <label
                    className="text-[10px] font-semibold text-fg-dim uppercase tracking-wide"
                    title="Run the skill in a real tool-use loop with a sandboxed filesystem. Required to honestly evaluate skills that produce file artifacts (docx, pdf, xlsx, etc)."
                  >
                    Agent mode
                  </label>
                  <div className="inline-flex border border-border-hint p-0.5">
                    <button
                      type="button"
                      onClick={() => setAgentMode(false)}
                      className={`px-3 py-2 text-sm font-medium ${
                        !agentMode
                          ? 'bg-fill-neutral text-fg-contrast'
                          : 'text-fg-dim hover:text-fg-contrast'
                      }`}
                    >
                      Off
                    </button>
                    <button
                      type="button"
                      onClick={() => setAgentMode(true)}
                      className={`px-3 py-2 text-sm font-medium ${
                        agentMode
                          ? 'bg-fill-neutral text-fg-contrast'
                          : 'text-fg-dim hover:text-fg-contrast'
                      }`}
                    >
                      On
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

            {/* Judge routing hint — only surfaced when the user picked a non-Anthropic
                judge but hasn't added an OpenRouter key. Otherwise silent: a green-path
                hint added clutter without adding information. */}
            {(() => {
              const selectedOpt =
                JUDGE_MODEL_OPTIONS.find((o) => (o.value ?? '') === judgeModel) ||
                JUDGE_MODEL_OPTIONS[0]
              if (selectedOpt.provider === 'openrouter' && !hasOpenRouterKey) {
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
              return null
            })()}

            {/* Trust warnings + Allow-bash checkbox grouped together. The
                base note appears whenever the skill is going to run with
                file-write tools; the bash variant replaces it when bash is
                checked because run_bash side-steps the workspace path
                allowlist. The Allow-bash checkbox sits directly below the
                warning so the user reads the risk *before* deciding to opt
                in. Surfaced inline (not modal) so it stays visible while the
                user reads the rest of the run config. */}
            {!isPromptEval && agentMode && (
              <div className="flex flex-col gap-1.5">
                {!allowBash ? (
                  <div
                    className="flex items-start gap-2 text-[11px] text-warning border border-warning/30 bg-warning/5 px-2.5 py-2"
                    data-testid="agent-mode-warning"
                  >
                    <span aria-hidden>⚠</span>
                    <span>
                      <strong className="font-semibold">Agent mode is on.</strong>{' '}
                      Each row runs the skill with file tools in a per-row workspace
                      under <code className="font-mono">tmp/eval-runs/</code>. The
                      sandbox is best-effort (pure-Python path allowlist) — use only
                      with skills you've reviewed. For untrusted skills, run inside
                      a container or open an issue and we'll help isolate it.
                    </span>
                  </div>
                ) : (
                  <div
                    className="flex items-start gap-2 text-[11px] text-danger border border-danger/40 bg-danger/5 px-2.5 py-2"
                    data-testid="allow-bash-warning"
                  >
                    <span aria-hidden>⛔</span>
                    <span>
                      <strong className="font-semibold">Bash bypasses the sandbox.</strong>{' '}
                      The skill can run any command the eval process can. Secrets
                      are stripped and PATH is restricted to system binaries, but
                      the workspace boundary is not enforced — a skill could read
                      files outside it or reach the network. Enable only for skills
                      you wrote or fully audited.
                    </span>
                  </div>
                )}
                <label
                  className="flex items-center gap-1.5 text-[11px] text-fg-dim cursor-pointer select-none px-1"
                  title="Also expose a run_bash tool. Off by default — bash can side-step the sandbox."
                  data-testid="allow-bash-checkbox"
                >
                  <input
                    type="checkbox"
                    checked={allowBash}
                    onChange={(e) => setAllowBash(e.target.checked)}
                    className="cursor-pointer"
                  />
                  Allow bash
                </label>
              </div>
            )}

            {startError && <p className="text-xs text-danger">{startError}</p>}
          </section>

          {/* --- Active run status --- */}
          {activeRun && (
            <section className="border border-border p-4 bg-surface-raised">
              {/* Sticky run header — extends to the section edges (negative
                  margins cancel the section's p-4) so the row covers the full
                  width when stuck at the scroll viewport top. Bottom border
                  appears only when the user has scrolled past the section's
                  natural top, keeping the resting state visually identical. */}
              <div className="-mx-4 -mt-4 mb-3 px-4 pt-4 pb-3 sticky top-0 z-10 bg-surface-raised border-b border-border-hint flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
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
                  <p className="text-xs text-muted-foreground mt-1">
                    {activeRun.status === 'pending' && 'Queued...'}
                    {activeRun.status === 'running' && 'Running — this may take a few minutes.'}
                    {activeRun.status === 'done' &&
                      `Done. Evaluated ${activeRun.rows_evaluated}/${activeRun.rows_total} rows.`}
                    {activeRun.status === 'failed' && 'Failed — every row errored. See details below.'}
                    {activeRun.status === 'error' && 'Failed to start the run.'}
                    {activeRun.status === 'cancelled' && 'Cancelled.'}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
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
                  {(activeRun.status === 'done' || activeRun.status === 'failed') && (
                    <button
                      onClick={() => handleSuggest(activeRun.run_id)}
                      disabled={suggesting}
                      className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm font-semibold ${
                        suggesting
                          ? 'bg-fill-neutral text-fg-dim cursor-not-allowed'
                          : 'bg-fill-primary text-bg-default hover:opacity-90'
                      }`}
                      title="Analyze the failures from this run to get proposed SKILL.md edits."
                    >
                      {suggesting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Sparkles className="w-4 h-4" />
                      )}
                      Analyze this run
                    </button>
                  )}
                </div>
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
                    {activeRun.seed_snapshot && (
                      <button
                        onClick={() =>
                          setViewingSeed({
                            seed: activeRun.seed_snapshot as Seed,
                            title: `Seed used for this run`,
                            subtitle: `${activeRun.project}${activeRun.experiment_name ? ' · ' + activeRun.experiment_name : ''}${activeRun.skill_version_number != null ? ' · SKILL v' + activeRun.skill_version_number : ''}`,
                          })
                        }
                        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        View seed
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
                    let originalRun: EvalRunSummary | null = v1Runs[0] || fallbackOldest
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
                        {(() => {
                          // Per-label split: "good" rows are designed for
                          // success cases, "bad" rows are deliberate failure
                          // probes. Aggregating both into one mean hides
                          // whether the model is succeeding on its happy
                          // path while only stumbling on hard cases (or vice
                          // versa). We surface the split alongside the
                          // overall mean so neither dimension hides behind
                          // the other.
                          const buckets: Record<string, Record<string, number[]>> = {}
                          for (const r of activeRun.per_row) {
                            const label = (r.metadata as Record<string, unknown> | undefined)?.label
                            const lk = typeof label === 'string' && label ? label : 'unlabeled'
                            for (const [name, score] of Object.entries(r.scores || {})) {
                              if (typeof score !== 'number') continue
                              const slot = (buckets[name] ||= {})
                              ;(slot[lk] ||= []).push(score)
                            }
                          }
                          const labelAvg = (
                            scorer: string,
                            label: string,
                          ): number | null => {
                            const vals = buckets[scorer]?.[label]
                            if (!vals || vals.length === 0) return null
                            return vals.reduce((a, b) => a + b, 0) / vals.length
                          }
                          // Stash on a closure so the row renderer below
                          // doesn't need to re-derive — keeps the JSX tight.
                          ;(activeRun as unknown as { __labelAvg?: typeof labelAvg }).__labelAvg = labelAvg
                          return null
                        })()}
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
                            const labelAvg = (activeRun as unknown as {
                              __labelAvg?: (s: string, l: string) => number | null
                            }).__labelAvg
                            const goodAvg = labelAvg ? labelAvg(name, 'good') : null
                            const badAvg = labelAvg ? labelAvg(name, 'bad') : null
                            const isFiltered = scorerFilter === name
                            return (
                              <li key={name}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (isFiltered) {
                                      setScorerFilter(null)
                                    } else {
                                      setScorerFilter(name)
                                      setPerRowOpen(true)
                                    }
                                  }}
                                  className={`w-full flex items-center justify-between text-xs px-2 py-1 gap-3 text-left transition-colors ${
                                    isFiltered
                                      ? 'bg-accent/15 hover:bg-accent/25'
                                      : 'bg-muted/30 hover:bg-muted/60'
                                  }`}
                                  title={
                                    isFiltered
                                      ? `Click to clear filter`
                                      : `Click to filter per-row results to rows that aren't green for "${name}"`
                                  }
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
                                    {(goodAvg !== null || badAvg !== null) && (
                                      <span
                                        className="font-mono text-[10px] text-muted-foreground"
                                        title="Per-label split. 'good' rows test happy-path behavior; 'bad' rows probe deliberate failure modes — that's why bad-row scores often look low."
                                      >
                                        {goodAvg !== null && (
                                          <span>
                                            good {(goodAvg * 100).toFixed(0)}%
                                          </span>
                                        )}
                                        {goodAvg !== null && badAvg !== null && (
                                          <span className="text-muted-foreground/60"> · </span>
                                        )}
                                        {badAvg !== null && (
                                          <span>bad {(badAvg * 100).toFixed(0)}%</span>
                                        )}
                                      </span>
                                    )}
                                    <span className={`font-mono font-medium ${scoreColor(avg)}`}>
                                      {(avg * 100).toFixed(0)}%
                                    </span>
                                  </div>
                                </button>
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

                  {/* Analyze CTA moved into the sticky run header above —
                      same trigger, just always visible while reviewing the
                      run's results. */}

                  {/* Failure-mode clusters — populated by the analyze step
                      when the user has notes on rows. Each cluster is a
                      filter chip that narrows the per-row table to that
                      bucket. The stale pill below appears when notes
                      changed after the last analysis. */}
                  {activeRun.clusters && activeRun.clusters.length > 0 && (() => {
                    const stale =
                      !!activeRun.notes_updated_at &&
                      !!activeRun.clusters_generated_at &&
                      new Date(activeRun.notes_updated_at).getTime() >
                        new Date(activeRun.clusters_generated_at).getTime()
                    return (
                      <div className="mb-4 border border-border-hint p-3 bg-surface">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                            Failure-mode clusters
                          </p>
                          {stale && (
                            <button
                              type="button"
                              onClick={() => handleSuggest(activeRun.run_id)}
                              disabled={suggesting}
                              className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-warning hover:text-foreground disabled:opacity-50"
                              title="Notes have changed since these clusters were generated. Click to re-cluster + re-analyze."
                            >
                              <RotateCcw className="w-3 h-3" />
                              Notes changed — re-analyze
                            </button>
                          )}
                        </div>
                        <ul className="flex flex-wrap gap-1.5">
                          {activeRun.clusters.map((c) => {
                            const isActive = clusterFilter === c.label
                            return (
                              <li key={c.label}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (isActive) {
                                      setClusterFilter(null)
                                    } else {
                                      setClusterFilter(c.label)
                                      setScorerFilter(null)
                                      setPerRowOpen(true)
                                    }
                                  }}
                                  className={`text-xs font-mono px-2 py-1 transition-colors ${
                                    isActive
                                      ? 'bg-accent/20 text-accent ring-1 ring-accent'
                                      : 'bg-muted/40 text-foreground hover:bg-muted/60'
                                  }`}
                                  title={
                                    isActive
                                      ? `Click to clear filter`
                                      : `Click to filter per-row results to the ${c.count} row${c.count === 1 ? '' : 's'} in "${c.label}"`
                                  }
                                >
                                  {c.label} <span className="text-muted-foreground">· {c.count}</span>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )
                  })()}

                  {/* Unmapped-feature_area banner. Surfaces rows whose
                      `feature_area` isn't an entry in the seed's
                      alignment list — those rows score only on coverage +
                      safety, with every alignment scorer silently gating
                      out. Common cause: synthesis put a coverage criterion
                      name in the alignment slot. The post-synthesis snap
                      sets these to "(unmapped)" so they're easy to count
                      and grep for. */}
                  {activeRun.per_row.length > 0 && (() => {
                    const seedForRun =
                      (activeRun.seed_snapshot as Seed | null | undefined) ?? null
                    const validAreas = new Set(
                      (seedForRun?.alignment ?? []).map((a) => a.feature_area),
                    )
                    if (validAreas.size === 0) return null
                    const unmapped = activeRun.per_row.filter((r) => {
                      const fa = (r.metadata as Record<string, unknown>)?.feature_area
                      if (typeof fa !== 'string') return false
                      if (fa === '(off-target)') return false
                      return !validAreas.has(fa)
                    })
                    if (unmapped.length === 0) return null
                    const sample = Array.from(
                      new Set(
                        unmapped
                          .map(
                            (r) =>
                              (r.metadata as Record<string, unknown>)?.feature_area,
                          )
                          .filter((v): v is string => typeof v === 'string'),
                      ),
                    ).slice(0, 4)
                    return (
                      <div className="mb-3 px-3 py-2 bg-warning/10 border border-warning/30 text-xs text-foreground">
                        <p className="font-medium">
                          {unmapped.length} row{unmapped.length === 1 ? '' : 's'} won't get
                          alignment scores
                        </p>
                        <p className="text-muted-foreground mt-0.5">
                          Their <span className="font-mono">feature_area</span> isn't in this
                          run's seed alignment list — alignment scorers silently gate them
                          out, so they score only on coverage + safety. Unmapped values:{' '}
                          {sample.map((s, i) => (
                            <span key={s}>
                              <span className="font-mono">{s}</span>
                              {i < sample.length - 1 ? ', ' : null}
                            </span>
                          ))}
                          .
                        </p>
                        <div className="flex items-center gap-2 mt-2">
                          {onGoToUnmappedRows && (
                            <button
                              type="button"
                              onClick={onGoToUnmappedRows}
                              className="px-2 py-1 text-[11px] font-medium border border-warning/40 bg-warning/10 hover:bg-warning/20 text-foreground"
                              title="Open the Dataset tab pre-filtered to these rows so you can re-tag them"
                            >
                              Fix in Dataset
                            </button>
                          )}
                          {onGoToSeed && (
                            <button
                              type="button"
                              onClick={onGoToSeed}
                              className="px-2 py-1 text-[11px] font-medium border border-border-hint bg-surface hover:bg-fill-neutral/30 text-foreground"
                              title="Open the Seed so you can add these as alignment dimensions"
                            >
                              Edit seed
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })()}

                  {activeRun.per_row.length > 0 && (() => {
                    // Run-wide visibility hint: when the run has rows scored
                    // but NO scorer_metadata captured anywhere (legacy run
                    // from before the trace-capture change), tell the user
                    // why score chips aren't clickable instead of leaving
                    // them to discover via tooltip.
                    const hasAnyScores = activeRun.per_row.some(
                      (r) => Object.keys(r.scores || {}).length > 0,
                    )
                    const hasAnyTraces = activeRun.per_row.some(
                      (r) => r.scorer_metadata && Object.keys(r.scorer_metadata).length > 0,
                    )
                    const showLegacyHint = hasAnyScores && !hasAnyTraces
                    const clusterRowIds: Set<string> | null = clusterFilter
                      ? new Set(
                          (activeRun.clusters || [])
                            .find((c) => c.label === clusterFilter)
                            ?.row_ids ?? [],
                        )
                      : null
                    const filteredRows = scorerFilter
                      ? activeRun.per_row.filter((r) => {
                          const s = r.scores[scorerFilter]
                          return typeof s === 'number' && s < 0.8
                        })
                      : clusterRowIds
                        ? activeRun.per_row.filter((r) => {
                            const meta = (r.metadata || {}) as Record<string, unknown>
                            const id = typeof meta.id === 'string' ? meta.id : null
                            return id ? clusterRowIds.has(id) : false
                          })
                        : activeRun.per_row
                    return (
                      <div className="mt-2">
                        <div className="flex items-center justify-between mb-2 gap-3">
                          <button
                            type="button"
                            onClick={() => setPerRowOpen((v) => !v)}
                            className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground"
                            aria-expanded={perRowOpen}
                          >
                            {perRowOpen ? (
                              <ChevronUp className="w-3 h-3" />
                            ) : (
                              <ChevronDown className="w-3 h-3" />
                            )}
                            Per-row results (
                            {scorerFilter || clusterFilter
                              ? `${filteredRows.length} of ${activeRun.per_row.length}`
                              : activeRun.per_row.length}
                            )
                          </button>
                          {(scorerFilter || clusterFilter) && (
                            <button
                              type="button"
                              onClick={() => {
                                setScorerFilter(null)
                                setClusterFilter(null)
                              }}
                              className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-accent hover:text-foreground"
                              title={`Stop filtering by "${scorerFilter || clusterFilter}"`}
                            >
                              <X className="w-3 h-3" />
                              Reset filter
                            </button>
                          )}
                        </div>
                        {perRowOpen && showLegacyHint && (
                          <p className="text-[11px] text-muted-foreground italic mb-2">
                            This run was completed before per-scorer judge reasoning was
                            captured. Run a fresh eval to make score chips clickable —
                            they'll then expand to show the judge's reasoning.
                          </p>
                        )}
                        {perRowOpen && (
                          <ul className="space-y-3 mt-2">
                            {filteredRows.length === 0 ? (
                              <li className="text-xs text-muted-foreground italic px-2 py-3">
                                No rows match the current filter.
                              </li>
                            ) : (
                              filteredRows.map((row, i) => {
                                const metadata = (row.metadata || {}) as Record<string, unknown>
                                const inputStr =
                                  typeof row.input === 'object' && row.input !== null
                                    ? ((row.input as Record<string, unknown>).input as string) || JSON.stringify(row.input)
                                    : String(row.input ?? '')
                                const outputStr = typeof row.output === 'string' ? row.output : JSON.stringify(row.output, null, 2)
                                const expectedStr = typeof row.expected === 'string' ? row.expected : JSON.stringify(row.expected, null, 2)
                                const exampleId =
                                  typeof metadata.id === 'string' ? metadata.id : null
                                // Note: textarea is always rendered. When the
                                // user has typed something different from the
                                // persisted note, the draft entry exists and
                                // Save/Cancel buttons appear.
                                const persistedNote = row.note ?? ''
                                const noteDraft =
                                  exampleId && exampleId in noteDrafts
                                    ? noteDrafts[exampleId]
                                    : undefined
                                const noteValue = noteDraft ?? persistedNote
                                const isDirty =
                                  noteDraft !== undefined && noteDraft !== persistedNote
                                const isSaving = exampleId ? !!noteSaving[exampleId] : false
                                const errMsg = exampleId ? noteError[exampleId] : undefined
                                // Row label — synthesized examples carry "good"
                                // (happy-path target) or "bad" (deliberate
                                // failure probe). Surface it as a chip alongside
                                // the score chips so the user can read each
                                // row's context without scrolling to inspect
                                // the dataset.
                                const rawLabel = metadata.label
                                const rowLabel =
                                  typeof rawLabel === 'string' && rawLabel ? rawLabel : null
                                const labelStyles =
                                  rowLabel === 'good'
                                    ? 'bg-success/15 text-success'
                                    : rowLabel === 'bad'
                                      ? 'bg-danger/15 text-danger'
                                      : 'bg-muted/40 text-muted-foreground'
                                const expandKeyPrefix = exampleId ?? `idx-${i}`
                                return (
                                  <li
                                    key={i}
                                    data-row-id={exampleId ?? undefined}
                                    className="border border-border p-3 bg-muted/10 text-xs space-y-2 transition-shadow"
                                  >
                                    <div className="flex flex-wrap gap-1 items-center">
                                      {rowLabel && (
                                        <span
                                          className={`font-mono text-[10px] uppercase px-1.5 py-0.5 ${labelStyles}`}
                                          title={
                                            rowLabel === 'good'
                                              ? 'Happy-path row — expected output is the good case'
                                              : rowLabel === 'bad'
                                                ? 'Failure-probe row — expected output is the bad case'
                                                : 'Row label'
                                          }
                                        >
                                          {rowLabel}
                                        </span>
                                      )}
                                      {Object.entries(row.scores).map(([name, score]) => {
                                        const trace = row.scorer_metadata?.[name]
                                        const expandKey = `${expandKeyPrefix}:${name}`
                                        const isExpanded = expandedScorers.has(expandKey)
                                        const hasDetail = !!(trace?.judge_response || trace?.error || trace?.parse_warning)
                                        return (
                                          <button
                                            type="button"
                                            key={name}
                                            onClick={() => {
                                              if (!hasDetail) return
                                              setExpandedScorers((prev) => {
                                                const next = new Set(prev)
                                                if (next.has(expandKey)) next.delete(expandKey)
                                                else next.add(expandKey)
                                                return next
                                              })
                                            }}
                                            className={`font-mono px-1.5 py-0.5 bg-background ${scoreColor(score)} ${
                                              scorerFilter === name ? 'ring-1 ring-accent' : ''
                                            } ${
                                              hasDetail
                                                ? isExpanded
                                                  ? 'ring-1 ring-foreground/30 cursor-pointer'
                                                  : 'cursor-pointer hover:opacity-80'
                                                : 'cursor-default opacity-80'
                                            }`}
                                            title={
                                              hasDetail
                                                ? isExpanded
                                                  ? 'Click to collapse judge reasoning'
                                                  : 'Click to see judge reasoning'
                                                : 'No judge reasoning captured for this scorer'
                                            }
                                            disabled={!hasDetail}
                                          >
                                            {name}: {(score * 100).toFixed(0)}%
                                          </button>
                                        )
                                      })}
                                    </div>
                                    {row.scorer_metadata && (() => {
                                      const expanded = Object.entries(row.scorer_metadata).filter(
                                        ([n]) => expandedScorers.has(`${expandKeyPrefix}:${n}`),
                                      )
                                      if (expanded.length === 0) return null
                                      return (
                                        <ul className="space-y-1.5 pt-1">
                                          {expanded.map(([n, trace]) => (
                                            <li
                                              key={n}
                                              className="border-l-2 border-border-hint pl-2 py-1 bg-background/50 text-[11px]"
                                            >
                                              <div className="font-mono text-muted-foreground">
                                                {n}
                                                {typeof trace.score === 'number' && (
                                                  <span className={`ml-2 ${scoreColor(trace.score)}`}>
                                                    {(trace.score * 100).toFixed(0)}%
                                                  </span>
                                                )}
                                              </div>
                                              {trace.error && (
                                                <div className="text-danger mt-0.5">
                                                  Scorer error: {trace.error}
                                                </div>
                                              )}
                                              {trace.parse_warning && (
                                                <div className="text-warning mt-0.5">
                                                  {trace.parse_warning}
                                                </div>
                                              )}
                                              {trace.judge_response && (
                                                <pre className="whitespace-pre-wrap break-words text-foreground mt-0.5 font-sans">
                                                  {trace.judge_response}
                                                </pre>
                                              )}
                                            </li>
                                          ))}
                                        </ul>
                                      )
                                    })()}
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
                                    {(() => {
                                      // Agent-mode trace: tool calls + materialized
                                      // artifacts. Only present when the run was
                                      // started with agent_mode=true.
                                      const agent = metadata.agent as
                                        | {
                                            tool_calls?: Array<{ name: string; input: Record<string, unknown>; result: string; is_error: boolean; duration_ms: number }>
                                            artifacts?: Array<{ path: string; size: number; sha256: string; preview: string | null; binary: boolean }>
                                            iterations?: number
                                            stop_reason?: string | null
                                            halted?: string | null
                                            workspace?: string | null
                                          }
                                        | undefined
                                      if (!agent || (!agent.tool_calls?.length && !agent.artifacts?.length && agent.iterations == null)) {
                                        return null
                                      }
                                      const calls = agent.tool_calls || []
                                      const artifacts = agent.artifacts || []
                                      const errored = calls.filter((c) => c.is_error).length
                                      return (
                                        <details className="border border-border-hint p-2 bg-background">
                                          <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                                            Agent trace · {calls.length} tool call{calls.length === 1 ? '' : 's'}
                                            {errored > 0 && <span className="text-danger"> · {errored} errored</span>}
                                            {artifacts.length > 0 && <span> · {artifacts.length} artifact{artifacts.length === 1 ? '' : 's'}</span>}
                                            {agent.halted && <span className="text-warning"> · {agent.halted}</span>}
                                          </summary>
                                          <div className="mt-2 space-y-2">
                                            {calls.length > 0 && (
                                              <ol className="space-y-1.5">
                                                {calls.map((c, ci) => (
                                                  <li key={ci} className="border-l-2 pl-2 border-border-hint">
                                                    <div className="flex items-center gap-2 text-[10px]">
                                                      <span className={`font-mono font-semibold ${c.is_error ? 'text-danger' : 'text-foreground'}`}>{c.name}</span>
                                                      <span className="text-muted-foreground">{c.duration_ms}ms</span>
                                                    </div>
                                                    <pre className="whitespace-pre-wrap break-words text-[10px] text-muted-foreground mt-0.5">{JSON.stringify(c.input, null, 2)}</pre>
                                                    <pre className={`whitespace-pre-wrap break-words text-[10px] mt-0.5 ${c.is_error ? 'text-danger' : 'text-foreground'}`}>{c.result}</pre>
                                                  </li>
                                                ))}
                                              </ol>
                                            )}
                                            {artifacts.length > 0 && (
                                              <div>
                                                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Artifacts</div>
                                                <ul className="mt-1 space-y-1">
                                                  {artifacts.map((a) => (
                                                    <li key={a.sha256 + a.path} className="text-[10px]">
                                                      <div className="flex gap-2 items-center">
                                                        <span className="font-mono text-foreground">{a.path}</span>
                                                        <span className="text-muted-foreground">{a.size}B</span>
                                                        {a.binary && <span className="text-muted-foreground">(binary)</span>}
                                                      </div>
                                                      {a.preview && (
                                                        <pre className="whitespace-pre-wrap break-words text-muted-foreground mt-0.5 max-h-32 overflow-auto">{a.preview}</pre>
                                                      )}
                                                    </li>
                                                  ))}
                                                </ul>
                                              </div>
                                            )}
                                          </div>
                                        </details>
                                      )
                                    })()}
                                    {exampleId ? (
                                      <div>
                                        <div className="flex items-center justify-between mb-0.5">
                                          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                                            Note
                                          </span>
                                          <span className="text-[10px] italic">
                                            {errMsg ? (
                                              <span className="text-danger not-italic">
                                                {errMsg}
                                              </span>
                                            ) : isSaving ? (
                                              <span className="text-muted-foreground">Saving…</span>
                                            ) : isDirty ? (
                                              <span className="text-muted-foreground">
                                                Unsaved changes
                                              </span>
                                            ) : persistedNote ? (
                                              <span className="text-muted-foreground">Saved</span>
                                            ) : null}
                                          </span>
                                        </div>
                                        <div className="space-y-1.5">
                                          <textarea
                                            value={noteValue}
                                            onChange={(e) =>
                                              updateNoteDraft(exampleId, e.target.value)
                                            }
                                            placeholder="What went wrong? (e.g. over-triggers on greeting)"
                                            rows={2}
                                            className="w-full bg-background border border-border px-2 py-1 text-xs font-sans text-foreground focus:outline-none focus:border-accent resize-y"
                                          />
                                          {/* Buttons only appear when there
                                              are unsaved changes — keeps the
                                              row visually quiet at rest while
                                              still letting the user commit
                                              the edit when they're ready. */}
                                          {isDirty && (
                                            <div className="flex items-center justify-end gap-1.5">
                                              <button
                                                type="button"
                                                onClick={() => cancelNoteEdit(exampleId)}
                                                disabled={isSaving}
                                                className="px-2 py-0.5 text-[11px] font-medium border border-border-hint bg-surface hover:bg-fill-neutral/30 text-foreground disabled:opacity-50"
                                              >
                                                Cancel
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => saveNote(exampleId)}
                                                disabled={isSaving}
                                                className="px-2 py-0.5 text-[11px] font-medium bg-fill-primary text-bg-default hover:opacity-90 disabled:bg-fill-neutral disabled:text-fg-dim disabled:cursor-not-allowed"
                                              >
                                                Save
                                              </button>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    ) : null}
                                  </li>
                                )
                              })
                            )}
                          </ul>
                        )}
                      </div>
                    )
                  })()}
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
              const selectedVer = selectedSkillVersionId
                ? skillVersions.find((v) => v.id === selectedSkillVersionId)
                : undefined
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
                      {selectedSkillVersionId && runs.length > 0 && (
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
                        className="p-1.5 text-fg-dim hover:text-fg-contrast"
                        title="Refresh history from the server"
                      >
                        <RotateCcw className="w-4 h-4" />
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
                        {r.seed_snapshot && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setViewingSeed({
                                seed: r.seed_snapshot as Seed,
                                title: `Seed used for this run`,
                                subtitle: `${r.project}${r.experiment_name ? ' · ' + r.experiment_name : ''}${r.skill_version_number != null ? ' · SKILL v' + r.skill_version_number : ''}`,
                              })
                            }}
                            className="inline-flex items-center gap-1 font-mono text-fg-dim hover:text-fg-contrast"
                            title="View the seed this run evaluated"
                          >
                            <FileText className="w-3.5 h-3.5" />
                            View seed
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

          {viewingSeed && (
            <SeedDocument
              seed={viewingSeed.seed}
              title={viewingSeed.title}
              subtitle={viewingSeed.subtitle}
              onClose={() => setViewingSeed(null)}
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

          {showAdvanced && (
            <div
              className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
              onClick={() => setShowAdvanced(false)}
            >
              <div
                className="bg-surface-raised border border-border p-6 max-w-lg w-full mx-4 shadow-lg"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-foreground">Advanced</h3>
                  <button
                    onClick={() => setShowAdvanced(false)}
                    className="text-fg-dim hover:text-fg-contrast"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mb-5">
                  Override the Braintrust project and experiment name. Defaults are usually fine.
                </p>
                <div className="space-y-4">
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
                <div className="flex justify-end mt-6">
                  <button
                    onClick={() => setShowAdvanced(false)}
                    className="inline-flex items-center px-4 py-2 text-sm font-medium bg-fill-primary text-bg-default hover:opacity-90"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
    </PanelLayout>
  )
}
