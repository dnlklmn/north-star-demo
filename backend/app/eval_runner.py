"""Shared Braintrust eval runner.

Used by:
  - evals/run_eval.py (CLI)
  - main.py POST /sessions/{id}/run-eval (UI-triggered run)

The heavy work is in `run_eval_sync`, which is CPU-bound + blocks on Anthropic
and Braintrust HTTP. API callers should wrap it in `asyncio.to_thread()` so they
don't block the event loop.
"""

from __future__ import annotations

import os
import sys
import types
from dataclasses import dataclass, field
from typing import Any, Callable

import anthropic
import braintrust


DEFAULT_MODEL = os.environ.get("EVAL_MODEL", "claude-opus-4-7")
DEFAULT_JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "claude-sonnet-4-20250514")


@dataclass
class EvalResult:
    """Outcome of a single eval run."""
    experiment_url: str | None
    experiment_name: str | None
    rows_total: int
    rows_evaluated: int
    scorer_averages: dict[str, float] = field(default_factory=dict)
    scorer_names: list[str] = field(default_factory=list)
    per_row: list[dict[str, Any]] = field(default_factory=list)


def make_judge(client: anthropic.Anthropic, model: str) -> Callable[[str], float]:
    """Build a `call_judge(prompt) -> float` helper for scorer bodies to call.

    Returned callable also exposes `.last_response` and `.last_parsed` on itself,
    so the scorer adapter can surface the judge's reasoning + extracted number in
    the per-row metadata — essential for debugging 0% scores.
    """
    import re

    def call_judge(prompt: str) -> float:
        # Force a rigid output shape the parser can trust, regardless of what
        # the generated scorer's inner prompt asks for.
        framed = (
            prompt
            + "\n\n---\n"
            "Respond with your reasoning (1-2 sentences), then on a NEW FINAL LINE write:\n"
            "SCORE: <number between 0.0 and 1.0>\n"
            "The SCORE: line must be the last line of your response."
        )
        response = client.messages.create(
            model=model,
            max_tokens=512,
            messages=[{"role": "user", "content": framed}],
        )
        text = response.content[0].text if response.content else ""
        call_judge.last_response = text  # type: ignore[attr-defined]

        # Preferred shape: "SCORE: 0.9" on its own line.
        match = re.search(r"SCORE\s*:\s*([0-9]*\.?[0-9]+)", text, re.IGNORECASE)
        if match:
            try:
                value = max(0.0, min(1.0, float(match.group(1))))
                call_judge.last_parsed = value  # type: ignore[attr-defined]
                return value
            except ValueError:
                pass

        # Fallback: take the LAST number in [0, 1] — the judge often puts its
        # final verdict at the end after reasoning. Numbers >1 are probably
        # unrelated (line counts, char counts) — skip them.
        candidates = re.findall(r"[0-9]*\.?[0-9]+", text)
        for tok in reversed(candidates):
            try:
                value = float(tok)
            except ValueError:
                continue
            if 0.0 <= value <= 1.0:
                call_judge.last_parsed = value  # type: ignore[attr-defined]
                return value

        call_judge.last_parsed = None  # type: ignore[attr-defined]
        return 0.0

    call_judge.last_response = None  # type: ignore[attr-defined]
    call_judge.last_parsed = None  # type: ignore[attr-defined]
    return call_judge


def compile_scorers(
    scorer_defs: list[dict],
    call_judge: Callable[[str], float],
) -> list[Callable[..., dict[str, Any]]]:
    """Execute each scorer's source code, wrap as Braintrust-shaped scorer."""
    adapted: list[Callable[..., dict[str, Any]]] = []

    for defn in scorer_defs:
        name = defn.get("name") or "unnamed_scorer"
        code = defn.get("code") or ""
        description = defn.get("description") or ""

        if not code.strip():
            print(f"[eval_runner] skipping scorer '{name}' — no code", file=sys.stderr)
            continue

        module = types.ModuleType(f"_northstar_scorer_{name}")
        module.call_judge = call_judge  # type: ignore[attr-defined]
        try:
            exec(code, module.__dict__)
        except Exception as e:  # noqa: BLE001
            print(f"[eval_runner] skipping scorer '{name}' — exec failed: {e}", file=sys.stderr)
            continue

        fn = module.__dict__.get(name)
        if not callable(fn):
            print(f"[eval_runner] skipping scorer '{name}' — function not in compiled code", file=sys.stderr)
            continue

        def _adapter(output, expected=None, input=None, _fn=fn, _name=name, _desc=description, _judge=call_judge):  # noqa: ARG001
            # Braintrust hands scorers whatever we stuffed into the eval row's
            # "input" field — which is the whole dataset row dict. North Star
            # scorers expect a string (the actual prompt). Extract it.
            if isinstance(input, dict):
                input_str = input.get("input") or ""
            else:
                input_str = input or ""

            # Reset judge side-channel so per-invocation state is fresh.
            _judge.last_response = None  # type: ignore[attr-defined]
            _judge.last_parsed = None  # type: ignore[attr-defined]

            try:
                raw = _fn(output, input_str)
            except Exception as e:  # noqa: BLE001
                return {
                    "name": _name,
                    "score": 0.0,
                    "metadata": {
                        "error": f"{type(e).__name__}: {e}",
                        "description": _desc,
                    },
                }
            try:
                score = float(raw)
            except (TypeError, ValueError):
                score = 0.0

            metadata: dict[str, Any] = {"description": _desc}
            judge_text = getattr(_judge, "last_response", None)
            judge_parsed = getattr(_judge, "last_parsed", None)
            if judge_text:
                metadata["judge_response"] = judge_text[:2000]  # cap to keep rows compact
            if judge_parsed is None and judge_text:
                # Scorer called the judge but we failed to parse a score.
                metadata["parse_warning"] = "Judge response did not contain a SCORE: line or 0-1 number."

            return {
                "name": _name,
                "score": max(0.0, min(1.0, score)),
                "metadata": metadata,
            }

        _adapter.__name__ = name
        adapted.append(_adapter)

    return adapted


def build_rows(examples: list[dict], include_triggering: bool) -> list[dict]:
    """Filter + shape dataset rows into Braintrust's {input, expected, metadata} format.

    Rules:
      - review_status must be approved (or unset — manual rows default approved).
      - should_trigger=True rows are ALWAYS included. They have expected_output
        and are exactly the "does the skill execute correctly" rows we want here.
      - should_trigger=False rows are OFF-TARGET (no expected_output). They test
        routing, not execution, so we skip them unless include_triggering is on.
      - should_trigger=None is standard mode — always include.

    The row is cleaned of non-JSON-serializable fields (datetimes) before being
    stuffed into Braintrust's input field, because the eval result is later
    persisted via json.dumps — raw DB datetimes would break that.
    """
    import datetime as _dt

    def _clean(value: Any) -> Any:
        if isinstance(value, _dt.datetime):
            return value.isoformat()
        if isinstance(value, dict):
            return {k: _clean(v) for k, v in value.items()}
        if isinstance(value, list):
            return [_clean(v) for v in value]
        return value

    out: list[dict] = []
    for row in examples:
        if row.get("review_status") not in (None, "approved"):
            continue
        if row.get("should_trigger") is False and not include_triggering:
            continue
        clean_row = _clean(row)
        out.append(
            {
                "input": clean_row,
                "expected": row.get("expected_output") or "",
                "metadata": {
                    "id": row.get("id"),
                    "feature_area": row.get("feature_area"),
                    "coverage_tags": row.get("coverage_tags") or [],
                    "label": row.get("label"),
                    "should_trigger": row.get("should_trigger"),
                },
                "tags": (row.get("coverage_tags") or [])[:5],
            }
        )
    return out


def make_task(
    client: anthropic.Anthropic,
    skill_body: str,
    model: str,
) -> Callable[[dict], str]:
    """Task function — runs the skill on a single row via SKILL.md-as-system-prompt."""

    def task(row: dict) -> str:
        user_input = row["input"] if isinstance(row, dict) else str(row)
        response = client.messages.create(
            model=model,
            max_tokens=2048,
            system=skill_body,
            messages=[{"role": "user", "content": user_input}],
        )
        return response.content[0].text if response.content else ""

    return task


def _extract_summary(eval_handle: Any) -> tuple[str | None, str | None, dict[str, float], list[dict]]:
    """Pull experiment URL + per-scorer averages out of a completed Eval handle.

    Braintrust's Eval() returns an EvalResultWithSummary. Shape has changed across
    versions, so we probe several attribute names defensively and fall back to
    empty results if the SDK surface is different than expected.
    """
    url: str | None = None
    name: str | None = None
    averages: dict[str, float] = {}
    per_row: list[dict] = []

    summary = getattr(eval_handle, "summary", None) or eval_handle
    for attr in ("experiment_url", "url"):
        val = getattr(summary, attr, None)
        if isinstance(val, str) and val:
            url = val
            break
    for attr in ("experiment_name", "name"):
        val = getattr(summary, attr, None)
        if isinstance(val, str) and val:
            name = val
            break

    scores = getattr(summary, "scores", None) or {}
    if isinstance(scores, dict):
        for scorer_name, stat in scores.items():
            mean = getattr(stat, "score", None)
            if mean is None and isinstance(stat, dict):
                mean = stat.get("score") or stat.get("mean")
            if isinstance(mean, (int, float)):
                averages[scorer_name] = float(mean)

    results = getattr(eval_handle, "results", None) or []
    for r in results[:500]:  # cap — avoid ballooning
        per_row.append(
            {
                "input": getattr(r, "input", None),
                "output": getattr(r, "output", None),
                "expected": getattr(r, "expected", None),
                "scores": dict(getattr(r, "scores", {}) or {}),
                "error": getattr(r, "error", None),
                "metadata": getattr(r, "metadata", {}) or {},
            }
        )

    return url, name, averages, per_row


def run_eval_sync(
    *,
    skill_body: str,
    scorer_defs: list[dict],
    examples: list[dict],
    braintrust_api_key: str,
    project: str,
    experiment_name: str | None = None,
    anthropic_api_key: str | None = None,
    model: str = DEFAULT_MODEL,
    judge_model: str = DEFAULT_JUDGE_MODEL,
    include_triggering: bool = False,
    limit: int | None = None,
) -> EvalResult:
    """Synchronously run a Braintrust Eval. Blocks. Call via asyncio.to_thread."""
    if not skill_body.strip():
        raise ValueError("skill_body is empty — can't run the skill with no instructions.")
    if not scorer_defs:
        raise ValueError("No scorers provided. Generate them in the Scorers tab first.")
    if not braintrust_api_key:
        raise ValueError("braintrust_api_key is required.")

    # Log into Braintrust for this process. Safe to call multiple times.
    braintrust.login(api_key=braintrust_api_key)

    base_client = anthropic.Anthropic(api_key=anthropic_api_key) if anthropic_api_key else anthropic.Anthropic()
    # Task client is traced; judge client is not, to keep traces focused on the output.
    task_client = braintrust.wrap_anthropic(
        anthropic.Anthropic(api_key=anthropic_api_key) if anthropic_api_key else anthropic.Anthropic()
    )

    call_judge = make_judge(base_client, judge_model)
    scorers = compile_scorers(scorer_defs, call_judge)
    if not scorers:
        raise ValueError("No scorers compiled successfully. Check the Scorers tab.")

    rows = build_rows(examples, include_triggering=include_triggering)
    if limit:
        rows = rows[:limit]
    if not rows:
        # Diagnose why so the UI message is actionable.
        total = len(examples)
        by_status: dict[str, int] = {}
        off_target = 0
        for ex in examples:
            status = ex.get("review_status") or "unset"
            by_status[status] = by_status.get(status, 0) + 1
            if ex.get("should_trigger") is False:
                off_target += 1
        status_summary = ", ".join(f"{k}: {v}" for k, v in sorted(by_status.items()))
        detail = f"{total} rows total ({status_summary})"
        if off_target and not include_triggering:
            detail += f"; {off_target} off-target rows skipped (enable 'Include off-target rows' to include them)"
        approved = by_status.get("approved", 0)
        if approved == 0:
            detail += ". Approve at least one row in the Dataset tab before running the eval."
        raise ValueError(f"No eligible rows to evaluate — {detail}")

    task = make_task(task_client, skill_body, model)

    handle = braintrust.Eval(
        name=project,
        experiment_name=experiment_name,
        data=lambda: rows,
        task=task,
        scores=scorers,
    )

    url, name, averages, per_row = _extract_summary(handle)
    return EvalResult(
        experiment_url=url,
        experiment_name=name or experiment_name,
        rows_total=len(examples),
        rows_evaluated=len(rows),
        scorer_averages=averages,
        scorer_names=[s.__name__ for s in scorers],
        per_row=per_row,
    )
