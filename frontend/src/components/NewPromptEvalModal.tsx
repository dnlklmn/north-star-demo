import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import Button from './ui/Button'
import { listPromptTargets, type PromptTargetInfo } from '../api'

interface NewPromptEvalModalProps {
  isOpen: boolean
  isLoading?: boolean
  onClose: () => void
  /** target identifies which builder to replay at eval time (still required
   *  even when the user edits the body — the eval task uses target, not body).
   *  body is the (optionally edited) prompt text fed to the seed pass. */
  onCreate: (target: string, sampleSize: number, body: string) => void
}

/**
 * Create a prompt-eval session. The user sees the prompt text under
 * evaluation pre-filled in a textarea — they can review or tweak before
 * hitting Create. Tweaking changes what the seed pass extracts (goals/users/
 * stories/charter) but not what runs at eval time; that's the registered
 * prompt builder, identified by `target`.
 */
export default function NewPromptEvalModal({
  isOpen,
  isLoading,
  onClose,
  onCreate,
}: NewPromptEvalModalProps) {
  const [targets, setTargets] = useState<PromptTargetInfo[]>([])
  const [body, setBody] = useState<string>('')
  const [sampleSize, setSampleSize] = useState<number>(30)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setLoadError(null)
    setBody('')
    listPromptTargets()
      .then((list) => {
        setTargets(list)
        if (list[0]?.prompt_text) {
          setBody(list[0].prompt_text)
        }
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load'))
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        const target = targets[0]?.target
        if (target && body.trim()) onCreate(target, sampleSize, body)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose, onCreate, targets, sampleSize, body])

  if (!isOpen) return null

  const target = targets[0]
  const canSubmit = !!target && body.trim().length > 0 && !isLoading

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface-raised border border-border p-6 max-w-3xl w-full mx-4 shadow-lg flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-foreground mb-2">Prompt eval</h3>
        <p className="text-sm text-muted-foreground mb-5">
          Evaluate one of North Star's own prompts against historical turns. Inputs
          are sampled from the <code className="font-mono text-xs">turns</code> table; the
          chosen prompt is re-run on each, and reference-free scorers grade the output.
        </p>

        {target && (
          <div className="text-xs text-muted-foreground mb-2 flex items-center gap-2 flex-wrap">
            <span className="text-foreground font-medium">{target.label}</span>
            {target.builder_name && (
              <code className="font-mono">{target.builder_name}</code>
            )}
            {target.source_path && (
              <span className="text-muted-foreground/70">· {target.source_path}</span>
            )}
          </div>
        )}

        <label className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
          Prompt template
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={loadError ? `Error: ${loadError}` : 'Loading prompt template…'}
          className="w-full h-72 p-3 text-xs bg-background border border-border focus:outline-none focus:ring-1 focus:ring-accent resize-y mb-2 font-mono text-foreground placeholder:text-muted-foreground"
          autoFocus
          disabled={!targets.length}
        />
        <p className="text-xs text-muted-foreground mb-5">
          Pre-filled with the prompt under test. Edits here change what the seed pass
          reads — they do <em>not</em> change what runs at eval time. To change the
          actual prompt, edit{' '}
          {target?.source_path ? (
            <code className="font-mono">{target.source_path}</code>
          ) : (
            <code className="font-mono">backend/app/prompt.py</code>
          )}
          .
        </p>

        <label className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
          Sample size
        </label>
        <input
          type="number"
          min={1}
          max={200}
          value={sampleSize}
          onChange={(e) => setSampleSize(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
          className="w-full p-3 text-sm bg-background border border-border focus:outline-none focus:ring-1 focus:ring-accent text-foreground mb-6"
        />

        <Button
          size="big"
          variant="primary"
          className="w-full"
          onClick={() => target && onCreate(target.target, sampleSize, body)}
          shortcut={<span className="text-xs">⌘↵</span>}
          disabled={!canSubmit}
        >
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Create
        </Button>
      </div>
    </div>
  )
}
