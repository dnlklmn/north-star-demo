/**
 * Underline component for keyboard shortcut hints
 */
export function KeyHint({ children }: { children: string }) {
  const first = children[0]
  const rest = children.slice(1)
  return (
    <>
      <span className="underline">{first}</span>{rest}
    </>
  )
}
