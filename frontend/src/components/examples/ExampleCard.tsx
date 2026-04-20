import { useState, useEffect, useRef } from 'react'
import type { Example } from '../../types'
import Badge, { SOURCE_COLORS, LABEL_COLORS, REVIEW_COLORS } from './Badge'
import { formatWithLineBreaks, KeyHint } from '../../lib/formatters'

interface ExampleCardProps {
  example: Example
  isSelected: boolean
  onSelect: () => void
  onUpdate: (fields: Partial<Example>) => void
  onDelete: () => void
  onStartEdit: () => void
  isEditing: boolean
  onCancelEdit: () => void
}

export default function ExampleCard({
  example,
  isSelected,
  onSelect,
  onUpdate,
  onDelete,
  onStartEdit,
  isEditing,
  onCancelEdit,
}: ExampleCardProps) {
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
      className={`border bg-surface p-3 border-l-3 cursor-pointer transition-all ${
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
              className="w-full mt-0.5 p-2 text-xs bg-background border border-border resize-none"
              rows={3}
              onClick={e => e.stopPropagation()}
            />
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Expected output</label>
            <textarea
              value={editOutput}
              onChange={e => setEditOutput(e.target.value)}
              className="w-full mt-0.5 p-2 text-xs bg-background border border-border resize-none"
              rows={4}
              onClick={e => e.stopPropagation()}
            />
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={(e) => { e.stopPropagation(); handleSaveEdit(); }}
              className="px-2 py-1 text-xs bg-success text-white hover:opacity-90"
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
            <div className="text-xs text-foreground leading-relaxed bg-muted/30 p-2">
              {formatWithLineBreaks(example.input)}
            </div>
          </div>
          <div className="mb-3">
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Expected output</div>
            <div className="text-xs text-foreground leading-relaxed bg-muted/30 p-2">
              {formatWithLineBreaks(example.expected_output)}
            </div>
          </div>

          {/* Judge reasoning */}
          {verdict?.reasoning && (
            <div className="mb-2 p-2 bg-muted text-[11px] text-muted-foreground">
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
                <span key={i} className="text-[10px] px-1.5 py-0.5 bg-muted text-muted-foreground">
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
                className="px-2 py-1 text-xs text-success hover:bg-success/10 transition-colors"
              >
                <KeyHint>Approve</KeyHint>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
                className="px-2 py-1 text-xs text-accent hover:bg-accent/10 transition-colors"
              >
                <KeyHint>Edit</KeyHint>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onUpdate({ review_status: 'rejected' }); }}
                className="px-2 py-1 text-xs text-danger hover:bg-danger/10 transition-colors"
              >
                <KeyHint>Reject</KeyHint>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onUpdate({ label: example.label === 'good' ? 'bad' : 'good' }); }}
                className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Re<span className="underline">l</span>abel
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="px-2 py-1 text-xs text-muted-foreground hover:text-danger transition-colors ml-auto"
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
