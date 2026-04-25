import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, ExternalLink, FileText, KeyRound, Loader2, PlayCircle, Settings as SettingsIcon, Sparkles } from 'lucide-react'
import type { Charter, Dataset, EvalRunSummary } from '../types'
import CharterDocument from './CharterDocument'
import {
  getApiKey,
  getEvalRun,
  hasBraintrustApiKey,
  listEvalRuns,
  runEval,
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
  onExport: () => void
  /** Navigate to Improve tab — shown as a CTA below the latest completed run. */
  onRequestImprove?: () => void
  /** When set to true, the panel kicks off a run on mount using the most-recent
   *  run's config (project + flags). Parent should reset this prop after. */
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
}

const POLL_INTERVAL_MS = 2000
const TERMINAL_STATUSES = new Set<EvalRunSummary['status']>(['done', 'error'])


function scoreColor(score: number): string {
  if (score >= 0.8) return 'text-success'
  if (score >= 0.5) return 'text-warning'
  return 'text-danger'
}

function formatWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString()
}

export default function EvaluatePanel({
  sessionId,
  dataset,
  scorerCount,
  hasSkillBody,
  onExport,
  onRequestImprove,
  autoRun,
  onAutoRunConsumed,
  onGoToSkill,
  onGoToDataset,
  onGoToScorers,
  onGenerateScorersInline,
  onOpenSettings,
}: Props) {
  const [inlineGenScorers, setInlineGenScorers] = useState(false)
  const exampleCount = dataset?.examples?.length || 0
  const approvedCount = (dataset?.examples || []).filter(
    (e) => e.review_status === 'approved',
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
  const [startError, setStartError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const pollTimerRef = useRef<number | null>(null)

  const [runsError, setRunsError] = useState<string | null>(null)
  // When set, opens the CharterDocument modal showing exactly what the
  // user clicked "View charter" for — either a run's snapshot or the live one.
  const [viewingCharter, setViewingCharter] = useState<{
    charter: Charter
    title: string
    subtitle?: string
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
    hasSkillBody &&
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
          // Only forward a judge_model override when OpenRouter is actually
          // configured — a stale localStorage value from before the key was
          // removed would otherwise error out on the backend.
          judge_model: hasOpenRouterKey && judgeModel ? judgeModel : undefined,
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
  if (!hasSkillBody) {
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

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 h-12 border-b border-border bg-surface-raised flex items-center justify-between flex-shrink-0">
        <h2 className="text-sm font-semibold text-foreground">Evaluate</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl space-y-8">
          {/* --- Braintrust run section --- */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 bg-accent/10 flex items-center justify-center">
                <PlayCircle className="w-4 h-4 text-accent" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Run with Braintrust</h3>
                <p className="text-xs text-muted-foreground">
                  Runs each approved dataset row through Claude with your SKILL.md as system prompt,
                  scores with the charter's scorers, streams results into Braintrust.
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
              <div className="col-span-2">
                <label
                  className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1"
                  title="Model used to grade scorer outputs. Non-Claude judges route via OpenRouter — configure an sk-or-... key in Settings to enable. The skill under test always runs on Claude."
                >
                  Judge model
                </label>
                {hasOpenRouterKey ? (
                  <select
                    value={judgeModel}
                    onChange={(e) => updateJudgeModel(e.target.value)}
                    className="w-full text-xs bg-background border border-border px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    {JUDGE_MODEL_OPTIONS.map((opt) => (
                      <option key={opt.label} value={opt.value ?? ''}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  // Non-Claude judges require an OpenRouter key. Rather than
                  // silently failing on run, we disable the picker and route
                  // the user to Settings to add one.
                  <div className="flex items-center justify-between gap-3 px-3 py-2 bg-muted/30 border border-border text-xs">
                    <span className="text-muted-foreground truncate">
                      Claude Sonnet (default). Add an OpenRouter key to pick a non-Claude judge.
                    </span>
                    {onOpenSettings && (
                      <button
                        onClick={onOpenSettings}
                        className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-foreground hover:bg-muted"
                      >
                        <SettingsIcon className="w-3 h-3" />
                        Settings
                      </button>
                    )}
                  </div>
                )}
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
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {activeRun.status === 'pending' && 'Queued...'}
                    {activeRun.status === 'running' && 'Running — this may take a few minutes.'}
                    {activeRun.status === 'done' &&
                      `Done. Evaluated ${activeRun.rows_evaluated}/${activeRun.rows_total} rows.`}
                    {activeRun.status === 'error' && 'Failed.'}
                  </p>
                </div>
                <span
                  className={`text-xs font-mono uppercase px-2 py-0.5 ${
                    activeRun.status === 'done'
                      ? 'bg-success/15 text-success'
                      : activeRun.status === 'error'
                        ? 'bg-danger/15 text-danger'
                        : 'bg-accent/15 text-accent'
                  }`}
                >
                  {activeRun.status}
                </span>
              </div>

              {activeRun.status === 'error' && activeRun.error && (
                <pre className="text-xs text-danger whitespace-pre-wrap bg-danger/5 p-2 border border-danger/20">
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

                  {Object.keys(activeRun.scorer_averages).length > 0 && (() => {
                    // Find the previous completed run (most recent one older
                    // than this run) to compute per-scorer deltas. Preferring
                    // same-project so the scorer set matches. `runs` comes
                    // back sorted newest-first from the backend.
                    const activeStart = activeRun.started_at || activeRun.finished_at
                    const candidates = runs.filter(
                      (r) =>
                        r.run_id !== activeRun.run_id &&
                        r.status === 'done' &&
                        (!activeStart ||
                          !r.started_at ||
                          new Date(r.started_at).getTime() < new Date(activeStart).getTime()),
                    )
                    const previousRun =
                      candidates.find((r) => r.project === activeRun.project) || candidates[0] || null
                    return (
                      <div className="mb-4">
                        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-2">
                          <span>Per-scorer averages</span>
                          {previousRun && (
                            <span className="font-mono normal-case text-muted-foreground/70">
                              vs{' '}
                              {previousRun.skill_version_number != null
                                ? `SKILL v${previousRun.skill_version_number}`
                                : previousRun.experiment_name || 'previous run'}
                            </span>
                          )}
                        </p>
                        <ul className="space-y-1">
                          {Object.entries(activeRun.scorer_averages).map(([name, avg]) => {
                            const prev = previousRun?.scorer_averages?.[name]
                            const delta = prev !== undefined ? avg - prev : null
                            return (
                              <li
                                key={name}
                                className="flex items-center justify-between text-xs bg-muted/30 px-2 py-1 gap-3"
                              >
                                <span className="font-mono text-foreground truncate flex-1">{name}</span>
                                <div className="flex items-center gap-2 flex-shrink-0">
                                  {delta !== null && (
                                    <span
                                      className={`font-mono ${
                                        Math.abs(delta) < 0.01
                                          ? 'text-muted-foreground'
                                          : delta > 0
                                            ? 'text-success'
                                            : 'text-danger'
                                      }`}
                                      title={`Previous: ${(prev! * 100).toFixed(0)}%`}
                                    >
                                      {delta > 0 ? '+' : ''}
                                      {(delta * 100).toFixed(0)}pp
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

                  {onRequestImprove && (
                    <div className="mb-4 flex items-center justify-between gap-3 border border-accent/40 bg-accent/5 px-3 py-2">
                      <p className="text-xs text-foreground">
                        Results look off? Analyze failures and get proposed SKILL.md edits.
                      </p>
                      <button
                        onClick={onRequestImprove}
                        className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-accent-foreground hover:opacity-90"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        Improve skill
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
        </div>
      </div>

      {viewingCharter && (
        <CharterDocument
          charter={viewingCharter.charter}
          title={viewingCharter.title}
          subtitle={viewingCharter.subtitle}
          onClose={() => setViewingCharter(null)}
        />
      )}
    </div>
  )
}
