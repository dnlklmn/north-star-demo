import { useState } from 'react'
import { Sparkles, ChevronRight, Copy, Download, Loader2, ArrowRight } from 'lucide-react'
import type { Charter, ScorerDef } from '../types'
import { generateScorers } from '../api'
import { AIIcon } from './ui/Icons'

interface Props {
  charter: Charter
  hasDataset: boolean
  sessionId: string
  scorers?: ScorerDef[]
  onScorersChange?: (scorers: ScorerDef[]) => void
  onNavigateToEvaluate?: () => void
  /** Set true while a parent-driven shortcut is generating scorers (e.g. the
   *  charter page kicked off `Generate dataset and scorers`). The empty-state
   *  spinner picks this up so the user sees feedback when they land here. */
  externalGenerating?: boolean
}

export default function ScorersPanel({ charter, hasDataset: _hasDataset, sessionId, scorers: externalScorers, onScorersChange, onNavigateToEvaluate, externalGenerating }: Props) {
  const [localScorers, setLocalScorers] = useState<ScorerDef[]>([])
  const scorers = externalScorers ?? localScorers
  const setScorers = (s: ScorerDef[]) => {
    setLocalScorers(s)
    onScorersChange?.(s)
  }
  const [generatingLocal, setGenerating] = useState(false)
  const generating = generatingLocal || !!externalGenerating
  const [expandedScorer, setExpandedScorer] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const hasCriteria = charter.coverage.criteria.length > 0
    || charter.balance.criteria.length > 0
    || charter.alignment.length > 0
    || charter.rot.criteria.length > 0

  const handleGenerate = async () => {
    // If scorers exist, regeneration replaces the code — confirm so manual
    // edits to a scorer body aren't lost to an accidental click.
    if (scorers.length > 0) {
      const ok = window.confirm(
        "Regenerate scorers?\n\nThis replaces the current scorer code — any manual edits will be lost.",
      )
      if (!ok) return
    }
    setGenerating(true)
    setError(null)
    try {
      const result = await generateScorers(sessionId)
      setScorers(result.scorers)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate scorers')
    } finally {
      setGenerating(false)
    }
  }

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code)
  }

  const handleDownloadAll = () => {
    const allCode = scorers.map(s => `# ${s.name}\n# ${s.description}\n${s.code}`).join('\n\n')
    const blob = new Blob([allCode], { type: 'text/python' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'scorers.py'
    a.click()
    URL.revokeObjectURL(url)
  }

  const typeColors: Record<string, string> = {
    coverage: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    alignment: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    balance: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    rot: 'bg-red-500/10 text-red-400 border-red-500/20',
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header bar — hidden in the idle/empty state so the page mirrors the
          fresh dataset page (centered title + single CTA, no chrome). */}
      {scorers.length > 0 && (
        <div className="px-4 h-12 border-b border-border bg-surface-raised flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-foreground">Scorers</h2>
            <span className="text-xs text-muted-foreground">{scorers.length} scorers</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDownloadAll}
              className="px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border transition-colors flex items-center gap-1"
            >
              <Download className="w-3 h-3" />
              Download all
            </button>
            <button
              onClick={handleGenerate}
              disabled={!hasCriteria || generating}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {generating ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles className="w-3 h-3" />
                  Regenerate
                </>
              )}
            </button>
            {onNavigateToEvaluate && (
              <button
                onClick={onNavigateToEvaluate}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-accent-foreground hover:opacity-90 transition-all"
              >
                Evaluate
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 p-3 bg-danger/10 border border-danger/20 text-xs text-danger">
            {error}
          </div>
        )}
        {scorers.length === 0 ? (
          // Idle/empty layout mirrors the dataset page so the two screens
          // feel like the same step: centered title + subtitle + a single
          // primary action.
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-6 max-w-md text-center">
              <div>
                <h2 className="text-xl font-semibold text-fg-contrast mb-1">
                  Generate your scorers
                </h2>
                <p className="text-sm text-fg-dim">
                  Generate scorers based on your charter.
                </p>
              </div>
              <button
                onClick={handleGenerate}
                disabled={!hasCriteria || generating}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-accent text-accent-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {generating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <AIIcon width={16} height={16} />
                    Generate scorers
                  </>
                )}
              </button>
              {!hasCriteria && (
                <p className="text-xs text-fg-dim">
                  Build a charter first — scorers are derived from its criteria.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="max-w-2xl space-y-2">
            {scorers.map(scorer => (
              <div key={scorer.name} className="border border-border bg-surface-raised">
                <button
                  onClick={() => setExpandedScorer(expandedScorer === scorer.name ? null : scorer.name)}
                  className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${expandedScorer === scorer.name ? 'rotate-90' : ''}`} />
                    <code className="text-sm font-medium text-foreground">{scorer.name}</code>
                    <span className={`text-[10px] px-1.5 py-0.5 border ${typeColors[scorer.type]}`}>
                      {scorer.type}
                    </span>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); handleCopy(scorer.code) }}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </button>
                {expandedScorer === scorer.name && (
                  <div className="px-3 pb-3">
                    <p className="text-xs text-muted-foreground mb-2">{scorer.description}</p>
                    <pre className="text-xs bg-background p-3 overflow-x-auto text-foreground/80 font-mono">
                      {scorer.code}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
