import { useContext, useEffect, useRef } from 'react'
import { PolarisCtx, type PolarisCtxShape, type PolarisNavHandler } from './polarisContext'
import type { PolarisContext } from '../api'

export function usePolaris(): PolarisCtxShape {
  const ctx = useContext(PolarisCtx)
  if (!ctx) throw new Error('usePolaris must be used within <PolarisProvider>')
  return ctx
}

/**
 * Pages call this with their current slice so the chat knows where the user
 * is. The cleanup clears the slice on unmount so a stale session_id can't
 * leak across route changes — that's why it doesn't depend on `pathname`.
 */
export function useRegisterPolarisContext(slice: Partial<PolarisContext>) {
  const { setContextSlice } = usePolaris()
  // Stringify so callers can pass a fresh object literal every render
  // without thrashing the effect.
  const key = JSON.stringify(slice)
  useEffect(() => {
    setContextSlice(slice)
    const fields = Object.keys(slice) as (keyof PolarisContext)[]
    return () => {
      // Clear only the fields we set, not the whole context (other pages
      // may have set sibling fields).
      const cleanup: Partial<PolarisContext> = {}
      for (const f of fields) cleanup[f] = undefined
      setContextSlice(cleanup)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

/**
 * Pages register a handler for a specific nav target — e.g. ProjectWorkspace
 * owns `phase`, `example`, `coverage_map`, `settings`, `share`. The provider
 * itself owns `home` and `project` (it has react-router's `navigate`).
 */
export function useRegisterPolarisNav(target: string, handler: PolarisNavHandler) {
  const { registerNavHandler } = usePolaris()
  const handlerRef = useRef(handler)
  // Refresh the latest handler in an effect (not during render) so closures
  // captured during dispatch see the newest props.
  useEffect(() => {
    handlerRef.current = handler
  })
  useEffect(() => {
    return registerNavHandler(target, props => handlerRef.current(props))
  }, [target, registerNavHandler])
}
