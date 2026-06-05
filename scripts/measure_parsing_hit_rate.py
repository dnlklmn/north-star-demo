#!/usr/bin/env python3
"""Measure sub-criteria parsing reliability against a judge corpus.

Reads JSONL produced by ``scripts/generate_judge_corpus.py`` and runs a
v0 parser against each ``judge_response``. Classifies the parse as one of:

    correct     — all expected sub-criteria extracted with a recognizable
                  verdict, final SCORE: line present.
    partial     — most sub-criteria extracted but at least one missing a
                  verdict label, or a missing final SCORE: line.
    missed      — couldn't extract any sub-criteria (parser falsifies).
    false_pos   — parser extracted MORE sub-criteria than the rubric
                  asked for (signals a wandering parser).

For each judge response the parser produces a structured shape:

    {
      "sub_criteria": [
        {"index": 1, "name": "...", "verdict": "MET", "weight": 1.0, "raw": "..."},
        ...
      ],
      "score": 0.8,           # the SCORE: line value
    }

Hit-rate bands map to the planning doc's decision rule
(docs/tier3a-training-data-capture.md):

    ≥90%  → Phase 2a wins (parse-at-extract-time).
    70-90% → tighten the generator prompt to enforce a strict line shape
             (e.g. each sub-criterion ends with [PASS|PARTIAL|FAIL]),
             re-test.
    <70%  → Phase 2b (scorers return structured shape instead of float).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Parser — v0
# ---------------------------------------------------------------------------

# Matches a sub-criterion header. Two families seen in the live corpus:
#
#   **1. Source fidelity**: ✓ ...
#   **1. Recognizes trivial/refactoring changes**: NOT APPLICABLE (0.5)
#
# The header always starts with bold-wrapped "N. Name", optionally followed
# by a colon. The verdict appears immediately after on the same line.
#
# We capture (index, name, rest-of-line) and let downstream pull a verdict
# out of the rest-of-line plus the next 200ish characters (some responses
# put the verdict on the NEXT line).
_HEADER_RE = re.compile(
    r"\*\*\s*(\d+)\.\s+(.+?)\*\*\s*:?\s*",
    re.IGNORECASE,
)

# Verdict tokens, in priority order. Longer tokens first so "PARTIALLY MET"
# doesn't get half-eaten by "MET". Each maps to a coarse class for stats —
# "pass" / "partial" / "fail" / "n/a" / "binary-pass" / "binary-fail" / "raw".
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

# Optional numeric weight after a verdict, e.g. "(0.7)" or "(1.0)".
_WEIGHT_RE = re.compile(r"\((\d+\.?\d*)\)")

# The final-line score the runtime parses to set the float — see
# eval_runner.make_judge.
_SCORE_RE = re.compile(r"SCORE\s*:\s*(\d+\.?\d*)", re.IGNORECASE)


@dataclass
class SubCriterion:
    index: int
    name: str
    verdict: str | None        # one of the keys in _VERDICT_PATTERNS, or None
    weight: float | None       # numeric weight if surfaced
    raw: str                   # the matched header line + verdict-search window


@dataclass
class ParseResult:
    sub_criteria: list[SubCriterion]
    score: float | None
    has_final_score_line: bool


def parse_judge_response(text: str) -> ParseResult:
    """Walk a judge response, extract sub-criteria + score.

    Designed for the CoT-rubric format the generator's #40 prompt produces:
    numbered ``**N. Name**:`` headers each followed by a verdict and reasoning,
    then a final ``SCORE: X.X`` line.

    The parser is deliberately lenient about how the verdict is expressed —
    real responses mix ``MET (1.0)``, ``PARTIALLY MET (0.7)``,
    ``NOT APPLICABLE (0.5)``, ``✓`` / ``✗``, and plain ``PASS``/``FAIL``.
    We classify whatever appears within ~200 chars of the header.

    Returns a ParseResult; even a "missed" response gets a result (with
    empty sub_criteria) so the caller can classify with a single check.
    """
    headers = list(_HEADER_RE.finditer(text))
    sub_criteria: list[SubCriterion] = []
    for i, m in enumerate(headers):
        index = int(m.group(1))
        name = m.group(2).strip()
        # Look ahead to the next header (or end of text) for the verdict.
        end = headers[i + 1].start() if i + 1 < len(headers) else len(text)
        window = text[m.end():end][:400]  # first 400 chars after the header

        # Two format families observed in the live corpus:
        #
        #   Format A (used when score is high):
        #     **1. Name**: MET (1.0)
        #     reasoning...
        #
        #   Format B (used when score is low):
        #     **1. Name (0):**
        #     reasoning...
        #
        # In Format B the weight is INSIDE the bold header — already eaten
        # by our name capture. Pull it back out if present and let it drive
        # the verdict classification when no verb-style label appears in the
        # post-header window.
        inside_weight = _WEIGHT_RE.search(name)
        if inside_weight:
            name = name[: inside_weight.start()].rstrip(" :,-")

        verdict: str | None = None
        for key, pat in _VERDICT_PATTERNS:
            if pat.search(window):
                verdict = key
                break

        # If the header carried an inside-weight and the window had no verb
        # verdict, derive a verdict from the weight value. 1.0 → pass,
        # 0.0 → fail, anything in between → partial. Matches how the
        # generator prompt asks the judge to express partials in Format B
        # (a fractional weight in the header).
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
        # for `(weight)` in the post-header window (Format A).
        weight: float | None
        if inside_weight:
            try:
                weight = float(inside_weight.group(1))
            except ValueError:
                weight = None
        else:
            weight_match = _WEIGHT_RE.search(window[:80])
            weight = float(weight_match.group(1)) if weight_match else None

        sub_criteria.append(SubCriterion(
            index=index,
            name=name,
            verdict=verdict,
            weight=weight,
            raw=(m.group(0) + window[:120]).strip().replace("\n", " "),
        ))

    score_match = _SCORE_RE.search(text)
    return ParseResult(
        sub_criteria=sub_criteria,
        score=float(score_match.group(1)) if score_match else None,
        has_final_score_line=bool(score_match),
    )


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

@dataclass
class SampleVerdict:
    sample_id: int
    scorer_name: str
    spec_name: str
    actual_score: float | None
    parsed_score: float | None
    sub_criteria_count: int
    sub_criteria_with_verdict: int
    has_score_line: bool
    classification: str            # correct / partial / missed / false_pos
    reason: str                    # why this classification
    parsed: ParseResult = field(default=None)  # type: ignore[assignment]


def classify(sample: dict, parsed: ParseResult, expected_count: int | None) -> SampleVerdict:
    """Bucket a single parse outcome.

    ``expected_count`` is the rubric's intended sub-criterion count.
    Today we don't have that authoritatively — the scorer code carries
    the count implicitly in its prompt. As a proxy we treat ``len >= 2``
    as "the parser found something meaningful" and check for a final
    SCORE: line. When we wire in the true expected count later (by parsing
    the scorer's judge_prompt to extract the rubric numbering), the
    classification gets sharper.
    """
    n_total = len(parsed.sub_criteria)
    n_with_verdict = sum(1 for s in parsed.sub_criteria if s.verdict is not None)

    if n_total == 0:
        classification = "missed"
        reason = "parser found no sub-criteria headers"
    elif expected_count is not None and n_total > expected_count + 1:
        classification = "false_pos"
        reason = f"extracted {n_total} sub-criteria, expected ~{expected_count}"
    elif not parsed.has_final_score_line:
        classification = "partial"
        reason = "no SCORE: final line found"
    elif n_with_verdict < n_total:
        missing = n_total - n_with_verdict
        classification = "partial"
        reason = f"{missing}/{n_total} sub-criteria missing a verdict label"
    else:
        classification = "correct"
        reason = f"all {n_total} sub-criteria + verdicts + SCORE: present"

    return SampleVerdict(
        sample_id=sample.get("_idx", -1),
        scorer_name=sample.get("scorer_name", ""),
        spec_name=sample.get("spec_name", ""),
        actual_score=sample.get("score"),
        parsed_score=parsed.score,
        sub_criteria_count=n_total,
        sub_criteria_with_verdict=n_with_verdict,
        has_score_line=parsed.has_final_score_line,
        classification=classification,
        reason=reason,
        parsed=parsed,
    )


# ---------------------------------------------------------------------------
# CLI + reporting
# ---------------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("corpus", type=Path, help="Path to judge_corpus.jsonl")
    p.add_argument(
        "--show-failures",
        type=int,
        default=3,
        help="Print this many partial/missed/false_pos examples per bucket (default: %(default)s)",
    )
    p.add_argument(
        "--score-agreement",
        action="store_true",
        help="Also report how often the parser's SCORE: value matches the runtime's saved score",
    )
    args = p.parse_args()

    if not args.corpus.exists():
        print(f"error: {args.corpus} not found", file=sys.stderr)
        return 2

    verdicts: list[SampleVerdict] = []
    by_scorer_class: dict[str, Counter] = {}

    with args.corpus.open() as f:
        for i, line in enumerate(f):
            if not line.strip():
                continue
            sample = json.loads(line)
            sample["_idx"] = i
            text = sample.get("judge_response") or ""
            parsed = parse_judge_response(text)
            verdict = classify(sample, parsed, expected_count=None)
            verdicts.append(verdict)
            by_scorer_class.setdefault(verdict.scorer_name, Counter())[verdict.classification] += 1

    total = len(verdicts)
    if total == 0:
        print("error: corpus is empty", file=sys.stderr)
        return 2

    bucket = Counter(v.classification for v in verdicts)
    correct = bucket["correct"]
    partial = bucket["partial"]
    missed = bucket["missed"]
    false_pos = bucket["false_pos"]
    hit_rate = correct / total

    print(f"\nCorpus: {args.corpus}")
    print(f"Samples: {total}")
    print(f"Distinct scorers: {len(by_scorer_class)}")
    print(f"Distinct specs: {len({v.spec_name for v in verdicts})}")
    print()
    print("Classification:")
    print(f"  correct   : {correct:4d}  ({correct/total:.0%})")
    print(f"  partial   : {partial:4d}  ({partial/total:.0%})")
    print(f"  missed    : {missed:4d}  ({missed/total:.0%})")
    print(f"  false_pos : {false_pos:4d}  ({false_pos/total:.0%})")
    print()
    print(f"Hit rate: {hit_rate:.1%}")

    # Map to the doc's bands.
    if hit_rate >= 0.90:
        band = "Phase 2a wins (≥90%): parse-at-extract-time is reliable."
    elif hit_rate >= 0.70:
        band = "Middle band (70-90%): tighten the generator prompt to enforce a strict per-criterion verdict label, re-test."
    else:
        band = "Phase 2b territory (<70%): structured scorer return needed."
    print(f"\nVerdict per planning doc: {band}")

    # Per-scorer breakdown
    print("\nPer-scorer hit rate:")
    for scorer, counts in sorted(by_scorer_class.items()):
        scorer_total = sum(counts.values())
        scorer_correct = counts.get("correct", 0)
        rate = scorer_correct / scorer_total if scorer_total else 0
        print(f"  {scorer:48s}  {scorer_correct:3d}/{scorer_total:3d}  ({rate:5.1%})")

    if args.score_agreement:
        # Sanity check on the parser's score extraction vs the runtime's saved score.
        # If we ever build a training-shape view, score divergence here would
        # break supervision alignment.
        matches = sum(
            1 for v in verdicts
            if v.actual_score is not None
            and v.parsed_score is not None
            and abs(v.actual_score - v.parsed_score) < 1e-6
        )
        relevant = sum(
            1 for v in verdicts if v.actual_score is not None and v.parsed_score is not None
        )
        print(f"\nScore agreement (parser SCORE: matches runtime saved score): {matches}/{relevant}")

    if args.show_failures:
        for cls in ("partial", "missed", "false_pos"):
            failures = [v for v in verdicts if v.classification == cls]
            if not failures:
                continue
            print(f"\n--- {cls.upper()} examples ({len(failures)} total, showing {min(args.show_failures, len(failures))}) ---")
            for v in failures[:args.show_failures]:
                print(f"  [#{v.sample_id} {v.scorer_name} / {v.spec_name}] {v.reason}")
                # Show the first ~200 chars of the response so the user can eyeball.
                # Look up the original sample to get the text.
                # (Reload the file rather than holding all in memory.)

    return 0


if __name__ == "__main__":
    sys.exit(main())
