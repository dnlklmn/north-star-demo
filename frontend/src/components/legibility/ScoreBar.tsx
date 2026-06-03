/**
 * Tiny horizontal bar for a single scorer's pass-rate, with an optional
 * threshold marker (default 0.75 — the loop's success line).
 *
 * Visual contract:
 * - Track: `bg-surface-raised` rounded rectangle, ~6px tall.
 * - Fill: `bg-accent` when score ≥ threshold, dimmer when below.
 * - Threshold tick: 1px vertical line on the track.
 *
 * `score` is a fraction in [0, 1]. Out-of-range values are clamped so
 * callers can pass raw numbers without sanitizing.
 */
import { useMemo } from 'react'

export interface ScoreBarProps {
  /** Fraction in [0, 1]. */
  score: number
  /** Pass line, default 0.75. */
  threshold?: number
  /** Optional label shown above the bar. */
  label?: string
  /** Optional value text shown to the right of the bar. Defaults to `Math.round(score * 100)%`. */
  valueText?: string
  /** Height of the bar in pixels. Default 6. */
  heightPx?: number
  /** Extra classes for the wrapper. */
  className?: string
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

export function ScoreBar({
  score,
  threshold = 0.75,
  label,
  valueText,
  heightPx = 6,
  className,
}: ScoreBarProps) {
  const pct = clamp01(score)
  const thr = clamp01(threshold)
  const passes = pct >= thr
  const displayed = valueText ?? `${Math.round(pct * 100)}%`

  const fillStyle = useMemo<React.CSSProperties>(
    () => ({ width: `${pct * 100}%` }),
    [pct],
  )
  const thresholdStyle = useMemo<React.CSSProperties>(
    () => ({ left: `${thr * 100}%` }),
    [thr],
  )
  const trackStyle = useMemo<React.CSSProperties>(
    () => ({ height: `${heightPx}px` }),
    [heightPx],
  )

  return (
    <div className={`flex flex-col gap-1 ${className ?? ''}`}>
      {(label || displayed) && (
        <div className="flex items-baseline justify-between gap-2 text-xs">
          {label ? (
            <span className="text-muted-foreground truncate">{label}</span>
          ) : (
            <span />
          )}
          <span
            className={passes ? 'text-foreground font-medium' : 'text-muted-foreground'}
          >
            {displayed}
          </span>
        </div>
      )}
      <div
        className="relative w-full overflow-hidden rounded bg-surface-raised"
        style={trackStyle}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct * 100)}
        aria-label={label ?? 'score'}
      >
        <div
          className={`h-full transition-[width] duration-300 ${passes ? 'bg-accent' : 'bg-accent/40'}`}
          style={fillStyle}
        />
        <div
          className="absolute top-0 bottom-0 w-px bg-border"
          style={thresholdStyle}
          aria-hidden
        />
      </div>
    </div>
  )
}

export default ScoreBar
