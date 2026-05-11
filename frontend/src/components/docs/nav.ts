export interface DocsNavItem {
  to: string;
  label: string;
}

export interface DocsNavSection {
  title: string;
  items: DocsNavItem[];
}

export const DOCS_NAV: DocsNavSection[] = [
  {
    title: "Start here",
    items: [
      { to: "/docs", label: "Overview" },
      { to: "/docs/concepts", label: "Concepts" },
      { to: "/docs/getting-started", label: "Getting started" },
    ],
  },
  {
    title: "Using North Star",
    items: [{ to: "/docs/workspace", label: "Workspace tour" }],
  },
  {
    title: "Under the hood",
    items: [
      { to: "/docs/agent", label: "Agent internals" },
      { to: "/docs/evals", label: "Evals & monitoring" },
      { to: "/docs/reference", label: "Reference" },
    ],
  },
];
