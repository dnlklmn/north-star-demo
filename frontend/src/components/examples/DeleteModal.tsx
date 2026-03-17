import { useEffect } from 'react'

interface DeleteModalProps {
  onConfirm: () => void
  onCancel: () => void
}

export default function DeleteModal({ onConfirm, onCancel }: DeleteModalProps) {
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
