import { useState, useRef, type ReactNode } from 'react'
import { ChevronRight, X } from 'lucide-react'

interface Props {
  title: string
  subtitle?: string
  badge?: string
  badgeVariant?: 'success' | 'warning' | 'danger' | 'muted'
  defaultExpanded?: boolean
  onRemove?: () => void
  onTitleChange?: (title: string) => void
  children: ReactNode
}

export default function Section({
  title,
  subtitle,
  badge,
  badgeVariant = 'muted',
  defaultExpanded = true,
  onRemove,
  onTitleChange,
  children,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const badgeColors = {
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
    muted: 'text-muted-foreground',
  }

  const startEditing = () => {
    if (!onTitleChange) return
    setEditing(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const stopEditing = () => {
    setEditing(false)
  }

  return (
    <div className="border border-border bg-surface-raised">
      <div className="flex items-center">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-shrink-0 p-3 hover:bg-muted/50 transition-colors"
        >
          <ChevronRight
            className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
        <div className="flex-1 flex items-center justify-between py-3 pr-3 min-w-0">
          <div className="min-w-0">
            {editing ? (
              <input
                ref={inputRef}
                type="text"
                value={title}
                onChange={e => onTitleChange?.(e.target.value)}
                onBlur={stopEditing}
                onKeyDown={e => { if (e.key === 'Enter') stopEditing() }}
                className="text-sm font-medium text-foreground bg-transparent border-b border-accent outline-none w-full"
              />
            ) : (
              <h3
                className={`text-sm font-medium text-foreground text-left ${onTitleChange ? 'cursor-text hover:text-accent transition-colors' : ''}`}
                onClick={e => { if (onTitleChange) { e.stopPropagation(); startEditing() } }}
              >
                {title}
              </h3>
            )}
            {subtitle && !editing && <p className="text-xs text-muted-foreground text-left">{subtitle}</p>}
          </div>
          {badge && (
            <span className={`text-xs ${badgeColors[badgeVariant]}`}>{badge}</span>
          )}
        </div>
        {onRemove && (
          <button
            onClick={onRemove}
            className="text-muted-foreground hover:text-danger p-2 mr-1 opacity-0 hover:opacity-100 transition-opacity"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {expanded && (
        <div className="px-3 pb-3">
          {children}
        </div>
      )}
    </div>
  )
}
