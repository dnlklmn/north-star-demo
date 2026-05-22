import { useEffect, useRef, useState } from 'react'
import RadarChart from './RadarChart'

/**
 * RadarChart wrapper that sizes itself to its container's width via
 * ResizeObserver. As the right-rail sidebar is dragged, the radar
 * grows / shrinks alongside.
 *
 * Clamped to 140-240px:
 * - below 140 the labels squish into the chart
 * - above 240 the chart dominates the rail without adding signal
 *   (data is already legible at 240)
 *
 * Label font size stays fixed at RadarChart's default; only the
 * wrap-threshold scales so labels wrap tighter on narrow sidebars and
 * looser on wider ones.
 *
 * When `onClick` is supplied, the wrapper is a button (used by the
 * Dataset sidebar to open the full matrix modal); otherwise it's a
 * plain div.
 */
export default function ResponsiveRadar({
  dimensions,
  onClick,
  ariaLabel,
  title,
}: {
  dimensions: React.ComponentProps<typeof RadarChart>['dimensions']
  onClick?: () => void
  ariaLabel?: string
  title?: string
}) {
  const wrapperRef = useRef<HTMLElement>(null)
  const [size, setSize] = useState(160)

  useEffect(() => {
    const el = wrapperRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      const w = Math.floor(entry.contentRect.width)
      if (w > 0) setSize(Math.max(140, Math.min(240, w)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const labelMaxChars = Math.max(14, Math.min(24, Math.round(size / 12)))

  const sharedClass =
    'flex justify-center w-full' +
    (onClick
      ? ' cursor-pointer hover:opacity-90 transition-opacity disabled:cursor-default'
      : '')

  if (onClick) {
    return (
      <button
        type="button"
        ref={wrapperRef as React.RefObject<HTMLButtonElement>}
        onClick={onClick}
        aria-label={ariaLabel}
        title={title}
        className={sharedClass}
      >
        <RadarChart
          dimensions={dimensions}
          size={size}
          labelMaxChars={labelMaxChars}
        />
      </button>
    )
  }
  return (
    <div
      ref={wrapperRef as React.RefObject<HTMLDivElement>}
      title={title}
      className={sharedClass}
    >
      <RadarChart
        dimensions={dimensions}
        size={size}
        labelMaxChars={labelMaxChars}
      />
    </div>
  )
}
