import type { ReactNode } from 'react'

/**
 * Wraps a disabled Polaris launcher so hover/focus surfaces an
 * explanation. Uses the same lightweight `title=` tooltip pattern the
 * rest of the codebase already relies on (see JudgeAgreementBadge,
 * EvaluatePanel) — no new dependency, screen-reader-accessible by
 * default, and works on inline-block wrappers when the inner button is
 * actually disabled (disabled buttons don't fire pointer events, so the
 * wrapper has to carry the tooltip).
 */
export const POLARIS_DISABLED_MESSAGE =
  'Polaris is disabled in the public playground. Available with your own API key or a North Star account (coming soon).'

export default function PolarisDisabledTooltip({
  children,
}: {
  children: ReactNode
}) {
  return (
    <span
      title={POLARIS_DISABLED_MESSAGE}
      className="inline-flex"
      aria-label={POLARIS_DISABLED_MESSAGE}
    >
      {children}
    </span>
  )
}
