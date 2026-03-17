import type { CreateSessionResponse, SendMessageResponse, SessionState, Charter, Dataset, Example, GapAnalysis, Settings, DetectSchemaResponse, ImportFromUrlResponse, InferSchemaResponse, TaskDefinition } from './types'

const BASE = '/api'

export async function createSession(input: {
  business_goals?: string
  user_stories?: string
}): Promise<CreateSessionResponse> {
  const res = await fetch(`${BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      initial_input: {
        business_goals: input.business_goals || null,
        user_stories: input.user_stories || null,
        conversation_history: [],
      },
    }),
  })
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`)
  return res.json()
}

export async function sendMessage(
  sessionId: string,
  message: string,
  options?: { regenerate?: boolean }
): Promise<SendMessageResponse> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/message`, {
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
  const res = await fetch(`${BASE}/sessions/${sessionId}`)
  if (!res.ok) throw new Error(`Failed to get session: ${res.status}`)
  return res.json()
}

export async function proceedToReview(
  sessionId: string
): Promise<{ agent_status: string; state: SessionState }> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/proceed`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Failed to proceed: ${res.status}`)
  return res.json()
}

export async function patchCharter(
  sessionId: string,
  patch: Partial<Charter>
): Promise<{ state: SessionState }> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/charter`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`Failed to patch charter: ${res.status}`)
  return res.json()
}

export async function finalizeCharter(
  sessionId: string
): Promise<{ charter_id: string; session_id: string; charter: Charter }> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/finalize`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Failed to finalize: ${res.status}`)
  return res.json()
}

// --- Dataset API ---

export async function createDataset(sessionId: string, name?: string): Promise<Dataset> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/dataset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`Failed to create dataset: ${res.status}`)
  return res.json()
}

export async function getDataset(sessionId: string): Promise<Dataset> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/dataset`)
  if (!res.ok) throw new Error(`Failed to get dataset: ${res.status}`)
  return res.json()
}

export async function importExamples(
  datasetId: string,
  examples: Array<{ input: string; expected_output: string; feature_area?: string; label?: string }>
): Promise<{ imported: number; stats: Dataset['stats'] }> {
  const res = await fetch(`${BASE}/datasets/${datasetId}/import`, {
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
  const res = await fetch(`${BASE}/datasets/${datasetId}/synthesize`, {
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
  const res = await fetch(`${BASE}/datasets/${datasetId}/examples/${exampleId}`, {
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
  const res = await fetch(`${BASE}/datasets/${datasetId}/examples`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(example),
  })
  if (!res.ok) throw new Error(`Failed to add example: ${res.status}`)
  return res.json()
}

export async function deleteExample(datasetId: string, exampleId: string): Promise<void> {
  const res = await fetch(`${BASE}/datasets/${datasetId}/examples/${exampleId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`Failed to delete example: ${res.status}`)
}

export async function autoReviewExamples(datasetId: string): Promise<{ reviewed: number; reviews: Array<{ example_id: string; suggested_label: string; confidence: string; reasoning: string }> }> {
  const res = await fetch(`${BASE}/datasets/${datasetId}/review`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Failed to review: ${res.status}`)
  return res.json()
}

export async function getGapAnalysis(datasetId: string): Promise<GapAnalysis> {
  const res = await fetch(`${BASE}/datasets/${datasetId}/gaps`)
  if (!res.ok) throw new Error(`Failed to get gaps: ${res.status}`)
  return res.json()
}

export async function enrichDataset(
  datasetId: string,
  gapType: string,
  targets: string[],
  count?: number
): Promise<{ generated: number; examples: Example[]; stats: Dataset['stats'] }> {
  const res = await fetch(`${BASE}/datasets/${datasetId}/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gap_type: gapType, targets, count: count || 2 }),
  })
  if (!res.ok) throw new Error(`Failed to enrich: ${res.status}`)
  return res.json()
}

export async function exportDataset(datasetId: string): Promise<{ dataset_id: string; examples: Example[] }> {
  const res = await fetch(`${BASE}/datasets/${datasetId}/export`)
  if (!res.ok) throw new Error(`Failed to export: ${res.status}`)
  return res.json()
}

// --- Settings API ---

export async function getSettings(): Promise<Settings> {
  const res = await fetch(`${BASE}/settings`)
  if (!res.ok) throw new Error(`Failed to get settings: ${res.status}`)
  return res.json()
}

export async function updateSettings(fields: Partial<Settings>): Promise<Settings> {
  const res = await fetch(`${BASE}/settings`, {
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
  const res = await fetch(`${BASE}/datasets/${datasetId}/chat`, {
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
  const res = await fetch(`${BASE}/sessions/${sessionId}/detect-schema`, {
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
  const res = await fetch(`${BASE}/sessions/${sessionId}/import-from-url`, {
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
  const res = await fetch(`${BASE}/datasets/${datasetId}/infer-schema`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Failed to infer schema: ${res.status}`)
  return res.json()
}
