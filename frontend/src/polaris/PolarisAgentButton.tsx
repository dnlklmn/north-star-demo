import Button from '../components/ui/Button'
import { ChatBubbleIcon } from '../components/ui/Icons'
import { usePolaris } from './usePolaris'
import { useConfig } from '../playground/useConfig'
import PolarisDisabledTooltip from '../playground/PolarisDisabledTooltip'

/**
 * Header button that toggles the Polaris sidebar.
 *
 * The sidebar itself is mounted at the app root (PolarisSidebar) and lives
 * next to the routes in a flex row — opening it pushes the page content in
 * rather than overlaying it. Open state lives in the provider so the
 * button doesn't need to know where the sidebar is mounted, and so other
 * surfaces (e.g. keyboard shortcut) can open it too.
 *
 * When the deployment has Polaris disabled (`/config.polaris_enabled ===
 * false`), the button renders disabled and is wrapped in a tooltip that
 * explains why. While config is loading (`null`), behave normally — a
 * slow /config response should never hide a feature the user has access
 * to in a private deployment.
 */
export default function PolarisAgentButton() {
  const { open, setOpen } = usePolaris()
  const config = useConfig()
  const disabled = config?.polaris_enabled === false

  const button = (
    <Button
      size="small"
      variant="neutral"
      onClick={() => setOpen(v => !v)}
      aria-expanded={open}
      aria-controls="polaris-sidebar"
      disabled={disabled}
    >
      <ChatBubbleIcon />
      Polaris agent
    </Button>
  )

  return disabled ? <PolarisDisabledTooltip>{button}</PolarisDisabledTooltip> : button
}
