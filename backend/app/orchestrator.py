"""PRD orchestrator — the "Build feature" button.

One textbox -> chained build: skill -> seed -> dataset -> scorers -> evaluate.
Streams progress as Server-Sent Events so the UI can show what's happening
at every step (no opaque spinners — see "Always show what's happening" in
the build context).

This module is intentionally self-contained:

  - Exposes a single `APIRouter` (`router`) that main.py wires in with one
    `app.include_router(router)` line.
  - Calls the existing LLM wrappers in `tools.py` (`call_generate_skill_from_goals`,
    `call_generate_scorers`, `call_synthesize_examples`) and persists via `db`
    directly. It does NOT call the HTTP endpoints in main.py — those are
    coupled to FastAPI `Depends(...)` (auth, quota) and would need a fake
    Request object to invoke.
  - The eval step is intentionally lightweight: when RUNNER_BACKEND=mock
    (the default for this demo path) we compute mock pass rates locally
    rather than hitting Braintrust. The shape of the events still matches
    what a real eval would emit, so the frontend doesn't change when we
    flip the runner backend later.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, AsyncIterator, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import db
from .models import (
    AgentStatus,
    AlignmentEntry,
    SessionInput,
    SessionState,
)
from .tools import (
    call_generate_scorers,
    call_generate_skill_from_goals,
    call_synthesize_examples,
)

logger = logging.getLogger(__name__)

# No prefix — main.py mounts existing endpoints at root (e.g. `/sessions`),
# and Vite's dev proxy already strips `/api` from frontend requests. So our
# backend route is `/orchestrate-build`; the frontend hits `${API_BASE}/orchestrate-build`
# which resolves to `/api/orchestrate-build` -> proxy -> `/orchestrate-build`.
router = APIRouter(tags=["orchestrator"])


# ---------------------------------------------------------------------------
# Request / event models
# ---------------------------------------------------------------------------


class OrchestrateBuildRequest(BaseModel):
    """Body for POST /api/orchestrate-build.

    `session_id` is optional — if omitted, the orchestrator creates a new
    session keyed off the PRD. This makes the "one textbox + button" demo
    flow possible without a separate /sessions call.
    """

    prd: str = Field(..., min_length=1, description="Free-form product description.")
    session_id: Optional[str] = Field(
        default=None,
        description=(
            "Existing session to build into. When omitted, a fresh session "
            "is created and its id is included in the first event payload."
        ),
    )
    project_name: Optional[str] = Field(default=None)


class StageEvent(BaseModel):
    """One progress event in the SSE stream."""

    stage: str  # "init" | "skill" | "seed" | "dataset" | "scorers" | "evaluate" | "done" | "error"
    status: str  # "start" | "progress" | "ok" | "error"
    detail: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Stage runners — each returns the result to thread into the next stage.
# Failures raise; the streamer catches and emits a final error event.
# ---------------------------------------------------------------------------


async def _stage_init(prd: str, project_name: Optional[str]) -> tuple[str, SessionState]:
    """Either create a fresh session seeded from the PRD, or return an
    existing one to extend."""
    session_id = str(uuid.uuid4())
    # Seed goals/stories from the PRD using the simplest possible split:
    # paragraph-1 = goals blob, paragraph-2+ = stories blob. The downstream
    # `call_generate_skill_from_goals` is the canonical "turn prose into a
    # SKILL.md" call, and it accepts goals + stories without requiring them
    # to be perfectly extracted ahead of time.
    parts = [p.strip() for p in prd.split("\n\n") if p.strip()]
    business_goals = parts[0] if parts else prd
    user_stories = "\n\n".join(parts[1:]) if len(parts) > 1 else ""
    initial_input = SessionInput(
        business_goals=business_goals,
        user_stories=user_stories,
        goals=[business_goals] if business_goals else [],
    )
    state = SessionState(
        session_id=session_id,
        input=initial_input,
        agent_status=AgentStatus.drafting,
    )
    await db.create_session(session_id, state.model_dump(), name=project_name)
    return session_id, state


async def _stage_skill(state: SessionState, project_name: Optional[str]) -> str:
    """Generate SKILL.md body from goals + stories."""
    goals = [g for g in (state.input.goals or []) if g and g.strip()]
    if not goals and state.input.business_goals:
        goals = [state.input.business_goals]
    stories: list[dict] = []
    if state.input.user_stories:
        stories.append({"who": "user", "what": state.input.user_stories, "why": ""})
    body, _meta = await call_generate_skill_from_goals(goals, stories, project_name)
    # Strip frontmatter — same shape as the real endpoint expects.
    name, description, stripped = _parse_frontmatter(body)
    state.seed.task.skill_body = stripped
    if name:
        state.seed.task.skill_name = name
    if description:
        state.seed.task.skill_description = description
    return stripped


def _parse_frontmatter(raw: str) -> tuple[Optional[str], Optional[str], str]:
    """Lightweight YAML frontmatter splitter — mirror of main._parse_skill_frontmatter
    so the orchestrator doesn't need a private import."""
    if not raw.startswith("---"):
        return None, None, raw
    lines = raw.splitlines()
    if len(lines) < 3 or lines[0].strip() != "---":
        return None, None, raw
    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        return None, None, raw
    front = lines[1:end_idx]
    body = "\n".join(lines[end_idx + 1 :]).lstrip()
    name = description = None
    for line in front:
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip().strip('"').strip("'")
        if key == "name":
            name = value
        elif key == "description":
            description = value
    return name, description, body


async def _stage_seed(state: SessionState) -> dict:
    """For this demo flow we treat "seed" as a synonym for "the dimension
    skeleton already populated by skill generation". The full
    call_validate_seed path requires more conversation; here we fill any
    empty dimensions with a single placeholder so the dataset / scorer
    stages have a valid `seed` to consume.

    This is intentionally lightweight — the real seed UI is where users
    deeply edit dimensions. The orchestrator just ensures the structure is
    non-empty so synthesis has feature areas to fan out across.
    """
    seed = state.seed
    if not seed.alignment:
        primary = seed.task.skill_name or "core_behavior"
        seed.alignment = [
            AlignmentEntry(
                feature_area=primary,
                good="Output is correct, complete and follows the SKILL.md.",
                bad="Output ignores the SKILL.md, fabricates, or is incomplete.",
            )
        ]
    if not seed.coverage.criteria:
        seed.coverage.criteria = ["typical happy-path request", "edge / unusual request"]
    if not seed.balance.criteria:
        seed.balance.criteria = ["short input", "long input"]
    if not seed.rot.criteria:
        seed.rot.criteria = ["concise", "follows the requested format"]
    return seed.model_dump()


async def _stage_dataset(
    session_id: str,
    seed_dict: dict,
) -> tuple[dict, list[dict]]:
    """Create a dataset row, synthesize a small batch of examples and
    persist them. Returns (dataset, examples)."""
    dataset = await db.create_dataset(
        session_id=session_id,
        name=f"PRD build {session_id[:8]}",
        seed_snapshot=seed_dict,
    )
    examples_acc: list[dict] = []

    async def on_cell(cell_examples: list[dict]) -> None:
        for ex in cell_examples:
            ex["source"] = "synthetic"
        try:
            inserted = await db.bulk_create_examples(dataset["id"], cell_examples)
        except Exception:  # pragma: no cover - best-effort like main.py
            logger.exception("orchestrator: cell insert failed")
            return
        examples_acc.extend(inserted)

    try:
        await call_synthesize_examples(
            seed_dict,
            feature_areas=None,
            coverage_criteria=None,
            count=1,
            on_cell=on_cell,
        )
    except Exception:
        logger.exception("orchestrator: synthesize failed; continuing with what we have")

    return dataset, examples_acc


async def _stage_scorers(state: SessionState, seed_dict: dict) -> list[dict]:
    """Generate scorers from the seed + the SKILL.md body."""
    agent_contract = state.seed.task.skill_body or None
    scorers, _meta = await call_generate_scorers(seed_dict, agent_contract=agent_contract)
    state.scorers = scorers
    return scorers


async def _stage_evaluate(
    examples: list[dict],
    scorers: list[dict],
) -> dict[str, Any]:
    """Mock evaluation — produces realistic-looking per-scorer pass rates.

    The real eval runner (eval_runner.run_eval_sync) requires a Braintrust
    key and runs synchronously for tens of seconds. For the PRD-orchestrator
    demo path we just emit a plausible pass-rate per scorer so the loop /
    deploy stages have a shape to react to. Marked clearly in the payload
    as `mock: True` so the frontend can label it honestly.
    """
    # Deterministic-ish pseudo scores: seed off scorer name length so two
    # runs of the same build feel stable, but different scorers don't
    # all land on the same number.
    pass_rates: dict[str, float] = {}
    for s in scorers:
        name = s.get("name") or "scorer"
        # 0.55 .. 0.85 band — visibly imperfect, room for the
        # self-improvement loop to do work.
        rate = 0.55 + ((len(name) * 7) % 30) / 100.0
        pass_rates[name] = round(rate, 2)
    overall = round(sum(pass_rates.values()) / max(len(pass_rates), 1), 2)
    return {
        "mock": True,
        "rows_evaluated": len(examples),
        "scorer_pass_rates": pass_rates,
        "overall_pass_rate": overall,
    }


# ---------------------------------------------------------------------------
# SSE streamer
# ---------------------------------------------------------------------------


def _sse(event: StageEvent) -> bytes:
    """Encode a StageEvent as one SSE message. We use only the `data:` field
    (no `event:` type) so the frontend can subscribe with a single onmessage
    handler and switch on `payload.stage`."""
    return f"data: {event.model_dump_json()}\n\n".encode("utf-8")


async def _build_stream(req: OrchestrateBuildRequest) -> AsyncIterator[bytes]:
    """Drive the full build, yielding SSE events at each stage transition."""
    try:
        # ---- init ----
        yield _sse(StageEvent(stage="init", status="start", detail="Creating session"))
        if req.session_id:
            row = await db.get_session(req.session_id)
            if row is None:
                raise HTTPException(status_code=404, detail="session not found")
            state = SessionState(**row["state"])
            session_id = req.session_id
        else:
            session_id, state = await _stage_init(req.prd, req.project_name)
        yield _sse(
            StageEvent(
                stage="init",
                status="ok",
                detail="Session ready",
                payload={"session_id": session_id},
            )
        )

        # ---- skill ----
        yield _sse(StageEvent(stage="skill", status="start", detail="Generating SKILL.md"))
        skill_body = await _stage_skill(state, req.project_name)
        await db.update_session(session_id, state.model_dump(), state.input.conversation_history)
        yield _sse(
            StageEvent(
                stage="skill",
                status="ok",
                detail=f"SKILL.md generated ({len(skill_body)} chars)",
                payload={"skill_body": skill_body},
            )
        )

        # ---- seed ----
        yield _sse(StageEvent(stage="seed", status="start", detail="Building seed dimensions"))
        seed_dict = await _stage_seed(state)
        await db.update_session(session_id, state.model_dump(), state.input.conversation_history)
        yield _sse(
            StageEvent(
                stage="seed",
                status="ok",
                detail="Seed populated",
                payload={
                    "alignment_count": len(seed_dict.get("alignment", [])),
                    "coverage_count": len(seed_dict.get("coverage", {}).get("criteria", [])),
                },
            )
        )

        # ---- dataset ----
        yield _sse(
            StageEvent(
                stage="dataset",
                status="start",
                detail="Synthesizing example dataset",
            )
        )
        dataset, examples = await _stage_dataset(session_id, seed_dict)
        yield _sse(
            StageEvent(
                stage="dataset",
                status="ok",
                detail=f"{len(examples)} examples generated",
                payload={
                    "dataset_id": dataset["id"],
                    "examples_count": len(examples),
                },
            )
        )

        # ---- scorers ----
        yield _sse(StageEvent(stage="scorers", status="start", detail="Generating scorers"))
        scorers = await _stage_scorers(state, seed_dict)
        await db.update_session(session_id, state.model_dump(), state.input.conversation_history)
        yield _sse(
            StageEvent(
                stage="scorers",
                status="ok",
                detail=f"{len(scorers)} scorers generated",
                payload={
                    "scorer_names": [s.get("name") for s in scorers],
                },
            )
        )

        # ---- evaluate ----
        yield _sse(
            StageEvent(
                stage="evaluate",
                status="start",
                detail="Running eval (mock backend)",
            )
        )
        eval_result = await _stage_evaluate(examples, scorers)
        yield _sse(
            StageEvent(
                stage="evaluate",
                status="ok",
                detail=(
                    f"Overall {int(eval_result['overall_pass_rate'] * 100)}% on "
                    f"{eval_result['rows_evaluated']} rows"
                ),
                payload=eval_result,
            )
        )

        # ---- done ----
        yield _sse(
            StageEvent(
                stage="done",
                status="ok",
                detail="Build complete",
                payload={
                    "session_id": session_id,
                    "dataset_id": dataset["id"],
                    "overall_pass_rate": eval_result["overall_pass_rate"],
                },
            )
        )
    except HTTPException as exc:
        yield _sse(
            StageEvent(
                stage="error",
                status="error",
                detail=exc.detail if isinstance(exc.detail, str) else str(exc.detail),
            )
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("orchestrator stream failed")
        yield _sse(
            StageEvent(
                stage="error",
                status="error",
                detail=f"{type(exc).__name__}: {exc}",
            )
        )


@router.post("/orchestrate-build")
async def orchestrate_build(req: OrchestrateBuildRequest) -> StreamingResponse:
    """Drive a full PRD -> deploy build, streaming progress as SSE.

    Curl example (the Anthropic key picks up from env):

        curl -N -X POST http://localhost:5000/orchestrate-build \\
             -H 'content-type: application/json' \\
             -d '{"prd": "We want a meeting-note summarizer."}'

    Each `data:` line is a JSON-encoded `StageEvent`. The stream closes
    after the `done` (or `error`) event; the frontend can keep a single
    `EventSource` open for the entire build.
    """
    return StreamingResponse(
        _build_stream(req),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable proxy buffering — events must flush
        },
    )


__all__ = ["router", "OrchestrateBuildRequest", "StageEvent"]
