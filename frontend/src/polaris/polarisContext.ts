import { createContext } from 'react'
import type { PolarisContext, PolarisProposal, PolarisToolSummary } from '../api'

/**
 * Polaris context bus — the React context object lives here so the provider
 * file only exports a component (keeps Fast Refresh happy).
 *
 * The provider owns the conversation so it survives tab switches and route
 * changes (the chat is mounted in the workspace rail, not on a per-page
 * component). Hydrated from `state.input.conversation_history` when the
 * project loads and persisted back on every assistant turn.
 */

export type PolarisNavHandler = (props: Record<string, unknown>) => void

export interface PolarisMessage {
  role: 'user' | 'assistant'
  content: string
  // Tool-call narration rendered inline under the assistant text — small
  // pill-style markers ("↳ approved example abc"), not collapsible cards.
  toolSummary?: PolarisToolSummary[]
  proposals?: PolarisProposal[]
}

export interface PolarisCtxShape {
  context: PolarisContext
  setContextSlice: (slice: Partial<PolarisContext>) => void
  registerNavHandler: (target: string, handler: PolarisNavHandler) => () => void
  dispatchNav: (nav: { target: string; props: Record<string, unknown> }) => void

  // Conversation
  messages: PolarisMessage[]
  setMessages: (next: PolarisMessage[] | ((prev: PolarisMessage[]) => PolarisMessage[])) => void
  hydrateMessages: (initial: PolarisMessage[]) => void
  loading: boolean
  setLoading: (v: boolean) => void
  error: string | null
  setError: (v: string | null) => void
}

export const PolarisCtx = createContext<PolarisCtxShape | null>(null)
