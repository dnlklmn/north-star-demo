"""Unit tests for ``app.training_corpus`` — the Tier 3A A1+A2 module.

Two layers:

1. ``parse_judge_response`` — extracts sub-criteria + score from the
   captured CoT text. Tested against representative samples covering the
   strict format (post-#51), Format A (Met/Partial), Format B (weight
   inside the bold name), and degenerate cases.

2. ``build_training_samples`` — joins an eval-run record with an
   examples-by-id lookup and yields the training-sample dicts the
   distillation pipeline will eventually train on. Tested with synthetic
   in-memory eval-run fixtures so we never touch the DB.

If you're touching ``training_corpus.py``, run this first — the parsing
contract is enforced live by the eval_runner framing (#51) and the export
endpoint streams whatever shape this module produces.
"""

from __future__ import annotations


from app.training_corpus import (
    build_training_samples,
    parse_judge_response,
)


# ---- parser --------------------------------------------------------------


class TestParseJudgeResponse:
    def test_strict_format_extracts_all_fields(self):
        """The format the post-#51 framing mandates: PASS/PARTIAL/FAIL/N/A
        labels in brackets, mandatory weight, em-dash reason, final SCORE line."""
        text = (
            "**1. Source fidelity** [PASS] (1.0) — The title matches the email subject exactly.\n"
            "**2. Null discipline** [N/A] (0.5) — Subject line is present so null handling does not apply.\n"
            "**3. No invention** [FAIL] (0.0) — Adds 'urgent' that does not appear in the source.\n"
            "\nSCORE: 0.5\n"
        )
        result = parse_judge_response(text)
        assert result.has_final_score_line is True
        assert result.score == 0.5
        assert len(result.sub_criteria) == 3

        # Per-criterion verdicts in priority order from _VERDICT_PATTERNS.
        verdicts = [sc.verdict for sc in result.sub_criteria]
        assert verdicts == ["pass", "not_applicable", "fail"]

        weights = [sc.weight for sc in result.sub_criteria]
        assert weights == [1.0, 0.5, 0.0]

        # Reason capture: em-dash + first sentence
        assert "title matches the email subject" in result.sub_criteria[0].reason
        assert result.sub_criteria[2].reason.startswith("Adds 'urgent'")

    def test_format_a_legacy_met_partial(self):
        """Pre-#51 Format A: colon after the bold name, verb-style verdict."""
        text = (
            "**1. Conciseness**: MET (1.0) - The reply is two sentences.\n"
            "**2. Tone**: PARTIALLY MET (0.7) - Slightly salesy in the second sentence.\n"
            "\nSCORE: 0.85\n"
        )
        result = parse_judge_response(text)
        assert result.score == 0.85
        assert len(result.sub_criteria) == 2
        # PARTIALLY MET is recognised distinctly from MET (longest-first ordering).
        assert result.sub_criteria[0].verdict == "met"
        assert result.sub_criteria[1].verdict == "partially_met"

    def test_format_b_weight_inside_bold(self):
        """Pre-#51 Format B: weight crammed into the bold name when judge
        gave a low score. Parser pulls the weight back out and derives the
        verdict from it when no verb label is present."""
        text = (
            "**1. Acknowledges missing context (0):**\n"
            "Did not call out the lack of context at all.\n"
            "**2. Asks for clarification (1.0):**\n"
            "Asked the user for the missing input.\n"
            "\nSCORE: 0.5\n"
        )
        result = parse_judge_response(text)
        assert len(result.sub_criteria) == 2
        # Verdict derived from numeric weight: 0 → fail, 1.0 → met
        assert result.sub_criteria[0].verdict == "fail"
        assert result.sub_criteria[0].weight == 0.0
        assert result.sub_criteria[1].verdict == "met"
        assert result.sub_criteria[1].weight == 1.0
        # And the name is trimmed of the weight + trailing punctuation
        assert result.sub_criteria[0].name == "Acknowledges missing context"

    def test_missing_score_line_still_returns_sub_criteria(self):
        """A response that walks through criteria but forgets the SCORE:
        line is "partial" — we still extract whatever sub-criteria we can
        find so downstream classification can flag the missing score."""
        text = (
            "**1. Tone** [PASS] (1.0) — Concise and friendly.\n"
            "**2. Format** [PASS] (1.0) — Valid JSON.\n"
            # No SCORE: line
        )
        result = parse_judge_response(text)
        assert result.has_final_score_line is False
        assert result.score is None
        assert len(result.sub_criteria) == 2

    def test_empty_text_returns_empty_result(self):
        result = parse_judge_response("")
        assert result.sub_criteria == []
        assert result.score is None
        assert result.has_final_score_line is False

    def test_no_headers_no_sub_criteria(self):
        """Prose-only response (e.g. judge gave up on the format and wrote
        an essay) — no headers extracted, but SCORE: still recognised."""
        text = "I think this output is bad because it doesn't acknowledge the constraints. SCORE: 0.2"
        result = parse_judge_response(text)
        assert result.sub_criteria == []
        assert result.score == 0.2
        assert result.has_final_score_line is True

    def test_mentions_in_prose_do_not_create_false_positives(self):
        """Mention of 'PASS' or 'FAIL' inside reasoning of one criterion
        shouldn't create headers for it. Only ``**N. Name**`` is a header."""
        text = (
            "**1. Real criterion** [PASS] (1.0) — This passes because the response did not FAIL or include MET keywords spuriously.\n"
            "\nSCORE: 1.0\n"
        )
        result = parse_judge_response(text)
        assert len(result.sub_criteria) == 1
        assert result.sub_criteria[0].verdict == "pass"


# ---- builder -------------------------------------------------------------


def _make_eval_run(per_row, *, run_id="run-1", model="claude-haiku-4-5"):
    """Minimal eval-run fixture matching the shape db.get_eval_run returns."""
    return {
        "id": run_id,
        "judge_model_used": model,
        "seed_snapshot": {"task": {"input_description": "..."}, "alignment": []},
        "finished_at": "2026-06-05T10:00:00Z",
        "per_row": per_row,
    }


def _row(row_id, scorers, output="..."):
    """Build a single per_row entry: input dict carrying the example id,
    output text, and scorer_metadata dict keyed by scorer name."""
    return {
        "input": {"id": row_id, "dataset_id": "ds-1"},
        "output": output,
        "scorer_metadata": scorers,
    }


def _judge_meta(judge_response, score=0.8, description="Judge scorer"):
    return {
        "score": score,
        "judge_response": judge_response,
        "description": description,
    }


class TestBuildTrainingSamples:
    def test_yields_one_sample_per_row_x_scorer(self):
        """The fan-out: 2 rows × 2 judge scorers = 4 samples."""
        per_row = [
            _row("ex-1", {
                "tone": _judge_meta("**1. Tone** [PASS] (1.0) — Good.\nSCORE: 1.0"),
                "format": _judge_meta("**1. Format** [PASS] (1.0) — Valid JSON.\nSCORE: 1.0"),
            }),
            _row("ex-2", {
                "tone": _judge_meta("**1. Tone** [FAIL] (0.0) — Salesy.\nSCORE: 0.0"),
                "format": _judge_meta("**1. Format** [PASS] (1.0) — Valid JSON.\nSCORE: 1.0"),
            }),
        ]
        eval_run = _make_eval_run(per_row)
        samples = list(build_training_samples(eval_run, examples_by_id={}))
        assert len(samples) == 4
        scorer_names = {s["scorer_name"] for s in samples}
        assert scorer_names == {"tone", "format"}
        row_ids = {s["row_id"] for s in samples}
        assert row_ids == {"ex-1", "ex-2"}

    def test_skips_deterministic_scorers_by_default(self):
        """No judge_response → deterministic scorer (pure-Python check).
        Not useful for training a CoT judge; skipped unless opted in."""
        per_row = [
            _row("ex-1", {
                "json_valid": {"score": 1.0, "description": "JSON validity check"},
                "tone": _judge_meta("**1. Tone** [PASS] (1.0) — Good.\nSCORE: 1.0"),
            }),
        ]
        eval_run = _make_eval_run(per_row)
        samples = list(build_training_samples(eval_run, examples_by_id={}))
        assert len(samples) == 1
        assert samples[0]["scorer_name"] == "tone"

        # Opt-in: deterministic shows up but with empty sub_criteria.
        all_samples = list(build_training_samples(
            eval_run, examples_by_id={}, include_deterministic=True,
        ))
        assert len(all_samples) == 2
        det = next(s for s in all_samples if s["scorer_name"] == "json_valid")
        assert det["judge_per_sub_criteria"] == []
        assert det["judge_reasoning"] is None

    def test_skips_gated_scorers_by_default(self):
        """``skipped: True`` → coverage / alignment scorer that didn't apply
        to this row. Bookkeeping artifact; not a real observation."""
        per_row = [
            _row("ex-1", {
                "tone": _judge_meta("**1. Tone** [PASS] (1.0) — Good.\nSCORE: 1.0"),
                "off_target_scorer": {"skipped": True, "skip_reason": "row off-target", "description": "..."},
            }),
        ]
        eval_run = _make_eval_run(per_row)
        samples = list(build_training_samples(eval_run, examples_by_id={}))
        assert len(samples) == 1
        assert samples[0]["scorer_name"] == "tone"

    def test_joins_human_supervision_when_example_present(self):
        per_row = [
            _row("ex-1", {
                "tone": _judge_meta("**1. Tone** [PASS] (1.0) — Good.\nSCORE: 1.0", score=0.9),
            }),
        ]
        examples_by_id = {
            "ex-1": {
                "id": "ex-1",
                "label": "good",
                "review_status": "approved",
                "judge_verdict": {"reviewer_note": "Looks fine to me."},
            },
        }
        eval_run = _make_eval_run(per_row)
        sample = next(build_training_samples(eval_run, examples_by_id=examples_by_id))
        assert sample["human_label"] == "good"
        assert sample["human_review_status"] == "approved"
        assert sample["human_notes"] == "Looks fine to me."
        # Agreement: judge says 0.9 (pass), reviewer says good → agree
        assert sample["agreement"] == "agree"

    def test_agreement_disagree_when_judge_and_human_differ(self):
        per_row = [
            _row("ex-1", {
                "tone": _judge_meta("**1. Tone** [PASS] (1.0) — Good.\nSCORE: 0.9", score=0.9),
            }),
        ]
        examples_by_id = {
            "ex-1": {"id": "ex-1", "label": "bad", "review_status": "approved"},
        }
        eval_run = _make_eval_run(per_row)
        sample = next(build_training_samples(eval_run, examples_by_id=examples_by_id))
        # Judge said good, human said bad — this is exactly the kind of row
        # we want surfaced for training data quality.
        assert sample["agreement"] == "disagree"

    def test_agreement_none_when_human_not_reviewed(self):
        per_row = [
            _row("ex-1", {
                "tone": _judge_meta("**1. Tone** [PASS] (1.0) — Good.\nSCORE: 0.9"),
            }),
        ]
        eval_run = _make_eval_run(per_row)
        sample = next(build_training_samples(eval_run, examples_by_id={}))
        assert sample["human_label"] is None
        assert sample["agreement"] is None

    def test_parse_complete_flag(self):
        """``parse_complete`` summarises whether the sub-criteria parser
        succeeded against this row — distillation pipelines can use it to
        filter to the high-confidence subset."""
        good = "**1. Tone** [PASS] (1.0) — Good.\nSCORE: 1.0"
        bad = "Just some prose without structure."  # no headers, no SCORE
        per_row = [
            _row("ex-1", {"good_scorer": _judge_meta(good)}),
            _row("ex-2", {"bad_scorer": _judge_meta(bad)}),
        ]
        eval_run = _make_eval_run(per_row)
        samples = list(build_training_samples(eval_run, examples_by_id={}))
        complete = {s["scorer_name"]: s["parse_complete"] for s in samples}
        assert complete["good_scorer"] is True
        assert complete["bad_scorer"] is False

    def test_provenance_carries_through(self):
        per_row = [
            _row("ex-1", {"tone": _judge_meta("**1. T** [PASS] (1.0) — ok.\nSCORE: 1.0")}),
        ]
        eval_run = _make_eval_run(per_row, run_id="run-abc", model="opus-test")
        eval_run["seed_snapshot"] = {"alignment": [{"feature_area": "tone"}]}
        sample = next(build_training_samples(eval_run, examples_by_id={}))
        assert sample["eval_run_id"] == "run-abc"
        assert sample["model_used"] == "opus-test"
        assert sample["seed_snapshot"]["alignment"][0]["feature_area"] == "tone"
        assert sample["created_at"] == "2026-06-05T10:00:00Z"
