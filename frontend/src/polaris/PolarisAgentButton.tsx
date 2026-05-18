import Button from '../components/ui/Button'
import { ChatBubbleIcon } from '../components/ui/Icons'
import { usePolaris } from './usePolaris'

/**
 * Header button that toggles the Polaris sidebar.
 *
 * The sidebar itself is mounted at the app root (PolarisSidebar) and lives
 * next to the routes in a flex row — opening it pushes the page content in
 * rather than overlaying it. Open state lives in the provider so the
 * button doesn't need to know where the sidebar is mounted, and so other
 * surfaces (e.g. keyboard shortcut) can open it too.
 */
export default function PolarisAgentButton() {
  const { open, setOpen } = usePolaris()
  return (
    <Button
      size="small"
      variant="neutral"
      onClick={() => setOpen(v => !v)}
      aria-expanded={open}
      aria-controls="polaris-sidebar"
    >
      <ChatBubbleIcon />
      Polaris agent
    </Button>
  )
}
