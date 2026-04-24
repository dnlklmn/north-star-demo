"""Offline smoke test for eval_runner.py internals.

Exercises compile_scorers + build_rows without touching Claude or Braintrust.
Run this after editing eval_runner.py to catch regressions quickly.
"""

from app.eval_runner import build_rows, compile_scorers


def fake_judge(_prompt: str) -> float:
    return 0.7


scorer_defs = [
    {
        "name": "alignment_good_output",
        "type": "alignment",
        "description": "Checks alignment.",
        "code": (
            "def alignment_good_output(output: str, input: str) -> float:\n"
            "    prompt = f'Rate this output: {output}'\n"
            "    return call_judge(prompt)\n"
        ),
    },
    {
        "name": "broken_scorer",
        "type": "alignment",
        "description": "Intentionally broken.",
        "code": "def broken_scorer(output, input):\n    raise ValueError('oops')\n",
    },
    {
        "name": "no_code",
        "type": "alignment",
        "description": "Empty.",
        "code": "",
    },
]

scorers = compile_scorers(scorer_defs, fake_judge)
assert len(scorers) == 2, f"expected 2 scorers (one broken kept, one empty skipped), got {len(scorers)}"

good = scorers[0](output="hello", expected="hi", input="say hi")
assert good["name"] == "alignment_good_output"
assert good["score"] == 0.7, good

broken = scorers[1](output="x", expected="y", input="z")
assert broken["score"] == 0.0, broken
assert "error" in broken["metadata"], broken

rows = [
    {"id": "1", "input": "a", "expected_output": "A", "review_status": "approved", "should_trigger": None, "coverage_tags": ["x"]},
    {"id": "2", "input": "b", "expected_output": "B", "review_status": "pending"},  # filtered by review_status
    {"id": "3", "input": "c", "expected_output": "", "review_status": "approved", "should_trigger": False},  # off-target, filtered by default
    {"id": "4", "input": "d", "expected_output": "D", "review_status": "approved", "should_trigger": True},  # positive-fire — kept always
]
default_rows = build_rows(rows, include_triggering=False)
ids = {r["input"]["id"] for r in default_rows}
assert ids == {"1", "4"}, f"expected ids 1 and 4 (standard + positive-trigger), got {ids}"

with_triggering = build_rows(rows, include_triggering=True)
ids_all = {r["input"]["id"] for r in with_triggering}
assert ids_all == {"1", "3", "4"}, f"expected ids 1, 3, 4 with include_triggering, got {ids_all}"

print("OK — compile_scorers + build_rows behave as expected")
