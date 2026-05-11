import type { ActivityEvent, CreateSessionResponse, CreateSkillVersionRequest, CreatedShareToken, EvalMode, EvalRunSummary, RunEvalRequest, SendMessageResponse, SessionState, ShareTokenSummary, SkillReferenceKind, SkillReferenceSummary, SkillVersion, SuggestImprovementsResponse, Charter, Dataset, Example, GapAnalysis, Settings, DetectSchemaResponse, ImportFromUrlResponse, InferSchemaResponse, ProjectSummary, StoryGroup, ScorerDef } from './types'
import { getShareToken, setAccessRole } from './shareToken'

export const API_BASE = import.meta.env.VITE_API_URL || '/api'
const BASE = API_BASE

// --- API Key management (localStorage) ---

const API_KEY_STORAGE_KEY = 'northstar_anthropic_api_key'

export function getApiKey(): string {
  return localStorage.getItem(API_KEY_STORAGE_KEY) || ''
}

export function setApiKey(key: string): void {
  if (key.trim()) {
    localStorage.setItem(API_KEY_STORAGE_KEY, key.trim())
  } else {
    localStorage.removeItem(API_KEY_STORAGE_KEY)
  }
}

export function hasApiKey(): boolean {
  return !!getApiKey()
}

// Braintrust API key — stored separately from Anthropic. Only sent on eval-run
// requests. Lives in localStorage so runs survive page reloads.

const BRAINTRUST_KEY_STORAGE_KEY = 'northstar_braintrust_api_key'

export function getBraintrustApiKey(): string {
  return localStorage.getItem(BRAINTRUST_KEY_STORAGE_KEY) || ''
}

export function setBraintrustApiKey(key: string): void {
  if (key.trim()) {
    localStorage.setItem(BRAINTRUST_KEY_STORAGE_KEY, key.trim())
  } else {
    localStorage.removeItem(BRAINTRUST_KEY_STORAGE_KEY)
  }
}

export function hasBraintrustApiKey(): boolean {
  return !!getBraintrustApiKey()
}

// GitHub Personal Access Token — optional. Used by the skill-fetch-from-url
// endpoint to bump rate limits and access private repos. Phase 1 (public-repo
// fetch) works without it; kept here so Phase 3 (push PR) can reuse the same
// storage.

const GITHUB_TOKEN_STORAGE_KEY = 'northstar_github_token'

export function getGithubToken(): string {
  return localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || ''
}

export function setGithubToken(key: string): void {
  if (key.trim()) {
    localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, key.trim())
  } else {
    localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY)
  }
}

// --- Fetch wrapper that attaches API key header ---

function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  const key = getApiKey()
  if (key) {
    headers['X-Anthropic-Key'] = key
  }
  // Share token: set when the user opened the project from a "?shareToken=…"
  // URL. Backend resolves it to a viewer/editor role for this session; absent
  // header → owner (the default before sharing existed).
  const shareToken = getShareToken()
  if (shareToken) {
    headers['X-Share-Token'] = shareToken
  }
  return headers
}

/**
 * Global event fired when the backend reports an LLM billing failure (out
 * of credits, missing payment method). A top-level banner in App listens
 * for this and shows itself with provider-specific copy. We use a plain
 * CustomEvent to avoid threading state through every component that calls
 * the API.
 */
export interface LLMBillingErrorDetail {
  provider: string
  message: string
  /** True when the failed request did not carry an X-Anthropic-Key header,
   *  i.e. it relied on the server's default key. The banner uses this to
   *  show "(server's default key)" vs "(your key)" so the user knows which
   *  account to look at when topping up credits. */
  usingDefaultKey: boolean
}

export const LLM_BILLING_EVENT = 'northstar:llm-billing'

/**
 * Global event a component dispatches when it wants to open the Settings
 * panel from outside the project workspace (e.g. the LLMBillingBanner's
 * "Change key" button). ProjectWorkspace listens and flips its
 * showSettings state.
 */
export const OPEN_SETTINGS_EVENT = 'northstar:open-settings'

/**
 * Global event fired when a write attempt is rejected because the current
 * share token is read-only. A top-level banner / toast listens and shows a
 * friendly message — components that triggered the call still receive a
 * normal Error so their local catch can revert optimistic UI.
 */
export interface ShareForbiddenDetail {
  message: string
}

export const SHARE_FORBIDDEN_EVENT = 'northstar:share-forbidden'

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  // Cold-start auto-retry: GETs (and OPTIONS) are idempotent so a single
  // retry after a short wait absorbs a Render free-tier dyno wake-up
  // (~30s) without surfacing the error. Mutations (POST/PATCH/DELETE)
  // stay manual to avoid duplicate side effects — the user is shown the
  // retry message and can re-click. We retry once only; back-to-back
  // failures still surface so a real outage isn't masked.
  const method = (init?.method || "GET").toUpperCase()
  const idempotent = method === "GET" || method === "HEAD" || method === "OPTIONS"
  const fetchOnce = () =>
    fetch(url, {
      ...init,
      headers: {
        ...apiHeaders(),
        ...(init?.headers as Record<string, string> || {}),
      },
    })

  let res: Response
  try {
    res = await fetchOnce()
  } catch (err) {
    // Browsers throw a generic `TypeError: Failed to fetch` for any
    // network-level failure (DNS, CORS, blocked, server cold-starting on
    // free-tier hosting, offline).
    if (err instanceof TypeError && idempotent) {
      // Wait long enough for Render's free dyno to finish spinning up
      // before retrying. Anything shorter would just hit the same cold
      // server and burn a retry slot on it.
      await new Promise((r) => setTimeout(r, 8000))
      try {
        res = await fetchOnce()
      } catch (retryErr) {
        if (retryErr instanceof TypeError) {
          throw new Error(
            "Couldn't reach the server. The backend may be cold-starting (give it ~30s) or your connection dropped — try again.",
          )
        }
        throw retryErr
      }
    } else if (err instanceof TypeError) {
      throw new Error(
        "Couldn't reach the server. The backend may be cold-starting (give it ~30s) or your connection dropped — try again.",
      )
    } else {
      throw err
    }
  }
  if (res.status === 401) {
    let body: { detail?: string; provider?: string; error?: string } = {}
    try { body = await res.clone().json() } catch { /* not JSON */ }
    if (body.error === 'llm_auth') {
      const provider = body.provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'
      throw new Error(
        `${provider} rejected the API key: ${body.detail || 'auth failed'}. ` +
        `Check the API key in Settings.`,
      )
    }
    throw new Error('Invalid or missing API key. Please add your API key in Settings.')
  }
  if (res.status === 422) {
    // 422 specifically for "model id not found / not entitled" — the auth
    // is fine, the model name doesn't resolve. Distinct copy from 401 so
    // the user looks at the model selector, not the key field.
    let body: { detail?: string; provider?: string; error?: string } = {}
    try { body = await res.clone().json() } catch { /* not JSON */ }
    if (body.error === 'llm_model') {
      const provider = body.provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'
      throw new Error(
        `${provider} doesn't recognize the selected model: ${body.detail || 'model not found'}. ` +
        `Pick a different model in Settings — your key is fine.`,
      )
    }
    // Fall through to default Response handling for non-LLM 422s
    // (validation errors etc.).
  }
  if (res.status === 403) {
    // Viewer attempted a write. Broadcast so a banner/toast can react, then
    // throw a normal Error so the caller's catch path can still revert any
    // optimistic state. The detail message is best-effort — server may
    // simply have returned a JSON {detail} or nothing at all.
    let body: { detail?: string } = {}
    try { body = await res.clone().json() } catch { /* not JSON */ }
    const message = body.detail || 'You have read-only access to this project.'
    try {
      window.dispatchEvent(
        new CustomEvent<ShareForbiddenDetail>(SHARE_FORBIDDEN_EVENT, { detail: { message } }),
      )
    } catch {
      // SSR or other env without window — non-fatal.
    }
    throw new Error(message)
  }
  if (res.status === 402) {
    // Provider rejected the call for billing reasons. Read the body once,
    // broadcast a global event so the banner can show, and re-throw with a
    // friendly message so the caller's catch can still handle it.
    let body: { detail?: string; provider?: string; error?: string } = {}
    try { body = await res.clone().json() } catch { /* not JSON */ }
    const provider = body.provider || 'anthropic'
    const message = body.detail || 'The LLM provider rejected the call for billing reasons.'
    // The frontend can determine which key was in play locally — we sent
    // the X-Anthropic-Key header iff the user has a key in localStorage.
    const usingDefaultKey = !getApiKey()
    try {
      window.dispatchEvent(
        new CustomEvent<LLMBillingErrorDetail>(LLM_BILLING_EVENT, {
          detail: { provider, message, usingDefaultKey },
        }),
      )
    } catch {
      // SSR or other env without window — non-fatal.
    }
    throw new Error(message)
  }
  return res
}

// --- Health check ---

export async function checkHealth(): Promise<{ status: string; has_default_api_key: boolean }> {
  const res = await apiFetch(`${BASE}/health`)
  if (!res.ok) return { status: 'error', has_default_api_key: false }
  return res.json()
}

// --- Scorers persistence ---

export async function saveScorers(sessionId: string, scorers: Array<{ name: string; type: string; description: string; code: string }>): Promise<void> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/scorers`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scorers }),
  })
  if (!res.ok) throw new Error(`Failed to save scorers: ${res.status}`)
}

export async function generateScorers(sessionId: string): Promise<{ scorers: ScorerDef[] }> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/generate-scorers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`Failed to generate scorers: ${res.status}`)
  return res.json()
}

/** Returns the Mustache-templated prompt body for a single scorer, ready to
 *  paste into Braintrust's online-scorer editor. Includes the trigger
 *  filter expression for prompt-eval projects (skill-eval projects have no
 *  natural live filter; `filter` comes back null and the user picks one). */
export async function getBraintrustScorerPrompt(
  sessionId: string,
  scorerName: string,
): Promise<{ name: string; prompt: string; filter: string | null }> {
  const res = await apiFetch(
    `${BASE}/sessions/${sessionId}/scorers/${encodeURIComponent(scorerName)}/braintrust-prompt`,
  )
  if (!res.ok) {
    let detail = `Failed to build Braintrust prompt (${res.status})`
    try {
      const j = await res.json()
      if (j?.detail) detail = j.detail
    } catch {
      /* fallthrough */
    }
    throw new Error(detail)
  }
  return res.json()
}

// --- Project / Session management ---

export async function listSessions(): Promise<{ sessions: ProjectSummary[] }> {
  const res = await apiFetch(`${BASE}/sessions`)
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`)
  const data = await res.json()
  // Backend returns a plain array; wrap it
  return { sessions: Array.isArray(data) ? data : data.sessions ?? [] }
}

export async function createSession(input: {
  business_goals?: string
  user_stories?: string
  name?: string
  goals?: string[]
  story_groups?: StoryGroup[]
}): Promise<CreateSessionResponse> {
  const res = await apiFetch(`${BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      initial_input: {
        business_goals: input.business_goals || null,
        user_stories: input.user_stories || null,
        conversation_history: [],
        goals: input.goals,
        story_groups: input.story_groups,
      },
      name: input.name,
    }),
  })
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`)
  return res.json()
}

export async function updateSessionName(
  sessionId: string,
  name: string
): Promise<void> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/name`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`Failed to rename session: ${res.status}`)
}

export async function updateSessionInput(
  sessionId: string,
  input: { goals?: string[]; story_groups?: StoryGroup[] }
): Promise<void> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/input`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to save input: ${res.status}`)
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`Failed to delete session: ${res.status}`)
}

export async function sendMessage(
  sessionId: string,
  message: string,
  options?: { regenerate?: boolean }
): Promise<SendMessageResponse> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, regenerate: options?.regenerate ?? false }),
  })
  if (!res.ok) throw new Error(`Failed to send message: ${res.status}`)
  return res.json()
}

export async function getSession(
  sessionId: string
): Promise<{ session_id: string; state: SessionState; conversation: Array<{ role: string; content: string }> }> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}`)
  if (!res.ok) throw new Error(`Failed to get session: ${res.status}`)
  const data = await res.json()
  // Backend stamps _access on every authenticated session response based on
  // the share-token header (or absence of one). Mirror it into the role
  // pub/sub so panel-level edit gating can react without prop-drilling.
  const access = data?.state?._access
  if (access?.role) {
    setAccessRole(sessionId, access.role)
  }
  return data
}

// --- Share tokens ---

export async function createShareToken(
  sessionId: string,
  role: 'viewer' | 'editor',
  label?: string,
): Promise<CreatedShareToken> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/share-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, label: label?.trim() || null }),
  })
  if (!res.ok) {
    let detail = `Failed to create share token (${res.status})`
    try {
      const j = await res.json()
      if (j?.detail) detail = j.detail
    } catch { /* not JSON */ }
    throw new Error(detail)
  }
  return res.json()
}

export async function listShareTokens(sessionId: string): Promise<ShareTokenSummary[]> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/share-tokens`)
  if (!res.ok) throw new Error(`Failed to list share tokens: ${res.status}`)
  return res.json()
}

export async function revokeShareToken(sessionId: string, tokenId: string): Promise<void> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/share-tokens/${tokenId}`, {
    method: 'DELETE',
  })
  if (!res.ok && res.status !== 204) throw new Error(`Failed to revoke share token: ${res.status}`)
}

export async function getActivity(
  sessionId: string,
  after?: string
): Promise<{ activity: ActivityEvent[] }> {
  const url = after
    ? `${BASE}/sessions/${sessionId}/activity?after=${encodeURIComponent(after)}`
    : `${BASE}/sessions/${sessionId}/activity`
  const res = await apiFetch(url)
  if (!res.ok) throw new Error(`Failed to get activity: ${res.status}`)
  return res.json()
}

export async function setSessionMode(
  sessionId: string,
  mode: EvalMode
): Promise<{ eval_mode: EvalMode; state: SessionState }> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/mode`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eval_mode: mode }),
  })
  if (!res.ok) throw new Error(`Failed to set mode: ${res.status}`)
  return res.json()
}

export interface PromptTargetInfo {
  target: string
  label: string
  builder_name: string
  description?: string
  source_path?: string | null
  /** Rendered prompt template with placeholder text marking the variable
   *  parts. Used to pre-fill the prompt-eval modal so the user can review
   *  and tweak before creating the session. */
  prompt_text?: string
}

export async function listPromptTargets(): Promise<PromptTargetInfo[]> {
  const res = await apiFetch(`${BASE}/prompt-targets`)
  if (!res.ok) throw new Error(`Failed to list prompt targets: ${res.status}`)
  return res.json()
}

export interface CreatePromptEvalResponse {
  session_id: string
  prompt_target: string
  rows_sampled: number
  rows_deduped: number
  dataset_id: string
  message: string
}

export async function createPromptEvalSession(input: {
  prompt_target: string
  name?: string
  sample_size?: number
  /** Optional override of the prompt body fed to the seed pass. None / empty
   *  falls back to the registered prompt's rendered text. */
  prompt_body?: string
}): Promise<CreatePromptEvalResponse> {
  const res = await apiFetch(`${BASE}/sessions/prompt-eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    let detail = `Failed to create prompt eval (${res.status})`
    try {
      const j = await res.json()
      if (j?.detail) detail = j.detail
    } catch { /* body wasn't JSON */ }
    throw new Error(detail)
  }
  return res.json()
}

export async function seedFromSkill(
  sessionId: string,
  body: { skill_body: string; skill_name?: string; skill_description?: string }
): Promise<{ state: SessionState; message: string }> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/skill-seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Failed to seed from skill: ${res.status}`)
  return res.json()
}

export interface FetchSkillFromUrlResponse {
  body: string
  name: string | null
  description: string | null
  source: {
    owner: string
    repo: string
    ref: string
    path: string
    blob_sha: string
  }
}

/** Fetch + validate a SKILL.md from a public GitHub URL. Does not mutate the
 *  session — caller hands the body back to `seedFromSkill` to run Analyze. */
export async function fetchSkillFromUrl(url: string): Promise<FetchSkillFromUrlResponse> {
  const token = getGithubToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['X-Github-Token'] = token
  const res = await apiFetch(`${BASE}/fetch-skill-from-url`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url }),
  })
  if (!res.ok) {
    // Surface the backend's HTTPException.detail so the user sees the real
    // error ("File not found", "rate-limited", etc.).
    let detail = `Failed to fetch SKILL.md (${res.status})`
    try {
      const j = await res.json()
      if (j?.detail) detail = j.detail
    } catch { /* body wasn't JSON, keep default */ }
    throw new Error(detail)
  }
  return res.json()
}

export async function runEval(
  sessionId: string,
  req: RunEvalRequest
): Promise<EvalRunSummary> {
  const braintrustKey = getBraintrustApiKey()
  if (!braintrustKey) {
    throw new Error('Braintrust API key required. Add it in the Evaluations tab.')
  }
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/run-eval`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Braintrust-Key': braintrustKey,
    },
    body: JSON.stringify(req),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Failed to start eval run: ${res.status}`)
  }
  return res.json()
}

export async function getEvalRun(
  sessionId: string,
  runId: string
): Promise<EvalRunSummary> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/eval-runs/${runId}`)
  if (!res.ok) throw new Error(`Failed to fetch eval run: ${res.status}`)
  return res.json()
}

export async function listEvalRuns(
  sessionId: string
): Promise<EvalRunSummary[]> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/eval-runs`)
  if (!res.ok) throw new Error(`Failed to list eval runs: ${res.status}`)
  return res.json()
}

// --- Skill versioning + improvement suggestions ---

export async function listSkillVersions(sessionId: string): Promise<SkillVersion[]> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/skill-versions`)
  if (!res.ok) throw new Error(`Failed to list skill versions: ${res.status}`)
  return res.json()
}

export async function createSkillVersion(
  sessionId: string,
  req: CreateSkillVersionRequest
): Promise<SkillVersion> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/skill-versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Failed to create skill version: ${res.status}`)
  }
  return res.json()
}

export async function restoreSkillVersion(
  sessionId: string,
  versionId: string
): Promise<SkillVersion> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/skill-versions/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version_id: versionId }),
  })
  if (!res.ok) throw new Error(`Failed to restore skill version: ${res.status}`)
  return res.json()
}

export async function cancelEvalRun(
  sessionId: string,
  runId: string,
): Promise<EvalRunSummary> {
  const res = await apiFetch(
    `${BASE}/sessions/${sessionId}/eval-runs/${runId}/cancel`,
    { method: 'POST' },
  )
  if (!res.ok) throw new Error(`Failed to cancel eval run: ${res.status}`)
  return res.json()
}

export async function promoteSkillVersion(
  sessionId: string,
  versionId: string,
  opts: { refreshReferences?: boolean } = {},
): Promise<SkillVersion> {
  // Backend accepts an absent body (legacy callers); only include one when
  // the caller explicitly opted out of the default refresh, so the simple
  // "promote" path stays a bare POST.
  const init: RequestInit = { method: 'POST' }
  if (opts.refreshReferences === false) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify({ refresh_references: false })
  }
  const res = await apiFetch(
    `${BASE}/sessions/${sessionId}/skill-versions/${versionId}/promote`,
    init,
  )
  if (!res.ok) throw new Error(`Failed to promote skill version: ${res.status}`)
  return res.json()
}

export async function listSkillReferences(
  sessionId: string,
): Promise<SkillReferenceSummary[]> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/skill-references`)
  if (!res.ok) throw new Error(`Failed to list skill references: ${res.status}`)
  const data: { references: SkillReferenceSummary[] } = await res.json()
  return data.references
}

export async function regenerateSkillReference(
  sessionId: string,
  kind: SkillReferenceKind,
): Promise<SkillReferenceSummary> {
  const res = await apiFetch(
    `${BASE}/sessions/${sessionId}/skill-references/${kind}/regenerate`,
    { method: 'POST' },
  )
  if (!res.ok) throw new Error(`Failed to regenerate ${kind}: ${res.status}`)
  return res.json()
}

export async function discardSkillVersion(
  sessionId: string,
  versionId: string,
): Promise<SkillVersion> {
  const res = await apiFetch(
    `${BASE}/sessions/${sessionId}/skill-versions/${versionId}/discard`,
    { method: 'POST' },
  )
  if (!res.ok) throw new Error(`Failed to discard skill version: ${res.status}`)
  return res.json()
}

export async function suggestImprovements(
  sessionId: string,
  runId: string
): Promise<SuggestImprovementsResponse> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/suggest-improvements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id: runId }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Failed to suggest improvements: ${res.status}`)
  }
  return res.json()
}

export async function exportForSkillCreator(
  datasetId: string
): Promise<{
  dataset_id: string
  session_id: string
  skill_name: string | null
  skill_description: string | null
  rows: Array<{ prompt: string; should_trigger: boolean; tags: string[]; notes: string | null }>
  counts: { total: number; should_trigger: number; should_not_trigger: number }
}> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/export/skill-creator`)
  if (!res.ok) throw new Error(`Failed to export for skill-creator: ${res.status}`)
  return res.json()
}

export async function proceedToReview(
  sessionId: string
): Promise<{ agent_status: string; state: SessionState }> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/proceed`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Failed to proceed: ${res.status}`)
  return res.json()
}

export async function patchCharter(
  sessionId: string,
  patch: Partial<Charter>
): Promise<{ state: SessionState }> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/charter`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`Failed to patch charter: ${res.status}`)
  return res.json()
}

export async function validateCharter(
  sessionId: string
): Promise<{ validation: import('./types').Validation; state: SessionState }> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/validate`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Failed to validate: ${res.status}`)
  return res.json()
}

export async function suggestForCharter(
  sessionId: string
): Promise<{ suggestions: import('./types').Suggestion[]; suggested_stories: import('./types').SuggestedStory[] }> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/suggest`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Failed to suggest: ${res.status}`)
  return res.json()
}

export async function evaluateGoals(
  goals: string[],
  sessionId?: string | null,
): Promise<{ feedback: Array<{ goal: string; issue: string | null; suggestion: string | null }> }> {
  const res = await apiFetch(`${BASE}/evaluate-goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goals, session_id: sessionId ?? null }),
  })
  if (!res.ok) throw new Error(`Failed to evaluate goals: ${res.status}`)
  return res.json()
}

export async function suggestGoals(
  goals: string[],
  sessionId?: string | null,
): Promise<{ suggestions: string[] }> {
  const res = await apiFetch(`${BASE}/suggest-goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goals, session_id: sessionId ?? null }),
  })
  if (!res.ok) throw new Error(`Failed to suggest goals: ${res.status}`)
  return res.json()
}

export async function suggestStories(
  goals: string[],
  stories: Array<{ who: string; what: string; why: string }>,
  sessionId?: string | null,
): Promise<{ suggestions: Array<{ who: string; what: string; why: string }> }> {
  const res = await apiFetch(`${BASE}/suggest-stories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goals, stories, session_id: sessionId ?? null }),
  })
  if (!res.ok) throw new Error(`Failed to suggest stories: ${res.status}`)
  return res.json()
}

export async function generateSkillFromGoals(
  sessionId: string,
): Promise<{ body: string; name: string | null; description: string | null }> {
  const res = await apiFetch(
    `${BASE}/sessions/${sessionId}/generate-skill-from-goals`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    },
  )
  if (!res.ok) {
    let detail = `Failed to generate skill (${res.status})`
    try {
      const j = await res.json()
      if (j?.detail) detail = j.detail
    } catch { /* not JSON */ }
    throw new Error(detail)
  }
  return res.json()
}

export interface SkillSuggestion {
  summary: string
  where: string | null
}

export interface ScorerIdea {
  summary: string
  type: string | null
}

export async function suggestScorerIdeas(
  sessionId: string,
): Promise<{ suggestions: ScorerIdea[] }> {
  const res = await apiFetch(
    `${BASE}/sessions/${sessionId}/suggest-scorer-ideas`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
  )
  if (!res.ok) {
    let detail = `Failed to suggest scorer ideas (${res.status})`
    try {
      const j = await res.json()
      if (j?.detail) detail = j.detail
    } catch { /* not JSON */ }
    throw new Error(detail)
  }
  return res.json()
}

export async function suggestSkill(
  goals: string[],
  stories: Array<{ who: string; what: string; why: string }>,
  currentBody: string | null,
  sessionId?: string | null,
): Promise<{ suggestions: SkillSuggestion[] }> {
  const res = await apiFetch(`${BASE}/suggest-skill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goals,
      stories,
      current_body: currentBody ?? null,
      session_id: sessionId ?? null,
    }),
  })
  if (!res.ok) throw new Error(`Failed to suggest skill: ${res.status}`)
  return res.json()
}

export async function finalizeCharter(
  sessionId: string
): Promise<{ charter_id: string; session_id: string; charter: Charter }> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/finalize`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Failed to finalize: ${res.status}`)
  return res.json()
}

// --- Dataset API ---

export async function createDataset(sessionId: string, name?: string): Promise<Dataset> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/dataset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`Failed to create dataset: ${res.status}`)
  return res.json()
}

export async function getDataset(sessionId: string): Promise<Dataset> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/dataset`)
  if (!res.ok) throw new Error(`Failed to get dataset: ${res.status}`)
  return res.json()
}

export async function importExamples(
  datasetId: string,
  examples: Array<{ input: string; expected_output: string; feature_area?: string; label?: string }>
): Promise<{ imported: number; stats: Dataset['stats'] }> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ examples }),
  })
  if (!res.ok) throw new Error(`Failed to import: ${res.status}`)
  return res.json()
}

export async function synthesizeExamples(
  datasetId: string,
  options?: { feature_areas?: string[]; coverage_criteria?: string[]; count_per_scenario?: number }
): Promise<{ generated: number; examples: Example[]; stats: Dataset['stats'] }> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options || {}),
  })
  if (!res.ok) throw new Error(`Failed to synthesize: ${res.status}`)
  return res.json()
}

export async function updateExample(
  datasetId: string,
  exampleId: string,
  fields: Partial<Example>
): Promise<Example> {
  // Hard timeout — without this an unresponsive backend leaves the user
  // staring at a spinner forever. 15s is generous for a single PATCH;
  // anything slower is a hung process or a stuck connection pool.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await apiFetch(`${BASE}/datasets/${datasetId}/examples/${exampleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Failed to update example: ${res.status}`)
    return res.json()
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Request timed out (15s). Backend may be unresponsive — try restarting.')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

export async function addExample(
  datasetId: string,
  example: { feature_area: string; input: string; expected_output: string; coverage_tags?: string[]; label?: string }
): Promise<Example> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/examples`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(example),
  })
  if (!res.ok) throw new Error(`Failed to add example: ${res.status}`)
  return res.json()
}

export async function deleteExample(datasetId: string, exampleId: string): Promise<void> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/examples/${exampleId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`Failed to delete example: ${res.status}`)
}

export async function autoReviewExamples(datasetId: string): Promise<{ reviewed: number; reviews: Array<{ example_id: string; suggested_label: string; confidence: string; reasoning: string }> }> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/review`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Failed to review: ${res.status}`)
  return res.json()
}

export async function refreshDatasetFromTurns(
  datasetId: string,
): Promise<{ added: number; total: number; message: string }> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/refresh-from-turns`, {
    method: 'POST',
  })
  if (!res.ok) {
    let detail = `Failed to refresh from turns (${res.status})`
    try {
      const j = await res.json()
      if (j?.detail) detail = j.detail
    } catch { /* not json */ }
    throw new Error(detail)
  }
  return res.json()
}

export async function retagExamplesAgainstCharter(
  datasetId: string,
): Promise<{
  retagged: number
  retags: Array<{ example_id: string; feature_area: string; coverage_tags: string[] }>
}> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/retag-against-charter`, {
    method: 'POST',
  })
  if (!res.ok) {
    let detail = `Failed to retag (${res.status})`
    try {
      const j = await res.json()
      if (j?.detail) detail = j.detail
    } catch { /* not json */ }
    throw new Error(detail)
  }
  return res.json()
}

export async function suggestRevisions(datasetId: string, exampleIds?: string[]): Promise<{ revised: number; revisions: Array<{ example_id: string; revised_input: string; revised_expected_output: string; reasoning: string }> }> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/suggest-revisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ example_ids: exampleIds || [] }),
  })
  if (!res.ok) throw new Error(`Failed to suggest revisions: ${res.status}`)
  return res.json()
}

export async function getGapAnalysis(datasetId: string): Promise<GapAnalysis> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/gaps`)
  if (!res.ok) throw new Error(`Failed to get gaps: ${res.status}`)
  return res.json()
}

export async function enrichDataset(
  datasetId: string,
  gapType: string,
  targets: string[],
  count?: number
): Promise<{ generated: number; examples: Example[]; stats: Dataset['stats'] }> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gap_type: gapType, targets, count: count || 2 }),
  })
  if (!res.ok) throw new Error(`Failed to enrich: ${res.status}`)
  return res.json()
}

export async function exportDataset(datasetId: string): Promise<{ dataset_id: string; examples: Example[] }> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/export`)
  if (!res.ok) throw new Error(`Failed to export: ${res.status}`)
  return res.json()
}

// --- Settings API ---

export async function getSettings(): Promise<Settings> {
  const res = await apiFetch(`${BASE}/settings`)
  if (!res.ok) throw new Error(`Failed to get settings: ${res.status}`)
  return res.json()
}

export async function updateSettings(fields: Partial<Settings>): Promise<Settings> {
  const res = await apiFetch(`${BASE}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(`Failed to update settings: ${res.status}`)
  return res.json()
}

export interface AgentAction {
  action: 'generate' | 'show_coverage' | 'auto_review' | 'export' | 'approve' | 'reject'
  count?: number
  example_id?: string
}

export interface ActionSuggestion {
  action: string
  label: string
  reason: string
}

export async function datasetChat(
  datasetId: string,
  message: string
): Promise<{ message: string; state: SessionState; actions?: AgentAction[]; action_suggestions?: ActionSuggestion[] }> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  if (!res.ok) throw new Error(`Failed to chat: ${res.status}`)
  return res.json()
}

// --- Schema Detection API ---

export async function detectSchema(
  sessionId: string,
  content: string,
  contentType: 'json' | 'csv' | 'text' | 'auto' = 'auto'
): Promise<DetectSchemaResponse> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/detect-schema`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, content_type: contentType }),
  })
  if (!res.ok) throw new Error(`Failed to detect schema: ${res.status}`)
  return res.json()
}

export async function importFromUrl(
  sessionId: string,
  url: string,
  urlType: 'json' | 'openapi' | 'auto' = 'auto'
): Promise<ImportFromUrlResponse> {
  const res = await apiFetch(`${BASE}/sessions/${sessionId}/import-from-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, url_type: urlType }),
  })
  if (!res.ok) throw new Error(`Failed to import from URL: ${res.status}`)
  return res.json()
}

export async function inferSchemaFromExamples(
  datasetId: string
): Promise<InferSchemaResponse> {
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/infer-schema`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Failed to infer schema: ${res.status}`)
  return res.json()
}
