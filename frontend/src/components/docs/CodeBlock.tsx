import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

interface Props {
  children: ReactNode;
  /** Plain-text source — used by the copy button. Defaults to `children` when it's a string. */
  source?: string;
  /** Optional label rendered top-right, e.g. "bash" or "python". */
  language?: string;
}

export default function CodeBlock({ children, source, language }: Props) {
  const [copied, setCopied] = useState(false);
  const text = source ?? (typeof children === "string" ? children : "");

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. http: in older browsers) — silently
      // skip; the user can still select the text.
    }
  };

  return (
    <div className="relative group mb-4">
      {language && (
        <span className="absolute top-2 right-12 font-mono text-[10px] uppercase tracking-wide text-fg-dim">
          {language}
        </span>
      )}
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy code"
        className="absolute top-2 right-2 inline-flex items-center justify-center w-7 h-7 text-fg-dim hover:text-fg-contrast bg-fill-neutral hover:bg-fill-neutral-hover transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        {copied ? (
          <Check className="w-3.5 h-3.5" />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
      </button>
      <pre className="bg-gray-100 text-fg-contrast text-xs leading-6 p-4 overflow-x-auto font-mono whitespace-pre">
        {children}
      </pre>
    </div>
  );
}
