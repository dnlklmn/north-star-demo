"""Unit tests for the LLM-response parsers in app.tools.

These are pure-string parsers — no LLM calls, no DB, no network. They sit
between the model and the rest of the agent, so a regression here breaks
every code path that touches an LLM response. Cheap to test, high signal.
"""

from __future__ import annotations

from app.models import Suggestion, SuggestedStory
from app.tools import (
    _dedupe_stories,
    _dedupe_suggestions,
    _extract_json,
    parse_charter_update,
    parse_suggestions,
)


class TestExtractJson:
    def test_bare_json(self):
        assert _extract_json('{"a": 1}') == {"a": 1}

    def test_fenced_json(self):
        text = '```json\n{"a": 1, "b": [2, 3]}\n```'
        assert _extract_json(text) == {"a": 1, "b": [2, 3]}

    def test_fenced_without_lang(self):
        assert _extract_json('```\n{"a": 1}\n```') == {"a": 1}

    def test_prose_around_json(self):
        text = 'Here you go:\n{"a": 1}\nLet me know.'
        assert _extract_json(text) == {"a": 1}

    def test_unparseable_returns_empty(self):
        # Logged + swallowed by design — callers tolerate this and fall back
        # to empty data rather than crashing the request.
        assert _extract_json("not json at all") == {}


class TestParseCharterUpdate:
    def test_present(self):
        text = (
            'Some prose.\n'
            '```charter-update\n'
            '{"coverage": {"criteria": ["x"]}}\n'
            '```\n'
            'More prose.'
        )
        update, remaining = parse_charter_update(text)
        assert update == {"coverage": {"criteria": ["x"]}}
        assert "charter-update" not in remaining
        assert "Some prose." in remaining
        assert "More prose." in remaining

    def test_absent(self):
        update, remaining = parse_charter_update("just a regular response")
        assert update is None
        assert remaining == "just a regular response"

    def test_malformed_json_falls_back_to_none(self):
        text = '```charter-update\n{not valid json}\n```'
        update, remaining = parse_charter_update(text)
        assert update is None
        # Original text returned unchanged so the caller can show it as-is.
        assert remaining == text


class TestParseSuggestions:
    def test_happy_path(self):
        text = (
            '```suggestions\n'
            '{"suggestions": ['
            '{"section": "coverage", "text": "edge case A"},'
            '{"section": "alignment", "text": "tone", "good": "warm", "bad": "cold"}'
            '], "user_stories": ['
            '{"who": "PM", "what": "set quality bar", "why": "consistency"}'
            ']}\n'
            '```'
        )
        sugs, stories, remaining = parse_suggestions(text)
        assert [s.section for s in sugs] == ["coverage", "alignment"]
        assert sugs[1].good == "warm" and sugs[1].bad == "cold"
        assert stories[0].who == "PM"
        assert "suggestions" not in remaining

    def test_absent(self):
        sugs, stories, remaining = parse_suggestions("plain text")
        assert sugs == []
        assert stories == []
        assert remaining == "plain text"

    def test_malformed_returns_empty(self):
        sugs, stories, remaining = parse_suggestions(
            '```suggestions\n{bad json}\n```'
        )
        assert sugs == []
        assert stories == []


class TestDedupe:
    def test_dedupes_by_section_plus_first_40_chars(self):
        # Same section + same first 40 chars (after lowercase + ws collapse)
        # collapse to one. Trailing words are ignored once you're past 40.
        items = [
            Suggestion(section="coverage", text="When a candidate has 10 plus years experience"),
            Suggestion(section="coverage", text="when a candidate has 10 plus years experience but no degree"),
            Suggestion(section="balance", text="When a candidate has 10 plus years experience"),
        ]
        result = _dedupe_suggestions(items)
        assert len(result) == 2
        assert {s.section for s in result} == {"coverage", "balance"}

    def test_keeps_distinct(self):
        items = [
            Suggestion(section="coverage", text="A specific scenario"),
            Suggestion(section="coverage", text="A different specific scenario"),
        ]
        assert len(_dedupe_suggestions(items)) == 2

    def test_stories_dedupe_by_who_and_what(self):
        items = [
            SuggestedStory(who="PM", what="set the quality bar for AI output"),
            SuggestedStory(who="pm", what="Set the quality bar for AI output"),
            SuggestedStory(who="PM", what="ship the feature on time"),
        ]
        result = _dedupe_stories(items)
        assert len(result) == 2
