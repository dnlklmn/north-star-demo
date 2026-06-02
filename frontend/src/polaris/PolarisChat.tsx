import { useCallback, useEffect, useRef, useState } from 'react'
import { Send, Loader2 } from 'lucide-react'
import {
  polarisChat,
  polarisConfirm,
  type PolarisProposal,
  type PolarisToolSummary,
} from '../api'
import { usePolaris } from './usePolaris'
import type { PolarisMessage } from './polarisContext'

/**
 * Polaris chat — the unified agent's conversation surface. Renders inside
 * the workspace's right rail. The provider owns messages so the transcript
 * survives tab switches and route changes. Tool calls render as inline
 * activity markers ("↳ approved example abc") under the assistant text —
 * narration, not actionable cards.
 */
export default function PolarisChat() {
  const {
    context,
    dispatchNav,
    messages,
    setMessages,
    loading,
    setLoading,
    error,
    setError,
  } = usePolaris()
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const send = useCallback(
    async (message: string) => {
      const trimmed = message.trim()
      if (!trimmed || loading) return
      setError(null)
      setMessages(prev => [...prev, { role: 'user', content: trimmed }])
      setLoading(true)
      try {
        const res = await polarisChat(trimmed, context)
        // Catch the model's most common honesty failure: it claims to have
        // queued a proposal in plain text but never actually called a
        // confirm-tier tool, so no chip appears and the user sees nothing
        // to click. Surface the gap inline so the user knows to retry
        // ("queued a proposal" / "click the chip" without a real proposal).
        const claimedChip =
          /\b(?:queued? (?:a )?proposal|click the (?:chip|confirm))/i.test(
            res.message || '',
          )
        const hasProposal = (res.proposals?.length || 0) > 0
        const phantomChip = claimedChip && !hasProposal
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            content: res.message || '',
            toolSummary: res.tool_summary,
            proposals: res.proposals,
            activity: phantomChip
              ? "I claimed I queued a proposal but didn't actually call the tool — ask me again and I'll try once more."
              : undefined,
          },
        ])
        for (const nav of res.navs || []) {
          dispatchNav(nav)
        }
        if (res.tool_summary?.some(t => t.tier !== 'nav' && t.ok && !t.proposal)) {
          window.dispatchEvent(new CustomEvent('polaris:state-changed'))
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [context, dispatchNav, loading, setError, setLoading, setMessages],
  )

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const value = input
      setInput('')
      send(value)
    },
    [input, send],
  )

  const onConfirmProposal = useCallback(
    async (proposal: PolarisProposal) => {
      if (loading) return
      setError(null)
      setMessages(prev => [
        ...prev,
        { role: 'user', content: `[confirmed] ${proposal.label}` },
      ])
      setLoading(true)
      try {
        const res = await polarisConfirm(proposal.tool, proposal.args, context)
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            content:
              res.message ||
              (res.tool_summary?.[0]?.error
                ? `That failed: ${res.tool_summary[0].error}`
                : 'Done.'),
            toolSummary: res.tool_summary,
            proposals: res.proposals,
          },
        ])
        for (const nav of res.navs || []) {
          dispatchNav(nav)
        }
        if (res.tool_summary?.some(t => t.tier !== 'nav' && t.ok)) {
          window.dispatchEvent(new CustomEvent('polaris:state-changed'))
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [context, dispatchNav, loading, setError, setLoading, setMessages],
  )

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground text-center mt-8 px-4">
            Talk to me about your project — ask anything, or tell me to do
            things. I can read state, run actions, and navigate the app.
          </p>
        )}

        {messages.map((msg, i) => (
          <ChatBubble
            key={i}
            msg={msg}
            onConfirmProposal={onConfirmProposal}
          />
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-muted px-3 py-2 flex items-center gap-2 text-sm italic text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Thinking
            </div>
          </div>
        )}

        {error && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-200 px-2 py-1.5">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form
        onSubmit={onSubmit}
        className="border-t border-border-hint p-3 flex gap-2 flex-shrink-0"
      >
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask anything, or tell me to do something…"
          className="flex-1 px-3 py-2 border border-border text-sm bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={!input.trim() || loading}
          className="p-2 bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  )
}

function ChatBubble({
  msg,
  onConfirmProposal,
}: {
  msg: PolarisMessage
  onConfirmProposal: (p: PolarisProposal) => void
}) {
  // Activity-only messages render as a single muted line with no bubble —
  // they're narration of out-of-chat actions, not part of the dialogue.
  if (
    msg.role === 'assistant' &&
    msg.activity &&
    !msg.content &&
    !msg.toolSummary?.length &&
    !msg.proposals?.length
  ) {
    return (
      <div className="px-1 text-[11px] text-muted-foreground flex items-baseline gap-1.5">
        <span className="text-blue-600" aria-hidden>↳</span>
        <span className="truncate">{msg.activity}</span>
      </div>
    )
  }
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3 py-2 text-sm leading-relaxed bg-accent text-accent-foreground">
          {msg.content}
        </div>
      </div>
    )
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] flex flex-col gap-1">
        {msg.content && (
          <div className="px-3 py-2 text-sm leading-relaxed bg-muted text-foreground">
            {msg.content}
          </div>
        )}
        {msg.toolSummary && msg.toolSummary.length > 0 && (
          <ToolMarkers summary={msg.toolSummary} />
        )}
        {msg.proposals && msg.proposals.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-0.5">
            {msg.proposals.map((p, i) => (
              <button
                key={i}
                onClick={() => onConfirmProposal(p)}
                title={p.reason}
                className="px-2.5 py-1.5 text-xs bg-accent/10 text-accent hover:bg-accent/20 border border-accent/30 transition-colors text-left"
              >
                ✓ {p.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Inline activity markers — one short line per tool call, no collapse, no
 * actions. Reads like narration ("↳ approved example abc", "↳ switched to
 * dataset", "↳ filtered to good/pending"). These are part of the
 * conversation, not a side panel.
 */
function ToolMarkers({ summary }: { summary: PolarisToolSummary[] }) {
  if (summary.length === 0) return null
  return (
    <div className="px-1 space-y-0.5 text-[11px] text-muted-foreground">
      {summary.map((s, i) => (
        <div key={i} className="flex items-baseline gap-1.5">
          <span
            className={
              s.error
                ? 'text-red-600'
                : s.proposal
                ? 'text-amber-600'
                : s.tier === 'nav'
                ? 'text-blue-600'
                : 'text-emerald-700'
            }
            aria-hidden
          >
            ↳
          </span>
          <span className="truncate">
            {describeToolCall(s)}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Turn a tool-call summary into a human-readable narration line. The agent
 * has already done what's described — this is informational, not actionable.
 */
function describeToolCall(s: PolarisToolSummary): string {
  if (s.error) return `${s.name} failed: ${s.error}`
  if (s.proposal) return `proposed ${s.name}`

  const args = s.args || {}
  switch (s.name) {
    case 'nav_phase':
      return `switched to ${args.phase as string} tab`
    case 'nav_example':
      return `opened example ${shortId(args.example_id)}`
    case 'nav_coverage_map':
      return 'opened coverage map'
    case 'nav_settings':
      return 'opened settings'
    case 'nav_share':
      return 'opened share dialog'
    case 'nav_eval_run':
      return `opened eval run ${shortId(args.run_id)}`
    case 'nav_home':
      return 'opened home'
    case 'nav_project':
      return `opened project ${shortId(args.session_id)}`
    case 'set_dataset_filter': {
      const parts: string[] = []
      if (typeof args.feature_area === 'string')
        parts.push(args.feature_area ? `area=${args.feature_area}` : 'cleared area')
      if (typeof args.label === 'string')
        parts.push(args.label ? `label=${args.label}` : 'cleared label')
      if (typeof args.review_status === 'string')
        parts.push(
          args.review_status
            ? `status=${args.review_status}`
            : 'cleared status',
        )
      return parts.length ? `filtered dataset: ${parts.join(', ')}` : 'updated dataset filter'
    }
    case 'approve_example':
      return `approved example ${shortId(args.example_id)}`
    case 'reject_example':
      return `rejected example ${shortId(args.example_id)}`
    case 'relabel_example':
      return `relabeled ${shortId(args.example_id)} → ${args.label as string}`
    case 'delete_example':
      return `deleted example ${shortId(args.example_id)}`
    case 'create_example':
      return `created example in ${args.feature_area as string}`
    case 'rename_project':
      return `renamed project to "${args.name as string}"`
    case 'patch_seed':
      return `updated seed`
    case 'update_settings':
      return 'updated settings'
    case 'synthesize_examples':
      return 'generated synthetic examples'
    case 'auto_review':
      return 'auto-reviewed pending examples'
    case 'enrich_gaps':
      return 'generated examples for coverage gaps'
    case 'export_dataset':
      return 'exported dataset'
    case 'run_eval':
      return 'opened eval runner'
    case 'generate_scorers':
      return 'opened scorers tab'
    case 'finalize_seed':
      return 'opened seed for finalize'
    case 'delete_project':
      return 'deleted project'
    case 'create_project':
      return `created project "${args.name as string}"`
    // Read tools — the UI moved, so just describe what was opened.
    case 'get_seed':
    case 'get_scorers':
    case 'get_dataset_overview':
    case 'list_examples':
    case 'get_example':
    case 'get_coverage_gaps':
    case 'get_eval_runs':
    case 'get_settings':
      return s.name.replace(/^get_/, 'inspected ').replace(/^list_/, 'listed ').replace(/_/g, ' ')
    case 'get_project':
    case 'list_projects':
    case 'get_activity':
      return s.name.replace(/^get_/, 'fetched ').replace(/^list_/, 'listed ').replace(/_/g, ' ')
    default:
      return s.name.replace(/_/g, ' ')
  }
}

function shortId(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.length > 10 ? v.slice(0, 8) + '…' : v
}
