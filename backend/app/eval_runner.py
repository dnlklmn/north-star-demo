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
import re
import sys
import types
from dataclasses import dataclass, field
from typing import Any, Callable

import anthropic
import braintrust


DEFAULT_MODEL = os.environ.get("EVAL_MODEL", "claude-opus-4-7")
DEFAULT_JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "claude-sonnet-4-5-20250929")

# See tools.OPENROUTER_BASE_URL — the SDK appends `/v1/messages`, so the base
# URL must end at `/api`, not `/api/v1`.
OPENROUTER_BASE_URL = "https://openrouter.ai/api"

_DATE_SUFFIX_RE = re.compile(r"-\d{8}$")


def _resolve_model_for_openrouter(name: str) -> str:
    """Map an Anthropic-native model id to its OpenRouter form.

    Mirrors tools._resolve_model. OpenRouter expects `anthropic/claude-sonnet-4-5`,
    not the bare dated id. Already-namespaced ids (containing `/`) are returned
    unchanged so non-Claude judges like `openai/gpt-4o` pass through.
    """
    if "/" in name:
        return name
    return f"anthropic/{_DATE_SUFFIX_RE.sub('', name)}"


def _build_judge_client(
    judge_model: str,
    anthropic_api_key: str | None,
) -> anthropic.Anthropic:
    """Pick the right client for the judge model.

    Non-Anthropic judges (``openai/gpt-4o``, ``google/gemini-2.5-pro`` etc.)
    route via OpenRouter, which is wire-compatible with the Anthropic SDK.
    The rule: a model slug containing ``/`` is an OpenRouter model ID.

    For OpenRouter we prefer, in order: a caller-supplied ``sk-or-`` key,
    then the ``OPENROUTER_API_KEY`` env var. For Anthropic judges we use
    the caller's key or the default client env lookup.
    """
    is_openrouter = "/" in judge_model
    if is_openrouter:
        key = anthropic_api_key if (anthropic_api_key and anthropic_api_key.startswith("sk-or-")) else os.environ.get("OPENROUTER_API_KEY")
        if not key:
            raise ValueError(
                f"Judge model '{judge_model}' requires an OpenRouter key. "
                "Set OPENROUTER_API_KEY or pass an sk-or-... key."
            )
        return anthropic.Anthropic(api_key=key, base_url=OPENROUTER_BASE_URL)
    if anthropic_api_key:
        # Anthropic or Anthropic-compatible key (including sk-or- if someone's
        # routing a claude-* model through OpenRouter).
        if anthropic_api_key.startswith("sk-or-"):
            return anthropic.Anthropic(api_key=anthropic_api_key, base_url=OPENROUTER_BASE_URL)
        return anthropic.Anthropic(api_key=anthropic_api_key)
    return anthropic.Anthropic()


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


def build_rows_for_prompt_eval(examples: list[dict]) -> list[dict]:
    """Shape rows for prompt-eval mode.

    No triggering / off-target filtering — every approved row participates.
    The `input` field on each example is already a JSON-serialized snapshot;
    keep it as a string so the task fn can json.loads it.
    """
    import datetime as _dt

    def _clean(value):
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
        out.append(
            {
                "input": row.get("input") or "",
                "expected": row.get("expected_output") or "",
                "metadata": {
                    "id": row.get("id"),
                    "feature_area": row.get("feature_area"),
                    "coverage_tags": _clean(row.get("coverage_tags") or []),
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


def make_task_for_prompt(
    client: anthropic.Anthropic,
    prompt_target: str,
    model: str,
    body_template: str | None = None,
) -> Callable[[dict], str]:
    """Task function for prompt-eval.

    Two paths:
      - body_template provided (the in-app prompt body, possibly user-edited):
        treat it as a template, substitute the row's snapshot values via
        the registered substitute_placeholders, send to the LLM. This is what
        runs in normal prompt-eval flow — letting the user iterate on prompt
        text in-app and have those edits actually drive the eval.
      - body_template not provided: fall back to calling the registered
        Python builder against the row's reconstructed state. Useful for CLI
        evals that don't have a session.
    """
    import json
    from .prompt_eval import get_prompt_target

    pt = get_prompt_target(prompt_target)
    if pt is None:
        raise ValueError(f"Unknown prompt_target: {prompt_target}")

    def task(row: dict) -> str:
        raw_input = row["input"] if isinstance(row, dict) else str(row)
        try:
            snapshot = json.loads(raw_input) if isinstance(raw_input, str) else (raw_input or {})
        except json.JSONDecodeError:
            snapshot = {}
        if not isinstance(snapshot, dict):
            snapshot = {}

        if body_template:
            prompt = pt.substitute_placeholders(body_template, snapshot)
        else:
            state = pt.build_state_from_snapshot(snapshot)
            prompt = pt.build_prompt(state)

        response = client.messages.create(
            model=model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
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
    prompt_target: str | None = None,
    prompt_body_template: str | None = None,
) -> EvalResult:
    """Synchronously run a Braintrust Eval. Blocks. Call via asyncio.to_thread.

    Two task modes:
      - skill mode (default): runs `skill_body` as system prompt against each
        row's `input` user message. `prompt_target` must be None.
      - prompt mode (`prompt_target` given): rebuilds a SessionState from each
        row's JSON-serialized snapshot and re-invokes the named prompt builder.
        `skill_body` is ignored in this mode.
    """
    is_prompt_mode = bool(prompt_target)

    if not is_prompt_mode and not skill_body.strip():
        raise ValueError("skill_body is empty — can't run the skill with no instructions.")
    if not scorer_defs:
        raise ValueError("No scorers provided. Generate them in the Scorers tab first.")
    if not braintrust_api_key:
        raise ValueError("braintrust_api_key is required.")

    # Log into Braintrust for this process. ``force_login=True`` is needed
    # because the prod-monitoring path (tools._ensure_braintrust_inited) has
    # already logged in with BRAINTRUST_PROD_API_KEY. Without force_login the
    # SDK warns and silently keeps the original auth, so the eval would write
    # to the wrong account/project. We restore the prod auth + logger in a
    # finally block below so background production tracing keeps flowing to
    # north-star-prod after the eval completes.
    braintrust.login(api_key=braintrust_api_key, force_login=True)

    # Task client runs the skill under test. Always Claude — but the user may
    # have given us an OpenRouter key (`sk-or-...`), in which case we route
    # through OpenRouter's Anthropic-compatible endpoint. Without this branch
    # the SDK silently sends the OpenRouter key as `x-api-key` to
    # api.anthropic.com → 401 on every row.
    task_model = model
    if anthropic_api_key and anthropic_api_key.startswith("sk-or-"):
        task_client = braintrust.wrap_anthropic(
            anthropic.Anthropic(api_key=anthropic_api_key, base_url=OPENROUTER_BASE_URL)
        )
        task_model = _resolve_model_for_openrouter(model)
    elif not anthropic_api_key and not os.environ.get("ANTHROPIC_API_KEY") and os.environ.get("OPENROUTER_API_KEY"):
        # Env-var fallback to OpenRouter (matches tools.get_client behavior).
        task_client = braintrust.wrap_anthropic(
            anthropic.Anthropic(api_key=os.environ["OPENROUTER_API_KEY"], base_url=OPENROUTER_BASE_URL)
        )
        task_model = _resolve_model_for_openrouter(model)
    else:
        task_client = braintrust.wrap_anthropic(
            anthropic.Anthropic(api_key=anthropic_api_key) if anthropic_api_key else anthropic.Anthropic()
        )

    # Judge client may point at OpenRouter when the user picked a non-Claude
    # judge — the Anthropic SDK is wire-compatible with OpenRouter so the
    # scorer code doesn't need to change. When the user's key is OpenRouter
    # AND the judge is a Claude model, remap the bare Anthropic id to the
    # OpenRouter form so the judge call doesn't 404.
    judge_client = _build_judge_client(judge_model, anthropic_api_key)
    judge_model_resolved = judge_model
    routed_via_openrouter = (
        ("/" in judge_model)
        or (anthropic_api_key and anthropic_api_key.startswith("sk-or-"))
        or (not anthropic_api_key and not os.environ.get("ANTHROPIC_API_KEY") and os.environ.get("OPENROUTER_API_KEY"))
    )
    if routed_via_openrouter:
        judge_model_resolved = _resolve_model_for_openrouter(judge_model)
    call_judge = make_judge(judge_client, judge_model_resolved)
    scorers = compile_scorers(scorer_defs, call_judge)
    if not scorers:
        raise ValueError("No scorers compiled successfully. Check the Scorers tab.")

    if is_prompt_mode:
        rows = build_rows_for_prompt_eval(examples)
    else:
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

    if is_prompt_mode:
        task = make_task_for_prompt(
            task_client,
            prompt_target,  # type: ignore[arg-type]
            task_model,
            body_template=prompt_body_template,
        )
    else:
        task = make_task(task_client, skill_body, task_model)

    try:
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
    finally:
        # Restore prod-monitoring auth + logger so production traces continue
        # writing to north-star-prod after the eval. Without this, every LLM
        # call after an eval would silently log to whichever Braintrust
        # project the user's eval key writes to.
        prod_key = os.environ.get("BRAINTRUST_PROD_API_KEY")
        if prod_key:
            try:
                braintrust.login(api_key=prod_key, force_login=True)
                braintrust.init_logger(
                    project=os.environ.get("BRAINTRUST_PROD_PROJECT", "north-star-prod"),
                )
            except Exception:
                pass  # never let restoration failure mask the eval result
