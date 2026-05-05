import type { ShareRole } from './types'

// --- Share token ---
// Always read fresh from `window.location.search` so navigations between
// projects (some with `?shareToken=…`, some without) don't bleed a stale
// token captured at module-load time. EventSource subscriptions and
// `apiHeaders()` re-call `getShareToken()` on every use, so picking up the
// current URL each time is correct.

export function getShareToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const t = new URLSearchParams(window.location.search).get('shareToken')
    return t && t.trim() ? t.trim() : null
  } catch {
    return null
  }
}

// `setShareToken` is kept as a no-op compatibility shim for any caller that
// still tries to push the token in. The source of truth is the URL.
export function setShareToken(_t: string | null): void {
  // intentionally empty — token is derived from window.location on every read
}

// --- Access role pub/sub ---
// Role is keyed by sessionId so a role resolved for project A doesn't
// "stick" when the user navigates to project B. The first session GET for
// each project populates the role; until then, a project opened with a
// share token reads as `null` (unknown), and one opened without reads as
// `'owner'`.

type RoleListener = (role: ShareRole | null) => void

const rolesBySession: Map<string, ShareRole> = new Map()
let currentSessionId: string | null = null
const roleListeners: Set<RoleListener> = new Set()

function defaultRoleForCurrentToken(): ShareRole | null {
  return getShareToken() ? null : 'owner'
}

function computeCurrentRole(): ShareRole | null {
  if (currentSessionId && rolesBySession.has(currentSessionId)) {
    return rolesBySession.get(currentSessionId) ?? null
  }
  return defaultRoleForCurrentToken()
}

export function getAccessRole(): ShareRole | null {
  return computeCurrentRole()
}

/**
 * Switch the "active" sessionId. The role listeners fire with the role
 * remembered for that session, falling back to the URL-derived default.
 * Call this from the workspace whenever the rendered sessionId changes.
 */
export function setActiveSessionId(sessionId: string | null): void {
  if (sessionId === currentSessionId) return
  currentSessionId = sessionId
  notify()
}

/**
 * Stamp the role for a specific session (called from `getSession()` after
 * the backend returns `_access.role`). If this session is the active one,
 * listeners fire.
 */
export function setAccessRole(sessionId: string, role: ShareRole | null): void {
  if (role === null) {
    rolesBySession.delete(sessionId)
  } else {
    rolesBySession.set(sessionId, role)
  }
  if (sessionId === currentSessionId) {
    notify()
  }
}

function notify(): void {
  const role = computeCurrentRole()
  for (const cb of roleListeners) {
    try {
      cb(role)
    } catch (err) {
      console.error('access role listener failed:', err)
    }
  }
}

export function subscribeAccessRole(cb: RoleListener): () => void {
  roleListeners.add(cb)
  return () => {
    roleListeners.delete(cb)
  }
}
