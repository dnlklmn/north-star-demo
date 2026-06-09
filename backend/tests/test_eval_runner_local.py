"""Unit tests for app.eval_runner._run_local — the local eval loop that
replaced braintrust.Eval().

These tests don't hit Anthropic. They feed _run_local a fake task fn and
plain stub scorers (matching the adapter contract from compile_scorers:
``(output, expected, input, metadata) -> {"name", "score", "metadata"}``,
where a ``None`` score means the scorer opted out of the row). They assert:
  - per_row has the expected shape and preserves input row order
  - None scores are excluded and don't pollute per-scorer averages
  - a task that raises records `error` and runs no scorers for that row
  - sequential (max_workers=1) and concurrent paths agree
"""

from __future__ import annotations

from app.eval_runner import _run_local


def _row(rid: str, prompt: str) -> dict:
    """A built row in the shape build_rows() produces."""
    return {
        "input": {"id": rid, "input": prompt},
        "expected": "",
        "metadata": {"id": rid},
        "tags": [],
    }


def _task(input_field: dict) -> str:
    if input_field.get("id") == "boom":
        raise RuntimeError("kaboom")
    return f"out:{input_field.get('input')}"


def _scorer_a(output, expected, input, metadata):
    return {"name": "a", "score": 0.5, "metadata": {"description": "a"}}


def _scorer_b(output, expected, input, metadata):
    # Opts out of row "r2" — mimics coverage gating (None => excluded).
    if metadata.get("id") == "r2":
        return {"name": "b", "score": None, "metadata": {"skipped": True}}
    return {"name": "b", "score": 1.0, "metadata": {"description": "b"}}


def _run(max_workers: int):
    rows = [_row("r1", "p1"), _row("r2", "p2"), _row("r3", "p3")]
    return _run_local(rows, _task, [_scorer_a, _scorer_b], "exp", max_workers)


def test_basic_scoring_and_order():
    url, name, averages, per_row = _run(max_workers=4)

    assert url is None
    assert name == "exp"

    # Order preserved despite concurrency.
    assert [r["metadata"]["id"] for r in per_row] == ["r1", "r2", "r3"]

    # Per-row shape.
    r1 = per_row[0]
    assert set(r1.keys()) == {"input", "output", "expected", "scores", "error", "metadata"}
    assert r1["output"] == "out:p1"
    assert r1["error"] is None
    assert r1["scores"] == {"a": 0.5, "b": 1.0}

    # None score is excluded from the row that opted out.
    assert per_row[1]["scores"] == {"a": 0.5}
    assert "b" not in per_row[1]["scores"]


def test_averages_exclude_opted_out_rows():
    _url, _name, averages, _per_row = _run(max_workers=4)
    # a scored on all 3 rows -> 0.5; b scored on r1 and r3 only -> 1.0.
    assert averages["a"] == 0.5
    assert averages["b"] == 1.0


def test_task_error_records_error_and_skips_scorers():
    calls: list[str] = []

    def counting_scorer(output, expected, input, metadata):
        calls.append(metadata.get("id"))
        return {"name": "a", "score": 0.5, "metadata": {}}

    rows = [_row("r1", "p1"), _row("boom", "x")]
    _url, _name, averages, per_row = _run_local(rows, _task, [counting_scorer], "exp", 2)

    boom = next(r for r in per_row if r["metadata"]["id"] == "boom")
    assert boom["output"] is None
    assert "kaboom" in boom["error"]
    assert boom["scores"] == {}

    # Scorer never ran on the errored row.
    assert calls == ["r1"]
    # Average reflects only the row that actually scored.
    assert averages["a"] == 0.5


def test_sequential_and_concurrent_agree():
    seq = _run(max_workers=1)
    conc = _run(max_workers=8)
    # Compare the per_row payloads (everything but ordering already asserted).
    assert seq[2] == conc[2]  # averages
    assert seq[3] == conc[3]  # per_row
