"""FastAPI application — seed generation agent backend.

Core endpoints:
- GET  /sessions — list all sessions (project list)
- POST /sessions — create a new session (accepts optional name)
- GET  /sessions/{id} — get current session state
- PATCH /sessions/{id}/name — rename a session
- PATCH /sessions/{id}/input — save goals/stories without running agent
- POST /sessions/{id}/message — send a user message
- POST /sessions/{id}/proceed — user-initiated proceed to review
- PATCH /sessions/{id}/seed — user edits during review
- POST /sessions/{id}/finalize — mark seed as final
- GET  /sessions/{id}/turns — get all turns for a session
- POST /judge/run — run judge scoring on unjudged turns
- GET  /judge/results — get judgement results
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid

from contextlib import asynccontextmanager
from dotenv import load_dotenv
from pathlib import Path
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

from . import db, feature_flags
from .agent import run_agent_turn, run_dataset_chat, run_polaris_chat
from .eval_runner import EvalResult, run_eval_sync
from .sharing import Access, broadcaster, capacity, require_writer, resolve_access
from .models import (
    AgentStatus,
    CreateDatasetRequest,
    CreateExampleRequest,
    CreateSessionRequest,
    CreateSessionResponse,
    CreateShareTokenRequest,
    CreateShareTokenResponse,
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
    PatchSeedRequest,
    ProceedResponse,
    ProjectSummary,
    PromptTargetInfo,
    CreatePromptEvalRequest,
    CreatePromptEvalResponse,
    RefreshDatasetRequest,
    RefreshDatasetResponse,
    RestoreSkillVersionRequest,
    RunEvalRequest,
    SendMessageRequest,
    SendMessageResponse,
    SessionState,
    SessionKind,
    SetEvalRunRowNoteRequest,
    SetModeRequest,
    ShareTokenSummary,
    Settings,
    SkillImportRequest,
    SkillImportResponse,
    SkillVersion,
    SuggestGoalsRequest,
    SuggestGoalsResponse,
    SuggestImprovementsRequest,
    SuggestImprovementsResponse,
    SuggestResponse,
    SuggestStoriesRequest,
    SuggestStoriesResponse,
    SuggestSkillRequest,
    SuggestSkillResponse,
    GenerateSkillFromGoalsRequest,
    GenerateSkillFromGoalsResponse,
    SuggestScorerIdeasResponse,
    SuggestRevisionsRequest,
    SynthesizeRequest,
    TaskDefinition,
    UpdateExampleRequest,
    UpdateInputRequest,
    UpdateSettingsRequest,
    ValidateResponse,
)
from .prompt_eval import get_prompt_target, list_prompt_targets
from .quota import enforce_quota
from .tools import (
    LLMAuthError,
    LLMBillingError,
    LLMModelError,
    call_suggest_goals,
    call_evaluate_goals,
    call_suggest_stories,
    call_suggest_skill,
    call_generate_skill_from_goals,
    call_suggest_scorer_ideas,
    call_validate_seed,
    call_generate_suggestions,
    call_synthesize_examples,
    call_retag_examples_against_seed,
    call_review_examples,
    call_generate_scorers,
    call_revise_examples,
    call_detect_schema,
    call_infer_schema,
    call_import_from_url,
    call_skill_import,
    set_request_api_key,
)

load_dotenv(Path(__file__).parent.parent / ".env", override=True)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    database_url = os.environ.get("DATABASE_URL", "postgresql://localhost:5432/northstar")
    await db.init_db(database_url)

    # Self-contained app modules register themselves into the LLM-call
    # middleware chain. Each module's `setup()` reads its own env flags and
    # is a no-op when disabled. Order matters: outermost layer runs first,
    # so register cheapest gates (cache) before policy gates (spend cap).
    from . import llm_cache
    llm_cache.setup()

    # Spend cap runs INSIDE the cache (registered second → inner layer), so
    # cache hits short-circuit before the cap counts them. Only real provider
    # spend ticks the daily total.
    from . import spend_cap
    spend_cap.setup()

    from . import feature_flags
    feature_flags.setup()

    yield
    await db.close_db()


app = FastAPI(title="North Star", version="0.1.0", lifespan=lifespan)

# Quota needs to register an ASGI middleware on the app, which Starlette
# forbids after startup — so it has to happen at app construction time,
# NOT in lifespan. The module reads its own env flag and is a no-op when
# disabled, so this call is safe regardless of deployment.
from . import quota  # noqa: E402
quota.setup(app)


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


@app.exception_handler(LLMAuthError)
async def _auth_error_handler(_request: Request, exc: LLMAuthError):
    """Translate provider auth failures into HTTP 401 with the same shape as
    billing errors. Common cause: the user pasted an OpenRouter key but the
    request hit the Anthropic-direct path (or vice versa). The frontend's
    apiFetch maps 401 to a clear 'invalid key' message pointing at Settings."""
    from fastapi.responses import JSONResponse
    return JSONResponse(
        status_code=401,
        content={
            "detail": str(exc),
            "error": "llm_auth",
            "provider": exc.provider,
        },
    )


@app.exception_handler(LLMModelError)
async def _model_error_handler(_request: Request, exc: LLMModelError):
    """Translate 'model id not found / not entitled' failures into HTTP 422.
    Distinct from 401 so the frontend can point the user at the model
    selector rather than the API key — used to be conflated under llm_auth
    and produced misleading 'Check your API key' copy when the key was fine
    but the model name was a typo or a retired snapshot."""
    from fastapi.responses import JSONResponse
    return JSONResponse(
        status_code=422,
        content={
            "detail": str(exc),
            "error": "llm_model",
            "provider": exc.provider,
        },
    )


@app.middleware("http")
async def _braintrust_trace_meta_middleware(request: Request, call_next):
    """Populate the trace metadata contextvar with session_id (and a coarse
    phase) for the duration of the request.

    Every ``call_*`` tool inside the request — whether invoked through the
    agent or directly by a handler — picks this up when opening its
    Braintrust span. Agent-level wrappers in agent.py refine ``phase`` with
    something more specific (goals/users/stories/seed/dataset) when known.

    Cheap when prod monitoring is off — set_trace_meta is a contextvar push.
    """
    import re
    from .tools import set_trace_meta

    path = request.url.path
    match = re.search(r"/sessions/([a-zA-Z0-9_-]+)", path)
    session_id = match.group(1) if match else None

    # Coarse phase inference from URL — the agent layer overrides this with
    # more specific values when it has them.
    phase: str | None = None
    if any(seg in path for seg in (
        "/synthesize", "/review", "/revise", "/gap-analysis",
        "/dataset", "/import", "/detect-schema", "/infer-schema",
    )):
        phase = "dataset"
    elif "/generate-scorers" in path or "/scorers" in path:
        phase = "scorers"
    elif "/skill-import" in path:
        phase = "seed"
    elif "/suggest-improvements" in path or "/eval" in path:
        phase = "eval_feedback"

    if session_id or phase:
        with set_trace_meta(session_id=session_id, phase=phase):
            return await call_next(request)
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    # Wildcard origin + credentials is forbidden by the CORS spec: every
    # browser rejects preflights when `Access-Control-Allow-Credentials: true`
    # is paired with `Access-Control-Allow-Origin: *`. We don't use cookies —
    # auth flows over custom `X-*-Key` headers — so credentials can stay
    # off and the wildcard works for the deployed prototype.
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Content-Type",
        "Authorization",
        "X-Anthropic-Key",
        "X-Braintrust-Key",
        "X-Github-Token",
        # Project-sharing tokens — viewers/editors send this on every call.
        "X-Share-Token",
    ],
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

async def _maybe_backfill_prompt_meta(
    session_id: str,
    state: SessionState,
    conversation: list[dict],
) -> tuple[SessionState, list[dict]]:
    """Backfill prompt-eval metadata (prompt_source_path / prompt_builder_name)
    from the registry for sessions created before those fields existed, so
    the Prompt panel can show provenance without forcing the user to recreate.
    Persists silently when needed — no separate migration step.

    Pure on already-loaded state so callers that already have the row don't
    pay for a second DB fetch. _load_state and the GET /sessions/{id}
    handler both go through this helper now.
    """
    if (
        state.kind == SessionKind.prompt
        and state.prompt_target
        and (not state.prompt_source_path or not state.prompt_builder_name)
    ):
        pt = get_prompt_target(state.prompt_target)
        if pt is not None:
            mutated = False
            if not state.prompt_source_path and pt.source_path:
                state.prompt_source_path = pt.source_path
                mutated = True
            if not state.prompt_builder_name and pt.builder_name:
                state.prompt_builder_name = pt.builder_name
                mutated = True
            if mutated:
                await db.update_session(session_id, state.model_dump(), conversation)
    return state, conversation


async def _load_state(session_id: str) -> tuple[SessionState, list[dict]]:
    """Load session state from DB, raise 404 if not found."""
    row = await db.get_session(session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    state = SessionState.model_validate(row["state"])
    conversation = row["conversation"]
    return await _maybe_backfill_prompt_meta(session_id, state, conversation)


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
    notes: str | None = None,
    applied_suggestion_ids: list[str] | None = None,
    as_candidate: bool = False,
) -> dict:
    """Create a new SkillVersion entry and return the record.

    By default the new version becomes active. Pass `as_candidate=True` to
    create a candidate instead — the version goes into history but isn't
    promoted, and `candidate_skill_version_id` is set to point at it. The
    candidate flow lets the user run an eval on the proposed body before
    committing, so a regressing change doesn't quietly become the new active.

    Caller is responsible for also updating seed.task.skill_body if this
    version should become the live body the next eval runs against.
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
    if as_candidate:
        state.candidate_skill_version_id = version.id
    else:
        state.active_skill_version_id = version.id
        # Promoting (or first-time creation) supersedes any pending candidate
        # from a previous flow.
        state.candidate_skill_version_id = None
    return record


# --- Endpoints ---

@app.get("/health")
async def health_check():
    """Health check that also reports whether a default API key is configured."""
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENROUTER_API_KEY"))
    return {"status": "ok", "has_default_api_key": has_key}


@app.get("/config")
async def get_config(request: Request):
    """Public, read-only deployment configuration the frontend reads once on
    mount. Tells the UI which surfaces to disable (Polaris) and what quota
    headroom the visitor has — without exposing secrets or env values.

    Not rate-limited: this is the metadata the rate limiter itself reports.
    Quota fields degrade to None when the quota module isn't installed
    (PR 2 may land after this one — order-independent rollout).
    """
    from .tools import get_model

    daily_limit: int | None = None
    runs_remaining: int | None = None
    try:
        from . import quota  # type: ignore[attr-defined]
        status = await quota.get_quota_status(request)
        daily_limit = status.get("daily_limit")
        runs_remaining = status.get("runs_remaining")
    except (ImportError, AttributeError):
        # quota module not installed in this deployment — leave both None.
        pass

    return {
        "polaris_enabled": feature_flags.is_polaris_enabled(),
        "daily_run_limit": daily_limit,
        "runs_remaining": runs_remaining,
        "model": get_model(),
    }


@app.get("/admin/spend")
async def admin_spend(request: Request):
    """Debug view of today's spend-cap accounting. Requires the X-Admin-Token
    header to match the ADMIN_TOKEN env var. Returns 404 when no token is
    configured so the endpoint is indistinguishable from missing routes on
    deployments that never opted in.

    Useful for verifying that the spend cap is wiring tokens correctly in a
    public-playground deployment without having to shell into the DB.
    """
    expected = os.environ.get("ADMIN_TOKEN")
    if not expected:
        raise HTTPException(status_code=404, detail="Not found")
    presented = request.headers.get("X-Admin-Token")
    if not presented or presented != expected:
        raise HTTPException(status_code=403, detail="Forbidden")

    from . import spend_cap
    pool = await db.get_pool()
    stats = await spend_cap.get_today_stats(pool)
    # Surface the configured cap alongside today's running total so the
    # caller can compute headroom without having to read env themselves.
    stats["cap_cents"] = spend_cap._cap_cents or None
    return stats


@app.post("/suggest-goals", response_model=SuggestGoalsResponse)
async def suggest_goals(
    req: SuggestGoalsRequest,
    _quota: None = Depends(enforce_quota),
):
    """Suggest additional business goals based on current goals.

    If ``session_id`` is provided the call is persisted as a turn so
    prompt-eval can later sample it. Without it the call still works,
    just isn't recorded as a dataset row.
    """
    non_empty = [g for g in req.goals if g.strip()]
    if not non_empty:
        return SuggestGoalsResponse(suggestions=[])

    try:
        suggestions, call_meta = await call_suggest_goals(non_empty)
        if req.session_id:
            try:
                await db.create_turn(
                    session_id=req.session_id,
                    turn_type="suggest_goals",
                    input_snapshot={"goals": non_empty},
                    llm_calls=call_meta,
                    parsed_output={"suggestions": suggestions},
                )
            except Exception:
                logger.warning("suggest_goals turn-log failed", exc_info=True)
        return SuggestGoalsResponse(suggestions=suggestions)
    except (HTTPException, LLMBillingError, LLMAuthError, LLMModelError):
        # Pass intentional HTTP statuses (e.g. 503 from spend_cap middleware,
        # 429 from quota) and provider-typed errors through to their
        # dedicated handlers, instead of clobbering them as 500.
        raise
    except Exception as e:
        logger.exception("Failed to suggest goals")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/evaluate-goals", response_model=EvaluateGoalsResponse)
async def evaluate_goals(
    req: EvaluateGoalsRequest,
    _quota: None = Depends(enforce_quota),
):
    """Evaluate business goal quality — check if goals are specific, measurable, independent.

    Persists a turn when ``session_id`` is provided (see suggest_goals).
    """
    non_empty = [g for g in req.goals if g.strip()]
    if not non_empty:
        return EvaluateGoalsResponse(feedback=[])

    try:
        feedback_raw, call_meta = await call_evaluate_goals(non_empty)
        feedback = [
            GoalFeedback(
                goal=f.get("goal", ""),
                issue=f.get("issue"),
                suggestion=f.get("suggestion"),
            )
            for f in feedback_raw
        ]
        if req.session_id:
            try:
                await db.create_turn(
                    session_id=req.session_id,
                    turn_type="evaluate_goals",
                    input_snapshot={"goals": non_empty},
                    llm_calls=call_meta,
                    parsed_output={"feedback": feedback_raw},
                )
            except Exception:
                logger.warning("evaluate_goals turn-log failed", exc_info=True)
        return EvaluateGoalsResponse(feedback=feedback)
    except (HTTPException, LLMBillingError, LLMAuthError, LLMModelError):
        raise
    except Exception as e:
        logger.exception("Failed to evaluate goals")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/suggest-stories", response_model=SuggestStoriesResponse)
async def suggest_stories(
    req: SuggestStoriesRequest,
    _quota: None = Depends(enforce_quota),
):
    """Suggest additional user stories based on goals and existing stories.

    Persists a turn when ``session_id`` is provided (see suggest_goals).
    """
    non_empty_goals = [g for g in req.goals if g.strip()]
    non_empty_stories = [s for s in req.stories if s.get("who", "").strip() or s.get("what", "").strip()]
    if not non_empty_goals:
        return SuggestStoriesResponse(suggestions=[])

    try:
        suggestions, call_meta = await call_suggest_stories(non_empty_goals, non_empty_stories)
        if req.session_id:
            try:
                await db.create_turn(
                    session_id=req.session_id,
                    turn_type="suggest_stories",
                    input_snapshot={"goals": non_empty_goals, "stories": non_empty_stories},
                    llm_calls=call_meta,
                    parsed_output={"suggestions": suggestions},
                )
            except Exception:
                logger.warning("suggest_stories turn-log failed", exc_info=True)
        return SuggestStoriesResponse(suggestions=suggestions)
    except (HTTPException, LLMBillingError, LLMAuthError, LLMModelError):
        raise
    except Exception as e:
        logger.exception("Failed to suggest stories")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/suggest-skill", response_model=SuggestSkillResponse)
async def suggest_skill(
    req: SuggestSkillRequest,
    _quota: None = Depends(enforce_quota),
):
    """Suggest SKILL.md content ideas given goals + stories + current draft.

    Powers the right-rail SuggestionBox on the Skill tab. Returns an empty
    list when no goals exist — the UI then shows the "Add goals to see
    suggestions" empty state instead of calling the LLM with nothing.
    """
    non_empty_goals = [g for g in req.goals if g.strip()]
    non_empty_stories = [
        s for s in req.stories if s.get("who", "").strip() or s.get("what", "").strip()
    ]
    if not non_empty_goals:
        return SuggestSkillResponse(suggestions=[])

    try:
        suggestions, call_meta = await call_suggest_skill(
            non_empty_goals,
            non_empty_stories,
            req.current_body,
        )
        if req.session_id:
            try:
                await db.create_turn(
                    session_id=req.session_id,
                    turn_type="suggest_skill",
                    input_snapshot={
                        "goals": non_empty_goals,
                        "stories": non_empty_stories,
                        "current_body": req.current_body or "",
                    },
                    llm_calls=call_meta,
                    parsed_output={"suggestions": suggestions},
                )
            except Exception:
                logger.warning("suggest_skill turn-log failed", exc_info=True)
        return SuggestSkillResponse(suggestions=suggestions)
    except (HTTPException, LLMBillingError, LLMAuthError, LLMModelError):
        raise
    except Exception as e:
        logger.exception("Failed to suggest skill")
        raise HTTPException(status_code=500, detail=str(e))


@app.post(
    "/sessions/{session_id}/generate-skill-from-goals",
    response_model=GenerateSkillFromGoalsResponse,
)
async def generate_skill_from_goals(
    session_id: str,
    _req: GenerateSkillFromGoalsRequest,
    access: Access = Depends(resolve_access),
    _quota: None = Depends(enforce_quota),
):
    """Generate a full SKILL.md body from the session's goals + stories.

    Persists the resulting body + name + description on the session so a
    reload (or any SSE state-change refetch) sees them. The frontend
    still has to call Analyze if it wants to re-seed goals/stories from
    the new body — this endpoint just fills the Skill page.
    """
    require_writer(access)
    state, conversation = await _load_state(session_id)
    goals = [g for g in (state.input.goals or []) if g and g.strip()]
    stories = []
    for g in (state.input.story_groups or []):
        role = g.get("role", "") if isinstance(g, dict) else g.role
        items = g.get("stories", []) if isinstance(g, dict) else g.stories
        for s in items:
            who = role
            what = s.get("what", "") if isinstance(s, dict) else s.what
            why = s.get("why", "") if isinstance(s, dict) else getattr(s, "why", "")
            if who or what:
                stories.append({"who": who, "what": what, "why": why or ""})
    if not goals:
        raise HTTPException(
            status_code=400,
            detail="Add at least one business goal before generating a skill.",
        )

    project = await db.get_session(session_id)
    project_name = (project or {}).get("name") if project else None

    try:
        raw_body, call_meta = await call_generate_skill_from_goals(
            goals, stories, project_name
        )
    except (HTTPException, LLMBillingError, LLMAuthError, LLMModelError):
        raise
    except Exception as e:
        logger.exception("Failed to generate skill from goals")
        raise HTTPException(status_code=500, detail=str(e))

    name, description, stripped_body = _parse_skill_frontmatter(raw_body)
    # Persist on the session so reload + SSE refetches see the body. We
    # store the stripped body so it matches the importFromSkill convention
    # (skill_body never carries frontmatter); name/description sit
    # alongside on the task object.
    state.seed.task.skill_body = stripped_body
    if name:
        state.seed.task.skill_name = name
    if description:
        state.seed.task.skill_description = description
    await _save_state(session_id, state, conversation)

    try:
        await db.create_turn(
            session_id=session_id,
            turn_type="generate_skill_from_goals",
            input_snapshot={"goals": goals, "stories": stories},
            llm_calls=call_meta,
            parsed_output={"body": stripped_body, "name": name, "description": description},
        )
    except Exception:
        logger.warning("generate_skill_from_goals turn-log failed", exc_info=True)

    return GenerateSkillFromGoalsResponse(
        body=stripped_body,
        name=name,
        description=description,
    )


@app.post(
    "/sessions/{session_id}/suggest-scorer-ideas",
    response_model=SuggestScorerIdeasResponse,
)
async def suggest_scorer_ideas(
    session_id: str,
    access: Access = Depends(resolve_access),
    _quota: None = Depends(enforce_quota),
):
    """Suggest NEW scorer ideas based on the session's seed + existing
    scorers. Returns short pitches; the user later promotes interesting
    ones into real scorers via the existing generate-scorers flow."""
    require_writer(access)
    state, _ = await _load_state(session_id)
    seed = state.seed.model_dump() if state.seed else {}
    existing = state.scorers or []
    try:
        suggestions, call_meta = await call_suggest_scorer_ideas(seed, existing)
    except (HTTPException, LLMBillingError, LLMAuthError, LLMModelError):
        raise
    except Exception as e:
        logger.exception("Failed to suggest scorer ideas")
        raise HTTPException(status_code=500, detail=str(e))
    try:
        await db.create_turn(
            session_id=session_id,
            turn_type="suggest_scorer_ideas",
            input_snapshot={"existing_count": len(existing)},
            llm_calls=call_meta,
            parsed_output={"suggestions": suggestions},
        )
    except Exception:
        logger.warning("suggest_scorer_ideas turn-log failed", exc_info=True)
    return SuggestScorerIdeasResponse(suggestions=suggestions)


@app.post("/sessions", response_model=CreateSessionResponse)
async def create_session(
    req: CreateSessionRequest,
    _quota: None = Depends(enforce_quota),
):
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
            has_seed=r.get("has_seed", False),
            has_dataset=r.get("has_dataset", False),
            kind=r.get("kind", "skill"),
            prompt_target=r.get("prompt_target"),
        )
        for r in rows
    ]


@app.patch("/sessions/{session_id}/name")
async def rename_session(
    session_id: str,
    body: dict,
    access: Access = Depends(resolve_access),
):
    """Rename a session. Owner-only — share-token bearers can't change
    project metadata visible to all collaborators."""
    _require_owner(access)
    name = body.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    try:
        row = await db.update_session_name(session_id, name)
        return row
    except ValueError:
        raise HTTPException(status_code=404, detail="Session not found")


@app.patch("/sessions/{session_id}/input")
async def update_session_input(
    session_id: str,
    req: UpdateInputRequest,
    access: Access = Depends(resolve_access),
):
    """Save structured goals and story_groups without triggering the agent."""
    require_writer(access)
    state, conversation = await _load_state(session_id)

    state.input.goals = req.goals
    state.input.story_groups = req.story_groups

    try:
        result = await db.update_session_input(session_id, state.model_dump())
        return {"state": result["state"]}
    except ValueError:
        raise HTTPException(status_code=404, detail="Session not found")


@app.patch("/sessions/{session_id}/mode")
async def set_session_mode(
    session_id: str,
    req: SetModeRequest,
    access: Access = Depends(resolve_access),
):
    """Set the eval mode for a session.

    - standard: existing flow, no routing decision modeled.
    - triggered: skill/tool/agent under evaluation — enables off-target stories,
      negative coverage, and should_trigger dataset labels.

    Owner-only — eval_mode is project-shaping metadata; share-token bearers
    (even editors) shouldn't be able to flip the mode on the project owner.
    """
    _require_owner(access)
    state, conversation = await _load_state(session_id)
    state.eval_mode = req.eval_mode
    await _save_state(session_id, state, conversation)
    return {"eval_mode": state.eval_mode.value, "state": state.model_dump()}


@app.post("/sessions/{session_id}/skill-import", response_model=SkillImportResponse)
async def import_from_skill(
    session_id: str,
    req: SkillImportRequest,
    access: Access = Depends(resolve_access),
    _quota: None = Depends(enforce_quota),
):
    """Seed goals/users/stories/task from a pasted SKILL.md body.

    Switches the session to triggered mode and populates extracted state. The
    user can review and edit before the seed is generated.
    """
    require_writer(access)
    state, conversation = await _load_state(session_id)

    # Idempotency: if this session already has a seed version pointing at
    # the same body, skip the whole flow. The user shows up here twice
    # when they retry a stuck request, when /skill-import double-fires from
    # the home-page modal, or when an SSE reconnect re-issues the POST.
    # Without this guard, every retry re-runs the LLM AND appends another
    # v2/v3/etc. with `created_from="import"` — exactly the duplicate-v1
    # the user reported.
    existing_import = next(
        (
            v for v in state.skill_versions
            if v.get("created_from") == "import" and (v.get("body") or "") == (req.skill_body or "")
        ),
        None,
    )
    if existing_import is not None:
        # Frontend reads `state` to repopulate goals/users/stories on the
        # success path. Returning the in-memory state here matches that
        # shape, so the second-call client gets the same payload as the
        # first-call client without re-running the LLM or appending a
        # duplicate v1.
        return SkillImportResponse(
            state=state,
            message="Skill already seeded; returning the existing snapshot.",
        )

    data, call_meta = await call_skill_import(
        req.skill_body, req.skill_name, req.skill_description,
    )

    # Switch to triggered mode and stamp skill metadata onto the task def.
    state.eval_mode = EvalMode.triggered
    state.seed.task.skill_name = req.skill_name or state.seed.task.skill_name
    state.seed.task.skill_description = req.skill_description or state.seed.task.skill_description
    state.seed.task.skill_body = req.skill_body

    # Snapshot this seeded body as v1 so we can diff against future edits.
    _append_skill_version(
        state,
        body=req.skill_body,
        created_from="import",
        notes="Seeded from SKILL.md paste.",
    )
    # Stamp lineage so the UI knows these artifacts were generated against v1.
    _stamp_lineage(state, "goals", "users", "stories")

    task_data = data.get("task") or {}
    if task_data.get("input_description"):
        state.seed.task.input_description = task_data["input_description"]
    if task_data.get("output_description"):
        state.seed.task.output_description = task_data["output_description"]
    if task_data.get("sample_input"):
        state.seed.task.sample_input = task_data["sample_input"]
    if task_data.get("sample_output"):
        state.seed.task.sample_output = task_data["sample_output"]

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
    # even though skill-import successfully pulled everything out of the SKILL.md.
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
        turn_type="skill_import",
        # Keep the full SKILL.md body so prompt-eval can replay this turn.
        # Storing only `_len` (the prior shape) saved bytes but made the turn
        # unsamplable as a dataset row — the body is the input.
        input_snapshot={
            "skill_name": req.skill_name,
            "skill_description": req.skill_description,
            "skill_body": req.skill_body,
        },
        llm_calls=call_meta,
        parsed_output=data,
    )

    return SkillImportResponse(
        state=state,
        message=data.get("summary") or "Seeded from SKILL.md. Review goals/users/stories and advance when ready.",
    )


# --- Prompt-eval (eval North Star's own prompts) ---

@app.get("/prompt-targets", response_model=list[PromptTargetInfo])
async def list_prompt_targets_endpoint():
    """List the North Star prompts that can be evaluated."""
    return [PromptTargetInfo(**info) for info in list_prompt_targets()]


# Coarse bucket for the `feature_area` column on each sampled row. Rows that
# all bucket to the same string render as one row in the dataset table, which
# defeats the visual purpose; for `generate` we use a goals/stories signal,
# everything else falls back to the prompt_target name. Lifted out of
# create_prompt_eval_session so the refresh endpoint can reuse it.
def _bucket_for_prompt_target(prompt_target: str, snap: dict) -> str:
    if prompt_target != "generate":
        return prompt_target
    has_goals = bool((snap.get("business_goals") or "").strip())
    has_stories = bool((snap.get("user_stories") or "").strip())
    if has_goals and has_stories:
        return "goals+stories"
    if has_goals:
        return "goals_only"
    if has_stories:
        return "stories_only"
    return "empty_input"


async def _sample_and_build_example_rows(
    prompt_target: str,
    exclude_session_id: str,
    sample_size: int,
) -> tuple[int, int, list[dict]]:
    """Sample turns for a prompt-eval target and shape them as example rows.

    Returns (sampled_count, deduped_count, example_rows). Used both at session
    creation and on dataset refresh — the only difference between those callers
    is what they do with the returned rows.

    Pulls 3× sample_size from the turns table (since dedup may discard most),
    dedupes by input_snapshot key, then truncates to sample_size. Excludes the
    prompt-eval project's own session so re-runs of the prompt under test
    don't pollute the dataset they're sampled from.
    """
    sampled = await db.sample_turns_for_prompt_eval(
        turn_type=prompt_target,
        limit=sample_size * 3,
        exclude_session_id=exclude_session_id,
    )

    seen: set[str] = set()
    deduped: list[dict] = []
    for t in sampled:
        snap = t.get("input_snapshot") or {}
        key = json.dumps(snap, sort_keys=True)[:1000]
        if key in seen:
            continue
        seen.add(key)
        deduped.append(t)
        if len(deduped) >= sample_size:
            break

    example_rows: list[dict] = []
    for t in deduped:
        snap = t.get("input_snapshot") or {}
        # Historical agent_message lives on the turn but generate-style turns
        # store the produced seed under parsed_output instead. Capture
        # whichever is present so the user can see what was produced before
        # — useful as a comparison even when scorers are reference-free.
        historical = t.get("agent_message") or ""
        if not historical:
            parsed = t.get("parsed_output")
            if isinstance(parsed, (dict, list)):
                historical = json.dumps(parsed)[:4000]
            elif isinstance(parsed, str):
                historical = parsed[:4000]
        example_rows.append({
            "feature_area": _bucket_for_prompt_target(prompt_target, snap),
            "input": json.dumps(snap),
            "expected_output": historical,
            "coverage_tags": ["prompt-eval", prompt_target],
            "source": "turns_sample",
            "label": "unlabeled",
            "review_status": "approved",
        })
    return len(sampled), len(deduped), example_rows


@app.post("/sessions/prompt-eval", response_model=CreatePromptEvalResponse)
async def create_prompt_eval_session(
    req: CreatePromptEvalRequest,
    _quota: None = Depends(enforce_quota),
):
    """Spin up a prompt-eval project end-to-end.

    Creates a kind='prompt' session that mirrors a regular skill-eval workspace:
    a synthetic SKILL.md describing the prompt under test seeds goals/users/
    stories via call_skill_import; sampled turns of that prompt's turn_type land
    in the dataset. The user reviews + advances through Goals → Users →
    Seed → Scorers → Evaluate exactly like a skill eval. The eval runner
    diverges only at task time — instead of running skill_body as a system
    prompt, it rebuilds SessionState and re-invokes the prompt builder.
    """
    pt = get_prompt_target(req.prompt_target)
    if pt is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown prompt_target '{req.prompt_target}'. "
                   f"Known: {[t['target'] for t in list_prompt_targets()]}",
        )

    # CreatePromptEvalRequest constrains sample_size to [1, 200] at validation,
    # so by the time we get here it's already a sane value.
    sample_size = req.sample_size
    session_id = str(uuid.uuid4())

    # Initial state: marked as kind=prompt + triggered eval mode (so the Skill
    # tab is visible — the synthetic body lives there and explains the prompt
    # under test). agent_status=review skips the discovery flow; the user
    # works the populated workspace, not a chat session.
    state = SessionState(
        session_id=session_id,
        agent_status=AgentStatus.review,
        eval_mode=EvalMode.triggered,
        kind=SessionKind.prompt,
        prompt_target=req.prompt_target,
        prompt_source_path=pt.source_path,
        prompt_builder_name=pt.builder_name,
    )
    # User can paste/edit the prompt body in the create modal. When they do,
    # use that text for the seed pass + Skill panel. None / empty = registered.
    import_body = (req.prompt_body or "").strip() or pt.prompt_text

    state.seed.task.skill_name = pt.label
    state.seed.task.skill_description = pt.description
    state.seed.task.skill_body = import_body

    # Snapshot the prompt text as v1 so lineage banners + version diff
    # infrastructure work the same as in a regular skill eval.
    _append_skill_version(
        state,
        body=import_body,
        created_from="import",
        notes=f"Initial render of {pt.builder_name} with placeholder variables.",
    )
    _stamp_lineage(state, "goals", "users", "stories")

    name = req.name or f"Prompt eval — {pt.label}"
    await db.create_session(session_id, state.model_dump(), name=name)

    # Feed the rendered prompt straight into the skill-import pipeline. This is
    # the same LLM call the SKILL.md-paste flow makes — the only difference is
    # the body is the actual prompt under test, not a SKILL.md. ~5–15s but
    # gives us populated goals/users/stories instead of an empty workspace.
    try:
        import_data, import_calls = await call_skill_import(
            import_body, pt.label, pt.description,
        )
    except Exception:  # noqa: BLE001
        import_data, import_calls = {}, []

    import_task = import_data.get("task") or {}
    if import_task.get("input_description"):
        state.seed.task.input_description = import_task["input_description"]
    if import_task.get("output_description"):
        state.seed.task.output_description = import_task["output_description"]
    if import_task.get("sample_input"):
        state.seed.task.sample_input = import_task["sample_input"]
    if import_task.get("sample_output"):
        state.seed.task.sample_output = import_task["sample_output"]

    goals_lower: set[str] = set()
    for g in import_data.get("goals", []) or []:
        if g and g.lower() not in goals_lower:
            state.extracted_goals.append(g)
            goals_lower.add(g.lower())

    users_lower: set[str] = set()
    for u in import_data.get("users", []) or []:
        if u and u.lower() not in users_lower:
            state.extracted_users.append(u)
            users_lower.add(u.lower())

    story_keys: set[tuple[str, str]] = set()
    for s in import_data.get("positive_stories", []) or []:
        if s.get("who") and s.get("what"):
            key = (s["who"].lower(), s["what"].lower().strip()[:40])
            if key not in story_keys:
                state.extracted_stories.append({**s, "kind": "positive"})
                story_keys.add(key)
    for s in import_data.get("off_target_stories", []) or []:
        if s.get("who") and s.get("what"):
            key = (s["who"].lower(), s["what"].lower().strip()[:40])
            if key not in story_keys:
                state.extracted_stories.append({**s, "kind": "off_target"})
                story_keys.add(key)

    # Mirror into the structured input fields the UI reads.
    state.input.goals = list(state.extracted_goals)
    role_to_stories: dict[str, list[dict]] = {}
    for s in state.extracted_stories:
        who = s.get("who", "").strip()
        if not who:
            continue
        role_to_stories.setdefault(who, []).append({
            "what": s.get("what", ""),
            "why": s.get("why", ""),
            "kind": s.get("kind", "positive"),
        })
    state.input.story_groups = [
        {"role": role, "stories": stories} for role, stories in role_to_stories.items()
    ]

    # Also populate the free-form text fields that build_generate_draft_prompt
    # reads from. Without this, "Generate seed" sees an empty input and
    # produces an empty seed, which then breaks gap analysis downstream.
    # Mirrors agent._build_input_from_extractions exactly.
    if state.extracted_goals:
        state.input.business_goals = "\n".join(f"- {g}" for g in state.extracted_goals)
    if state.extracted_stories:
        story_lines = []
        for s in state.extracted_stories:
            who = s.get("who", "user")
            what = s.get("what", "")
            why = s.get("why", "")
            story_lines.append(f"As a {who}, I want to {what}" + (f", so that {why}" if why else ""))
        state.input.user_stories = "\n".join(story_lines)

    await _save_state(session_id, state, [])

    if import_calls:
        await db.create_turn(
            session_id=session_id,
            turn_type="skill_import",
            # Persist the full prompt body, not just length — prompt-eval
            # samples this snapshot as a dataset row and needs to replay it.
            input_snapshot={
                "prompt_target": req.prompt_target,
                "skill_body": import_body,
            },
            llm_calls=import_calls,
            parsed_output=import_data,
        )

    # Sample turns + build example rows. Excluding self is moot at create
    # time (no turns yet) but matters once re-runs land their own turns —
    # and the same helper is reused by /refresh-dataset below.
    rows_sampled, rows_deduped, example_rows = await _sample_and_build_example_rows(
        prompt_target=req.prompt_target,
        exclude_session_id=session_id,
        sample_size=sample_size,
    )

    dataset = await db.create_dataset(
        session_id=session_id,
        name=f"{pt.label} — sampled turns",
        seed_snapshot={},
    )

    if example_rows:
        await db.bulk_create_examples(dataset["id"], example_rows)
        await db.update_dataset_stats(dataset["id"])

    return CreatePromptEvalResponse(
        session_id=session_id,
        prompt_target=req.prompt_target,
        rows_sampled=rows_sampled,
        rows_deduped=rows_deduped,
        dataset_id=dataset["id"],
        message=(
            f"Seeded goals/users/stories from synthetic description, sampled "
            f"{rows_sampled} turns, deduped to {rows_deduped}. Generate the "
            f"seed and scorers next."
        ),
    )


@app.post("/sessions/{session_id}/refresh-dataset", response_model=RefreshDatasetResponse)
async def refresh_prompt_eval_dataset(
    session_id: str,
    req: RefreshDatasetRequest,
    _quota: None = Depends(enforce_quota),
):
    """Re-sample the latest turns into a prompt-eval session's dataset.

    The rolling-window pattern: the dataset that was sampled at session
    creation goes stale as new production turns accumulate. This endpoint
    wipes the existing examples and replaces them with a fresh sample —
    the same logic ``create_prompt_eval_session`` uses, so a refresh is
    indistinguishable from a re-spawn except it preserves the seed,
    scorers, and any other downstream work attached to the session.

    **DESTRUCTIVE on user curation.** Any per-example labels, review
    statuses, or reviewer notes attached to the existing dataset rows
    are wiped along with the rows themselves. The response surfaces
    ``rows_curation_lost`` so callers can warn before invoking. Pass
    ``confirm: true`` to acknowledge — without it, the endpoint refuses
    when curation is non-zero (preserves the dataset by default).

    Replace-only for v1. An ``append`` mode is a follow-up if regression
    tracking becomes a use case (today the user wants "what is the prompt
    doing on current traffic", not "is it regressing across releases").
    """
    raw = await db.get_session(session_id)
    if raw is None:
        raise HTTPException(status_code=404, detail="Session not found")
    state = SessionState(**raw["state"])
    if state.kind != SessionKind.prompt or not state.prompt_target:
        raise HTTPException(
            status_code=400,
            detail="refresh-dataset only applies to prompt-eval sessions (kind=prompt with a prompt_target).",
        )

    dataset = await db.get_dataset_by_session(session_id)
    if dataset is None:
        raise HTTPException(
            status_code=404,
            detail="No dataset attached to this session. Create the prompt-eval project first.",
        )

    # Refuse to wipe user curation unless the caller explicitly confirms.
    # This keeps a stray refresh from silently destroying labels someone
    # spent time applying. Counted before sampling so the cost of the
    # confirmation roundtrip stays cheap (no LLM, no DB writes).
    rows_curation_lost = await db.count_curated_examples(dataset["id"])
    if rows_curation_lost > 0 and not req.confirm:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Refresh would destroy {rows_curation_lost} curated example(s) "
                f"(labeled, reviewed, or annotated). Re-send with confirm=true to proceed."
            ),
        )

    rows_sampled, rows_deduped, example_rows = await _sample_and_build_example_rows(
        prompt_target=state.prompt_target,
        exclude_session_id=session_id,
        sample_size=req.sample_size,
    )

    # Refuse to wipe a populated dataset for an empty sample — that's
    # almost always a misconfiguration (wrong turn_type filter, no recent
    # traffic) rather than the user's intent. Existing examples survive.
    if not example_rows:
        raise HTTPException(
            status_code=409,
            detail=(
                "Refresh aborted: 0 turns matched the prompt_target. "
                "Existing examples preserved."
            ),
        )

    # Atomic swap: delete + bulk-insert under one transaction so an
    # insert-side failure doesn't leave the dataset empty (the prior
    # non-transactional shape had this hazard).
    rows_removed = await db.replace_examples_for_dataset(dataset["id"], example_rows)
    stats = await db.update_dataset_stats(dataset["id"])

    return RefreshDatasetResponse(
        session_id=session_id,
        prompt_target=state.prompt_target,
        dataset_id=dataset["id"],
        rows_sampled=rows_sampled,
        rows_deduped=rows_deduped,
        rows_removed=rows_removed,
        rows_curation_lost=rows_curation_lost,
        rows_total=int(stats.get("total", len(example_rows))),
        message=(
            f"Refreshed dataset: removed {rows_removed} stale examples "
            f"(of which {rows_curation_lost} were curated), sampled {rows_sampled} "
            f"turns, deduped to {rows_deduped}."
        ),
    )


@app.patch("/sessions/{session_id}/scorers")
async def update_session_scorers(
    session_id: str,
    body: dict,
    access: Access = Depends(resolve_access),
):
    """Save generated scorers to session state."""
    require_writer(access)
    state, conversation = await _load_state(session_id)
    state.scorers = body.get("scorers", [])
    try:
        await db.update_session_input(session_id, state.model_dump())
        return {"ok": True}
    except ValueError:
        raise HTTPException(status_code=404, detail="Session not found")


# --- Scorer file export (GitHub-as-source-of-truth groundwork) ---

# Generated scorers land in backend/app/scorers/generated/<scope>/<name>.py
# so they can be committed, diffed in PRs, and pushed to Braintrust by CI.
# Scope keeps scorer-name collisions across prompt-eval targets (and skill
# sessions) from overwriting each other — `completeness` from skill_import
# and `completeness` from suggest_goals are different scorers.
_GENERATED_SCORERS_DIR = Path(__file__).parent / "scorers" / "generated"


def _slugify_scope(text: str) -> str:
    """Conservative slugger for directory names — keeps the tree predictable
    in `git diff` output and avoids surprises when a session name has a slash
    or unicode the OS dislikes. Also caps length so a runaway session name
    can't produce a 200-char path."""
    cleaned = "".join(c if (c.isalnum() or c in "-_") else "_" for c in (text or ""))
    cleaned = cleaned.strip("_") or "unscoped"
    return cleaned[:60]


def _scope_for_scorer_export(state: SessionState) -> str:
    """Pick a stable scope for a session's generated scorers.

    For prompt-eval projects (kind=prompt) the scope is the prompt_target,
    so re-running scorer generation for the same target overwrites the
    previous files in place — that's the "stable canonical artifact" the
    GitHub-source-of-truth flow wants.

    For skill-eval projects we don't have a stable identifier across runs
    (a session is one user's one project), so we scope by session-id prefix.
    Re-running scorer generation in the same session overwrites; a new
    session for the same skill produces a sibling directory the user can
    reconcile manually.
    """
    if state.kind == SessionKind.prompt and state.prompt_target:
        return _slugify_scope(state.prompt_target)
    return f"skill__{state.session_id[:8]}" if state.session_id else "skill__unknown"


def _export_generated_scorers(state: SessionState, scorers: list[dict]) -> int:
    """Write each scorer dict as both a `.py` and a `.md` file under
    scorers/generated/<scope>/.

    Two artifacts per scorer:
      * `.py` — the LLM-emitted Python function used by offline evals (the
        `evals/run_eval.py` harness execs these with a `call_judge` helper).
      * `.md` — the same judge prompt converted to Braintrust online-scorer
        format (Mustache placeholders, YAML frontmatter). Picked up by
        `online_scorers.list_scorers()` so the user can paste the body into
        Braintrust UI and attach as an autoeval scorer on production traces.

    Returns the number of `.py` files written. Best-effort on both formats —
    IO failures log a warning, never raise.
    """
    if not scorers:
        return 0
    scope = _scope_for_scorer_export(state)
    target_dir = _GENERATED_SCORERS_DIR / scope
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.warning(f"scorer file export: mkdir {target_dir} failed: {e}")
        return 0

    # Lazy import to match the rest of this module's datetime usage pattern.
    from datetime import datetime, timezone
    from .scorer_publish import scorer_to_online_md, ScorerPublishError
    written = 0
    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    # turn_type for the Braintrust filter: prompt-eval scorers grade the
    # output of the prompt under test, so they fire on that target's spans.
    # Skill-eval scorers score the eval task itself — no good live trace
    # filter, so we leave turn_type empty and the user adds one manually.
    turn_type_for_filter = (
        state.prompt_target if state.kind == SessionKind.prompt else None
    )
    for scorer in scorers:
        name = scorer.get("name") or ""
        code = scorer.get("code") or ""
        if not name or not code:
            continue
        # Same conservative slug rules as the directory — names come from
        # the LLM and we don't want a bad one breaking the filesystem.
        filename = _slugify_scope(name) + ".py"
        path = target_dir / filename
        # Deterministic header that traces back to the session that produced
        # the file — matters when a CI step asks "where did this come from".
        header = (
            f'"""\n{scorer.get("description") or "(no description)"}\n\n'
            f'Generated by North Star.\n'
            f'session_id: {state.session_id or "unknown"}\n'
            f'scope: {scope}\n'
            f'type: {scorer.get("type") or "unknown"}\n'
            f'generated_at: {timestamp}\n'
            f'"""\n\n'
        )
        try:
            path.write_text(header + code.lstrip() + "\n")
            written += 1
        except OSError as e:
            logger.warning(f"scorer file export: write {path} failed: {e}")
            continue

        # Mirror as a Braintrust online-scorer .md. Failures here don't undo
        # the .py write — offline evals still work without the .md.
        md_path = target_dir / (_slugify_scope(name) + ".md")
        try:
            md_text = scorer_to_online_md(
                scorer,
                turn_type=turn_type_for_filter,
                session_id=state.session_id,
                scope=scope,
                generated_at=timestamp,
            )
            md_path.write_text(md_text)
        except ScorerPublishError as e:
            logger.warning(f"scorer .md export: {name} skipped — {e}")
        except OSError as e:
            logger.warning(f"scorer .md export: write {md_path} failed: {e}")
    return written


UNMAPPED_FEATURE_AREA = "(unmapped)"


def _normalize_synthesized_coverage_tags(generated: list[dict], seed: dict) -> tuple[int, int]:
    """Snap each synthesized row's `coverage_tags` to canonical seed
    coverage criteria using the same fuzzy resolver as the coverage matrix.

    Why: the matrix in `_build_coverage_matrix` already fuzzy-matches tags at
    read time, but downstream consumers (filters, exports, eval gating, the
    sidebar's "Row covers" list) compare raw strings. Without snapping at
    write time, a row whose LLM paraphrased a criterion ("FAQ-style
    responses" vs seed's "FAQ responses") shows the LLM's wording
    everywhere except the coverage matrix — inconsistent and confusing.

    Per-tag behavior:
      1. exact match against a seed criterion → keep as-is.
      2. fuzzy resolve (>=12-char shared normalized prefix) → snap to the
         canonical form.
      3. otherwise → leave the tag alone. We don't drop unknowns: the LLM
         occasionally adds useful descriptors the seed hasn't named yet,
         and the matrix will simply not credit them — same outcome as before
         this snap existed.

    Returns (tags_snapped, tags_left_alone). Both are useful for warning
    logs: lots of snaps means the LLM is paraphrasing the criteria; lots of
    "left alone" means it's inventing categories not in the seed.
    """
    from .prompt import _resolve_seed_string

    coverage = (seed.get("coverage") or {}).get("criteria") or []
    if not coverage:
        return 0, 0
    canonical_lookup = {c.casefold().strip(): c for c in coverage if isinstance(c, str)}
    snapped_total = 0
    unmapped_total = 0
    for ex in generated:
        if not isinstance(ex, dict):
            continue
        tags = ex.get("coverage_tags")
        if not isinstance(tags, list):
            continue
        new_tags: list[str] = []
        for tag in tags:
            if not isinstance(tag, str) or not tag.strip():
                continue
            if tag in coverage:
                new_tags.append(tag)
                continue
            # Cheap exact-after-casefold check first; fuzzy resolver is the
            # fallback for paraphrases.
            exact = canonical_lookup.get(tag.casefold().strip())
            if exact is not None:
                new_tags.append(exact)
                snapped_total += 1
                continue
            fuzzy = _resolve_seed_string(tag, coverage)
            if fuzzy is not None:
                new_tags.append(fuzzy)
                snapped_total += 1
                continue
            new_tags.append(tag)
            unmapped_total += 1
        # Dedupe while preserving order — fuzzy snap can collapse two LLM
        # paraphrases of the same criterion onto the same canonical string.
        seen: set[str] = set()
        deduped: list[str] = []
        for t in new_tags:
            if t in seen:
                continue
            seen.add(t)
            deduped.append(t)
        ex["coverage_tags"] = deduped
    return snapped_total, unmapped_total


def _normalize_synthesized_feature_areas(generated: list[dict], seed: dict) -> int:
    """Snap each synthesized row's `feature_area` to a known alignment entry,
    or to ``UNMAPPED_FEATURE_AREA`` when it doesn't match any.

    Why: scorer gating compares row.feature_area to seed.alignment[*].
    feature_area exactly. If the LLM emits a paraphrased or wrong-dimension
    string (a common synthesis bug — confusing alignment with coverage),
    the row's alignment scorers all silently gate out and the row scores
    only on coverage + safety. Snapping here makes the failure visible:
    rows tagged ``(unmapped)`` sit clearly outside any alignment scorer's
    target and surface in the UI's "unmapped rows" banner.

    Three branches:
      1. exact match against an alignment feature_area → keep as-is.
      2. case/whitespace-insensitive match → snap to the canonical form.
      3. otherwise → ``(unmapped)``.

    Returns the count of rows that got snapped to ``(unmapped)`` so the
    caller can log how often synthesis is producing out-of-range labels.
    """
    alignment_areas = [
        a.get("feature_area", "")
        for a in (seed.get("alignment") or [])
        if isinstance(a, dict) and a.get("feature_area")
    ]
    if not alignment_areas:
        # No alignment dimensions defined → nothing to snap to. Leave rows
        # alone so the user can decide whether to flesh out the seed.
        return 0
    canonical = {a.casefold().strip(): a for a in alignment_areas}
    unmapped_count = 0
    for ex in generated:
        if not isinstance(ex, dict):
            continue
        fa = ex.get("feature_area")
        if not isinstance(fa, str):
            ex["feature_area"] = UNMAPPED_FEATURE_AREA
            unmapped_count += 1
            continue
        # Off-target rows in triggered mode legitimately use this sentinel
        # — leave it alone.
        if fa == "(off-target)":
            continue
        if fa in alignment_areas:
            continue
        snapped = canonical.get(fa.casefold().strip())
        if snapped is not None:
            ex["feature_area"] = snapped
            continue
        ex["feature_area"] = UNMAPPED_FEATURE_AREA
        unmapped_count += 1
    return unmapped_count


def _slugify_for_scorer_match(text: str) -> str:
    """Lowercase + strip non-alphanumerics. Used to match a generated scorer
    name against the seed entry it grades, when the LLM-emitted
    `target_tag` is missing or malformed.

    Why this exists: the gating runner needs the EXACT seed text to
    filter rows, but the LLM that emits scorers occasionally drops the
    `target_tag` field. The scorer name itself (e.g. `coverage_3p_updates`)
    is a slug of the criterion text the LLM picked, so we can recover the
    gate by slugifying every seed entry the same way and finding the
    one whose slug appears in the scorer name.
    """
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _ensure_scorer_target_tags(scorers: list[dict], seed: dict) -> None:
    """Mutate `scorers` in place: backfill missing target_tag fields by
    slug-matching each scorer's name against seed entries.

    Coverage scorers map to `coverage.criteria` strings; alignment scorers
    map to `alignment[i].feature_area` strings. Safety scorers don't gate
    so they're left alone. If we can't find a seed entry whose slug
    appears in the scorer name, we leave target_tag as None and the runner
    falls back to ungated execution with a stderr warning — same behavior
    as legacy sessions that pre-date the field, so nothing breaks.
    """
    coverage_criteria = list(seed.get("coverage", {}).get("criteria") or [])
    alignment_areas = [
        a.get("feature_area", "")
        for a in (seed.get("alignment") or [])
        if isinstance(a, dict) and a.get("feature_area")
    ]

    coverage_slugs = [(c, _slugify_for_scorer_match(c)) for c in coverage_criteria if c]
    alignment_slugs = [(a, _slugify_for_scorer_match(a)) for a in alignment_areas if a]

    for sc in scorers:
        if not isinstance(sc, dict):
            continue
        existing = sc.get("target_tag")
        if isinstance(existing, str) and existing.strip():
            continue  # LLM emitted it — trust it
        scorer_type = (sc.get("type") or "").strip().lower()
        if scorer_type not in ("coverage", "alignment"):
            continue  # safety / unknown — no gate needed
        name_slug = _slugify_for_scorer_match(sc.get("name") or "")
        if not name_slug:
            continue
        candidates = coverage_slugs if scorer_type == "coverage" else alignment_slugs
        # Pick the longest slug that appears in the scorer name. Longer
        # wins so ambiguous prefixes (e.g. "3p" vs "3p_update") resolve to
        # the more specific seed entry; ties fall through to the first
        # match in seed order.
        best: tuple[str, str] | None = None
        for original, slug in candidates:
            if not slug or slug not in name_slug:
                continue
            if best is None or len(slug) > len(best[1]):
                best = (original, slug)
        if best is not None:
            sc["target_tag"] = best[0]


def _agent_contract_for_session(state: SessionState) -> str | None:
    """Resolve the system-prompt / SKILL.md the scorers are grading outputs of.

    Three branches, all derived from session state, no graceful-fallback
    invention — by the time scorer generation runs, the user has either:

      * created a prompt-eval project (prompt_target set at creation),
      * seeded a triggered skill-eval project from a SKILL.md (skill_body
        set at seeding time, gates the rest of the workspace),
      * walked through chat/discovery — in which case there is no separate
        agent prompt at all and the seed IS the contract. We return None
        and the scorer-generation prompt omits the section, falling back to
        the historic seed-only behavior for that one mode.

    Branches are dispatched on ``state.kind`` exclusively, not on the
    presence of skill_body — prompt-eval sessions seed a synthetic
    skill_body containing the rendered prompt template, and confusing that
    with a user's actual SKILL.md would silently corrupt the contract.
    """
    if state.kind == SessionKind.prompt:
        target = get_prompt_target(state.prompt_target) if state.prompt_target else None
        return target.prompt_text if target else None
    if state.kind == SessionKind.skill and state.seed.task.skill_body:
        return state.seed.task.skill_body
    return None


@app.post("/sessions/{session_id}/generate-scorers")
async def generate_scorers_endpoint(
    session_id: str,
    access: Access = Depends(resolve_access),
    _quota: None = Depends(enforce_quota),
):
    """Generate evaluation scorers from seed via LLM.

    Writes each generated scorer to ``backend/app/scorers/generated/<scope>/``
    as a side effect — gives downstream CI / `braintrust push` a canonical
    file to read, lets the scorers be diffed in PRs when they regenerate.
    The DB row remains the operational source of truth; the file mirror is
    the versioned one. File-write failures don't block the response.

    The agent contract (the prompt / SKILL.md the scorers will grade outputs
    of) is passed alongside the seed so the LLM doesn't fabricate criteria
    the agent can't satisfy — see build_generate_scorers_prompt's docstring.
    """
    require_writer(access)
    state, conversation = await _load_state(session_id)
    seed = state.seed.model_dump()
    agent_contract = _agent_contract_for_session(state)
    scorers, call_meta = await call_generate_scorers(seed, agent_contract=agent_contract)
    # Backstop for the LLM occasionally forgetting `target_tag`. Each
    # scorer maps 1:1 to a seed entry; we can recover the gate from
    # the scorer name alone — no LLM judgment, just slug matching against
    # the seed we know.
    _ensure_scorer_target_tags(scorers, seed)
    state.scorers = scorers
    _stamp_lineage(state, "scorers")
    await _save_state(session_id, state, conversation)
    await db.create_turn(
        session_id=session_id,
        turn_type="generate_scorers",
        input_snapshot={"seed": seed},
        llm_calls=call_meta,
        parsed_output={"scorers": scorers},
    )
    files_written = _export_generated_scorers(state, scorers)
    return {"scorers": scorers, "files_written": files_written}


@app.get("/sessions/{session_id}/scorers/{scorer_name}/braintrust-prompt")
async def get_braintrust_prompt(session_id: str, scorer_name: str):
    """Return the Mustache-templated prompt body for one generated scorer.

    Powers the "Export to Braintrust" button in the Scorers panel — the
    button writes the response body to the clipboard so the user can paste
    it directly into Braintrust's online-scorer editor without leaving the
    browser. Same conversion path as ``_export_generated_scorers`` and the
    ``online_scorers.py publish`` CLI, so all three stay consistent.
    """
    state, _ = await _load_state(session_id)
    # scorer_name is used only as a dict-key lookup against state.scorers —
    # never touched the filesystem here, so path traversal isn't a risk.
    # If a future refactor uses it for file IO, slugify via _slugify_scope
    # before that point.
    scorers = state.scorers or []
    scorer = next((s for s in scorers if s.get("name") == scorer_name), None)
    if scorer is None:
        raise HTTPException(status_code=404, detail=f"No scorer named '{scorer_name}' on session {session_id}")

    from .scorer_publish import scorer_to_online_md, ScorerPublishError
    turn_type = state.prompt_target if state.kind == SessionKind.prompt else None
    try:
        body = scorer_to_online_md(
            scorer,
            turn_type=turn_type,
            session_id=state.session_id,
            scope=_scope_for_scorer_export(state),
        )
    except ScorerPublishError as e:
        raise HTTPException(
            status_code=422,
            detail=f"Cannot convert scorer to Braintrust format: {e}",
        )
    # Filter expression the user pastes into the Braintrust UI's trigger
    # field. None for skill-eval projects (no live trace turn_type to filter on).
    filter_expression = (
        f'metadata.turn_type = "{turn_type}"' if turn_type else None
    )
    return {
        "name": scorer_name,
        "prompt": body,
        "filter": filter_expression,
    }


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str, access: Access = Depends(resolve_access)):
    """Delete a session and all associated data. Owner-only — share-token
    bearers (even editors) must not destroy the project they were invited to."""
    _require_owner(access)
    try:
        await db.delete_session(session_id)
        return {"ok": True}
    except ValueError:
        raise HTTPException(status_code=404, detail="Session not found")


# --- Share tokens (project sharing) ----------------------------------------
#
# Every project ("session") can hand out viewer/editor links via short-lived
# share tokens. Owners — i.e. callers without an X-Share-Token / ?token= —
# can mint, list, and revoke. Token bearers cannot manage tokens (would let
# an editor escalate to permanent access by minting a fresh editor token
# then revoking the original on a whim).

def _require_owner(access: Access) -> None:
    """Refuse the request if the caller authed via a share token.

    Used by the token-management endpoints — only the owner gets to mint or
    revoke. Token-bearing collaborators always 403 here, even editors.
    """
    if access.via_token:
        raise HTTPException(
            status_code=403,
            detail="Only the project owner can manage share tokens.",
        )


@app.post(
    "/sessions/{session_id}/share-tokens",
    response_model=CreateShareTokenResponse,
)
async def create_share_token_endpoint(
    session_id: str,
    req: CreateShareTokenRequest,
    access: Access = Depends(resolve_access),
):
    """Mint a new viewer/editor token for this session.

    The plaintext token is in the response **once and only once** — there's
    no recovery flow. Caller is expected to copy/embed it immediately.
    """
    _require_owner(access)
    if req.role not in ("viewer", "editor"):
        raise HTTPException(status_code=400, detail="role must be 'viewer' or 'editor'.")
    # Confirm the session exists so a typo in the URL doesn't leave a dangling
    # token row referencing a missing session (FK would catch it, but the
    # 500 → 404 mapping is friendlier from the dependency layer).
    if await db.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    row = await db.create_share_token(session_id, req.role, req.label)
    return CreateShareTokenResponse(
        id=str(row["id"]),
        token=row["token"],
        role=row["role"],
        label=row.get("label"),
        created_at=row["created_at"],
    )


@app.get(
    "/sessions/{session_id}/share-tokens",
    response_model=list[ShareTokenSummary],
)
async def list_share_tokens_endpoint(
    session_id: str,
    access: Access = Depends(resolve_access),
):
    """List active + revoked tokens for a session, plaintext redacted."""
    _require_owner(access)
    rows = await db.list_share_tokens(session_id)
    return [
        ShareTokenSummary(
            id=str(r["id"]),
            role=r["role"],
            label=r.get("label"),
            token_preview=r["token_preview"],
            created_at=r["created_at"],
            revoked_at=r.get("revoked_at"),
        )
        for r in rows
    ]


@app.delete(
    "/sessions/{session_id}/share-tokens/{token_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def revoke_share_token_endpoint(
    session_id: str,
    token_id: str,
    access: Access = Depends(resolve_access),
):
    """Revoke a token. Idempotent — already-revoked still returns 204."""
    _require_owner(access)
    await db.revoke_share_token(token_id, session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Dataset access dependency ---------------------------------------------

async def resolve_dataset_access(
    dataset_id: str,
    request: Request,
    x_share_token: str | None = None,
) -> Access:
    """Like `resolve_access` but for endpoints that take dataset_id in the path.

    Looks up the owning session_id and delegates to `resolve_access`. Used by
    every dataset-scoped mutating endpoint so a viewer-token holder can't
    sneak in by addressing the dataset directly. Falls through to 404 when
    the dataset doesn't exist (rather than 403) so missing-resource
    semantics stay clean for honest callers.
    """
    # Header lookup matches resolve_access's alias casing exactly.
    header_token = request.headers.get("x-share-token")
    session_id = await db.get_session_id_for_dataset(dataset_id)
    if session_id is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return await resolve_access(
        session_id=session_id,
        request=request,
        x_share_token=header_token,
    )


# --- Live SSE updates ------------------------------------------------------

@app.get("/sessions/{session_id}/events")
async def session_events(
    session_id: str,
    request: Request,
    access: Access = Depends(resolve_access),
):
    """Server-Sent Events stream of state changes for one session.

    Every successful `db.update_session` call publishes a `state_changed`
    event via the in-process broadcaster; this endpoint relays them over an
    EventSource-compatible stream so the frontend updates without polling.

    Auth: the share-token can come on the `X-Share-Token` header (regular
    fetch) or `?token=` query param (EventSource — can't set headers).
    Both routes go through `resolve_access`, viewer + editor + owner all
    pass; viewers don't get events any more limited than editors do because
    the underlying state is the same regardless of role.

    Heartbeat: 15s of silence emits an SSE comment line so intermediary
    proxies don't time the connection out. Browsers ignore comments.
    """
    import asyncio

    # Capacity tracking + alerting. inc/dec inside try/finally so a slow
    # consumer disconnect or proxy timeout always decrements the counter.
    await capacity.inc("sse_connections")
    queue = await broadcaster.subscribe(session_id)

    async def event_stream():
        try:
            # Initial hello — lets the frontend confirm role at handshake
            # time without a separate fetch.
            yield f'event: hello\ndata: {{"role": "{access.role}"}}\n\n'
            while True:
                # Bail if the client went away — without this an aborted
                # EventSource would keep the queue subscription forever.
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    # Heartbeat: SSE comment line. Browsers + EventSource
                    # treat lines starting with ":" as comments and ignore.
                    yield ": ping\n\n"
                    continue
                event_type = event.get("type", "message")
                # Forward the payload so progress events (e.g. dataset-synth
                # cell completions) can carry generated/total counts. Default
                # to "{}" so existing state_changed listeners that ignore the
                # payload keep working.
                payload = event.get("data") or {}
                yield (
                    f"event: {event_type}\n"
                    f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"
                )
        except asyncio.CancelledError:
            # Cancellation flows through here when the request is torn down
            # — re-raise so FastAPI unwinds correctly.
            raise
        finally:
            broadcaster.unsubscribe(session_id, queue)
            await capacity.dec("sse_connections")

    headers = {
        "Cache-Control": "no-cache",
        # Prevents nginx from buffering the stream into chunks of full
        # responses. Fastly + Cloudflare also honor this.
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers=headers,
    )


# --- Metrics ---------------------------------------------------------------

@app.get("/metrics")
async def metrics():
    """Plain-text capacity gauges. NOT auth-gated — fine for the prototype
    because the values are aggregate counts with no secrets, but should be
    locked down (scrape token, internal-only ingress, etc.) before any
    real production deployment.
    """
    snap = capacity.snapshot()
    body = "\n".join(f"{k} {v}" for k, v in snap.items()) + "\n"
    return Response(content=body, media_type="text/plain")


# Session IDs with an in-flight auto-retag. Module-level set + check-then-add
# under no async boundary is fine — Python's GIL serializes the membership
# check and add. Cross-process locking would need Redis or a DB advisory lock,
# but a single uvicorn worker is the deployment shape today.
_RETAG_IN_FLIGHT: set[str] = set()


async def _retag_dataset_after_seed(session_id: str, seed: dict) -> None:
    """Background: re-tag a prompt-eval dataset against a freshly-generated
    seed so the Coverage Map matrix lines up with the seed's axes.

    Safe to fire-and-forget — failures are logged but don't surface to the
    user. The user can also re-run manually via the dataset endpoint.

    Concurrency-guarded: if a retag is already running for this session,
    we skip rather than spawn a second one. Two simultaneous retags would
    interleave per-batch updates against the same examples and produce
    confusing results.
    """
    if session_id in _RETAG_IN_FLIGHT:
        logger.info("Skipping auto-retag for session %s — one already running", session_id)
        return
    _RETAG_IN_FLIGHT.add(session_id)
    try:
        dataset = await db.get_dataset_by_session(session_id)
        if dataset is None:
            return
        # Refresh the seed_snapshot first — gap_analysis and scorers read
        # from there, and it was set to {} at session-create time (before the
        # seed existed).
        await db.update_dataset_seed_snapshot(dataset["id"], seed)
        examples = await db.get_examples(dataset["id"])
        if not examples:
            return
        batch_size = 10
        for i in range(0, len(examples), batch_size):
            batch = examples[i:i + batch_size]
            retags, call_meta = await call_retag_examples_against_seed(seed, batch)
            # Apply the same canonical-snap passes as synth so the retag
            # writes consistent seed strings even when the LLM
            # paraphrased.
            _normalize_synthesized_feature_areas(retags, seed)
            _normalize_synthesized_coverage_tags(retags, seed)
            for r in retags:
                eid = r.get("example_id")
                if not eid:
                    continue
                update_fields: dict = {}
                fa = r.get("feature_area")
                if isinstance(fa, str) and fa.strip():
                    update_fields["feature_area"] = fa.strip()
                tags = r.get("coverage_tags")
                if isinstance(tags, list):
                    update_fields["coverage_tags"] = [t for t in tags if isinstance(t, str) and t.strip()]
                if update_fields:
                    await db.update_example(eid, update_fields)
            await db.create_turn(
                session_id=session_id,
                turn_type="retag",
                input_snapshot={"seed": seed, "example_count": len(batch), "auto": True},
                llm_calls=call_meta,
                parsed_output={"retags": retags},
            )
        await db.update_dataset_stats(dataset["id"])
    except Exception:  # noqa: BLE001
        logger.exception("Auto-retag after seed generation failed for session %s", session_id)
    finally:
        _RETAG_IN_FLIGHT.discard(session_id)


@app.post("/sessions/{session_id}/message", response_model=SendMessageResponse)
async def send_message(
    session_id: str,
    req: SendMessageRequest,
    access: Access = Depends(resolve_access),
    _quota: None = Depends(enforce_quota),
):
    require_writer(access)

    # Track that an LLM agent loop is in flight so the capacity monitor can
    # alert if too many pile up at once. Outer try/finally guarantees the
    # counter decrements on every exit path (HTTPException, cancel, etc.).
    await capacity.inc("agent_inflight")
    try:
        state, conversation = await _load_state(session_id)

        result = await run_agent_turn(state, req.message, regenerate=req.regenerate)

        conversation = state.input.conversation_history.copy()
        await _save_state(session_id, state, conversation)

        logger.info(
            f"Turn complete: session={session_id} status={state.agent_status.value} "
            f"tools={result.tool_calls} rounds={state.rounds_of_questions}"
        )

        # For prompt-eval projects: when the agent just generated a fresh
        # seed, re-tag the dataset (sampled from `turns`) against the
        # seed's axes so the Coverage Map matrix becomes meaningful.
        # Fire-and-forget so we don't add 5–15s to the message turn — the
        # user can refresh the dataset to see updated tags, or trigger
        # manually via the retag endpoint.
        if state.kind == SessionKind.prompt and "generate_draft" in result.tool_calls:
            asyncio.create_task(
                _retag_dataset_after_seed(session_id, state.seed.model_dump())
            )

        return SendMessageResponse(
            message=result.message,
            agent_status=state.agent_status,
            state=state,
            tool_calls=result.tool_calls,
            suggestions=result.suggestions,
            suggested_stories=result.suggested_stories,
        )
    finally:
        await capacity.dec("agent_inflight")


@app.post("/sessions/{session_id}/proceed", response_model=ProceedResponse)
async def proceed_to_review(
    session_id: str,
    access: Access = Depends(resolve_access),
    _quota: None = Depends(enforce_quota),
):
    require_writer(access)
    state, conversation = await _load_state(session_id)

    state.agent_status = AgentStatus.review

    await _save_state(session_id, state, conversation)

    return ProceedResponse(
        agent_status=state.agent_status,
        state=state,
    )


@app.get("/sessions/{session_id}")
async def get_session(
    session_id: str,
    access: Access = Depends(resolve_access),
):
    # Single DB read — _load_state used to call db.get_session itself, so
    # this handler was hitting the row twice. Inline the load here so we
    # can pull `name` and `state`/`conversation` out of one fetchrow.
    row = await db.get_session(session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    state = SessionState.model_validate(row["state"])
    conversation = row["conversation"]
    state, conversation = await _maybe_backfill_prompt_meta(session_id, state, conversation)
    state_dict = state.model_dump()
    # Frontend reads state._access.role to hide write affordances for viewers.
    state_dict["_access"] = {"role": access.role}
    return {
        "session_id": session_id,
        "name": row.get("name"),
        "state": state_dict,
        "conversation": conversation,
    }


@app.patch("/sessions/{session_id}/seed")
async def patch_seed(
    session_id: str,
    req: PatchSeedRequest,
    access: Access = Depends(resolve_access),
):
    require_writer(access)
    state, conversation = await _load_state(session_id)

    if req.coverage is not None:
        state.seed.coverage = req.coverage
    if req.balance is not None:
        state.seed.balance = req.balance
    if req.alignment is not None:
        state.seed.alignment = req.alignment
    if req.rot is not None:
        state.seed.rot = req.rot
    if req.safety is not None:
        state.seed.safety = req.safety

    await _save_state(session_id, state, conversation)

    return {"state": state.model_dump()}


@app.post("/sessions/{session_id}/validate", response_model=ValidateResponse)
async def validate_seed(
    session_id: str,
    access: Access = Depends(resolve_access),
    _quota: None = Depends(enforce_quota),
):
    """Run validation on the current seed and return results."""
    require_writer(access)
    state, conversation = await _load_state(session_id)

    validation, call_meta = await call_validate_seed(state)
    state.validation = validation

    await _save_state(session_id, state, conversation)

    # Log the turn
    await db.create_turn(
        session_id=session_id,
        turn_type="validate",
        input_snapshot=state.seed.model_dump(),
        llm_calls=call_meta,
        parsed_output=validation.model_dump(),
    )

    return ValidateResponse(validation=validation, state=state)


@app.post("/sessions/{session_id}/suggest", response_model=SuggestResponse)
async def suggest_for_seed(
    session_id: str,
    access: Access = Depends(resolve_access),
    _quota: None = Depends(enforce_quota),
):
    """Generate suggestions for weak/empty seed sections."""
    require_writer(access)
    state, conversation = await _load_state(session_id)

    (suggestions, stories), call_meta = await call_generate_suggestions(state)

    # Log the turn
    await db.create_turn(
        session_id=session_id,
        turn_type="suggest",
        input_snapshot=state.seed.model_dump(),
        llm_calls=call_meta,
        parsed_output={"suggestions": [s.model_dump() for s in suggestions], "stories": [s.model_dump() for s in stories]},
    )

    return SuggestResponse(suggestions=suggestions, suggested_stories=stories)


@app.post("/sessions/{session_id}/finalize", response_model=FinalizeResponse)
async def finalize_session(
    session_id: str,
    access: Access = Depends(resolve_access),
):
    require_writer(access)
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

    # Create seed record
    seed_row = await db.create_seed(
        session_id=session_id,
        seed=state.seed.model_dump(),
        weak_criteria=weak_criteria,
    )

    # Finalize it
    await db.finalize_seed(seed_row["id"])

    _stamp_lineage(state, "seed")

    state.agent_status = AgentStatus.review
    await _save_state(session_id, state, conversation)

    return FinalizeResponse(
        seed_id=seed_row["id"],
        session_id=session_id,
        seed=state.seed,
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
            f"Drafted seed · {coverage} coverage, {balance} balance, "
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
async def run_judge(
    request: Request,
    session_id: str | None = None,
    limit: int = 50,
    _quota: None = Depends(enforce_quota),
):
    """Run judge scoring on unjudged turns.

    Auth note: when ``session_id`` is provided, the call must pass write
    auth on that session — we re-use ``resolve_access`` so a viewer-token
    holder can't trigger judge work on a project they only read. With no
    ``session_id`` (the cross-session admin path), we require *no* token —
    only direct (owner-style) access. A token of any kind is rejected,
    since the bearer has no scope to run global judging.
    """
    if session_id is not None:
        access = await resolve_access(session_id=session_id, request=request)
        require_writer(access)
    elif request.headers.get("x-share-token") or request.query_params.get("token"):
        raise HTTPException(
            status_code=403,
            detail="Cross-session judge runs aren't accessible via share tokens.",
        )
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

        await db.create_judgement(
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
    parsed_output = turn.get("parsed_output")
    agent_message = turn.get("agent_message")

    if turn_type == "generate":
        return f"""You are a judge evaluating a seed generation agent. The agent was given user input and generated a seed draft.

User input:
{json.dumps(input_snapshot, indent=2)}

Agent's generated seed:
{json.dumps(parsed_output, indent=2)}

Score the agent on these dimensions (0.0 to 1.0):
- **specificity**: Are criteria specific and testable, or vague/generic?
- **traceability**: Are criteria directly traceable to the user's input, or invented?
- **completeness**: Did the agent address all relevant sections given the input?
- **conciseness**: Did the agent avoid over-generating beyond what the input supports?

Return ONLY JSON:
{{"scores": {{"specificity": 0.0, "traceability": 0.0, "completeness": 0.0, "conciseness": 0.0}}, "reasoning": "brief explanation"}}"""

    elif turn_type == "validate":
        return f"""You are a judge evaluating a seed validation step. The agent validated a seed and assigned pass/weak/fail statuses.

Seed being validated:
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
        return f"""You are a judge evaluating a conversational turn from a seed-building agent.

Context:
{json.dumps(input_snapshot, indent=2)}

Agent's message to user:
{agent_message or "(no message)"}

Seed update applied: {json.dumps(parsed_output) if parsed_output else "None"}

Score the agent on these dimensions (0.0 to 1.0):
- **relevance**: Does the response address what the user said?
- **brevity**: Is the response concise and scannable?
- **question_quality**: Are follow-up questions specific and useful?
- **update_accuracy**: If a seed update was made, is it correct and minimal?

Return ONLY JSON:
{{"scores": {{"relevance": 0.0, "brevity": 0.0, "question_quality": 0.0, "update_accuracy": 0.0}}, "reasoning": "brief explanation"}}"""

    elif turn_type == "suggest":
        return f"""You are a judge evaluating suggestion generation from a seed-building agent.

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
async def create_dataset(
    session_id: str,
    req: CreateDatasetRequest,
    access: Access = Depends(resolve_access),
):
    """Create a dataset for this session's seed."""
    require_writer(access)
    state, _ = await _load_state(session_id)
    seed_snapshot = state.seed.model_dump()

    dataset = await db.create_dataset(
        session_id=session_id,
        name=req.name or f"Dataset for {session_id[:8]}",
        seed_snapshot=seed_snapshot,
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
async def create_dataset_version(
    dataset_id: str,
    access: Access = Depends(resolve_dataset_access),
):
    """Snapshot current dataset as a new version."""
    require_writer(access)
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    state, _ = await _load_state(dataset["session_id"])
    seed_snapshot = state.seed.model_dump()

    new_version = await db.create_dataset_version(dataset_id, seed_snapshot)
    return new_version


@app.post("/datasets/{dataset_id}/import")
async def import_examples(
    dataset_id: str,
    req: ImportExamplesRequest,
    access: Access = Depends(resolve_dataset_access),
):
    """Import examples from JSON."""
    require_writer(access)
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
            "scenario_type": ex.get("scenario_type"),
            "difficulty": ex.get("difficulty"),
            "tier": ex.get("tier", "eval"),
        })

    created = await db.bulk_create_examples(dataset_id, normalized)
    stats = await db.update_dataset_stats(dataset_id)
    return {"imported": len(created), "stats": stats}


@app.post("/datasets/{dataset_id}/synthesize")
async def synthesize_examples(
    dataset_id: str,
    req: SynthesizeRequest,
    access: Access = Depends(resolve_dataset_access),
    _quota: None = Depends(enforce_quota),
):
    """Generate synthetic examples from the seed.

    Rows persist per-cell (rather than one bulk insert at the end) so each
    cell completion publishes a `synth_progress` SSE event with the running
    `{generated, total}` counts. Frontends use this to show real progress
    instead of a guessed expected total.
    """
    require_writer(access)
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    seed = dataset["seed_snapshot"]
    session_id = dataset["session_id"]

    # Compute the cell total upfront so progress events have a denominator
    # the frontend can paint against. Mirrors the cell-fan-out logic in
    # call_synthesize_examples — keep the two heuristics aligned.
    target_areas = req.feature_areas or [
        a.get("feature_area", "")
        for a in (seed.get("alignment") or [])
    ]
    target_areas = [a for a in target_areas if a]
    target_coverage = req.coverage_criteria or (
        (seed.get("coverage") or {}).get("criteria") or []
    )
    target_coverage = [c for c in target_coverage if c]
    cell_count = len(target_areas) * len(target_coverage)
    expected_total = max(cell_count, 1) * (req.count_per_scenario or 2)

    # Tell the frontend we're kicking off — `generated=0, total=expected`
    # gives the overlay something to render before the first cell lands.
    await broadcaster.publish(
        session_id,
        {
            "type": "synth_progress",
            "data": {
                "dataset_id": dataset_id,
                "generated": 0,
                "total": expected_total,
                "phase": "started",
            },
        },
    )

    created_total = 0
    all_created: list[dict] = []

    async def on_cell(cell_examples: list[dict]) -> None:
        """Persist this cell's rows and broadcast running progress.

        Lives inside the endpoint so it can close over `dataset_id` /
        `session_id` / counters without plumbing them through tools.py.
        Best-effort by design — if the publish or insert hiccups we log
        and move on; the synth itself is the source of truth.
        """
        nonlocal created_total
        # Snap out-of-range feature_area values to "(unmapped)" before
        # persisting. Per-cell synth makes this still a per-cell concern
        # (each cell can independently emit a coverage-name-in-alignment-
        # slot row); doing it here keeps the snap close to the LLM output.
        unmapped = _normalize_synthesized_feature_areas(cell_examples, seed)
        if unmapped:
            logger.warning(
                "synthesize: %d/%d rows in this cell had out-of-range feature_area, snapped to %r",
                unmapped, len(cell_examples), UNMAPPED_FEATURE_AREA,
            )
        # Also snap paraphrased coverage_tags back to their canonical seed
        # strings so the coverage matrix credits them and downstream
        # consumers see consistent tag values.
        tag_snapped, tag_unmapped = _normalize_synthesized_coverage_tags(cell_examples, seed)
        if tag_snapped or tag_unmapped:
            logger.info(
                "synthesize: cell coverage_tag snap — %d paraphrases canonicalized, "
                "%d tags left as-is (not in seed)",
                tag_snapped, tag_unmapped,
            )
        for ex in cell_examples:
            ex["source"] = "synthetic"
            # Keep the legacy is_adversarial column in sync with the new
            # scenario_type taxonomy so downstream code that hasn't migrated
            # off is_adversarial yet (safety scorers, exports, etc.) still
            # sees adversarial rows correctly.
            if ex.get("scenario_type") == "adversarial" and ex.get("is_adversarial") is None:
                ex["is_adversarial"] = True
        try:
            inserted = await db.bulk_create_examples(dataset_id, cell_examples)
        except Exception as err:
            logger.warning(
                f"synthesize_examples: cell insert failed: "
                f"{type(err).__name__}: {err}"
            )
            return
        all_created.extend(inserted)
        created_total += len(inserted)
        await broadcaster.publish(
            session_id,
            {
                "type": "synth_progress",
                "data": {
                    "dataset_id": dataset_id,
                    "generated": created_total,
                    "total": max(expected_total, created_total),
                    "phase": "in_progress",
                },
            },
        )

    _, call_meta = await call_synthesize_examples(
        seed,
        feature_areas=req.feature_areas,
        coverage_criteria=req.coverage_criteria,
        count=req.count_per_scenario,
        on_cell=on_cell,
    )

    # Final progress beat — pin generated/total to the actual created count
    # so the frontend can clear its overlay cleanly even when expected_total
    # diverges (LLM returned fewer rows than asked, cell failures, etc.).
    await broadcaster.publish(
        session_id,
        {
            "type": "synth_progress",
            "data": {
                "dataset_id": dataset_id,
                "generated": created_total,
                "total": created_total,
                "phase": "done",
            },
        },
    )

    # Log the turn
    await db.create_turn(
        session_id=session_id,
        turn_type="synthesize",
        input_snapshot={"seed": seed, "request": req.model_dump()},
        llm_calls=call_meta,
        parsed_output={"examples_generated": len(all_created)},
    )

    # Stamp lineage — dataset generated against the current active skill version.
    state, conversation = await _load_state(session_id)
    _stamp_lineage(state, "dataset")
    await _save_state(session_id, state, conversation)

    stats = await db.update_dataset_stats(dataset_id)
    return {
        "generated": len(all_created),
        "examples": all_created,
        "stats": stats,
    }


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
async def add_example(
    dataset_id: str,
    req: CreateExampleRequest,
    access: Access = Depends(resolve_dataset_access),
):
    """Add a manual example."""
    require_writer(access)
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
        scenario_type=req.scenario_type,
        difficulty=req.difficulty,
        tier=req.tier,
    )
    await db.update_dataset_stats(dataset_id)
    return example


@app.patch("/datasets/{dataset_id}/examples/{example_id}")
async def update_example(
    dataset_id: str,
    example_id: str,
    req: UpdateExampleRequest,
    access: Access = Depends(resolve_dataset_access),
):
    """Update an example (edit, approve, reject, relabel)."""
    require_writer(access)
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    example = await db.update_example(example_id, fields)
    await db.update_dataset_stats(dataset_id)
    return example


@app.delete("/datasets/{dataset_id}/examples/{example_id}")
async def remove_example(
    dataset_id: str,
    example_id: str,
    access: Access = Depends(resolve_dataset_access),
):
    """Remove an example from the dataset."""
    require_writer(access)
    deleted = await db.delete_example(example_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Example not found")
    await db.update_dataset_stats(dataset_id)
    return {"deleted": True}


@app.post("/datasets/{dataset_id}/review")
async def auto_review_examples(
    dataset_id: str,
    access: Access = Depends(resolve_dataset_access),
    _quota: None = Depends(enforce_quota),
):
    """Run auto-review on pending examples using the judge."""
    require_writer(access)
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    seed = dataset["seed_snapshot"]
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
             "label": ex["label"], "should_trigger": ex.get("should_trigger"),
             "scenario_type": ex.get("scenario_type")
                 or ("adversarial" if ex.get("is_adversarial") else None)}
            for ex in batch
        ]
        reviews, call_meta = await call_review_examples(seed, batch_for_review)

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
            input_snapshot={"seed": seed, "example_count": len(batch)},
            llm_calls=call_meta,
            parsed_output={"reviews": reviews},
        )

    await db.update_dataset_stats(dataset_id)
    return {"reviewed": len(all_reviews), "reviews": all_reviews}


@app.post("/datasets/{dataset_id}/refresh-from-turns")
async def refresh_dataset_from_turns(
    dataset_id: str,
    access: Access = Depends(resolve_dataset_access),
):
    """Pull any new historical turns into a prompt-eval dataset.

    Re-samples turns matching the session's prompt_target, dedupes against
    every input already in the dataset, and bulk-inserts the net-new rows
    with a "new" coverage tag so the UI can flag fresh evidence the user
    hasn't reviewed yet. Returns counts so callers can render a notice.

    No-op for sessions that aren't kind=prompt — use the manual import flow
    or synthesize for skill-eval datasets instead.
    """
    require_writer(access)
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    state, _ = await _load_state(dataset["session_id"])
    if state.kind != SessionKind.prompt or not state.prompt_target:
        return {"added": 0, "total": 0, "message": "Not a prompt-eval dataset"}

    pt = get_prompt_target(state.prompt_target)
    if pt is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown prompt_target on session: {state.prompt_target}",
        )

    # Hash every existing example's input so we can skip turns that match.
    existing = await db.get_examples(dataset_id)
    existing_hashes: set[str] = set()
    for ex in existing:
        existing_hashes.add((ex.get("input") or "")[:1000])

    # Sample widely so dedup has room to work — we'll cap by what's actually new.
    sampled = await db.sample_turns_for_prompt_eval(
        turn_type=state.prompt_target,
        limit=200,
        exclude_session_id=dataset["session_id"],
    )

    new_rows: list[dict] = []
    seen_in_batch: set[str] = set()
    for t in sampled:
        snap = t.get("input_snapshot") or {}
        input_str = json.dumps(snap)
        key = input_str[:1000]
        if key in existing_hashes or key in seen_in_batch:
            continue
        seen_in_batch.add(key)

        historical = t.get("agent_message") or ""
        if not historical:
            parsed = t.get("parsed_output")
            if isinstance(parsed, (dict, list)):
                historical = json.dumps(parsed)[:4000]
            elif isinstance(parsed, str):
                historical = parsed[:4000]

        new_rows.append({
            "feature_area": _bucket_for_prompt_target(state.prompt_target, snap),
            "input": input_str,
            "expected_output": historical,
            # "new" tag lets the UI badge these rows; the user can clear it
            # by reviewing/relabeling. Keeps the existing prompt-eval +
            # target tags alongside.
            "coverage_tags": ["prompt-eval", state.prompt_target, "new"],
            "source": "turns_sample",
            "label": "unlabeled",
            "review_status": "approved",
        })

    if new_rows:
        await db.bulk_create_examples(dataset_id, new_rows)
        await db.update_dataset_stats(dataset_id)

    return {
        "added": len(new_rows),
        "total": len(existing) + len(new_rows),
        "message": (
            f"Added {len(new_rows)} new turn{'s' if len(new_rows) != 1 else ''}"
            if new_rows else "No new turns since last refresh"
        ),
    }


@app.post("/datasets/{dataset_id}/retag-against-seed")
async def retag_examples_against_seed(
    dataset_id: str,
    access: Access = Depends(resolve_dataset_access),
    _quota: None = Depends(enforce_quota),
):
    """Re-tag every example's feature_area + coverage_tags against the current
    seed. Built for prompt-eval (where the dataset is sampled from `turns`
    before the seed exists, so the seeded `feature_area` buckets don't
    align with the seed's alignment areas), but works for any dataset.

    Idempotent — re-running just refreshes tags against the latest seed.
    """
    require_writer(access)
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    state, _ = await _load_state(dataset["session_id"])
    seed = state.seed.model_dump()

    coverage = (seed.get("coverage") or {}).get("criteria") or []
    alignment = seed.get("alignment") or []
    if not coverage and not alignment:
        raise HTTPException(
            status_code=400,
            detail="Seed has no coverage criteria or alignment entries to tag against. Generate the seed first.",
        )

    # Keep seed_snapshot in sync so /gaps and any scorer-side reads see
    # today's seed, not whatever was on the dataset at create time.
    await db.update_dataset_seed_snapshot(dataset_id, seed)

    examples = await db.get_examples(dataset_id)
    if not examples:
        return {"retagged": 0, "message": "Dataset is empty"}

    # Batch — same size as auto-review so we share rate-limit characteristics.
    batch_size = 10
    all_retags: list[dict] = []
    for i in range(0, len(examples), batch_size):
        batch = examples[i:i + batch_size]
        retags, call_meta = await call_retag_examples_against_seed(seed, batch)
        _normalize_synthesized_feature_areas(retags, seed)
        _normalize_synthesized_coverage_tags(retags, seed)
        for r in retags:
            eid = r.get("example_id")
            if not eid:
                continue
            update_fields: dict = {}
            fa = r.get("feature_area")
            if isinstance(fa, str) and fa.strip():
                update_fields["feature_area"] = fa.strip()
            tags = r.get("coverage_tags")
            if isinstance(tags, list):
                update_fields["coverage_tags"] = [t for t in tags if isinstance(t, str) and t.strip()]
            if update_fields:
                await db.update_example(eid, update_fields)
        all_retags.extend(retags)

        await db.create_turn(
            session_id=dataset["session_id"],
            turn_type="retag",
            input_snapshot={"seed": seed, "example_count": len(batch)},
            llm_calls=call_meta,
            parsed_output={"retags": retags},
        )

    await db.update_dataset_stats(dataset_id)
    return {"retagged": len(all_retags), "retags": all_retags}


@app.post("/datasets/{dataset_id}/suggest-revisions")
async def suggest_revisions(
    dataset_id: str,
    req: SuggestRevisionsRequest,
    access: Access = Depends(resolve_dataset_access),
    _quota: None = Depends(enforce_quota),
):
    """Suggest revisions for examples that have review issues."""
    require_writer(access)
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    seed = dataset["seed_snapshot"]

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
        revisions, call_meta = await call_revise_examples(seed, batch_for_revision)

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
            input_snapshot={"seed": seed, "example_count": len(batch)},
            llm_calls=call_meta,
            parsed_output={"revisions": revisions},
        )

    await db.update_dataset_stats(dataset_id)
    return {"revised": len(all_revisions), "revisions": all_revisions}


@app.get("/datasets/{dataset_id}/gaps")
async def analyze_gaps(dataset_id: str):
    """Coverage and balance gap analysis — fully deterministic.

    The earlier implementation called the LLM here, which paid 30-60s
    of latency to do work that's just counting cells in a matrix:
      - "criteria with 0 examples"
      - "feature areas with 0 examples"
      - "feature areas missing good or bad examples"
    None of those need a model. Now they're computed in Python from
    the same coverage matrix the LLM was being handed as input. The
    endpoint returns instantly (single DB read for examples + stats).

    Trade-off: the human-readable `summary` field used to be free-form
    LLM prose. We now build it from the counts deterministically — less
    flowery, more honest, and the user can read the matrix below for
    detail. No turn is logged because no LLM call ran.
    """
    from .prompt import _build_coverage_matrix

    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    seed = dataset["seed_snapshot"]
    examples = await db.get_examples(dataset_id)
    stats = await db.update_dataset_stats(dataset_id)

    coverage_criteria = list(seed.get("coverage", {}).get("criteria") or [])
    feature_areas = [
        a.get("feature_area", "")
        for a in (seed.get("alignment") or [])
        if isinstance(a, dict) and a.get("feature_area")
    ]
    matrix = _build_coverage_matrix(seed, examples)

    coverage_gaps = [
        c for c in coverage_criteria
        if sum((matrix.get(c) or {}).values()) == 0
    ]
    feature_area_gaps: list[str] = []
    for fa in feature_areas:
        total = sum(
            (matrix.get(c) or {}).get(fa, 0) for c in coverage_criteria
        )
        if total == 0:
            feature_area_gaps.append(fa)

    # `label_gaps`: per (feature_area, label) pair, does at least one
    # non-rejected example exist? Computed from the raw examples since
    # the matrix only carries totals, not label splits.
    by_fa_label: dict[str, set[str]] = {}
    for ex in examples:
        if ex.get("review_status") == "rejected":
            continue
        fa = ex.get("feature_area")
        lbl = ex.get("label")
        if not isinstance(fa, str) or fa not in feature_areas:
            continue
        if not isinstance(lbl, str):
            continue
        by_fa_label.setdefault(fa, set()).add(lbl)
    label_gaps: list[dict[str, str]] = []
    for fa in feature_areas:
        labels_present = by_fa_label.get(fa, set())
        if "good" not in labels_present:
            label_gaps.append({"feature_area": fa, "missing": "good"})
        if "bad" not in labels_present:
            label_gaps.append({"feature_area": fa, "missing": "bad"})

    # `balance_issues` is hard to derive purely structurally — it's
    # really "is the distribution close to what the seed's balance
    # criteria asked for?". Without the LLM we don't have a free-text
    # interpreter, so leave it empty rather than fabricate. The summary
    # below covers the high-level signal.
    balance_issues: list[str] = []

    total_examples = stats.get("total", len(examples)) if isinstance(stats, dict) else len(examples)
    parts: list[str] = [f"{total_examples} examples"]
    if coverage_criteria:
        parts.append(
            f"{len(coverage_criteria) - len(coverage_gaps)}/{len(coverage_criteria)} coverage criteria covered"
        )
    if feature_areas:
        parts.append(
            f"{len(feature_areas) - len(feature_area_gaps)}/{len(feature_areas)} feature areas covered"
        )
    if label_gaps:
        parts.append(f"{len(label_gaps)} feature-area × label slots missing")
    summary = "; ".join(parts) + "."

    return {
        "coverage_gaps": coverage_gaps,
        "feature_area_gaps": feature_area_gaps,
        "balance_issues": balance_issues,
        "label_gaps": label_gaps,
        "coverage_matrix": matrix,
        "summary": summary,
    }


@app.get("/datasets/{dataset_id}/judge-agreement")
async def judge_agreement(
    dataset_id: str,
    _quota: None = Depends(enforce_quota),
):
    """Cohen's kappa + raw agreement between the judge's suggested_label and
    the reviewer's final label, over rows the human has actually reviewed.

    Returns ``not_enough_data: True`` (with the running counts) when fewer
    than 10 reviewed rows carry a judge suggestion — kappa is noisy below
    that. Frontend renders the metric with a warning color when agreement
    drops below 80% or kappa falls under 0.6 with >=20 rows.
    """
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    examples = await db.get_examples(dataset_id)
    pairs: list[tuple[str, str]] = []
    for ex in examples:
        # "Reviewed" = the human took an action other than leaving it pending.
        # Approved, rejected, and needs_edit all carry a settled label.
        if ex.get("review_status") == "pending":
            continue
        verdict = ex.get("judge_verdict") or {}
        # Triggered-mode rows surface the model's suggestion under
        # execution_verdict instead of at the top level. Both paths land
        # in the same comparison.
        suggested = verdict.get("suggested_label")
        if suggested is None:
            exec_v = verdict.get("execution_verdict") or {}
            suggested = exec_v.get("suggested_label")
        label = ex.get("label")
        if suggested in ("good", "bad") and label in ("good", "bad"):
            pairs.append((str(suggested), str(label)))

    reviewed_count = len(pairs)
    agreement_count = sum(1 for s, lab in pairs if s == lab)
    agreement_rate = (agreement_count / reviewed_count) if reviewed_count else 0.0

    # Cohen's kappa over the 2x2 confusion matrix. Tiny by hand:
    #   po = observed agreement (agreement_rate)
    #   pe = expected agreement by chance, from each rater's marginal
    #   kappa = (po - pe) / (1 - pe)
    #
    # `pe` is always computable. It only reaches 1.0 — the one value that
    # makes the formula undefined — when BOTH raters are unanimous on the
    # SAME label; in that case they agree on every row, so kappa is 1.0 by
    # convention. Every other case (including "one rater unanimous, the
    # other not") has a well-defined kappa, so compute it directly rather
    # than discarding it.
    kappa: float | None = None
    if reviewed_count >= 2:
        n = reviewed_count
        s_good = sum(1 for s, _ in pairs if s == "good")
        l_good = sum(1 for _, lab in pairs if lab == "good")
        pe = (s_good / n) * (l_good / n) + ((n - s_good) / n) * ((n - l_good) / n)
        if pe >= 1.0:
            # Both raters unanimous + same side → perfect agreement.
            kappa = 1.0 if agreement_rate == 1.0 else None
        else:
            kappa = (agreement_rate - pe) / (1.0 - pe)

    return {
        "reviewed_count": reviewed_count,
        "agreement_count": agreement_count,
        "agreement_rate": agreement_rate,
        "kappa": kappa,
        "not_enough_data": reviewed_count < 10,
    }



@app.post("/datasets/{dataset_id}/enrich")
async def enrich_dataset(
    dataset_id: str,
    req: EnrichRequest,
    access: Access = Depends(resolve_dataset_access),
    _quota: None = Depends(enforce_quota),
):
    """Generate examples to fill identified gaps."""
    require_writer(access)
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    seed = dataset["seed_snapshot"]

    if req.gap_type == "coverage":
        generated, call_meta = await call_synthesize_examples(
            seed, coverage_criteria=req.targets, count=req.count,
        )
    elif req.gap_type in ("feature_area", "label"):
        generated, call_meta = await call_synthesize_examples(
            seed, feature_areas=req.targets, count=req.count,
        )
    else:
        raise HTTPException(status_code=400, detail=f"Unknown gap type: {req.gap_type}")

    unmapped = _normalize_synthesized_feature_areas(generated, seed)
    if unmapped:
        logger.warning(
            "enrich (%s): %d/%d rows had out-of-range feature_area, snapped to %r",
            req.gap_type, unmapped, len(generated), UNMAPPED_FEATURE_AREA,
        )
    tag_snapped, tag_unmapped = _normalize_synthesized_coverage_tags(generated, seed)
    if tag_snapped or tag_unmapped:
        logger.info(
            "enrich (%s): coverage_tag snap — %d paraphrases canonicalized, "
            "%d tags left as-is (not in seed)",
            req.gap_type, tag_snapped, tag_unmapped,
        )

    for ex in generated:
        ex["source"] = "synthetic"

    created = await db.bulk_create_examples(dataset_id, generated)

    await db.create_turn(
        session_id=dataset["session_id"],
        turn_type="enrich",
        input_snapshot={"seed": seed, "gap_type": req.gap_type, "targets": req.targets},
        llm_calls=call_meta,
        parsed_output={"examples_generated": len(created)},
    )

    stats = await db.update_dataset_stats(dataset_id)
    return {"generated": len(created), "examples": created, "stats": stats}


@app.post("/datasets/{dataset_id}/chat")
async def dataset_chat(
    dataset_id: str,
    req: SendMessageRequest,
    access: Access = Depends(resolve_dataset_access),
    _quota: None = Depends(enforce_quota),
):
    """Chat with the agent in dataset phase."""
    require_writer(access)
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


class PolarisConfirmPayload(BaseModel):
    """Structured confirmation of a previously-proposed tool call.

    When a confirm-tier tool returns a proposal envelope, the frontend renders
    a chip; clicking the chip POSTs `confirm: { tool, args }` and the backend
    re-dispatches the tool with `confirmed=True` directly — no second model
    round-trip, no English re-issue that could be misparsed or spoofed.
    """
    tool: str
    args: dict = {}


class PolarisChatRequest(BaseModel):
    """Polaris chat request — global, tool-using assistant.

    `context` is what the frontend knows about the user's current view; the
    agent reads it from the system prompt rather than calling tools to find
    out. `session_id` and `dataset_id` inside `context` are the only routing
    info — there is no path parameter, because Polaris isn't bound to a
    project (you can talk to it from the home page).

    `confirm` is the structured shortcut for a previously-proposed action.
    When present, the model is skipped entirely; the named tool runs once
    with `confirmed=True` and the result is returned directly.
    """
    message: str = ""
    context: dict = {}
    confirm: PolarisConfirmPayload | None = None


@app.post(
    "/polaris/chat",
    dependencies=[
        Depends(feature_flags.require_polaris_enabled),
        Depends(enforce_quota),
    ],
)
async def polaris_chat(req: PolarisChatRequest):
    """Run one Polaris turn — or one direct confirm if `confirm` is set.

    Returns:
        {message, tool_calls, tool_summary, proposals, navs, state?}

    `state` is included only when a session_id is in context — the frontend
    needs it to refresh the workspace after writes that touched session state.
    """
    ctx = req.context or {}
    session_id = ctx.get("session_id")

    # Direct-confirm path: bypass the model loop entirely. Same registry, same
    # tier semantics, but no English instruction the model could misread.
    if req.confirm is not None:
        from . import polaris_tools
        tool_ctx = polaris_tools.ToolCtx(
            session_id=session_id,
            dataset_id=ctx.get("dataset_id"),
            selected_example_id=ctx.get("selected_example_id"),
            route=ctx.get("route"),
            phase=ctx.get("phase"),
        )
        args = {**req.confirm.args, "confirmed": True}
        result = await polaris_tools.dispatch(req.confirm.tool, tool_ctx, args)
        tier = polaris_tools.get_tier(req.confirm.tool) or "auto"
        is_nav = isinstance(result, dict) and result.get("_nav")
        is_proposal = isinstance(result, dict) and result.get("_proposal")
        summary = [{
            "name": req.confirm.tool,
            "args": req.confirm.args,
            "tier": tier,
            "ok": isinstance(result, dict) and bool(result.get("ok")),
            **({"error": result["error"]} if isinstance(result, dict) and "error" in result else {}),
            **({"nav": result.get("target")} if is_nav else {}),
            **({"proposal": True} if is_proposal else {}),
        }]
        navs = []
        if is_nav:
            navs.append({"target": result.get("target"), "props": result.get("props") or {}})
        out: dict = {
            "message": "",
            "tool_calls": [{"name": req.confirm.tool, "args": args, "result": result}],
            "tool_summary": summary,
            "proposals": [],
            "navs": navs,
        }
        # Re-load + return state so the workspace refreshes.
        if session_id:
            try:
                state, _conv = await _load_state(session_id)
                out["state"] = state.model_dump()
            except HTTPException:
                pass
        return out

    state = None
    if session_id:
        try:
            state, _conv = await _load_state(session_id)
        except HTTPException:
            # Session pointed to in context disappeared — chat continues
            # statelessly rather than 404'ing the whole conversation.
            state = None

    result = await run_polaris_chat(state, req.message, ctx)

    if state is not None and session_id:
        await _save_state(session_id, state, state.input.conversation_history)
        result["state"] = state.model_dump()

    return result


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

    seed = dataset.get("seed_snapshot", {}) or {}
    task = seed.get("task", {}) or {}

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
        judge_model_used=run.get("judge_model_used"),
        seed_snapshot=run.get("seed_snapshot"),
        improvement_suggestions=run.get("improvement_suggestions"),
        improvement_summary=run.get("improvement_summary"),
        notes_updated_at=run.get("notes_updated_at"),
        clusters=run.get("clusters"),
        clusters_generated_at=run.get("clusters_generated_at"),
    )


# Active eval-run tasks keyed by run_id. Lets the /cancel endpoint flip the
# DB row to 'cancelled' so the post-run write doesn't clobber the status.
# Memory-only — restart wipes it; the DB row still wins. The underlying
# Braintrust call runs in a thread we can't kill mid-flight, so this is a
# UI-level cancellation, not a process-level one (the thread finishes in
# the background but its results are dropped).
_ACTIVE_EVAL_TASKS: dict[str, "asyncio.Task"] = {}


async def _execute_eval_run(
    run_id: str,
    skill_body: str,
    scorer_defs: list[dict],
    examples: list[dict],
    braintrust_key: str,
    anthropic_key: str | None,
    req: RunEvalRequest,
    prompt_target: str | None = None,
    prompt_body_template: str | None = None,
) -> None:
    """Background task: runs the blocking eval off the event loop.

    All status transitions + results are written to the eval_runs DB row so
    the UI sees them on the next poll, and history survives process restarts.
    """
    from datetime import datetime, timezone
    from .eval_runner import DEFAULT_JUDGE_MODEL, DEFAULT_MODEL

    async def _was_cancelled() -> bool:
        """Returns True if the user clicked Stop while we were running. Read
        from the DB so we don't have to trust the in-memory task registry."""
        row = await db.get_eval_run(run_id)
        return bool(row and row.get("status") == "cancelled")

    await db.update_eval_run(run_id, {
        "status": "running",
        "started_at": datetime.now(timezone.utc),
    })

    try:
        from .agent_task import MAX_ITERATIONS_DEFAULT
        # Use the run_id as the sandbox subfolder so concurrent runs from the
        # same experiment_name never trample each other.
        from .agent_task import default_sandbox_root
        sandbox_root = default_sandbox_root(run_id) if req.agent_mode else None
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
            prompt_target=prompt_target,
            prompt_body_template=prompt_body_template,
            agent_mode=req.agent_mode,
            allow_bash=req.allow_bash,
            max_iterations=req.max_iterations or MAX_ITERATIONS_DEFAULT,
            sandbox_root=sandbox_root,
        )
        # Braintrust returns Done even when every row's task threw — auth
        # errors against Anthropic, rate limits, etc. Surface that as 'failed'
        # so the UI shows a red banner instead of a misleading "Done. 0/N rows
        # evaluated." Partial failures stay 'done' (the user still gets useful
        # signal from the rows that succeeded).
        errored_rows = sum(1 for r in result.per_row if r.get("error"))
        total_rows = len(result.per_row)
        first_error = next((r.get("error") for r in result.per_row if r.get("error")), None)
        if total_rows > 0 and errored_rows == total_rows:
            status = "failed"
            error_msg = (
                f"All {total_rows} rows errored. First error: {first_error}"
                if first_error
                else f"All {total_rows} rows errored."
            )
        else:
            status = "done"
            error_msg = (
                f"{errored_rows} of {total_rows} rows errored. First error: {first_error}"
                if errored_rows and first_error
                else None
            )
        # If the user hit Stop, don't overwrite the cancelled status with
        # done/failed — the eval thread couldn't be killed but its results
        # are no longer wanted by the user.
        if await _was_cancelled():
            return
        await db.update_eval_run(run_id, {
            "status": status,
            "error": error_msg,
            "finished_at": datetime.now(timezone.utc),
            "experiment_url": result.experiment_url,
            "experiment_name": result.experiment_name,
            "rows_evaluated": result.rows_evaluated,
            "scorer_names": result.scorer_names,
            "scorer_averages": result.scorer_averages,
            "per_row": result.per_row,
        })
        # Clear the "new" tag from rows that participated in this run. Pull
        # the row IDs straight from the eval result's per_row metadata so a
        # concurrent /refresh-from-turns inserting fresh "new"-tagged rows
        # mid-cleanup can't have its rows stripped — only rows we actually
        # evaluated lose the tag. Done in a single SQL statement → atomic.
        try:
            evaluated_ids: list[str] = []
            for r in result.per_row:
                meta = r.get("metadata") or {}
                rid = meta.get("id")
                if isinstance(rid, str):
                    evaluated_ids.append(rid)
            if evaluated_ids:
                await db.clear_new_tag_from_examples(evaluated_ids)
        except Exception:  # noqa: BLE001
            logger.exception("Failed to clear 'new' tags after eval run %s", run_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("Eval run %s failed", run_id)
        if not await _was_cancelled():
            await db.update_eval_run(run_id, {
                "status": "error",
                "error": str(e),
                "finished_at": datetime.now(timezone.utc),
            })
    finally:
        _ACTIVE_EVAL_TASKS.pop(run_id, None)


@app.post("/sessions/{session_id}/run-eval", response_model=EvalRunSummary)
async def run_eval_for_session(
    session_id: str,
    req: RunEvalRequest,
    request: Request,
    access: Access = Depends(resolve_access),
    _quota: None = Depends(enforce_quota),
):
    """Trigger a Braintrust eval run for this session's dataset + scorers + skill.

    Braintrust API key is read from the X-Braintrust-Key header. Anthropic key
    from X-Anthropic-Key (same pattern as other endpoints). Runs asynchronously
    in a background task; poll GET /sessions/{id}/eval-runs/{run_id} for status.
    """
    require_writer(access)
    import uuid as _uuid

    braintrust_key = request.headers.get("x-braintrust-key") or os.environ.get("BRAINTRUST_API_KEY")
    if not braintrust_key:
        raise HTTPException(
            status_code=400,
            detail="Braintrust API key required. Add it in Settings or send X-Braintrust-Key header.",
        )

    state, conversation = await _load_state(session_id)
    is_prompt_eval = state.kind == SessionKind.prompt
    skill_body = state.seed.task.skill_body or ""
    if not is_prompt_eval and not skill_body.strip():
        raise HTTPException(
            status_code=400,
            detail="Session has no skill_body on its seed. Seed from a SKILL.md first.",
        )

    # Drop scorers the user has toggled off in the UI. ``enabled`` is an
    # opt-out: missing or true → run, explicit false → skip. Lets the user
    # focus an eval on a subset of scorers without deleting the rest.
    scorer_defs = [
        s for s in (state.scorers or [])
        if s.get("enabled", True) is not False
    ]
    # Backfill target_tag on the in-memory copy for sessions whose scorers
    # were generated before the gating field existed (or whose LLM dropped
    # it). Pure slug match against the seed — no LLM. Mutates the local
    # copy only; the persisted scorers stay as-is until the user
    # regenerates, so this is safe to run on every eval.
    _ensure_scorer_target_tags(scorer_defs, state.seed.model_dump())
    if not scorer_defs:
        total = len(state.scorers or [])
        if total == 0:
            raise HTTPException(
                status_code=400,
                detail="No scorers on this session. Generate them in the Scorers tab first.",
            )
        raise HTTPException(
            status_code=400,
            detail=f"All {total} scorers are disabled. Enable at least one before running an eval.",
        )

    dataset = await db.get_dataset_by_session(session_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="No dataset for this session.")

    examples = await db.get_examples(dataset["id"])
    if not examples:
        raise HTTPException(status_code=400, detail="Dataset is empty.")

    anthropic_key = request.headers.get("x-anthropic-key") or None

    # Tag the run with whatever SKILL.md version is *actually* being
    # evaluated. When a candidate exists, seed.task.skill_body mirrors
    # the candidate (set when the candidate was created), and the eval
    # below sends that exact body to Braintrust — so the run's
    # skill_version_id has to be the candidate's id, not the active's.
    # Otherwise the Skill version timeline shows "no run" on the candidate
    # row (because no run is tagged with its id) and the Promote/Discard
    # banner never fires (it keys off skill_version_id == candidateId).
    # Skipped entirely for prompt-eval projects — no SKILL.md is involved.
    eval_ver_id: str | None = None
    eval_ver_num: int | None = None
    if not is_prompt_eval:
        eval_ver_id = state.candidate_skill_version_id or state.active_skill_version_id
        if not state.skill_versions:
            record = _append_skill_version(
                state,
                body=skill_body,
                created_from="import",
                notes="Backfilled v1 from existing SKILL.md body.",
            )
            eval_ver_id = record["id"]
            eval_ver_num = record["version"]
            await _save_state(session_id, state, conversation)
        else:
            for v in state.skill_versions:
                if v.get("id") == eval_ver_id:
                    eval_ver_num = v.get("version")
                    break

    # Resolve the judge model now (rather than only inside _execute_eval_run)
    # so we can persist it on the run row and the UI can show "ran with X" in
    # history. Falls back to the env-var default when the request didn't pin one.
    from .eval_runner import DEFAULT_JUDGE_MODEL as _DEFAULT_JUDGE
    judge_model_resolved = req.judge_model or _DEFAULT_JUDGE

    run_id = str(_uuid.uuid4())
    run_row = await db.create_eval_run(
        run_id=run_id,
        session_id=session_id,
        project=req.project,
        experiment_name=req.experiment_name,
        rows_total=len(examples),
        skill_version_id=eval_ver_id,
        skill_version_number=eval_ver_num,
        seed_snapshot=state.seed.model_dump(),
        judge_model_used=judge_model_resolved,
    )

    eval_task = asyncio.create_task(
        _execute_eval_run(
            run_id=run_id,
            skill_body=skill_body,
            scorer_defs=scorer_defs,
            examples=examples,
            braintrust_key=braintrust_key,
            anthropic_key=anthropic_key,
            req=req,
            prompt_target=state.prompt_target if is_prompt_eval else None,
            # For prompt-eval: feed the session's active skill_body to the
            # task as the prompt template. This is the user's in-app version
            # — possibly edited/restored from version history. The eval task
            # substitutes row snapshots into placeholders, so per-version
            # iteration in-app drives what scores.
            prompt_body_template=skill_body if is_prompt_eval else None,
        )
    )
    _ACTIVE_EVAL_TASKS[run_id] = eval_task

    return _eval_run_to_summary(run_row)


@app.post("/sessions/{session_id}/eval-runs/{run_id}/cancel", response_model=EvalRunSummary)
async def cancel_eval_run(
    session_id: str,
    run_id: str,
    access: Access = Depends(resolve_access),
):
    """Cancel a running eval. Marks the DB row as 'cancelled' so the
    background task's post-run write is skipped, and the polling UI sees
    the terminal state on the next tick. The Braintrust thread in the pool
    can't be killed mid-call — it finishes in the background but its
    results are dropped. Idempotent: cancelling an already-terminal run
    just returns its current state."""
    require_writer(access)
    from datetime import datetime, timezone
    run = await db.get_eval_run(run_id)
    if run is None or run.get("session_id") != session_id:
        raise HTTPException(status_code=404, detail="Eval run not found")
    if run.get("status") in ("done", "failed", "error", "cancelled"):
        return _eval_run_to_summary(run)
    await db.update_eval_run(run_id, {
        "status": "cancelled",
        "error": "Run cancelled by user.",
        "finished_at": datetime.now(timezone.utc),
    })
    task = _ACTIVE_EVAL_TASKS.pop(run_id, None)
    if task is not None:
        task.cancel()
    fresh = await db.get_eval_run(run_id)
    return _eval_run_to_summary(fresh or run)


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


@app.patch(
    "/sessions/{session_id}/eval-runs/{run_id}/rows/{example_id}/note",
    response_model=EvalRunSummary,
)
async def set_eval_run_row_note_endpoint(
    session_id: str,
    run_id: str,
    example_id: str,
    req: SetEvalRunRowNoteRequest,
    access: Access = Depends(resolve_access),
):
    """Attach (or clear) a free-text note to a single per-row result.

    The note is the first half of the failure-analysis flow: the user marks
    rows as they review them ("over-triggers on greeting", "ignored
    off-target marker"), and a later analyze step (Phase 2) clusters those
    notes into named buckets that feed the improve prompt.

    Rows are addressed by example_id (== examples.id from the dataset),
    which is stable across run-to-run resorts and survives reordering of
    the per_row JSONB array.
    """
    require_writer(access)
    run = await db.get_eval_run(run_id)
    if run is None or run.get("session_id") != session_id:
        raise HTTPException(status_code=404, detail="Eval run not found")
    updated = await db.set_eval_run_row_note(run_id, example_id, req.note)
    if updated is None:
        # Either the run vanished between the two reads (TOCTOU — rare) or
        # the example_id doesn't appear in this run's per_row. Same 404
        # response either way; the client just heard "no such row."
        raise HTTPException(
            status_code=404,
            detail="Row not found in this eval run",
        )
    return _eval_run_to_summary(updated)


# --- Skill version endpoints (Path A: iterate SKILL.md from eval failures) ---

@app.get("/sessions/{session_id}/skill-versions", response_model=list[SkillVersion])
async def list_skill_versions(session_id: str):
    """List all skill versions for this session (newest first)."""
    state, _ = await _load_state(session_id)
    versions = list(state.skill_versions)
    versions.sort(key=lambda v: v.get("version", 0), reverse=True)
    return [SkillVersion(**v) for v in versions]


@app.post("/sessions/{session_id}/skill-versions", response_model=SkillVersion)
async def create_skill_version(
    session_id: str,
    req: CreateSkillVersionRequest,
    access: Access = Depends(resolve_access),
):
    """Create a new SKILL.md version.

    Suggestion-derived versions land as candidates (must be promoted after a
    confirming eval) so a regressing batch of edits doesn't silently become
    the new active. Manual edits and other sources promote immediately —
    they're explicit user-typed changes, not LLM proposals to validate.

    Either way, seed.task.skill_body updates so subsequent evals use the
    new body and the user can re-run on the candidate before committing.
    """
    require_writer(access)
    state, conversation = await _load_state(session_id)

    # If this is the first version on a legacy session, backfill v1 from the
    # current body so the new one doesn't land as v1 with history missing.
    if not state.skill_versions and (state.seed.task.skill_body or "").strip():
        _append_skill_version(
            state,
            body=state.seed.task.skill_body or "",
            created_from="import",
            notes="Backfilled v1 from existing SKILL.md body.",
        )

    created_from = req.created_from or "manual"
    as_candidate = created_from == "suggestion"
    record = _append_skill_version(
        state,
        body=req.body,
        created_from=created_from,
        notes=req.notes,
        applied_suggestion_ids=req.applied_suggestion_ids,
        as_candidate=as_candidate,
    )
    state.seed.task.skill_body = req.body
    await _save_state(session_id, state, conversation)
    return SkillVersion(**record)


@app.post("/sessions/{session_id}/skill-versions/{version_id}/promote", response_model=SkillVersion)
async def promote_skill_version(
    session_id: str,
    version_id: str,
    access: Access = Depends(resolve_access),
):
    """Promote a candidate version to active.

    Strict pairing with discard: only the *current* candidate can be promoted.
    Without this guard, a stale UI (or any caller hitting the URL) could flip
    an arbitrary historical version to active, silently orphaning the real
    candidate (its pointer would clear on promote even though the user never
    confirmed it). To restore an older non-candidate version, use
    /skill-versions/restore — that's the dedicated affordance."""
    require_writer(access)
    state, conversation = await _load_state(session_id)
    if state.candidate_skill_version_id != version_id:
        raise HTTPException(
            status_code=400,
            detail="That version isn't the current candidate. Use /skill-versions/restore to revive an older version.",
        )
    target = next((v for v in state.skill_versions if v.get("id") == version_id), None)
    if target is None:
        # Belt-and-braces — pointer says it's the candidate but the version
        # row is gone. Shouldn't happen, but don't 500 if it does.
        raise HTTPException(status_code=404, detail="Skill version not found")
    state.active_skill_version_id = version_id
    state.candidate_skill_version_id = None
    state.seed.task.skill_body = target["body"]
    await _save_state(session_id, state, conversation)
    return SkillVersion(**target)


@app.post("/sessions/{session_id}/skill-versions/{version_id}/discard", response_model=SkillVersion)
async def discard_skill_version(
    session_id: str,
    version_id: str,
    access: Access = Depends(resolve_access),
):
    """Discard a candidate. Reverts skill_body to the active version's body
    and clears the candidate pointer. The discarded version stays in history
    (the user can still review or restore it from the timeline) but stops
    being the body the next eval runs against."""
    require_writer(access)
    state, conversation = await _load_state(session_id)
    if state.candidate_skill_version_id != version_id:
        raise HTTPException(status_code=400, detail="That version isn't the current candidate.")
    target = next((v for v in state.skill_versions if v.get("id") == version_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Skill version not found")
    active = next(
        (v for v in state.skill_versions if v.get("id") == state.active_skill_version_id),
        None,
    )
    if active is not None:
        state.seed.task.skill_body = active["body"]
    state.candidate_skill_version_id = None
    await _save_state(session_id, state, conversation)
    return SkillVersion(**target)


@app.post("/sessions/{session_id}/skill-versions/restore", response_model=SkillVersion)
async def restore_skill_version(
    session_id: str,
    req: RestoreSkillVersionRequest,
    access: Access = Depends(resolve_access),
):
    """Restore a previous version. Appends a new SkillVersion row with
    created_from='restore' so the history reads 'v4 — restored from v2',
    rather than silently flipping the active pointer (which left v3's edits
    looking lost). The new row's body is identical to the target's body, but
    its `notes` field carries the lineage so the UI can render an arrow back
    to the source version.

    Refuses to run while a candidate is pending — restore would otherwise
    silently clear the candidate (since `_append_skill_version` resets the
    pointer when not as_candidate), making the user's in-flight edits
    unreachable. The user has to explicitly promote or discard first.
    """
    require_writer(access)
    state, conversation = await _load_state(session_id)
    if state.candidate_skill_version_id is not None:
        raise HTTPException(
            status_code=409,
            detail="A candidate version is pending. Promote or discard it before restoring an older version.",
        )
    target = next((v for v in state.skill_versions if v.get("id") == req.version_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Skill version not found")

    new_record = _append_skill_version(
        state,
        body=target["body"],
        created_from="restore",
        notes=f"Restored from v{target.get('version')}",
    )
    state.seed.task.skill_body = target["body"]
    await _save_state(session_id, state, conversation)
    return SkillVersion(**new_record)


@app.post(
    "/sessions/{session_id}/suggest-improvements",
    response_model=SuggestImprovementsResponse,
)
async def suggest_skill_improvements(
    session_id: str,
    req: SuggestImprovementsRequest,
    access: Access = Depends(resolve_access),
    _quota: None = Depends(enforce_quota),
):
    """Analyze a completed eval run and propose targeted SKILL.md edits.

    Two-step internally when the user has written per-row notes:
      1. Cluster the notes into named failure-mode buckets (cached on the
         eval_run as `clusters`).
      2. Pass those clusters into the suggest-improvements prompt so each
         suggestion can target a specific bucket via `target_label`.

    When no notes exist, step 1 is skipped and the suggest-improvements
    prompt sees the raw failing rows the way it always has.

    Failures from step 1 surface to the caller — we don't silently fall
    back to "improve without clusters" because the user clicked Analyze
    expecting the cluster taxonomy to drive the suggestions.
    """
    require_writer(access)
    from datetime import datetime, timezone
    from .tools import call_cluster_notes, call_suggest_improvements

    run = await db.get_eval_run(req.run_id)
    if run is None or run.get("session_id") != session_id:
        raise HTTPException(status_code=404, detail="Eval run not found")
    # Allow both 'done' (the happy path) and 'failed' (every row errored —
    # the prompt now handles the all-errored case and proposes defensive
    # SKILL.md edits, e.g. "ensure output is JSON only"). 'pending' /
    # 'running' / 'error' (run never started) still 400.
    if run.get("status") not in ("done", "failed"):
        raise HTTPException(
            status_code=400,
            detail=f"Eval run must be completed (current status: {run.get('status')}).",
        )

    state, _ = await _load_state(session_id)
    skill_body = state.seed.task.skill_body or ""
    if not skill_body.strip():
        raise HTTPException(status_code=400, detail="Session has no active SKILL.md to improve.")

    # ---- Step 1: cluster notes (only if any rows have notes) -----------
    notes_input: list[dict] = []
    for row in run.get("per_row", []) or []:
        if not isinstance(row, dict):
            continue
        note = row.get("note")
        if not isinstance(note, str) or not note.strip():
            continue
        meta = row.get("metadata") or {}
        row_id = meta.get("id") if isinstance(meta, dict) else None
        if not isinstance(row_id, str):
            continue
        notes_input.append({"row_id": row_id, "note": note.strip()})

    clusters: list[dict] | None = None
    clusters_generated_at = None
    if notes_input:
        # Seed clustering with the previous run's labels (same session +
        # project) so a recurring failure mode keeps its name across runs.
        # The prompt explicitly permits new labels, so genuinely new modes
        # still surface cleanly — this just prevents gratuitous renames.
        prior_labels: list[str] | None = None
        prior_run = await db.get_previous_clustered_run(
            session_id=session_id,
            project=run.get("project", ""),
            excluding_run_id=req.run_id,
        )
        if prior_run is not None:
            raw_prior = prior_run.get("clusters") or []
            seen = set()
            collected: list[str] = []
            for c in raw_prior:
                if not isinstance(c, dict):
                    continue
                lbl = c.get("label")
                if isinstance(lbl, str) and lbl and lbl not in seen:
                    seen.add(lbl)
                    collected.append(lbl)
            prior_labels = collected or None
        try:
            cluster_data, cluster_meta = await call_cluster_notes(notes_input, prior_labels)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail=f"Clustering notes failed: {e}",
            ) from e
        raw_clusters = cluster_data.get("clusters") or []
        # Normalize: keep only well-formed entries. The prompt may emit
        # row_ids that aren't in the input (hallucination); we accept those
        # since the UI only uses row_ids for cross-run delta queries
        # (Phase 3) and treats any missing ones as a no-op.
        clusters = []
        for c in raw_clusters:
            if not isinstance(c, dict):
                continue
            label = c.get("label")
            row_ids = c.get("row_ids") or []
            if not isinstance(label, str) or not label.strip():
                continue
            if not isinstance(row_ids, list):
                row_ids = []
            clusters.append({
                "label": label.strip(),
                "count": len([r for r in row_ids if isinstance(r, str)]) or int(c.get("count") or 0),
                "row_ids": [r for r in row_ids if isinstance(r, str)],
            })
        clusters_generated_at = datetime.now(timezone.utc)
        await db.create_turn(
            session_id=session_id,
            turn_type="cluster_notes",
            input_snapshot={
                "run_id": req.run_id,
                "notes": notes_input,
                "prior_labels": prior_labels or [],
                "prior_run_id": prior_run.get("id") if prior_run else None,
            },
            llm_calls=cluster_meta,
            parsed_output={"clusters": clusters},
        )
        await db.update_eval_run(req.run_id, {
            "clusters": clusters,
            "clusters_generated_at": clusters_generated_at,
        })

    # ---- Step 2: improve prompt (cluster-aware when clusters exist) ----
    # Reload run so the suggest-improvements prompt sees the freshly cached
    # clusters (the prompt itself only reads from its `clusters` arg, but
    # the persisted state needs to be consistent if step 2 fails).
    run_after_cluster = await db.get_eval_run(req.run_id) or run

    data, call_meta = await call_suggest_improvements(
        skill_body,
        run_after_cluster,
        state.seed.model_dump(),
        clusters,
    )

    await db.create_turn(
        session_id=session_id,
        turn_type="suggest_improvements",
        input_snapshot={
            "run_id": req.run_id,
            "skill_version_id": run.get("skill_version_id"),
            "cluster_count": len(clusters) if clusters else 0,
        },
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
        clusters=clusters,
        clusters_generated_at=clusters_generated_at,
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
async def detect_schema(
    session_id: str,
    req: DetectSchemaRequest,
    access: Access = Depends(resolve_access),
    _quota: None = Depends(enforce_quota),
):
    """Detect schema from pasted sample data."""
    require_writer(access)
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
async def import_from_url(
    session_id: str,
    req: ImportFromUrlRequest,
    access: Access = Depends(resolve_access),
    _quota: None = Depends(enforce_quota),
):
    """Import schema from a URL (JSON data, OpenAPI spec, or docs)."""
    require_writer(access)
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
    body and source metadata the frontend can hand back to `skill-import`.

    Strategy:
      * No token → fetch the raw file via raw.githubusercontent.com. CDN-
        served, no per-IP rate limit, works fine for public repos. blob_sha
        is left empty; Phase-3 PR work will re-resolve via the API once the
        user adds a token.
      * Token present → use the GitHub REST API so we can read private repos
        and capture the blob `sha` (needed for conditional updates later).
    """
    import httpx

    owner, repo, ref, path = _parse_github_url(req.url)
    token = request.headers.get("x-github-token") or os.environ.get("GITHUB_TOKEN")

    if token:
        # Authenticated path — REST API gives us the blob sha + works for
        # private repos.
        api_url = f"https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={ref}"
        headers = {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "northstar-skill-fetch",
            "Authorization": f"Bearer {token}",
        }
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(api_url, headers=headers, follow_redirects=True)
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"GitHub fetch failed: {e}")

        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail="File not found on GitHub (check owner/repo/branch/path).")
        if resp.status_code in (401, 403):
            raise HTTPException(
                status_code=resp.status_code,
                detail="GitHub rejected the token. Check that it has `contents: read` on this repo.",
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
                raw_text = base64.b64decode(raw_content).decode("utf-8")
            except Exception as e:  # noqa: BLE001
                raise HTTPException(status_code=400, detail=f"Failed to decode file contents: {e}")
        else:
            raw_text = raw_content
        blob_sha = data.get("sha", "")
    else:
        # Public path — raw.githubusercontent.com isn't subject to the 60/hr
        # API rate limit that the deployed backend was hitting from a shared
        # IP. blob_sha stays empty; we'll resolve it later if a PR flow ever
        # needs it.
        raw_url = f"https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}"
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(
                    raw_url,
                    headers={"User-Agent": "northstar-skill-fetch"},
                    follow_redirects=True,
                )
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"GitHub fetch failed: {e}")

        if resp.status_code == 404:
            raise HTTPException(
                status_code=404,
                detail="File not found on GitHub (check owner/repo/branch/path), or the repo is private — add a GitHub token in Settings.",
            )
        if resp.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"GitHub returned {resp.status_code}: {resp.text[:200]}")
        if len(resp.content) > _SKILL_MAX_BYTES:
            raise HTTPException(status_code=400, detail="File too large to be a SKILL.md.")
        raw_text = resp.text
        blob_sha = ""

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
            blob_sha=blob_sha,
        ),
    )


@app.post("/datasets/{dataset_id}/infer-schema", response_model=InferSchemaResponse)
async def infer_schema_from_examples(
    dataset_id: str,
    access: Access = Depends(resolve_dataset_access),
    _quota: None = Depends(enforce_quota),
):
    """Infer schema from existing dataset examples."""
    require_writer(access)
    dataset = await db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    examples = await db.get_examples(dataset_id)
    if len(examples) < 3:
        raise HTTPException(
            status_code=400,
            detail=f"Need at least 3 examples to infer schema (have {len(examples)})"
        )

    seed = dataset["seed_snapshot"]

    # Prepare examples for inference (just input/output)
    examples_for_inference = [
        {"input": ex["input"], "expected_output": ex["expected_output"], "feature_area": ex["feature_area"]}
        for ex in examples
    ]

    result, call_meta = await call_infer_schema(examples_for_inference, seed)

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
