import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Play, Square, CheckCircle2, XCircle, AlertTriangle, ChevronRight } from 'lucide-react'
import { API_BASE, getApiKey } from '../api'
import type { LoopConfig, LoopRoundEvent } from '../types'

/**
 * ImproveLoopPanel — UI for Track 3's bounded self-improvement loop.
 *
 * Streams round events from `POST /api/improve-loop` (SSE over a fetch
 * ReadableStream so we can send the JSON body — EventSource is GET-only).
 * Renders each round as a card with what changed, why, per-scorer scores, and
 * a pass-rate delta vs the previous round. The final card surfaces the
 * terminal pass/fail state from the `done` event.
 *
 * Cross-cutting principle: "always show what's happening". No opaque spinner;
 * every long step emits a visible round event the user can read while it runs.
 */

interface Props {
  sessionId: string
  /** Optional overrides; sensible defaults match LoopConfig() backend-side. */
  defaultConfig?: Partial<LoopConfig>
  /** Mount slot — render inline (default) or as a self-contained card. */
  variant?: 'card' | 'inline'
}

interface DoneEvent {
  passed: boolean
  rounds: number
  reason: string
  pass_threshold?: number
}

type StreamEvent =
  | { type: 'hello'; data: unknown }
  | { type: 'round'; data: LoopRoundEvent }
  | { type: 'done'; data: DoneEvent }

const DEFAULT_CONFIG: LoopConfig = {
  pass_threshold: 0.75,
  max_rounds: 5,
  target_policy: 'feature_only',
}

export default function ImproveLoopPanel({ sessionId, defaultConfig, variant = 'card' }: Props) {
  const [config, setConfig] = useState<LoopConfig>({ ...DEFAULT_CONFIG, ...defaultConfig })
  const [rounds, setRounds] = useState<LoopRoundEvent[]>([])
  const [done, setDone] = useState<DoneEvent | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Auto-scroll the round list as new events stream in.
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [rounds.length, done])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
  }, [])

  useEffect(() => () => stop(), [stop])

  const start = useCallback(async () => {
    if (running) return
    setRounds([])
    setDone(null)
    setError(null)
    setRunning(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const apiKey = getApiKey()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers['X-Anthropic-Key'] = apiKey
      const resp = await fetch(`${API_BASE}/improve-loop`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId, config }),
        signal: ctrl.signal,
      })
      if (!resp.ok || !resp.body) {
        throw new Error(`HTTP ${resp.status}`)
      }
      // SSE parser over the fetch stream. We accumulate bytes, split on the
      // double-newline message boundary, then parse `event:` / `data:` lines.
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done: streamDone } = await reader.read()
        if (streamDone) break
        buf += decoder.decode(value, { stream: true })
        // Drain complete SSE messages from the buffer.
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const parsed = parseSseMessage(raw)
          if (!parsed) continue
          dispatch(parsed)
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // User stopped — not an error to surface.
      } else {
        setError(`${(err as Error).message}`)
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }

    function dispatch(ev: StreamEvent) {
      if (ev.type === 'round') {
        setRounds((prev) => [...prev, ev.data])
      } else if (ev.type === 'done') {
        setDone(ev.data)
      }
      // 'hello' is informational; ignore.
    }
  }, [running, sessionId, config])

  const wrapperCls =
    variant === 'card'
      ? 'rounded-lg border border-border bg-surface-raised p-4'
      : ''

  return (
    <div className={wrapperCls}>
      <header className="flex items-center justify-between mb-3 gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Self-improvement loop</h3>
          <p className="text-xs text-muted-foreground">
            Bounded analyze → improve → rerun until every scorer ≥{' '}
            {Math.round(config.pass_threshold * 100)}% or {config.max_rounds} rounds.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!running ? (
            <button
              type="button"
              onClick={start}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
            >
              <Play size={14} /> Start loop
            </button>
          ) : (
            <button
              type="button"
              onClick={stop}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-raised"
            >
              <Square size={14} /> Stop
            </button>
          )}
        </div>
      </header>

      <ConfigRow config={config} onChange={setConfig} disabled={running} />

      {error ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-background p-2 text-xs text-foreground">
          <AlertTriangle size={14} className="text-muted-foreground" />
          <span>Loop failed: {error}</span>
        </div>
      ) : null}

      <div ref={listRef} className="mt-3 space-y-2 max-h-[420px] overflow-y-auto">
        {rounds.length === 0 && !running ? (
          <p className="text-xs text-muted-foreground italic">
            No rounds yet. Press “Start loop” to watch the agent improve the skill.
          </p>
        ) : null}
        {rounds.map((r) => (
          <RoundCard key={r.round} round={r} threshold={config.pass_threshold} />
        ))}
        {running ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            <span>Working on next round…</span>
          </div>
        ) : null}
        {done ? <DoneCard done={done} /> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConfigRow({
  config,
  onChange,
  disabled,
}: {
  config: LoopConfig
  onChange: (next: LoopConfig) => void
  disabled: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <label className="flex items-center gap-1.5">
        <span>Pass threshold</span>
        <input
          type="number"
          step="0.05"
          min={0}
          max={1}
          value={config.pass_threshold}
          disabled={disabled}
          onChange={(e) =>
            onChange({ ...config, pass_threshold: Number(e.target.value) || 0 })
          }
          className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-foreground disabled:opacity-50"
        />
      </label>
      <label className="flex items-center gap-1.5">
        <span>Max rounds</span>
        <input
          type="number"
          min={1}
          max={20}
          value={config.max_rounds}
          disabled={disabled}
          onChange={(e) =>
            onChange({ ...config, max_rounds: Math.max(1, Number(e.target.value) || 1) })
          }
          className="w-14 rounded border border-border bg-background px-1.5 py-0.5 text-foreground disabled:opacity-50"
        />
      </label>
      <span className="text-muted-foreground">
        Policy: <span className="font-mono">{config.target_policy}</span>
      </span>
    </div>
  )
}

function RoundCard({ round, threshold }: { round: LoopRoundEvent; threshold: number }) {
  const isBaseline = round.round === 0
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ChevronRight size={14} className="text-muted-foreground shrink-0" />
          <span className="text-xs font-semibold text-foreground">
            {isBaseline ? 'Baseline' : `Round ${round.round}`}
          </span>
          <span className="truncate text-xs text-foreground">{round.changed}</span>
        </div>
        <PassPill passed={round.passed} passRate={round.pass_rate} delta={round.delta} />
      </div>
      {!isBaseline ? (
        <p className="mt-1 text-xs text-muted-foreground">{round.rationale}</p>
      ) : null}
      <ScorerGrid scores={round.scorer_scores} threshold={threshold} />
    </div>
  )
}

function PassPill({
  passed,
  passRate,
  delta,
}: {
  passed: boolean
  passRate: number
  delta: number | null | undefined
}) {
  const pct = Math.round(passRate * 100)
  const deltaStr =
    delta == null
      ? null
      : delta === 0
        ? '±0'
        : delta > 0
          ? `+${Math.round(delta * 100)}pp`
          : `${Math.round(delta * 100)}pp`
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
          passed
            ? 'bg-accent text-accent-foreground'
            : 'bg-surface-raised text-foreground border border-border'
        }`}
      >
        {passed ? <CheckCircle2 size={11} /> : null}
        {pct}% pass
      </span>
      {deltaStr ? (
        <span
          className={`text-[10px] font-mono ${
            delta && delta > 0
              ? 'text-foreground'
              : delta && delta < 0
                ? 'text-muted-foreground'
                : 'text-muted-foreground'
          }`}
        >
          {deltaStr}
        </span>
      ) : null}
    </div>
  )
}

function ScorerGrid({
  scores,
  threshold,
}: {
  scores: Record<string, number>
  threshold: number
}) {
  const entries = Object.entries(scores)
  if (entries.length === 0) {
    return (
      <p className="mt-2 text-xs italic text-muted-foreground">
        No scorer results yet for this round.
      </p>
    )
  }
  return (
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      {entries.map(([name, score]) => {
        const pct = Math.round(score * 100)
        const passing = score >= threshold
        return (
          <div
            key={name}
            className="flex items-center gap-2 rounded border border-border bg-surface-raised px-2 py-1"
          >
            <span className="text-xs truncate flex-1 text-foreground">{name}</span>
            <span
              className={`text-xs font-mono ${
                passing ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              {pct}%
            </span>
            <span
              aria-hidden
              className={`inline-block h-2 w-2 rounded-full ${
                passing ? 'bg-accent' : 'bg-border'
              }`}
            />
          </div>
        )
      })}
    </div>
  )
}

function DoneCard({ done }: { done: DoneEvent }) {
  return (
    <div
      className={`rounded-md border p-3 ${
        done.passed
          ? 'border-border bg-surface-raised'
          : 'border-border bg-background'
      }`}
    >
      <div className="flex items-center gap-2">
        {done.passed ? (
          <CheckCircle2 size={16} className="text-foreground" />
        ) : (
          <XCircle size={16} className="text-muted-foreground" />
        )}
        <span className="text-sm font-semibold text-foreground">
          {done.passed ? 'Loop converged' : 'Loop ended without passing'}
        </span>
        <span className="text-xs text-muted-foreground">
          ({done.rounds} round{done.rounds === 1 ? '' : 's'})
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{done.reason}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SSE message parsing — minimal subset covering `event:` + `data:` lines.
// ---------------------------------------------------------------------------

function parseSseMessage(raw: string): StreamEvent | null {
  // A single SSE message is a block of lines. Lines starting with `:` are
  // comments (e.g. our `: ping` heartbeats) and are dropped.
  let eventType = 'message'
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }
  if (dataLines.length === 0) return null
  const dataStr = dataLines.join('\n')
  try {
    const data = JSON.parse(dataStr)
    return { type: eventType, data } as StreamEvent
  } catch {
    return null
  }
}
