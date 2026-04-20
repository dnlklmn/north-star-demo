import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
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
}

export default function SuggestionBox({
  label = "Suggestions",
  onRefresh,
  loading,
  emptyText,
  children,
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
      ) : emptyText ? (
        <p className="text-sm text-fg-dim">{emptyText}</p>
      ) : null}
    </div>
  );
}
