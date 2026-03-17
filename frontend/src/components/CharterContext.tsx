import type { Charter, Example } from '../types'

interface CharterContextProps {
  charter: Charter
  selectedExample: Example | null
  approvedCountByArea: Record<string, number>
  approvedCountByCoverage: Record<string, number>
}

export default function CharterContext({
  charter,
  selectedExample,
  approvedCountByArea,
  approvedCountByCoverage,
}: CharterContextProps) {
  const selectedArea = selectedExample?.feature_area
  const selectedAlignment = selectedArea
    ? charter.alignment.find(a => a.feature_area === selectedArea)
    : null

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="h-12 flex items-center px-4 border-b border-border flex-shrink-0">
        <h2 className="text-sm font-semibold">Charter</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Highlighted alignment for selected example */}
        {selectedAlignment && (
          <div className="p-3 border border-accent/30 bg-accent/5 rounded-lg">
            <div className="text-[10px] font-medium text-accent uppercase tracking-wide mb-1.5">
              Reviewing: {selectedAlignment.feature_area}
            </div>
            <div className="space-y-2">
              <div>
                <div className="text-[10px] font-medium text-success uppercase tracking-wide">Good</div>
                <div className="text-xs text-foreground leading-relaxed">{selectedAlignment.good}</div>
              </div>
              <div>
                <div className="text-[10px] font-medium text-danger uppercase tracking-wide">Bad</div>
                <div className="text-xs text-foreground leading-relaxed">{selectedAlignment.bad}</div>
              </div>
            </div>
          </div>
        )}

        {/* Coverage */}
        <section>
          <h3 className="text-xs font-semibold text-foreground mb-2">Coverage</h3>
          <div className="space-y-1">
            {charter.coverage.criteria.map((c, i) => {
              const count = approvedCountByCoverage[c] || 0
              return (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className={`flex-shrink-0 mt-0.5 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-medium ${
                    count > 0 ? 'bg-success/20 text-success' : 'bg-muted text-muted-foreground'
                  }`}>
                    {count}
                  </span>
                  <span className="text-foreground leading-relaxed">{c}</span>
                </div>
              )
            })}
            {charter.coverage.criteria.length === 0 && (
              <p className="text-xs text-muted-foreground">No coverage criteria defined.</p>
            )}
          </div>
        </section>

        {/* Balance */}
        <section>
          <h3 className="text-xs font-semibold text-foreground mb-2">Balance</h3>
          <div className="space-y-1">
            {charter.balance.criteria.map((c, i) => (
              <div key={i} className="text-xs text-foreground leading-relaxed">
                <span className="text-muted-foreground mr-1">-</span> {c}
              </div>
            ))}
            {charter.balance.criteria.length === 0 && (
              <p className="text-xs text-muted-foreground">No balance criteria defined.</p>
            )}
          </div>
        </section>

        {/* Alignment */}
        <section>
          <h3 className="text-xs font-semibold text-foreground mb-2">Alignment</h3>
          <div className="space-y-3">
            {charter.alignment.map((a, i) => {
              const count = approvedCountByArea[a.feature_area] || 0
              const isSelected = a.feature_area === selectedArea
              return (
                <div
                  key={i}
                  className={`p-2 rounded border text-xs ${
                    isSelected
                      ? 'border-accent/50 bg-accent/5'
                      : 'border-border bg-surface'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-foreground">{a.feature_area}</span>
                    <span className={`text-[10px] ${count > 0 ? 'text-success' : 'text-muted-foreground'}`}>
                      {count} example{count !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="text-muted-foreground leading-relaxed">
                    <span className="text-success font-medium">Good:</span> {a.good.length > 100 ? a.good.slice(0, 100) + '...' : a.good}
                  </div>
                  <div className="text-muted-foreground leading-relaxed mt-0.5">
                    <span className="text-danger font-medium">Bad:</span> {a.bad.length > 100 ? a.bad.slice(0, 100) + '...' : a.bad}
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* Rot */}
        <section>
          <h3 className="text-xs font-semibold text-foreground mb-2">Rot</h3>
          <div className="space-y-1">
            {charter.rot.criteria.map((c, i) => (
              <div key={i} className="text-xs text-foreground leading-relaxed">
                <span className="text-muted-foreground mr-1">-</span> {c}
              </div>
            ))}
            {charter.rot.criteria.length === 0 && (
              <p className="text-xs text-muted-foreground">No rot criteria defined.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
