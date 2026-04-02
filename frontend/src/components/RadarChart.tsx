import { useMemo } from 'react'

interface Props {
  dimensions: Array<{
    label: string
    value: number // 0-1 normalized
    status: 'pending' | 'weak' | 'good' | 'pass' | 'fail' | 'untested'
  }>
  size?: number // default 200
}

const STATUS_COLORS: Record<string, string> = {
  good: 'hsl(var(--color-success))',
  pass: 'hsl(var(--color-success))',
  weak: 'hsl(var(--color-warning))',
  fail: 'hsl(var(--color-danger))',
  pending: 'hsl(var(--color-muted-foreground))',
  untested: 'hsl(var(--color-muted-foreground))',
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
  // Start from top (-PI/2) so the first axis points up
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

  const count = dimensions.length
  const labelMargin = 28
  const cx = size / 2
  const cy = size / 2
  const radius = size / 2 - labelMargin

  const gridLevels = [0.25, 0.5, 0.75, 1]

  const axisPoints = useMemo(() => getPolygonPoints(cx, cy, radius, count), [cx, cy, radius, count])

  const dataPoints = useMemo(() => {
    const angleStep = (2 * Math.PI) / count
    const startAngle = -Math.PI / 2
    return dimensions.map((d, i) => {
      const r = Math.max(0, Math.min(1, d.value)) * radius
      return polarToCartesian(cx, cy, r, startAngle + i * angleStep)
    })
  }, [dimensions, cx, cy, radius, count])

  const labelPositions = useMemo(() => {
    const labelRadius = radius + 14
    const angleStep = (2 * Math.PI) / count
    const startAngle = -Math.PI / 2
    return dimensions.map((_, i) => {
      const angle = startAngle + i * angleStep
      const pos = polarToCartesian(cx, cy, labelRadius, angle)
      // Determine text-anchor based on position relative to center
      let anchor: 'start' | 'middle' | 'end' = 'middle'
      if (pos.x < cx - 2) anchor = 'end'
      else if (pos.x > cx + 2) anchor = 'start'
      // Vertical nudge for top/bottom labels
      let dy = '0.35em'
      if (pos.y < cy - radius * 0.5) dy = '0.8em'
      else if (pos.y > cy + radius * 0.5) dy = '-0.2em'
      return { ...pos, anchor, dy }
    })
  }, [dimensions, cx, cy, radius, count])

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="overflow-visible"
    >
      {/* Background grid polygons */}
      {gridLevels.map((level) => {
        const points = getPolygonPoints(cx, cy, radius * level, count)
        return (
          <polygon
            key={level}
            points={pointsToString(points)}
            fill="none"
            style={{
              stroke: 'hsl(var(--color-border))',
              opacity: 0.3,
            }}
            strokeWidth={1}
          />
        )
      })}

      {/* Axis lines from center to each vertex */}
      {axisPoints.map((point, i) => (
        <line
          key={i}
          x1={cx}
          y1={cy}
          x2={point.x}
          y2={point.y}
          style={{
            stroke: 'hsl(var(--color-border))',
            opacity: 0.3,
          }}
          strokeWidth={1}
        />
      ))}

      {/* Data polygon */}
      <polygon
        points={pointsToString(dataPoints)}
        style={{
          fill: 'hsl(var(--color-accent) / 0.15)',
          stroke: 'hsl(var(--color-accent))',
        }}
        strokeWidth={1.5}
      />

      {/* Data point circles */}
      {dataPoints.map((point, i) => (
        <circle
          key={i}
          cx={point.x}
          cy={point.y}
          r={3}
          style={{
            fill: STATUS_COLORS[dimensions[i].status] ?? STATUS_COLORS.pending,
          }}
          strokeWidth={0}
        />
      ))}

      {/* Labels */}
      {labelPositions.map((pos, i) => (
        <text
          key={i}
          x={pos.x}
          y={pos.y}
          textAnchor={pos.anchor}
          dy={pos.dy}
          className="fill-muted-foreground"
          style={{ fontSize: 10 }}
        >
          {dimensions[i].label}
        </text>
      ))}
    </svg>
  )
}
