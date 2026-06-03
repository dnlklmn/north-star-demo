/**
 * DeployPanel — last step of the build flow.
 *
 * Once the user's feature passes the self-improvement loop, this panel lets
 * them publish it as a live URL and try it from inside the app. The
 * deployed page (served by the backend) renders the same form auto-generated
 * from the seed's input schema, so "what you evaluated is what you ship".
 *
 * Wiring (parent supplies):
 *   - skillId, skillBody — the feature being deployed
 *   - inputSchema — drives the embedded preview form + the deployed page
 *   - scorers — list of scorer names so prod calls can be re-scored later
 *   - onDeployed (optional) — fires when the link is live, lets the parent
 *     advance to Track 5's observer view
 */
import { useCallback, useState } from 'react'
import { API_BASE, getApiKey } from '../api'
import { InputSchemaForm } from '../lib/inputSchemaForm'
import type {
  FeatureInput,
  FeatureTrace,
  InputSchema,
  RunMode,
} from '../types'

export interface DeployPanelProps {
  skillId: string
  skillBody: string
  inputSchema: InputSchema
  scorers?: string[]
  /** Display title for the deployed page; defaults to "Feature: {skillId}". */
  title?: string
  /** Mode passed to RunFeature on the live URL. Defaults to "agent". */
  mode?: RunMode
  onDeployed?: (deployment: DeploymentInfo) => void
}

export interface DeploymentInfo {
  skill_id: string
  url: string
  api_url: string
  created_at: string
}

interface RunResult {
  output: string
  trace?: FeatureTrace
  error?: string | null
  log_id?: string
  scoring_pending?: boolean
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const apiKey = getApiKey()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['X-Anthropic-Key'] = apiKey
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText)
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }
  return resp.json() as Promise<T>
}

export function DeployPanel(props: DeployPanelProps) {
  const { skillId, skillBody, inputSchema, scorers, title, mode, onDeployed } = props

  const [deployment, setDeployment] = useState<DeploymentInfo | null>(null)
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [lastResult, setLastResult] = useState<RunResult | null>(null)

  const handleDeploy = useCallback(async () => {
    setDeploying(true)
    setError(null)
    try {
      const info = await postJson<DeploymentInfo>(`/deploy/${encodeURIComponent(skillId)}`, {
        skill_body: skillBody,
        input_schema: inputSchema,
        scorers: scorers ?? [],
        mode: mode ?? 'agent',
        title,
      })
      setDeployment(info)
      onDeployed?.(info)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeploying(false)
    }
  }, [skillId, skillBody, inputSchema, scorers, mode, title, onDeployed])

  const handleCopy = useCallback(async () => {
    if (!deployment) return
    try {
      await navigator.clipboard.writeText(deployment.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }, [deployment])

  const handleTryIt = useCallback(
    async (input: FeatureInput) => {
      if (!deployment) {
        setError('Deploy first to enable the preview.')
        return
      }
      setError(null)
      try {
        const result = await postJson<RunResult>(
          `/deployed/${encodeURIComponent(skillId)}/run`,
          { input },
        )
        setLastResult(result)
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [deployment, skillId],
  )

  return (
    <section className="rounded-lg border border-border bg-surface-raised p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-foreground">Deploy</h2>
        <span className="text-xs text-muted-foreground">
          Same runner as evaluation — what you ship is what you scored.
        </span>
      </header>

      {!deployment && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            Publish this feature as a live URL with the same input form your
            scorers tested against.
          </p>
          <button
            type="button"
            onClick={handleDeploy}
            disabled={deploying}
            className="inline-flex w-fit items-center rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {deploying ? 'Deploying…' : 'Deploy'}
          </button>
        </div>
      )}

      {deployment && (
        <div className="space-y-4">
          <div className="rounded-md border border-border bg-background p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Live link
            </div>
            <div className="mt-1 flex items-center gap-2">
              <a
                href={deployment.url}
                target="_blank"
                rel="noreferrer"
                className="break-all text-sm font-mono text-accent underline"
              >
                {deployment.url}
              </a>
              <button
                type="button"
                onClick={handleCopy}
                className="ml-auto rounded-md border border-border px-2 py-1 text-xs hover:bg-background"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Deployed {deployment.created_at}
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              Try it from here
            </div>
            <InputSchemaForm schema={inputSchema} onSubmit={handleTryIt} submitLabel="Run" />
          </div>

          {lastResult && (
            <div
              className={`rounded-md border p-3 text-sm ${
                lastResult.error
                  ? 'border-red-400 bg-red-50 text-red-700'
                  : 'border-border bg-background text-foreground'
              }`}
            >
              {lastResult.error ? (
                <>Error: {lastResult.error}</>
              ) : (
                <>
                  <pre className="whitespace-pre-wrap font-mono text-sm">
                    {lastResult.output || '(empty output)'}
                  </pre>
                  <div className="mt-2 text-xs text-muted-foreground">
                    log id: {lastResult.log_id ?? '-'}
                    {lastResult.scoring_pending ? ' • scoring in progress…' : ''}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-md border border-red-400 bg-red-50 p-2 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}
    </section>
  )
}

export default DeployPanel
