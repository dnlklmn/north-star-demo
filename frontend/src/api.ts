import type { CreateSessionResponse, SendMessageResponse, SessionState, Charter, Dataset, Example, GapAnalysis, Settings, DetectSchemaResponse, ImportFromUrlResponse, InferSchemaResponse, ProjectSummary, StoryGroup, ScorerDef } from './types'

const BASE = import.meta.env.VITE_API_URL || '/api'

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

// --- Fetch wrapper that attaches API key header ---

function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  const key = getApiKey()
  if (key) {
    headers['X-Anthropic-Key'] = key
  }
  return headers
}

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...apiHeaders(),
      ...(init?.headers as Record<string, string> || {}),
    },
  })
  if (res.status === 401) {
    throw new Error('Invalid or missing API key. Please add your API key in Settings.')
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
  goals: string[]
): Promise<{ feedback: Array<{ goal: string; issue: string | null; suggestion: string | null }> }> {
  const res = await apiFetch(`${BASE}/evaluate-goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goals }),
  })
  if (!res.ok) throw new Error(`Failed to evaluate goals: ${res.status}`)
  return res.json()
}

export async function suggestGoals(
  goals: string[]
): Promise<{ suggestions: string[] }> {
  const res = await apiFetch(`${BASE}/suggest-goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goals }),
  })
  if (!res.ok) throw new Error(`Failed to suggest goals: ${res.status}`)
  return res.json()
}

export async function suggestStories(
  goals: string[],
  stories: Array<{ who: string; what: string; why: string }>
): Promise<{ suggestions: Array<{ who: string; what: string; why: string }> }> {
  const res = await apiFetch(`${BASE}/suggest-stories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goals, stories }),
  })
  if (!res.ok) throw new Error(`Failed to suggest stories: ${res.status}`)
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
  const res = await apiFetch(`${BASE}/datasets/${datasetId}/examples/${exampleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(`Failed to update example: ${res.status}`)
  return res.json()
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
