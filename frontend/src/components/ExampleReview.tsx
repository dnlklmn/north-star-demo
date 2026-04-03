import { useState, useEffect, useRef, useCallback } from 'react'
import { ArrowRight } from 'lucide-react'
import type { Example, Charter } from '../types'
import Badge, { SOURCE_COLORS, LABEL_COLORS, REVIEW_COLORS } from './examples/Badge'
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
  onNavigateToScorers?: () => void
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
  onNavigateToScorers,
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

  // Calculate suggested example count and reason
  const getSuggestedGeneration = () => {
    const coverageCriteria = charter.coverage?.criteria?.length || 0
    const alignmentAreas = charter.alignment?.length || 0
    const totalScenarios = Math.max(coverageCriteria * alignmentAreas, 1)

    if (coverageGaps && coverageGaps.uncoveredCount > 0) {
      const countPerGap = 2
      return {
        count: countPerGap,
        reason: `Based on coverage analysis: ${coverageGaps.uncoveredCount} of ${coverageGaps.totalScenarios} scenarios lack examples. Generating ${countPerGap} examples per scenario will help fill these gaps.`
      }
    }

    if (examples.length === 0) {
      return {
        count: 2,
        reason: `Starting fresh: generating 2 examples per scenario (${totalScenarios} scenarios = ~${totalScenarios * 2} examples) provides good initial coverage for your ${alignmentAreas} feature areas × ${coverageCriteria} coverage criteria.`
      }
    }

    const approvedCount = examples.filter(e => e.review_status === 'approved').length
    if (approvedCount < totalScenarios) {
      return {
        count: 2,
        reason: `You have ${approvedCount} approved examples but ${totalScenarios} scenario combinations. Generating more will improve coverage across all feature areas and criteria.`
      }
    }

    return {
      count: 1,
      reason: `You have good coverage (${approvedCount} approved). Generate additional examples to increase diversity or cover edge cases.`
    }
  }

  const { count: suggestedCount, reason: suggestionReason } = getSuggestedGeneration()
  const totalScenarios = Math.max((charter.coverage?.criteria?.length || 0) * (charter.alignment?.length || 0), 1)

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
    if (editingId || deleteConfirmId) {
      if (e.key === 'Escape') setEditingId(null)
      return
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return

    switch (e.key) {
      case 'ArrowUp':
      case 'k':
        e.preventDefault()
        if (selectedIndex > 0) setSelectedId(filtered[selectedIndex - 1].id)
        break
      case 'ArrowDown':
      case 'j':
        e.preventDefault()
        if (selectedIndex < filtered.length - 1) setSelectedId(filtered[selectedIndex + 1].id)
        break
      case 'a': case 'A':
        if (selectedExample) { e.preventDefault(); onUpdateExample(selectedExample.id, { review_status: 'approved' }) }
        break
      case 'e': case 'E':
        if (selectedExample) { e.preventDefault(); setEditingId(selectedExample.id) }
        break
      case 'r': case 'R':
        if (selectedExample) { e.preventDefault(); onUpdateExample(selectedExample.id, { review_status: 'rejected' }) }
        break
      case 'l': case 'L':
        if (selectedExample) { e.preventDefault(); onUpdateExample(selectedExample.id, { label: selectedExample.label === 'good' ? 'bad' : 'good' }) }
        break
      case 'd': case 'D':
        if (selectedExample) { e.preventDefault(); setDeleteConfirmId(selectedExample.id) }
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
      if (selectedIndex < filtered.length - 1) setSelectedId(filtered[selectedIndex + 1].id)
      else if (selectedIndex > 0) setSelectedId(filtered[selectedIndex - 1].id)
      else setSelectedId(null)
    }
  }

  const stats = {
    total: examples.length,
    pending: examples.filter(e => e.review_status === 'pending').length,
    approved: examples.filter(e => e.review_status === 'approved').length,
    rejected: examples.filter(e => e.review_status === 'rejected').length,
  }

  return (
    <div className="h-full flex flex-col" ref={containerRef}>
      {/* Header */}
      <div
        onClick={onHeaderClick}
        className={`h-12 flex items-center justify-between px-4 border-b border-border flex-shrink-0 ${
          isFocused ? '' : 'hover:bg-muted/50 cursor-pointer'
        }`}
      >
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">Golden Dataset</h2>
          <span className="text-xs text-muted-foreground">
            {stats.total} total · {stats.pending} pending · {stats.approved} approved
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onNavigateToScorers && (
            <button
              onClick={(e) => { e.stopPropagation(); onNavigateToScorers(); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:opacity-90 transition-all"
            >
              Set up scorers
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Subheader: filters + actions */}
      <div className="px-4 py-2 border-b border-border flex items-center gap-2 flex-shrink-0 flex-wrap">
        <select value={filterArea} onChange={e => setFilterArea(e.target.value)} className="text-xs px-2 py-1 bg-background border border-border rounded">
          <option value="">All areas</option>
          {featureAreas.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={filterLabel} onChange={e => setFilterLabel(e.target.value)} className="text-xs px-2 py-1 bg-background border border-border rounded">
          <option value="">All labels</option>
          <option value="good">Good</option>
          <option value="bad">Bad</option>
          <option value="unlabeled">Unlabeled</option>
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="text-xs px-2 py-1 bg-background border border-border rounded">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="needs_edit">Needs edit</option>
        </select>

        <div className="ml-auto flex gap-1.5 items-center">
          <button onClick={(e) => { e.stopPropagation(); onShowCoverageMap(); }} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground border border-border rounded transition-colors">
            Coverage map
          </button>
          <button onClick={(e) => { e.stopPropagation(); onExport(); }} disabled={stats.approved === 0} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground border border-border rounded transition-colors disabled:opacity-40">
            Export
          </button>
          <span className="w-px h-4 bg-border mx-0.5" />
          <button onClick={onImport} disabled={loading} className="px-2.5 py-1 text-xs bg-surface-raised border border-border rounded hover:bg-muted transition-colors disabled:opacity-50">
            Import
          </button>
          <button onClick={() => setShowGenerateModal(true)} disabled={loading} className="px-2.5 py-1 text-xs bg-accent text-accent-foreground rounded hover:opacity-90 transition-opacity disabled:opacity-50">
            {loading ? 'Generating...' : 'Generate'}
          </button>
          <button onClick={onAutoReview} disabled={loading || stats.pending === 0} className="px-2.5 py-1 text-xs bg-surface-raised border border-border rounded hover:bg-muted transition-colors disabled:opacity-50">
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

      {/* Table-style example list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && filterStatus === 'pending' && stats.total > 0 ? (
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
                <button onClick={onShowCoverageMap} className="w-full py-2.5 px-4 bg-surface-raised border border-border rounded-lg text-sm font-medium hover:bg-muted transition-colors">
                  Check coverage gaps
                </button>
                <button onClick={() => setShowGenerateModal(true)} disabled={loading} className="w-full py-2.5 px-4 bg-surface-raised border border-border rounded-lg text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50">
                  Generate more examples
                </button>
                <button onClick={onExport} disabled={stats.approved === 0} className="w-full py-2.5 px-4 bg-accent text-accent-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
                  Export dataset ({stats.approved} examples)
                </button>
              </div>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <p className="text-sm mb-2">No examples match filters</p>
            <p className="text-xs">Try adjusting the filters above.</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-raised border-b border-border z-10">
              <tr className="text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium w-36">Scenario</th>
                <th className="px-3 py-2 font-medium w-40">Title & Labels</th>
                <th className="px-3 py-2 font-medium">Input</th>
                <th className="px-3 py-2 font-medium">Expected Output</th>
                <th className="px-3 py-2 font-medium w-32 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(example => (
                <ExampleRow
                  key={example.id}
                  example={example}
                  isSelected={selectedId === example.id}
                  isEditing={editingId === example.id}
                  onSelect={() => setSelectedId(example.id)}
                  onUpdate={fields => onUpdateExample(example.id, fields)}
                  onDelete={() => setDeleteConfirmId(example.id)}
                  onStartEdit={() => setEditingId(example.id)}
                  onCancelEdit={() => setEditingId(null)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {deleteConfirmId && (
        <DeleteModal onConfirm={handleConfirmDelete} onCancel={() => setDeleteConfirmId(null)} />
      )}
      {showGenerateModal && (
        <GenerateModal
          onConfirm={(count) => { onSynthesize(count); setShowGenerateModal(false) }}
          onCancel={() => setShowGenerateModal(false)}
          suggestedCount={suggestedCount}
          suggestionReason={suggestionReason}
          totalScenarios={totalScenarios}
        />
      )}
    </div>
  )
}

/* ── Table row for each example ── */

function ExampleRow({
  example,
  isSelected,
  isEditing,
  onSelect,
  onUpdate,
  onDelete,
  onStartEdit,
  onCancelEdit,
}: {
  example: Example
  isSelected: boolean
  isEditing: boolean
  onSelect: () => void
  onUpdate: (fields: Partial<Example>) => void
  onDelete: () => void
  onStartEdit: () => void
  onCancelEdit: () => void
}) {
  const [editInput, setEditInput] = useState(example.input)
  const [editOutput, setEditOutput] = useState(example.expected_output)
  const rowRef = useRef<HTMLTableRowElement>(null)

  useEffect(() => {
    setEditInput(example.input)
    setEditOutput(example.expected_output)
  }, [example.input, example.expected_output])

  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isSelected])

  const handleSaveEdit = () => {
    onUpdate({ input: editInput, expected_output: editOutput, review_status: 'approved' })
    onCancelEdit()
  }

  if (isEditing) {
    return (
      <tr ref={rowRef} className="bg-accent/5 border-b border-border">
        <td className="px-3 py-2 align-top text-muted-foreground">{example.feature_area}</td>
        <td className="px-3 py-2 align-top">
          <span className="text-foreground font-medium">{example.feature_area}</span>
        </td>
        <td className="px-3 py-2 align-top">
          <textarea
            value={editInput}
            onChange={e => setEditInput(e.target.value)}
            className="w-full p-2 text-xs bg-background border border-border rounded resize-none"
            rows={4}
            onClick={e => e.stopPropagation()}
          />
        </td>
        <td className="px-3 py-2 align-top">
          <textarea
            value={editOutput}
            onChange={e => setEditOutput(e.target.value)}
            className="w-full p-2 text-xs bg-background border border-border rounded resize-none"
            rows={4}
            onClick={e => e.stopPropagation()}
          />
        </td>
        <td className="px-3 py-2 align-top text-right">
          <div className="flex flex-col gap-1 items-end">
            <button onClick={(e) => { e.stopPropagation(); handleSaveEdit() }} className="px-2 py-1 text-xs bg-success text-white rounded hover:opacity-90">
              Save
            </button>
            <button onClick={(e) => { e.stopPropagation(); onCancelEdit() }} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        </td>
      </tr>
    )
  }

  // Truncate text for table display
  const truncate = (text: string, max: number) => text.length > max ? text.slice(0, max) + '…' : text

  return (
    <tr
      ref={rowRef}
      onClick={onSelect}
      className={`border-b border-border cursor-pointer transition-colors ${
        isSelected
          ? 'bg-accent/5 border-l-2 border-l-accent'
          : 'hover:bg-muted/30'
      } ${REVIEW_COLORS[example.review_status] || ''}`}
    >
      {/* Scenario / coverage tags */}
      <td className="px-3 py-2.5 align-top">
        {example.coverage_tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {example.coverage_tags.slice(0, 2).map((tag, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 bg-muted text-muted-foreground rounded">{tag}</span>
            ))}
            {example.coverage_tags.length > 2 && (
              <span className="text-[10px] text-muted-foreground">+{example.coverage_tags.length - 2}</span>
            )}
          </div>
        ) : (
          <span className="text-[10px] text-muted-foreground italic">—</span>
        )}
      </td>

      {/* Title + labels */}
      <td className="px-3 py-2.5 align-top">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground leading-tight">{example.feature_area}</span>
          <div className="flex flex-wrap gap-1">
            <Badge text={example.source} className={SOURCE_COLORS[example.source] || ''} />
            <Badge text={example.label} className={LABEL_COLORS[example.label] || ''} />
            {example.review_status !== 'pending' && (
              <Badge text={example.review_status} className="bg-muted text-muted-foreground" />
            )}
          </div>
        </div>
      </td>

      {/* Input */}
      <td className="px-3 py-2.5 align-top">
        <div className="text-xs text-foreground/80 leading-relaxed line-clamp-3">
          {truncate(example.input, 200)}
        </div>
      </td>

      {/* Expected output */}
      <td className="px-3 py-2.5 align-top">
        <div className="text-xs text-foreground/80 leading-relaxed line-clamp-3">
          {truncate(example.expected_output, 200)}
        </div>
      </td>

      {/* Actions */}
      <td className="px-3 py-2.5 align-top text-right">
        {isSelected && (
          <div className="flex gap-1 justify-end flex-wrap">
            <button onClick={(e) => { e.stopPropagation(); onUpdate({ review_status: 'approved' }) }} className="px-1.5 py-0.5 text-[10px] text-success hover:bg-success/10 rounded transition-colors">
              Approve
            </button>
            <button onClick={(e) => { e.stopPropagation(); onStartEdit() }} className="px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10 rounded transition-colors">
              Edit
            </button>
            <button onClick={(e) => { e.stopPropagation(); onUpdate({ review_status: 'rejected' }) }} className="px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/10 rounded transition-colors">
              Reject
            </button>
            <button onClick={(e) => { e.stopPropagation(); onDelete() }} className="px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-danger rounded transition-colors">
              Delete
            </button>
          </div>
        )}
      </td>
    </tr>
  )
}
