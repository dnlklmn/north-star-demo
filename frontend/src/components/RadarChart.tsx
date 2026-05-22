import { useMemo, useId } from 'react'

interface Props {
  dimensions: Array<{
    label: string
    value: number // 0-1 normalized
    status: 'pending' | 'weak' | 'good' | 'pass' | 'fail' | 'untested'
  }>
  size?: number // default 200
  /** Override font size for the axis labels. Defaults to 14. */
  labelFontSize?: number
  /** Soft cap on characters per line — longer labels wrap onto further
   *  lines (split on whitespace). Defaults to 24. */
  labelMaxChars?: number
}

function wrapLabel(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    if (!current) {
      current = w
    } else if (current.length + 1 + w.length <= maxChars) {
      current += ' ' + w
    } else {
      lines.push(current)
      current = w
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : [text]
}

function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleRad: number
): { x: number; y: number } {
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad),
  }
}

function getPolygonPoints(
  cx: number,
  cy: number,
  radius: number,
  count: number
): Array<{ x: number; y: number }> {
  const angleStep = (2 * Math.PI) / count
  const startAngle = -Math.PI / 2
  return Array.from({ length: count }, (_, i) =>
    polarToCartesian(cx, cy, radius, startAngle + i * angleStep)
  )
}

function pointsToString(points: Array<{ x: number; y: number }>): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ')
}

export default function RadarChart({
  dimensions,
  size = 200,
  labelFontSize = 14,
  labelMaxChars = 24,
}: Props) {
  const filterId = useId()
  const count = dimensions?.length ?? 0
  const labelMargin = 48
  const cx = size / 2
  const cy = size / 2
  const radius = size / 2 - labelMargin

  const outerPoints = useMemo(() => getPolygonPoints(cx, cy, radius, count), [cx, cy, radius, count])

  const dataPoints = useMemo(() => {
    if (!dimensions || count < 1) return []
    const angleStep = (2 * Math.PI) / count
    const startAngle = -Math.PI / 2
    return dimensions.map((d, i) => {
      const r = Math.max(0.08, Math.min(1, d.value)) * radius
      return polarToCartesian(cx, cy, r, startAngle + i * angleStep)
    })
  }, [dimensions, cx, cy, radius, count])

  const labelPositions = useMemo(() => {
    if (!dimensions || count < 1) return []
    const labelRadius = radius + 20
    const angleStep = (2 * Math.PI) / count
    const startAngle = -Math.PI / 2
    return dimensions.map((_, i) => {
      const angle = startAngle + i * angleStep
      const pos = polarToCartesian(cx, cy, labelRadius, angle)
      let anchor: 'start' | 'middle' | 'end' = 'middle'
      if (pos.x < cx - 2) anchor = 'end'
      else if (pos.x > cx + 2) anchor = 'start'
      let dy = '0.35em'
      if (pos.y < cy - radius * 0.5) dy = '0.8em'
      else if (pos.y > cy + radius * 0.5) dy = '-0.2em'
      return { ...pos, anchor, dy }
    })
  }, [dimensions, cx, cy, radius, count])

  if (!dimensions || dimensions.length < 3) return null

  return (
    <div className="flex justify-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="overflow-visible"
      >
        <defs>
          {/* Noise texture filter matching Figma design */}
          <filter id={filterId} x="0" y="0" width="100%" height="100%" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            <feFlood floodOpacity="0" result="BackgroundImageFix" />
            <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
            <feTurbulence type="fractalNoise" baseFrequency="5" stitchTiles="stitch" numOctaves="3" result="noise" seed="8513" />
            <feColorMatrix in="noise" type="luminanceToAlpha" result="alphaNoise" />
            <feComponentTransfer in="alphaNoise" result="coloredNoise1">
              <feFuncA type="discrete" tableValues="1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 " />
            </feComponentTransfer>
            <feComposite operator="in" in2="shape" in="coloredNoise1" result="noise1Clipped" />
            <feFlood floodColor="rgba(47, 0, 144, 0.36)" result="color1Flood" />
            <feComposite operator="in" in2="noise1Clipped" in="color1Flood" result="color1" />
            <feMerge>
              <feMergeNode in="shape" />
              <feMergeNode in="color1" />
            </feMerge>
          </filter>
        </defs>

        {/* Outer boundary polygon — subtle border */}
        <polygon
          points={pointsToString(outerPoints)}
          fill="none"
          stroke="var(--color-border-hint, rgba(36, 36, 36, 1))"
          strokeWidth={1}
        />

        {/* Data polygon — purple fill with noise texture */}
        <polygon
          points={pointsToString(dataPoints)}
          fill="#9982DF"
          filter={`url(#${filterId})`}
          strokeWidth={0}
        />

        {/* Labels — wrap long strings onto multiple tspans so they fit
            without overflowing the chart's allotted margin. */}
        {labelPositions.map((pos, i) => {
          const dim = dimensions[i]
          const isActive = dim.value > 0.15 && dim.status !== 'pending' && dim.status !== 'untested'
          const lines = wrapLabel(dim.label, labelMaxChars)
          // Vertically center the multi-line block around pos.y by shifting
          // the first line up by (n-1)/2 line heights. For single-line
          // labels this collapses to the original pos.dy.
          const lineHeightEm = 1.15
          const firstLineDy =
            lines.length === 1
              ? pos.dy
              : `${-((lines.length - 1) * lineHeightEm) / 2 + 0.35}em`
          return (
            <text
              key={i}
              x={pos.x}
              y={pos.y}
              textAnchor={pos.anchor}
              fill={isActive ? 'rgba(224, 224, 224, 1)' : 'rgba(142, 142, 142, 1)'}
              style={{ fontSize: labelFontSize, fontFamily: 'Geist, sans-serif' }}
            >
              {lines.map((line, li) => (
                <tspan key={li} x={pos.x} dy={li === 0 ? firstLineDy : `${lineHeightEm}em`}>
                  {line}
                </tspan>
              ))}
            </text>
          )
        })}
      </svg>
    </div>
  )
}
