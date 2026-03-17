import type { GapAnalysis } from '../types'

interface CoverageMapProps {
  gaps: GapAnalysis
  onClose: () => void
}

function cellColor(count: number): string {
  if (count === 0) return 'bg-danger/20 text-danger'
  if (count <= 2) return 'bg-warning/20 text-warning'
  return 'bg-success/20 text-success'
}

export default function CoverageMap({ gaps, onClose }: CoverageMapProps) {
  const matrix = gaps.coverage_matrix || {}
  const criteria = Object.keys(matrix)
  const featureAreas = criteria.length > 0 ? Object.keys(matrix[criteria[0]] || {}) : []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-surface-raised border border-border rounded-xl shadow-xl max-w-3xl w-full mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">Coverage Map</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg leading-none"
          >
            x
          </button>
        </div>

        {/* Summary */}
        <div className="px-5 py-3 border-b border-border text-xs text-muted-foreground">
          {gaps.summary}
        </div>

        {/* Matrix */}
        <div className="flex-1 overflow-auto p-5">
          {criteria.length === 0 ? (
            <p className="text-xs text-muted-foreground">No coverage data available. Generate or import examples first.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-xs w-full border-collapse">
                <thead>
                  <tr>
                    <th className="text-left p-2 font-medium text-muted-foreground border-b border-border min-w-[200px]">
                      Coverage criterion
                    </th>
                    {featureAreas.map(fa => (
                      <th key={fa} className="text-center p-2 font-medium text-muted-foreground border-b border-border min-w-[80px]">
                        {fa}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {criteria.map(crit => (
                    <tr key={crit}>
                      <td className="p-2 text-foreground border-b border-border leading-relaxed">
                        {crit}
                      </td>
                      {featureAreas.map(fa => {
                        const count = (matrix[crit] || {})[fa] || 0
                        return (
                          <td key={fa} className="text-center p-2 border-b border-border">
                            <span className={`inline-block w-7 h-7 rounded-md flex items-center justify-center text-xs font-medium ${cellColor(count)}`}>
                              {count}
                            </span>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Gaps detail */}
        <div className="px-5 py-3 border-t border-border space-y-2 max-h-40 overflow-y-auto">
          {gaps.coverage_gaps.length > 0 && (
            <div>
              <span className="text-[10px] font-medium text-danger uppercase tracking-wide">Coverage gaps</span>
              <div className="flex gap-1 flex-wrap mt-0.5">
                {gaps.coverage_gaps.map((g, i) => (
                  <span key={i} className="text-[10px] px-1.5 py-0.5 bg-danger/10 text-danger rounded">{g}</span>
                ))}
              </div>
            </div>
          )}
          {gaps.feature_area_gaps.length > 0 && (
            <div>
              <span className="text-[10px] font-medium text-warning uppercase tracking-wide">Feature area gaps</span>
              <div className="flex gap-1 flex-wrap mt-0.5">
                {gaps.feature_area_gaps.map((g, i) => (
                  <span key={i} className="text-[10px] px-1.5 py-0.5 bg-warning/10 text-warning rounded">{g}</span>
                ))}
              </div>
            </div>
          )}
          {gaps.balance_issues.length > 0 && (
            <div>
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Balance issues</span>
              {gaps.balance_issues.map((issue, i) => (
                <p key={i} className="text-[11px] text-muted-foreground mt-0.5">{issue}</p>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
