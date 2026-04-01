import { useState, useEffect, useRef, useCallback } from 'react'
import type { Example, Charter } from '../types'
import ExampleCard from './examples/ExampleCard'
import DeleteModal from './examples/DeleteModal'
import GenerateModal from './examples/GenerateModal'

interface ExampleReviewProps {
  examples: Example[]
  charter: Charter
  loading: boolean
  onUpdateExample: (exampleId: string, fields: Partial<Example>) => void
  onDeleteExample: (exampleId: string) => void
  onImport: () => void
  onSynthesize: (count?: number) => void
  onAutoReview: () => void
  onExport: () => void
  onShowCoverageMap: () => void
  onHeaderClick?: () => void
  isFocused?: boolean
  coverageGaps?: { uncoveredCount: number; totalScenarios: number } | null
}

export default function ExampleReview({
  examples,
  charter,
  loading,
  onUpdateExample,
  onDeleteExample,
  onImport,
  onSynthesize,
  onAutoReview,
  onExport,
  onShowCoverageMap,
  onHeaderClick,
  isFocused,
  coverageGaps,
}: ExampleReviewProps) {
  const [filterArea, setFilterArea] = useState<string>('')
  const [filterLabel, setFilterLabel] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<string>('pending')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [showGenerateModal, setShowGenerateModal] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const featureAreas = charter.alignment.map(a => a.feature_area)

  const coverageCriteria = charter.coverage?.criteria?.length || 0
  const alignmentAreas = charter.alignment?.length || 0
  const totalScenarios = Math.max(coverageCriteria * alignmentAreas, 1)

  // Calculate suggested total example count
  const getSuggestedGeneration = () => {
    if (coverageGaps && coverageGaps.uncoveredCount > 0) {
      const total = coverageGaps.uncoveredCount * 2
      return {
        count: total,
        reason: `${coverageGaps.uncoveredCount} of ${coverageGaps.totalScenarios} scenarios lack examples.`
      }
    }

    if (examples.length === 0) {
      const total = totalScenarios * 2
      return {
        count: total,
        reason: `${totalScenarios} scenarios (${alignmentAreas} feature areas × ${coverageCriteria} criteria). 2 examples each for good initial coverage.`
      }
    }

    const approvedCount = examples.filter(e => e.review_status === 'approved').length
    if (approvedCount < totalScenarios) {
      return {
        count: totalScenarios - approvedCount,
        reason: `${approvedCount} approved out of ${totalScenarios} scenarios. Fill the remaining gaps.`
      }
    }

    return {
      count: totalScenarios,
      reason: `Good coverage (${approvedCount} approved). Add more for diversity or edge cases.`
    }
  }

  const { count: suggestedCount, reason: suggestionReason } = getSuggestedGeneration()

  const filtered = examples.filter(ex => {
    if (filterArea && ex.feature_area !== filterArea) return false
    if (filterLabel && ex.label !== filterLabel) return false
    if (filterStatus && ex.review_status !== filterStatus) return false
    return true
  })

  // Auto-select first example if none selected
  useEffect(() => {
    if (filtered.length > 0 && (!selectedId || !filtered.find(e => e.id === selectedId))) {
      setSelectedId(filtered[0].id)
    }
  }, [filtered, selectedId])

  const selectedIndex = filtered.findIndex(e => e.id === selectedId)
  const selectedExample = filtered.find(e => e.id === selectedId)

  // Keyboard navigation and shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Don't handle if editing or modal is open
    if (editingId || deleteConfirmId) {
      if (e.key === 'Escape') {
        setEditingId(null)
      }
      return
    }

    // Don't handle if focus is in an input/textarea
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
      return
    }

    switch (e.key) {
      case 'ArrowUp':
      case 'k':
        e.preventDefault()
        if (selectedIndex > 0) {
          setSelectedId(filtered[selectedIndex - 1].id)
        }
        break
      case 'ArrowDown':
      case 'j':
        e.preventDefault()
        if (selectedIndex < filtered.length - 1) {
          setSelectedId(filtered[selectedIndex + 1].id)
        }
        break
      case 'a':
      case 'A':
        if (selectedExample) {
          e.preventDefault()
          onUpdateExample(selectedExample.id, { review_status: 'approved' })
        }
        break
      case 'e':
      case 'E':
        if (selectedExample) {
          e.preventDefault()
          setEditingId(selectedExample.id)
        }
        break
      case 'r':
      case 'R':
        if (selectedExample) {
          e.preventDefault()
          onUpdateExample(selectedExample.id, { review_status: 'rejected' })
        }
        break
      case 'l':
      case 'L':
        if (selectedExample) {
          e.preventDefault()
          onUpdateExample(selectedExample.id, {
            label: selectedExample.label === 'good' ? 'bad' : 'good'
          })
        }
        break
      case 'd':
      case 'D':
        if (selectedExample) {
          e.preventDefault()
          setDeleteConfirmId(selectedExample.id)
        }
        break
    }
  }, [editingId, deleteConfirmId, selectedIndex, filtered, selectedExample, onUpdateExample])

  useEffect(() => {
    if (isFocused) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isFocused, handleKeyDown])

  const handleConfirmDelete = () => {
    if (deleteConfirmId) {
      onDeleteExample(deleteConfirmId)
      setDeleteConfirmId(null)
      // Select next or previous
      if (selectedIndex < filtered.length - 1) {
        setSelectedId(filtered[selectedIndex + 1].id)
      } else if (selectedIndex > 0) {
        setSelectedId(filtered[selectedIndex - 1].id)
      } else {
        setSelectedId(null)
      }
    }
  }

  const stats = {
    total: examples.length,
    pending: examples.filter(e => e.review_status === 'pending').length,
    approved: examples.filter(e => e.review_status === 'approved').length,
    rejected: examples.filter(e => e.review_status === 'rejected').length,
  }

  const hasExamples = examples.length > 0

  return (
    <div className="h-full flex flex-col" ref={containerRef}>
      {/* Empty state — centered import/generate */}
      {!hasExamples ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8">
          <div className="text-center max-w-sm">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground/40 mx-auto mb-4">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            <h3 className="text-base font-semibold text-foreground mb-2">Build your dataset</h3>
            <p className="text-sm text-muted-foreground mb-6">
              Import existing data or generate examples from your charter.
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={onImport}
                disabled={loading}
                className="px-5 py-2.5 bg-surface-raised border border-border rounded-lg text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
              >
                Import data
              </button>
              <button
                onClick={() => onSynthesize(1)}
                disabled={loading}
                className="px-5 py-2.5 bg-accent text-accent-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {loading ? 'Generating...' : 'Minimum coverage'}
              </button>
              <button
                onClick={() => setShowGenerateModal(true)}
                disabled={loading}
                className="px-5 py-2.5 bg-surface-raised border border-border rounded-lg text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
              >
                Custom amount...
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Minimum coverage generates ~{totalScenarios} examples ({alignmentAreas} areas × {coverageCriteria} criteria)
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Header — only shown when there are examples */}
          <div
            onClick={onHeaderClick}
            className={`h-12 flex items-center justify-between px-4 border-b border-border flex-shrink-0 ${
              isFocused ? '' : 'hover:bg-muted/50 cursor-pointer'
            }`}
          >
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold">Examples</h2>
              <span className="text-xs text-muted-foreground">
                {stats.total} total · {stats.pending} pending · {stats.approved} approved
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={(e) => { e.stopPropagation(); onShowCoverageMap(); }}
                className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground border border-border rounded transition-colors"
              >
                Coverage map
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onExport(); }}
                disabled={stats.approved === 0}
                className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground border border-border rounded transition-colors disabled:opacity-40"
              >
                Export
              </button>
            </div>
          </div>

          {/* Filters + actions */}
          <div className="px-4 py-2 border-b border-border flex items-center gap-2 flex-shrink-0 flex-wrap">
            <select
              value={filterArea}
              onChange={e => setFilterArea(e.target.value)}
              className="text-xs px-2 py-1 bg-background border border-border rounded"
            >
              <option value="">All areas</option>
              {featureAreas.map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <select
              value={filterLabel}
              onChange={e => setFilterLabel(e.target.value)}
              className="text-xs px-2 py-1 bg-background border border-border rounded"
            >
              <option value="">All labels</option>
              <option value="good">Good</option>
              <option value="bad">Bad</option>
              <option value="unlabeled">Unlabeled</option>
            </select>
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="text-xs px-2 py-1 bg-background border border-border rounded"
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="needs_edit">Needs edit</option>
            </select>

            <div className="ml-auto flex gap-1.5">
              <button
                onClick={onImport}
                disabled={loading}
                className="px-2.5 py-1 text-xs bg-surface-raised border border-border rounded hover:bg-muted transition-colors disabled:opacity-50"
              >
                Import
              </button>
              <button
                onClick={() => onSynthesize(1)}
                disabled={loading}
                className="px-2.5 py-1 text-xs bg-accent text-accent-foreground rounded hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {loading ? 'Generating...' : 'Min. coverage'}
              </button>
              <button
                onClick={() => setShowGenerateModal(true)}
                disabled={loading}
                className="px-2.5 py-1 text-xs bg-surface-raised border border-border rounded hover:bg-muted transition-colors disabled:opacity-50"
              >
                Generate...
              </button>
              <button
                onClick={onAutoReview}
                disabled={loading || stats.pending === 0}
                className="px-2.5 py-1 text-xs bg-surface-raised border border-border rounded hover:bg-muted transition-colors disabled:opacity-50"
              >
                Auto-review
              </button>
            </div>
          </div>

          {/* Keyboard hints */}
          {isFocused && filtered.length > 0 && (
            <div className="px-4 py-1.5 bg-muted/50 border-b border-border text-[10px] text-muted-foreground flex-shrink-0">
              <span className="mr-3">↑↓ Navigate</span>
              <span className="mr-3"><span className="underline">A</span>pprove</span>
              <span className="mr-3"><span className="underline">E</span>dit</span>
              <span className="mr-3"><span className="underline">R</span>eject</span>
              <span className="mr-3">Re<span className="underline">l</span>abel</span>
              <span><span className="underline">D</span>elete</span>
            </div>
          )}

          {/* Example list */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {filtered.length === 0 && filterStatus === 'pending' && stats.total > 0 ? (
              // All examples reviewed - show next steps
              <div className="flex flex-col items-center justify-center h-full">
                <div className="text-center max-w-sm">
                  <div className="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-4">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-success">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                  <h3 className="text-base font-semibold text-foreground mb-2">All examples reviewed!</h3>
                  <p className="text-xs text-muted-foreground mb-6">
                    You've reviewed all {stats.total} examples. {stats.approved} approved, {stats.rejected} rejected.
                  </p>
                  <div className="flex flex-col gap-3">
                    <button
                      onClick={onShowCoverageMap}
                      className="w-full py-2.5 px-4 bg-surface-raised border border-border rounded-lg text-sm font-medium hover:bg-muted transition-colors flex items-center justify-center gap-2"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
                        <rect x="3" y="3" width="7" height="7" />
                        <rect x="14" y="3" width="7" height="7" />
                        <rect x="14" y="14" width="7" height="7" />
                        <rect x="3" y="14" width="7" height="7" />
                      </svg>
                      Check coverage gaps
                    </button>
                    <button
                      onClick={() => setShowGenerateModal(true)}
                      disabled={loading}
                      className="w-full py-2.5 px-4 bg-surface-raised border border-border rounded-lg text-sm font-medium hover:bg-muted transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      Generate more examples
                    </button>
                    <button
                      onClick={onExport}
                      disabled={stats.approved === 0}
                      className="w-full py-2.5 px-4 bg-accent text-accent-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                      Export dataset ({stats.approved} examples)
                    </button>
                  </div>
                </div>
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <p className="text-sm mb-2">No matches</p>
                <p className="text-xs">Try adjusting your filters.</p>
              </div>
            ) : (
          filtered.map(example => (
            <ExampleCard
              key={example.id}
              example={example}
              isSelected={selectedId === example.id}
              onSelect={() => setSelectedId(example.id)}
              onUpdate={fields => onUpdateExample(example.id, fields)}
              onDelete={() => setDeleteConfirmId(example.id)}
              onStartEdit={() => setEditingId(example.id)}
              isEditing={editingId === example.id}
              onCancelEdit={() => setEditingId(null)}
            />
          ))
        )}
          </div>
        </>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirmId && (
        <DeleteModal
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteConfirmId(null)}
        />
      )}

      {/* Generate examples modal */}
      {showGenerateModal && (
        <GenerateModal
          onConfirm={(count) => {
            onSynthesize(count)
            setShowGenerateModal(false)
          }}
          onCancel={() => setShowGenerateModal(false)}
          suggestedCount={suggestedCount}
          suggestionReason={suggestionReason}
          totalScenarios={totalScenarios}
        />
      )}
    </div>
  )
}
