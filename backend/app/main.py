"""FastAPI application — charter generation agent backend.

9 endpoints:
- POST /sessions — create a new session
- POST /sessions/{id}/message — send a user message
- POST /sessions/{id}/proceed — user-initiated proceed to review
- GET /sessions/{id} — get current session state
- PATCH /sessions/{id}/charter — user edits during review
- POST /sessions/{id}/finalize — mark charter as final
- GET /sessions/{id}/turns — get all turns for a session
- POST /judge/run — run judge scoring on unjudged turns
- GET /judge/results — get judgement results
"""

from __future__ import annotations

import json
import logging
import os
import uuid

from contextlib import asynccontextmanager
from dotenv import load_dotenv
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import db
from .agent import run_agent_turn, run_dataset_chat, advance_phase
from .models import (
    AgentStatus,
    Charter,
    CreateDatasetRequest,
    CreateExampleRequest,
    CreateSessionRequest,
    CreateSessionResponse,
    DetectedField,
    DetectSchemaRequest,
    DetectSchemaResponse,
    EnrichRequest,
    FinalizeResponse,
    ImportExamplesRequest,
    ImportFromUrlRequest,
    ImportFromUrlResponse,
    InferSchemaResponse,
    PatchCharterRequest,
    PatchGoalsRequest,
    PatchUsersRequest,
    PatchStoriesRequest,
    ProceedResponse,
    SendMessageRequest,
    SendMessageResponse,
    SessionState,
    Settings,
    SynthesizeRequest,
    TaskDefinition,
    UpdateExampleRequest,
    UpdateSettingsRequest,
)
from .tools import (
    call_synthesize_examples,
    call_review_examples,
    call_gap_analysis,
    call_detect_schema,
    call_infer_schema,
    call_import_from_url,
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


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


def _get_phase(state: SessionState) -> str:
    """Derive the current phase from session state."""
    has_charter = bool(state.charter.coverage.criteria or state.charter.alignment)
    if has_charter:
        return "charter"
    # Return the specific discovery sub-phase: goals, users, or stories
    return state.discovery_phase.value if hasattr(state.discovery_phase, 'value') else state.discovery_phase


# --- Endpoints ---

@app.post("/sessions", response_model=CreateSessionResponse)
async def create_session(req: CreateSessionRequest):
    session_id = str(uuid.uuid4())

    state = SessionState(
        session_id=session_id,
        input=req.initial_input,
        agent_status=AgentStatus.discovery,
    )

    await db.create_session(session_id, state.model_dump())

    # Run initial agent turn (discovery greeting or generate if input provided)
    initial_input_parts = []
    if req.initial_input.business_goals:
        initial_input_parts.append(f"Business goals: {req.initial_input.business_goals}")
    if req.initial_input.user_stories:
        initial_input_parts.append(f"User stories: {req.initial_input.user_stories}")

    if initial_input_parts:
        user_msg = "\n\n".join(initial_input_parts)
        result = await run_agent_turn(state, user_msg)
    else:
        # Start with discovery — no user message yet
        result = await run_agent_turn(state)

    agent_message = result.message

    conversation = state.input.conversation_history.copy()
    await _save_state(session_id, state, conversation)

    return CreateSessionResponse(
        session_id=session_id,
        agent_status=state.agent_status,
        message=agent_message,
        phase=_get_phase(state),
        suggestions=result.suggestions,
        suggested_stories=result.suggested_stories,
        extracted_goals=result.extracted_goals,
        extracted_users=result.extracted_users,
        extracted_stories=result.extracted_stories,
        ready_for_users=result.ready_for_users,
        ready_for_stories=result.ready_for_stories,
        ready_for_charter=result.ready_for_charter,
        suggested_goals=result.suggested_goals,
        suggested_users=result.suggested_users,
        suggested_stories_options=result.suggested_stories_options,
    )


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

    return _build_send_response(result, state)


def _build_send_response(result, state: SessionState) -> SendMessageResponse:
    """Build a SendMessageResponse from an AgentResult and state."""
    return SendMessageResponse(
        message=result.message,
        agent_status=state.agent_status,
        state=state,
        phase=_get_phase(state),
        tool_calls=result.tool_calls,
        suggestions=result.suggestions,
        suggested_stories=result.suggested_stories,
        extracted_goals=state.extracted_goals,
        extracted_users=state.extracted_users,
        extracted_stories=state.extracted_stories,
        ready_for_users=result.ready_for_users,
        ready_for_stories=result.ready_for_stories,
        ready_for_charter=result.ready_for_charter,
        suggested_goals=result.suggested_goals,
        suggested_users=result.suggested_users,
        suggested_stories_options=result.suggested_stories_options,
    )


@app.post("/sessions/{session_id}/reevaluate", response_model=SendMessageResponse)
async def reevaluate_endpoint(session_id: str):
    """Re-evaluate discovery state after pill clicks — no user message added to chat."""
    state, conversation = await _load_state(session_id)

    result = await run_agent_turn(state)

    conversation = state.input.conversation_history.copy()
    await _save_state(session_id, state, conversation)

    return _build_send_response(result, state)


@app.post("/sessions/{session_id}/advance-phase", response_model=SendMessageResponse)
async def advance_phase_endpoint(session_id: str):
    """Advance discovery phase: goals→users→stories→charter generation."""
    state, conversation = await _load_state(session_id)

    result = await advance_phase(state)

    conversation = state.input.conversation_history.copy()
    await _save_state(session_id, state, conversation)

    return _build_send_response(result, state)


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
    state, conversation = await _load_state(session_id)
    return {
        "session_id": session_id,
        "state": state.model_dump(),
        "conversation": conversation,
    }


@app.patch("/sessions/{session_id}/charter")
async def patch_charter(session_id: str, req: PatchCharterRequest):
    state, conversation = await _load_state(session_id)

    if req.task is not None:
        state.charter.task = req.task
    if req.coverage is not None:
        state.charter.coverage = req.coverage
    if req.balance is not None:
        state.charter.balance = req.balance
    if req.alignment is not None:
        state.charter.alignment = req.alignment
    if req.rot is not None:
        state.charter.rot = req.rot

    await _save_state(session_id, state, conversation)

    return {"state": state.model_dump()}


@app.patch("/sessions/{session_id}/goals")
async def patch_goals(session_id: str, req: PatchGoalsRequest):
    """Update extracted goals directly from the UI."""
    state, conversation = await _load_state(session_id)
    old_goals = state.extracted_goals.copy()
    state.extracted_goals = req.goals
    # Also rebuild the text input for charter generation
    if req.goals:
        state.input.business_goals = "\n".join(f"- {g}" for g in req.goals)
    else:
        state.input.business_goals = None
    # Notify the agent about the manual edit
    if req.goals != old_goals:
        state.input.conversation_history.append({
            "role": "system",
            "content": f"[User manually edited goals. Current goals: {req.goals}]"
        })
    await _save_state(session_id, state, conversation)
    return {"extracted_goals": state.extracted_goals}


@app.patch("/sessions/{session_id}/users")
async def patch_users(session_id: str, req: PatchUsersRequest):
    """Update extracted user types directly from the UI."""
    state, conversation = await _load_state(session_id)
    old_users = state.extracted_users.copy()
    state.extracted_users = req.users
    if req.users != old_users:
        state.input.conversation_history.append({
            "role": "system",
            "content": f"[User manually edited user types. Current users: {req.users}]"
        })
    await _save_state(session_id, state, conversation)
    return {"extracted_users": state.extracted_users}


@app.patch("/sessions/{session_id}/stories")
async def patch_stories(session_id: str, req: PatchStoriesRequest):
    """Update extracted stories directly from the UI."""
    state, conversation = await _load_state(session_id)
    old_stories = state.extracted_stories.copy()
    state.extracted_stories = req.stories
    # Also rebuild the text input for charter generation
    if req.stories:
        parts = []
        for s in req.stories:
            who = s.get("who", "user")
            what = s.get("what", "")
            why = s.get("why", "")
            parts.append(f"As a {who}, I want to {what}" + (f", so that {why}" if why else ""))
        state.input.user_stories = "\n".join(parts)
    else:
        state.input.user_stories = None
    # Notify the agent about the manual edit
    if req.stories != old_stories:
        state.input.conversation_history.append({
            "role": "system",
            "content": f"[User manually edited stories. Current stories: {req.stories}]"
        })
    await _save_state(session_id, state, conversation)
    return {"extracted_stories": state.extracted_stories}


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
            "expected_output": ex.get("expected_output", ""),
            "coverage_tags": ex.get("coverage_tags", []),
            "source": "imported",
            "label": ex.get("label", "unlabeled"),
            "label_reason": ex.get("label_reason"),
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
             "label": ex["label"]}
            for ex in batch
        ]
        reviews, call_meta = await call_review_examples(charter, batch_for_review)

        # Apply verdicts
        for review in reviews:
            eid = review.get("example_id")
            if eid:
                await db.update_example(eid, {
                    "judge_verdict": {
                        "suggested_label": review.get("suggested_label"),
                        "confidence": review.get("confidence"),
                        "reasoning": review.get("reasoning"),
                        "coverage_match": review.get("coverage_match", []),
                        "issues": review.get("issues", []),
                    }
                })
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

    # Validate URL to prevent SSRF
    from urllib.parse import urlparse
    import ipaddress

    parsed = urlparse(req.url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only HTTP/HTTPS URLs are allowed")
    blocked_hosts = {"localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254", "metadata.google.internal"}
    if parsed.hostname and parsed.hostname in blocked_hosts:
        raise HTTPException(status_code=400, detail="Internal addresses are not allowed")
    if parsed.hostname:
        try:
            ip = ipaddress.ip_address(parsed.hostname)
            if ip.is_private or ip.is_loopback or ip.is_link_local:
                raise HTTPException(status_code=400, detail="Internal addresses are not allowed")
        except ValueError:
            pass  # hostname is a domain name, not an IP

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
