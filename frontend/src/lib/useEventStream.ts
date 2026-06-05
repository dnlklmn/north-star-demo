import { useEffect, useRef, useState } from 'react'

/**
 * Typed SSE hook for long-running endpoints (build orchestration,
 * self-improvement loops, prod call streams).
 *
 * Subscribes to `url` via `EventSource` and accumulates parsed events
 * into a list. Generic over the event payload type so each track can
 * narrow it (e.g. `useEventStream<LoopRoundEvent>`).
 *
 * Behavior:
 * - Open → status 'open'
 * - Server emits a message → parsed via JSON and pushed to `events`
 * - Transient error → status 'reconnecting'; the underlying
 *   `EventSource` reconnects automatically; we report it through `error`
 *   and clear when the next message arrives.
 * - Caller passes `null`/`undefined` for `url` to pause/disable the
 *   subscription without unmounting (useful while inputs are loading).
 *
 * `parser` lets callers override how the message data becomes T. The
 * default is `JSON.parse`. If `parser` throws, the message is dropped
 * and `error` is set so the UI can surface it instead of crashing.
 *
 * `withCredentials` enables cookies on the SSE request — needed when
 * the backend lives behind a session-cookie auth boundary.
 */
export type EventStreamStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'error'

export interface UseEventStreamOptions<T> {
  /** Override default `JSON.parse(data)`. */
  parser?: (raw: string) => T
  /** Send cookies with the SSE request. Default false. */
  withCredentials?: boolean
  /** Cap on retained events to avoid unbounded memory growth. Default 500. */
  maxEvents?: number
  /** Called whenever an event is received — useful for side effects
   *  like auto-scrolling without re-reading the full list. */
  onEvent?: (event: T) => void
  /** Optional named event types to listen for in addition to the
   *  default unnamed `message` channel. SSE servers can emit
   *  `event: round` etc.; pass `['round', 'done']` to capture them. */
  namedEvents?: string[]
}

export interface UseEventStreamResult<T> {
  events: T[]
  status: EventStreamStatus
  error: string | null
  /** Imperative reset — clears events and reopens the stream. */
  reset: () => void
}

export function useEventStream<T>(
  url: string | null | undefined,
  options: UseEventStreamOptions<T> = {},
): UseEventStreamResult<T> {
  const {
    parser,
    withCredentials = false,
    maxEvents = 500,
    onEvent,
    namedEvents,
  } = options

  const [events, setEvents] = useState<T[]>([])
  const [status, setStatus] = useState<EventStreamStatus>(url ? 'connecting' : 'idle')
  const [error, setError] = useState<string | null>(null)
  const [resetTick, setResetTick] = useState(0)

  // Latest callback refs so we don't reopen the EventSource on each render.
  // The assignments live in an effect because React 19's `react-hooks/refs`
  // rule disallows mutating `ref.current` during render. The semantics
  // ("update to the latest after every render") are unchanged — the effect
  // runs after the commit, before the next EventSource event triggers a
  // handler that reads through the ref.
  const parserRef = useRef(parser)
  const onEventRef = useRef(onEvent)
  useEffect(() => {
    parserRef.current = parser
    onEventRef.current = onEvent
  })

  // Effect-scoped setState calls below are derived from the `url` prop, not
  // from external state — the lint rule's "this may cascade" concern doesn't
  // apply (each effect returns immediately after setting state and only
  // re-runs when `url` changes). Inline-disable rather than rewrite — the
  // status transitions are the whole point of this hook.
  useEffect(() => {
    if (!url) {
      setStatus('idle') // eslint-disable-line react-hooks/set-state-in-effect
      return
    }
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      setStatus('error')
      setError('EventSource not available in this environment')
      return
    }

    let cancelled = false
    setStatus('connecting')
    setError(null)

    const es = new EventSource(url, { withCredentials })

    const handleMessage = (raw: MessageEvent) => {
      if (cancelled) return
      try {
        const parsed = parserRef.current
          ? parserRef.current(raw.data)
          : (JSON.parse(raw.data) as T)
        setEvents(prev => {
          const next = prev.length >= maxEvents ? prev.slice(prev.length - maxEvents + 1) : prev
          return [...next, parsed]
        })
        setStatus('open')
        setError(null)
        onEventRef.current?.(parsed)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    }

    es.onopen = () => {
      if (cancelled) return
      setStatus('open')
      setError(null)
    }
    es.onmessage = handleMessage
    // EventSource reconnects automatically after a transient error.
    // Surface the disrupted state to the UI but don't tear down — the
    // next successful message flips status back to 'open'.
    es.onerror = () => {
      if (cancelled) return
      if (es.readyState === EventSource.CLOSED) {
        setStatus('closed')
      } else {
        setStatus('reconnecting')
      }
    }

    if (namedEvents) {
      for (const name of namedEvents) {
        es.addEventListener(name, handleMessage as EventListener)
      }
    }

    return () => {
      cancelled = true
      es.close()
    }
  }, [url, withCredentials, maxEvents, resetTick, namedEvents])

  const reset = () => {
    setEvents([])
    setError(null)
    setResetTick(t => t + 1)
  }

  return { events, status, error, reset }
}
