export type AgentStatus = 'drafting' | 'validating' | 'questioning' | 'soft_ok' | 'review' | 'discovery'

export type DimensionStatus = 'pending' | 'weak' | 'good'

export type ValidationStatus = 'pass' | 'weak' | 'fail' | 'untested'

export type EvalMode = 'standard' | 'triggered'

export interface DimensionCriteria {
  criteria: string[]
  /** Triggered-mode only: scenarios that must NOT invoke the skill/tool.
   *  Used by coverage; other dimensions leave it empty. */
  negative_criteria?: string[]
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
  /** Triggered-mode metadata for the skill/tool under evaluation. */
  skill_name?: string | null
  skill_description?: string | null
  skill_body?: string | null
}

export interface Charter {
  task: TaskDefinition
  coverage: DimensionCriteria
  balance: DimensionCriteria
  alignment: AlignmentEntry[]
  rot: DimensionCriteria
  /** Output-level safety rules (triggered mode). Optional for backward
   *  compatibility — older charters loaded from DB may not have this field. */
  safety?: DimensionCriteria
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
  eval_mode?: EvalMode
  extracted_goals?: string[]
  extracted_users?: string[]
  extracted_stories?: ExtractedStory[]
  /** Latest SKILL.md version id — mirrors backend active_skill_version_id. */
  active_skill_version_id?: string | null
  /** Which skill version was active when each artifact was last generated.
   *  Keys: 'goals' | 'users' | 'stories' | 'charter' | 'dataset' | 'scorers'. */
  generated_at_skill_version?: Record<string, string>
  /** Full version history. Mirrors backend skill_versions. */
  skill_versions?: SkillVersion[]
}

export interface ExtractedStory {
  who: string
  what: string
  why?: string
  /** Triggered-mode only. Missing or 'positive' = should fire.
   *  'off_target' = adjacent request that should NOT fire. */
  kind?: 'positive' | 'off_target'
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
  kind?: 'hint'
  id?: string
  /** For hint messages: concrete detail about what the agent did. */
  detail?: string | null
}

export interface ActivityEvent {
  id: string
  created_at: string
  turn_type: string
  detail?: string | null
}

export interface UserStory {
  who: string
  what: string
  why: string
}

export interface StoryGroup {
  role: string
  stories: { what: string; why: string; kind?: 'positive' | 'off_target' }[]
}

export interface CreateSessionResponse {
  session_id: string
  agent_status: AgentStatus
  message: string
  suggestions: Suggestion[]
  suggested_stories: SuggestedStory[]
}

export interface Suggestion {
  section: 'coverage' | 'balance' | 'alignment' | 'rot' | 'safety'
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
  /** Empty string when should_trigger === false. */
  expected_output: string
  coverage_tags: string[]
  source: 'imported' | 'synthetic' | 'manual'
  label: 'good' | 'bad' | 'unlabeled'
  label_reason: string | null
  review_status: 'pending' | 'approved' | 'rejected' | 'needs_edit'
  reviewer_notes: string | null
  judge_verdict: JudgeVerdict | null
  revision_suggestion: RevisionSuggestion | null
  /** Triggered-mode label. null = standard mode. */
  should_trigger?: boolean | null
  /** Adversarial probe (prompt injection, credential leakage attempts, etc).
   *  null = normal row. True = safety scorers weight this heavily. */
  is_adversarial?: boolean | null
  created_at: string
  updated_at: string
}

export interface TriggerVerdict {
  expected_fire: boolean
  would_fire: boolean
  correct: boolean
  reasoning: string
}

export interface ExecutionVerdict {
  suggested_label: 'good' | 'bad'
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
}

export interface JudgeVerdict {
  suggested_label?: 'good' | 'bad'
  confidence?: 'high' | 'medium' | 'low'
  reasoning?: string
  coverage_match?: string[]
  issues?: string[]
  /** Triggered-mode additions. */
  trigger_verdict?: TriggerVerdict | null
  execution_verdict?: ExecutionVerdict | null
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

// --- Eval run (Braintrust execution eval triggered from the UI) ---

export type EvalRunStatus = 'pending' | 'running' | 'done' | 'error'

export interface EvalRunPerRow {
  input: unknown
  output: unknown
  expected: unknown
  scores: Record<string, number>
  error: string | null
  metadata: Record<string, unknown>
}

export interface EvalRunSummary {
  run_id: string
  status: EvalRunStatus
  project: string
  experiment_name: string | null
  experiment_url: string | null
  rows_total: number
  rows_evaluated: number
  scorer_names: string[]
  scorer_averages: Record<string, number>
  per_row: EvalRunPerRow[]
  error: string | null
  started_at: string | null
  finished_at: string | null
  skill_version_id?: string | null
  skill_version_number?: number | null
  /** Full charter at the moment the run started. Null for older runs
   *  created before this column existed. */
  charter_snapshot?: Charter | null
  /** Improvement suggestions generated by /suggest-improvements on this run.
   *  Null = never analyzed. Empty array = analyzed, no patterns found. */
  improvement_suggestions?: ImprovementSuggestion[] | null
  improvement_summary?: string | null
}

// --- Skill versioning + improvement suggestions (Path A) ---

export type SkillVersionSource = 'seed' | 'suggestion' | 'manual'

export interface SkillVersion {
  id: string
  version: number
  body: string
  notes: string | null
  created_from: SkillVersionSource
  applied_suggestion_ids: string[]
  created_at: string | null
}

export type ImprovementKind = 'add_rule' | 'clarify_rule' | 'add_example' | 'reword' | 'other'

export type ImprovementConfidence = 'low' | 'medium' | 'high'

export interface ImprovementSuggestion {
  id: string
  kind: ImprovementKind
  summary: string
  rationale: string
  /** Exact text to find in current SKILL.md — empty means append. */
  find: string
  replacement: string
  source_row_ids: string[]
  source_scorer_names: string[]
  confidence: ImprovementConfidence
}

export interface SuggestImprovementsResponse {
  suggestions: ImprovementSuggestion[]
  summary: string
  run_id: string
  skill_version_id: string | null
}

export interface CreateSkillVersionRequest {
  body: string
  notes?: string
  created_from?: SkillVersionSource
  applied_suggestion_ids?: string[]
}

export interface RunEvalRequest {
  project: string
  experiment_name?: string
  limit?: number
  include_triggering?: boolean
  model?: string
  judge_model?: string
}
