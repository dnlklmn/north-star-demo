import React from 'react'

/**
 * Format text with better structure: line breaks, lists, paragraphs
 */
export function formatWithLineBreaks(text: string): React.ReactNode {
  // First split by double newlines (paragraphs)
  const paragraphs = text.split(/\n\n+/)

  return paragraphs.map((para, pIdx) => {
    // Check if this paragraph is a list
    const lines = para.split(/\n/)
    const isList = lines.every(line =>
      /^[\s]*[-•*]/.test(line) || /^[\s]*\d+[.)]/.test(line) || line.trim() === ''
    )

    if (isList && lines.length > 1) {
      // Render as list
      return (
        <div key={pIdx} className="my-2">
          {lines.filter(l => l.trim()).map((line, lIdx) => (
            <div key={lIdx} className="pl-2 py-0.5">
              {line.trim()}
            </div>
          ))}
        </div>
      )
    }

    // For regular text, split on sentences
    const sentences = para.split(/(?<=[.!?])\s+/)

    return (
      <div key={pIdx} className={pIdx > 0 ? 'mt-3' : ''}>
        {sentences.map((sentence, sIdx) => (
          <span key={sIdx}>
            {sentence.trim()}
            {sIdx < sentences.length - 1 && (
              <>
                <br />
              </>
            )}
          </span>
        ))}
      </div>
    )
  })
}

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
