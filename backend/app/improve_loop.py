"""Self-improvement loop — Track 3 of the PRD->prod quick-demo pipeline.

A bounded ``analyze -> improve -> rerun`` loop that pushes the skill body until
every scorer is at or above ``LoopConfig.pass_threshold`` (default 0.75), or
``LoopConfig.max_rounds`` is exhausted. Every round is emitted as a
``LoopRoundEvent`` over Server-Sent Events so the UI can show "what changed"
and "why" live — opaque spinners are forbidden by the cross-cutting principle.

Design notes
------------
* **Feature-only mutation.** ``LoopTargetPolicy.feature_only`` (the default) is
  enforced: only ``skill_body`` is mutated. If a generated patch tries to touch
  scorers, dataset, or charter, we hard-fail that round with an explicit
  rationale rather than silently dropping the suspicious fields. This is the
  anti-Goodhart guarantee — the green checkmark cannot be gamed by editing the
  ruler.
* **"Passes" == every scorer >= threshold.** Not aggregate, not average. Even a
  single laggard scorer below the bar leaves ``passed=False``.
* **Bounded.** ``max_rounds`` is a hard cap. The stream ALWAYS terminates with a
  final ``done`` event carrying ``{passed: bool}`` even if all rounds errored.
* **Pluggable hooks.** The loop body talks to the rest of the app through a
  small ``ImproveLoopDeps`` dataclass — load_state, persist_skill, run_eval,
  improve_skill. Defaults work against ``RUNNER_BACKEND=mock`` with no DB so
  unit tests and other tracks can exercise the loop today. main.py wires the
  real hooks at integration time.

Wiring (see ``wiring_notes`` in the report):
    from . import improve_loop
    app.include_router(improve_loop.router)
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import contracts as c

logger = logging.getLogger(__name__)

router = APIRouter(tags=["improve-loop"])


# ---------------------------------------------------------------------------
# State the loop reads/writes through pluggable hooks.
# ---------------------------------------------------------------------------


@dataclass
class LoopState:
    """Minimal view of session state the loop needs.

    Kept separate from any DB schema so the loop is testable in isolation —
    main.py adapts whatever the session-storage row looks like into this.
    """

    skill_id: str
    skill_body: str
    # Last eval results: scorer name -> aggregate score in [0, 1].
    last_scorer_scores: dict[str, float] = field(default_factory=dict)
    # Per-row breakdown (row_id -> scorer -> score). Used to pick the low
    # performers for the improve prompt. Optional — empty is fine.
    last_per_row_scores: dict[str, dict[str, float]] = field(default_factory=dict)


@dataclass
class ImproveLoopDeps:
    """Pluggable seams so the loop is mock-friendly + DB-free under tests."""

    load_state: Callable[[str], Awaitable[LoopState]]
    persist_skill: Callable[[str, str], Awaitable[None]]
    run_eval: Callable[[str, str], Awaitable[dict[str, float]]]
    improve_skill: Callable[
        [LoopState, c.LoopConfig], Awaitable[tuple[str, str, str]]
    ]
    # ``improve_skill`` returns ``(new_skill_body, changed_summary, rationale)``.


# ---------------------------------------------------------------------------
# Default mock-friendly implementations.
# ---------------------------------------------------------------------------


# In-memory store for mock/testing — keyed by session_id.
_MOCK_STATE: dict[str, LoopState] = {}


async def _default_load_state(session_id: str) -> LoopState:
    state = _MOCK_STATE.get(session_id)
    if state is None:
        # Seed a stub state so a brand-new session can drive the loop end to
        # end against RUNNER_BACKEND=mock. Two scorers, both failing — round 1
        # has somewhere to climb from.
        state = LoopState(
            skill_id=f"skill_{session_id}",
            skill_body="# SKILL\n\nYou are a helpful assistant.",
            last_scorer_scores={"helpfulness": 0.40, "correctness": 0.55},
        )
        _MOCK_STATE[session_id] = state
    return state


async def _default_persist_skill(session_id: str, skill_body: str) -> None:
    state = _MOCK_STATE.get(session_id)
    if state is not None:
        state.skill_body = skill_body


async def _default_run_eval(session_id: str, skill_body: str) -> dict[str, float]:
    """Mock evaluator: deterministically nudges each scorer upward each round.

    Real wiring replaces this with an eval_runner / runner.run_feature loop +
    real scorer aggregation. The shape stays the same: scorer name -> [0,1].
    """
    state = _MOCK_STATE.get(session_id)
    if state is None:
        return {}
    new_scores: dict[str, float] = {}
    for name, prev in state.last_scorer_scores.items():
        # Diminishing-returns climb: half the gap to 1.0 each round, with a
        # tiny floor so a scorer can briefly tick down if the model decides
        # the previous round overcorrected. Caps at 0.99 so we always have a
        # bit of headroom for delta computation.
        nudged = prev + (1.0 - prev) * 0.45
        new_scores[name] = round(min(0.99, nudged), 4)
    state.last_scorer_scores = new_scores
    return new_scores


async def _default_improve_skill(
    state: LoopState, cfg: c.LoopConfig
) -> tuple[str, str, str]:
    """Use the LLM (via ``tools.get_client``) to rewrite the skill body.

    Falls back to a deterministic edit if no API key is configured so the loop
    is still demonstrable under ``RUNNER_BACKEND=mock`` with zero credentials.
    """
    failing = [
        name
        for name, score in state.last_scorer_scores.items()
        if score < cfg.pass_threshold
    ]
    if not failing:
        return (
            state.skill_body,
            "no-op (all scorers already pass)",
            "Loop entered with every scorer above threshold — nothing to do.",
        )

    # Prompt the model only if we have a client. Track 3 keeps the prompt
    # surface narrow so it can't accidentally edit scorers/charter/dataset —
    # the model is asked for a SKILL.md rewrite, nothing else. Anything that
    # comes back is treated as the new skill_body verbatim (the policy guard
    # below double-checks before we persist).
    try:
        from . import tools  # late import: keeps the module import-light

        client = tools.get_client()
        model = tools._resolve_model(tools.get_model())
    except Exception as exc:  # noqa: BLE001 — no key / no network is fine in mock
        logger.info("improve_skill: falling back to deterministic edit: %s", exc)
        return _deterministic_improve(state, failing)

    system = (
        "You are an eval-driven skill editor. You will be given a SKILL.md "
        "body and the names of automatic scorers it is currently failing. "
        "Rewrite ONLY the SKILL.md body to improve those scorers. Do not "
        "comment on scorers themselves, do not change scorer definitions, do "
        "not touch the charter or dataset. Return only the new SKILL.md."
    )
    user = (
        f"Current SKILL.md:\n```\n{state.skill_body}\n```\n\n"
        f"Failing scorers (below {cfg.pass_threshold}): {', '.join(failing)}\n"
        f"All scorer scores: {json.dumps(state.last_scorer_scores)}\n\n"
        "Return the rewritten SKILL.md only."
    )
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=2048,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        new_body = "".join(
            b.text for b in resp.content if getattr(b, "type", None) == "text"
        ).strip()
        if not new_body:
            return _deterministic_improve(state, failing)
        changed = f"Rewrote SKILL.md targeting: {', '.join(failing)}"
        rationale = (
            f"Model edited the skill to address {len(failing)} failing "
            f"scorer(s). Persisted as new skill version; rerunning eval."
        )
        return new_body, changed, rationale
    except Exception as exc:  # noqa: BLE001 — model errors degrade gracefully
        logger.warning("improve_skill: model call failed, falling back: %s", exc)
        return _deterministic_improve(state, failing)


def _deterministic_improve(
    state: LoopState, failing: list[str]
) -> tuple[str, str, str]:
    """Reproducible fallback used when no LLM client is configured.

    Appends a numbered "improvement note" referencing the failing scorers, so
    the SSE stream still has a visible diff to render.
    """
    round_n = state.skill_body.count("## Improvement note") + 1
    addition = (
        f"\n\n## Improvement note {round_n}\n"
        f"- Address scorers: {', '.join(failing)}\n"
        "- Be more specific, cite examples, and check your work.\n"
    )
    return (
        state.skill_body + addition,
        f"Appended guidance for: {', '.join(failing)}",
        "Deterministic fallback (no LLM client). Targeted note appended so "
        "downstream eval re-runs see a structural change to the skill body.",
    )


def default_deps() -> ImproveLoopDeps:
    """Defaults that work standalone against ``RUNNER_BACKEND=mock``."""
    return ImproveLoopDeps(
        load_state=_default_load_state,
        persist_skill=_default_persist_skill,
        run_eval=_default_run_eval,
        improve_skill=_default_improve_skill,
    )


# main.py may swap this out at integration time. We expose a module-level
# slot rather than passing deps through every request because (a) the FastAPI
# route is the public seam, and (b) tests can monkeypatch this attribute.
DEPS: ImproveLoopDeps = default_deps()


def set_deps(deps: ImproveLoopDeps) -> None:
    """Integration hook for main.py (or tests) to inject real DB-backed seams."""
    global DEPS
    DEPS = deps


# ---------------------------------------------------------------------------
# Policy guard — the anti-Goodhart hard-fail.
# ---------------------------------------------------------------------------


# Keys the improve step is FORBIDDEN from returning under feature_only. If the
# LLM hands back a JSON-shaped patch (instead of raw SKILL.md text), we refuse
# the round rather than silently strip the fields.
_FORBIDDEN_PATCH_KEYS = frozenset(
    {"scorer", "scorers", "scorer_definitions", "charter", "dataset", "rows"}
)


def _enforce_feature_only(new_skill_body: str, cfg: c.LoopConfig) -> Optional[str]:
    """Return an error message if the patch tries to mutate forbidden surfaces.

    Returns None when the patch is policy-clean.
    """
    if cfg.target_policy != c.LoopTargetPolicy.feature_only:
        return None
    stripped = new_skill_body.lstrip()
    if not stripped.startswith("{"):
        return None  # plain SKILL.md text — clean by construction
    # Looks like JSON; sniff for forbidden keys.
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return None  # not actually JSON, just a doc that opens with `{`
    if not isinstance(parsed, dict):
        return None
    bad = sorted(set(parsed.keys()) & _FORBIDDEN_PATCH_KEYS)
    if bad:
        return (
            "feature_only policy violation: improve step returned a patch "
            f"touching {bad}. Only skill_body may change."
        )
    return None


# ---------------------------------------------------------------------------
# Round computation.
# ---------------------------------------------------------------------------


def _pass_rate(scores: dict[str, float], threshold: float) -> float:
    if not scores:
        return 0.0
    passing = sum(1 for s in scores.values() if s >= threshold)
    return round(passing / len(scores), 4)


def _all_pass(scores: dict[str, float], threshold: float) -> bool:
    return bool(scores) and all(s >= threshold for s in scores.values())


def build_round_event(
    *,
    round_n: int,
    changed: str,
    rationale: str,
    scorer_scores: dict[str, float],
    cfg: c.LoopConfig,
    prev_pass_rate: Optional[float],
) -> c.LoopRoundEvent:
    """Pure: assemble a LoopRoundEvent from already-computed scorer scores.

    Exposed so unit tests + the loop body share the same arithmetic.
    """
    pr = _pass_rate(scorer_scores, cfg.pass_threshold)
    delta = None if prev_pass_rate is None else round(pr - prev_pass_rate, 4)
    return c.LoopRoundEvent(
        round=round_n,
        changed=changed,
        rationale=rationale,
        scorer_scores=scorer_scores,
        pass_rate=pr,
        delta=delta,
        passed=_all_pass(scorer_scores, cfg.pass_threshold),
    )


# ---------------------------------------------------------------------------
# The async loop body — yields LoopRoundEvent per round, terminates exactly
# once with a "done" sentinel. Used by the SSE endpoint and by tests.
# ---------------------------------------------------------------------------


async def run_loop(
    session_id: str,
    cfg: c.LoopConfig,
    *,
    deps: Optional[ImproveLoopDeps] = None,
    request: Optional[Request] = None,
) -> AsyncIterator[dict[str, Any]]:
    """Drive the bounded improvement loop.

    Yields one dict per SSE message. Each ``round`` event carries a
    serialized ``LoopRoundEvent``. The final ``done`` event carries
    ``{passed: bool, rounds: int, reason: str}`` so the UI can render the
    terminal state without inferring it from the last round.
    """
    deps = deps or DEPS
    state = await deps.load_state(session_id)
    # First, emit the initial scorer scores so the UI has a "round 0" baseline.
    baseline_event = build_round_event(
        round_n=0,
        changed="(baseline)",
        rationale="Starting scorer scores before the first improve cycle.",
        scorer_scores=dict(state.last_scorer_scores),
        cfg=cfg,
        prev_pass_rate=None,
    )
    yield {"type": "round", "data": baseline_event.model_dump()}

    if baseline_event.passed:
        yield {
            "type": "done",
            "data": {"passed": True, "rounds": 0, "reason": "already passing"},
        }
        return

    prev_pass_rate = baseline_event.pass_rate
    passed = False
    reason = "max_rounds exhausted"
    completed_rounds = 0

    for round_n in range(1, cfg.max_rounds + 1):
        completed_rounds = round_n
        # Cooperative cancel: bail if the SSE client went away.
        if request is not None and await request.is_disconnected():
            reason = "client disconnected"
            break

        # 1. Generate an improved skill body. Wrapped in try/except so a
        #    transient LLM/network blip doesn't take down the whole loop —
        #    the round is reported as an error and we continue.
        try:
            new_body, changed, rationale = await deps.improve_skill(state, cfg)
        except Exception as exc:  # noqa: BLE001
            logger.exception("improve_skill failed")
            err_event = build_round_event(
                round_n=round_n,
                changed="(improve step errored)",
                rationale=f"improve_skill raised {type(exc).__name__}: {exc}",
                scorer_scores=dict(state.last_scorer_scores),
                cfg=cfg,
                prev_pass_rate=prev_pass_rate,
            )
            yield {"type": "round", "data": err_event.model_dump()}
            prev_pass_rate = err_event.pass_rate
            continue

        # 2. Policy guard: feature_only forbids touching scorers/charter/dataset.
        policy_err = _enforce_feature_only(new_body, cfg)
        if policy_err:
            err_event = build_round_event(
                round_n=round_n,
                changed="(policy violation)",
                rationale=policy_err,
                scorer_scores=dict(state.last_scorer_scores),
                cfg=cfg,
                prev_pass_rate=prev_pass_rate,
            )
            yield {"type": "round", "data": err_event.model_dump()}
            prev_pass_rate = err_event.pass_rate
            continue

        # 3. Persist new skill_body.
        try:
            await deps.persist_skill(session_id, new_body)
            state.skill_body = new_body
        except Exception as exc:  # noqa: BLE001
            logger.exception("persist_skill failed")
            err_event = build_round_event(
                round_n=round_n,
                changed="(persist failed)",
                rationale=f"persist_skill raised {type(exc).__name__}: {exc}",
                scorer_scores=dict(state.last_scorer_scores),
                cfg=cfg,
                prev_pass_rate=prev_pass_rate,
            )
            yield {"type": "round", "data": err_event.model_dump()}
            prev_pass_rate = err_event.pass_rate
            continue

        # 4. Rerun eval to get new scorer scores.
        try:
            new_scores = await deps.run_eval(session_id, new_body)
        except Exception as exc:  # noqa: BLE001
            logger.exception("run_eval failed")
            err_event = build_round_event(
                round_n=round_n,
                changed=changed + " (eval failed)",
                rationale=f"run_eval raised {type(exc).__name__}: {exc}",
                scorer_scores=dict(state.last_scorer_scores),
                cfg=cfg,
                prev_pass_rate=prev_pass_rate,
            )
            yield {"type": "round", "data": err_event.model_dump()}
            prev_pass_rate = err_event.pass_rate
            continue

        state.last_scorer_scores = new_scores

        # 5. Emit the round event.
        event = build_round_event(
            round_n=round_n,
            changed=changed,
            rationale=rationale,
            scorer_scores=new_scores,
            cfg=cfg,
            prev_pass_rate=prev_pass_rate,
        )
        yield {"type": "round", "data": event.model_dump()}
        prev_pass_rate = event.pass_rate

        if event.passed:
            passed = True
            reason = "all scorers >= threshold"
            break

    yield {
        "type": "done",
        "data": {
            "passed": passed,
            "rounds": completed_rounds,
            "reason": reason,
            "pass_threshold": cfg.pass_threshold,
        },
    }


# ---------------------------------------------------------------------------
# HTTP surface.
# ---------------------------------------------------------------------------


class ImproveLoopRequest(BaseModel):
    session_id: str
    config: Optional[c.LoopConfig] = None


def _sse_format(event_type: str, payload: dict[str, Any]) -> str:
    # Compact JSON keeps lines short (some proxies drop long single-line bodies).
    body = json.dumps(payload, separators=(",", ":"))
    return f"event: {event_type}\ndata: {body}\n\n"


@router.post("/api/improve-loop")
async def improve_loop_endpoint(req: ImproveLoopRequest, request: Request):
    cfg = req.config or c.LoopConfig()

    async def stream() -> AsyncIterator[str]:
        # Initial hello mirrors the existing SSE pattern in main.py — lets the
        # client confirm the connection without a sidecar fetch.
        yield _sse_format(
            "hello",
            {"session_id": req.session_id, "config": cfg.model_dump()},
        )
        try:
            async for ev in run_loop(req.session_id, cfg, request=request):
                yield _sse_format(ev.get("type", "round"), ev.get("data", {}))
        except asyncio.CancelledError:
            # Re-raise so FastAPI unwinds the streaming response cleanly when
            # the client aborts mid-stream.
            raise
        except Exception as exc:  # noqa: BLE001 — surface unexpected errors
            logger.exception("improve-loop stream errored")
            yield _sse_format(
                "done",
                {
                    "passed": False,
                    "rounds": 0,
                    "reason": f"server error: {type(exc).__name__}: {exc}",
                },
            )

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",  # disable nginx buffering
        "Connection": "keep-alive",
    }
    return StreamingResponse(
        stream(), media_type="text/event-stream", headers=headers
    )


# ---------------------------------------------------------------------------
# Self-test helper — kept in-module so `python -c "from app import improve_loop;
# improve_loop.self_test()"` is the verification command in CI/the report.
# ---------------------------------------------------------------------------


def self_test() -> dict[str, Any]:
    """Synchronous smoke test: drive one fake round end-to-end."""
    cfg = c.LoopConfig()
    event = build_round_event(
        round_n=1,
        changed="Tightened wording around citations.",
        rationale="Helpfulness scorer flagged vague responses last round.",
        scorer_scores={"helpfulness": 0.82, "correctness": 0.76},
        cfg=cfg,
        prev_pass_rate=0.0,
    )
    # Round-trip through Pydantic to prove the contract is satisfied.
    parsed = c.LoopRoundEvent.model_validate(event.model_dump())
    assert parsed.passed is True
    assert parsed.pass_rate == 1.0
    # Policy guard: a JSON patch touching scorers must be rejected.
    bad = '{"skill_body":"x","scorers":[{"name":"foo"}]}'
    err = _enforce_feature_only(bad, cfg)
    assert err is not None and "feature_only" in err
    # Plain SKILL.md text passes the guard.
    assert _enforce_feature_only("# SKILL\nbe helpful", cfg) is None
    return {
        "parsed_round": parsed.model_dump(),
        "policy_violation_detected": err,
    }


async def self_test_async() -> list[dict[str, Any]]:
    """Drive the full async loop against the mock defaults end to end."""
    cfg = c.LoopConfig(pass_threshold=0.75, max_rounds=5)
    session_id = f"selftest_{int(time.time() * 1000)}"
    # Fresh state for the smoke run.
    _MOCK_STATE.pop(session_id, None)
    events: list[dict[str, Any]] = []
    async for ev in run_loop(session_id, cfg):
        events.append(ev)
    return events
