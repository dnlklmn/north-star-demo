export type AgentStatus = 'drafting' | 'validating' | 'questioning' | 'soft_ok' | 'review'

export type DimensionStatus = 'pending' | 'weak' | 'good'

export type ValidationStatus = 'pass' | 'weak' | 'fail' | 'untested'

export interface DimensionCriteria {
  criteria: string[]
  status: DimensionStatus
}

export interface AlignmentEntry {
  feature_area: string
  good: string
  bad: string
  status: DimensionStatus
}

export interface TaskDefinition {
  input_description: string
  output_description: string
  sample_input?: string | null
  sample_output?: string | null
}

export interface Charter {
  task: TaskDefinition
  coverage: DimensionCriteria
  balance: DimensionCriteria
  alignment: AlignmentEntry[]
  rot: DimensionCriteria
}

export interface AlignmentValidation {
  feature_area: string
  status: ValidationStatus
  weak_reason: string | null
}

export interface Validation {
  coverage: ValidationStatus
  balance: ValidationStatus
  alignment: AlignmentValidation[]
  rot: ValidationStatus
  overall: ValidationStatus
}

export interface SessionInput {
  business_goals: string | null
  user_stories: string | null
  conversation_history: Message[]
  goals?: string[]
  story_groups?: StoryGroup[]
}

export interface ProjectSummary {
  id: string
  name: string
  created_at: string
  updated_at: string
  agent_status: AgentStatus
  has_charter: boolean
  has_dataset: boolean
}

export interface ScorerDef {
  name: string
  type: string
  description: string
  code: string
}

export interface SessionState {
  session_id: string
  input: SessionInput
  charter: Charter
  validation: Validation
  rounds_of_questions: number
  agent_status: AgentStatus
  scorers?: ScorerDef[]
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
}

export interface UserStory {
  who: string
  what: string
  why: string
}

export interface StoryGroup {
  role: string
  stories: { what: string; why: string }[]
}

export interface CreateSessionResponse {
  session_id: string
  agent_status: AgentStatus
  message: string
  suggestions: Suggestion[]
  suggested_stories: SuggestedStory[]
}

export interface Suggestion {
  section: 'coverage' | 'balance' | 'alignment' | 'rot'
  text: string
  good?: string
  bad?: string
}

export interface SuggestedStory {
  who: string
  what: string
  why: string
}

export interface SendMessageResponse {
  message: string
  agent_status: AgentStatus
  state: SessionState
  tool_calls: string[]
  suggestions: Suggestion[]
  suggested_stories: SuggestedStory[]
}

// --- Dataset types ---

export interface Example {
  id: string
  dataset_id: string
  feature_area: string
  input: string
  expected_output: string
  coverage_tags: string[]
  source: 'imported' | 'synthetic' | 'manual'
  label: 'good' | 'bad' | 'unlabeled'
  label_reason: string | null
  review_status: 'pending' | 'approved' | 'rejected' | 'needs_edit'
  reviewer_notes: string | null
  judge_verdict: JudgeVerdict | null
  revision_suggestion: RevisionSuggestion | null
  created_at: string
  updated_at: string
}

export interface JudgeVerdict {
  suggested_label: 'good' | 'bad'
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
  coverage_match: string[]
  issues: string[]
}

export interface RevisionSuggestion {
  input: string
  expected_output: string
  reasoning: string
}

export interface DatasetStats {
  total: number
  by_review_status: { pending: number; approved: number; rejected: number; needs_edit: number }
  by_label: { good: number; bad: number; unlabeled: number }
  by_feature_area: Record<string, number>
}

export interface Dataset {
  id: string
  session_id: string
  version: number
  parent_version_id: string | null
  name: string | null
  status: 'draft' | 'in_review' | 'approved'
  stats: DatasetStats
  charter_snapshot: Charter
  examples: Example[]
  created_at: string
}

export interface Settings {
  model_name: string
  max_rounds: number
  creativity: number
}

export interface GapAnalysis {
  coverage_gaps: string[]
  feature_area_gaps: string[]
  balance_issues: string[]
  label_gaps: { feature_area: string; missing: string }[]
  coverage_matrix: Record<string, Record<string, number>>
  summary: string
}

// --- Schema detection types ---

export interface DetectedField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  example?: string | null
}

export interface DetectSchemaResponse {
  input_description: string
  output_description: string
  detected_format: 'json_object' | 'json_array' | 'csv' | 'freeform_text'
  fields: DetectedField[]
  sample_input: string
}

export interface ImportFromUrlResponse {
  task: TaskDefinition
  source_url: string
  detected_type: 'json_data' | 'openapi' | 'html_docs'
}

export interface InferSchemaResponse {
  task: TaskDefinition
  confidence: 'high' | 'medium' | 'low'
  example_count: number
  pattern_notes: string
}
