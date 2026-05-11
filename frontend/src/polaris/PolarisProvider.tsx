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
  type PolarisMessage,
  type PolarisNavHandler,
} from './polarisContext'

/**
 * Polaris context bus.
 *
 * Tracks the `context` blob that's sent with every chat call (route,
 * session_id, dataset_id, phase, selected_example_id), owns the
 * conversation transcript, and dispatches nav tool results.
 */
export function PolarisProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [contextSlice, setContextSliceState] = useState<PolarisContext>({})
  const handlersRef = useRef<Map<string, PolarisNavHandler>>(new Map())

  // Conversation lives in the provider so the rail and the (future) panel
  // chat inputs are the same transcript. Hydrated by whichever page mounts
  // first via `hydrateMessages`.
  const [messages, setMessagesState] = useState<PolarisMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setMessages = useCallback(
    (next: PolarisMessage[] | ((prev: PolarisMessage[]) => PolarisMessage[])) => {
      setMessagesState(prev => (typeof next === 'function' ? next(prev) : next))
    },
    [],
  )

  const hydrateMessages = useCallback((initial: PolarisMessage[]) => {
    // Only replace if the incoming history isn't already what we're showing.
    // Avoids clobbering an in-flight conversation when the project page
    // re-mounts (e.g. tab switch triggers a state refetch).
    setMessagesState(prev => {
      if (prev.length === 0 && initial.length > 0) return initial
      return prev
    })
  }, [])

  // Keep `context.route` in sync with the URL automatically — pages don't
  // have to remember to push it.
  const fullContext = useMemo<PolarisContext>(
    () => ({ ...contextSlice, route: location.pathname }),
    [contextSlice, location.pathname],
  )

  const setContextSlice = useCallback((slice: Partial<PolarisContext>) => {
    setContextSliceState(prev => {
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
        if (handlersRef.current.get(target) === handler) {
          handlersRef.current.delete(target)
        }
      }
    },
    [],
  )

  const dispatchNav = useCallback(
    (nav: PolarisNav) => {
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
      messages,
      setMessages,
      hydrateMessages,
      loading,
      setLoading,
      error,
      setError,
    }),
    [
      fullContext,
      setContextSlice,
      registerNavHandler,
      dispatchNav,
      messages,
      setMessages,
      hydrateMessages,
      loading,
      error,
    ],
  )

  return <PolarisCtx.Provider value={value}>{children}</PolarisCtx.Provider>
}
