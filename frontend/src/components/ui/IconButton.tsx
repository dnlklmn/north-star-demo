import type { ButtonHTMLAttributes, ReactNode } from 'react'

type IdleTone = 'dim' | 'contrast'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Resting color of the icon.
   *   'dim'      — foreground-dim (gray-550) idle → foreground-contrast (gray-900) hover
   *   'contrast' — foreground-contrast (gray-900) idle → foreground-primary (purple-700) hover
   */
  tone?: IdleTone
  /**
   * The icon element. Keep it at its natural size (e.g. 16x16);
   * the hit area is provided by the button padding.
   */
  children: ReactNode
}

/**
 * A square icon button with a generous hit area (40x40) around a small icon.
 * No background by default — only color animates on hover.
 */
export default function IconButton({
  tone = 'dim',
  className = '',
  children,
  ...rest
}: Props) {
  const toneClasses =
    tone === 'dim'
      ? 'text-fg-dim hover:text-fg-contrast'
      : 'text-fg-contrast hover:text-fg-primary'

  return (
    <button
      {...rest}
      className={[
        'inline-flex items-center justify-center',
        'w-10 h-10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
        toneClasses,
        className,
      ].join(' ')}
    >
      {children}
    </button>
  )
}
