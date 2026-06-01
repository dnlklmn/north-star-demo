import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import {
  PLAYGROUND_QUOTA_EVENT,
  PLAYGROUND_SPEND_CAP_EVENT,
  type PlaygroundQuotaDetail,
  type PlaygroundSpendCapDetail,
} from '../api'

/**
 * Top-of-app banner that appears when an LLM call is rejected because either:
 *   - The caller's IP has hit the per-day quota (HTTP 429), or
 *   - The backend has hit its daily spend cap (HTTP 503).
 *
 * Without this banner, rate-limited actions in the UI would silently fail
 * from the user's point of view — the spinner stops and nothing shows up.
 * Listens for the two playground events dispatched by `apiFetch`.
 *
 * Mirrors the LLMBillingBanner pattern. One banner instance handles both
 * statuses because they're mutually exclusive in practice: a 503 means the
 * deployment is over budget regardless of who's calling, and a 429 means
 * one specific IP is over its allowance.
 */
type BannerKind = 'quota' | 'spend_cap'

interface BannerState {
  kind: BannerKind
  message: string
  /** Only for kind=quota. */
  limit?: number
  retryAfterSeconds?: number
}

function formatRetryAfter(seconds: number): string {
  if (seconds < 60) return `~${seconds}s`
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`
  return `~${Math.round(seconds / 3600)}h`
}

export default function PlaygroundLimitBanner() {
  const [state, setState] = useState<BannerState | null>(null)

  useEffect(() => {
    const quotaHandler = (e: Event) => {
      const ce = e as CustomEvent<PlaygroundQuotaDetail>
      setState({
        kind: 'quota',
        message: ce.detail.message,
        limit: ce.detail.limit,
        retryAfterSeconds: ce.detail.retryAfterSeconds,
      })
    }
    const spendHandler = (e: Event) => {
      const ce = e as CustomEvent<PlaygroundSpendCapDetail>
      setState({ kind: 'spend_cap', message: ce.detail.message })
    }
    window.addEventListener(PLAYGROUND_QUOTA_EVENT, quotaHandler)
    window.addEventListener(PLAYGROUND_SPEND_CAP_EVENT, spendHandler)
    return () => {
      window.removeEventListener(PLAYGROUND_QUOTA_EVENT, quotaHandler)
      window.removeEventListener(PLAYGROUND_SPEND_CAP_EVENT, spendHandler)
    }
  }, [])

  if (!state) return null

  // Heading copy distinguishes the two cases so the user knows whether the
  // constraint is theirs (quota) or the whole deployment's (spend cap).
  const heading =
    state.kind === 'quota'
      ? `Daily run limit reached${state.limit ? ` (${state.limit} / day)` : ''}`
      : 'Playground budget exhausted'

  const suffix =
    state.kind === 'quota' && state.retryAfterSeconds
      ? ` Resets in ${formatRetryAfter(state.retryAfterSeconds)}.`
      : ''

  return (
    <div className="bg-warning/10 border-b border-warning/30 px-4 py-2 flex-shrink-0">
      <div className="flex items-center justify-center gap-3 text-sm max-w-3xl mx-auto">
        <span className="text-warning font-medium whitespace-nowrap">
          {heading}
        </span>
        <span className="text-foreground truncate">
          {state.message}
          {suffix}
        </span>
        <button
          onClick={() => setState(null)}
          className="text-muted-foreground hover:text-foreground ml-auto"
          title="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
