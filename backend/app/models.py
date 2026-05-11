"""Pydantic models matching the agent spec state object."""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# --- Enums ---

class AgentStatus(str, Enum):
    discovery = "discovery"
    drafting = "drafting"
    validating = "validating"
    questioning = "questioning"
    soft_ok = "soft_ok"
    review = "review"


class DimensionStatus(str, Enum):
    pending = "pending"
    weak = "weak"
    good = "good"


class ValidationStatus(str, Enum):
    passing = "pass"
    weak = "weak"
    fail = "fail"
    untested = "untested"


class DiscoveryPhase(str, Enum):
    goals = "goals"
    users = "users"
    stories = "stories"
    charter = "charter"


class EvalMode(str, Enum):
    """Whether the thing being evaluated has a routing/triggering decision.

    - standard: always invoked once the user takes a path (most product features).
    - triggered: loaded by a router based on its description (skills, tools, agents).
      Adds negative coverage, off-target stories, and should_trigger dataset labels.
    """
    standard = "standard"
    triggered = "triggered"


class SessionKind(str, Enum):
    """Top-level discriminator on what this North Star project evaluates.

    - skill: the user's own SKILL.md / agent / feature (the default product flow).
    - prompt: one of North Star's *internal* prompts (e.g. build_generate_draft_prompt).
      Inputs are SessionState snapshots sampled from the `turns` table; the
      task function rebuilds state and re-runs the prompt under test.
    """
    skill = "skill"
    prompt = "prompt"


# --- Charter models ---

class TaskDefinition(BaseModel):
    """Defines what the app receives and produces."""
    input_description: str = ""  # What the app receives (e.g., "business goals + user stories")
    output_description: str = ""  # What the app produces (e.g., "structured charter JSON")
    sample_input: Optional[str] = None  # Example input
    sample_output: Optional[str] = None  # Example output
    # Triggered-mode fields: metadata about the skill/tool under evaluation.
    skill_name: Optional[str] = None
    skill_description: Optional[str] = None  # the routing signal (e.g. SKILL.md frontmatter)
    skill_body: Optional[str] = None  # full SKILL.md body for seeding + reference


class DimensionCriteria(BaseModel):
    criteria: list[str] = Field(default_factory=list)
    # Triggered-mode: scenarios that must NOT invoke the skill/tool.
    # Coverage uses this; other dimensions leave it empty.
    negative_criteria: list[str] = Field(default_factory=list)
    status: DimensionStatus = DimensionStatus.pending


class AlignmentEntry(BaseModel):
    feature_area: str
    good: str
    bad: str
    status: DimensionStatus = DimensionStatus.pending


class Charter(BaseModel):
    task: TaskDefinition = Field(default_factory=TaskDefinition)
    coverage: DimensionCriteria = Field(default_factory=DimensionCriteria)
    balance: DimensionCriteria = Field(default_factory=DimensionCriteria)
    alignment: list[AlignmentEntry] = Field(default_factory=list)
    rot: DimensionCriteria = Field(default_factory=DimensionCriteria)
    # Output-level safety rules. Only meaningfully populated in triggered mode
    # (skills, where prompt-injection and exfiltration concerns are real).
    # Each criterion is a rule the skill's OUTPUT must obey — e.g. "Output
    # must not reference URLs outside the docs allow-list" or "Output must
    # refuse when the user input attempts prompt injection". These generate
    # dedicated safety scorers alongside alignment/coverage scorers.
    #
    # This is static (output-text) safety. Runtime safety (did the skill
    # actually call a disallowed domain, did it write to an unauthorized
    # path) requires running the skill through Claude Agent SDK with tool
    # policies — out of scope for this harness.
    safety: DimensionCriteria = Field(default_factory=DimensionCriteria)


# --- Validation models ---

class AlignmentValidation(BaseModel):
    feature_area: str
    status: ValidationStatus = ValidationStatus.untested
    weak_reason: Optional[str] = None


class Validation(BaseModel):
    coverage: ValidationStatus = ValidationStatus.untested
    balance: ValidationStatus = ValidationStatus.untested
    alignment: list[AlignmentValidation] = Field(default_factory=list)
    rot: ValidationStatus = ValidationStatus.untested
    overall: ValidationStatus = ValidationStatus.untested


# --- Session input ---

class SessionInput(BaseModel):
    business_goals: Optional[str] = None
    user_stories: Optional[str] = None
    goals: list[str] = Field(default_factory=list)
    story_groups: list[dict] = Field(default_factory=list)
    conversation_history: list[dict] = Field(default_factory=list)


# --- Full session state ---

class SessionState(BaseModel):
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    input: SessionInput = Field(default_factory=SessionInput)
    charter: Charter = Field(default_factory=Charter)
    validation: Validation = Field(default_factory=Validation)
    rounds_of_questions: int = 0
    agent_status: AgentStatus = AgentStatus.drafting
    discovery_phase: DiscoveryPhase = DiscoveryPhase.goals
    discovery_rounds: int = 0
    extracted_goals: list[str] = Field(default_factory=list)
    extracted_users: list[str] = Field(default_factory=list)
    # Stories are dicts with: who, what, why, kind ("positive" | "off_target").
    # kind defaults to "positive" when missing (backward-compatible).
    extracted_stories: list[dict] = Field(default_factory=list)
    scorers: list[dict] = Field(default_factory=list)
    eval_mode: EvalMode = EvalMode.standard
    # SessionKind discriminates "skill" projects (the default product flow,
    # paste a SKILL.md and eval it) from "prompt" projects (eval one of North
    # Star's own prompts — e.g. build_generate_draft_prompt — against turn
    # snapshots sampled from the turns table).
    kind: SessionKind = SessionKind.skill
    # For kind=prompt only: identifies which prompt builder is under test.
    # Mirrors a turn_type value, e.g. "generate" for build_generate_draft_prompt.
    prompt_target: Optional[str] = None
    # Repo-relative "path:line" of the prompt builder under test. Stamped at
    # session-create time so the Prompt panel can tell the user exactly where
    # to edit to change what runs at eval time. Only set when kind=prompt.
    prompt_source_path: Optional[str] = None
    # Builder function name (e.g. "build_generate_draft_prompt"). Stamped at
    # session-create time so the Prompt panel can show it without an extra
    # API roundtrip. Only set when kind=prompt.
    prompt_builder_name: Optional[str] = None
    # Every accepted SKILL.md edit creates a new SkillVersion. The current
    # active body always lives on charter.task.skill_body; this list is history.
    skill_versions: list[dict] = Field(default_factory=list)
    active_skill_version_id: Optional[str] = None
    # Pointer to the version currently being trialled. Distinct from active so
    # the user can iterate on a candidate (run evals, see per-row deltas)
    # before deciding to promote it. When set, charter.task.skill_body
    # mirrors the candidate's body so the next eval runs against it. Cleared
    # on promote (becomes active) or discard (revert to active's body).
    candidate_skill_version_id: Optional[str] = None
    # Lineage: which skill version was active when each downstream artifact
    # was last generated. Keys: "goals" | "users" | "stories" | "charter" |
    # "dataset" | "scorers". UI shows a "Regenerate" affordance on tabs where
    # the lineage id is older than active_skill_version_id.
    generated_at_skill_version: dict[str, str] = Field(default_factory=dict)


# --- API request/response models ---

class CreateSessionRequest(BaseModel):
    initial_input: SessionInput
    name: Optional[str] = None


class CreateSessionResponse(BaseModel):
    session_id: str
    agent_status: AgentStatus
    message: str
    suggestions: list['Suggestion'] = Field(default_factory=list)
    suggested_stories: list['SuggestedStory'] = Field(default_factory=list)


class ProjectSummary(BaseModel):
    """Lightweight session summary for the project list."""
    id: str
    name: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    agent_status: str
    has_charter: bool = False
    has_dataset: bool = False
    kind: str = "skill"
    prompt_target: Optional[str] = None


class UpdateInputRequest(BaseModel):
    """Save structured goals + story_groups without triggering the agent."""
    goals: list[str] = Field(default_factory=list)
    story_groups: list[dict] = Field(default_factory=list)


class SendMessageRequest(BaseModel):
    message: str
    regenerate: bool = False


class Suggestion(BaseModel):
    """A suggested addition to the charter that the user can accept or dismiss."""
    section: str  # coverage, balance, rot, alignment
    text: str  # the criterion text or feature_area for alignment
    good: Optional[str] = None  # only for alignment suggestions
    bad: Optional[str] = None  # only for alignment suggestions


class SuggestedStory(BaseModel):
    """A suggested user story the AI thinks would help."""
    who: str
    what: str
    why: str = ""


class SendMessageResponse(BaseModel):
    message: str
    agent_status: AgentStatus
    state: SessionState
    tool_calls: list[str] = Field(default_factory=list)
    suggestions: list[Suggestion] = Field(default_factory=list)
    suggested_stories: list[SuggestedStory] = Field(default_factory=list)


class ProceedResponse(BaseModel):
    agent_status: AgentStatus
    state: SessionState


class PatchCharterRequest(BaseModel):
    """Partial charter update — only include fields being edited."""
    task: Optional[TaskDefinition] = None
    coverage: Optional[DimensionCriteria] = None
    balance: Optional[DimensionCriteria] = None
    alignment: Optional[list[AlignmentEntry]] = None
    rot: Optional[DimensionCriteria] = None
    safety: Optional[DimensionCriteria] = None


class FinalizeResponse(BaseModel):
    charter_id: str
    session_id: str
    charter: Charter


# --- Dataset models ---

class Example(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    dataset_id: str = ""
    feature_area: str
    input: str
    expected_output: str = ""  # empty allowed when should_trigger=false
    coverage_tags: list[str] = Field(default_factory=list)
    source: str = "manual"
    label: str = "unlabeled"
    label_reason: Optional[str] = None
    review_status: str = "pending"
    reviewer_notes: Optional[str] = None
    # judge_verdict carries either:
    #   standard mode: { suggested_label, confidence, reasoning, coverage_match, issues }
    #   triggered mode: { trigger_verdict: {...}, execution_verdict: {...} | null }
    judge_verdict: Optional[dict] = None
    revision_suggestion: Optional[dict] = None
    # Triggered-mode field. None = standard (no routing decision modeled).
    should_trigger: Optional[bool] = None
    # Adversarial examples probe safety boundaries: prompt injection, credential
    # leakage attempts, requests to call disallowed domains, etc. When true,
    # safety scorers are weighted more heavily and execution scorers may
    # consider refusal a valid 'good' output. None = normal row.
    is_adversarial: Optional[bool] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class Dataset(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    session_id: str
    version: int = 1
    parent_version_id: Optional[str] = None
    name: Optional[str] = None
    status: str = "draft"
    stats: dict = Field(default_factory=dict)
    charter_snapshot: dict = Field(default_factory=dict)
    created_at: Optional[datetime] = None


class CreateDatasetRequest(BaseModel):
    name: Optional[str] = None


class ImportExamplesRequest(BaseModel):
    examples: list[dict]


class SynthesizeRequest(BaseModel):
    feature_areas: Optional[list[str]] = None
    coverage_criteria: Optional[list[str]] = None
    count_per_scenario: int = 2


class UpdateExampleRequest(BaseModel):
    feature_area: Optional[str] = None
    input: Optional[str] = None
    expected_output: Optional[str] = None
    coverage_tags: Optional[list[str]] = None
    label: Optional[str] = None
    label_reason: Optional[str] = None
    review_status: Optional[str] = None
    reviewer_notes: Optional[str] = None
    revision_suggestion: Optional[dict] = None
    should_trigger: Optional[bool] = None
    is_adversarial: Optional[bool] = None


class CreateExampleRequest(BaseModel):
    feature_area: str
    input: str
    expected_output: str = ""
    coverage_tags: list[str] = Field(default_factory=list)
    label: str = "unlabeled"
    label_reason: Optional[str] = None
    should_trigger: Optional[bool] = None
    is_adversarial: Optional[bool] = None


# --- Triggered mode (skill eval) requests ---

class SetModeRequest(BaseModel):
    eval_mode: EvalMode


class SkillSeedRequest(BaseModel):
    """Paste a SKILL.md (body) to auto-populate goals/users/stories + task def."""
    skill_body: str
    skill_name: Optional[str] = None
    skill_description: Optional[str] = None  # overrides frontmatter if provided


class SkillSeedResponse(BaseModel):
    state: SessionState
    message: str  # short human-readable summary of what was seeded


# --- Prompt-eval (eval North Star's own prompts) ---

class CreatePromptEvalRequest(BaseModel):
    """Spin up a prompt-eval project from sampled `turns` rows.

    Picks a `prompt_target` (e.g. "generate" for build_generate_draft_prompt),
    samples turns of that type from the DB, builds a dataset of input snapshots,
    and seeds default scorers tailored to the target.
    """
    prompt_target: str
    # Bounded so a runaway client can't fill the sessions table with a 10MB
    # name; matches the existing skill-eval session-name flow.
    name: Optional[str] = Field(default=None, max_length=200)
    # Pydantic clamps at validation time so the endpoint can rely on a sane
    # value without re-clamping. Ceiling matches sample_turns_for_prompt_eval
    # default; floor of 1 keeps the request meaningful.
    sample_size: int = Field(default=30, ge=1, le=200)
    # Optional override of the prompt body fed into the seed pass + Skill
    # panel. Lets the user paste / edit the prompt text in the modal before
    # creating the session. None = use the registered prompt's rendered text.
    # Note: this affects seeding only — the eval task still replays the
    # registered build_*_prompt builder by prompt_target. Capped at 40k
    # chars so a runaway client can't burn unbounded LLM tokens via the
    # seed pass; the rendered template for `generate` is ~2.2k for context.
    prompt_body: Optional[str] = Field(default=None, max_length=40000)


class CreatePromptEvalResponse(BaseModel):
    session_id: str
    prompt_target: str
    rows_sampled: int
    rows_deduped: int
    dataset_id: str
    message: str


class RefreshDatasetRequest(BaseModel):
    """Re-sample turns into an existing prompt-eval session's dataset.

    Replace-only for v1: existing examples are wiped, fresh ones inserted.
    sample_size matches the create-flow ceiling so a refresh can't grow the
    dataset beyond what create_prompt_eval_session would produce.

    ``confirm`` defaults to False. When the existing dataset has any
    user-curated examples (labels, review status, reviewer notes), the
    endpoint refuses with HTTP 409 unless ``confirm=True`` is set. This
    keeps a casual refresh from silently destroying review work.
    """
    sample_size: int = Field(default=30, ge=1, le=200)
    confirm: bool = Field(
        default=False,
        description=(
            "Set true to acknowledge that any curated examples in the existing "
            "dataset will be destroyed. Required when rows_curation_lost > 0."
        ),
    )


class RefreshDatasetResponse(BaseModel):
    session_id: str
    prompt_target: str
    dataset_id: str
    # rows_sampled is the raw turns-table hit count (3× sample_size ceiling
    # on the SELECT); rows_deduped is what survived input-snapshot dedup
    # before truncation; rows_total is the final example_count after insert.
    # rows_removed is the count cleared from the prior dataset state — the
    # signal for "how stale was this". rows_curation_lost is the subset of
    # rows_removed that carried user labels, review status, or notes (i.e.
    # what the refresh actually destroyed beyond pure auto-sampled rows).
    rows_sampled: int
    rows_deduped: int
    rows_removed: int
    rows_curation_lost: int
    rows_total: int
    message: str


class PromptTargetInfo(BaseModel):
    target: str
    label: str
    builder_name: str
    description: Optional[str] = None
    # Repo-relative "path:line" pointer to the prompt builder, computed via
    # inspect.getsourcelines on the registered function. Lets the modal +
    # Prompt panel show the user where to edit. None when the function isn't
    # backed by a source file.
    source_path: Optional[str] = None
    # Rendered prompt template with placeholder text marking the variable
    # parts. The modal pre-fills the textarea with this so the user can
    # review or tweak before creating the session. ~3KB per target — well
    # within HTTP response budget for the small registry we expect.
    prompt_text: Optional[str] = None


# --- Eval-run requests (Braintrust execution eval from UI) ---

class RunEvalRequest(BaseModel):
    project: str  # Braintrust project name
    experiment_name: Optional[str] = None
    limit: Optional[int] = None
    include_triggering: bool = False
    model: Optional[str] = None  # override EVAL_MODEL for this run
    judge_model: Optional[str] = None  # override JUDGE_MODEL
    # Agent mode: run the skill inside a real tool-use loop with a sandboxed
    # filesystem instead of bare messages.create(). This is the only honest
    # way to evaluate tool-using skills (docx, pdf, xlsx, web fetch) — without
    # it the model returns prose like "I've written the file" with no file,
    # and judges happily score the prose. Default off to keep existing runs
    # cheap + identical.
    agent_mode: bool = False
    # When agent_mode is on, also expose the run_bash tool. Off by default —
    # it can side-step the sandbox path allowlist. Enable only for trusted
    # skills you've reviewed.
    allow_bash: bool = False
    # Hard cap on how many tool-use turns the agent gets per row. Prevents
    # runaway loops + bounds cost. Ignored when agent_mode is false.
    max_iterations: Optional[int] = None


class EvalRunSummary(BaseModel):
    run_id: str
    status: str  # "pending" | "running" | "done" | "failed" | "error" | "cancelled"
    # done = ran, may include some errored rows (see `error` for summary if any)
    # failed = ran, but every row errored (auth/billing/network)
    # error = run never started (setup/validation error before Braintrust)
    # cancelled = user clicked Stop while the run was in flight
    project: str
    experiment_name: Optional[str] = None
    experiment_url: Optional[str] = None
    rows_total: int = 0
    rows_evaluated: int = 0
    scorer_names: list[str] = Field(default_factory=list)
    scorer_averages: dict[str, float] = Field(default_factory=dict)
    per_row: list[dict] = Field(default_factory=list)
    error: Optional[str] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    # Which SKILL.md version this run evaluated. Lets the UI label runs by
    # version and diff averages across versions.
    skill_version_id: Optional[str] = None
    skill_version_number: Optional[int] = None
    # Judge model used to grade this run's outputs. Persisted at run-creation
    # so history can show "ran with claude-opus-4-7" etc. without inferring
    # from per_row metadata. NULL on legacy rows created before this column.
    judge_model_used: Optional[str] = None
    # Full charter at the moment this run was started — so "View charter"
    # on an old run shows exactly what was evaluated, not the current live
    # charter (which may have been edited since).
    charter_snapshot: Optional[dict] = None
    # Persisted output of /suggest-improvements on this run. None = never
    # analyzed; empty list = analyzed + no patterns found.
    improvement_suggestions: Optional[list[dict]] = None
    improvement_summary: Optional[str] = None


# --- Skill versioning (Path A: iterate on SKILL.md from eval failures) ---

class SkillVersion(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    version: int  # monotonically increasing per session, starting at 1
    body: str
    notes: Optional[str] = None  # short human-readable summary of what changed
    created_from: str = "manual"  # "seed" | "suggestion" | "manual" | "restore"
    applied_suggestion_ids: list[str] = Field(default_factory=list)  # if created_from=suggestion
    created_at: Optional[datetime] = None


class ImprovementSuggestion(BaseModel):
    """A single proposed edit to SKILL.md derived from eval failures."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    kind: str  # "add_rule" | "clarify_rule" | "add_example" | "reword" | "other"
    summary: str  # short — shown as the suggestion's title
    rationale: str  # why (references which rows/scorers failed)
    # The suggested edit, expressed as find/replace OR as an append.
    # If `find` is empty, the `replacement` is appended to the end of SKILL.md.
    find: str = ""
    replacement: str
    source_row_ids: list[str] = Field(default_factory=list)  # which dataset rows surfaced this
    source_scorer_names: list[str] = Field(default_factory=list)
    confidence: str = "medium"  # "low" | "medium" | "high"


class SuggestImprovementsRequest(BaseModel):
    run_id: str  # which eval run to analyze


class SuggestImprovementsResponse(BaseModel):
    suggestions: list[ImprovementSuggestion] = Field(default_factory=list)
    summary: str  # one-paragraph overview of patterns found
    run_id: str
    skill_version_id: Optional[str] = None  # which version these were generated against


class CreateSkillVersionRequest(BaseModel):
    body: str  # the full new SKILL.md body
    notes: Optional[str] = None
    created_from: str = "manual"
    applied_suggestion_ids: list[str] = Field(default_factory=list)


class RestoreSkillVersionRequest(BaseModel):
    version_id: str  # the SkillVersion.id to restore as active


class Settings(BaseModel):
    model_name: str = "claude-sonnet-4-20250514"
    max_rounds: int = 3
    creativity: float = 0.2  # 0.0 = strict, 1.0 = creative


class UpdateSettingsRequest(BaseModel):
    model_name: Optional[str] = None
    max_rounds: Optional[int] = None
    creativity: Optional[float] = None


class ValidateResponse(BaseModel):
    validation: Validation
    state: SessionState


class SuggestResponse(BaseModel):
    suggestions: list[Suggestion] = Field(default_factory=list)
    suggested_stories: list[SuggestedStory] = Field(default_factory=list)


class SuggestGoalsRequest(BaseModel):
    goals: list[str]
    # Optional — when provided, the call is logged to the `turns` table under
    # this session so prompt-eval can later sample it as a dataset row. Stays
    # stateless when None (suggestions are still returned, just not persisted).
    session_id: Optional[str] = None


class SuggestGoalsResponse(BaseModel):
    suggestions: list[str] = Field(default_factory=list)


class GoalFeedback(BaseModel):
    """Feedback on a single business goal's quality."""
    goal: str
    issue: Optional[str] = None  # null means goal is fine
    suggestion: Optional[str] = None  # improved version if issue exists


class EvaluateGoalsRequest(BaseModel):
    goals: list[str]
    session_id: Optional[str] = None


class EvaluateGoalsResponse(BaseModel):
    feedback: list[GoalFeedback] = Field(default_factory=list)


class SuggestStoriesRequest(BaseModel):
    goals: list[str]
    stories: list[dict]  # each dict has who, what, why
    session_id: Optional[str] = None


class SuggestStoriesResponse(BaseModel):
    suggestions: list[dict] = Field(default_factory=list)  # each dict has who, what, why


class SuggestSkillRequest(BaseModel):
    """Ask the agent for skill-content ideas given goals + stories.

    Powers the right-rail SuggestionBox on the Skill tab. The current draft
    body is included so we can de-dup against rules already present and
    avoid suggesting things the user has clearly already covered.
    """
    goals: list[str]
    stories: list[dict] = Field(default_factory=list)  # each dict has who, what, why
    current_body: Optional[str] = None
    session_id: Optional[str] = None


class SkillSuggestion(BaseModel):
    """One skill-content idea, with an optional pointer to where in the
    SKILL.md it should land. ``where`` is freeform — typically a section
    name like "Output format" or "Behaviors / rules" — and renders as a
    small label next to the suggestion text in the right rail."""
    summary: str
    where: Optional[str] = None


class SuggestSkillResponse(BaseModel):
    suggestions: list[SkillSuggestion] = Field(default_factory=list)


class GenerateSkillFromGoalsRequest(BaseModel):
    """Generate a full SKILL.md body from goals + stories.

    Distinct from SuggestSkill which returns short bullet hints. This
    endpoint returns a ready-to-paste SKILL.md draft (with frontmatter)
    that the user can then refine inline. session_id is required because
    we read the goals/stories from the persisted session to keep the
    request payload small.
    """
    session_id: str


class GenerateSkillFromGoalsResponse(BaseModel):
    body: str
    name: Optional[str] = None
    description: Optional[str] = None


class ScorerIdea(BaseModel):
    """One scorer idea — short pitch, no code. The user can click to
    promote into a real scorer (we don't auto-create code for it yet)."""
    summary: str
    # Optional dimension hint (coverage / alignment / balance / rot / safety).
    # Free-form so the model can suggest a new dimension if it wants.
    type: Optional[str] = None


class SuggestScorerIdeasResponse(BaseModel):
    suggestions: list[ScorerIdea] = Field(default_factory=list)


class SuggestRevisionsRequest(BaseModel):
    example_ids: list[str] = Field(default_factory=list)


class EnrichRequest(BaseModel):
    gap_type: str  # "coverage" | "balance" | "label" | "feature_area"
    targets: list[str]  # criteria names or feature area names
    count: int = 2


class DatasetResponse(BaseModel):
    id: str
    session_id: str
    version: int
    name: Optional[str]
    status: str
    stats: dict
    examples: list[Example] = Field(default_factory=list)


# --- DB row models ---

class SessionRow(BaseModel):
    id: str
    created_at: datetime
    agent_status: str
    state: dict
    conversation: list[dict]


class CharterRow(BaseModel):
    id: str
    session_id: str
    created_at: datetime
    finalised_at: Optional[datetime] = None
    charter: dict
    weak_criteria: list[dict] = Field(default_factory=list)


# --- Schema detection models ---

class DetectedField(BaseModel):
    """A field detected in sample data."""
    name: str
    type: str  # "string" | "number" | "boolean" | "array" | "object"
    example: Optional[str] = None


class DetectSchemaRequest(BaseModel):
    """Request to detect schema from pasted content."""
    content: str  # Raw pasted content
    content_type: str = "auto"  # "json" | "csv" | "text" | "auto"


class DetectSchemaResponse(BaseModel):
    """Response with detected schema information."""
    input_description: str  # Generated description of the input
    output_description: str = ""  # If output sample provided
    detected_format: str  # "json_object" | "json_array" | "csv" | "freeform_text"
    fields: list[DetectedField] = Field(default_factory=list)
    sample_input: str  # Cleaned sample


class ImportFromUrlRequest(BaseModel):
    """Request to import schema from a URL."""
    url: str
    url_type: str = "auto"  # "json" | "openapi" | "auto"


class ImportFromUrlResponse(BaseModel):
    """Response with task definition from URL import."""
    task: TaskDefinition
    source_url: str
    detected_type: str  # "json_data" | "openapi" | "html_docs"


class FetchSkillFromUrlRequest(BaseModel):
    """Fetch + validate a SKILL.md from a public GitHub URL. Session-agnostic
    — the frontend decides what to do with the returned body (typically
    populating the Skill panel for the user to review before analyzing)."""
    url: str


class GithubSource(BaseModel):
    """Minimum metadata needed to later open a PR back to the same file.
    Stored alongside the seeded skill body so Phase 3 (push-back) can skip
    a second round of user input."""
    owner: str
    repo: str
    ref: str  # branch, tag, or commit SHA
    path: str
    blob_sha: str


class FetchSkillFromUrlResponse(BaseModel):
    """Parsed SKILL.md ready to hand to the existing skill-seed flow."""
    body: str
    name: str | None
    description: str | None
    source: GithubSource


class InferSchemaRequest(BaseModel):
    """Request to infer schema from existing examples."""
    pass  # No parameters needed - uses dataset examples


class InferSchemaResponse(BaseModel):
    """Response with inferred schema from examples."""
    task: TaskDefinition
    confidence: str  # "high" | "medium" | "low"
    example_count: int
    pattern_notes: str  # What patterns were detected


# --- Share tokens (project sharing) ---------------------------------------

class CreateShareTokenRequest(BaseModel):
    """Owner-only payload for minting a new share token."""
    role: str  # 'viewer' | 'editor'
    label: Optional[str] = None


class CreateShareTokenResponse(BaseModel):
    """Returned exactly once at create time — the plaintext `token` is never
    surfaced again, so the frontend must capture it from this response."""
    id: str
    token: str
    role: str
    label: Optional[str] = None
    created_at: datetime


class ShareTokenSummary(BaseModel):
    """List-view shape: redacted, safe to render in the management UI."""
    id: str
    role: str
    label: Optional[str] = None
    token_preview: str  # First 8 chars + "…"
    created_at: datetime
    revoked_at: Optional[datetime] = None
