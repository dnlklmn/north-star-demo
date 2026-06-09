"""Shared Braintrust eval runner.

Used by:
  - evals/run_eval.py (CLI)
  - main.py POST /sessions/{id}/run-eval (UI-triggered run)

The heavy work is in `run_eval_sync`, which is CPU-bound + blocks on Anthropic
and Braintrust HTTP. API callers should wrap it in `asyncio.to_thread()` so they
don't block the event loop.
"""

from __future__ import annotations

import json
import os
import re
import sys
import types
from dataclasses import dataclass, field
from typing import Any, Callable

import anthropic
import braintrust

from . import agent_task


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


def json_schema_ok(obj: Any, schema: Any) -> bool:
    """Validate ``obj`` against a minimal subset of JSON Schema.

    Dependency-free (no ``jsonschema`` package). Injected into generated
    scorer namespaces so deterministic format checks can run without
    ``import``. Supports ``type`` (object/array/string/number/integer/
    boolean/null), ``required`` (list of keys), ``properties`` (recurse),
    and ``items`` (recurse for array elements). Unknown keywords are
    ignored. Never raises — returns ``False`` on any mismatch or error.
    """
    try:
        if not isinstance(schema, dict):
            return False

        expected_type = schema.get("type")
        if expected_type is not None:
            type_map = {
                "object": dict,
                "array": list,
                "string": str,
                "boolean": bool,
                "null": type(None),
            }
            if expected_type == "integer":
                # bool is a subclass of int — exclude it.
                if isinstance(obj, bool) or not isinstance(obj, int):
                    return False
            elif expected_type == "number":
                if isinstance(obj, bool) or not isinstance(obj, (int, float)):
                    return False
            elif expected_type in type_map:
                if not isinstance(obj, type_map[expected_type]):
                    return False
            else:
                # Unknown type keyword — can't validate, treat as failure.
                return False

        if "required" in schema:
            required = schema.get("required")
            if not isinstance(obj, dict) or not isinstance(required, list):
                return False
            for key in required:
                if key not in obj:
                    return False

        if "properties" in schema:
            properties = schema.get("properties")
            if isinstance(properties, dict) and isinstance(obj, dict):
                for key, subschema in properties.items():
                    if key in obj and not json_schema_ok(obj[key], subschema):
                        return False

        if "items" in schema:
            item_schema = schema.get("items")
            if isinstance(obj, list) and isinstance(item_schema, dict):
                for element in obj:
                    if not json_schema_ok(element, item_schema):
                        return False

        return True
    except Exception:  # noqa: BLE001
        return False


def make_judge(client: anthropic.Anthropic, model: str) -> Callable[[str], float]:
    """Build a `call_judge(prompt) -> float` helper for scorer bodies to call.

    Returned callable also exposes `.last_response` and `.last_parsed` on itself,
    so the scorer adapter can surface the judge's reasoning + extracted number in
    the per-row metadata — essential for debugging 0% scores.
    """
    import re

    def call_judge(prompt: str) -> float:
        # Mandate a single, parseable line shape per sub-criterion plus a
        # final SCORE: line. The first version of this framing asked for
        # "one line each" — which Haiku interpreted loosely, mixing
        # `**N. Name**: MET (1.0)` (high-score cases) with
        # `**N. Name (0):**` (low-score cases) and sometimes dropping the
        # SCORE: line entirely. Measurement against a 68-sample corpus
        # showed 56% parser hit rate under the loose framing
        # (scripts/measure_parsing_hit_rate.py against
        # /tmp/judge_corpus.jsonl). Tightening to ONE format with literal
        # markers ([PASS]/[PARTIAL]/[FAIL], em-dash separator, mandatory
        # numeric weight) pushes that into the green band by leaving no
        # interpretive wiggle room. The Tier 3A parser at
        # scripts/measure_parsing_hit_rate.py expects exactly this shape.
        framed = (
            prompt
            + "\n\n---\n"
            "Output format — follow EXACTLY, no improvisation:\n\n"
            "For EACH criterion in the rubric above, write ONE line in this exact format:\n"
            "  **N. <criterion name>** [PASS|PARTIAL|FAIL|N/A] (weight) — <one-sentence reason>\n\n"
            "Where:\n"
            "  • N is the criterion number, starting at 1, no gaps\n"
            "  • Replace [PASS|PARTIAL|FAIL|N/A] with one of those four literal labels in square brackets\n"
            "  • (weight) is a number: 1.0 for PASS, 0.0 for FAIL, between 0 and 1 for PARTIAL,\n"
            "    and 0.5 for N/A (use N/A only when the criterion genuinely doesn't apply to this\n"
            "    output's situation — e.g. a 'must explain trade-offs' criterion when no trade-off exists)\n"
            "  • The em-dash (—) is mandatory; do not use a regular dash\n"
            "  • The reason is ONE sentence — no line breaks inside it\n\n"
            "After every criterion line, write a NEW FINAL LINE:\n"
            "  SCORE: <average of weights, between 0.0 and 1.0>\n\n"
            "The SCORE: line MUST be the last line of your response. No prose after it."
        )
        response = client.messages.create(
            model=model,
            max_tokens=512,
            temperature=0,
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


def make_knn_voter(
    labeled_pool: list[dict] | None,
    *,
    model: str | None = None,
    default_k: int = 5,
) -> Callable[..., float]:
    """Build a ``knn_vote(output, k=5) -> float`` helper for scorer bodies.

    Tier 2 B1 — the runtime side of the kNN-against-labels scoring method.
    The voter:

    1. Embeds the candidate ``output`` via the embeddings provider.
    2. Computes cosine similarity against every row in ``labeled_pool``.
    3. Picks the top-k by similarity.
    4. Returns a weighted vote: ``good`` rows contribute +similarity,
       ``bad`` rows contribute -similarity; the result is normalised into
       ``[0, 1]`` (0.5 means neighbors are evenly split, 1.0 means every
       neighbor is ``good`` with high similarity).

    Parallels :func:`make_judge` in shape — exposes ``.last_response`` (a
    JSON-serialisable summary of neighbors voted) and ``.last_parsed``
    (the float that came out) so the compiled adapter can surface them
    in per-row metadata for the UI and the future training corpus.

    Pool of ``None`` or empty produces a voter that always returns
    ``None`` (skip-the-row sentinel — same convention as a coverage
    scorer that doesn't match): a kNN scorer with nothing to vote
    against would otherwise hand out misleading 0.0 scores.

    The pool is closed over the lifetime of the eval run, not refreshed
    per-row. A new label landing mid-run intentionally does NOT change
    votes for already-scored rows — that would make the run
    irreproducible. The next eval run picks the updated pool up.
    """
    import json as _json

    # Local import: avoids paying the httpx + module-load cost when an eval
    # run has no kNN scorers, which is the common case during the transition.
    from .embeddings import cosine_similarity, embed_texts

    pool = labeled_pool or []

    def knn_vote(output: str, k: int = default_k) -> float | None:
        if not pool:
            knn_vote.last_response = None  # type: ignore[attr-defined]
            knn_vote.last_parsed = None  # type: ignore[attr-defined]
            return None

        text = (output or "").strip()
        if not text:
            # Empty output — record the skip but return 0 (not None), since
            # an empty output IS the response under test and most "good"
            # neighbors would NOT match it. 0 is the right floor here.
            knn_vote.last_response = _json.dumps(  # type: ignore[attr-defined]
                {"reason": "empty output", "k": k, "pool_size": len(pool)}
            )
            knn_vote.last_parsed = 0.0  # type: ignore[attr-defined]
            return 0.0

        # One embedding call per scorer invocation. The provider's in-process
        # LRU dedupes when the same output text shows up in multiple scorers
        # (common: a coverage and an alignment kNN scorer both look at the
        # same row), so this is cheaper than it looks.
        result = embed_texts([text], model=model)[0]
        query_vec = result.vector

        scored: list[tuple[float, dict]] = []
        for row in pool:
            row_vec = row.get("embedding")
            if not isinstance(row_vec, list):
                continue
            try:
                sim = cosine_similarity(query_vec, row_vec)
            except ValueError:
                # Dim mismatch — different provider in the pool than at
                # query time. Silently skip the row; the model filter in
                # ``get_labeled_embeddings`` SHOULD prevent this, but
                # defence-in-depth keeps a single weird row from poisoning
                # the whole vote.
                continue
            scored.append((sim, row))

        if not scored:
            knn_vote.last_response = _json.dumps(  # type: ignore[attr-defined]
                {"reason": "no comparable embeddings in pool", "k": k, "pool_size": len(pool)}
            )
            knn_vote.last_parsed = None  # type: ignore[attr-defined]
            return None

        scored.sort(key=lambda t: t[0], reverse=True)
        top = scored[: max(1, k)]

        # Weighted vote: +sim for good, -sim for bad, 0 for anything else
        # (which shouldn't happen given the pool filter, but tolerated).
        # Map the signed sum into [0, 1] via ``(x + 1) / 2`` so 0.5 means
        # neighbors are evenly weighted between good and bad — which the
        # eval UI will read as "abstain" naturally without a special case.
        weighted = 0.0
        weight_total = 0.0
        for sim, row in top:
            label = (row.get("label") or "").strip().lower()
            if label == "good":
                weighted += sim
            elif label == "bad":
                weighted -= sim
            weight_total += abs(sim)

        if weight_total == 0.0:
            score = 0.5
        else:
            normalised = weighted / weight_total  # [-1, 1]
            score = max(0.0, min(1.0, (normalised + 1.0) / 2.0))

        # Persist the neighbors for the eval-row UI + training corpus. We
        # keep this LIGHT — top-k neighbors with sim + label + an input
        # snippet — because this lands in ``scorer_metadata`` JSONB and the
        # eval_runs table is already heavy.
        knn_vote.last_response = _json.dumps(  # type: ignore[attr-defined]
            {
                "k": len(top),
                "pool_size": len(pool),
                "neighbors": [
                    {
                        "id": row.get("id"),
                        "label": row.get("label"),
                        "similarity": round(sim, 4),
                        "input_snippet": (row.get("input") or "")[:160],
                    }
                    for sim, row in top
                ],
            }
        )
        knn_vote.last_parsed = score  # type: ignore[attr-defined]
        return score

    knn_vote.last_response = None  # type: ignore[attr-defined]
    knn_vote.last_parsed = None  # type: ignore[attr-defined]
    return knn_vote


def compile_scorers(
    scorer_defs: list[dict],
    call_judge: Callable[[str], float],
    scorer_traces: dict[tuple[str, str], dict[str, Any]] | None = None,
    knn_vote: Callable[..., float | None] | None = None,
) -> list[Callable[..., dict[str, Any]]]:
    """Execute each scorer's source code, wrap as Braintrust-shaped scorer.

    Modern generated scorers take ``(output, input, metadata)`` and may
    return ``None`` to skip a row (coverage scorers gate on
    ``metadata["coverage_tags"]`` so they don't hand out misleading 0%
    scores on rows that weren't testing their criterion). Older generated
    scorers (pre-gating, persisted on existing sessions) take
    ``(output, input)`` only — we detect arity via ``inspect`` and call
    them with whichever signature fits, so a session created before the
    gating change keeps working without forcing a regenerate.

    ``scorer_traces`` is an optional out-parameter dict the runner can pass
    in to capture per-(row, scorer) judge reasoning. The adapter writes
    every invocation's metadata (judge response text, skip reason, etc.)
    keyed by ``(row_id, scorer_name)``. Braintrust's own EvalResult only
    exposes per-row scores as floats, so without this side-channel the
    judge's reasoning would never reach the UI — there'd be no way to
    answer "why did this scorer give 30%?" without re-running.
    """
    import inspect as _inspect

    adapted: list[Callable[..., dict[str, Any]]] = []

    for defn in scorer_defs:
        name = defn.get("name") or "unnamed_scorer"
        code = defn.get("code") or ""
        description = defn.get("description") or ""
        scorer_type = (defn.get("type") or "").strip().lower()
        # `target_tag` is the gate the runner enforces. The match strategy
        # depends on scorer_type:
        #   coverage  → row matches when target_tag ∈ metadata.coverage_tags
        #   alignment → row matches when target_tag == metadata.feature_area
        #   safety    → no gate (output-level rules apply universally)
        # Scorers persisted on older sessions don't carry target_tag; they
        # fall back to running ungated (the pre-gating behavior) with a
        # stderr warning so the noise is visible.
        raw_tag = defn.get("target_tag")
        target_tag: str | None
        if isinstance(raw_tag, str) and raw_tag.strip():
            target_tag = raw_tag.strip()
        else:
            target_tag = None
            if scorer_type in ("coverage", "alignment"):
                print(
                    f"[eval_runner] {scorer_type} scorer '{name}' has no target_tag — "
                    "running ungated; expect off-target rows to add noise",
                    file=sys.stderr,
                )

        if not code.strip():
            print(f"[eval_runner] skipping scorer '{name}' — no code", file=sys.stderr)
            continue

        module = types.ModuleType(f"_northstar_scorer_{name}")
        module.call_judge = call_judge  # type: ignore[attr-defined]
        # Generated scorers can't `import` — inject the deterministic
        # helpers they're allowed to use directly into their namespace.
        module.re = re  # type: ignore[attr-defined]
        module.json = json  # type: ignore[attr-defined]
        module.json_schema_ok = json_schema_ok  # type: ignore[attr-defined]
        # Tier 2 B1: kNN-against-labels helper. Always injected (even when
        # the pool is empty, in which case it returns None for every call —
        # which the adapter treats as a row-skip, matching the coverage
        # gate behaviour). A None here ALSO maps to a no-op stand-in so a
        # scorer that calls ``knn_vote`` without a pool fails the row
        # gracefully instead of raising NameError.
        if knn_vote is not None:
            module.knn_vote = knn_vote  # type: ignore[attr-defined]
        else:
            def _no_knn(output, k=5):  # noqa: ARG001
                return None
            module.knn_vote = _no_knn  # type: ignore[attr-defined]
        try:
            exec(code, module.__dict__)
        except Exception as e:  # noqa: BLE001
            print(f"[eval_runner] skipping scorer '{name}' — exec failed: {e}", file=sys.stderr)
            continue

        fn = module.__dict__.get(name)
        if not callable(fn):
            print(f"[eval_runner] skipping scorer '{name}' — function not in compiled code", file=sys.stderr)
            continue

        # Probe the signature once at compile time so we don't pay the
        # introspection cost on every row. >2 positional params (output,
        # input, metadata, …) → new-style; otherwise legacy two-arg.
        try:
            sig = _inspect.signature(fn)
            takes_metadata = len([p for p in sig.parameters.values() if p.kind in (
                _inspect.Parameter.POSITIONAL_OR_KEYWORD,
                _inspect.Parameter.POSITIONAL_ONLY,
            )]) >= 3
        except (TypeError, ValueError):
            takes_metadata = False

        def _adapter(  # noqa: ARG001
            output,
            expected=None,
            input=None,
            metadata=None,
            _fn=fn,
            _name=name,
            _desc=description,
            _judge=call_judge,
            _knn=knn_vote,
            _takes_metadata=takes_metadata,
            _target_tag=target_tag,
            _scorer_type=scorer_type,
            _traces=scorer_traces,
        ):
            # Braintrust hands scorers whatever we stuffed into the eval row's
            # "input" field — which is the whole dataset row dict. North Star
            # scorers expect a string (the actual prompt). Extract it.
            if isinstance(input, dict):
                input_str = input.get("input") or ""
            else:
                input_str = input or ""

            row_metadata = metadata if isinstance(metadata, dict) else {}

            # Runner-level gate. Coverage and alignment scorers each map
            # 1:1 to a seed entry; the row's metadata says which entry
            # it exercises. We just compare strings — no LLM judgment at
            # eval time. Coverage uses tag membership (a row can exercise
            # multiple criteria); alignment uses feature_area equality
            # (a row sits in exactly one feature area). Safety scorers
            # don't gate.
            row_id = row_metadata.get("id") if isinstance(row_metadata, dict) else None

            def _record_trace(payload: dict[str, Any]) -> None:
                """Record per-(row, scorer) metadata into the optional
                side-channel so _extract_summary can attach it to per_row.
                Braintrust's own scores object only exposes floats, so this
                is the only path the judge's reasoning has to the UI.
                """
                if _traces is None or not isinstance(row_id, str):
                    return
                _traces[(row_id, _name)] = payload

            if _target_tag is not None and _scorer_type in ("coverage", "alignment"):
                if _scorer_type == "coverage":
                    tags = row_metadata.get("coverage_tags") or []
                    matched = isinstance(tags, list) and _target_tag in tags
                else:  # alignment
                    matched = row_metadata.get("feature_area") == _target_tag
                if not matched:
                    skip_meta = {
                        "description": _desc,
                        "skipped": True,
                        "skip_reason": (
                            f"row {('coverage_tags' if _scorer_type == 'coverage' else 'feature_area')} "
                            f"does not match target {_target_tag!r}"
                        ),
                    }
                    _record_trace(skip_meta)
                    return {"name": _name, "score": None, "metadata": skip_meta}

            # Reset judge + kNN side-channels so per-invocation state is fresh.
            _judge.last_response = None  # type: ignore[attr-defined]
            _judge.last_parsed = None  # type: ignore[attr-defined]
            if _knn is not None:
                _knn.last_response = None  # type: ignore[attr-defined]
                _knn.last_parsed = None  # type: ignore[attr-defined]

            try:
                if _takes_metadata:
                    raw = _fn(output, input_str, row_metadata)
                else:
                    raw = _fn(output, input_str)
            except Exception as e:  # noqa: BLE001
                err_meta = {
                    "error": f"{type(e).__name__}: {e}",
                    "description": _desc,
                }
                _record_trace(err_meta)
                return {"name": _name, "score": 0.0, "metadata": err_meta}

            # `None` is a valid return value: the scorer is opting out of
            # this row (e.g. coverage scorer for FAQ on a row that isn't
            # tagged FAQ). Surface it as score=None so Braintrust's
            # per-scorer averaging excludes the row, and so the row's
            # scores dict in our own per_row payload doesn't carry a
            # misleading 0%.
            if raw is None:
                skip_meta = {
                    "description": _desc,
                    "skipped": True,
                    "skip_reason": "scorer returned None (out-of-scope row)",
                }
                _record_trace(skip_meta)
                return {"name": _name, "score": None, "metadata": skip_meta}

            try:
                score = float(raw)
            except (TypeError, ValueError):
                score = 0.0

            metadata_out: dict[str, Any] = {"description": _desc}
            # kNN trace lands first — when a scorer uses both knn_vote and
            # call_judge (a future hybrid), both surfaces are captured.
            if _knn is not None:
                knn_text = getattr(_knn, "last_response", None)
                knn_parsed = getattr(_knn, "last_parsed", None)
                if knn_text:
                    metadata_out["knn_response"] = knn_text
                if knn_parsed is not None:
                    metadata_out["knn_score"] = knn_parsed
            judge_text = getattr(_judge, "last_response", None)
            judge_parsed = getattr(_judge, "last_parsed", None)
            if judge_text:
                # Store the full CoT reasoning, not a 2000-char prefix. The
                # tail of a judge response is the part that carries the most
                # signal — it's where the final per-sub-criterion verdict
                # and SCORE: line live after a decomposed-rubric framing
                # (see #40). Truncating here silently drops supervision
                # signal we'll want later for training a distilled judge
                # (see docs/tier3a-training-data-capture.md). The Evaluate
                # panel already renders this through a wrapping <pre> in an
                # expand-on-demand surface, so untruncated text doesn't
                # bloat the default view; it just shows the full reasoning
                # when the user opens a row's detail.
                metadata_out["judge_response"] = judge_text
            if judge_parsed is None and judge_text:
                # Scorer called the judge but we failed to parse a score.
                metadata_out["parse_warning"] = "Judge response did not contain a SCORE: line or 0-1 number."
            metadata_out["score"] = max(0.0, min(1.0, score))
            _record_trace(metadata_out)

            return {
                "name": _name,
                "score": max(0.0, min(1.0, score)),
                "metadata": metadata_out,
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

    import math

    scores = getattr(summary, "scores", None) or {}
    if isinstance(scores, dict):
        for scorer_name, stat in scores.items():
            mean = getattr(stat, "score", None)
            if mean is None and isinstance(stat, dict):
                mean = stat.get("score") or stat.get("mean")
            # Drop nan/inf — surfaces when a scorer returned None on every
            # row in older Braintrust versions that didn't filter Nones
            # before averaging. We'll recompute from per_row below.
            if isinstance(mean, (int, float)) and not math.isnan(mean) and not math.isinf(mean):
                averages[scorer_name] = float(mean)

    results = getattr(eval_handle, "results", None) or []
    for r in results[:500]:  # cap — avoid ballooning
        # Drop None scores from the per-row scores dict — they come from
        # scorers that opted out of this row (coverage gating). Keeping
        # them as null would make the UI render an awkward "0%" or break
        # numeric averaging on the frontend.
        raw_scores = dict(getattr(r, "scores", {}) or {})
        clean_scores = {k: v for k, v in raw_scores.items() if isinstance(v, (int, float)) and not math.isnan(v)}
        per_row.append(
            {
                "input": getattr(r, "input", None),
                "output": getattr(r, "output", None),
                "expected": getattr(r, "expected", None),
                "scores": clean_scores,
                "error": getattr(r, "error", None),
                "metadata": getattr(r, "metadata", {}) or {},
            }
        )

    # Backfill any missing per-scorer averages from the cleaned per-row data.
    # A scorer that returned None on every row won't appear in `averages`
    # above (Braintrust either dropped it or emitted nan); a scorer that
    # returned None on some rows but real scores on others may have a
    # contaminated mean we already filtered. Either way, computing from
    # the cleaned per_row is correct: average of the rows that scored.
    scorer_names_seen: set[str] = set()
    for entry in per_row:
        for n in (entry.get("scores") or {}).keys():
            scorer_names_seen.add(n)
    for n in scorer_names_seen:
        if n in averages:
            continue
        vals = [
            float(entry["scores"][n])
            for entry in per_row
            if isinstance(entry.get("scores", {}).get(n), (int, float))
        ]
        if vals:
            averages[n] = sum(vals) / len(vals)

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
    agent_mode: bool = False,
    allow_bash: bool = False,
    max_iterations: int = agent_task.MAX_ITERATIONS_DEFAULT,
    sandbox_root: Any | None = None,
    labeled_embeddings: list[dict] | None = None,
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
    # Tier 2 B1: build the kNN voter ONCE per run, closed over a snapshot
    # of the labeled pool. The pool is None when the caller didn't preload
    # embeddings (older callers or kNN-less runs) — make_knn_voter handles
    # that by always returning None for every call, which the adapter
    # treats as a row-skip.
    knn_vote = make_knn_voter(labeled_embeddings)
    # scorer_traces collects per-(row_id, scorer_name) judge metadata
    # (response text, parsed score, skip reason). Braintrust's per-row
    # results only expose scores as floats, so this is the only path the
    # judge's reasoning has to the UI — without it the user can never
    # answer "why did this scorer give 30%?" from the eval result alone.
    scorer_traces: dict[tuple[str, str], dict[str, Any]] = {}
    scorers = compile_scorers(scorer_defs, call_judge, scorer_traces=scorer_traces, knn_vote=knn_vote)
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

    # Per-row trace storage for agent mode. The Braintrust task fn must return
    # a string, so we collect rich traces here via a side-channel sink and
    # merge them into per_row metadata after Eval() finishes.
    agent_traces: dict[str, agent_task.AgentRunTrace] = {}

    if is_prompt_mode:
        if agent_mode:
            # Agent mode is about giving a SKILL.md tools to call; prompt-eval
            # mode evaluates a prompt template against state snapshots, where
            # tool use isn't meaningful. Refuse instead of silently ignoring.
            raise ValueError("agent_mode is not supported for prompt-eval projects.")
        task = make_task_for_prompt(
            task_client,
            prompt_target,  # type: ignore[arg-type]
            task_model,
            body_template=prompt_body_template,
        )
    elif agent_mode:
        # Agent mode: per-row sandbox + tool loop. Sandbox root defaults to
        # tmp/eval-runs/<experiment_name or auto>/ so concurrent runs don't
        # collide. Caller can override via sandbox_root for tests.
        from pathlib import Path as _Path
        if sandbox_root is None:
            sandbox_root = agent_task.default_sandbox_root(experiment_name)
        else:
            sandbox_root = _Path(sandbox_root)

        def _trace_sink(rid: str, trace: agent_task.AgentRunTrace) -> None:
            agent_traces[rid] = trace

        task = agent_task.make_agent_task(
            task_client,
            skill_body,
            task_model,
            sandbox_root=sandbox_root,
            allow_bash=allow_bash,
            max_iterations=max_iterations,
            trace_sink=_trace_sink,
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
        if agent_mode and agent_traces:
            agent_task.attach_traces_to_per_row(per_row, agent_traces)
        # Attach per-scorer judge traces collected by the adapter to each
        # per-row entry, keyed by row id from metadata. Lets the UI show
        # the judge's reasoning when the user clicks a score chip — same
        # data we've always logged to Braintrust traces, just plumbed back
        # to our own per_row payload too.
        attached_count = 0
        for entry in per_row:
            row_id = (entry.get("metadata") or {}).get("id")
            if not isinstance(row_id, str):
                continue
            sc_meta: dict[str, dict[str, Any]] = {}
            for (rid, scorer_name), trace in scorer_traces.items():
                if rid == row_id:
                    sc_meta[scorer_name] = trace
            if sc_meta:
                entry["scorer_metadata"] = sc_meta
                attached_count += 1
        # Verifies on every run that scorer reasoning is being captured.
        # If `attached_count=0` shows up in logs, the runner has fresh
        # scores but no judge text — meaning the user's UI score chips
        # will be disabled and the legacy-run hint will show. Most likely
        # cause when this happens: the backend didn't reload to this code
        # version. Restart uvicorn.
        print(
            f"[eval_runner] scorer_traces captured: {len(scorer_traces)} "
            f"(scorer, row) pairs across {attached_count}/{len(per_row)} rows",
            file=sys.stderr,
        )
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
