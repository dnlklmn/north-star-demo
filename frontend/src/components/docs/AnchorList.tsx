interface Anchor {
  id: string;
  label: string;
}

interface Props {
  anchors: Anchor[];
}

/**
 * Inline table-of-contents for long pages. Renders as a simple bullet list of
 * jump links — placed near the top of a page so the user can survey the
 * sections before scrolling.
 */
export default function AnchorList({ anchors }: Props) {
  return (
    <nav
      aria-label="On this page"
      className="border border-border-hint bg-fill-neutral p-4 mb-10"
    >
      <div className="text-xs font-mono uppercase tracking-wide text-fg-dim mb-2">
        On this page
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {anchors.map((a) => (
          <li key={a.id}>
            <a
              href={`#${a.id}`}
              className="text-fg-dim hover:text-fg-primary transition-colors"
            >
              {a.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
