import { useState, useRef, useEffect, useCallback } from 'react'
import { Send } from 'lucide-react'
import type { Message, AgentStatus, Validation } from '../types'
import SoftOkBanner from './SoftOkBanner'

interface Props {
  messages: Message[]
  status: AgentStatus
  validation: Validation
  loading: boolean
  onSend: (message: string) => void
  onProceed: () => void
  onKeepRefining: () => void
}

export default function ConversationPanel({
  messages,
  status,
  validation,
  loading,
  onSend,
  onProceed,
  onKeepRefining,
}: Props) {
  const [input, setInput] = useState('')
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
    if (!input.trim() || loading) return
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
    <div className="flex flex-col h-full">
      <div className="px-4 h-12 border-b border-border bg-surface-raised flex items-center">
        <h2 className="text-sm font-semibold text-foreground">Agent</h2>
      </div>

      {/* Messages */}
      <div
        ref={messagesAreaRef}
        className="flex-1 overflow-y-auto p-4 space-y-3"
        onMouseUp={handleMouseUp}
      >
        {messages.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground text-center mt-8">
            Add your input and click Generate to start.
          </p>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-muted text-foreground'
              }`}
            >
              {formatMessage(msg.content, handleQuestionClick)}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-muted px-4 py-2.5 rounded-2xl">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-surface-raised border border-border rounded-lg shadow-lg py-1"
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

      {/* Input */}
      <div className="border-t border-border p-3">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Type your response..."
            disabled={loading}
            className="flex-1 px-3 py-2 border border-border rounded-lg text-sm bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="p-2 bg-accent text-accent-foreground rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
        <button
          onClick={onProceed}
          className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Proceed to review
        </button>
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
                className="text-left w-full hover:bg-accent/10 rounded px-1 -mx-1 transition-colors"
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
          className="inline-block px-1.5 py-0.5 mr-0.5 text-xs bg-accent/10 text-accent rounded font-medium"
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
