import { useEffect, useRef } from 'react'
import { API_BASE } from '../api'
import { getShareToken } from '../shareToken'

/**
 * Subscribe to the backend's per-session SSE feed and re-fetch session state
 * whenever a `state_changed` event fires. The backend emits an initial
 * `hello` event (carrying the resolved access role) and periodic `: ping`
 * comments to keep the connection alive — both of those are no-ops here;
 * only `state_changed` triggers the parent's reload callback.
 *
 * EventSource auto-reconnects on transient drops. We layer a short manual
 * backoff for hard errors (e.g. server restart) so we don't spin a tight
 * reconnect loop that hammers the server. After MAX_RETRIES consecutive
 * failures we give up and log a warning — better than burning battery on a
 * dead server or a revoked share token.
 */
const MAX_RETRIES = 10

/** Payload of a `synth_progress` SSE event — fired during dataset
 *  synthesis as cells complete. The frontend reads it to drive the
 *  "X of N rows generated" copy in the dataset regeneration overlay. */
export interface SynthProgressEvent {
  dataset_id: string
  generated: number
  total: number
  phase: 'started' | 'in_progress' | 'done'
}

export function useProjectEvents(
  sessionId: string | null,
  onStateChange: () => void,
  onSynthProgress?: (event: SynthProgressEvent) => void,
): void {
  // Hold the latest callbacks in refs so we can keep the EventSource open
  // across renders without resubscribing every time the parent rebuilds the
  // closure. Re-subscribing flickers the live feed and causes spurious
  // reconnect chatter on the server.
  const cbRef = useRef(onStateChange)
  useEffect(() => {
    cbRef.current = onStateChange
  }, [onStateChange])
  const synthRef = useRef(onSynthProgress)
  useEffect(() => {
    synthRef.current = onSynthProgress
  }, [onSynthProgress])

  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    let reconnectTimer: number | null = null
    let backoffMs = 1000
    let retries = 0

    const scheduleReconnect = () => {
      if (cancelled) return
      if (reconnectTimer !== null) return
      if (retries >= MAX_RETRIES) {
        console.warn(
          `[useProjectEvents] giving up after ${MAX_RETRIES} reconnect attempts ` +
            `(session ${sessionId}). Server may be down or share token revoked.`,
        )
        return
      }
      retries += 1
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        backoffMs = Math.min(backoffMs * 2, 30000)
        connect()
      }, backoffMs)
    }

    const connect = () => {
      if (cancelled) return
      // Re-read the share token fresh on each connect so a navigation that
      // changed the URL gets the right credentials on the new EventSource.
      const token = getShareToken()
      const url = token
        ? `${API_BASE}/sessions/${sessionId}/events?token=${encodeURIComponent(token)}`
        : `${API_BASE}/sessions/${sessionId}/events`

      // Bind each EventSource to its own scoped local. The `onerror` handler
      // closes over `mine`, NOT a shared mutable reference, so a late error
      // from a closed-and-replaced stream can't accidentally tear down its
      // successor.
      let mine: EventSource
      try {
        mine = new EventSource(url)
      } catch (err) {
        console.error('Failed to open EventSource:', err)
        scheduleReconnect()
        return
      }
      esRef.current = mine

      mine.addEventListener('hello', () => {
        // Stream opened cleanly — reset backoff + retry counter so the next
        // hard failure starts from 1s again, and the retry cap doesn't carry
        // over from earlier transient blips.
        backoffMs = 1000
        retries = 0
      })

      mine.addEventListener('state_changed', () => {
        try {
          cbRef.current()
        } catch (err) {
          console.error('state_changed handler threw:', err)
        }
      })

      // Per-cell dataset synthesis progress. Optional — older callers that
      // only pass `onStateChange` see no behaviour change.
      mine.addEventListener('synth_progress', (e: MessageEvent) => {
        const cb = synthRef.current
        if (!cb) return
        try {
          const payload = JSON.parse(e.data || '{}') as SynthProgressEvent
          cb(payload)
        } catch (err) {
          console.error('synth_progress handler threw:', err)
        }
      })

      mine.onerror = () => {
        // EventSource will retry by itself on a transient blip, but if the
        // connection actually closed we close + reschedule with backoff.
        // Guard with `esRef.current === mine` so a stale errored stream
        // can't clobber a newer one that already replaced it.
        if (mine.readyState === EventSource.CLOSED) {
          mine.close()
          if (esRef.current === mine) {
            esRef.current = null
          }
          scheduleReconnect()
        }
      }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      esRef.current?.close()
      esRef.current = null
    }
  }, [sessionId])
}
