"""Stage A integration contracts for the PRD -> prod demo pipeline.

These are the frozen seams every build track codes against. See
`docs/quick-demo-plan.md`. Keep this module dependency-light (Pydantic + stdlib
only) so any track can import it without pulling in the rest of the app.

Locked decisions encoded here:
  * Input/artifact convention  -> InputSchema, InputField, ArtifactRef
  * RunFeature seam            -> RunFeatureRequest, RunFeatureResult
  * Trace schema (frozen)      -> Trace (mirrors frontend AgentRowMetadata)
  * Self-improvement loop      -> LoopConfig, LoopRoundEvent
  * Production monitoring      -> ProdLogRecord, ScorerResult
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# 1. Input schema — the seed's typed description of what a feature consumes.
#    Single source of truth driving: the deploy form, dataset synthesis, and
#    RunFeature message assembly.
# ---------------------------------------------------------------------------


class InputFieldType(str, Enum):
    text = "text"
    longtext = "longtext"
    number = "number"
    boolean = "boolean"
    enum = "enum"
    json = "json"
    file = "file"
    image = "image"


class InputField(BaseModel):
    name: str
    type: InputFieldType = InputFieldType.text
    required: bool = True
    description: str = ""
    enum: list[str] = Field(default_factory=list)  # for type == enum
    mime: Optional[str] = None  # for type in {file, image}, e.g. "application/pdf"


def _default_fields() -> list[InputField]:
    # The degenerate case: one text field named "input" == today's plain-string
    # behavior, so existing datasets need no migration.
    return [InputField(name="input", type=InputFieldType.text)]


class InputSchema(BaseModel):
    fields: list[InputField] = Field(default_factory=_default_fields)

    @property
    def is_single_text(self) -> bool:
        return len(self.fields) == 1 and self.fields[0].type in (
            InputFieldType.text,
            InputFieldType.longtext,
        )


# ---------------------------------------------------------------------------
# 2. Artifacts — files travel by reference, never inline base64.
# ---------------------------------------------------------------------------


class ArtifactRef(BaseModel):
    type: Literal["file", "image"] = "file"
    mime: str
    ref: str  # opaque locator into the artifact store (local dir -> object storage)
    filename: str


# A feature input is either a bare string (single-text-field shorthand,
# backward compatible) or a mapping of field name -> value. File/image fields
# carry an ArtifactRef (as a dict on the wire).
FeatureInput = Union[str, dict[str, Any]]


# ---------------------------------------------------------------------------
# 3. Trace — FROZEN to match the frontend `AgentRowMetadata` so EvaluatePanel
#    renders it unchanged, whatever runner produced it. Additive fields below
#    the divider are UI-optional (the current UI ignores unknown keys).
# ---------------------------------------------------------------------------


class ToolCall(BaseModel):
    name: str
    input: dict[str, Any] = Field(default_factory=dict)
    result: str = ""
    is_error: bool = False
    duration_ms: int = 0


class Artifact(BaseModel):
    path: str
    size: int = 0
    sha256: str = ""
    preview: Optional[str] = None
    binary: bool = False


class Trace(BaseModel):
    # --- frozen rendering contract (must match types.ts AgentRowMetadata) ---
    tool_calls: list[ToolCall] = Field(default_factory=list)
    artifacts: list[Artifact] = Field(default_factory=list)
    iterations: int = 0
    stop_reason: Optional[str] = None
    halted: Optional[str] = None
    workspace: Optional[str] = None
    # --- additive, UI-optional ---
    final_text: Optional[str] = None
    model: Optional[str] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    latency_ms: Optional[int] = None


# ---------------------------------------------------------------------------
# 4. RunFeature — the single execution seam. Same contract powers the Evaluate
#    step and the deployed feature, so "what you evaluated is what you ship".
# ---------------------------------------------------------------------------


class RunMode(str, Enum):
    single_shot = "single_shot"  # one messages.create with content blocks
    agent = "agent"  # SDK-in-container tool-use loop (the flexible path)


class RunFeatureRequest(BaseModel):
    skill_id: str
    skill_body: str  # SKILL.md text
    input_schema: InputSchema = Field(default_factory=InputSchema)
    input: FeatureInput  # conforms to input_schema
    mode: RunMode = RunMode.agent
    model: Optional[str] = None
    max_iterations: int = 10
    allow_bash: bool = False


class RunFeatureResult(BaseModel):
    output: str
    trace: Trace = Field(default_factory=Trace)
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# 5. Self-improvement loop — bounded, watchable, optimizes the feature not the
#    measure. "passes" == every scorer >= pass_threshold.
# ---------------------------------------------------------------------------


class LoopTargetPolicy(str, Enum):
    # What the loop may mutate. Default keeps scorers + charter as fixed ground
    # truth so the green checkmark can't be gamed (Goodhart).
    feature_only = "feature_only"
    feature_and_dataset = "feature_and_dataset"


class LoopConfig(BaseModel):
    pass_threshold: float = 0.75  # every scorer must reach this
    max_rounds: int = 5
    target_policy: LoopTargetPolicy = LoopTargetPolicy.feature_only


class LoopRoundEvent(BaseModel):
    """One round, surfaced to the UI (legibility == engagement)."""

    round: int
    changed: str  # human-readable summary of what changed this round
    rationale: str  # why
    scorer_scores: dict[str, float] = Field(default_factory=dict)
    pass_rate: float = 0.0  # fraction of scorers >= threshold
    delta: Optional[float] = None  # change vs previous round
    passed: bool = False  # all scorers >= threshold


# ---------------------------------------------------------------------------
# 6. Production monitoring — one record per deployed-feature invocation.
# ---------------------------------------------------------------------------


class ScorerResult(BaseModel):
    scorer: str
    score: Optional[float] = None  # None == pending (async scoring)
    error: Optional[str] = None


class ProdLogRecord(BaseModel):
    id: str
    skill_id: str
    input: FeatureInput
    output: str
    trace: Trace = Field(default_factory=Trace)
    scores: list[ScorerResult] = Field(default_factory=list)
    latency_ms: Optional[int] = None
    error: Optional[str] = None
    created_at: Optional[str] = None  # ISO8601, stamped by the caller
