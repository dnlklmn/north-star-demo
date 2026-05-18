import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import type { GapAnalysis } from '../types'
import RadarChart from './RadarChart'
import { computeCoverageScore, coverageStatus } from './coverage'

interface CoverageMapProps {
  gaps: GapAnalysis
  /** Modal variant: backdrop + close button. Inline variant: panel embeds in
   *  the page above the example list, with an optional collapse toggle. */
  variant?: 'modal' | 'inline'
  onClose?: () => void
  /** Inline-only: passed when the caller wants a collapse chevron in the header. */
  collapsed?: boolean
  onToggleCollapsed?: () => void
  /** Request generation for a single (criterion, featureArea) intersection.
   *  The parent opens the GenerateModal with appropriate context — the map
   *  doesn't trigger synthesis directly. */
  onRequestCellGenerate?: (criterion: string, featureArea: string) => void
  /** Request bulk generation to fill every empty intersection. Same pattern
   *  as onRequestCellGenerate — opens the modal, doesn't run synth. */
  onRequestFillGaps?: () => void
}

function cellTone(count: number): string {
  if (count === 0) return 'bg-danger/20 text-danger'
  if (count <= 2) return 'bg-warning/20 text-warning'
  return 'bg-success/20 text-success'
}

export default function CoverageMap({
  gaps,
  variant = 'modal',
  onClose,
  collapsed = false,
  onToggleCollapsed,
  onRequestCellGenerate,
  onRequestFillGaps,
}: CoverageMapProps) {
  const matrix = gaps.coverage_matrix || {}
  const criteria = Object.keys(matrix)
  const featureAreas = criteria.length > 0 ? Object.keys(matrix[criteria[0]] || {}) : []

  const score = computeCoverageScore(gaps)
  const totalCells = criteria.length * featureAreas.length
  const emptyCount = criteria.reduce(
    (acc, c) => acc + featureAreas.filter(fa => (matrix[c]?.[fa] ?? 0) === 0).length,
    0,
  )

  const isInline = variant === 'inline'

  const header = (
    <div className="flex items-center justify-between px-5 py-3 border-b border-border-hint">
      <div className="flex items-center gap-3">
        {isInline && onToggleCollapsed && (
          <button
            onClick={onToggleCollapsed}
            className="text-fg-dim hover:text-fg-contrast"
            aria-label={collapsed ? 'Expand coverage map' : 'Collapse coverage map'}
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        )}
        <h3 className="text-sm font-semibold text-fg-contrast">Coverage Map</h3>
        {score != null && (
          <span className="flex items-center gap-1.5 text-xs text-fg-dim">
            <CoverageDot score={score} />
            {Math.round(score * 100)}% covered ({totalCells - emptyCount}/{totalCells})
          </span>
        )}
      </div>
      {!isInline && onClose && (
        <button
          onClick={onClose}
          className="text-fg-dim hover:text-fg-contrast"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  )

  // Body is identical between variants — only the framing chrome differs.
  const body = collapsed ? null : (
    <>
      {gaps.summary && (
        <div className="px-5 py-3 border-b border-border-hint text-xs text-fg-dim">
          {gaps.summary}
        </div>
      )}

      <div className={isInline ? 'overflow-auto p-5 max-h-[60vh]' : 'flex-1 overflow-auto p-5'}>
        {criteria.length === 0 ? (
          <p className="text-xs text-fg-dim">
            No coverage data available. Generate or import examples first.
          </p>
        ) : (
          <>
            {featureAreas.length >= 3 && (
              <div className="flex justify-center mb-6">
                <RadarChart
                  dimensions={featureAreas.map(fa => {
                    const coveredCount = criteria.filter(
                      c => ((matrix[c] || {})[fa] || 0) > 0,
                    ).length
                    const pct = criteria.length > 0 ? coveredCount / criteria.length : 0
                    return {
                      label: fa,
                      value: pct,
                      status: pct >= 0.7 ? ('good' as const) : pct > 0 ? ('weak' as const) : ('fail' as const),
                    }
                  })}
                  size={240}
                />
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="text-xs w-full border-collapse">
                <thead>
                  <tr>
                    <th className="text-left p-2 font-medium text-fg-dim border-b border-border-hint min-w-[200px]">
                      Coverage criterion
                    </th>
                    {featureAreas.map(fa => (
                      <th
                        key={fa}
                        className="text-center p-2 font-medium text-fg-dim border-b border-border-hint min-w-[80px]"
                      >
                        {fa}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {criteria.map(crit => (
                    <tr key={crit}>
                      <td className="p-2 text-fg-contrast border-b border-border-hint leading-relaxed">
                        {crit}
                      </td>
                      {featureAreas.map(fa => {
                        const count = (matrix[crit] || {})[fa] || 0
                        const tone = cellTone(count)
                        return (
                          <td key={fa} className="text-center p-2 border-b border-border-hint">
                            <div
                              className={`inline-flex items-center justify-between gap-1 w-14 px-2 py-1 text-xs font-medium ${tone}`}
                            >
                              <span>{count}</span>
                              {onRequestCellGenerate && (
                                <button
                                  onClick={() => onRequestCellGenerate(crit, fa)}
                                  className="hover:opacity-70 transition-opacity"
                                  title={
                                    count === 0
                                      ? `Generate examples for "${crit}" × "${fa}"`
                                      : `Add more examples for "${crit}" × "${fa}"`
                                  }
                                >
                                  <Plus className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {onRequestFillGaps && emptyCount > 0 && (
        <div className="px-5 py-3 border-t border-border-hint">
          <button
            onClick={onRequestFillGaps}
            className="w-full py-2.5 bg-fill-primary text-bg-default text-sm font-medium hover:bg-fill-primary-hover transition-opacity"
          >
            Fix coverage ({emptyCount} gap{emptyCount === 1 ? '' : 's'})
          </button>
        </div>
      )}
    </>
  )

  if (isInline) {
    return (
      <div className="bg-bg-default border border-border-hint">
        {header}
        {body}
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-bg-default border border-border-hint shadow-xl max-w-3xl w-full mx-4 max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {header}
        {body}
      </div>
    </div>
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
