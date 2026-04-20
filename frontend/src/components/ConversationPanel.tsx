import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, ChevronDown, ChevronRight } from 'lucide-react'
import type { Message, AgentStatus, Validation } from '../types'
import { StarIcon } from './ui/Icons'

type Phase = 'goals' | 'users' | 'stories' | 'charter' | 'dataset'
type ExtractedStory = { who: string; what: string; why: string }
import SoftOkBanner from './SoftOkBanner'

const USER_MESSAGE_COLLAPSE_LINES = 5
const USER_MESSAGE_COLLAPSE_CHARS = 280

const STATUS_SEQUENCES: Record<string, string[]> = {
  init: ['Initializing...'],
  goals: ['Thinking about your goals...'],
  users: ['Thinking about your users...'],
  stories: ['Thinking about user scenarios...'],
  charter_generating: [
    'Generating draft from your input',
    'Validating criteria',
    'Generating suggestions',
  ],
  charter: ['Thinking...'],
  dataset: ['Thinking...'],
}

function getStatusKey(phase: Phase, hasCharter: boolean, isInit: boolean): string {
  if (isInit) return 'init'
  if (phase === 'goals') return 'goals'
  if (phase === 'users') return 'users'
  if (phase === 'stories') return 'stories'
  if (phase === 'charter' && !hasCharter) return 'charter_generating'
  if (phase === 'charter') return 'charter'
  return 'dataset'
}

interface ActionSuggestion {
  action: string
  label: string
  reason: string
}

interface Props {
  messages: Message[]
  status: AgentStatus
  validation: Validation
  loading: boolean
  onSend: (message: string) => void
  onProceed: () => void
  onKeepRefining: () => void
  actionSuggestions?: ActionSuggestion[]
  onActionSuggestion?: (action: string) => void
  chatInput?: string
  onChatInputChange?: (value: string) => void
  placeholder?: string
  phase?: Phase
  hasCharter?: boolean
  isInit?: boolean
  suggestedGoals?: string[]
  suggestedUsers?: string[]
  suggestedStoryOptions?: ExtractedStory[]
  onAcceptSuggestedGoal?: (goal: string) => void
  onAcceptSuggestedUser?: (user: string) => void
  onAcceptSuggestedStory?: (story: ExtractedStory) => void
}

export default function ConversationPanel({
  messages,
  status,
  validation,
  loading,
  onSend,
  onProceed,
  onKeepRefining,
  actionSuggestions = [],
  onActionSuggestion,
  chatInput,
  onChatInputChange,
  placeholder = 'Type your response...',
  phase = 'goals',
  hasCharter = false,
  suggestedGoals = [],
  suggestedUsers = [],
  suggestedStoryOptions = [],
  onAcceptSuggestedGoal,
  onAcceptSuggestedUser,
  onAcceptSuggestedStory,
  isInit = false,
}: Props) {
  const [localInput, setLocalInput] = useState('')
  // Use controlled input if chatInput/onChatInputChange provided, else local state
  const input = chatInput !== undefined ? chatInput : localInput
  const setInput = onChatInputChange || setLocalInput

  // Cycling status label during loading
  const [statusIndex, setStatusIndex] = useState(0)
  const statusKey = getStatusKey(phase, hasCharter, isInit)
  const statusSequence = STATUS_SEQUENCES[statusKey] || ['Thinking...']

  useEffect(() => {
    if (!loading) {
      setStatusIndex(0)
      return
    }
    if (statusSequence.length <= 1) return

    const interval = setInterval(() => {
      setStatusIndex(prev => {
        if (prev < statusSequence.length - 1) return prev + 1
        return prev // Stay on last step
      })
    }, 3000)
    return () => clearInterval(interval)
  }, [loading, statusSequence.length])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; text: string } | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesAreaRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Close context menu on click outside or scroll
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [contextMenu])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return
    onSend(input.trim())
    setInput('')
  }

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    // Small delay to let the selection finalize
    setTimeout(() => {
      const selection = window.getSelection()
      const selectedText = selection?.toString().trim()
      if (selectedText && selectedText.length > 3) {
        // Position the menu near the mouse
        setContextMenu({ x: e.clientX, y: e.clientY, text: selectedText })
      }
    }, 10)
  }, [])

  const handleRespond = useCallback(() => {
    if (!contextMenu) return
    // Quote the selected text and place it in the input
    const quoted = `"${contextMenu.text}" — `
    setInput(quoted)
    setContextMenu(null)
    inputRef.current?.focus()
  }, [contextMenu])

  const handleQuestionClick = useCallback((section: string, _question: string) => {
    // Generate a starter response based on the section type
    // _question is available for more contextual starters in the future
    const starters: Record<string, string> = {
      Coverage: 'For this scenario, we should consider ',
      Balance: 'I think we should prioritize ',
      Alignment: 'A good response would ',
      Rot: 'We should update when ',
    }
    const starter = starters[section] || ''
    setInput(starter)
    inputRef.current?.focus()
  }, [])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Messages */}
      <div
        ref={messagesAreaRef}
        className="flex-1 overflow-y-auto p-4 space-y-3"
        onMouseUp={handleMouseUp}
      >
        {messages.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground text-center mt-8">
            Starting your session...
          </p>
        )}

        {messages.map((msg, i) => {
          if (msg.kind === 'hint') {
            return (
              <HintPill
                key={msg.id ?? i}
                content={msg.content}
                detail={msg.detail ?? null}
              />
            )
          }
          if (msg.role === 'user') {
            return (
              <CollapsibleUserMessage
                key={i}
                content={msg.content}
                onQuestionClick={handleQuestionClick}
              />
            )
          }
          return (
            <div key={i} className="flex justify-start">
              <div className="max-w-[85%] px-3.5 py-2.5 text-sm leading-relaxed bg-muted text-foreground">
                {formatMessage(msg.content, handleQuestionClick)}
              </div>
            </div>
          )
        })}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-muted px-4 py-2.5 flex items-center gap-2">
              <span className="text-sm italic text-muted-foreground">
                {statusSequence[statusIndex]}
              </span>
              <span className="flex gap-0.5">
                <span className="w-1 h-1 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-surface-raised border border-border shadow-lg py-1"
          style={{ left: contextMenu.x, top: contextMenu.y - 40 }}
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={handleRespond}
            className="px-3 py-1.5 text-sm text-foreground hover:bg-muted w-full text-left"
          >
            Respond
          </button>
        </div>
      )}

      {/* Soft OK banner */}
      {status === 'soft_ok' && (
        <SoftOkBanner
          validation={validation}
          onKeepRefining={onKeepRefining}
          onProceed={onProceed}
        />
      )}

      {/* Suggested goals (clickable options during goals phase) */}
      {suggestedGoals.length > 0 && (
        <div className="px-3 py-2 border-t border-border bg-muted/30">
          <div className="flex flex-wrap gap-1.5">
            {suggestedGoals.map((goal, i) => (
              <button
                key={i}
                onClick={() => onAcceptSuggestedGoal?.(goal)}
                className="px-3 py-1.5 text-xs bg-accent/10 text-accent hover:bg-accent/20 transition-colors text-left"
              >
                + {goal}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Suggested users (clickable options during users phase) */}
      {suggestedUsers.length > 0 && (
        <div className="px-3 py-2 border-t border-border bg-muted/30">
          <div className="flex flex-wrap gap-1.5">
            {suggestedUsers.map((user, i) => (
              <button
                key={i}
                onClick={() => onAcceptSuggestedUser?.(user)}
                className="px-3 py-1.5 text-xs bg-accent/10 text-accent hover:bg-accent/20 transition-colors text-left"
              >
                + {user}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Suggested stories (clickable options during stories phase) */}
      {suggestedStoryOptions.length > 0 && (
        <div className="px-3 py-2 border-t border-border bg-muted/30">
          <div className="flex flex-wrap gap-1.5">
            {suggestedStoryOptions.map((story, i) => (
              <button
                key={i}
                onClick={() => onAcceptSuggestedStory?.(story)}
                className="px-3 py-1.5 text-xs bg-accent/10 text-accent hover:bg-accent/20 transition-colors text-left"
              >
                + {story.who}: {story.what}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Action suggestions */}
      {actionSuggestions.length > 0 && (
        <div className="px-3 py-2 border-t border-border bg-muted/30">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
            Suggested actions
          </div>
          <div className="flex flex-wrap gap-1.5">
            {actionSuggestions.map((suggestion, i) => (
              <button
                key={i}
                onClick={() => onActionSuggestion?.(suggestion.action)}
                className="px-2.5 py-1.5 text-xs bg-accent/10 text-accent hover:bg-accent/20 transition-colors text-left"
                title={suggestion.reason}
              >
                {suggestion.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-border p-3">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={placeholder}
            className="flex-1 px-3 py-2 border border-border text-sm bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="p-2 bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
        {phase === 'charter' && (
          <button
            onClick={onProceed}
            className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Proceed to review
          </button>
        )}
      </div>
    </div>
  )
}

function HintPill({ content, detail }: { content: string; detail: string | null }) {
  return (
    <div className="flex justify-start py-0.5">
      <div className="inline-flex items-start gap-1.5 px-2.5 py-1 rounded-md bg-muted/40 border border-border-hint/60 max-w-full">
        <StarIcon className="shrink-0 text-muted-foreground/70 mt-0.5" width={11} height={11} />
        <div className="min-w-0 flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground">
            {content}
          </span>
          {detail && (
            <span className="text-[11px] text-foreground/80 font-mono break-words">
              {detail}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function CollapsibleUserMessage({
  content,
  onQuestionClick,
}: {
  content: string
  onQuestionClick: (section: string, question: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.split('\n')
  const isLong =
    content.length > USER_MESSAGE_COLLAPSE_CHARS ||
    lines.length > USER_MESSAGE_COLLAPSE_LINES

  if (!isLong) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3.5 py-2.5 text-sm leading-relaxed bg-accent text-accent-foreground">
          {formatMessage(content, onQuestionClick)}
        </div>
      </div>
    )
  }

  const firstLine = lines[0].trim()
  const summary = firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine

  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] text-sm leading-relaxed bg-accent text-accent-foreground overflow-hidden">
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full flex items-center gap-1.5 px-3.5 py-2 text-left hover:bg-black/10 transition-colors"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-70" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 shrink-0 opacity-70" />
          )}
          <span className={expanded ? 'font-medium' : 'opacity-90 truncate'}>
            {expanded ? 'Your message' : summary}
          </span>
        </button>
        {expanded && (
          <div className="px-3.5 pb-2.5 pt-0.5">
            {formatMessage(content, onQuestionClick)}
          </div>
        )}
      </div>
    </div>
  )
}

function formatMessage(content: string, onQuestionClick?: (section: string, question: string) => void): React.ReactNode {
  // Split all lines, then group into blocks
  const allLines = content.split('\n')
  const blocks: { type: 'text' | 'list' | 'question'; lines: string[]; section?: string; question?: string }[] = []

  let currentBlock: typeof blocks[number] | null = null

  for (const line of allLines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (currentBlock) {
        blocks.push(currentBlock)
        currentBlock = null
      }
      continue
    }

    // Check for question format: "? [Tag] Question text" or "? Tag Question text"
    const questionMatch = trimmed.match(/^\?\s*\[?(\w+)\]?\s+(.+)$/)
    if (questionMatch) {
      if (currentBlock) blocks.push(currentBlock)
      blocks.push({
        type: 'question',
        lines: [],
        section: questionMatch[1],
        question: questionMatch[2],
      })
      currentBlock = null
      continue
    }

    const isBullet = /^\s*[-•·]\s/.test(trimmed)

    if (isBullet) {
      if (currentBlock?.type !== 'list') {
        if (currentBlock) blocks.push(currentBlock)
        currentBlock = { type: 'list', lines: [] }
      }
      currentBlock.lines.push(trimmed)
    } else {
      if (currentBlock?.type !== 'text') {
        if (currentBlock) blocks.push(currentBlock)
        currentBlock = { type: 'text', lines: [] }
      }
      currentBlock.lines.push(trimmed)
    }
  }
  if (currentBlock) blocks.push(currentBlock)

  return (
    <div className="space-y-2">
      {blocks.map((block, bi) => {
        if (block.type === 'question' && block.section && block.question) {
          return (
            <div key={bi} className="space-y-1">
              <button
                onClick={() => onQuestionClick?.(block.section!, block.question!)}
                className="text-left w-full hover:bg-accent/10 px-1 -mx-1 transition-colors"
              >
                <span className="font-semibold text-foreground">{block.section}</span>
                <p className="text-foreground/80">{block.question}</p>
              </button>
            </div>
          )
        }

        if (block.type === 'list') {
          return (
            <ul key={bi} className="space-y-1">
              {block.lines.map((line, li) => (
                <li key={li} className="flex gap-1.5">
                  <span className="text-muted-foreground mt-0.5">·</span>
                  <span>{formatInline(line.replace(/^\s*[-•·]\s*/, ''))}</span>
                </li>
              ))}
            </ul>
          )
        }

        return <p key={bi}>{formatInline(block.lines.join(' '))}</p>
      })}
    </div>
  )
}

function formatInline(text: string): React.ReactNode {
  // Handle [Tag] markers and **bold**
  const pattern = /\[([^\]]+)\]|\*\*([^*]+)\*\*/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    if (match[1]) {
      // [Tag] marker
      parts.push(
        <span
          key={match.index}
          className="inline-block px-1.5 py-0.5 mr-0.5 text-xs bg-accent/10 text-accent font-medium"
        >
          {match[1]}
        </span>
      )
    } else if (match[2]) {
      // **bold**
      parts.push(<strong key={match.index}>{match[2]}</strong>)
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>
}
