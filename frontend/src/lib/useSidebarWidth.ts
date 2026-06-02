import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Shared resize state for the right-rail sidebar. Used by both
 * PanelLayout (Seed / Goals / Stories / Scorers / Evaluate) and the
 * dataset workspace's SeedSidebar so resizing on any page persists
 * to localStorage and is picked up by every other page on its next
 * mount — and live within the current tab via a custom event.
 *
 * Constants are exported so callers that want to render a fixed
 * stand-in (e.g. an empty placeholder) can match the chrome exactly.
 */
export const SIDEBAR_DEFAULT_WIDTH = 360
export const SIDEBAR_MIN_WIDTH = 280
export const SIDEBAR_MAX_WIDTH = 600
const STORAGE_KEY = 'ns:suggestions-width'
const CHANGE_EVENT = 'northstar:sidebar-width-changed'

function clamp(n: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, n))
}

function readStored(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH
  const stored = window.localStorage.getItem(STORAGE_KEY)
  const parsed = stored ? Number(stored) : NaN
  return Number.isFinite(parsed) ? clamp(parsed) : SIDEBAR_DEFAULT_WIDTH
}

/**
 * Returns `[width, startResize, isResizing]`. `startResize` is a
 * `mousedown` handler that begins a drag — once the user releases, the
 * new width is persisted to localStorage and broadcast to other
 * listeners in the same tab via a `CustomEvent` so split-pane layouts
 * stay in sync without a remount. `isResizing` is exposed so callers
 * can style the drag handle (e.g. an "active" tint while dragging).
 */
export function useSidebarWidth(): [
  number,
  (e: React.MouseEvent) => void,
  boolean,
] {
  const [width, setWidth] = useState<number>(readStored)
  const [isResizing, setIsResizing] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  // Listen for width changes initiated elsewhere — another panel in the
  // same tab (CustomEvent) or another tab (storage event).
  useEffect(() => {
    const onCustom = (e: Event) => {
      const next = (e as CustomEvent<number>).detail
      if (typeof next === 'number' && Number.isFinite(next)) {
        setWidth(clamp(next))
      }
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return
      const parsed = Number(e.newValue)
      if (Number.isFinite(parsed)) setWidth(clamp(parsed))
    }
    window.addEventListener(CHANGE_EVENT, onCustom)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(CHANGE_EVENT, onCustom)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  // Run the drag — same shape as the previous PanelLayout-local impl,
  // but persistence + broadcast happen on mouseup.
  useEffect(() => {
    if (!isResizing) return
    const handleMove = (e: MouseEvent) => {
      const s = dragRef.current
      if (!s) return
      // Sidebar lives on the right edge → resize handle on its LEFT
      // edge. Dragging left grows the sidebar; subtract clientX from
      // startX so positive delta = wider.
      const delta = s.startX - e.clientX
      setWidth(clamp(s.startWidth + delta))
    }
    const handleUp = () => {
      dragRef.current = null
      setIsResizing(false)
      // Read the latest committed width via the functional updater so
      // we don't snapshot a stale value (state may not have flushed yet
      // between the last move and this up). Persist + broadcast the
      // final value to other listeners.
      setWidth(current => {
        try {
          window.localStorage.setItem(STORAGE_KEY, String(current))
          window.dispatchEvent(
            new CustomEvent<number>(CHANGE_EVENT, { detail: current }),
          )
        } catch {
          // Storage unavailable (private mode, quota) — width simply
          // isn't persisted across reloads.
        }
        return current
      })
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [isResizing])

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startWidth: width }
    setIsResizing(true)
  }, [width])

  return [width, startResize, isResizing]
}
