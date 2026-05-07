/**
 * In-memory cache for session lists, session records, and datasets.
 *
 * No persistence — entries live until the tab reloads. Goal is to make
 * intra-session navigation feel instant: render from cache on mount, then
 * issue a fresh fetch in the background and swap the result in once it
 * lands. SSE updates and explicit mutation paths refresh entries as they
 * happen, so cached values are usually within seconds of the server.
 *
 * Caches are intentionally typed as `unknown`-ish to avoid pulling
 * frontend-only React types into the utility layer; callers cast at the
 * boundary (api.ts already returns concrete types).
 */

import type { Dataset, ProjectSummary, SessionState } from '../types'

interface SessionRecord {
  session_id: string
  state: SessionState
  conversation: Array<{ role: string; content: string }>
  // Backend may attach a name + access_role on the response payload —
  // preserve them as a passthrough so consumers see the same shape getSession
  // returns.
  name?: string
  _access?: { role: 'owner' | 'editor' | 'viewer' }
}

const sessionsListCache = { value: null as ProjectSummary[] | null }
const sessionCache = new Map<string, SessionRecord>()
const datasetCache = new Map<string, Dataset>()

export function getCachedSessionsList(): ProjectSummary[] | null {
  return sessionsListCache.value
}

export function setCachedSessionsList(list: ProjectSummary[]): void {
  sessionsListCache.value = list
}

export function getCachedSession(sessionId: string): SessionRecord | null {
  return sessionCache.get(sessionId) ?? null
}

export function setCachedSession(sessionId: string, record: SessionRecord): void {
  sessionCache.set(sessionId, record)
}

export function getCachedDataset(sessionId: string): Dataset | null {
  return datasetCache.get(sessionId) ?? null
}

export function setCachedDataset(sessionId: string, dataset: Dataset): void {
  datasetCache.set(sessionId, dataset)
}

/** Wipe a single project from the cache — called when the user deletes it
 *  so a stale cached row can't reappear after the next listSessions() runs. */
export function evictSession(sessionId: string): void {
  sessionCache.delete(sessionId)
  datasetCache.delete(sessionId)
}
