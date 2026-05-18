"""Tests for the bundled-reference-file generators.

These are pure functions — no LLM, no DB, no network — that turn slices of
session state into markdown files plus a content signature. The signature
drives skip-if-unchanged on promote and the per-file staleness banner, so
its stability across runs matters more than the markdown shape.
"""

from __future__ import annotations

import pytest

from app.models import AlignmentEntry, Charter, DimensionCriteria, TaskDefinition
from app.references import (
    MAX_EXAMPLES,
    build_criteria_md,
    build_examples_md,
    build_off_target_md,
    generate_reference,
)


class TestExamplesMd:
    def test_empty_dataset_returns_placeholder(self):
        body, sig = build_examples_md([])
        assert "No labeled-good examples yet" in body
        assert sig  # deterministic empty signature is still set

    def test_filters_to_label_good_only(self):
        rows = [
            {"id": "1", "label": "good", "input": "in1", "expected_output": "out1", "feature_area": "x"},
            {"id": "2", "label": "bad", "input": "in2", "expected_output": "out2", "feature_area": "x"},
            {"id": "3", "label": "unlabeled", "input": "in3", "expected_output": "out3", "feature_area": "x"},
        ]
        body, _ = build_examples_md(rows)
        assert "in1" in body
        assert "in2" not in body
        assert "in3" not in body

    def test_caps_at_max(self):
        rows = [
            {"id": str(i), "label": "good", "input": f"row {i}", "expected_output": "out", "feature_area": "x"}
            for i in range(MAX_EXAMPLES + 5)
        ]
        body, _ = build_examples_md(rows)
        # the (MAX+1)th row should not appear
        assert f"row {MAX_EXAMPLES}" not in body
        assert f"row {MAX_EXAMPLES - 1}" in body

    def test_signature_stable_across_calls(self):
        rows = [{"id": "1", "label": "good", "input": "hello", "expected_output": "world", "feature_area": "x"}]
        _, sig1 = build_examples_md(rows)
        _, sig2 = build_examples_md(rows)
        assert sig1 == sig2

    def test_signature_changes_when_inputs_change(self):
        base = [{"id": "1", "label": "good", "input": "hello", "expected_output": "world", "feature_area": "x"}]
        changed = [{"id": "1", "label": "good", "input": "hello", "expected_output": "WORLD!", "feature_area": "x"}]
        _, s1 = build_examples_md(base)
        _, s2 = build_examples_md(changed)
        assert s1 != s2

    def test_signature_ignores_irrelevant_fields(self):
        # created_at, label_reason etc. shouldn't move the signature.
        base = [{"id": "1", "label": "good", "input": "hi", "expected_output": "yo", "feature_area": "x"}]
        embellished = [
            {
                "id": "1",
                "label": "good",
                "input": "hi",
                "expected_output": "yo",
                "feature_area": "x",
                "label_reason": "an extra note",
                "created_at": "2026-01-01",
            }
        ]
        _, s1 = build_examples_md(base)
        _, s2 = build_examples_md(embellished)
        assert s1 == s2

    def test_should_not_trigger_flag_surfaced_in_header(self):
        rows = [
            {
                "id": "1",
                "label": "good",
                "input": "ask about pricing",
                "expected_output": "decline",
                "feature_area": "billing",
                "should_trigger": False,
            }
        ]
        body, _ = build_examples_md(rows)
        assert "should NOT trigger" in body


class TestOffTargetMd:
    def test_empty_stories_placeholder(self):
        body, _ = build_off_target_md([])
        assert "No off-target stories captured" in body

    def test_filters_to_off_target_kind(self):
        stories = [
            {"who": "a user", "what": "asks for pricing", "why": "billing q", "kind": "off_target"},
            {"who": "a user", "what": "asks for help", "why": "support", "kind": "positive"},
            {"who": "a user", "what": "no kind set", "why": "", "kind": ""},
        ]
        body, _ = build_off_target_md(stories)
        assert "pricing" in body
        assert "asks for help" not in body
        assert "no kind set" not in body

    def test_signature_stable(self):
        s = [{"who": "a", "what": "b", "why": "c", "kind": "off_target"}]
        _, s1 = build_off_target_md(s)
        _, s2 = build_off_target_md(s)
        assert s1 == s2

    def test_signature_changes_with_text(self):
        a = [{"who": "user", "what": "x", "why": "", "kind": "off_target"}]
        b = [{"who": "user", "what": "x changed", "why": "", "kind": "off_target"}]
        _, s1 = build_off_target_md(a)
        _, s2 = build_off_target_md(b)
        assert s1 != s2


class TestCriteriaMd:
    def test_empty_charter_placeholder(self):
        body, _ = build_criteria_md(Charter())
        assert "No charter criteria yet" in body

    def test_renders_coverage_negative_alignment(self):
        charter = Charter(
            task=TaskDefinition(),
            coverage=DimensionCriteria(
                criteria=["address the user's actual question"],
                negative_criteria=["billing questions"],
            ),
            alignment=[
                AlignmentEntry(feature_area="tone", good="warm + concise", bad="snarky"),
            ],
        )
        body, _ = build_criteria_md(charter)
        assert "address the user's actual question" in body
        assert "billing questions" in body
        assert "warm + concise" in body
        assert "snarky" in body

    def test_accepts_dict_form(self):
        body, _ = build_criteria_md(
            {"coverage": {"criteria": ["c1"], "negative_criteria": []}, "alignment": []}
        )
        assert "c1" in body


class TestSignatureStability:
    """Pin the contract that drives skip-if-unchanged + per-file staleness.

    The promote flow keeps a reference's lineage stamp pinned to the version
    when its *content* last changed (not every promote). That only works if
    the signature is stable across irrelevant churn — adding more good rows
    must move the examples signature, but changing a row's `created_at`
    must not."""

    def test_examples_signature_stable_when_only_metadata_changes(self):
        rows1 = [{"id": "1", "label": "good", "input": "x", "expected_output": "y", "feature_area": "a"}]
        rows2 = [{
            "id": "1", "label": "good", "input": "x", "expected_output": "y", "feature_area": "a",
            "created_at": "2026-05-11T00:00:00Z",
            "updated_at": "2026-05-11T00:00:00Z",
            "review_status": "approved",
        }]
        _, s1 = build_examples_md(rows1)
        _, s2 = build_examples_md(rows2)
        assert s1 == s2

    def test_examples_signature_moves_when_a_row_is_added(self):
        rows1 = [{"id": "1", "label": "good", "input": "x", "expected_output": "y", "feature_area": "a"}]
        rows2 = rows1 + [{"id": "2", "label": "good", "input": "z", "expected_output": "w", "feature_area": "b"}]
        _, s1 = build_examples_md(rows1)
        _, s2 = build_examples_md(rows2)
        assert s1 != s2

    def test_criteria_signature_ignores_skill_body(self):
        # The skill body lives on charter.task and can churn every promote
        # — criteria.md must not flag stale because of it.
        a = Charter(coverage=DimensionCriteria(criteria=["c1"]))
        a.task.skill_body = "first body"
        b = Charter(coverage=DimensionCriteria(criteria=["c1"]))
        b.task.skill_body = "completely different body"
        _, sa = build_criteria_md(a)
        _, sb = build_criteria_md(b)
        assert sa == sb


class TestGenerateReference:
    def test_dispatches_by_kind(self):
        body, _ = generate_reference("examples", examples=[])
        assert "Examples" in body
        body, _ = generate_reference("off_target", stories=[])
        assert "Off-target" in body
        body, _ = generate_reference("criteria", charter={})
        assert "Self-check" in body

    def test_unknown_kind_raises(self):
        with pytest.raises(ValueError, match="nope"):
            generate_reference("nope")
