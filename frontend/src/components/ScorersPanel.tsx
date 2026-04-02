import { useState } from 'react'
import { Sparkles, ChevronRight, Copy, Download, Loader2 } from 'lucide-react'
import type { Charter } from '../types'

interface ScorerDef {
  name: string
  type: 'coverage' | 'alignment' | 'balance' | 'rot'
  description: string
  code: string
}

interface Props {
  charter: Charter
  hasDataset: boolean
}

export default function ScorersPanel({ charter, hasDataset }: Props) {
  const [scorers, setScorers] = useState<ScorerDef[]>([])
  const [generating, setGenerating] = useState(false)
  const [expandedScorer, setExpandedScorer] = useState<string | null>(null)

  const hasCriteria = charter.coverage.criteria.length > 0
    || charter.balance.criteria.length > 0
    || charter.alignment.length > 0
    || charter.rot.criteria.length > 0

  const handleGenerate = async () => {
    setGenerating(true)
    // Build scorers from charter criteria
    const generated: ScorerDef[] = []

    charter.coverage.criteria.forEach((criterion, i) => {
      generated.push({
        name: `coverage_${i + 1}`,
        type: 'coverage',
        description: criterion,
        code: buildCoverageScorer(criterion, i),
      })
    })

    charter.alignment.forEach((entry) => {
      generated.push({
        name: `alignment_${entry.feature_area.toLowerCase().replace(/\s+/g, '_')}`,
        type: 'alignment',
        description: `${entry.feature_area}: good="${entry.good}" vs bad="${entry.bad}"`,
        code: buildAlignmentScorer(entry.feature_area, entry.good, entry.bad),
      })
    })

    charter.balance.criteria.forEach((criterion, i) => {
      generated.push({
        name: `balance_${i + 1}`,
        type: 'balance',
        description: criterion,
        code: buildBalanceScorer(criterion, i),
      })
    })

    charter.rot.criteria.forEach((criterion, i) => {
      generated.push({
        name: `rot_${i + 1}`,
        type: 'rot',
        description: criterion,
        code: buildRotScorer(criterion, i),
      })
    })

    // Simulate async generation
    await new Promise(r => setTimeout(r, 800))
    setScorers(generated)
    setGenerating(false)
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
      <div className="px-4 h-12 border-b border-border bg-surface-raised flex items-center justify-between flex-shrink-0">
        <h2 className="text-sm font-semibold text-foreground">Scorers</h2>
        <div className="flex items-center gap-2">
          {scorers.length > 0 && (
            <button
              onClick={handleDownloadAll}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <Download className="w-3 h-3" />
              Download all
            </button>
          )}
          <button
            onClick={handleGenerate}
            disabled={!hasCriteria || generating}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              hasCriteria && !generating ? 'bg-accent text-accent-foreground hover:opacity-90' : 'text-muted-foreground/40 cursor-not-allowed'
            }`}
          >
            {generating ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-3 h-3" />
                {scorers.length > 0 ? 'Regenerate scorers' : 'Generate scorers'}
              </>
            )}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {scorers.length === 0 ? (
          <div className="max-w-lg mx-auto text-center py-12">
            <Sparkles className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
            <h3 className="text-sm font-medium text-foreground mb-2">Generate custom scorers</h3>
            <p className="text-sm text-muted-foreground mb-6">
              Create evaluation scorers from your charter criteria. Each charter dimension becomes a scorer
              that can check whether outputs meet your quality standards.
            </p>
            <div className="text-left max-w-sm mx-auto space-y-2 text-xs text-muted-foreground">
              <p><span className="font-medium text-foreground">Coverage scorers</span> — check if outputs handle specific input scenarios</p>
              <p><span className="font-medium text-foreground">Alignment scorers</span> — compare outputs against good/bad examples</p>
              <p><span className="font-medium text-foreground">Balance scorers</span> — verify weighting and priority compliance</p>
              <p><span className="font-medium text-foreground">Rot scorers</span> — detect when outputs need updating</p>
            </div>
          </div>
        ) : (
          <div className="max-w-2xl space-y-2">
            {scorers.map(scorer => (
              <div key={scorer.name} className="border border-border rounded-lg bg-surface-raised">
                <button
                  onClick={() => setExpandedScorer(expandedScorer === scorer.name ? null : scorer.name)}
                  className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${expandedScorer === scorer.name ? 'rotate-90' : ''}`} />
                    <code className="text-sm font-medium text-foreground">{scorer.name}</code>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${typeColors[scorer.type]}`}>
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
                    <pre className="text-xs bg-background rounded p-3 overflow-x-auto text-foreground/80 font-mono">
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

function buildCoverageScorer(criterion: string, index: number): string {
  return `def coverage_${index + 1}(output: str, input: str) -> float:
    """Check: ${criterion}"""
    # LLM-as-judge scorer
    prompt = f"""Rate how well this output addresses the following criterion:
Criterion: ${criterion}
Input: {input}
Output: {output}

Score 0.0 (not addressed) to 1.0 (fully addressed)."""
    # return call_judge(prompt)
    raise NotImplementedError("Connect to your LLM judge")`
}

function buildAlignmentScorer(featureArea: string, good: string, bad: string): string {
  return `def alignment_${featureArea.toLowerCase().replace(/\s+/g, '_')}(output: str) -> float:
    """Alignment: ${featureArea}
    Good example: ${good}
    Bad example: ${bad}"""
    prompt = f"""Compare this output against quality examples for "${featureArea}":

Good example: ${good}
Bad example: ${bad}
Actual output: {output}

Score 0.0 (matches bad example) to 1.0 (matches good example)."""
    # return call_judge(prompt)
    raise NotImplementedError("Connect to your LLM judge")`
}

function buildBalanceScorer(criterion: string, index: number): string {
  return `def balance_${index + 1}(output: str, input: str) -> float:
    """Balance check: ${criterion}"""
    prompt = f"""Check if this output properly balances: ${criterion}
Input: {input}
Output: {output}

Score 0.0 (poorly balanced) to 1.0 (well balanced)."""
    # return call_judge(prompt)
    raise NotImplementedError("Connect to your LLM judge")`
}

function buildRotScorer(criterion: string, index: number): string {
  return `def rot_${index + 1}(output: str) -> float:
    """Rot detection: ${criterion}"""
    prompt = f"""Check if this output shows signs of staleness per: ${criterion}
Output: {output}

Score 0.0 (stale/outdated) to 1.0 (fresh/current)."""
    # return call_judge(prompt)
    raise NotImplementedError("Connect to your LLM judge")`
}
