import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import Button from './ui/Button'
import { listSamples, type SampleInfo } from '../api'

interface NewSkillEvalModalProps {
  isOpen: boolean
  isLoading?: boolean
  onClose: () => void
  onAnalyze: (input: string) => void
  onLoadSample?: (sampleId: string) => void
  loadingSampleId?: string | null
}

export default function NewSkillEvalModal({
  isOpen,
  isLoading,
  onClose,
  onAnalyze,
  onLoadSample,
  loadingSampleId,
}: NewSkillEvalModalProps) {
  const [skillInput, setSkillInput] = useState('')
  const [samples, setSamples] = useState<SampleInfo[] | null>(null)
  // Reset the input every time the modal opens. Track previous open-state and
  // clear during render rather than via setState-in-effect.
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen)
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen)
    if (isOpen) setSkillInput('')
  }

  // Fetch the sample list once on first open. The list is fixture metadata —
  // small, cacheable, no auth — so swallow errors silently rather than block
  // the paste flow when /samples is unreachable.
  useEffect(() => {
    if (!isOpen || samples !== null) return
    let cancelled = false
    listSamples()
      .then(list => {
        if (!cancelled) setSamples(list)
      })
      .catch(() => {
        if (!cancelled) setSamples([])
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, samples])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        onAnalyze(skillInput)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose, onAnalyze, skillInput])

  if (!isOpen) return null

  const showSamples = onLoadSample && samples && samples.length > 0
  const anySampleLoading = Boolean(loadingSampleId)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-raised border border-border p-6 max-w-3xl w-full mx-4 shadow-lg flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-foreground mb-4">Skill</h3>

        {showSamples && (
          <div className="mb-6">
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
              Start from a sample
            </div>
            <div className="grid grid-cols-2 gap-2">
              {samples.map(sample => {
                const thisLoading = loadingSampleId === sample.id
                return (
                  <button
                    key={sample.id}
                    type="button"
                    onClick={() => onLoadSample?.(sample.id)}
                    disabled={isLoading || anySampleLoading}
                    className="text-left p-3 bg-background border border-border hover:border-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground mb-1">
                      {thisLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                      {sample.name}
                    </div>
                    <div className="text-xs text-muted-foreground leading-snug">
                      {sample.blurb}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <textarea
          value={skillInput}
          onChange={e => setSkillInput(e.target.value)}
          placeholder="Paste a Github link or the SKILL.md (with or without frontmatter), or start writing your own skill."
          className="w-full h-72 p-4 text-sm bg-background border border-border focus:outline-none focus:ring-1 focus:ring-accent resize-y mb-6 text-foreground placeholder:text-muted-foreground"
          autoFocus
        />
        <Button
          size="big"
          variant="primary"
          className="w-full"
          onClick={() => onAnalyze(skillInput)}
          shortcut={<span className="text-xs">⌘↵</span>}
          disabled={isLoading || anySampleLoading}
        >
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Analyze
        </Button>
      </div>
    </div>
  )
}
