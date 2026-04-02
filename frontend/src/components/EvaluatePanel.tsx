import { Download, ExternalLink } from 'lucide-react'
import type { Dataset } from '../types'

interface Integration {
  name: string
  description: string
  icon: string
  exportFormat: string
}

const INTEGRATIONS: Integration[] = [
  { name: 'Langfuse', description: 'Open-source LLM observability & evaluation', icon: 'LF', exportFormat: 'langfuse' },
  { name: 'Braintrust', description: 'AI product evaluation & monitoring', icon: 'BT', exportFormat: 'braintrust' },
  { name: 'Promptfoo', description: 'Open-source LLM testing framework', icon: 'PF', exportFormat: 'promptfoo' },
  { name: 'Humanloop', description: 'Evaluation, monitoring & prompt management', icon: 'HL', exportFormat: 'humanloop' },
  { name: 'W&B Weave', description: 'ML experiment tracking & evaluation', icon: 'WB', exportFormat: 'weave' },
]

interface Props {
  dataset: Dataset | null
  onExport: () => void
}

export default function EvaluatePanel({ dataset, onExport }: Props) {
  const exampleCount = dataset?.examples?.length || 0

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 h-12 border-b border-border bg-surface-raised flex items-center justify-between flex-shrink-0">
        <h2 className="text-sm font-semibold text-foreground">Evaluate</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-lg">
          <p className="text-sm text-muted-foreground mb-6">
            Export your dataset and scorers to run evaluations with your preferred platform.
            {exampleCount > 0 && (
              <span className="text-foreground font-medium"> {exampleCount} examples ready.</span>
            )}
          </p>

          {/* Direct download */}
          <div className="mb-8">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Download</h3>
            <button
              onClick={onExport}
              disabled={!dataset}
              className={`w-full flex items-center gap-3 p-4 border border-border rounded-lg transition-colors ${
                dataset ? 'hover:bg-muted/50 cursor-pointer' : 'opacity-50 cursor-not-allowed'
              }`}
            >
              <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                <Download className="w-5 h-5 text-accent" />
              </div>
              <div className="text-left">
                <p className="text-sm font-medium text-foreground">Download JSON</p>
                <p className="text-xs text-muted-foreground">
                  Raw dataset with all examples, labels, and metadata
                </p>
              </div>
            </button>
          </div>

          {/* Integrations */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Integrations</h3>
            <div className="space-y-2">
              {INTEGRATIONS.map(integration => (
                <div
                  key={integration.name}
                  className="flex items-center gap-3 p-4 border border-border rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="w-10 h-10 rounded-lg bg-surface-raised border border-border flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-bold text-muted-foreground">{integration.icon}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">{integration.name}</p>
                    <p className="text-xs text-muted-foreground">{integration.description}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      disabled={!dataset}
                      className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
                        dataset
                          ? 'bg-accent/10 text-accent hover:bg-accent/20'
                          : 'text-muted-foreground/40 cursor-not-allowed'
                      }`}
                    >
                      Export
                    </button>
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/40" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {!dataset && (
            <p className="text-xs text-muted-foreground/60 text-center mt-8">
              Generate a dataset first to enable exports and integrations
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
