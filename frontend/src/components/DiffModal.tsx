import { X } from 'lucide-react'
import { diffLines, diffStats } from '../lib/textDiff'

interface Props {
  title: string
  subtitle?: string
  oldLabel: string
  newLabel: string
  oldText: string
  newText: string
  onClose: () => void
}

/**
 * Full-screen modal showing a line-level diff between two SKILL.md bodies.
 * Used for:
 *   - previewing a proposed improvement before accepting
 *   - comparing two saved skill versions in the history list
 */
export default function DiffModal({
  title,
  subtitle,
  oldLabel,
  newLabel,
  oldText,
  newText,
  onClose,
}: Props) {
  const ops = diffLines(oldText, newText)
  const stats = diffStats(ops)

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg-default max-w-5xl w-full max-h-[90vh] flex flex-col border border-border shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground truncate">{title}</h2>
            {subtitle && (
              <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
            )}
          </div>
          <div className="flex items-center gap-3 flex-shrink-0 ml-3">
            <span className="text-xs font-mono">
              <span className="text-success">+{stats.added}</span>{' '}
              <span className="text-danger">−{stats.removed}</span>
            </span>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-4 py-2 bg-muted/30 border-b border-border text-[11px] font-mono text-muted-foreground flex gap-4 flex-shrink-0">
          <span>− {oldLabel}</span>
          <span>+ {newLabel}</span>
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs font-mono">
            <tbody>
              {ops.map((op, i) => {
                const bg =
                  op.kind === 'added'
                    ? 'bg-success/8'
                    : op.kind === 'removed'
                      ? 'bg-danger/8'
                      : ''
                const marker =
                  op.kind === 'added' ? '+' : op.kind === 'removed' ? '−' : ' '
                const markerColor =
                  op.kind === 'added'
                    ? 'text-success'
                    : op.kind === 'removed'
                      ? 'text-danger'
                      : 'text-muted-foreground/40'
                return (
                  <tr key={i} className={bg}>
                    <td className="w-10 text-right pr-2 text-muted-foreground/60 select-none">
                      {op.oldLineNumber ?? ''}
                    </td>
                    <td className="w-10 text-right pr-2 text-muted-foreground/60 select-none">
                      {op.newLineNumber ?? ''}
                    </td>
                    <td className={`w-4 text-center ${markerColor} select-none`}>{marker}</td>
                    <td className="whitespace-pre-wrap break-words pr-4 py-0.5 text-foreground">
                      {op.text || '\u00A0'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
