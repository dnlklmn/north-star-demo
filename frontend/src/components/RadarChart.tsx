import { useMemo, useId } from 'react'

interface Props {
  dimensions: Array<{
    label: string
    value: number // 0-1 normalized
    status: 'pending' | 'weak' | 'good' | 'pass' | 'fail' | 'untested'
  }>
  size?: number // default 200
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

export default function RadarChart({ dimensions, size = 200 }: Props) {
  if (!dimensions || dimensions.length < 3) return null

  const filterId = useId()
  const count = dimensions.length
  const labelMargin = 48
  const cx = size / 2
  const cy = size / 2
  const radius = size / 2 - labelMargin

  const outerPoints = useMemo(() => getPolygonPoints(cx, cy, radius, count), [cx, cy, radius, count])

  const dataPoints = useMemo(() => {
    const angleStep = (2 * Math.PI) / count
    const startAngle = -Math.PI / 2
    return dimensions.map((d, i) => {
      const r = Math.max(0.08, Math.min(1, d.value)) * radius
      return polarToCartesian(cx, cy, r, startAngle + i * angleStep)
    })
  }, [dimensions, cx, cy, radius, count])

  const labelPositions = useMemo(() => {
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

        {/* Labels */}
        {labelPositions.map((pos, i) => {
          const dim = dimensions[i]
          // Bright label for dimensions with data, dim for pending/empty
          const isActive = dim.value > 0.15 && dim.status !== 'pending' && dim.status !== 'untested'
          return (
            <text
              key={i}
              x={pos.x}
              y={pos.y}
              textAnchor={pos.anchor}
              dy={pos.dy}
              fill={isActive ? 'rgba(224, 224, 224, 1)' : 'rgba(142, 142, 142, 1)'}
              style={{ fontSize: 14, fontFamily: 'Geist, sans-serif' }}
            >
              {dim.label}
            </text>
          )
        })}
      </svg>
    </div>
  )
}
