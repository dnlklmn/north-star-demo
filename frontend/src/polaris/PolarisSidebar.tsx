import { X } from 'lucide-react'
import { ChatBubbleIcon } from '../components/ui/Icons'
import PolarisChat from './PolarisChat'
import { usePolaris } from './usePolaris'

/**
 * Polaris sidebar — the agent's chat surface. Mounted at the app root in a
 * flex row alongside the routes, so opening it pushes the page content in
 * (rather than overlaying it). Closed by default; toggled by the header
 * button or programmatically via `usePolaris().setOpen`.
 *
 * Sized at 420px; the page gets `flex-1` so it reflows automatically.
 */
export default function PolarisSidebar() {
  const { open, setOpen } = usePolaris()
  if (!open) return null
  return (
    <aside
      id="polaris-sidebar"
      aria-label="Polaris agent"
      className="w-[420px] flex-shrink-0 border-l border-border-hint bg-bg-default flex flex-col min-h-0"
    >
      <header className="h-16 px-4 border-b border-border-hint flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <ChatBubbleIcon />
          <span className="text-sm font-semibold text-fg-contrast">
            Polaris agent
          </span>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="p-1 hover:bg-fill-neutral/30 transition-colors"
          aria-label="Close Polaris"
        >
          <X className="w-4 h-4" />
        </button>
      </header>
      <div className="flex-1 min-h-0 flex flex-col">
        <PolarisChat />
      </div>
    </aside>
  )
}
