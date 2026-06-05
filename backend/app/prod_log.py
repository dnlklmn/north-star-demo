"""Track 5 — Observer: production monitoring for deployed features.

Every call to a deployed feature lands here as a ``ProdLogRecord`` (see
``contracts.py``). The record carries the input, the output, the full
``Trace``, and an initially-empty ``scores`` list. We then kick off async
scorer runs against the generated scorer files in
``app/scorers/generated/skill__<id>/``; each score fills in a beat later.
That deliberate "scoring…" → score arrival is the legibility-as-engagement
UX the Observer panel surfaces.

Storage is an in-memory dict keyed by ``skill_id``. See the bottom of this
module for the note that this should become a Postgres table mirroring the
``turns`` pattern before this is exercised in real prod traffic — the
current store is process-local and resets on reload.
"""
from __future__ import annotations

import asyncio
import inspect
import os
import sys
import time
import types
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Callable, Optional

from fastapi import APIRouter, HTTPException, Query

from . import contracts as c


# ---------------------------------------------------------------------------
# Storage — in-memory, append-only per skill_id. Concurrent updates to the
# same record (multiple scorers landing) take ``_LOCK`` to avoid clobbering
# ``scores`` while another task is mutating it.
# ---------------------------------------------------------------------------

_STORE: dict[str, list[c.ProdLogRecord]] = defaultdict(list)
_INDEX: dict[tuple[str, str], c.ProdLogRecord] = {}  # (skill_id, id) -> record
_LOCK = asyncio.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def reset_store() -> None:
    """Test hook — clear all logged records. Not exposed via API."""
    _STORE.clear()
    _INDEX.clear()


# ---------------------------------------------------------------------------
# Scorer loading — read every ``.py`` under ``scorers/generated/skill__<id>/``
# and compile it into a callable that takes ``(output, input, metadata) ->
# float | None``. Mirrors ``eval_runner.compile_scorers`` but trimmed down: we
# don't need Braintrust adapters or per-row coverage gating in prod (a prod
# call has no ``coverage_tags``; the scorers either run universally or skip
# themselves via the gate inside their own body).
# ---------------------------------------------------------------------------


def _scorers_root() -> Path:
    """Filesystem root that holds generated scorer files.

    Lives next to this module so it works both in dev (editable install) and
    in any deployment that ships the ``app/`` tree as-is.
    """
    return Path(__file__).parent / "scorers" / "generated"


def _scorer_dir(skill_id: str) -> Path:
    return _scorers_root() / f"skill__{skill_id}"


def _make_judge() -> Callable[[str], float]:
    """Lightweight Anthropic LLM-as-judge.

    Mirrors ``eval_runner.make_judge`` so scorer bodies see the same
    ``call_judge(prompt) -> float`` contract they were authored against
    (rigid ``SCORE:`` line at the end). We don't share ``eval_runner``'s
    implementation directly to keep Observer importable without Braintrust;
    we just rebuild the equivalent on the canonical ``tools.get_client``.
    """
    import re

    from . import tools  # local import; keeps prod_log import-light at module load

    client = tools.get_client()
    model = tools._resolve_model(os.environ.get("PROD_JUDGE_MODEL") or tools.get_model())

    def call_judge(prompt: str) -> float:
        framed = (
            prompt
            + "\n\n---\n"
            "Respond with your reasoning (1-2 sentences), then on a NEW FINAL LINE write:\n"
            "SCORE: <number between 0.0 and 1.0>\n"
            "The SCORE: line must be the last line of your response."
        )
        resp = client.messages.create(
            model=model,
            max_tokens=512,
            messages=[{"role": "user", "content": framed}],
        )
        text = resp.content[0].text if resp.content else ""
        m = re.search(r"SCORE\s*:\s*([0-9]*\.?[0-9]+)", text, re.IGNORECASE)
        if m:
            try:
                return max(0.0, min(1.0, float(m.group(1))))
            except ValueError:
                pass
        for tok in reversed(re.findall(r"[0-9]*\.?[0-9]+", text)):
            try:
                v = float(tok)
            except ValueError:
                continue
            if 0.0 <= v <= 1.0:
                return v
        return 0.0

    return call_judge


def _load_scorers(skill_id: str, call_judge: Callable[[str], float]) -> list[tuple[str, Callable[..., Any]]]:
    """Compile every scorer ``.py`` for ``skill_id`` into callables.

    Returns ``[(name, fn), …]``. Each ``fn`` is the raw scorer function: it
    expects ``(output, input, metadata)`` (modern) or ``(output, input)``
    (legacy two-arg). The caller picks the right arity at invocation time.

    Scorers that fail to compile are skipped with a stderr warning rather
    than crashing the whole prod-log write — partial scoring is better than
    none.
    """
    out: list[tuple[str, Callable[..., Any]]] = []
    sdir = _scorer_dir(skill_id)
    if not sdir.is_dir():
        return out

    for path in sorted(sdir.glob("*.py")):
        if path.name.startswith("_"):
            continue
        code = path.read_text(encoding="utf-8")
        if not code.strip():
            continue
        module = types.ModuleType(f"_northstar_prod_scorer_{skill_id}_{path.stem}")
        module.call_judge = call_judge  # type: ignore[attr-defined]
        try:
            exec(code, module.__dict__)
        except Exception as e:  # noqa: BLE001
            print(
                f"[prod_log] skipping scorer {path.name} for skill {skill_id} — exec failed: {e}",
                file=sys.stderr,
            )
            continue
        # Convention: the scorer function shares its stem with the file.
        fn = module.__dict__.get(path.stem)
        if not callable(fn):
            # Fallback: pick the first top-level callable that isn't call_judge.
            fn = next(
                (
                    v
                    for k, v in module.__dict__.items()
                    if callable(v) and not k.startswith("_") and k != "call_judge"
                ),
                None,
            )
            if not callable(fn):
                continue
        out.append((path.stem, fn))
    return out


def _run_one_scorer(
    fn: Callable[..., Any],
    output: str,
    input_str: str,
    metadata: dict[str, Any],
) -> tuple[Optional[float], Optional[str]]:
    """Invoke ``fn`` with whichever arity it takes. Return (score, error)."""
    try:
        sig = inspect.signature(fn)
        n_pos = len(
            [
                p
                for p in sig.parameters.values()
                if p.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.POSITIONAL_ONLY)
            ]
        )
    except (TypeError, ValueError):
        n_pos = 2
    try:
        if n_pos >= 3:
            raw = fn(output, input_str, metadata)
        else:
            raw = fn(output, input_str)
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"

    if raw is None:
        # Scorer opted out of this row (e.g. coverage-tag gate). Surface as
        # None so the UI can show "n/a" rather than 0%.
        return None, None
    try:
        return float(raw), None
    except (TypeError, ValueError):
        return 0.0, "scorer returned non-float"


# ---------------------------------------------------------------------------
# Async scoring orchestration — kicked off after the record is stored. Runs
# each scorer in a thread (Anthropic SDK is sync) so we don't block the event
# loop; collects results back onto the stored record.
# ---------------------------------------------------------------------------


async def _score_record_async(skill_id: str, record_id: str) -> None:
    """Background task: run every scorer for ``skill_id`` against the stored
    record, updating ``record.scores`` as each result arrives.

    Each scorer's pending placeholder is added BEFORE any judge calls so the
    UI can show "scoring…" badges immediately while we wait. As scorers
    complete we mutate the placeholder in place (under ``_LOCK``).
    """
    record = _INDEX.get((skill_id, record_id))
    if record is None:
        return

    # Best-effort: any failure during scoring is non-fatal — we leave the
    # placeholders or partial results in place rather than crashing.
    try:
        call_judge = await asyncio.to_thread(_make_judge)
    except Exception as e:  # noqa: BLE001
        # Without a judge, none of the LLM-as-judge scorers can run. Stamp
        # every pending slot with the error so the UI can show "no key" /
        # "rate-limited" etc., instead of an indefinite spinner.
        async with _LOCK:
            for s in record.scores:
                if s.score is None and s.error is None:
                    s.error = f"judge init failed: {type(e).__name__}: {e}"
        return

    try:
        scorers = await asyncio.to_thread(_load_scorers, skill_id, call_judge)
    except Exception as e:  # noqa: BLE001
        print(f"[prod_log] failed to load scorers for {skill_id}: {e}", file=sys.stderr)
        return

    if not scorers:
        return

    # Ensure every scorer has a pending slot upfront so the UI shows the
    # full list of "scoring…" badges from the moment the record appears.
    async with _LOCK:
        existing_names = {s.scorer for s in record.scores}
        for name, _ in scorers:
            if name not in existing_names:
                record.scores.append(c.ScorerResult(scorer=name, score=None))

    input_str = record.input if isinstance(record.input, str) else ""
    if not input_str and isinstance(record.input, dict):
        # Best-effort flatten for scorers that only know a single text field.
        input_str = str(record.input.get("input") or record.input)

    # Metadata available to scorers in prod. Prod calls don't carry the
    # dataset row's coverage_tags / feature_area, so gated scorers will
    # naturally opt out (return None) — that's the right semantics: a
    # coverage scorer is testing whether a specific scenario was handled
    # well, and prod inputs aren't pre-classified as any scenario.
    metadata: dict[str, Any] = {
        "source": "prod",
        "skill_id": skill_id,
        "record_id": record_id,
        "trace": record.trace.model_dump() if record.trace else {},
    }

    async def _run(name: str, fn: Callable[..., Any]) -> None:
        score, err = await asyncio.to_thread(
            _run_one_scorer, fn, record.output, input_str, metadata
        )
        async with _LOCK:
            for s in record.scores:
                if s.scorer == name:
                    s.score = score
                    s.error = err
                    break

    # Run scorers concurrently — the judge calls are network-bound and the
    # whole point of async UX is that the slower scorers don't gate the
    # faster ones from appearing in the UI.
    await asyncio.gather(*[_run(name, fn) for name, fn in scorers], return_exceptions=True)


# ---------------------------------------------------------------------------
# Pass-rate bucketing — coarse time-series over the in-memory log so the UI
# sparkline doesn't have to do its own grouping.
# ---------------------------------------------------------------------------


def _record_mean_score(record: c.ProdLogRecord) -> Optional[float]:
    """Mean of completed scores on a record. ``None`` if nothing has scored
    yet — caller distinguishes "still scoring" from "actually zero"."""
    scored = [s.score for s in record.scores if s.score is not None]
    if not scored:
        return None
    return sum(scored) / len(scored)


def _pass_rate_buckets(
    records: list[c.ProdLogRecord], buckets: int, threshold: float
) -> list[dict[str, Any]]:
    """Group ``records`` into ``buckets`` equal time slices and compute the
    fraction whose mean score >= ``threshold`` in each slice.

    Records with no completed scores are excluded from the rate calculation
    but still counted in ``total`` so the UI can show "5 of 20 scored".
    """
    if not records or buckets <= 0:
        return []
    ts = sorted(
        [
            _parse_iso(r.created_at) or 0.0
            for r in records
            if r.created_at is not None
        ]
    )
    if len(ts) < 2:
        # Single point — just emit one bucket.
        rate, scored, total = _bucket_stats(records, threshold)
        return [
            {
                "start": records[0].created_at,
                "end": records[-1].created_at,
                "pass_rate": rate,
                "scored": scored,
                "total": total,
            }
        ]
    t_min, t_max = ts[0], ts[-1]
    if t_max == t_min:
        rate, scored, total = _bucket_stats(records, threshold)
        return [
            {
                "start": records[0].created_at,
                "end": records[-1].created_at,
                "pass_rate": rate,
                "scored": scored,
                "total": total,
            }
        ]
    width = (t_max - t_min) / buckets
    out: list[dict[str, Any]] = []
    for i in range(buckets):
        b_start = t_min + i * width
        b_end = t_min + (i + 1) * width if i < buckets - 1 else t_max + 1
        in_bucket = [
            r
            for r in records
            if (t := _parse_iso(r.created_at)) is not None and b_start <= t < b_end
        ]
        rate, scored, total = _bucket_stats(in_bucket, threshold)
        out.append(
            {
                "start": _iso_from_ts(b_start),
                "end": _iso_from_ts(b_end),
                "pass_rate": rate,
                "scored": scored,
                "total": total,
            }
        )
    return out


def _bucket_stats(
    records: list[c.ProdLogRecord], threshold: float
) -> tuple[Optional[float], int, int]:
    total = len(records)
    means = [m for r in records if (m := _record_mean_score(r)) is not None]
    if not means:
        return None, 0, total
    passed = sum(1 for m in means if m >= threshold)
    return passed / len(means), len(means), total


def _parse_iso(s: Optional[str]) -> Optional[float]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def _iso_from_ts(t: float) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


router = APIRouter(prefix="/api", tags=["prod-log"])


@router.post("/prod-log", response_model=c.ProdLogRecord)
async def post_prod_log(record: c.ProdLogRecord) -> c.ProdLogRecord:
    """Record a single production invocation of a deployed feature.

    Body matches ``ProdLogRecord``. Stamps ``created_at`` if missing, stores
    the record, and kicks off async scorer runs whose results land on the
    same record over the next few seconds.
    """
    if not record.created_at:
        record.created_at = _now_iso()

    async with _LOCK:
        _STORE[record.skill_id].append(record)
        _INDEX[(record.skill_id, record.id)] = record

    # Fire-and-forget scoring. The task holds a reference to the stored
    # record, mutates ``scores`` in place under ``_LOCK``, and never
    # propagates exceptions to the caller (which has already returned).
    asyncio.create_task(_score_record_async(record.skill_id, record.id))
    return record


@router.get("/prod-log/{skill_id}", response_model=list[c.ProdLogRecord])
async def list_prod_log(
    skill_id: str,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    since: Annotated[
        Optional[str],
        Query(description="ISO8601 — return only records created strictly after this timestamp"),
    ] = None,
) -> list[c.ProdLogRecord]:
    """List recent prod calls for a skill, newest first.

    ``since`` lets the UI poll for new records without re-fetching the
    whole window each tick.
    """
    records = list(_STORE.get(skill_id, []))
    if since:
        cutoff = _parse_iso(since)
        if cutoff is not None:
            records = [
                r for r in records if (t := _parse_iso(r.created_at)) is not None and t > cutoff
            ]
    records.sort(key=lambda r: _parse_iso(r.created_at) or 0.0, reverse=True)
    return records[:limit]


@router.get("/prod-log/{skill_id}/outliers", response_model=list[c.ProdLogRecord])
async def list_outliers(
    skill_id: str,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
) -> list[c.ProdLogRecord]:
    """Lowest-mean-score N records for ``skill_id``.

    Records that haven't fully scored yet are excluded — surfacing a
    half-scored record as an outlier would be misleading until all
    scorers finish.
    """
    records = _STORE.get(skill_id, [])
    scored: list[tuple[float, c.ProdLogRecord]] = []
    for r in records:
        m = _record_mean_score(r)
        if m is None:
            continue
        # Only consider records whose scorers have all completed — otherwise
        # partial means rank above full means unfairly.
        if any(s.score is None and s.error is None for s in r.scores):
            continue
        scored.append((m, r))
    scored.sort(key=lambda pair: pair[0])  # ascending — worst first
    return [r for _, r in scored[:limit]]


@router.get("/prod-log/{skill_id}/pass-rate")
async def pass_rate_over_time(
    skill_id: str,
    buckets: Annotated[int, Query(ge=1, le=100)] = 20,
    threshold: Annotated[float, Query(ge=0.0, le=1.0)] = 0.75,
) -> dict[str, Any]:
    """Pass rate (fraction with mean score >= threshold) bucketed over time.

    Returns ``{"buckets": [...], "threshold": 0.75, "skill_id": ...,
    "total": N, "scored": M}``. The sparkline reads ``buckets[].pass_rate``.
    """
    records = list(_STORE.get(skill_id, []))
    total = len(records)
    scored_total = sum(1 for r in records if _record_mean_score(r) is not None)
    return {
        "skill_id": skill_id,
        "threshold": threshold,
        "total": total,
        "scored": scored_total,
        "buckets": _pass_rate_buckets(records, buckets, threshold),
    }


# ---------------------------------------------------------------------------
# Persistence caveat — see also the wiring notes / report.
#
# In-memory store: this resets on every uvicorn reload. For real prod
# traffic we want a Postgres table mirroring the ``turns`` schema:
#   prod_logs(id PK, skill_id, input JSONB, output TEXT, trace JSONB,
#             scores JSONB, latency_ms INT, error TEXT, created_at TIMESTAMPTZ)
# with the same async-update pattern (insert with null scores, UPDATE as each
# scorer completes). Until then this module is a faithful in-memory mock that
# satisfies the contract the UI codes against.
# ---------------------------------------------------------------------------
