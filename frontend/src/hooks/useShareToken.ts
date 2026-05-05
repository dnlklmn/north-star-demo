import { useEffect, useState } from 'react'
import {
  getAccessRole,
  getShareToken,
  setActiveSessionId,
  subscribeAccessRole,
} from '../shareToken'
import type { ShareRole } from '../types'

/**
 * Read-only view of the current share token + access role for components.
 * Re-renders when the role flips (e.g. from null → 'viewer' after the
 * session GET resolves).
 *
 * Pass the current `sessionId` so the hook can scope role lookups by
 * project — preventing the role for project A from leaking into project B
 * when the user navigates between sessions in the same browser tab. Until
 * the next `getSession()` populates the role for the new project, callers
 * see the URL-derived default ('owner' if no `?shareToken`, else `null`).
 */
export function useShareToken(sessionId?: string | null): { token: string | null; role: ShareRole | null } {
  // Activate the session as soon as the hook mounts / sessionId changes so
  // pub/sub subscribers see the right role immediately on first render.
  if (sessionId !== undefined) {
    setActiveSessionId(sessionId ?? null)
  }
  const [role, setRole] = useState<ShareRole | null>(getAccessRole())

  useEffect(() => {
    if (sessionId !== undefined) {
      setActiveSessionId(sessionId ?? null)
    }
    // Sync to current value on activation in case the role for this session
    // was already resolved by a prior fetch.
    setRole(getAccessRole())
    return subscribeAccessRole(setRole)
  }, [sessionId])

  return { token: getShareToken(), role }
}
