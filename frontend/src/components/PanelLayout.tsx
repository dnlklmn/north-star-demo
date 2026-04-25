import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AIIcon } from "./ui/Icons";

interface Props {
  title: string;
  subtitle?: string;
  /** Bottom section of the main column, pinned below scrollable content (same style as sidebar bottom). */
  footer?: ReactNode;
  /** Right rail top section (e.g. RadarChart). Optional, shown with border-b when present. */
  rightTop?: ReactNode;
  /** Right rail middle section (e.g. Suggestions panel). Flex-grows to fill remaining height. */
  right?: ReactNode;
  /** Right rail bottom section (e.g. AI Assist button). Shown with border-t. */
  rightBottom?: ReactNode;
  /** When set, the bottom section fills remaining height, rightTop is hidden,
   *  and Suggestions collapses to a clickable header above the bottom panel. */
  rightBottomExpanded?: ReactNode;
  children: ReactNode;
}

const DEFAULT_RIGHT_WIDTH = 360;
const MIN_RIGHT_WIDTH = 280;
const MAX_RIGHT_WIDTH = 600;

export default function PanelLayout({
  title,
  subtitle,
  footer,
  rightTop,
  right,
  rightBottom,
  rightBottomExpanded,
  children,
}: Props) {
  const [rightWidth, setRightWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_RIGHT_WIDTH;
    const stored = window.localStorage.getItem("ns:suggestions-width");
    const parsed = stored ? Number(stored) : NaN;
    return Number.isFinite(parsed)
      ? Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, parsed))
      : DEFAULT_RIGHT_WIDTH;
  });
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );
  const [isResizing, setIsResizing] = useState(false);
  // When rightBottomExpanded is active, collapse Suggestions by default so
  // Polaris fills the rail from just below the suggestions header.
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);

  useEffect(() => {
    if (!isResizing) return;
    const handleMove = (e: MouseEvent) => {
      const s = dragStateRef.current;
      if (!s) return;
      const delta = s.startX - e.clientX;
      const next = Math.min(
        MAX_RIGHT_WIDTH,
        Math.max(MIN_RIGHT_WIDTH, s.startWidth + delta),
      );
      setRightWidth(next);
    };
    const handleUp = () => {
      dragStateRef.current = null;
      setIsResizing(false);
      try {
        window.localStorage.setItem("ns:suggestions-width", String(rightWidth));
      } catch {}
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isResizing, rightWidth]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: rightWidth };
    setIsResizing(true);
  };

  return (
    <div className="flex-1 flex min-h-0 gap-6">
      {/* Main column — stretches freely */}
      <div className="flex-1 min-w-0 relative">
        <div className="absolute inset-0 overflow-y-auto py-6">
          <h2 className="text-2xl font-medium text-fg-contrast">{title}</h2>
          {subtitle && (
            <p className="text-base text-fg-dim mt-1 mb-12">{subtitle}</p>
          )}
          {!subtitle && <div className="mb-12" />}
          {children}
          {/* Spacer so content can scroll past the floating footer */}
          {footer && <div className="h-28" />}
        </div>

        {/* Floating footer — overlays bottom-right of scroll area */}
        {footer && (
          <div className="absolute bottom-8 right-8 pointer-events-auto">
            {footer}
          </div>
        )}
      </div>

      {/* Right rail — always reserved, resizable, border on left */}
      <aside
        style={{ width: `${rightWidth}px` }}
        className="relative flex-shrink-0 border-l border-border-hint flex flex-col"
      >
        {/* Drag handle — sits on the left edge, slightly inset for easier grabbing */}
        <div
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize suggestions panel"
          className={`absolute top-0 bottom-0 -left-[3px] w-[6px] cursor-col-resize z-10 ${
            isResizing ? "bg-purple-700/30" : "hover:bg-purple-700/20"
          } transition-colors`}
        />

        {/* Top section (e.g. RadarChart) — hidden when Polaris is expanded */}
        {rightTop && !rightBottomExpanded && (
          <div className="p-6 border-b border-border-hint flex-shrink-0">
            {rightTop}
          </div>
        )}

        {rightBottomExpanded ? (
          <>
            {/* Suggestions — collapsed header by default; expand on click */}
            {right && (
              <div className="border-b border-border-hint flex-shrink-0 flex flex-col min-h-0">
                <button
                  onClick={() => setSuggestionsOpen((v) => !v)}
                  className="flex items-center gap-1.5 px-6 py-6 w-full text-left hover:bg-fill-neutral/30 transition-colors flex-shrink-0"
                  aria-expanded={suggestionsOpen}
                >
                  <AIIcon />
                  <span className="text-base font-semibold text-fg-contrast">
                    Suggestions
                  </span>
                </button>
                {suggestionsOpen && (
                  <div className="max-h-[40vh] overflow-y-auto px-6 pb-6">
                    {right}
                  </div>
                )}
              </div>
            )}
            {/* Bottom-expanded — fills remaining height */}
            <div className="flex-1 min-h-0 flex flex-col">
              {rightBottomExpanded}
            </div>
          </>
        ) : (
          <>
            {/* Middle section (e.g. Suggestions) — stretches to fill */}
            {right && (
              <div className="flex-1 overflow-y-auto p-6">{right}</div>
            )}

            {/* Bottom section (e.g. AI Assist button) */}
            {rightBottom && (
              <div className="border-t border-border-hint flex-shrink-0">
                {rightBottom}
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
