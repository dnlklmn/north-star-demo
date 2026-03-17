import { useState } from 'react'
import type { Example, Charter } from '../types'

interface ExampleReviewProps {
  examples: Example[]
  charter: Charter
  loading: boolean
  onUpdateExample: (exampleId: string, fields: Partial<Example>) => void
  onDeleteExample: (exampleId: string) => void
  onImport: () => void
  onSynthesize: () => void
  onAutoReview: () => void
  onExport: () => void
  onShowCoverageMap: () => void
  onHeaderClick?: () => void
  isFocused?: boolean
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

function ExampleCard({
  example,
  onUpdate,
  onDelete,
}: {
  example: Example
  onUpdate: (fields: Partial<Example>) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [editInput, setEditInput] = useState(example.input)
  const [editOutput, setEditOutput] = useState(example.expected_output)

  const handleSaveEdit = () => {
    onUpdate({ input: editInput, expected_output: editOutput, review_status: 'approved' })
    setEditing(false)
  }

  const handleCancelEdit = () => {
    setEditInput(example.input)
    setEditOutput(example.expected_output)
    setEditing(false)
  }

  const verdict = example.judge_verdict

  return (
    <div className={`border border-border rounded-lg bg-surface p-3 border-l-3 ${REVIEW_COLORS[example.review_status] || ''}`}>
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
      {editing ? (
        <div className="space-y-2">
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Input</label>
            <textarea
              value={editInput}
              onChange={e => setEditInput(e.target.value)}
              className="w-full mt-0.5 p-2 text-xs bg-background border border-border rounded resize-none"
              rows={3}
            />
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Expected output</label>
            <textarea
              value={editOutput}
              onChange={e => setEditOutput(e.target.value)}
              className="w-full mt-0.5 p-2 text-xs bg-background border border-border rounded resize-none"
              rows={4}
            />
          </div>
          <div className="flex gap-1.5">
            <button onClick={handleSaveEdit} className="px-2 py-1 text-xs bg-success text-white rounded hover:opacity-90">
              Save & approve
            </button>
            <button onClick={handleCancelEdit} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-2">
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-0.5">Input</div>
            <div className="text-xs text-foreground leading-relaxed">{example.input}</div>
          </div>
          <div className="mb-2">
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-0.5">Expected output</div>
            <div className="text-xs text-foreground leading-relaxed">{example.expected_output}</div>
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

          {/* Actions */}
          <div className="flex gap-1.5 pt-1 border-t border-border">
            <button
              onClick={() => onUpdate({ review_status: 'approved' })}
              className="px-2 py-1 text-xs text-success hover:bg-success/10 rounded transition-colors"
            >
              Approve
            </button>
            <button
              onClick={() => setEditing(true)}
              className="px-2 py-1 text-xs text-accent hover:bg-accent/10 rounded transition-colors"
            >
              Edit
            </button>
            <button
              onClick={() => onUpdate({ review_status: 'rejected' })}
              className="px-2 py-1 text-xs text-danger hover:bg-danger/10 rounded transition-colors"
            >
              Reject
            </button>
            <button
              onClick={() => onUpdate({ label: example.label === 'good' ? 'bad' : 'good' })}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded transition-colors"
            >
              Relabel
            </button>
            <button
              onClick={onDelete}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-danger rounded transition-colors ml-auto"
            >
              Delete
            </button>
          </div>
        </>
      )}
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
}: ExampleReviewProps) {
  const [filterArea, setFilterArea] = useState<string>('')
  const [filterLabel, setFilterLabel] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<string>('')

  const featureAreas = charter.alignment.map(a => a.feature_area)

  const filtered = examples.filter(ex => {
    if (filterArea && ex.feature_area !== filterArea) return false
    if (filterLabel && ex.label !== filterLabel) return false
    if (filterStatus && ex.review_status !== filterStatus) return false
    return true
  })

  const stats = {
    total: examples.length,
    pending: examples.filter(e => e.review_status === 'pending').length,
    approved: examples.filter(e => e.review_status === 'approved').length,
    rejected: examples.filter(e => e.review_status === 'rejected').length,
  }

  return (
    <div className="h-full flex flex-col">
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
            onClick={onSynthesize}
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

      {/* Example list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <p className="text-sm mb-2">No examples yet</p>
            <p className="text-xs">Import existing data or generate examples from your charter.</p>
          </div>
        ) : (
          filtered.map(example => (
            <ExampleCard
              key={example.id}
              example={example}
              onUpdate={fields => onUpdateExample(example.id, fields)}
              onDelete={() => onDeleteExample(example.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}
