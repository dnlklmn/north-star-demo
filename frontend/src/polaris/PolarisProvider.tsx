import {
  useCallback,
  useEffect,
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

  // Sidebar visibility — toggled by the header button, read by the
  // sidebar component. Lives here so any surface (button, keyboard
  // shortcut, programmatic) can open/close from the same state.
  const [open, setOpenState] = useState(false)
  const setOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setOpenState(prev => (typeof next === 'function' ? next(prev) : next))
    },
    [],
  )

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

  // Emit a route-level activity whenever the URL changes. First render is
  // silent (the user didn't navigate, they just landed). Provider lives
  // here because react-router's useLocation is available; pages would
  // otherwise each have to wire this for every route.
  const routeActivityFirstRenderRef = useRef(true)
  useEffect(() => {
    if (routeActivityFirstRenderRef.current) {
      routeActivityFirstRenderRef.current = false
      return
    }
    const path = location.pathname
    if (path === '/') {
      window.dispatchEvent(
        new CustomEvent('polaris:activity', {
          detail: { activity: 'returned to home' },
        }),
      )
    } else if (path.startsWith('/project/')) {
      window.dispatchEvent(
        new CustomEvent('polaris:activity', {
          detail: { activity: `opened project ${path.slice('/project/'.length, '/project/'.length + 8)}…` },
        }),
      )
    }
  }, [location.pathname])

  // Listen for `polaris:activity` events fired anywhere in the app and
  // append them to the transcript as muted "↳ X" markers. Lets the user
  // follow what's happening even when they're driving the UI by hand.
  // De-dupes runs of the same activity (e.g. an effect that fires twice
  // back-to-back) so the transcript stays clean.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ activity: string }>).detail
      const activity = detail?.activity?.trim()
      if (!activity) return
      setMessagesState(prev => {
        const last = prev[prev.length - 1]
        if (last && last.activity === activity) return prev
        return [...prev, { role: 'assistant', content: '', activity }]
      })
    }
    window.addEventListener('polaris:activity', handler)
    return () => window.removeEventListener('polaris:activity', handler)
  }, [])

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
      open,
      setOpen,
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
      open,
      setOpen,
      messages,
      setMessages,
      hydrateMessages,
      loading,
      error,
    ],
  )

  return <PolarisCtx.Provider value={value}>{children}</PolarisCtx.Provider>
}
