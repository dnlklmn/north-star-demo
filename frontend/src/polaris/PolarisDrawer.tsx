import { useCallback, useEffect, useRef, useState } from 'react'
import { Send, X, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import {
  polarisChat,
  polarisConfirm,
  type PolarisProposal,
  type PolarisToolSummary,
} from '../api'
import { usePolaris } from './usePolaris'

/**
 * Polaris drawer — global, route-aware chat with the tool-using agent.
 *
 * Anchored to the right edge of the viewport. Reads `context` from the
 * provider so every message is sent with up-to-date routing info; the model
 * never asks "where are you."
 */

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  toolSummary?: PolarisToolSummary[]
  proposals?: PolarisProposal[]
}

export default function PolarisDrawer() {
  const { context, dispatchNav, open, setOpen } = usePolaris()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open])

  const send = useCallback(
    async (message: string, extraContextOverride?: Record<string, unknown>) => {
      const trimmed = message.trim()
      if (!trimmed || loading) return
      setError(null)
      setMessages(prev => [...prev, { role: 'user', content: trimmed }])
      setLoading(true)
      try {
        const ctxToSend = extraContextOverride
          ? { ...context, ...extraContextOverride }
          : context
        const res = await polarisChat(trimmed, ctxToSend)
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            content: res.message || '',
            toolSummary: res.tool_summary,
            proposals: res.proposals,
          },
        ])
        // Dispatch nav side effects after rendering — gives the user a chance
        // to read the assistant's text before the view changes.
        for (const nav of res.navs || []) {
          dispatchNav(nav)
        }
        // If anything mutated session/dataset state, ask the rest of the app
        // to refresh via a custom event. Pages already listening to SSE
        // updates pick this up too; the event is a backup for screens that
        // don't have SSE wired (e.g. Home).
        if (res.tool_summary?.some(t => t.tier !== 'nav' && t.ok && !t.proposal)) {
          window.dispatchEvent(new CustomEvent('polaris:state-changed'))
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [context, dispatchNav, loading],
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
      // Show the user's "click" as a synthetic message in the transcript so
      // the conversation stays coherent — but bypass the model loop and run
      // the tool directly. Cheaper, deterministic, and not spoofable.
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
    [context, dispatchNav, loading],
  )

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 px-4 py-2.5 bg-accent text-accent-foreground shadow-lg hover:opacity-90 text-sm font-medium"
      >
        Polaris
      </button>
    )
  }

  return (
    <div className="fixed top-0 right-0 bottom-0 w-[420px] z-40 bg-bg-default border-l border-border-hint flex flex-col shadow-2xl">
      <header className="px-4 py-3 border-b border-border-hint flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-fg-contrast">
            Polaris
          </span>
          <RouteBadge route={context.route} />
        </div>
        <button
          onClick={() => setOpen(false)}
          className="p-1 hover:bg-fill-neutral/30 transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground text-center mt-8 px-4">
            Talk to me about your project — I can read state, run actions, and
            navigate the app.
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
  msg: ChatMessage
  onConfirmProposal: (p: PolarisProposal) => void
}) {
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
      <div className="max-w-[92%] flex flex-col gap-1.5">
        {msg.content && (
          <div className="px-3 py-2 text-sm leading-relaxed bg-muted text-foreground">
            {msg.content}
          </div>
        )}
        {msg.toolSummary && msg.toolSummary.length > 0 && (
          <ToolSummaryStack summary={msg.toolSummary} />
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

function ToolSummaryStack({ summary }: { summary: PolarisToolSummary[] }) {
  const [expanded, setExpanded] = useState(false)
  if (summary.length === 0) return null
  const ok = summary.filter(s => !s.error).length
  const failed = summary.filter(s => s.error).length
  return (
    <div className="text-[11px] text-muted-foreground border border-border-hint bg-muted/40">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-1 px-2 py-1 hover:bg-fill-neutral/30 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        <span>
          {summary.length} tool call{summary.length === 1 ? '' : 's'}
          {failed > 0 ? `, ${failed} failed` : ''}
          {failed === 0 && ok > 0 ? ` · ${ok} ok` : ''}
        </span>
      </button>
      {expanded && (
        <div className="px-2 py-1 space-y-0.5 font-mono">
          {summary.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span
                className={
                  s.error
                    ? 'text-red-600'
                    : s.tier === 'nav'
                    ? 'text-blue-600'
                    : s.proposal
                    ? 'text-amber-600'
                    : 'text-emerald-700'
                }
              >
                {s.error ? '✗' : s.tier === 'nav' ? '↪' : s.proposal ? '?' : '✓'}
              </span>
              <span className="truncate">{s.name}</span>
              {s.error && (
                <span className="text-red-600 truncate">— {s.error}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RouteBadge({ route }: { route?: string }) {
  if (!route) return null
  return (
    <span className="text-[10px] text-muted-foreground font-mono bg-muted px-1.5 py-0.5">
      {route}
    </span>
  )
}
