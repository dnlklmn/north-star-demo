import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import Button from '../components/ui/Button'
import { ChatBubbleIcon } from '../components/ui/Icons'
import PolarisChat from './PolarisChat'

/**
 * Header-mounted Polaris agent button + popover.
 *
 * Mounted in the top bar of every page (Home + ProjectWorkspace). Click the
 * button → a popover anchored to the button opens with the chat. Click
 * outside or press Esc to close. The chat itself lives in the provider, so
 * closing and reopening preserves the transcript.
 *
 * Why not a rail panel: the right rail isn't available on every screen
 * (Home doesn't have one) and the rail itself is too narrow on some tabs.
 * A header-anchored popover gives us one consistent surface.
 */
export default function PolarisAgentButton() {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Click-outside + escape to close. Pointerdown rather than click so a
  // selection drag that ends outside doesn't dismiss the popover.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapperRef} className="relative">
      <Button
        size="small"
        variant="neutral"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <ChatBubbleIcon />
        Polaris agent
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Polaris agent"
          className="absolute top-full right-0 mt-2 w-[420px] h-[560px] z-50 bg-bg-default border border-border-hint shadow-2xl flex flex-col"
        >
          <div className="px-3 py-2 border-b border-border-hint flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-1.5">
              <ChatBubbleIcon />
              <span className="text-sm font-semibold text-fg-contrast">
                Polaris agent
              </span>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="p-1 hover:bg-fill-neutral/30 transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 flex flex-col">
            <PolarisChat />
          </div>
        </div>
      )}
    </div>
  )
}
