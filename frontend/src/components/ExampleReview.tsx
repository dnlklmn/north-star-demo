import { useState, useEffect, useRef, useCallback } from 'react'
import type { Example, Charter } from '../types'

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

const SOURCE_COLORS: Record<string, string> = {
  imported: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  synthetic: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  manual: 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300',
}

const LABEL_COLORS: Record<string, string> = {
  good: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  bad: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  unlabeled: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
}

const REVIEW_COLORS: Record<string, string> = {
  pending: 'border-l-yellow-400',
  approved: 'border-l-green-400',
  rejected: 'border-l-red-400',
  needs_edit: 'border-l-orange-400',
}

function Badge({ text, className }: { text: string; className: string }) {
  return (
    <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded ${className}`}>
      {text}
    </span>
  )
}

// Format text with better structure: line breaks, lists, paragraphs
function formatWithLineBreaks(text: string): React.ReactNode {
  // First split by double newlines (paragraphs)
  const paragraphs = text.split(/\n\n+/)

  return paragraphs.map((para, pIdx) => {
    // Check if this paragraph is a list
    const lines = para.split(/\n/)
    const isList = lines.every(line =>
      /^[\s]*[-•*]/.test(line) || /^[\s]*\d+[.)]/.test(line) || line.trim() === ''
    )

    if (isList && lines.length > 1) {
      // Render as list
      return (
        <div key={pIdx} className="my-2">
          {lines.filter(l => l.trim()).map((line, lIdx) => (
            <div key={lIdx} className="pl-2 py-0.5">
              {line.trim()}
            </div>
          ))}
        </div>
      )
    }

    // For regular text, split on sentences
    const sentences = para.split(/(?<=[.!?])\s+/)

    return (
      <div key={pIdx} className={pIdx > 0 ? 'mt-3' : ''}>
        {sentences.map((sentence, sIdx) => (
          <span key={sIdx}>
            {sentence.trim()}
            {sIdx < sentences.length - 1 && (
              <>
                <br />
              </>
            )}
          </span>
        ))}
      </div>
    )
  })
}

// Underline component for keyboard shortcut hints
function KeyHint({ children }: { children: string }) {
  const first = children[0]
  const rest = children.slice(1)
  return (
    <>
      <span className="underline">{first}</span>{rest}
    </>
  )
}

function ExampleCard({
  example,
  isSelected,
  onSelect,
  onUpdate,
  onDelete,
  onStartEdit,
  isEditing,
  onCancelEdit,
}: {
  example: Example
  isSelected: boolean
  onSelect: () => void
  onUpdate: (fields: Partial<Example>) => void
  onDelete: () => void
  onStartEdit: () => void
  isEditing: boolean
  onCancelEdit: () => void
}) {
  const [editInput, setEditInput] = useState(example.input)
  const [editOutput, setEditOutput] = useState(example.expected_output)
  const cardRef = useRef<HTMLDivElement>(null)

  // Reset edit state when example changes
  useEffect(() => {
    setEditInput(example.input)
    setEditOutput(example.expected_output)
  }, [example.input, example.expected_output])

  // Scroll into view when selected
  useEffect(() => {
    if (isSelected && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isSelected])

  const handleSaveEdit = () => {
    onUpdate({ input: editInput, expected_output: editOutput, review_status: 'approved' })
    onCancelEdit()
  }

  const handleCancelEdit = () => {
    setEditInput(example.input)
    setEditOutput(example.expected_output)
    onCancelEdit()
  }

  const verdict = example.judge_verdict

  return (
    <div
      ref={cardRef}
      onClick={onSelect}
      className={`border rounded-lg bg-surface p-3 border-l-3 cursor-pointer transition-all ${
        REVIEW_COLORS[example.review_status] || ''
      } ${
        isSelected
          ? 'border-accent ring-1 ring-accent'
          : 'border-border hover:border-muted-foreground/50'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
        <span className="text-xs font-medium text-foreground">{example.feature_area}</span>
        <Badge text={example.source} className={SOURCE_COLORS[example.source] || ''} />
        <Badge text={example.label} className={LABEL_COLORS[example.label] || ''} />
        {example.review_status !== 'pending' && (
          <Badge
            text={example.review_status}
            className="bg-muted text-muted-foreground"
          />
        )}
        {verdict && (
          <Badge
            text={`judge: ${verdict.suggested_label} (${verdict.confidence})`}
            className={verdict.confidence === 'high'
              ? 'bg-accent/10 text-accent'
              : 'bg-warning/10 text-warning'}
          />
        )}
      </div>

      {/* Content */}
      {isEditing ? (
        <div className="space-y-2">
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Input</label>
            <textarea
              value={editInput}
              onChange={e => setEditInput(e.target.value)}
              className="w-full mt-0.5 p-2 text-xs bg-background border border-border rounded resize-none"
              rows={3}
              onClick={e => e.stopPropagation()}
            />
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Expected output</label>
            <textarea
              value={editOutput}
              onChange={e => setEditOutput(e.target.value)}
              className="w-full mt-0.5 p-2 text-xs bg-background border border-border rounded resize-none"
              rows={4}
              onClick={e => e.stopPropagation()}
            />
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={(e) => { e.stopPropagation(); handleSaveEdit(); }}
              className="px-2 py-1 text-xs bg-success text-white rounded hover:opacity-90"
            >
              Save & approve
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); handleCancelEdit(); }}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel (Esc)
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-3 pb-3 border-b border-border/50">
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Input</div>
            <div className="text-xs text-foreground leading-relaxed bg-muted/30 rounded p-2">
              {formatWithLineBreaks(example.input)}
            </div>
          </div>
          <div className="mb-3">
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Expected output</div>
            <div className="text-xs text-foreground leading-relaxed bg-muted/30 rounded p-2">
              {formatWithLineBreaks(example.expected_output)}
            </div>
          </div>

          {/* Judge reasoning */}
          {verdict?.reasoning && (
            <div className="mb-2 p-2 bg-muted rounded text-[11px] text-muted-foreground">
              <span className="font-medium">Judge:</span> {verdict.reasoning}
              {verdict.issues?.length > 0 && (
                <div className="mt-1">
                  {verdict.issues.map((issue, i) => (
                    <div key={i} className="text-warning">- {issue}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Coverage tags */}
          {example.coverage_tags.length > 0 && (
            <div className="flex gap-1 flex-wrap mb-2">
              {example.coverage_tags.map((tag, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 bg-muted text-muted-foreground rounded">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Actions - only show when selected */}
          {isSelected && (
            <div className="flex gap-1.5 pt-2 border-t border-border">
              <button
                onClick={(e) => { e.stopPropagation(); onUpdate({ review_status: 'approved' }); }}
                className="px-2 py-1 text-xs text-success hover:bg-success/10 rounded transition-colors"
              >
                <KeyHint>Approve</KeyHint>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
                className="px-2 py-1 text-xs text-accent hover:bg-accent/10 rounded transition-colors"
              >
                <KeyHint>Edit</KeyHint>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onUpdate({ review_status: 'rejected' }); }}
                className="px-2 py-1 text-xs text-danger hover:bg-danger/10 rounded transition-colors"
              >
                <KeyHint>Reject</KeyHint>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onUpdate({ label: example.label === 'good' ? 'bad' : 'good' }); }}
                className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded transition-colors"
              >
                Re<span className="underline">l</span>abel
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="px-2 py-1 text-xs text-muted-foreground hover:text-danger rounded transition-colors ml-auto"
              >
                <KeyHint>Delete</KeyHint>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Delete confirmation modal
function DeleteModal({
  onConfirm,
  onCancel
}: {
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
      } else if (e.key === 'Enter' || e.key === 'd' || e.key === 'D') {
        onConfirm()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onConfirm, onCancel])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onCancel}>
      <div
        className="bg-surface-raised border border-border rounded-lg p-4 max-w-sm mx-4 shadow-lg"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-foreground mb-2">Delete example?</h3>
        <p className="text-xs text-muted-foreground mb-4">
          This action cannot be undone.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded transition-colors"
          >
            Cancel (Esc)
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs bg-danger text-white rounded hover:opacity-90 transition-opacity"
          >
            Delete (Enter)
          </button>
        </div>
      </div>
    </div>
  )
}

// Generate examples modal
function GenerateModal({
  onConfirm,
  onCancel,
  suggestedCount,
  suggestionReason,
}: {
  onConfirm: (count: number) => void
  onCancel: () => void
  suggestedCount: number
  suggestionReason: string
}) {
  const [count, setCount] = useState(suggestedCount)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        onConfirm(count)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onConfirm, onCancel, count])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onCancel}>
      <div
        className="bg-surface-raised border border-border rounded-lg p-5 max-w-md mx-4 shadow-lg"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-foreground mb-4">Generate examples</h3>

        <div className="mb-4">
          <label className="text-xs font-medium text-muted-foreground block mb-1.5">
            Number of examples per scenario
          </label>
          <input
            type="number"
            min={1}
            max={20}
            value={count}
            onChange={e => setCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-accent"
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
            {suggestionReason}
          </p>
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(count)}
            className="px-4 py-1.5 text-xs bg-accent text-accent-foreground rounded hover:opacity-90 transition-opacity"
          >
            Generate
          </button>
        </div>
      </div>
    </div>
  )
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
      case 'k': // vim-style
        e.preventDefault()
        if (selectedIndex > 0) {
          setSelectedId(filtered[selectedIndex - 1].id)
        }
        break
      case 'ArrowDown':
      case 'j': // vim-style
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
            onClick={() => setShowGenerateModal(true)}
            disabled={loading}
            className="px-2.5 py-1 text-xs bg-accent text-accent-foreground rounded hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading ? 'Generating...' : 'Generate'}
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
            <p className="text-sm mb-2">No examples yet</p>
            <p className="text-xs">Import existing data or generate examples from your charter.</p>
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
        />
      )}
    </div>
  )
}
