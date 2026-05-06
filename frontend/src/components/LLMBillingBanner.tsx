import { useEffect, useState } from 'react'
import { ExternalLink, Key, X } from 'lucide-react'
import {
  LLM_BILLING_EVENT,
  OPEN_SETTINGS_EVENT,
  type LLMBillingErrorDetail,
} from '../api'

/**
 * Top-of-app banner that appears when the LLM provider rejects a call for
 * billing reasons (out of credits, missing payment method). Listens for the
 * `northstar:llm-billing` event dispatched by `apiFetch` whenever the
 * backend returns HTTP 402.
 *
 * Without this banner, generation requests fail silently from the user's
 * point of view — the spinner stops and nothing shows up. The banner makes
 * the cause obvious and links straight to the provider's billing page so
 * the user can top up and retry.
 */
export default function LLMBillingBanner() {
  const [detail, setDetail] = useState<LLMBillingErrorDetail | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<LLMBillingErrorDetail>
      setDetail(ce.detail)
    }
    window.addEventListener(LLM_BILLING_EVENT, handler)
    return () => window.removeEventListener(LLM_BILLING_EVENT, handler)
  }, [])

  if (!detail) return null

  // Provider-specific top-up link. OpenRouter and Anthropic both have a
  // billing page; default to the Anthropic one for unknown providers.
  const billingUrl =
    detail.provider === 'openrouter'
      ? 'https://openrouter.ai/credits'
      : 'https://console.anthropic.com/settings/billing'
  const providerLabel =
    detail.provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'

  // The user wants to know whose account is on the hook. When the call used
  // the server's default key (no X-Anthropic-Key header), the user can't
  // top up that account — but they CAN supply their own key. When the call
  // used the user's own localStorage key, they go to the provider's
  // billing page directly.
  const keyContext = detail.usingDefaultKey
    ? "server's default key"
    : 'your key'

  const openSettings = () => {
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT))
  }

  return (
    <div className="bg-danger/10 border-b border-danger/30 px-4 py-2 flex-shrink-0">
      <div className="flex items-center justify-center gap-3 text-sm max-w-3xl mx-auto">
        <span className="text-danger font-medium whitespace-nowrap">
          {providerLabel} billing issue
          <span className="ml-1.5 text-danger/70 font-normal">
            ({keyContext})
          </span>
        </span>
        <span className="text-foreground truncate">{detail.message}</span>
        {detail.usingDefaultKey ? (
          <button
            onClick={openSettings}
            className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium bg-accent text-accent-foreground hover:opacity-90 transition-opacity whitespace-nowrap"
          >
            <Key className="w-3 h-3" />
            Use your own key
          </button>
        ) : (
          <a
            href={billingUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium bg-accent text-accent-foreground hover:opacity-90 transition-opacity whitespace-nowrap"
          >
            Add credits
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
        <button
          onClick={openSettings}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground whitespace-nowrap"
          title="Open Settings to change your API key"
        >
          Change key
        </button>
        <button
          onClick={() => setDetail(null)}
          className="text-muted-foreground hover:text-foreground"
          title="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
