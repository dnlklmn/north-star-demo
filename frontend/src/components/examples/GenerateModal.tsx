import { useState, useEffect } from 'react'

interface GenerateModalProps {
  onConfirm: (count: number) => void
  onCancel: () => void
  suggestedCount: number
  suggestionReason: string
}

export default function GenerateModal({
  onConfirm,
  onCancel,
  suggestedCount,
  suggestionReason,
}: GenerateModalProps) {
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
