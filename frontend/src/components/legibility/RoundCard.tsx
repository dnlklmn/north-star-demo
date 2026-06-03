/**
 * Renders a single self-improvement round.
 *
 * Track 3 emits `LoopRoundEvent`s as the feature is repeatedly run,
 * scored, critiqued, and rewritten. This card surfaces:
 *  - Round number + headline pass rate (with delta vs prior round)
 *  - Per-scorer pass rates as `ScoreBar`s
 *  - The model's rationale for the change it just made
 *  - A short list of changed scorer names so the user sees what moved
 *
 * The type is defined locally to keep this primitive usable before
 * `LoopRoundEvent` lands in `types.ts`. Callers can pass any object
 * that satisfies `RoundCardData` — the contract type from Stage A is a
 * superset of this shape.
 */
import { useMemo } from 'react'
import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { ScoreBar } from './ScoreBar'

export interface RoundCardScorer {
  /** Scorer display name (e.g. "claim_grounding"). */
  name: string
  /** Pass rate in [0, 1]. */
  score: number
  /** Optional threshold; defaults to RoundCard's `threshold`. */
  threshold?: number
}

export interface RoundCardData {
  round_index: number
  /** Headline overall pass rate in [0, 1], usually mean of per-scorer scores. */
  pass_rate: number
  /** Per-scorer scores for this round. */
  scorers: RoundCardScorer[]
  /** Free-text rationale for the change applied this round. */
  rationale?: string | null
  /** Scorer names whose scores moved meaningfully vs prior round. */
  changed?: string[]
  /** ISO timestamp the round was recorded. Optional. */
  timestamp?: string | null
}

export interface RoundCardProps {
  round: RoundCardData
  /** Prior round, used to compute deltas. Pass null for the first round. */
  previous?: RoundCardData | null
  /** Pass threshold for both the headline bar and per-scorer bars. */
  threshold?: number
  /** Extra classes for the wrapper. */
  className?: string
}

function deltaText(curr: number, prev: number | null | undefined): {
  text: string
  direction: 'up' | 'down' | 'flat'
} {
  if (prev == null) return { text: '—', direction: 'flat' }
  const d = curr - prev
  if (Math.abs(d) < 0.005) return { text: '±0%', direction: 'flat' }
  const sign = d > 0 ? '+' : '−'
  return {
    text: `${sign}${Math.round(Math.abs(d) * 100)}%`,
    direction: d > 0 ? 'up' : 'down',
  }
}

export function RoundCard({
  round,
  previous,
  threshold = 0.75,
  className,
}: RoundCardProps) {
  const delta = useMemo(
    () => deltaText(round.pass_rate, previous?.pass_rate ?? null),
    [round.pass_rate, previous?.pass_rate],
  )

  const prevByScorer = useMemo(() => {
    const map = new Map<string, number>()
    if (previous) {
      for (const s of previous.scorers) map.set(s.name, s.score)
    }
    return map
  }, [previous])

  const changedSet = useMemo(
    () => new Set(round.changed ?? []),
    [round.changed],
  )

  const Icon =
    delta.direction === 'up' ? ArrowUp : delta.direction === 'down' ? ArrowDown : Minus
  const deltaClass =
    delta.direction === 'up'
      ? 'text-accent'
      : delta.direction === 'down'
        ? 'text-foreground'
        : 'text-muted-foreground'

  return (
    <div
      className={`rounded-md border border-border bg-background p-4 flex flex-col gap-3 ${className ?? ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Round
          </span>
          <span className="text-sm font-semibold text-foreground">
            {round.round_index}
          </span>
        </div>
        <div className="flex items-center gap-1 text-xs">
          <span className={`inline-flex items-center gap-0.5 ${deltaClass}`}>
            <Icon className="w-3 h-3" />
            {delta.text}
          </span>
          <span className="text-muted-foreground">
            vs prior
          </span>
        </div>
      </div>

      <ScoreBar
        score={round.pass_rate}
        threshold={threshold}
        label="Overall pass rate"
      />

      {round.scorers.length > 0 && (
        <div className="flex flex-col gap-2">
          {round.scorers.map(s => {
            const prev = prevByScorer.get(s.name)
            const d = deltaText(s.score, prev)
            const changed = changedSet.has(s.name)
            return (
              <div key={s.name} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span
                    className={`truncate ${changed ? 'text-foreground font-medium' : 'text-muted-foreground'}`}
                  >
                    {s.name}
                    {changed && (
                      <span className="ml-1 text-[10px] uppercase tracking-wide text-accent">
                        changed
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <span>{Math.round(s.score * 100)}%</span>
                    {prev != null && (
                      <span
                        className={
                          d.direction === 'up'
                            ? 'text-accent'
                            : d.direction === 'down'
                              ? 'text-foreground'
                              : 'text-muted-foreground'
                        }
                      >
                        ({d.text})
                      </span>
                    )}
                  </span>
                </div>
                <ScoreBar
                  score={s.score}
                  threshold={s.threshold ?? threshold}
                />
              </div>
            )
          })}
        </div>
      )}

      {round.rationale && (
        <div className="rounded bg-surface-raised p-2 text-xs text-foreground">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Rationale
          </div>
          {round.rationale}
        </div>
      )}
    </div>
  )
}

export default RoundCard
