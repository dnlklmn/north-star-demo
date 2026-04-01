/**
 * Radar/spider chart for visualizing multi-dimensional scores.
 * Pure SVG — no dependencies.
 */

interface RadarPoint {
  label: string
  value: number // 0-100
}

interface Props {
  points: RadarPoint[]
  threshold?: number // 0-100, shown as a dashed ring
  size?: number
  className?: string
}

export default function RadarChart({ points, threshold = 70, size = 200, className = '' }: Props) {
  if (points.length < 3) return null

  const cx = size / 2
  const cy = size / 2
  const radius = (size / 2) - 32 // leave room for labels
  const n = points.length
  const angleStep = (2 * Math.PI) / n
  const startAngle = -Math.PI / 2 // start from top

  // Get (x, y) for a given index and radius fraction (0-1)
  const getPoint = (index: number, fraction: number) => {
    const angle = startAngle + index * angleStep
    return {
      x: cx + radius * fraction * Math.cos(angle),
      y: cy + radius * fraction * Math.sin(angle),
    }
  }

  // Build polygon path for a given set of fractions
  const buildPath = (fractions: number[]) => {
    return fractions
      .map((f, i) => {
        const { x, y } = getPoint(i, f)
        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`
      })
      .join(' ') + ' Z'
  }

  // Grid rings at 25%, 50%, 75%, 100%
  const gridLevels = [0.25, 0.5, 0.75, 1.0]

  // Data polygon
  const dataFractions = points.map(p => Math.max(0, Math.min(p.value, 100)) / 100)
  const dataPath = buildPath(dataFractions)

  // Threshold ring
  const thresholdFraction = threshold / 100
  const thresholdPath = buildPath(Array(n).fill(thresholdFraction))

  return (
    <div className={className}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Grid rings */}
        {gridLevels.map(level => (
          <polygon
            key={level}
            points={Array.from({ length: n }, (_, i) => {
              const { x, y } = getPoint(i, level)
              return `${x},${y}`
            }).join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="0.5"
            className="text-border"
          />
        ))}

        {/* Axis lines */}
        {points.map((_, i) => {
          const { x, y } = getPoint(i, 1)
          return (
            <line
              key={i}
              x1={cx}
              y1={cy}
              x2={x}
              y2={y}
              stroke="currentColor"
              strokeWidth="0.5"
              className="text-border"
            />
          )
        })}

        {/* Threshold ring */}
        <polygon
          points={Array.from({ length: n }, (_, i) => {
            const { x, y } = getPoint(i, thresholdFraction)
            return `${x},${y}`
          }).join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="3 3"
          className="text-muted-foreground/40"
        />

        {/* Data fill */}
        <path
          d={dataPath}
          fill="currentColor"
          fillOpacity="0.15"
          className="text-accent"
        />

        {/* Data outline */}
        <path
          d={dataPath}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-accent"
        />

        {/* Data points */}
        {dataFractions.map((f, i) => {
          const { x, y } = getPoint(i, f)
          const isGood = points[i].value >= threshold
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={3}
              fill="currentColor"
              className={isGood ? 'text-success' : points[i].value > 0 ? 'text-accent' : 'text-muted-foreground'}
            />
          )
        })}

        {/* Labels */}
        {points.map((point, i) => {
          const { x, y } = getPoint(i, 1.2)
          // Determine text-anchor based on position
          const angle = startAngle + i * angleStep
          const cos = Math.cos(angle)
          const textAnchor = Math.abs(cos) < 0.1 ? 'middle' : cos > 0 ? 'start' : 'end'
          const dy = Math.sin(angle) > 0.5 ? '0.8em' : Math.sin(angle) < -0.5 ? '-0.2em' : '0.35em'

          return (
            <text
              key={i}
              x={x}
              y={y}
              textAnchor={textAnchor}
              dy={dy}
              className="fill-muted-foreground"
              style={{ fontSize: '10px' }}
            >
              {point.label}
              <tspan
                dx="3"
                className={point.value >= threshold ? 'fill-success' : point.value > 0 ? 'fill-accent' : 'fill-muted-foreground'}
                style={{ fontWeight: 600 }}
              >
                {point.value}%
              </tspan>
            </text>
          )
        })}
      </svg>
    </div>
  )
}
