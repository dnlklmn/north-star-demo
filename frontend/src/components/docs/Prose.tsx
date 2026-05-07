import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Long-form prose container for docs pages. Centralises typography so every
 * page reads the same — heading sizes, list spacing, link colour, code style.
 */
export function Prose({ children }: { children: ReactNode }) {
  return <article>{children}</article>;
}

export function H1({ children }: { children: ReactNode }) {
  return (
    <h1 className="text-3xl font-semibold text-fg-contrast tracking-tight mb-3">
      {children}
    </h1>
  );
}

export function Lede({ children }: { children: ReactNode }) {
  return (
    <p className="text-lg text-fg-dim leading-relaxed mb-10">{children}</p>
  );
}

export function H2({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="text-xl font-semibold text-fg-contrast mt-12 mb-3 scroll-mt-20"
    >
      {children}
    </h2>
  );
}

export function H3({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3
      id={id}
      className="text-base font-semibold text-fg-contrast mt-8 mb-2 scroll-mt-20"
    >
      {children}
    </h3>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="text-sm text-fg-contrast leading-7 mb-4">{children}</p>;
}

export function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="text-sm text-fg-contrast leading-7 mb-4 ml-5 list-disc space-y-1 marker:text-fg-dim">
      {children}
    </ul>
  );
}

export function OL({ children }: { children: ReactNode }) {
  return (
    <ol className="text-sm text-fg-contrast leading-7 mb-4 ml-5 list-decimal space-y-1 marker:text-fg-dim">
      {children}
    </ol>
  );
}

export function LI({ children }: { children: ReactNode }) {
  return <li>{children}</li>;
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[0.85em] bg-fill-neutral text-fg-contrast px-1.5 py-0.5">
      {children}
    </code>
  );
}

export function Strong({ children }: { children: ReactNode }) {
  return (
    <strong className="font-semibold text-fg-contrast">{children}</strong>
  );
}

interface DocLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to?: string;
  href?: string;
  children: ReactNode;
}

export function A({ to, href, children, ...rest }: DocLinkProps) {
  const className =
    "text-fg-primary hover:text-fg-contrast underline underline-offset-2 transition-colors";
  if (to) {
    return (
      <Link to={to} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href}
      className={className}
      target="_blank"
      rel="noopener noreferrer"
      {...rest}
    >
      {children}
    </a>
  );
}

export function HR() {
  return <hr className="my-10 border-border-hint" />;
}
