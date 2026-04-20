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


# --- Charter models ---

class TaskDefinition(BaseModel):
    """Defines what the app receives and produces."""
    input_description: str = ""  # What the app receives (e.g., "business goals + user stories")
    output_description: str = ""  # What the app produces (e.g., "structured charter JSON")
    sample_input: Optional[str] = None  # Example input
    sample_output: Optional[str] = None  # Example output


class DimensionCriteria(BaseModel):
    criteria: list[str] = Field(default_factory=list)
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
    extracted_stories: list[dict] = Field(default_factory=list)
    scorers: list[dict] = Field(default_factory=list)


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
    expected_output: str
    coverage_tags: list[str] = Field(default_factory=list)
    source: str = "manual"
    label: str = "unlabeled"
    label_reason: Optional[str] = None
    review_status: str = "pending"
    reviewer_notes: Optional[str] = None
    judge_verdict: Optional[dict] = None
    revision_suggestion: Optional[dict] = None
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


class CreateExampleRequest(BaseModel):
    feature_area: str
    input: str
    expected_output: str
    coverage_tags: list[str] = Field(default_factory=list)
    label: str = "unlabeled"
    label_reason: Optional[str] = None


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


class SuggestGoalsResponse(BaseModel):
    suggestions: list[str] = Field(default_factory=list)


class GoalFeedback(BaseModel):
    """Feedback on a single business goal's quality."""
    goal: str
    issue: Optional[str] = None  # null means goal is fine
    suggestion: Optional[str] = None  # improved version if issue exists


class EvaluateGoalsRequest(BaseModel):
    goals: list[str]


class EvaluateGoalsResponse(BaseModel):
    feedback: list[GoalFeedback] = Field(default_factory=list)


class SuggestStoriesRequest(BaseModel):
    goals: list[str]
    stories: list[dict]  # each dict has who, what, why


class SuggestStoriesResponse(BaseModel):
    suggestions: list[dict] = Field(default_factory=list)  # each dict has who, what, why


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


class InferSchemaRequest(BaseModel):
    """Request to infer schema from existing examples."""
    pass  # No parameters needed - uses dataset examples


class InferSchemaResponse(BaseModel):
    """Response with inferred schema from examples."""
    task: TaskDefinition
    confidence: str  # "high" | "medium" | "low"
    example_count: int
    pattern_notes: str  # What patterns were detected
