import type { Charter, GapAnalysis } from '../types'
import RadarChart from './RadarChart'
import { computeCoverageScore, coverageStatus } from './coverage'

interface CharterSidebarProps {
  charter: Charter
  /** feature_area of the currently focused row (set by click or scroll).
   *  Resolved against alignment by name match. */
  focusedFeatureArea: string | null | undefined
  /** Coverage tags carried by the focused row. */
  focusedCoverageTags: string[]
  /** Gap analysis powers the compact coverage summary (radar + score).
   *  The full matrix opens in a modal via `onOpenCoverageMatrix`. */
  gaps?: GapAnalysis | null
  onOpenCoverageMatrix?: () => void
  onRequestFillGaps?: () => void
}

export default function CharterSidebar({
  charter,
  focusedFeatureArea,
  focusedCoverageTags,
  gaps,
  onOpenCoverageMatrix,
  onRequestFillGaps,
}: CharterSidebarProps) {
  const allAlignment = charter.alignment ?? []
  const matched = allAlignment.find(a => a.feature_area === focusedFeatureArea)

  return (
    <aside className="w-80 shrink-0 flex flex-col gap-4 overflow-y-auto">
      <CoverageSummary
        gaps={gaps}
        onOpenMatrix={onOpenCoverageMatrix}
        onRequestFillGaps={onRequestFillGaps}
      />

      <section className="bg-bg-default border border-border-hint p-4 flex flex-col gap-3 text-xs">
        <header className="flex flex-col gap-0.5">
          <div className="text-[10px] uppercase tracking-wide text-fg-dim">
            Charter criteria
          </div>
          <div className="text-sm font-semibold text-fg-contrast leading-tight">
            {focusedFeatureArea || 'No row in view'}
          </div>
        </header>

        {!focusedFeatureArea ? (
          <p className="text-fg-dim">
            Scroll or click a row to see the charter alignment for it.
          </p>
        ) : matched ? (
          <>
            <CriterionBlock tone="good" label="Good" text={matched.good} />
            <CriterionBlock tone="bad" label="Bad" text={matched.bad} />
          </>
        ) : (
          <p className="text-fg-dim leading-relaxed">
            No matching alignment entry in the charter for this row's
            feature_area. The reference list below shows every alignment entry
            the charter defines.
          </p>
        )}

        {focusedCoverageTags.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-fg-dim mb-1">
              Row covers
            </div>
            <ul className="space-y-0.5 text-fg-contrast">
              {focusedCoverageTags.map(tag => (
                <li key={tag} className="leading-snug">• {tag}</li>
              ))}
            </ul>
          </div>
        )}

        {!matched && allAlignment.length > 0 && (
          <details className="text-fg-dim">
            <summary className="cursor-pointer text-[10px] uppercase tracking-wide hover:text-fg-contrast">
              All alignment entries ({allAlignment.length})
            </summary>
            <ul className="mt-2 space-y-2">
              {allAlignment.map(a => (
                <li key={a.feature_area} className="leading-snug">
                  <div className="font-semibold text-fg-contrast">{a.feature_area}</div>
                  {a.good && (
                    <div className="text-fg-dim">
                      <span className="text-success">Good:</span> {a.good}
                    </div>
                  )}
                  {a.bad && (
                    <div className="text-fg-dim">
                      <span className="text-danger">Bad:</span> {a.bad}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </aside>
  )
}

function CriterionBlock({ tone, label, text }: { tone: 'good' | 'bad'; label: string; text: string }) {
  const colorCls = tone === 'good' ? 'text-success' : 'text-danger'
  return (
    <div>
      <div className={`text-[10px] uppercase tracking-wide mb-1 ${colorCls}`}>{label}</div>
      <div className="text-fg-contrast leading-relaxed">{text || '—'}</div>
    </div>
  )
}

function CoverageSummary({
  gaps,
  onOpenMatrix,
  onRequestFillGaps,
}: {
  gaps?: GapAnalysis | null
  onOpenMatrix?: () => void
  onRequestFillGaps?: () => void
}) {
  if (!gaps) {
    return (
      <section className="bg-bg-default border border-border-hint p-4 text-xs text-fg-dim">
        Coverage will appear once examples land.
      </section>
    )
  }

  const matrix = gaps.coverage_matrix || {}
  const criteria = Object.keys(matrix)
  const featureAreas =
    criteria.length > 0 ? Object.keys(matrix[criteria[0]] || {}) : []
  const score = computeCoverageScore(gaps)
  const totalCells = criteria.length * featureAreas.length
  const emptyCount = criteria.reduce(
    (acc, c) => acc + featureAreas.filter(fa => (matrix[c]?.[fa] ?? 0) === 0).length,
    0,
  )

  return (
    <section className="bg-bg-default border border-border-hint p-4 flex flex-col gap-3 text-xs">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {score != null && <CoverageDot score={score} />}
          <span className="text-sm font-semibold text-fg-contrast">Coverage</span>
        </div>
        {score != null && (
          <span className="text-fg-dim">
            {Math.round(score * 100)}% ({totalCells - emptyCount}/{totalCells})
          </span>
        )}
      </header>

      {featureAreas.length >= 3 && (
        <div className="flex justify-center">
          <RadarChart
            dimensions={featureAreas.map(fa => {
              const coveredCount = criteria.filter(
                c => ((matrix[c] || {})[fa] || 0) > 0,
              ).length
              const pct = criteria.length > 0 ? coveredCount / criteria.length : 0
              return {
                label: fa,
                value: pct,
                status:
                  pct >= 0.7
                    ? ('good' as const)
                    : pct > 0
                      ? ('weak' as const)
                      : ('fail' as const),
              }
            })}
            size={160}
          />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {onRequestFillGaps && emptyCount > 0 && (
          <button
            onClick={onRequestFillGaps}
            className="w-full py-1.5 px-2 bg-fill-primary text-bg-default text-xs font-medium hover:bg-fill-primary-hover transition-opacity"
          >
            Fix coverage ({emptyCount} gap{emptyCount === 1 ? '' : 's'})
          </button>
        )}
        {onOpenMatrix && (
          <button
            onClick={onOpenMatrix}
            className="w-full py-1.5 px-2 text-xs text-fg-dim hover:text-fg-contrast border border-border-hint transition-colors"
          >
            View full matrix
          </button>
        )}
      </div>
    </section>
  )
}

function CoverageDot({ score }: { score: number }) {
  const status = coverageStatus(score)
  const cls =
    status === 'good'
      ? 'bg-success'
      : status === 'warn'
        ? 'bg-warning'
        : 'bg-danger'
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />
}
