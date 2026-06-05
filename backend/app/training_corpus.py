"""Materialise eval-run traces + dataset labels into training-sample rows.

This is the A1+A2 implementation from the Tier 3A planning doc
(docs/tier3a-training-data-capture.md): parse the structured per-sub-criterion
verdicts out of each captured ``judge_response``, then join with
``datasets.examples`` to produce one row per ``(eval_run, dataset_row, scorer)``
in the shape the eventual house-judge distillation will train on.

Two concerns live in this module:

  1. **Parsing.** ``parse_judge_response`` walks the strict CoT-rubric format
     enforced by ``eval_runner.make_judge`` (see #51) and extracts each
     sub-criterion's verdict, weight, and inline reason. The strict framing
     gives ~100% hit rate on the live corpus
     (scripts/measure_parsing_hit_rate.py against /tmp/judge_corpus.jsonl),
     so this lives in code rather than a runtime-side return shape.

  2. **Joining.** ``build_training_samples`` takes an ``eval_runs`` record
     (the dict shape ``db.get_eval_run`` returns) and an example-id-keyed
     lookup of ``datasets.examples`` rows, then yields one training-sample
     dict per ``(per_row × scorer_metadata)`` pairing. Pure derived data —
     no DB writes, no LLM calls, no schema changes.

The training-sample shape matches the doc's
"What a training sample looks like" table. Disagreement-labeling fields
(``human_verdict.judge_agreement``, ``failure_modes``) are reserved in the
shape but populated only when the reviewer has captured them — see the
"Disagreement labeling" open question in the planning doc for the UX work
that fills them.

Why not Postgres?

The parser's regex/window logic is non-trivial. Porting it to a PL/pgSQL
function (or a Postgres VIEW with CTEs of regex matches) would duplicate
the live measurement code, fragment the test surface, and make the format
contract harder to evolve. The Python module composes cleanly with the
``measure_parsing_hit_rate.py`` script, the upcoming HTTP export endpoint,
and any future ETL.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, AsyncIterator, Iterable, Iterator


# ---------------------------------------------------------------------------
# Parsing — extracts per-sub-criterion verdicts from a judge_response string.
# ---------------------------------------------------------------------------
#
# The strict framing in eval_runner.make_judge mandates:
#
#   **N. <criterion name>** [PASS|PARTIAL|FAIL|N/A] (weight) — <reason>
#   ...
#   SCORE: <average>
#
# Old responses (pre-#51) used looser formats — Format A (`**N. Name**: MET
# (1.0)`) and Format B (`**N. Name (0):**`). The parser handles both so
# historical eval-runs still produce training samples; the strict format
# is just the highest-confidence subset.

# Header: bold-wrapped "N. Name", optionally followed by a colon. Non-greedy
# capture of the name so a stray ** inside reasoning doesn't swallow lines.
_HEADER_RE = re.compile(
    r"\*\*\s*(\d+)\.\s+(.+?)\*\*\s*:?\s*",
    re.IGNORECASE,
)

# Verdict tokens, in priority order (longest-first so "PARTIALLY MET" doesn't
# get half-eaten by "MET"). Each maps to a canonical class for downstream
# stats — the four sanctioned by the strict framing plus legacy variants.
_VERDICT_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("not_applicable", re.compile(r"\bNOT APPLICABLE\b|\[N/?A\]|\bN/A\b", re.IGNORECASE)),
    ("partially_met", re.compile(r"\bPARTIALLY MET\b", re.IGNORECASE)),
    ("partial", re.compile(r"\bPARTIAL\b", re.IGNORECASE)),
    ("met", re.compile(r"\bMET\b", re.IGNORECASE)),
    ("missed", re.compile(r"\bMISSED\b|\bMISS\b", re.IGNORECASE)),
    ("pass", re.compile(r"\bPASS\b", re.IGNORECASE)),
    ("fail", re.compile(r"\bFAIL\b", re.IGNORECASE)),
    ("check", re.compile(r"✓")),
    ("cross", re.compile(r"✗|❌")),
]

# Strict-format bracket label, e.g. ``[PASS]`` or ``[N/A]``. When present
# this is the canonical verdict and takes priority over any verdict
# keyword that might appear in the per-criterion reasoning text. The
# strict framing (eval_runner.make_judge, post-#51) always uses brackets,
# so for the high-confidence subset of the corpus this is what fires
# first. Map to the canonical _VERDICT_PATTERNS keys for downstream stats.
_BRACKET_VERDICT_RE = re.compile(r"\[\s*(PASS|PARTIAL|FAIL|N/?A)\s*\]", re.IGNORECASE)
_BRACKET_TO_VERDICT = {
    "PASS": "pass",
    "PARTIAL": "partial",
    "FAIL": "fail",
    "N/A": "not_applicable",
    "NA": "not_applicable",
}

# Optional numeric weight, e.g. "(0.7)" or "(1.0)" — appears after the
# verdict in Format A / strict framing, or inside the name in Format B.
_WEIGHT_RE = re.compile(r"\((\d+\.?\d*)\)")

# Final SCORE: line (same regex eval_runner.make_judge uses to extract the
# float — keep them in lockstep).
_SCORE_RE = re.compile(r"SCORE\s*:\s*(\d+\.?\d*)", re.IGNORECASE)

# Single-sentence reason: from the em-dash separator (mandated by strict
# framing) up to the next newline. The em-dash is U+2014. Falls back to
# nothing when absent (legacy format) — we keep the verdict + weight
# regardless.
_REASON_RE = re.compile(r"—\s*(.+?)(?:\n|$)")


@dataclass
class SubCriterion:
    index: int
    name: str
    verdict: str | None  # one of the canonical _VERDICT_PATTERNS keys, or None
    weight: float | None
    reason: str | None
    raw: str  # the matched header line + verdict-search window; debugging aid


@dataclass
class ParseResult:
    sub_criteria: list[SubCriterion]
    score: float | None  # the SCORE: line value, if found
    has_final_score_line: bool


def parse_judge_response(text: str) -> ParseResult:
    """Extract sub-criteria + score from a captured judge_response.

    Designed for the strict format eval_runner.make_judge mandates post-#51,
    with graceful handling of the two legacy format families. See
    ``_VERDICT_PATTERNS`` for the recognised verdict labels.

    Returns a ParseResult even on total parse failure — the caller checks
    ``len(sub_criteria)`` and ``has_final_score_line`` to classify.
    """
    if not text:
        return ParseResult(sub_criteria=[], score=None, has_final_score_line=False)

    headers = list(_HEADER_RE.finditer(text))
    sub_criteria: list[SubCriterion] = []

    for i, m in enumerate(headers):
        index = int(m.group(1))
        name = m.group(2).strip()
        end = headers[i + 1].start() if i + 1 < len(headers) else len(text)
        window = text[m.end():end][:400]  # bound the search window — verdict is near the header

        # Format B: weight inside the bold name. Pull it back out so we can
        # classify, and trim it from the visible name.
        inside_weight = _WEIGHT_RE.search(name)
        if inside_weight:
            name = name[: inside_weight.start()].rstrip(" :,-")

        # Strict-format bracket label takes priority — when present, the
        # judge committed to a canonical verdict per the post-#51 framing,
        # and we don't want a keyword in the reasoning prose to override
        # it. Only fall back to the broader keyword scan when no bracket
        # exists (legacy formats, edge cases).
        verdict: str | None = None
        bracket = _BRACKET_VERDICT_RE.search(window)
        if bracket:
            label = bracket.group(1).upper().replace("/", "")
            verdict = _BRACKET_TO_VERDICT.get(label) or _BRACKET_TO_VERDICT.get(label.replace("/", ""))
        if verdict is None:
            for key, pat in _VERDICT_PATTERNS:
                if pat.search(window):
                    verdict = key
                    break

        # If only the inside-weight survived (Format B with no verb label),
        # derive a verdict from the numeric: 1.0 → met, 0.0 → fail, between
        # → partial. Matches how the model expresses partials in Format B.
        if verdict is None and inside_weight:
            try:
                w = float(inside_weight.group(1))
            except ValueError:
                w = None
            if w is not None:
                if w >= 0.99:
                    verdict = "met"
                elif w <= 0.01:
                    verdict = "fail"
                else:
                    verdict = "partial"

        # Weight precedence: inside-header (Format B) wins; otherwise look
        # in the post-header window (Format A / strict).
        weight: float | None
        if inside_weight:
            try:
                weight = float(inside_weight.group(1))
            except ValueError:
                weight = None
        else:
            wm = _WEIGHT_RE.search(window[:80])
            weight = float(wm.group(1)) if wm else None

        reason_match = _REASON_RE.search(window)
        reason = reason_match.group(1).strip() if reason_match else None

        sub_criteria.append(SubCriterion(
            index=index,
            name=name,
            verdict=verdict,
            weight=weight,
            reason=reason,
            raw=(m.group(0) + window[:120]).strip().replace("\n", " "),
        ))

    score_match = _SCORE_RE.search(text)
    return ParseResult(
        sub_criteria=sub_criteria,
        score=float(score_match.group(1)) if score_match else None,
        has_final_score_line=bool(score_match),
    )


# ---------------------------------------------------------------------------
# Joining — produces one training-sample dict per (per_row × scorer) pairing.
# ---------------------------------------------------------------------------


def build_training_samples(
    eval_run: dict[str, Any],
    examples_by_id: dict[str, dict[str, Any]],
    *,
    include_skipped: bool = False,
    include_deterministic: bool = False,
) -> Iterator[dict[str, Any]]:
    """Walk an eval-run's per_row and yield one training-sample dict per
    ``(dataset_row × scorer)`` pairing.

    ``eval_run`` is the dict returned by ``db.get_eval_run`` (or a sufficiently-
    shaped subset — at minimum: ``id``, ``per_row``, ``judge_model_used``,
    ``seed_snapshot``, ``finished_at``).

    ``examples_by_id`` is a lookup keyed by example id. We treat misses as
    "the row exists but we lack reviewer context"; the sample is still
    emitted with ``human_*`` fields set to None. Callers can pass an empty
    dict when they don't care about supervision (e.g. for parser-only
    inspection).

    By default we skip:
      - gated-out scorers (``skipped == True``) — they're not real
        observations, just bookkeeping artifacts of the runtime's coverage/
        alignment gating;
      - deterministic scorers (no ``judge_response``) — they don't produce
        a CoT trace to train against and shouldn't dilute the corpus.

    Both can be opted into via flags, useful for downstream analysis that
    wants the full pairing (e.g. counting how often each row hits the
    gating filter).

    Yields plain dicts (not Pydantic models) so callers can JSONL-serialise
    without an extra .model_dump() pass.
    """
    per_row = eval_run.get("per_row") or []
    judge_model = eval_run.get("judge_model_used")
    seed_snapshot = eval_run.get("seed_snapshot")
    eval_run_id = eval_run.get("id")
    finished_at = eval_run.get("finished_at")

    # finished_at can be a datetime (from db.get_eval_run) or a string (from
    # an SSE / JSON re-fetch). Normalize to ISO so JSONL stays stable across
    # call sites without leaking driver-specific types.
    if hasattr(finished_at, "isoformat"):
        finished_at = finished_at.isoformat()

    for row in per_row:
        if not isinstance(row, dict):
            continue
        scorer_metadata = row.get("scorer_metadata") or {}
        if not isinstance(scorer_metadata, dict):
            continue

        row_input = row.get("input")
        row_id = row_input.get("id") if isinstance(row_input, dict) else None
        example = examples_by_id.get(row_id) if row_id else None

        # Pull supervision context from the example record. judge_verdict
        # carries the auto-review verdict (separate from the eval-time
        # judge response); review_notes captures whatever a human typed in
        # the row-detail panel.
        if example:
            human_label = example.get("label")
            human_review_status = example.get("review_status")
            judge_verdict = example.get("judge_verdict")
            human_notes = (judge_verdict or {}).get("reviewer_note") if isinstance(judge_verdict, dict) else None
        else:
            human_label = None
            human_review_status = None
            human_notes = None

        for scorer_name, meta in scorer_metadata.items():
            if not isinstance(meta, dict):
                continue

            if meta.get("skipped") and not include_skipped:
                continue

            judge_response = meta.get("judge_response")
            if not judge_response and not include_deterministic:
                # No judge text → likely a deterministic scorer. Skip unless
                # the caller specifically wants them.
                continue

            parsed = parse_judge_response(judge_response) if judge_response else ParseResult([], None, False)

            yield {
                # Sample identity
                "eval_run_id": eval_run_id,
                "row_id": row_id,
                "scorer_name": scorer_name,
                # The model's input/output
                "input": row_input,
                "output": row.get("output"),
                # Scoring trace
                "judge_score": meta.get("score"),
                "judge_reasoning": judge_response,
                "judge_per_sub_criteria": [
                    {
                        "index": sc.index,
                        "name": sc.name,
                        "verdict": sc.verdict,
                        "weight": sc.weight,
                        "reason": sc.reason,
                    }
                    for sc in parsed.sub_criteria
                ],
                "parse_complete": (
                    bool(parsed.sub_criteria)
                    and parsed.has_final_score_line
                    and all(sc.verdict is not None for sc in parsed.sub_criteria)
                ),
                # Per-scorer metadata
                "scorer_description": meta.get("description"),
                "scorer_skipped": bool(meta.get("skipped")),
                # Supervision (may be None — captured only for reviewed rows)
                "human_label": human_label,
                "human_review_status": human_review_status,
                "human_notes": human_notes,
                # Agreement is a derived signal — populated when both sides
                # are present. Coarse for now: PASS/FAIL by score threshold.
                "agreement": _compute_agreement(meta.get("score"), human_label),
                # Provenance
                "model_used": judge_model,
                "seed_snapshot": seed_snapshot,
                "created_at": finished_at,
            }


def _compute_agreement(judge_score: float | None, human_label: str | None) -> str | None:
    """Coarse judge-vs-human agreement: does the score's PASS/FAIL bucket
    match the reviewer's good/bad label?

    Returns ``"agree"``, ``"disagree"``, or ``None`` when either side is
    missing. ``None`` is the common case today — most rows aren't reviewed.
    Disagreements are the most-informative training rows; this lets the
    corpus highlight them without an extra query.

    The threshold (0.5) is intentionally coarse — finer-grained agreement
    (e.g. "judge said partial, reviewer said good") needs the richer
    reviewer schema from the planning doc's open question, which is a
    separate PR.
    """
    if judge_score is None or human_label not in ("good", "bad"):
        return None
    judge_pass = judge_score >= 0.5
    human_pass = human_label == "good"
    return "agree" if judge_pass == human_pass else "disagree"


# ---------------------------------------------------------------------------
# Higher-level entry: stream samples for a whole session.
# ---------------------------------------------------------------------------


async def iter_training_samples_for_session(
    session_id: str,
    *,
    include_skipped: bool = False,
    include_deterministic: bool = False,
    eval_run_limit: int = 50,
) -> AsyncIterator[dict[str, Any]]:
    """Stream training samples for every eval run in a session.

    Reads from the DB lazily — per eval run, loads its dataset's examples
    once and re-uses the lookup across all per_row rows. This avoids the
    cross-join blowup of fetching examples once globally and then
    re-filtering.

    Returns an async generator so callers can stream to disk / HTTP / SSE
    without materialising the whole corpus in memory.
    """
    from . import db  # local import — keeps the module importable without DB

    runs = await db.list_eval_runs(session_id, limit=eval_run_limit)
    for run_summary in runs:
        full = await db.get_eval_run(run_summary["id"])
        if not full:
            continue

        examples_by_id: dict[str, dict[str, Any]] = {}
        # Each eval run scopes to one dataset implicitly: per_row rows came
        # from one dataset. We don't store the dataset_id on eval_runs
        # directly, so derive it from the first per_row's input metadata.
        # Fall back to no supervision when that's missing.
        per_row = full.get("per_row") or []
        dataset_id = None
        for row in per_row:
            row_input = row.get("input") if isinstance(row, dict) else None
            if isinstance(row_input, dict) and row_input.get("dataset_id"):
                dataset_id = row_input["dataset_id"]
                break

        if dataset_id:
            examples = await db.get_examples(dataset_id)
            examples_by_id = {ex["id"]: ex for ex in examples if ex.get("id")}

        # Plain `yield from` is invalid in async generators (PEP 525); spell
        # out the bridge from the sync inner generator to the async outer.
        for sample in build_training_samples(
            full,
            examples_by_id,
            include_skipped=include_skipped,
            include_deterministic=include_deterministic,
        ):
            yield sample


def iter_training_samples_sync(
    eval_run: dict[str, Any],
    examples: Iterable[dict[str, Any]],
    *,
    include_skipped: bool = False,
    include_deterministic: bool = False,
) -> Iterator[dict[str, Any]]:
    """Sync convenience for callers that already have an eval_run + examples
    list in hand (tests, the offline corpus-export script).
    """
    by_id = {ex["id"]: ex for ex in examples if ex.get("id")}
    return build_training_samples(
        eval_run,
        by_id,
        include_skipped=include_skipped,
        include_deterministic=include_deterministic,
    )
