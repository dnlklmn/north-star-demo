import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { Menu, X, ArrowRight } from "lucide-react";
import IconButton from "../ui/IconButton";
import { StarIcon } from "../ui/Icons";
import { DOCS_NAV, type DocsNavSection } from "./nav";

interface Props {
  children: ReactNode;
}

export default function DocsLayout({ children }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close drawer on Escape — matches the rest of the app's modal pattern
  // (see Home.tsx menu behaviour).
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  return (
    <div className="h-full flex flex-col bg-bg-default text-fg-contrast">
      <DocsHeader
        mobileOpen={mobileOpen}
        onToggleMobile={() => setMobileOpen((v) => !v)}
      />
      <div className="flex-1 min-h-0 flex overflow-hidden relative">
        {mobileOpen && (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            className="md:hidden absolute inset-0 z-10 bg-black/40"
          />
        )}
        <DocsSidebar
          mobileOpen={mobileOpen}
          onNavigate={() => setMobileOpen(false)}
        />
        <main className="flex-1 min-w-0 overflow-auto">
          <div className="max-w-3xl mx-auto px-6 sm:px-10 py-10 sm:py-16">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

interface HeaderProps {
  mobileOpen: boolean;
  onToggleMobile: () => void;
}

function DocsHeader({ mobileOpen, onToggleMobile }: HeaderProps) {
  return (
    <header className="h-16 flex items-center justify-between px-4 flex-shrink-0 border-b border-border-hint">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="md:hidden inline-flex items-center justify-center w-10 h-10 text-fg-dim hover:text-fg-contrast transition-colors"
          onClick={onToggleMobile}
          aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? (
            <X className="w-4 h-4" />
          ) : (
            <Menu className="w-4 h-4" />
          )}
        </button>
        <Link to="/" aria-label="North Star home" className="inline-flex">
          <IconButton tone="contrast" aria-label="North Star">
            <StarIcon />
          </IconButton>
        </Link>
        <span className="font-mono text-sm text-fg-dim">/ docs</span>
      </div>
      <Link
        to="/"
        className="font-mono text-sm text-fg-dim hover:text-fg-contrast transition-colors inline-flex items-center gap-1.5"
      >
        Back to app
        <ArrowRight className="w-3.5 h-3.5" />
      </Link>
    </header>
  );
}

interface SidebarProps {
  mobileOpen: boolean;
  onNavigate: () => void;
}

function DocsSidebar({ mobileOpen, onNavigate }: SidebarProps) {
  return (
    <aside
      className={[
        "border-r border-border-hint bg-bg-default overflow-y-auto",
        "w-64 flex-shrink-0",
        // Mobile: absolute drawer that slides in from the left.
        // md+: static column, always on-screen.
        "absolute md:static inset-y-0 left-0 z-20 md:z-auto",
        mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        // Block focus entry into the off-screen drawer on mobile so Tab
        // doesn't jump into hidden content. md+ resets it.
        mobileOpen
          ? "pointer-events-auto"
          : "pointer-events-none md:pointer-events-auto",
        "transition-transform md:transition-none",
      ].join(" ")}
    >
      <nav className="py-6 px-4">
        {DOCS_NAV.map((section) => (
          <SidebarSection
            key={section.title}
            section={section}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </aside>
  );
}

interface SectionProps {
  section: DocsNavSection;
  onNavigate: () => void;
}

function SidebarSection({ section, onNavigate }: SectionProps) {
  return (
    <div className="mb-6">
      <div className="px-2 mb-2 text-xs font-mono uppercase tracking-wide text-fg-dim">
        {section.title}
      </div>
      <ul>
        {section.items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end
              onClick={onNavigate}
              className={({ isActive }) =>
                [
                  "block px-2 py-1.5 text-sm transition-colors",
                  isActive
                    ? "text-fg-contrast bg-fill-neutral"
                    : "text-fg-dim hover:text-fg-contrast",
                ].join(" ")
              }
            >
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}
