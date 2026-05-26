"""Unit tests for sample-skill fixtures and the shared _apply_seed_data helper.

These tests don't hit Postgres or Anthropic — they validate the in-memory
fixture shape and the helper extracted from /skill-seed so the new
/samples/{id}/sessions endpoint reuses it without drift.

The endpoint round-trip itself isn't covered here because we don't have
test-DB infra in this repo yet; the bits that aren't pure (DB writes,
turn logging) are thin wrappers around helpers that ARE tested.
"""

from __future__ import annotations

import pytest

from app.main import _apply_seed_data
from app.models import SessionState
from app.samples import SAMPLE_IDS, list_samples, load_sample, validate_all


def test_validate_all_loads_every_sample():
    """Boot-time pass must succeed. Run twice to exercise the lru_cache."""
    validate_all()
    validate_all()


def test_list_samples_returns_ids_in_registry_order():
    out = list_samples()
    assert [s.id for s in out] == list(SAMPLE_IDS)
    # Every tile has the fields the frontend renders — empty strings would
    # produce silently-broken UI.
    for s in out:
        assert s.name.strip(), f"Sample {s.id}: empty name"
        assert s.blurb.strip(), f"Sample {s.id}: empty blurb"


def test_load_sample_unknown_returns_none():
    assert load_sample("definitely-not-a-real-sample") is None


@pytest.mark.parametrize("sample_id", SAMPLE_IDS)
def test_sample_fixture_shape(sample_id: str):
    """Per-sample invariants beyond what Pydantic catches at import time."""
    sample = load_sample(sample_id)
    assert sample is not None
    assert sample.id == sample_id
    assert sample.skill_body.startswith("---\n"), (
        f"{sample_id}: SKILL.md must start with frontmatter"
    )
    assert sample.skill_name, f"{sample_id}: missing skill_name"
    assert sample.skill_description, f"{sample_id}: missing skill_description"

    # Fixture should be substantive — a sample with two examples and no
    # off-target story is a half-baked demo.
    assert len(sample.examples) >= 4, f"{sample_id}: <4 examples is too thin"
    off_target = [s for s in sample.seed["off_target_stories"]]
    assert off_target, f"{sample_id}: no off-target story — coverage demo will fall flat"

    # Charter must have task fields populated — empty input/output description
    # leaves the Skill panel rendering blank tabs.
    assert sample.charter.task.input_description
    assert sample.charter.task.output_description


@pytest.mark.parametrize("sample_id", SAMPLE_IDS)
def test_sample_examples_obey_expected_output_invariant(sample_id: str):
    """expected_output may be empty ONLY when should_trigger is False."""
    sample = load_sample(sample_id)
    assert sample is not None
    for i, ex in enumerate(sample.examples):
        if not ex.expected_output:
            assert ex.should_trigger is False, (
                f"{sample_id} example[{i}] ({ex.feature_area}): empty "
                "expected_output requires should_trigger=False"
            )


def test_apply_seed_data_populates_state_and_mirrors_input():
    """Helper drives both /skill-seed and /samples/{id}/sessions — pin its
    behavior so the two endpoints can't drift apart."""
    state = SessionState()
    data = {
        "task": {
            "input_description": "raw transactions",
            "output_description": "xlsx file",
            "sample_input": "5/3 AWS $14",
            "sample_output": "expenses.xlsx",
        },
        "goals": ["Categorize transactions", "Use SUMIF"],
        "users": ["Freelancer", "Small biz owner"],
        "positive_stories": [
            {"who": "Freelancer", "what": "paste transactions", "why": "save time"},
        ],
        "off_target_stories": [
            {"who": "Freelancer", "what": "get tax advice", "why": "deductibility"},
        ],
    }

    _apply_seed_data(state, data)

    assert state.charter.task.input_description == "raw transactions"
    assert state.charter.task.output_description == "xlsx file"
    assert state.extracted_goals == ["Categorize transactions", "Use SUMIF"]
    assert state.extracted_users == ["Freelancer", "Small biz owner"]
    assert len(state.extracted_stories) == 2
    kinds = {s["kind"] for s in state.extracted_stories}
    assert kinds == {"positive", "off_target"}

    # Mirroring — UI reads from input.goals and input.story_groups, so the
    # helper must wire them up or the populated panels render empty.
    assert state.input.goals == ["Categorize transactions", "Use SUMIF"]
    assert len(state.input.story_groups) == 1
    group = state.input.story_groups[0]
    assert group["role"] == "Freelancer"
    assert len(group["stories"]) == 2  # positive + off_target both under same who


def test_apply_seed_data_without_task_preserves_existing_charter_task():
    """The sample-load flow pre-populates state.charter.task from the fixture
    then calls _apply_seed_data with a payload that intentionally omits the
    `task` key. The helper must NOT clobber the pre-set task description with
    empty fallbacks — that's the bug the fixture-vs-charter drift review
    flagged.
    """
    state = SessionState()
    state.charter.task.input_description = "pre-set input"
    state.charter.task.output_description = "pre-set output"
    state.charter.task.sample_input = "pre-set sample in"
    state.charter.task.sample_output = "pre-set sample out"

    _apply_seed_data(state, {"goals": ["G1"], "users": [], "positive_stories": [], "off_target_stories": []})

    assert state.charter.task.input_description == "pre-set input"
    assert state.charter.task.output_description == "pre-set output"
    assert state.charter.task.sample_input == "pre-set sample in"
    assert state.charter.task.sample_output == "pre-set sample out"
    assert state.extracted_goals == ["G1"]


def test_apply_seed_data_dedupes_against_existing_state():
    """Re-applying the same seed to a state that already has entries shouldn't
    duplicate them — the helper guards both endpoints against this."""
    state = SessionState()
    state.extracted_goals = ["Categorize transactions"]
    state.extracted_users = ["Freelancer"]
    state.extracted_stories = [
        {"who": "Freelancer", "what": "paste transactions", "why": "", "kind": "positive"},
    ]
    data = {
        "goals": ["Categorize transactions", "Use SUMIF"],
        "users": ["Freelancer", "Small biz owner"],
        "positive_stories": [
            {"who": "Freelancer", "what": "paste transactions", "why": "save time"},
            {"who": "Small biz owner", "what": "track expenses", "why": "clarity"},
        ],
    }

    _apply_seed_data(state, data)

    assert state.extracted_goals == ["Categorize transactions", "Use SUMIF"]
    assert state.extracted_users == ["Freelancer", "Small biz owner"]
    # Original positive story preserved (not duplicated), new positive story added.
    assert len(state.extracted_stories) == 2
