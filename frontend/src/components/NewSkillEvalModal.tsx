import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import Button from './ui/Button'

interface NewSkillEvalModalProps {
  isOpen: boolean
  isLoading?: boolean
  onClose: () => void
  onAnalyze: (input: string) => void
}

export default function NewSkillEvalModal({ isOpen, isLoading, onClose, onAnalyze }: NewSkillEvalModalProps) {
  const [skillInput, setSkillInput] = useState('')

  useEffect(() => {
    if (isOpen) {
      setSkillInput('')
    }
  }, [isOpen])

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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-raised border border-border p-6 max-w-3xl w-full mx-4 shadow-lg flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-foreground mb-4">Skill</h3>
        <textarea
          value={skillInput}
          onChange={e => setSkillInput(e.target.value)}
          placeholder="Paste a Github link or the SKILL.md (with or without frontmatter), or start writing your own skill."
          className="w-full h-96 p-4 text-sm bg-background border border-border focus:outline-none focus:ring-1 focus:ring-accent resize-y mb-6 text-foreground placeholder:text-muted-foreground"
          autoFocus
        />
        <Button
          size="big"
          variant="primary"
          className="w-full"
          onClick={() => onAnalyze(skillInput)}
          shortcut={<span className="text-xs">⌘↵</span>}
          disabled={isLoading}
        >
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Analyze
        </Button>
      </div>
    </div>
  )
}
