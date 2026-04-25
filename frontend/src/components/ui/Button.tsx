import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "neutral";
type Size = "big" | "small";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /**
   * Optional keyboard shortcut glyph rendered inside a subtly-darker chip
   * after the label (e.g. `<ReturnKeyIcon />` or a `⌘+↵` span).
   */
  shortcut?: ReactNode;
  children: ReactNode;
}

/**
 * Geist-Mono, SemiBold buttons per the North Star design system.
 *
 * Sizes:
 *   big    — 56px tall, 16px padding, 16px font (use for primary footer actions)
 *   small  — 32px tall, 12px horizontal padding, 13px font (use for top bar, inline)
 *
 * Variants:
 *   primary — purple-700 → purple-800 on hover, text gray-75
 *   neutral — gray-100 (text gray-550) → gray-150 (text gray-900) on hover → gray-200 active
 */
export default function Button({
  variant = "neutral",
  size = "big",
  shortcut,
  className = "",
  children,
  ...rest
}: Props) {
  // `big` buttons get a 1px border in the app-bg colour. On panels the button
  // floats over content cards (fill-neutral) so the bg-coloured border reads
  // as a subtle halo that separates the button visually from what's behind.
  const sizeClasses =
    size === "big"
      ? "h-14 px-4 gap-2 text-base border border-bg-default"
      : "h-10 px-3 gap-1.5 text-sm";

  const variantClasses =
    variant === "primary"
      ? "bg-purple-700 text-gray-75 hover:bg-purple-800 active:bg-purple-600 disabled:bg-gray-100 disabled:text-gray-550"
      : "bg-gray-150 text-gray-900 hover:bg-gray-200 active:bg-gray-100 disabled:bg-gray-100 disabled:text-gray-550";

  // The shortcut chip is always one scale-step darker than the button surface
  // so it reads as a subtle keyboard-key indicator.
  const shortcutClasses =
    variant === "primary"
      ? "bg-purple-600 group-hover:bg-purple-700 group-active:bg-purple-500 group-disabled:bg-gray-75"
      : "bg-gray-100 group-hover:bg-gray-150 group-active:bg-gray-50 group-disabled:bg-gray-75";

  return (
    <button
      {...rest}
      className={[
        "group inline-flex items-center justify-center font-mono font-semibold",
        "transition-colors disabled:cursor-not-allowed",
        sizeClasses,
        variantClasses,
        className,
      ].join(" ")}
    >
      {children}
      {shortcut && (
        <span
          className={[
            "inline-flex items-center justify-center flex-shrink-0 transition-colors",
            size === "big" ? "h-6 min-w-[18px] px-1" : "h-5 min-w-[16px] px-1",
            shortcutClasses,
          ].join(" ")}
        >
          {shortcut}
        </span>
      )}
    </button>
  );
}
