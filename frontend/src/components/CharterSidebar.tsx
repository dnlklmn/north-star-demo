import type { Charter, GapAnalysis } from '../types'
import RadarChart from './RadarChart'
import { computeCoverageScore, coverageStatus } from './coverage'

interface CharterSidebarProps {
  charter: Charter
  /** Charter at the time the dataset was generated. Rows' feature_area
   *  strings are normalized against this at synth time, so we look up
   *  alignment here first — using the live charter would miss matches
   *  whenever the user edited the charter post-synth. */
  charterSnapshot?: Charter | null
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
  /** Navigate to the Charter tab's alignment section so the user can add or
   *  edit alignment entries. Called from the "Add alignment criteria" CTA
   *  in the no-match branch of the charter criteria block. */
  onAddAlignmentCriteria?: () => void
}

export default function CharterSidebar({
  charter,
  charterSnapshot,
  focusedFeatureArea,
  focusedCoverageTags,
  gaps,
  onOpenCoverageMatrix,
  onRequestFillGaps,
  onAddAlignmentCriteria,
}: CharterSidebarProps) {
  // Prefer the snapshot for matching — that's the alignment the rows were
  // tagged against. Fall back to the live charter if the dataset has no
  // snapshot (older datasets) or it's empty.
  const snapshotAlignment = charterSnapshot?.alignment ?? []
  const liveAlignment = charter.alignment ?? []
  const allAlignment = snapshotAlignment.length > 0 ? snapshotAlignment : liveAlignment
  const matched = allAlignment.find(a => a.feature_area === focusedFeatureArea)
  // Drift signal: when both lists are non-empty and their feature_area sets
  // differ, the user edited the charter after synth and "Retag against
  // charter" would help.
  const usingSnapshot = snapshotAlignment.length > 0
  const driftDetected =
    usingSnapshot &&
    liveAlignment.length > 0 &&
    !sameFeatureAreas(snapshotAlignment, liveAlignment)

  // Full-height rail with a left border, matching Scorers / Evaluate. Inner
  // sections separate via border-b (not floating cards).
  return (
    <aside className="w-80 shrink-0 border-l border-border-hint flex flex-col overflow-y-auto">
      <CoverageSummary
        gaps={gaps}
        onOpenMatrix={onOpenCoverageMatrix}
        onRequestFillGaps={onRequestFillGaps}
      />

      <section className="p-6 flex flex-col gap-3 text-xs">
        <header className="flex flex-col gap-0.5">
          <div className="text-[10px] uppercase tracking-wide text-fg-dim">
            Charter criteria
          </div>
          <div className="text-sm font-semibold text-fg-contrast leading-tight">
            {focusedFeatureArea || 'No row in view'}
          </div>
        </header>

        {driftDetected && (
          <div className="px-2 py-1.5 bg-warning/10 border-l-2 border-warning text-[11px] text-warning leading-snug">
            The charter alignment has changed since this dataset was
            generated. Run "Retag against charter" to align rows.
          </div>
        )}

        {!focusedFeatureArea ? (
          <p className="text-fg-dim">
            Scroll or click a row to see the charter alignment for it.
          </p>
        ) : matched ? (
          <>
            <CriterionBlock tone="good" label="Good" text={matched.good} />
            <CriterionBlock tone="bad" label="Bad" text={matched.bad} />
          </>
        ) : allAlignment.length === 0 ? (
          <NoAlignmentCTA
            label="No alignment defined yet"
            description="Define alignment entries on the Charter tab to see good/bad criteria here."
            onClick={onAddAlignmentCriteria}
          />
        ) : (
          <NoAlignmentCTA
            label="No alignment match for this row"
            description={`This row's feature_area isn't one of the ${allAlignment.length} alignment ${allAlignment.length === 1 ? 'entry' : 'entries'} the charter defines.`}
            onClick={onAddAlignmentCriteria}
          />
        )}

        {focusedCoverageTags.length > 0 && (
          <div>
            <div
              className="text-[10px] uppercase tracking-wide text-fg-dim mb-1"
              title="Coverage tags identify which scenarios this row claims to test."
            >
              Coverage tags
            </div>
            <ul className="space-y-0.5 text-fg-contrast">
              {focusedCoverageTags.map(tag => (
                <li key={tag} className="leading-snug">• {tag}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </aside>
  )
}

function sameFeatureAreas(a: Charter['alignment'], b: Charter['alignment']): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a.map(e => e.feature_area))
  for (const e of b) {
    if (!setA.has(e.feature_area)) return false
  }
  return true
}

function NoAlignmentCTA({
  label,
  description,
  onClick,
}: {
  label: string
  description: string
  onClick?: () => void
}) {
  return (
    <div className="flex flex-col gap-2 text-fg-dim leading-relaxed">
      <p>
        <span className="text-fg-contrast font-medium">{label}.</span>{' '}
        {description}
      </p>
      {onClick && (
        <button
          onClick={onClick}
          className="self-start px-2 py-1 text-xs bg-fill-primary text-bg-default hover:bg-fill-primary-hover transition-opacity"
        >
          Add alignment criteria
        </button>
      )}
    </div>
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
      <section className="p-6 border-b border-border-hint text-xs text-fg-dim">
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
    <section className="p-6 border-b border-border-hint flex flex-col gap-3 text-xs">
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
            labelFontSize={11}
            labelMaxChars={14}
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
