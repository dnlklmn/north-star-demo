import type { ReactNode } from "react";

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 overflow-x-auto border border-border-hint">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="bg-fill-neutral text-fg-contrast">{children}</thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return (
    <tbody className="divide-y divide-border-hint">{children}</tbody>
  );
}

export function TR({ children }: { children: ReactNode }) {
  return <tr>{children}</tr>;
}

export function TH({ children }: { children: ReactNode }) {
  return (
    <th className="text-left font-semibold px-3 py-2 align-top text-xs font-mono uppercase tracking-wide">
      {children}
    </th>
  );
}

export function TD({ children }: { children: ReactNode }) {
  return (
    <td className="px-3 py-2 align-top text-fg-contrast leading-6">
      {children}
    </td>
  );
}
