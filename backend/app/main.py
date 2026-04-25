"""FastAPI application — charter generation agent backend.

Core endpoints:
- GET  /sessions — list all sessions (project list)
- POST /sessions — create a new session (accepts optional name)
- GET  /sessions/{id} — get current session state
- PATCH /sessions/{id}/name — rename a session
- PATCH /sessions/{id}/input — save goals/stories without running agent
- POST /sessions/{id}/message — send a user message
- POST /sessions/{id}/proceed — user-initiated proceed to review
- PATCH /sessions/{id}/charter — user edits during review
- POST /sessions/{id}/finalize — mark charter as final
- GET  /sessions/{id}/turns — get all turns for a session
- POST /judge/run — run judge scoring on unjudged turns
- GET  /judge/results — get judgement results
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid

from contextlib import asynccontextmanager
from dotenv import load_dotenv
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from . import db
from .agent import run_agent_turn, run_dataset_chat
from .eval_runner import EvalResult, run_eval_sync
from .models import (
    AgentStatus,
    Charter,
    CreateDatasetRequest,
    CreateExampleRequest,
    CreateSessionRequest,
    CreateSessionResponse,
    CreateSkillVersionRequest,
    DetectedField,
    DetectSchemaRequest,
    DetectSchemaResponse,
    EnrichRequest,
    EvalMode,
    EvalRunSummary,
    EvaluateGoalsRequest,
    EvaluateGoalsResponse,
    FinalizeResponse,
    GoalFeedback,
    ImprovementSuggestion,
    ImportExamplesRequest,
    ImportFromUrlRequest,
    ImportFromUrlResponse,
    InferSchemaResponse,
    FetchSkillFromUrlRequest,
    FetchSkillFromUrlResponse,
    GithubSource,
    PatchCharterRequest,
    ProceedResponse,
    ProjectSummary,
    RestoreSkillVersionRequest,
    RunEvalRequest,
    SendMessageRequest,
    SendMessageResponse,
    SessionState,
    SetModeRequest,
    Settings,
    SkillSeedRequest,
    SkillSeedResponse,
    SkillVersion,
    SuggestGoalsRequest,
    SuggestGoalsResponse,
    SuggestImprovementsRequest,
    SuggestImprovementsResponse,
    SuggestResponse,
    SuggestStoriesRequest,
    SuggestStoriesResponse,
    SuggestRevisionsRequest,
    SynthesizeRequest,
    TaskDefinition,
    UpdateExampleRequest,
    UpdateInputRequest,
    UpdateSettingsRequest,
    ValidateResponse,
)
from .tools import (
    LLMBillingError,
    call_suggest_goals,
    call_evaluate_goals,
    call_suggest_stories,
    call_validate_charter,
    call_generate_suggestions,
    call_synthesize_examples,
    call_review_examples,
    call_gap_analysis,
    call_generate_scorers,
    call_revise_examples,
    call_detect_schema,
    call_infer_schema,
    call_import_from_url,
    call_skill_seed,
    set_request_api_key,
)

load_dotenv(Path(__file__).parent.parent / ".env", override=True)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    database_url = os.environ.get("DATABASE_URL", "postgresql://localhost:5432/northstar")
    await db.init_db(database_url)
    yield
    await db.close_db()


app = FastAPI(title="North Star", version="0.1.0", lifespan=lifespan)


@app.exception_handler(LLMBillingError)
async def _billing_error_handler(_request: Request, exc: LLMBillingError):
    """Translate provider out-of-credit / billing failures into HTTP 402 with
    a stable shape the frontend can detect. Without this, the frontend just
    saw a generic 500 and the user had to dig into network logs to know why
    generation silently stopped working."""
    from fastapi.responses import JSONResponse
    return JSONResponse(
        status_code=402,
        content={
            "detail": str(exc),
            "error": "llm_billing",
            "provider": exc.provider,
        },
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow any origin for deployed prototype
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Anthropic-Key"],
)


class ApiKeyMiddleware(BaseHTTPMiddleware):
    """Extract X-Anthropic-Key header and set it for the current request context."""
    async def dispatch(self, request: Request, call_next):
        api_key = request.headers.get("x-anthropic-key")
        set_request_api_key(api_key if api_key else None)
        response = await call_next(request)
        return response


# Eval runs are persisted in the eval_runs DB table. The background task
# writes status transitions + final results directly to the row.


app.add_middleware(ApiKeyMiddleware)


# --- Helpers ---

async def _load_state(session_id: str) -> tuple[SessionState, list[dict]]:
    """Load session state from DB, raise 404 if not found."""
    row = await db.get_session(session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    state = SessionState.model_validate(row["state"])
    conversation = row["conversation"]
    return state, conversation


async def _save_state(session_id: str, state: SessionState, conversation: list[dict]) -> None:
    """Persist session state to DB."""
    await db.update_session(session_id, state.model_dump(), conversation)


def _next_skill_version_number(state: SessionState) -> int:
    if not state.skill_versions:
        return 1
    return max((v.get("version", 0) for v in state.skill_versions), default=0) + 1


def _stamp_lineage(state: SessionState, *artifacts: str) -> None:
    """Record that these artifacts were just generated against the current
    active SKILL.md version. UI uses this to show 'Regenerate' affordances
    when the active version later advances past what a tab was built from.
    """
    if not state.active_skill_version_id:
        return
    for artifact in artifacts:
        state.generated_at_skill_version[artifact] = state.active_skill_version_id


def _append_skill_version(
    state: SessionState,
    body: str,
    created_from: str,
    notes: Optional[str] = None,
    applied_suggestion_ids: Optional[list[str]] = None,
) -> dict:
    """Create a new SkillVersion entry, set it active, and return the record.

    Caller is responsible for also updating charter.task.skill_body if this
    version should become the live one.
    """
    from datetime import datetime, timezone

    version = SkillVersion(
        version=_next_skill_version_number(state),
        body=body,
        notes=notes,
        created_from=created_from,
        applied_suggestion_ids=applied_suggestion_ids or [],
        created_at=datetime.now(timezone.utc),
    )
    record = version.model_dump(mode="json")
    state.skill_versions.append(record)
    state.active_skill_version_id = version.id
    return record


# --- Endpoints ---

@app.get("/health")
async def health_check():
    """Health check that also reports whether a default API key is configured."""
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENROUTER_API_KEY"))
    return {"status": "ok", "has_default_api_key": has_key}


@app.post("/suggest-goals", response_model=SuggestGoalsResponse)
async def suggest_goals(req: SuggestGoalsRequest):
    """Suggest additional business goals based on current goals (stateless, no session)."""
    non_empty = [g for g in req.goals if g.strip()]
    if not non_empty:
        return SuggestGoalsResponse(suggestions=[])

    try:
        suggestions, _ = await call_suggest_goals(non_empty)
        return SuggestGoalsResponse(suggestions=suggestions)
    except Exception as e:
        logger.exception("Failed to suggest goals")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/evaluate-goals", response_model=EvaluateGoalsResponse)
async def evaluate_goals(req: EvaluateGoalsRequest):
    """Evaluate business goal quality — check if goals are specific, measurable, independent."""
    non_empty = [g for g in req.goals if g.strip()]
    if not non_empty:
        return EvaluateGoalsResponse(feedback=[])

    try:
        feedback_raw, _ = await call_evaluate_goals(non_empty)
        feedback = [
            GoalFeedback(
                goal=f.get("goal", ""),
                issue=f.get("issue"),
                suggestion=f.get("suggestion"),
            )
            for f in feedback_raw
        ]
        return EvaluateGoalsResponse(feedback=feedback)
    except Exception as e:
        logger.exception("Failed to evaluate goals")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/suggest-stories", response_model=SuggestStoriesResponse)
async def suggest_stories(req: SuggestStoriesRequest):
    """Suggest additional user stories based on goals and existing stories (stateless, no session)."""
    non_empty_goals = [g for g in req.goals if g.strip()]
    non_empty_stories = [s for s in req.stories if s.get("who", "").strip() or s.get("what", "").strip()]
    if not non_empty_goals:
        return SuggestStoriesResponse(suggestions=[])

    try:
        suggestions, _ = await call_suggest_stories(non_empty_goals, non_empty_stories)
        return SuggestStoriesResponse(suggestions=suggestions)
    except Exception as e:
        logger.exception("Failed to suggest stories")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sessions", response_model=CreateSessionResponse)
async def create_session(req: CreateSessionRequest):
    session_id = str(uuid.uuid4())

    state = SessionState(
        session_id=session_id,
        input=req.initial_input,
        agent_status=AgentStatus.drafting,
    )

    await db.create_session(session_id, state.model_dump(), name=req.name)

    # Run initial agent turn
    initial_input_parts = []
    if req.initial_input.business_goals:
        initial_input_parts.append(f"Business goals: {req.initial_input.business_goals}")
    if req.initial_input.user_stories:
        initial_input_parts.append(f"User stories: {req.initial_input.user_stories}")

    result = None
    if initial_input_parts:
        user_msg = "\n\n".join(initial_input_parts)
        result = await run_agent_turn(state, user_msg)
        agent_message = result.message
    else:
        agent_message = "Tell me about the AI feature you're building — what does it do, and what does a good result look like?"

    conversation = state.input.conversation_history.copy()
    await _save_state(session_id, state, conversation)

    return CreateSessionResponse(
        session_id=session_id,
        agent_status=state.agent_status,
        message=agent_message,
        suggestions=result.suggestions if result else [],
        suggested_stories=result.suggested_stories if result else [],
    )


@app.get("/sessions", response_model=list[ProjectSummary])
async def list_sessions():
    """List all sessions ordered by most recently updated."""
    rows = await db.list_sessions(limit=50)
    return [
        ProjectSummary(
            id=r["id"],
            name=r["name"],
            created_at=r["created_at"],
            updated_at=r["updated_at"],
            agent_status=r["agent_status"],
            has_charter=r.get("has_charter", False),
            has_dataset=r.get("has_dataset", False),
        )
        for r in rows
    ]


@app.patch("/sessions/{session_id}/name")
async def rename_session(session_id: str, body: dict):
    """Rename a session."""
    name = body.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    try:
        row = await db.update_session_name(session_id, name)
        return row
    except ValueError:
        raise HTTPException(status_code=404, detail="Session not found")


@app.patch("/sessions/{session_id}/input")
async def update_session_input(session_id: str, req: UpdateInputRequest):
    """Save structured goals and story_groups without triggering the agent."""
    state, conversation = await _load_state(session_id)

    state.input.goals = req.goals
    state.input.story_groups = req.story_groups

    try:
        result = await db.update_session_input(session_id, state.model_dump())
        return {"state": result["state"]}
    except ValueError:
        raise HTTPException(status_code=404, detail="Session not found")


@app.patch("/sessions/{session_id}/mode")
async def set_session_mode(session_id: str, req: SetModeRequest):
    """Set the eval mode for a session.

    - standard: existing flow, no routing decision modeled.
    - triggered: skill/tool/agent under evaluation — enables off-target stories,
      negative coverage, and should_trigger dataset labels.
    """
    state, conversation = await _load_state(session_id)
    state.eval_mode = req.eval_mode
    await _save_state(session_id, state, conversation)
    return {"eval_mode": state.eval_mode.value, "state": state.model_dump()}


@app.post("/sessions/{session_id}/skill-seed", response_model=SkillSeedResponse)
async def seed_from_skill(session_id: str, req: SkillSeedRequest):
    """Seed goals/users/stories/task from a pasted SKILL.md body.

    Switches the session to triggered mode and populates extracted state. The
    user can review and edit before the charter is generated.
    """
    state, conversation = await _load_state(session_id)

    data, call_meta = await call_skill_seed(
        req.skill_body, req.skill_name, req.skill_description,
    )

    # Switch to triggered mode and stamp skill metadata onto the task def.
    state.eval_mode = EvalMode.triggered
    state.charter.task.skill_name = req.skill_name or state.charter.task.skill_name
    state.charter.task.skill_description = req.skill_description or state.charter.task.skill_description
    state.charter.task.skill_body = req.skill_body

    # Snapshot this seeded body as v1 so we can diff against future edits.
    _append_skill_version(
        state,
        body=req.skill_body,
        created_from="seed",
        notes="Seeded from SKILL.md paste.",
    )
    # Stamp lineage so the UI knows these artifacts were generated against v1.
    _stamp_lineage(state, "goals", "users", "stories")

    task_data = data.get("task") or {}
    if task_data.get("input_description"):
        state.charter.task.input_description = task_data["input_description"]
    if task_data.get("output_description"):
        state.charter.task.output_description = task_data["output_description"]
    if task_data.get("sample_input"):
        state.charter.task.sample_input = task_data["sample_input"]
    if task_data.get("sample_output"):
        state.charter.task.sample_output = task_data["sample_output"]

    # Populate extracted state — dedup against any existing entries.
    goals_lower = {g.lower() for g in state.extracted_goals}
    for g in data.get("goals", []):
        if g and g.lower() not in goals_lower:
            state.extracted_goals.append(g)
            goals_lower.add(g.lower())

    users_lower = {u.lower() for u in state.extracted_users}
    for u in data.get("users", []):
        if u and u.lower() not in users_lower:
            state.extracted_users.append(u)
            users_lower.add(u.lower())

    story_keys = {
        (s.get("who", "").lower(), s.get("what", "").lower().strip()[:40])
        for s in state.extracted_stories
    }
    for s in data.get("positive_stories", []) or []:
        if s.get("who") and s.get("what"):
            key = (s["who"].lower(), s["what"].lower().strip()[:40])
            if key not in story_keys:
                state.extracted_stories.append({**s, "kind": "positive"})
                story_keys.add(key)
    for s in data.get("off_target_stories", []) or []:
        if s.get("who") and s.get("what"):
            key = (s["who"].lower(), s["what"].lower().strip()[:40])
            if key not in story_keys:
                state.extracted_stories.append({**s, "kind": "off_target"})
                story_keys.add(key)

    # Mirror extracted state into the structured input fields the UI reads.
    # Without this, the Goals/Users/Stories panels render empty after seeding
    # even though skill-seed successfully pulled everything out of the SKILL.md.
    state.input.goals = list(state.extracted_goals)
    role_to_stories: dict[str, list[dict]] = {}
    for s in state.extracted_stories:
        who = s.get("who", "").strip()
        if not who:
            continue
        bucket = role_to_stories.setdefault(who, [])
        bucket.append({
            "what": s.get("what", ""),
            "why": s.get("why", ""),
            "kind": s.get("kind", "positive"),
        })
    state.input.story_groups = [
        {"role": role, "stories": stories}
        for role, stories in role_to_stories.items()
    ]

    await _save_state(session_id, state, conversation)

    await db.create_turn(
        session_id=session_id,
        turn_type="skill_seed",
        input_snapshot={"skill_name": req.skill_name, "skill_body_len": len(req.skill_body)},
        llm_calls=call_meta,
        parsed_output=data,
    )

    return SkillSeedResponse(
        state=state,
        message=data.get("summary") or "Seeded from SKILL.md. Review goals/users/stories and advance when ready.",
    )


@app.patch("/sessions/{session_id}/scorers")
async def update_session_scorers(session_id: str, body: dict):
    """Save generated scorers to session state."""
    state, conversation = await _load_state(session_id)
    state.scorers = body.get("scorers", [])
    try:
        result = await db.update_session_input(session_id, state.model_dump())
        return {"ok": True}
    except ValueError:
        raise HTTPException(status_code=404, detail="Session not found")


@app.post("/sessions/{session_id}/generate-scorers")
async def generate_scorers_endpoint(session_id: str):
    """Generate evaluation scorers from charter via LLM."""
    state, conversation = await _load_state(session_id)
    charter = state.charter.model_dump()
    scorers, call_meta = await call_generate_scorers(charter)
    state.scorers = scorers
    _stamp_lineage(state, "scorers")
    await _save_state(session_id, state, conversation)
    await db.create_turn(
        session_id=session_id,
        turn_type="generate_scorers",
        input_snapshot={"charter": charter},
        llm_calls=call_meta,
        parsed_output={"scorers": scorers},
    )
    return {"scorers": scorers}


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a session and all associated data."""
    try:
        await db.delete_session(session_id)
        return {"ok": True}
    except ValueError:
        raise HTTPException(status_code=404, detail="Session not found")


@app.post("/sessions/{session_id}/message", response_model=SendMessageResponse)
async def send_message(session_id: str, req: SendMessageRequest):
    state, conversation = await _load_state(session_id)

    result = await run_agent_turn(state, req.message, regenerate=req.regenerate)

    conversation = state.input.conversation_history.copy()
    await _save_state(session_id, state, conversation)

    logger.info(
        f"Turn complete: session={session_id} status={state.agent_status.value} "
        f"tools={result.tool_calls} rounds={state.rounds_of_questions}"
    )

    return SendMessageResponse(
        message=result.message,
        agent_status=state.agent_status,
        state=state,
        tool_calls=result.tool_calls,
        suggestions=result.suggestions,
        suggested_stories=result.suggested_stories,
    )


@app.post("/sessions/{session_id}/proceed", response_model=ProceedResponse)
async def proceed_to_review(session_id: str):
    state, conversation = await _load_state(session_id)

    state.agent_status = AgentStatus.review

    await _save_state(session_id, state, conversation)

    return ProceedResponse(
        agent_status=state.agent_status,
        state=state,
    )


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    row = await db.get_session(session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    state, conversation = await _load_state(session_id)
    return {
        "session_id": session_id,
        "name": row.get("name"),
        "state": state.model_dump(),
        "conversation": conversation,
    }


@app.patch("/sessions/{session_id}/charter")
async def patch_charter(session_id: str, req: PatchCharterRequest):
    state, conversation = await _load_state(session_id)

    if req.coverage is not None:
        state.charter.coverage = req.coverage
    if req.balance is not None:
        state.charter.balance = req.balance
    if req.alignment is not None:
        state.charter.alignment = req.alignment
    if req.rot is not None:
        state.charter.rot = req.rot
    if req.safety is not None:
        state.charter.safety = req.safety

    await _save_state(session_id, state, conversation)

    return {"state": state.model_dump()}


@app.post("/sessions/{session_id}/validate", response_model=ValidateResponse)
async def validate_charter(session_id: str):
    """Run validation on the current charter and return results."""
    state, conversation = await _load_state(session_id)

    validation, call_meta = await call_validate_charter(state)
    state.validation = validation

    await _save_state(session_id, state, conversation)

    # Log the turn
    await db.create_turn(
        session_id=session_id,
        turn_type="validate",
        input_snapshot=state.charter.model_dump(),
        llm_calls=call_meta,
        parsed_output=validation.model_dump(),
    )

    return ValidateResponse(validation=validation, state=state)


@app.post("/sessions/{session_id}/suggest", response_model=SuggestResponse)
async def suggest_for_charter(session_id: str):
    """Generate suggestions for weak/empty charter sections."""
    state, conversation = await _load_state(session_id)

    (suggestions, stories), call_meta = await call_generate_suggestions(state)

    # Log the turn
    await db.create_turn(
        session_id=session_id,
        turn_type="suggest",
        input_snapshot=state.charter.model_dump(),
        llm_calls=call_meta,
        parsed_output={"suggestions": [s.model_dump() for s in suggestions], "stories": [s.model_dump() for s in stories]},
    )

    return SuggestResponse(suggestions=suggestions, suggested_stories=stories)


@app.post("/sessions/{session_id}/finalize", response_model=FinalizeResponse)
async def finalize_session(session_id: str):
    state, conversation = await _load_state(session_id)

    # Collect weak criteria
    weak_criteria = []
    v = state.validation
    if v.coverage.value in ("weak", "fail"):
        weak_criteria.append({"dimension": "coverage", "status": v.coverage.value})
    if v.balance.value in ("weak", "fail"):
        weak_criteria.append({"dimension": "balance", "status": v.balance.value})
    if v.rot.value in ("weak", "fail"):
        weak_criteria.append({"dimension": "rot", "status": v.rot.value})
    for av in v.alignment:
        if av.status.value in ("weak", "fail"):
            weak_criteria.append({
                "dimension": "alignment",
                "feature_area": av.feature_area,
                "status": av.status.value,
                "reason": av.weak_reason,
            })

    # Create charter record
    charter_row = await db.create_charter(
        session_id=session_id,
        charter=state.charter.model_dump(),
        weak_criteria=weak_criteria,
    )

    # Finalize it
    await db.finalize_charter(charter_row["id"])

    _stamp_lineage(state, "charter")

    state.agent_status = AgentStatus.review
    await _save_state(session_id, state, conversation)

    return FinalizeResponse(
        charter_id=charter_row["id"],
        session_id=session_id,
        charter=state.charter,
    )


# --- Turns & Judge Endpoints ---

@app.get("/sessions/{session_id}/turns")
async def get_session_turns(session_id: str):
    turns = await db.get_turns(session_id)
    return {"turns": turns}


def _summarize_turn(turn_type: str, parsed_output: dict | None) -> str | None:
    """Produce a concrete one-liner about what the agent actually did in this turn."""
    if not parsed_output:
        return None

    if turn_type == "generate":
        coverage = len(parsed_output.get("coverage", {}).get("criteria", []) or [])
        alignment = len(parsed_output.get("alignment", []) or [])
        balance = len(parsed_output.get("balance", {}).get("criteria", []) or [])
        rot = len(parsed_output.get("rot", {}).get("criteria", []) or [])
        return (
            f"Drafted charter · {coverage} coverage, {balance} balance, "
            f"{alignment} alignment, {rot} rot"
        )

    if turn_type == "validate":
        overall = parsed_output.get("overall") or "unknown"
        weak = []
        for key in ("coverage", "balance", "rot"):
            if parsed_output.get(key) in ("weak", "fail"):
                weak.append(key)
        alignment = parsed_output.get("alignment") or []
        weak_align = sum(1 for a in alignment if a.get("status") in ("weak", "fail"))
        if weak_align:
            weak.append(f"{weak_align} alignment")
        detail = f"Validated · overall {overall}"
        if weak:
            detail += f" · weak: {', '.join(weak)}"
        return detail

    if turn_type == "suggest":
        s = parsed_output.get("suggestions") or []
        stories = parsed_output.get("stories") or []
        parts = []
        if s:
            parts.append(f"{len(s)} criteria")
        if stories:
            parts.append(f"{len(stories)} stories")
        return "Suggested " + ", ".join(parts) if parts else "Generated suggestions"

    if turn_type in ("synthesize", "enrich"):
        n = parsed_output.get("examples_generated")
        return f"Generated {n} examples" if n is not None else None

    if turn_type == "review":
        reviews = parsed_output.get("reviews") or []
        return f"Reviewed {len(reviews)} examples" if reviews else None

    if turn_type == "generate_scorers":
        scorers = parsed_output.get("scorers") or []
        return f"Generated {len(scorers)} scorers" if scorers else None

    if turn_type == "suggest_revisions":
        revisions = parsed_output.get("revisions") or []
        return f"Suggested {len(revisions)} revisions" if revisions else None

    if turn_type == "gap_analysis":
        coverage_gaps = len(parsed_output.get("coverage_gaps") or [])
        feature_gaps = len(parsed_output.get("feature_area_gaps") or [])
        balance = len(parsed_output.get("balance_issues") or [])
        parts = []
        if coverage_gaps:
            parts.append(f"{coverage_gaps} coverage")
        if feature_gaps:
            parts.append(f"{feature_gaps} feature")
        if balance:
            parts.append(f"{balance} balance")
        if not parts:
            return "No gaps found"
        return "Found gaps · " + ", ".join(parts)

    if turn_type == "discovery":
        goals = len(parsed_output.get("goals") or [])
        users = len(parsed_output.get("users") or [])
        stories = len(parsed_output.get("stories") or [])
        parts = []
        if goals:
            parts.append(f"{goals} goals")
        if users:
            parts.append(f"{users} users")
        if stories:
            parts.append(f"{stories} stories")
        return "Extracted " + ", ".join(parts) if parts else None

    if turn_type == "detect_schema":
        fmt = parsed_output.get("detected_format") or "unknown"
        fields = len(parsed_output.get("fields") or [])
        return f"Detected schema · {fmt}, {fields} fields"

    if turn_type == "import_from_url":
        detected = parsed_output.get("detected_type") or "unknown"
        return f"Imported · {detected}"

    if turn_type == "infer_schema":
        conf = parsed_output.get("confidence") or "unknown"
        n = parsed_output.get("example_count")
        return f"Inferred schema · confidence {conf}" + (f", {n} examples" if n else "")

    return None


@app.get("/sessions/{session_id}/activity")
async def get_session_activity(session_id: str, after: str | None = None):
    """Activity feed for the Polaris panel — turn_type, timestamp, and a summary detail."""
    from datetime import datetime

    after_dt = None
    if after:
        try:
            after_dt = datetime.fromisoformat(after.replace("Z", "+00:00"))
        except ValueError:
            after_dt = None

    items = await db.get_activity(session_id, after=after_dt)
    return {
        "activity": [
            {
                "id": item["id"],
                "created_at": item["created_at"].isoformat(),
                "turn_type": item["turn_type"],
                "detail": _summarize_turn(item["turn_type"], item.get("parsed_output")),
            }
            for item in items
        ]
    }


@app.post("/judge/run")
async def run_judge(session_id: str | None = None, limit: int = 50):
    """Run judge scoring on unjudged turns. Call this manually when you want to evaluate agent quality."""
    from .tools import get_client, get_model

    turns = await db.get_unjudged_turns(session_id=session_id)
    turns = turns[:limit]

    if not turns:
        return {"judged": 0, "message": "No unjudged turns found"}

    results = []
    for turn in turns:
        judge_prompt = _build_judge_prompt(turn)

        response = get_client().messages.create(
            model=get_model(),
            max_tokens=1024,
            messages=[{"role": "user", "content": judge_prompt}],
        )

        text = response.content[0].text if response.content else "{}"

        # Parse scores from response
        try:
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                data = json.loads(text[start:end])
            else:
                data = {}
        except json.JSONDecodeError:
            data = {}

        scores = data.get("scores", {})
        reasoning = data.get("reasoning", text)

        judgement = await db.create_judgement(
            turn_id=turn["id"],
            judge_model=get_model(),
            judge_prompt=judge_prompt,
            scores=scores,
            reasoning=reasoning,
        )
        results.append({"turn_id": turn["id"], "scores": scores})

    return {"judged": len(results), "results": results}


def _build_judge_prompt(turn: dict) -> str:
    """Build a judge prompt for a single turn."""
    turn_type = turn["turn_type"]
    input_snapshot = turn.get("input_snapshot", {})
    llm_calls = turn.get("llm_calls", [])
    parsed_output = turn.get("parsed_output")
    agent_message = turn.get("agent_message")

    # Get the raw LLM response from the first call
    raw_response = llm_calls[0]["raw_response"] if llm_calls else "(no response captured)"

    if turn_type == "generate":
        return f"""You are a judge evaluating a charter generation agent. The agent was given user input and generated a charter draft.

User input:
{json.dumps(input_snapshot, indent=2)}

Agent's generated charter:
{json.dumps(parsed_output, indent=2)}

Score the agent on these dimensions (0.0 to 1.0):
- **specificity**: Are criteria specific and testable, or vague/generic?
- **traceability**: Are criteria directly traceable to the user's input, or invented?
- **completeness**: Did the agent address all relevant sections given the input?
- **conciseness**: Did the agent avoid over-generating beyond what the input supports?

Return ONLY JSON:
{{"scores": {{"specificity": 0.0, "traceability": 0.0, "completeness": 0.0, "conciseness": 0.0}}, "reasoning": "brief explanation"}}"""

    elif turn_type == "validate":
        return f"""You are a judge evaluating a charter validation step. The agent validated a charter and assigned pass/weak/fail statuses.

Charter being validated:
{json.dumps(input_snapshot, indent=2)}

Validation result:
{json.dumps(parsed_output, indent=2)}

Score the validation on these dimensions (0.0 to 1.0):
- **accuracy**: Do the pass/weak/fail ratings correctly identify issues?
- **strictness**: Is the validator appropriately strict (not rubber-stamping)?
- **actionability**: Do weak/fail reasons point to specific improvements?

Return ONLY JSON:
{{"scores": {{"accuracy": 0.0, "strictness": 0.0, "actionability": 0.0}}, "reasoning": "brief explanation"}}"""

    elif turn_type == "chat":
        return f"""You are a judge evaluating a conversational turn from a charter-building agent.

Context:
{json.dumps(input_snapshot, indent=2)}

Agent's message to user:
{agent_message or "(no message)"}

Charter update applied: {json.dumps(parsed_output) if parsed_output else "None"}

Score the agent on these dimensions (0.0 to 1.0):
- **relevance**: Does the response address what the user said?
- **brevity**: Is the response concise and scannable?
- **question_quality**: Are follow-up questions specific and useful?
- **update_accuracy**: If a charter update was made, is it correct and minimal?

Return ONLY JSON:
{{"scores": {{"relevance": 0.0, "brevity": 0.0, "question_quality": 0.0, "update_accuracy": 0.0}}, "reasoning": "brief explanation"}}"""

    elif turn_type == "suggest":
        return f"""You are a judge evaluating suggestion generation from a charter-building agent.

Context:
{json.dumps(input_snapshot, indent=2)}

Suggestions generated:
{json.dumps(turn.get("suggestions"), indent=2)}

Score the suggestions on these dimensions (0.0 to 1.0):
- **relevance**: Are suggestions relevant to the user's specific product?
- **specificity**: Are suggestions concrete and actionable?
- **diversity**: Do suggestions cover different sections/aspects?

Return ONLY JSON:
{{"scores": {{"relevance": 0.0, "specificity": 0.0, "diversity": 0.0}}, "reasoning": "brief explanation"}}"""

    else:
        return f"""You are a judge evaluating an agent turn of type "{turn_type}".

Input: {json.dumps(input_snapshot, indent=2)}
Output: {json.dumps(parsed_output, indent=2)}
Message: {agent_message or "(none)"}

Score overall quality (0.0 to 1.0):
Return ONLY JSON:
{{"scores": {{"quality": 0.0}}, "reasoning": "brief explanation"}}"""


# --- Dataset Endpoints ---

@app.post("/sessions/{session_id}/dataset")
async def create_dataset(session_id: str, req: CreateDatasetRequest):
    """Create a dataset for this session's charter."""
    state, _ = await _load_state(session_id)
    charter_snapshot = state.charter.model_dump()

    dataset = await db.create_dataset(
        session_id=session_id,
        name=req.name or f"Dataset for {session_id[:8]}",
        charter_snapshot=charter_snapshot,
    )
    return dataset


@app.get("/sessions/{session_id}/dataset")
async def get_session_dataset(session_id: str):
    """Get the latest dataset for a session, with examples and stats."""
    dataset = await db.get_dataset_by_session(session_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="No dataset found for this session")

    examples = await db.get_examples(dataset["id"])
    stats = await db.update_dataset_stats(dataset["id"])
    dataset["stats"] = stats
    dataset["examples"] = examples
    return dataset


@app.get("/datasets/{dataset_id}/versions")
async def get_dataset_versions(dataset_id: str):
    """List all versions of a dataset."""
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    versions = await db.get_dataset_versions(dataset["session_id"])
    return {"versions": versions}


@app.post("/datasets/{dataset_id}/version")
async def create_dataset_version(dataset_id: str):
    """Snapshot current dataset as a new version."""
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    state, _ = await _load_state(dataset["session_id"])
    charter_snapshot = state.charter.model_dump()

    new_version = await db.create_dataset_version(dataset_id, charter_snapshot)
    return new_version


@app.post("/datasets/{dataset_id}/import")
async def import_examples(dataset_id: str, req: ImportExamplesRequest):
    """Import examples from JSON."""
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    # Normalize imported examples
    normalized = []
    for ex in req.examples:
        normalized.append({
            "feature_area": ex.get("feature_area", "unassigned"),
            "input": ex.get("input", ""),
            "expected_output": ex.get("expected_output", "") or "",
            "coverage_tags": ex.get("coverage_tags", []),
            "source": "imported",
            "label": ex.get("label", "unlabeled"),
            "label_reason": ex.get("label_reason"),
            "should_trigger": ex.get("should_trigger"),
            "is_adversarial": ex.get("is_adversarial"),
        })

    created = await db.bulk_create_examples(dataset_id, normalized)
    stats = await db.update_dataset_stats(dataset_id)
    return {"imported": len(created), "stats": stats}


@app.post("/datasets/{dataset_id}/synthesize")
async def synthesize_examples(dataset_id: str, req: SynthesizeRequest):
    """Generate synthetic examples from the charter."""
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    charter = dataset["charter_snapshot"]
    generated, call_meta = await call_synthesize_examples(
        charter,
        feature_areas=req.feature_areas,
        coverage_criteria=req.coverage_criteria,
        count=req.count_per_scenario,
    )

    # Add source marker and persist
    for ex in generated:
        ex["source"] = "synthetic"

    created = await db.bulk_create_examples(dataset_id, generated)

    # Log the turn
    await db.create_turn(
        session_id=dataset["session_id"],
        turn_type="synthesize",
        input_snapshot={"charter": charter, "request": req.model_dump()},
        llm_calls=call_meta,
        parsed_output={"examples_generated": len(created)},
    )

    # Stamp lineage — dataset generated against the current active skill version.
    state, conversation = await _load_state(dataset["session_id"])
    _stamp_lineage(state, "dataset")
    await _save_state(dataset["session_id"], state, conversation)

    stats = await db.update_dataset_stats(dataset_id)
    return {"generated": len(created), "examples": created, "stats": stats}


@app.get("/datasets/{dataset_id}/examples")
async def list_examples(
    dataset_id: str,
    feature_area: str | None = None,
    label: str | None = None,
    review_status: str | None = None,
    source: str | None = None,
):
    """List examples with optional filters."""
    examples = await db.get_examples(
        dataset_id,
        feature_area=feature_area,
        label=label,
        review_status=review_status,
        source=source,
    )
    return {"examples": examples}


@app.post("/datasets/{dataset_id}/examples")
async def add_example(dataset_id: str, req: CreateExampleRequest):
    """Add a manual example."""
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    example = await db.create_example(
        dataset_id=dataset_id,
        feature_area=req.feature_area,
        input_text=req.input,
        expected_output=req.expected_output,
        coverage_tags=req.coverage_tags,
        source="manual",
        label=req.label,
        label_reason=req.label_reason,
        should_trigger=req.should_trigger,
        is_adversarial=req.is_adversarial,
    )
    await db.update_dataset_stats(dataset_id)
    return example


@app.patch("/datasets/{dataset_id}/examples/{example_id}")
async def update_example(dataset_id: str, example_id: str, req: UpdateExampleRequest):
    """Update an example (edit, approve, reject, relabel)."""
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    example = await db.update_example(example_id, fields)
    await db.update_dataset_stats(dataset_id)
    return example


@app.delete("/datasets/{dataset_id}/examples/{example_id}")
async def remove_example(dataset_id: str, example_id: str):
    """Remove an example from the dataset."""
    deleted = await db.delete_example(example_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Example not found")
    await db.update_dataset_stats(dataset_id)
    return {"deleted": True}


@app.post("/datasets/{dataset_id}/review")
async def auto_review_examples(dataset_id: str):
    """Run auto-review on pending examples using the judge."""
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    charter = dataset["charter_snapshot"]
    examples = await db.get_examples(dataset_id, review_status="pending")

    if not examples:
        return {"reviewed": 0, "message": "No pending examples to review"}

    # Process in batches of 10
    all_reviews = []
    batch_size = 10
    for i in range(0, len(examples), batch_size):
        batch = examples[i:i + batch_size]
        batch_for_review = [
            {"id": ex["id"], "feature_area": ex["feature_area"],
             "input": ex["input"], "expected_output": ex["expected_output"],
             "label": ex["label"], "should_trigger": ex.get("should_trigger")}
            for ex in batch
        ]
        reviews, call_meta = await call_review_examples(charter, batch_for_review)

        # Apply verdicts — triggered-mode reviews carry trigger_verdict + execution_verdict.
        for review in reviews:
            eid = review.get("example_id")
            if eid:
                verdict = {
                    "suggested_label": review.get("suggested_label"),
                    "confidence": review.get("confidence"),
                    "reasoning": review.get("reasoning"),
                    "coverage_match": review.get("coverage_match", []),
                    "issues": review.get("issues", []),
                }
                if review.get("trigger_verdict") is not None:
                    verdict["trigger_verdict"] = review.get("trigger_verdict")
                if review.get("execution_verdict") is not None:
                    verdict["execution_verdict"] = review.get("execution_verdict")
                await db.update_example(eid, {"judge_verdict": verdict})
        all_reviews.extend(reviews)

        await db.create_turn(
            session_id=dataset["session_id"],
            turn_type="review",
            input_snapshot={"charter": charter, "example_count": len(batch)},
            llm_calls=call_meta,
            parsed_output={"reviews": reviews},
        )

    await db.update_dataset_stats(dataset_id)
    return {"reviewed": len(all_reviews), "reviews": all_reviews}


@app.post("/datasets/{dataset_id}/suggest-revisions")
async def suggest_revisions(dataset_id: str, req: SuggestRevisionsRequest):
    """Suggest revisions for examples that have review issues."""
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    charter = dataset["charter_snapshot"]

    if req.example_ids:
        # Fetch specific examples
        all_examples = await db.get_examples(dataset_id)
        examples = [ex for ex in all_examples if ex["id"] in req.example_ids]
    else:
        # Fetch all examples with review issues
        all_examples = await db.get_examples(dataset_id)
        examples = [
            ex for ex in all_examples
            if ex.get("judge_verdict") and ex["judge_verdict"].get("issues")
        ]

    if not examples:
        return {"revised": 0, "message": "No examples with issues to revise"}

    # Process in batches of 10
    all_revisions = []
    batch_size = 10
    for i in range(0, len(examples), batch_size):
        batch = examples[i:i + batch_size]
        batch_for_revision = [
            {"id": ex["id"], "feature_area": ex["feature_area"],
             "input": ex["input"], "expected_output": ex["expected_output"],
             "label": ex["label"], "judge_verdict": ex.get("judge_verdict")}
            for ex in batch
        ]
        revisions, call_meta = await call_revise_examples(charter, batch_for_revision)

        # Store revision suggestions
        for rev in revisions:
            eid = rev.get("example_id")
            if eid:
                await db.update_example(eid, {
                    "revision_suggestion": {
                        "input": rev.get("revised_input", ""),
                        "expected_output": rev.get("revised_expected_output", ""),
                        "reasoning": rev.get("reasoning", ""),
                    }
                })
        all_revisions.extend(revisions)

        await db.create_turn(
            session_id=dataset["session_id"],
            turn_type="suggest_revisions",
            input_snapshot={"charter": charter, "example_count": len(batch)},
            llm_calls=call_meta,
            parsed_output={"revisions": revisions},
        )

    await db.update_dataset_stats(dataset_id)
    return {"revised": len(all_revisions), "revisions": all_revisions}


@app.get("/datasets/{dataset_id}/gaps")
async def analyze_gaps(dataset_id: str):
    """Run coverage and balance gap analysis."""
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    charter = dataset["charter_snapshot"]
    examples = await db.get_examples(dataset_id)
    stats = await db.update_dataset_stats(dataset_id)

    gaps, call_meta = await call_gap_analysis(charter, stats, examples)

    await db.create_turn(
        session_id=dataset["session_id"],
        turn_type="gap_analysis",
        input_snapshot={"charter": charter, "stats": stats},
        llm_calls=call_meta,
        parsed_output=gaps,
    )

    return gaps


@app.post("/datasets/{dataset_id}/enrich")
async def enrich_dataset(dataset_id: str, req: EnrichRequest):
    """Generate examples to fill identified gaps."""
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    charter = dataset["charter_snapshot"]

    if req.gap_type == "coverage":
        generated, call_meta = await call_synthesize_examples(
            charter, coverage_criteria=req.targets, count=req.count,
        )
    elif req.gap_type in ("feature_area", "label"):
        generated, call_meta = await call_synthesize_examples(
            charter, feature_areas=req.targets, count=req.count,
        )
    else:
        raise HTTPException(status_code=400, detail=f"Unknown gap type: {req.gap_type}")

    for ex in generated:
        ex["source"] = "synthetic"

    created = await db.bulk_create_examples(dataset_id, generated)

    await db.create_turn(
        session_id=dataset["session_id"],
        turn_type="enrich",
        input_snapshot={"charter": charter, "gap_type": req.gap_type, "targets": req.targets},
        llm_calls=call_meta,
        parsed_output={"examples_generated": len(created)},
    )

    stats = await db.update_dataset_stats(dataset_id)
    return {"generated": len(created), "examples": created, "stats": stats}


@app.post("/datasets/{dataset_id}/chat")
async def dataset_chat(dataset_id: str, req: SendMessageRequest):
    """Chat with the agent in dataset phase."""
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    state, conversation = await _load_state(dataset["session_id"])
    stats = await db.update_dataset_stats(dataset_id)

    result = await run_dataset_chat(state, req.message, stats)

    await _save_state(dataset["session_id"], state, state.input.conversation_history)

    return {
        "message": result.message,
        "state": state.model_dump(),
        "actions": result.actions,
        "action_suggestions": result.action_suggestions,
    }


@app.get("/datasets/{dataset_id}/export")
async def export_dataset_endpoint(dataset_id: str):
    """Export approved examples as JSON."""
    try:
        return await db.export_dataset(dataset_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/datasets/{dataset_id}/export/skill-creator")
async def export_for_skill_creator(dataset_id: str):
    """Export triggering rows in a format skill-creator's eval harness consumes.

    Emits approved rows that carry should_trigger (true or false). Each row
    becomes {prompt, should_trigger}. Rows without should_trigger (standard
    mode) are omitted — they belong in the execution-eval export.
    """
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    examples = await db.get_examples(dataset_id, review_status="approved")
    trigger_rows = [
        {
            "prompt": ex["input"],
            "should_trigger": ex["should_trigger"],
            "tags": ex.get("coverage_tags", []),
            "notes": ex.get("label_reason") or None,
        }
        for ex in examples
        if ex.get("should_trigger") is not None
    ]

    charter = dataset.get("charter_snapshot", {}) or {}
    task = charter.get("task", {}) or {}

    return {
        "dataset_id": dataset_id,
        "session_id": dataset["session_id"],
        "skill_name": task.get("skill_name"),
        "skill_description": task.get("skill_description"),
        "rows": trigger_rows,
        "counts": {
            "total": len(trigger_rows),
            "should_trigger": sum(1 for r in trigger_rows if r["should_trigger"]),
            "should_not_trigger": sum(1 for r in trigger_rows if r["should_trigger"] is False),
        },
    }


# --- Eval run endpoints (Braintrust execution eval from the UI) ---

def _eval_run_to_summary(run: dict) -> EvalRunSummary:
    # DB rows have `id` not `run_id`; normalize.
    return EvalRunSummary(
        run_id=run.get("run_id") or run["id"],
        status=run["status"],
        project=run["project"],
        experiment_name=run.get("experiment_name"),
        experiment_url=run.get("experiment_url"),
        rows_total=run.get("rows_total", 0) or 0,
        rows_evaluated=run.get("rows_evaluated", 0) or 0,
        scorer_names=run.get("scorer_names", []) or [],
        scorer_averages=run.get("scorer_averages", {}) or {},
        per_row=run.get("per_row", []) or [],
        error=run.get("error"),
        started_at=run.get("started_at"),
        finished_at=run.get("finished_at"),
        skill_version_id=run.get("skill_version_id"),
        skill_version_number=run.get("skill_version_number"),
        charter_snapshot=run.get("charter_snapshot"),
        improvement_suggestions=run.get("improvement_suggestions"),
        improvement_summary=run.get("improvement_summary"),
    )


async def _execute_eval_run(
    run_id: str,
    skill_body: str,
    scorer_defs: list[dict],
    examples: list[dict],
    braintrust_key: str,
    anthropic_key: str | None,
    req: RunEvalRequest,
) -> None:
    """Background task: runs the blocking eval off the event loop.

    All status transitions + results are written to the eval_runs DB row so
    the UI sees them on the next poll, and history survives process restarts.
    """
    import asyncio
    from datetime import datetime, timezone
    from .eval_runner import DEFAULT_JUDGE_MODEL, DEFAULT_MODEL

    await db.update_eval_run(run_id, {
        "status": "running",
        "started_at": datetime.now(timezone.utc),
    })

    try:
        result: EvalResult = await asyncio.to_thread(
            run_eval_sync,
            skill_body=skill_body,
            scorer_defs=scorer_defs,
            examples=examples,
            braintrust_api_key=braintrust_key,
            project=req.project,
            experiment_name=req.experiment_name,
            anthropic_api_key=anthropic_key,
            model=req.model or DEFAULT_MODEL,
            judge_model=req.judge_model or DEFAULT_JUDGE_MODEL,
            include_triggering=req.include_triggering,
            limit=req.limit,
        )
        await db.update_eval_run(run_id, {
            "status": "done",
            "finished_at": datetime.now(timezone.utc),
            "experiment_url": result.experiment_url,
            "experiment_name": result.experiment_name,
            "rows_evaluated": result.rows_evaluated,
            "scorer_names": result.scorer_names,
            "scorer_averages": result.scorer_averages,
            "per_row": result.per_row,
        })
    except Exception as e:  # noqa: BLE001
        logger.exception("Eval run %s failed", run_id)
        await db.update_eval_run(run_id, {
            "status": "error",
            "error": str(e),
            "finished_at": datetime.now(timezone.utc),
        })


@app.post("/sessions/{session_id}/run-eval", response_model=EvalRunSummary)
async def run_eval_for_session(session_id: str, req: RunEvalRequest, request: Request):
    """Trigger a Braintrust eval run for this session's dataset + scorers + skill.

    Braintrust API key is read from the X-Braintrust-Key header. Anthropic key
    from X-Anthropic-Key (same pattern as other endpoints). Runs asynchronously
    in a background task; poll GET /sessions/{id}/eval-runs/{run_id} for status.
    """
    import asyncio
    import uuid as _uuid
    from datetime import datetime, timezone

    braintrust_key = request.headers.get("x-braintrust-key") or os.environ.get("BRAINTRUST_API_KEY")
    if not braintrust_key:
        raise HTTPException(
            status_code=400,
            detail="Braintrust API key required. Add it in Settings or send X-Braintrust-Key header.",
        )

    state, conversation = await _load_state(session_id)
    skill_body = state.charter.task.skill_body or ""
    if not skill_body.strip():
        raise HTTPException(
            status_code=400,
            detail="Session has no skill_body on its charter. Seed from a SKILL.md first.",
        )

    scorer_defs = state.scorers or []
    if not scorer_defs:
        raise HTTPException(
            status_code=400,
            detail="No scorers on this session. Generate them in the Scorers tab first.",
        )

    dataset = await db.get_dataset_by_session(session_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="No dataset for this session.")

    examples = await db.get_examples(dataset["id"])
    if not examples:
        raise HTTPException(status_code=400, detail="Dataset is empty.")

    anthropic_key = request.headers.get("x-anthropic-key") or None

    # Capture the active SKILL.md version so this run is tied to a specific edit.
    # If the session was seeded before versioning landed, auto-create v1 from
    # the current body so later diffs have something to compare against.
    active_ver_id = state.active_skill_version_id
    active_ver_num: int | None = None
    if not state.skill_versions:
        record = _append_skill_version(
            state,
            body=skill_body,
            created_from="seed",
            notes="Backfilled v1 from existing SKILL.md body.",
        )
        active_ver_id = record["id"]
        active_ver_num = record["version"]
        await _save_state(session_id, state, conversation)
    else:
        for v in state.skill_versions:
            if v.get("id") == active_ver_id:
                active_ver_num = v.get("version")
                break

    run_id = str(_uuid.uuid4())
    run_row = await db.create_eval_run(
        run_id=run_id,
        session_id=session_id,
        project=req.project,
        experiment_name=req.experiment_name,
        rows_total=len(examples),
        skill_version_id=active_ver_id,
        skill_version_number=active_ver_num,
        charter_snapshot=state.charter.model_dump(),
    )

    asyncio.create_task(
        _execute_eval_run(
            run_id=run_id,
            skill_body=skill_body,
            scorer_defs=scorer_defs,
            examples=examples,
            braintrust_key=braintrust_key,
            anthropic_key=anthropic_key,
            req=req,
        )
    )

    return _eval_run_to_summary(run_row)


@app.get("/sessions/{session_id}/eval-runs/{run_id}", response_model=EvalRunSummary)
async def get_eval_run_endpoint(session_id: str, run_id: str):
    """Poll an eval run's status. Returns the latest snapshot from the DB."""
    run = await db.get_eval_run(run_id)
    if run is None or run.get("session_id") != session_id:
        raise HTTPException(status_code=404, detail="Eval run not found")
    return _eval_run_to_summary(run)


@app.get("/sessions/{session_id}/eval-runs", response_model=list[EvalRunSummary])
async def list_eval_runs_endpoint(session_id: str):
    """List all eval runs for this session (most recent first)."""
    runs = await db.list_eval_runs(session_id)
    return [_eval_run_to_summary(r) for r in runs]


# --- Skill version endpoints (Path A: iterate SKILL.md from eval failures) ---

@app.get("/sessions/{session_id}/skill-versions", response_model=list[SkillVersion])
async def list_skill_versions(session_id: str):
    """List all skill versions for this session (newest first)."""
    state, _ = await _load_state(session_id)
    versions = list(state.skill_versions)
    versions.sort(key=lambda v: v.get("version", 0), reverse=True)
    return [SkillVersion(**v) for v in versions]


@app.post("/sessions/{session_id}/skill-versions", response_model=SkillVersion)
async def create_skill_version(session_id: str, req: CreateSkillVersionRequest):
    """Create a new SKILL.md version and set it as active.

    Updates charter.task.skill_body so subsequent evals use the new body. The
    prior body stays in skill_versions history.
    """
    state, conversation = await _load_state(session_id)

    # If this is the first version on a legacy session, backfill v1 from the
    # current body so the new one doesn't land as v1 with history missing.
    if not state.skill_versions and (state.charter.task.skill_body or "").strip():
        _append_skill_version(
            state,
            body=state.charter.task.skill_body or "",
            created_from="seed",
            notes="Backfilled v1 from existing SKILL.md body.",
        )

    record = _append_skill_version(
        state,
        body=req.body,
        created_from=req.created_from or "manual",
        notes=req.notes,
        applied_suggestion_ids=req.applied_suggestion_ids,
    )
    state.charter.task.skill_body = req.body
    await _save_state(session_id, state, conversation)
    return SkillVersion(**record)


@app.post("/sessions/{session_id}/skill-versions/restore", response_model=SkillVersion)
async def restore_skill_version(session_id: str, req: RestoreSkillVersionRequest):
    """Make a previous version the active one. Does NOT rewrite history —
    the restored version becomes the latest active; older versions are kept."""
    state, conversation = await _load_state(session_id)
    target = next((v for v in state.skill_versions if v.get("id") == req.version_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Skill version not found")

    state.active_skill_version_id = target["id"]
    state.charter.task.skill_body = target["body"]
    await _save_state(session_id, state, conversation)
    return SkillVersion(**target)


@app.post(
    "/sessions/{session_id}/suggest-improvements",
    response_model=SuggestImprovementsResponse,
)
async def suggest_skill_improvements(session_id: str, req: SuggestImprovementsRequest):
    """Analyze a completed eval run and propose targeted SKILL.md edits.

    Reads the run (in-memory for MVP), the current SKILL.md body, and the
    charter. Returns a list of suggestions with rationale + row citations.
    """
    from .tools import call_suggest_improvements

    run = await db.get_eval_run(req.run_id)
    if run is None or run.get("session_id") != session_id:
        raise HTTPException(status_code=404, detail="Eval run not found")
    if run.get("status") != "done":
        raise HTTPException(
            status_code=400,
            detail=f"Eval run must be completed (current status: {run.get('status')}).",
        )

    state, _ = await _load_state(session_id)
    skill_body = state.charter.task.skill_body or ""
    if not skill_body.strip():
        raise HTTPException(status_code=400, detail="Session has no active SKILL.md to improve.")

    data, call_meta = await call_suggest_improvements(
        skill_body,
        run,
        state.charter.model_dump(),
    )

    await db.create_turn(
        session_id=session_id,
        turn_type="suggest_improvements",
        input_snapshot={"run_id": req.run_id, "skill_version_id": run.get("skill_version_id")},
        llm_calls=call_meta,
        parsed_output=data,
    )

    suggestions = [
        ImprovementSuggestion(**s) for s in data.get("suggestions", []) if s.get("replacement")
    ]

    # Persist on the eval_run so the UI can show these on reload without
    # having to re-analyze (which costs tokens + time).
    summary = data.get("summary") or ""
    await db.update_eval_run(req.run_id, {
        "improvement_suggestions": [s.model_dump(mode="json") for s in suggestions],
        "improvement_summary": summary,
    })

    return SuggestImprovementsResponse(
        suggestions=suggestions,
        summary=summary,
        run_id=req.run_id,
        skill_version_id=run.get("skill_version_id"),
    )


# --- Settings Endpoints ---

@app.get("/settings", response_model=Settings)
async def get_settings():
    """Get current agent settings."""
    row = await db.get_settings()
    return Settings(
        model_name=row["model_name"],
        max_rounds=row["max_rounds"],
        creativity=row["creativity"],
    )


@app.patch("/settings", response_model=Settings)
async def update_settings(req: UpdateSettingsRequest):
    """Update agent settings."""
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Validate creativity range
    if "creativity" in fields:
        fields["creativity"] = max(0.0, min(1.0, fields["creativity"]))

    row = await db.update_settings(fields)
    return Settings(
        model_name=row["model_name"],
        max_rounds=row["max_rounds"],
        creativity=row["creativity"],
    )


@app.get("/judge/results")
async def get_judge_results(session_id: str | None = None):
    judgements = await db.get_judgements(session_id=session_id)
    return {"judgements": judgements}


# --- Schema Detection Endpoints ---

@app.post("/sessions/{session_id}/detect-schema", response_model=DetectSchemaResponse)
async def detect_schema(session_id: str, req: DetectSchemaRequest):
    """Detect schema from pasted sample data."""
    # Verify session exists
    state, _ = await _load_state(session_id)

    result, call_meta = await call_detect_schema(req.content, req.content_type)

    # Parse fields from result
    fields = [
        DetectedField(
            name=f.get("name", ""),
            type=f.get("type", "string"),
            example=f.get("example"),
        )
        for f in result.get("fields", [])
    ]

    # Log the turn
    await db.create_turn(
        session_id=session_id,
        turn_type="detect_schema",
        input_snapshot={"content_preview": req.content[:500], "content_type": req.content_type},
        llm_calls=call_meta,
        parsed_output=result,
    )

    return DetectSchemaResponse(
        input_description=result.get("input_description", ""),
        output_description=result.get("output_description", ""),
        detected_format=result.get("detected_format", "freeform_text"),
        fields=fields,
        sample_input=result.get("sample_input", req.content),
    )


@app.post("/sessions/{session_id}/import-from-url", response_model=ImportFromUrlResponse)
async def import_from_url(session_id: str, req: ImportFromUrlRequest):
    """Import schema from a URL (JSON data, OpenAPI spec, or docs)."""
    import httpx

    # Verify session exists
    state, _ = await _load_state(session_id)

    # Fetch URL content
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(req.url, follow_redirects=True)
            response.raise_for_status()
            content = response.text
    except httpx.HTTPError as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {str(e)}")

    # Detect content type
    content_type = response.headers.get("content-type", "")
    if req.url_type != "auto":
        detected_type = req.url_type
    elif "application/json" in content_type or req.url.endswith(".json"):
        # Check if it looks like OpenAPI
        if '"openapi"' in content or '"swagger"' in content:
            detected_type = "openapi"
        else:
            detected_type = "json_data"
    elif "text/html" in content_type:
        detected_type = "html_docs"
    else:
        detected_type = "json_data"  # Default

    result, call_meta = await call_import_from_url(content, req.url, detected_type)

    # Parse task definition from result
    task_data = result.get("task", {})
    task = TaskDefinition(
        input_description=task_data.get("input_description", ""),
        output_description=task_data.get("output_description", ""),
        sample_input=task_data.get("sample_input"),
        sample_output=task_data.get("sample_output"),
    )

    # Log the turn
    await db.create_turn(
        session_id=session_id,
        turn_type="import_from_url",
        input_snapshot={"url": req.url, "url_type": req.url_type, "detected_type": detected_type},
        llm_calls=call_meta,
        parsed_output=result,
    )

    return ImportFromUrlResponse(
        task=task,
        source_url=req.url,
        detected_type=result.get("detected_type", detected_type),
    )


# --- Skill source fetch (Phase 1 of GitHub integration) -------------------

_GITHUB_BLOB_RE = re.compile(
    r"^https?://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/blob/(?P<ref>[^/]+)/(?P<path>.+)$"
)
_GITHUB_RAW_RE = re.compile(
    r"^https?://raw\.githubusercontent\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/(?P<ref>[^/]+)/(?P<path>.+)$"
)
_SKILL_MAX_BYTES = 1_000_000  # 1 MB — more than any real SKILL.md will ever be.


def _parse_github_url(url: str) -> tuple[str, str, str, str]:
    """Extract (owner, repo, ref, path) from either a github.com/blob URL or a
    raw.githubusercontent.com URL. Raises 400 on anything else."""
    url = url.strip().split("?", 1)[0].rstrip("/")
    m = _GITHUB_BLOB_RE.match(url) or _GITHUB_RAW_RE.match(url)
    if not m:
        raise HTTPException(
            status_code=400,
            detail=(
                "URL must be a GitHub file link like "
                "https://github.com/<owner>/<repo>/blob/<ref>/path/to/SKILL.md"
            ),
        )
    return m.group("owner"), m.group("repo"), m.group("ref"), m.group("path")


def _parse_skill_frontmatter(raw: str) -> tuple[str | None, str | None, str]:
    """YAML-ish frontmatter parser — same semantics as the frontend's
    parseSkillFrontmatter. Returns (name, description, body)."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", raw, re.DOTALL)
    if not m:
        return None, None, raw
    front, body = m.group(1), m.group(2)
    def pick(key: str) -> str | None:
        for line in front.splitlines():
            if line.strip().lower().startswith(f"{key}:"):
                value = line.split(":", 1)[1].strip()
                return value.strip("'\"") or None
        return None
    return pick("name"), pick("description"), body


@app.post("/fetch-skill-from-url", response_model=FetchSkillFromUrlResponse)
async def fetch_skill_from_url(req: FetchSkillFromUrlRequest, request: Request):
    """Fetch a SKILL.md from a public GitHub URL + validate it looks like a
    skill (frontmatter with `name` and `description`). Returns the parsed
    body and source metadata the frontend can hand back to `skill-seed`.

    An optional `X-Github-Token` header authenticates the call — pushes the
    IP-based rate limit (60/hr) up to the token's limit (5000/hr). Not
    required for public repos.
    """
    import httpx

    owner, repo, ref, path = _parse_github_url(req.url)

    api_url = f"https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={ref}"
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "northstar-skill-fetch",
    }
    token = request.headers.get("x-github-token") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(api_url, headers=headers, follow_redirects=True)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"GitHub fetch failed: {e}")

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="File not found on GitHub (check owner/repo/branch/path).")
    if resp.status_code == 403:
        raise HTTPException(
            status_code=403,
            detail="GitHub rate-limited or repo is private. Add a GitHub token in Settings.",
        )
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"GitHub returned {resp.status_code}: {resp.text[:200]}")

    data = resp.json()
    if data.get("type") != "file":
        raise HTTPException(status_code=400, detail="URL must point to a file, not a directory.")
    if data.get("size", 0) > _SKILL_MAX_BYTES:
        raise HTTPException(status_code=400, detail="File too large to be a SKILL.md.")

    encoding = data.get("encoding")
    raw_content = data.get("content", "")
    if encoding == "base64":
        import base64
        try:
            body_bytes = base64.b64decode(raw_content)
            raw_text = body_bytes.decode("utf-8")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"Failed to decode file contents: {e}")
    else:
        raw_text = raw_content

    name, description, body = _parse_skill_frontmatter(raw_text)
    # Validation: a skill has frontmatter with at least `name` and `description`.
    # We accept files without frontmatter too, but surface a soft warning via
    # an empty name/description — the UI can prompt the user to fill those in.
    if not body.strip():
        raise HTTPException(status_code=400, detail="File is empty after frontmatter parsing.")

    return FetchSkillFromUrlResponse(
        body=body,
        name=name,
        description=description,
        source=GithubSource(
            owner=owner,
            repo=repo,
            ref=ref,
            path=path,
            blob_sha=data.get("sha", ""),
        ),
    )


@app.post("/datasets/{dataset_id}/infer-schema", response_model=InferSchemaResponse)
async def infer_schema_from_examples(dataset_id: str):
    """Infer schema from existing dataset examples."""
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    examples = await db.get_examples(dataset_id)
    if len(examples) < 3:
        raise HTTPException(
            status_code=400,
            detail=f"Need at least 3 examples to infer schema (have {len(examples)})"
        )

    charter = dataset["charter_snapshot"]

    # Prepare examples for inference (just input/output)
    examples_for_inference = [
        {"input": ex["input"], "expected_output": ex["expected_output"], "feature_area": ex["feature_area"]}
        for ex in examples
    ]

    result, call_meta = await call_infer_schema(examples_for_inference, charter)

    # Parse task definition from result
    task_data = result.get("task", {})
    task = TaskDefinition(
        input_description=task_data.get("input_description", ""),
        output_description=task_data.get("output_description", ""),
        sample_input=task_data.get("sample_input"),
        sample_output=task_data.get("sample_output"),
    )

    # Log the turn
    await db.create_turn(
        session_id=dataset["session_id"],
        turn_type="infer_schema",
        input_snapshot={"example_count": len(examples)},
        llm_calls=call_meta,
        parsed_output=result,
    )

    return InferSchemaResponse(
        task=task,
        confidence=result.get("confidence", "medium"),
        example_count=len(examples),
        pattern_notes=result.get("pattern_notes", ""),
    )
