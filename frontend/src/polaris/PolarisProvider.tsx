import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { PolarisContext, PolarisNav } from '../api'
import {
  PolarisCtx,
  type PolarisCtxShape,
  type PolarisNavHandler,
} from './polarisContext'

/**
 * Polaris context bus.
 *
 * Tracks the `context` blob that's sent with every chat call (route,
 * session_id, dataset_id, phase, selected_example_id), and dispatches nav
 * tool results to whichever handler is registered. The provider owns
 * `home` / `project` (it has access to react-router's `navigate`); pages
 * register their own handlers for `phase`, `example`, `coverage_map`,
 * `settings`, `share`, etc.
 */
export function PolarisProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [contextSlice, setContextSliceState] = useState<PolarisContext>({})
  const handlersRef = useRef<Map<string, PolarisNavHandler>>(new Map())

  // Keep `context.route` in sync with the URL automatically — pages don't
  // have to remember to push it.
  const fullContext = useMemo<PolarisContext>(
    () => ({ ...contextSlice, route: location.pathname }),
    [contextSlice, location.pathname],
  )

  const setContextSlice = useCallback((slice: Partial<PolarisContext>) => {
    setContextSliceState(prev => {
      // Identity-preserving update — when nothing changed, return the same
      // object so consumers don't re-render.
      let dirty = false
      const next = { ...prev }
      for (const k of Object.keys(slice) as (keyof PolarisContext)[]) {
        if (next[k] !== slice[k]) {
          dirty = true
          if (slice[k] === undefined) delete next[k]
          else (next as Record<string, unknown>)[k] = slice[k]
        }
      }
      return dirty ? next : prev
    })
  }, [])

  const registerNavHandler = useCallback(
    (target: string, handler: PolarisNavHandler) => {
      handlersRef.current.set(target, handler)
      return () => {
        // Only remove if it's still our handler — prevents a re-render race
        // from clearing a freshly-registered one.
        if (handlersRef.current.get(target) === handler) {
          handlersRef.current.delete(target)
        }
      }
    },
    [],
  )

  const dispatchNav = useCallback(
    (nav: PolarisNav) => {
      // Provider-owned defaults: `home` and `project` need `navigate`, which
      // is hooked into react-router and not available to leaf pages without
      // ceremony. Anything else falls through to a registered handler.
      if (nav.target === 'home') {
        navigate('/')
        return
      }
      if (nav.target === 'project') {
        const sid = nav.props?.session_id as string | undefined
        if (sid) navigate(`/project/${sid}`)
        return
      }
      const handler = handlersRef.current.get(nav.target)
      if (handler) handler(nav.props || {})
      else if (typeof window !== 'undefined' && import.meta.env.DEV) {
        console.warn(`[polaris] no handler for nav target "${nav.target}"`)
      }
    },
    [navigate],
  )

  const value = useMemo<PolarisCtxShape>(
    () => ({
      context: fullContext,
      setContextSlice,
      registerNavHandler,
      dispatchNav,
      open,
      setOpen,
    }),
    [fullContext, setContextSlice, registerNavHandler, dispatchNav, open],
  )

  return <PolarisCtx.Provider value={value}>{children}</PolarisCtx.Provider>
}
