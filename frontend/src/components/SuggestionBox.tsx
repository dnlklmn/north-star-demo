import type { ReactNode } from 'react'
import { Sparkles, Loader2, RefreshCw } from 'lucide-react'

/* ── SuggestionCard ── */

interface CardProps {
  onAccept: () => void
  onDismiss: () => void
  children: ReactNode
}

export function SuggestionCard({ onAccept, onDismiss, children }: CardProps) {
  return (
    <div className="py-1.5 px-2.5 bg-accent/5 border border-accent/20 rounded-lg">
      <div className="text-sm text-foreground">{children}</div>
      <div className="flex gap-1 mt-1">
        <button
          onClick={onAccept}
          className="text-xs px-2 py-0.5 bg-accent/20 text-accent rounded hover:bg-accent/30 font-medium"
        >
          Add
        </button>
        <button
          onClick={onDismiss}
          className="text-xs px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
        >
          dismiss
        </button>
      </div>
    </div>
  )
}

/* ── SuggestionBox ── */

interface BoxProps {
  label?: string
  onRefresh?: () => void
  loading?: boolean
  emptyText?: string
  children?: ReactNode
}

export default function SuggestionBox({
  label = 'Suggestions',
  onRefresh,
  loading,
  emptyText,
  children,
}: BoxProps) {
  const hasContent = !!children
  return (
    <div className="bg-surface-raised border border-border rounded-lg shadow-sm p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <Sparkles className={`w-3.5 h-3.5 ${hasContent || loading ? 'text-accent' : 'text-muted-foreground/40'}`} />
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
        </div>
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={loading}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          </button>
        )}
      </div>
      {hasContent ? (
        <div className="space-y-1.5">{children}</div>
      ) : loading ? (
        <div className="py-3 text-center">
          <Loader2 className="w-4 h-4 text-muted-foreground animate-spin mx-auto mb-2" />
          <p className="text-xs text-muted-foreground">Generating...</p>
        </div>
      ) : emptyText ? (
        <p className="text-xs text-muted-foreground/60 py-3 text-center">{emptyText}</p>
      ) : null}
    </div>
  )
}
