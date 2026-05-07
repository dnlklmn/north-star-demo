import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import Button from "./ui/Button";
import IconButton from "./ui/IconButton";
import { RefreshIcon, DismissIcon, PlusIcon, AIIcon } from "./ui/Icons";

/* ── SuggestionCard ── */

interface CardProps {
  onAccept: () => void;
  onDismiss: () => void;
  children: ReactNode;
}

export function SuggestionCard({ onAccept, onDismiss, children }: CardProps) {
  return (
    <div className="py-4 flex flex-col gap-3">
      <div className="text-base text-fg-contrast leading-[1.5]">{children}</div>
      <div className="flex items-center gap-4">
        <button
          onClick={onDismiss}
          className="flex items-center gap-1.5 text-base font-mono font-semibold text-fg-dim hover:text-fg-contrast transition-colors"
        >
          <DismissIcon />
          Dismiss
        </button>
        <button
          onClick={onAccept}
          className="flex items-center gap-1.5 text-base font-mono font-semibold text-fg-dim hover:text-fg-contrast transition-colors"
        >
          <PlusIcon />
          Add
        </button>
      </div>
    </div>
  );
}

/* ── SuggestionBox ── */

interface BoxProps {
  label?: string;
  onRefresh?: () => void;
  loading?: boolean;
  emptyText?: string;
  children?: ReactNode;
  /** When true, render a prominent "Get suggestions" button in the empty
   *  state next to (instead of) the empty-text placeholder. Used when the
   *  user has opted out of automatic suggestion fetches and needs an
   *  explicit affordance to trigger one. */
  showGetButton?: boolean;
  /** Label override for the get-suggestions button (e.g. "Get story
   *  suggestions"). Defaults to "Get suggestions". */
  getButtonLabel?: string;
}

export default function SuggestionBox({
  label = "Suggestions",
  onRefresh,
  loading,
  emptyText,
  children,
  showGetButton = false,
  getButtonLabel = "Get suggestions",
}: BoxProps) {
  const hasContent = !!children;
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <AIIcon
            className={
              hasContent || loading ? "text-fg-primary" : "text-fg-dim"
            }
          />
          <span className="text-base font-semibold text-fg-contrast">
            {label}
          </span>
        </div>
        {onRefresh && (
          <IconButton
            tone="dim"
            onClick={onRefresh}
            disabled={loading}
            title="Refresh"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshIcon />
            )}
          </IconButton>
        )}
      </div>
      {hasContent ? (
        <div className="divide-y divide-border-hint">{children}</div>
      ) : loading ? (
        <div className="py-4">
          <Loader2 className="w-4 h-4 text-fg-dim animate-spin mx-auto mb-2" />
          <p className="text-sm text-fg-dim text-center">Generating…</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {emptyText && <p className="text-sm text-fg-dim">{emptyText}</p>}
          {showGetButton && onRefresh && (
            <Button size="small" variant="neutral" onClick={onRefresh}>
              {getButtonLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
