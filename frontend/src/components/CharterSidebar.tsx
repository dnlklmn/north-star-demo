import type { Charter, GapAnalysis } from '../types'
import RadarChart from './RadarChart'
import { computeCoverageScore, coverageStatus } from './coverage'

interface CharterSidebarProps {
  charter: Charter
  /** feature_area of the currently focused row. The sidebar resolves the
   *  matching alignment entry by name (not by index — alignment entries
   *  are not index-aligned to anything else). */
  focusedFeatureArea: string | null | undefined
  /** Coverage tags carried by the focused row. Shown above the charter's
   *  coverage list so reviewers see which scenarios this row claims to cover. */
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
  const alignment = charter.alignment?.find(
    a => a.feature_area === focusedFeatureArea,
  )

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
            Charter criteria for
          </div>
          <div className="text-sm font-semibold text-fg-contrast leading-tight">
            {focusedFeatureArea || 'No row selected'}
          </div>
        </header>

        {!focusedFeatureArea ? (
          <p className="text-fg-dim">
            Select a row to see the charter alignment it should satisfy.
          </p>
        ) : alignment ? (
          <>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-success mb-1">Good</div>
              <div className="text-fg-contrast leading-relaxed">{alignment.good || '—'}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-danger mb-1">Bad</div>
              <div className="text-fg-contrast leading-relaxed">{alignment.bad || '—'}</div>
            </div>
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
          </>
        ) : (
          <p className="text-fg-dim italic">
            This feature_area isn't in the charter alignment list. The row may
            be off-target — consider re-tagging or rejecting.
          </p>
        )}
      </section>
    </aside>
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
