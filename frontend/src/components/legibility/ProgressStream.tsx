/**
 * Generic vertical stage list with status icons. Drives the "what is
 * the system doing right now" UI across tracks (build orchestration,
 * loop runner, prod stream startup).
 *
 * The component is intentionally dumb — callers compute current stage
 * and per-stage status and pass them in. That keeps the visual layer
 * decoupled from track-specific event shapes.
 *
 * Stages render as a vertical column; the active stage shows a soft
 * pulse and the latest detail line. Transitions to 'done' animate a
 * tick swap-in.
 */
import { useEffect, useState } from 'react'
import { Check, Loader2, AlertTriangle, Circle } from 'lucide-react'

export type StageStatus = 'pending' | 'active' | 'done' | 'failed'

export interface Stage {
  id: string
  label: string
  /** Optional short description rendered under the label. */
  description?: string
}

export interface ProgressStreamProps {
  stages: Stage[]
  /** Stage id that is currently active. May not appear in `stages` if
   *  the backend reports a stage outside the canonical list — in that
   *  case the detail line still renders but no node highlights. */
  current: string | null
  /** Per-stage status. Stages missing from this map default to 'pending'. */
  status: Map<string, StageStatus>
  /** Short human-readable line describing what the active stage is
   *  doing right now (e.g. "Calling messages.create() — 4.2s"). */
  detail?: string | null
  /** Extra classes for the wrapper. */
  className?: string
}

function statusOf(
  stageId: string,
  status: Map<string, StageStatus>,
): StageStatus {
  return status.get(stageId) ?? 'pending'
}

function StageIcon({ status }: { status: StageStatus }) {
  if (status === 'done') {
    return <Check className="w-3.5 h-3.5 text-accent" aria-label="done" />
  }
  if (status === 'active') {
    return (
      <Loader2
        className="w-3.5 h-3.5 text-accent animate-spin"
        aria-label="active"
      />
    )
  }
  if (status === 'failed') {
    return (
      <AlertTriangle
        className="w-3.5 h-3.5 text-foreground"
        aria-label="failed"
      />
    )
  }
  return (
    <Circle
      className="w-3.5 h-3.5 text-muted-foreground"
      aria-label="pending"
    />
  )
}

export function ProgressStream({
  stages,
  current,
  status,
  detail,
  className,
}: ProgressStreamProps) {
  // Track which stages just transitioned to 'done' so we can pulse the
  // tick. Compared against the previous render's status map.
  const [justDone, setJustDone] = useState<Set<string>>(new Set())

  useEffect(() => {
    const newlyDone = new Set<string>()
    for (const s of stages) {
      if (status.get(s.id) === 'done') newlyDone.add(s.id)
    }
    if (newlyDone.size === 0) return
    setJustDone(newlyDone)
    const t = window.setTimeout(() => setJustDone(new Set()), 600)
    return () => window.clearTimeout(t)
    // We intentionally re-run whenever the status map identity changes;
    // callers should pass a fresh Map on each tick (cheap, since stage
    // counts are small).
  }, [status, stages])

  return (
    <ol
      className={`flex flex-col gap-3 ${className ?? ''}`}
      aria-label="Progress"
    >
      {stages.map((stage, i) => {
        const s = statusOf(stage.id, status)
        const isCurrent = current === stage.id
        const flash = justDone.has(stage.id)
        return (
          <li key={stage.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div
                className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                  s === 'done'
                    ? 'border-accent bg-accent/10'
                    : s === 'active'
                      ? 'border-accent bg-background'
                      : s === 'failed'
                        ? 'border-border bg-surface-raised'
                        : 'border-border bg-background'
                } ${flash ? 'ring-2 ring-accent/40 transition' : ''}`}
              >
                <StageIcon status={s} />
              </div>
              {i < stages.length - 1 && (
                <div
                  className={`mt-1 w-px flex-1 min-h-[1rem] ${
                    s === 'done' ? 'bg-accent/40' : 'bg-border'
                  }`}
                />
              )}
            </div>
            <div className="flex flex-col pb-1">
              <span
                className={`text-sm ${
                  isCurrent
                    ? 'text-foreground font-medium'
                    : s === 'done'
                      ? 'text-foreground'
                      : 'text-muted-foreground'
                }`}
              >
                {stage.label}
              </span>
              {stage.description && (
                <span className="text-xs text-muted-foreground">
                  {stage.description}
                </span>
              )}
              {isCurrent && detail && (
                <span className="mt-0.5 text-xs text-muted-foreground italic">
                  {detail}
                </span>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export default ProgressStream
