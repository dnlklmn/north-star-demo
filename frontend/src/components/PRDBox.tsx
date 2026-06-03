import { useCallback, useRef, useState } from 'react'
import { API_BASE, getApiKey } from '../api'

/**
 * PRDBox — the "one textbox + Build feature" entry point.
 *
 * Posts a PRD blob to `/orchestrate-build`, which streams Server-Sent Events
 * for each stage of the build (skill -> seed -> dataset -> scorers -> evaluate
 * -> done). Each event flips that stage's row from "pending" -> "running" ->
 * "ok" / "error" so the user sees what's happening end-to-end, not an opaque
 * spinner.
 *
 * SSE notes: EventSource only supports GET, so we drive the stream by hand
 * with fetch + ReadableStream parsing. Simpler than wiring a WebSocket and
 * matches what the backend emits (`data: {...}\n\n`).
 */

type StageStatus = 'pending' | 'running' | 'ok' | 'error'

interface StageRow {
  key: string
  label: string
  status: StageStatus
  detail: string
  payload?: Record<string, unknown>
}

interface OrchestratorEvent {
  stage: string
  status: 'start' | 'progress' | 'ok' | 'error'
  detail: string
  payload?: Record<string, unknown>
}

const INITIAL_STAGES: StageRow[] = [
  { key: 'init', label: 'Create session', status: 'pending', detail: '' },
  { key: 'skill', label: 'Generate SKILL.md', status: 'pending', detail: '' },
  { key: 'seed', label: 'Build seed dimensions', status: 'pending', detail: '' },
  { key: 'dataset', label: 'Synthesize dataset', status: 'pending', detail: '' },
  { key: 'scorers', label: 'Generate scorers', status: 'pending', detail: '' },
  { key: 'evaluate', label: 'Run eval', status: 'pending', detail: '' },
]

const EXAMPLES: { title: string; body: string }[] = [
  {
    title: 'Meeting-note summarizer',
    body:
      'We want an AI feature that summarizes meeting transcripts into action items.\n\n' +
      'As a project manager I want to paste a transcript and get a list of decisions, owners, and due dates so I can drop them into Jira.',
  },
  {
    title: 'Support-ticket triage',
    body:
      'Triage incoming customer support tickets by urgency and route to the correct team.\n\n' +
      'As a support lead I want urgent billing issues to skip the L1 queue.',
  },
  {
    title: 'PR description writer',
    body:
      'Generate good PR descriptions from a git diff plus the linked issue.\n\n' +
      'As a senior engineer I want the description to call out behavior changes and risk.',
  },
]

function StageIcon({ status }: { status: StageStatus }) {
  if (status === 'running') {
    return (
      <span
        aria-label="running"
        className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent"
      />
    )
  }
  if (status === 'ok') {
    return (
      <span aria-label="ok" className="text-accent">
        {'✓'}
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span aria-label="error" className="text-red-500">
        {'✕'}
      </span>
    )
  }
  return (
    <span aria-label="pending" className="text-muted-foreground">
      {'·'}
    </span>
  )
}

function PassRateBar({ rates }: { rates: Record<string, number> }) {
  const entries = Object.entries(rates)
  if (entries.length === 0) return null
  return (
    <div className="mt-2 space-y-1">
      {entries.map(([name, rate]) => {
        const pct = Math.round(rate * 100)
        const tone =
          rate >= 0.75 ? 'bg-accent' : rate >= 0.5 ? 'bg-yellow-500' : 'bg-red-500'
        return (
          <div key={name} className="flex items-center gap-2 text-xs">
            <span className="w-40 truncate text-muted-foreground">{name}</span>
            <div className="h-2 flex-1 overflow-hidden rounded bg-surface-raised">
              <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="w-10 text-right tabular-nums">{pct}%</span>
          </div>
        )
      })}
    </div>
  )
}

export interface PRDBoxProps {
  /** Optional callback fired when the build finishes with the final
   *  payload (session_id, dataset_id, overall_pass_rate). Lets the parent
   *  route the user into the regular project workspace. */
  onComplete?: (payload: { session_id: string; dataset_id: string; overall_pass_rate: number }) => void
}

export default function PRDBox({ onComplete }: PRDBoxProps) {
  const [prd, setPrd] = useState('')
  const [stages, setStages] = useState<StageRow[]>(INITIAL_STAGES)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const reset = useCallback(() => {
    setStages(INITIAL_STAGES.map((s) => ({ ...s })))
    setError(null)
    setSessionId(null)
  }, [])

  const applyEvent = useCallback((evt: OrchestratorEvent) => {
    if (evt.stage === 'error') {
      setError(evt.detail || 'Build failed')
      setStages((prev) =>
        prev.map((s) => (s.status === 'running' ? { ...s, status: 'error', detail: evt.detail } : s)),
      )
      return
    }
    if (evt.stage === 'done') {
      if (evt.payload && typeof evt.payload.session_id === 'string') {
        setSessionId(evt.payload.session_id)
      }
      if (
        onComplete &&
        evt.payload &&
        typeof evt.payload.session_id === 'string' &&
        typeof evt.payload.dataset_id === 'string' &&
        typeof evt.payload.overall_pass_rate === 'number'
      ) {
        onComplete({
          session_id: evt.payload.session_id,
          dataset_id: evt.payload.dataset_id,
          overall_pass_rate: evt.payload.overall_pass_rate,
        })
      }
      return
    }
    if (evt.stage === 'init' && evt.status === 'ok' && evt.payload?.session_id) {
      setSessionId(String(evt.payload.session_id))
    }
    setStages((prev) =>
      prev.map((s) => {
        if (s.key !== evt.stage) return s
        const nextStatus: StageStatus =
          evt.status === 'start' ? 'running' : evt.status === 'ok' ? 'ok' : evt.status === 'error' ? 'error' : 'running'
        return { ...s, status: nextStatus, detail: evt.detail, payload: evt.payload }
      }),
    )
  }, [onComplete])

  const startBuild = useCallback(async () => {
    if (!prd.trim() || running) return
    reset()
    setRunning(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const apiKey = getApiKey()
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (apiKey) headers['X-Anthropic-Key'] = apiKey
      const res = await fetch(`${API_BASE}/orchestrate-build`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prd }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `Request failed (${res.status})`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // SSE frame parsing: events separated by a blank line. We accumulate
      // bytes into `buffer`, split on `\n\n`, and parse each frame's `data:` lines.
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sepIdx = buffer.indexOf('\n\n')
        while (sepIdx !== -1) {
          const frame = buffer.slice(0, sepIdx)
          buffer = buffer.slice(sepIdx + 2)
          const dataLines = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
          if (dataLines.length > 0) {
            try {
              const parsed = JSON.parse(dataLines.join('\n')) as OrchestratorEvent
              applyEvent(parsed)
            } catch {
              // ignore malformed frame; keep streaming
            }
          }
          sepIdx = buffer.indexOf('\n\n')
        }
      }
    } catch (e: unknown) {
      if ((e as { name?: string })?.name === 'AbortError') return
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }, [prd, running, reset, applyEvent])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    setRunning(false)
  }, [])

  const evaluateStage = stages.find((s) => s.key === 'evaluate')
  const rates = (evaluateStage?.payload?.scorer_pass_rates ?? null) as
    | Record<string, number>
    | null

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Build a feature from a PRD</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste a short product description. We&apos;ll generate the SKILL, seed,
          dataset, scorers, and a first eval automatically.
        </p>
      </div>

      <textarea
        className="w-full min-h-[160px] rounded border border-border bg-surface-raised p-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent"
        placeholder="Describe the AI feature you want to build..."
        value={prd}
        onChange={(e) => setPrd(e.target.value)}
        disabled={running}
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={startBuild}
          disabled={!prd.trim() || running}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {running ? 'Building...' : 'Build feature'}
        </button>
        {running && (
          <button
            type="button"
            onClick={cancel}
            className="rounded border border-border px-3 py-2 text-sm text-foreground"
          >
            Cancel
          </button>
        )}
        {sessionId && !running && (
          <a
            href={`/project/${sessionId}`}
            className="text-sm text-accent underline-offset-2 hover:underline"
          >
            Open project
          </a>
        )}
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Examples</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.title}
              type="button"
              onClick={() => setPrd(ex.body)}
              disabled={running}
              className="rounded border border-border bg-surface-raised px-3 py-1 text-xs text-foreground hover:bg-background disabled:opacity-50"
            >
              {ex.title}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded border border-border bg-surface-raised">
        <div className="border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Progress
        </div>
        <ul className="divide-y divide-border">
          {stages.map((s) => (
            <li key={s.key} className="flex items-start gap-3 px-4 py-2 text-sm">
              <span className="mt-0.5 flex h-4 w-4 items-center justify-center">
                <StageIcon status={s.status} />
              </span>
              <div className="flex-1">
                <div className="text-foreground">{s.label}</div>
                {s.detail && (
                  <div className="text-xs text-muted-foreground">{s.detail}</div>
                )}
                {s.key === 'evaluate' && rates && <PassRateBar rates={rates} />}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {error && (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-500">
          {error}
        </div>
      )}
    </div>
  )
}
