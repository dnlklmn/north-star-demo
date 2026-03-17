"""
North Star Eval
Validates the charter judge against the labeled dataset.
Runs each good/bad charter output through the judge and checks
whether the judge's verdict matches the expected label.

Usage:
  ANTHROPIC_API_KEY=your_key python north-star-eval.py
"""

import json
import re
import os
import anthropic

# ── paths ────────────────────────────────────────────────────────────────────

DATASET_PATH = "north-star-dataset.json"
JUDGE_PROMPT_PATH = "north-star-judge-prompt.md"
RESULTS_PATH = "north-star-eval-results.json"
MODEL = "claude-opus-4-5-20251101"

# ── setup ─────────────────────────────────────────────────────────────────────

client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

with open(DATASET_PATH) as f:
    dataset = json.load(f)

with open(JUDGE_PROMPT_PATH) as f:
    judge_prompt = f.read()


# ── charter formatter ─────────────────────────────────────────────────────────

def format_charter(charter: dict) -> str:
    """Convert a charter dict into readable text for the judge."""
    lines = []

    lines.append("## Coverage")
    for c in charter.get("coverage", {}).get("criteria", []):
        lines.append(f"- {c}")

    lines.append("\n## Balance")
    for c in charter.get("balance", {}).get("criteria", []):
        lines.append(f"- {c}")

    lines.append("\n## Alignment")
    for area in charter.get("alignment", []):
        lines.append(f"\n### {area['feature_area']}")
        lines.append(f"Good: {area['good']}")
        lines.append(f"Bad: {area['bad']}")

    lines.append("\n## Rot")
    for c in charter.get("rot", {}).get("criteria", []):
        lines.append(f"- {c}")

    return "\n".join(lines)


# ── judge ─────────────────────────────────────────────────────────────────────

def judge_charter(charter: dict) -> dict | None:
    """Run a charter through the judge. Returns parsed verdict or None on error."""
    charter_text = format_charter(charter)

    response = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=judge_prompt,
        messages=[
            {
                "role": "user",
                "content": (
                    "Please evaluate this charter and return your verdict as JSON.\n\n"
                    f"{charter_text}"
                ),
            }
        ],
    )

    text = response.content[0].text

    # extract JSON from the response
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        print(f"    [warn] could not parse JSON from judge response")
        return None

    try:
        return json.loads(match.group())
    except json.JSONDecodeError as e:
        print(f"    [warn] JSON parse error: {e}")
        return None


# ── eval runner ───────────────────────────────────────────────────────────────

def run_eval():
    results = []
    correct = 0
    total = 0

    print(f"Running eval against {len(dataset)} examples ({len(dataset) * 2} charters)\n")
    print("=" * 60)

    for example in dataset:
        print(f"\n{example['id']} — {example['scenario']}")

        row = {
            "id": example["id"],
            "scenario": example["scenario"],
            "coverage_tags": example.get("coverage", []),
            "good_output": {},
            "bad_output": {},
        }

        # evaluate good output
        good_verdict = judge_charter(example["good_output"])
        good_got = good_verdict.get("overall") if good_verdict else "error"
        good_correct = good_got == "good"

        row["good_output"] = {
            "expected": "good",
            "got": good_got,
            "correct": good_correct,
            "verdict": good_verdict,
        }

        if good_correct:
            correct += 1
        total += 1

        tick = "✓" if good_correct else "✗"
        print(f"  good output  {tick}  judge: {good_got}")
        if not good_correct and good_verdict:
            for v in good_verdict.get("violations", []):
                print(f"               → {v}")

        # evaluate bad output
        bad_verdict = judge_charter(example["bad_output"])
        bad_got = bad_verdict.get("overall") if bad_verdict else "error"
        bad_correct = bad_got == "bad"

        row["bad_output"] = {
            "expected": "bad",
            "got": bad_got,
            "correct": bad_correct,
            "verdict": bad_verdict,
        }

        if bad_correct:
            correct += 1
        total += 1

        tick = "✓" if bad_correct else "✗"
        print(f"  bad output   {tick}  judge: {bad_got}")
        if not bad_correct and bad_verdict:
            print(f"               → judge thought this was good")
            for dim, detail in (bad_verdict.get("dimensions") or {}).items():
                if detail.get("status") == "pass":
                    print(f"               → {dim} passed when it should have failed: {detail.get('reason')}")

        results.append(row)

    # ── summary ───────────────────────────────────────────────────────────────

    accuracy = 100 * correct // total if total else 0
    print(f"\n{'=' * 60}")
    print(f"ACCURACY: {correct}/{total} ({accuracy}%)")

    misses = [
        r for r in results
        if not r["good_output"]["correct"] or not r["bad_output"]["correct"]
    ]

    if misses:
        print(f"\nMISCLASSIFIED ({len(misses)} examples):")
        for m in misses:
            if not m["good_output"]["correct"]:
                print(f"  {m['id']} good output — judge said: {m['good_output']['got']}")
            if not m["bad_output"]["correct"]:
                print(f"  {m['id']} bad output — judge said: {m['bad_output']['got']}")
    else:
        print("\nAll examples classified correctly.")

    # ── dimension breakdown ───────────────────────────────────────────────────

    print("\nDIMENSION BREAKDOWN (false positives — bad charters judge called good):")
    dim_failures = {"coverage": 0, "balance": 0, "alignment": 0, "rot": 0}

    for r in results:
        verdict = r["bad_output"].get("verdict") or {}
        for dim, detail in (verdict.get("dimensions") or {}).items():
            if dim in dim_failures and detail.get("status") == "pass":
                dim_failures[dim] += 1

    for dim, count in dim_failures.items():
        flag = " ← worth reviewing judge rubric" if count > 0 else ""
        print(f"  {dim}: {count} false passes{flag}")

    # ── save ──────────────────────────────────────────────────────────────────

    summary = {
        "accuracy": accuracy,
        "correct": correct,
        "total": total,
        "misclassified": len(misses),
        "dimension_false_positives": dim_failures,
        "results": results,
    }

    with open(RESULTS_PATH, "w") as f:
        json.dump(summary, f, indent=2)

    print(f"\nFull results saved to {RESULTS_PATH}")
    return summary


# ── entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    run_eval()
