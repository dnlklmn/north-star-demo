import type { ReactNode } from 'react'

interface Props {
  title: string
  /** Left side of subheader (before title), e.g. back button */
  headerLeft?: ReactNode
  /** Right side of subheader, e.g. action buttons */
  headerRight?: ReactNode
  /** Content in the left 1/4 area (e.g. radar chart) */
  left?: ReactNode
  /** Content in the right 1/4 area (e.g. suggestion box) */
  right?: ReactNode
  children: ReactNode
}

export default function PanelLayout({
  title,
  headerLeft,
  headerRight,
  left,
  right,
  children,
}: Props) {
  return (
    <div className="flex flex-col h-full">
      {/* Subheader */}
      <div className="px-4 h-12 border-b border-border bg-surface-raised flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          {headerLeft}
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        </div>
        {headerRight && (
          <div className="flex items-center gap-2">
            {headerRight}
          </div>
        )}
      </div>

      {/* 1/4 — 1/2 — 1/4 content area */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex items-start">
          <div className="w-1/4 flex-shrink-0 flex justify-end pr-12">
            {left}
          </div>
          <div className="w-1/2 min-w-0">
            {children}
          </div>
          <div className="w-1/4 flex-shrink-0 pl-12">
            {right}
          </div>
        </div>
      </div>
    </div>
  )
}
