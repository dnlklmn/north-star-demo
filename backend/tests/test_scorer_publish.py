"""Unit tests for `app.scorer_publish`.

Pure string/AST work — no DB, no network, no LLM. Covers the two scorer
shapes the hybrid-scoring generator emits:

1. **Judge** scorers (have ``judge_prompt`` / ``call_judge``) → prompt-based
   Braintrust online-scorer markdown with Mustache placeholders + choice
   rubric.
2. **Deterministic** scorers (no ``judge_prompt``, no ``call_judge``) →
   code-based Braintrust online-scorer markdown with a fenced ``python``
   block.

If you're touching `scorer_publish.py`, run this first — the publish path
has three callers (live batch export, on-demand endpoint, CLI) and they
all share this module's behavior.
"""

from __future__ import annotations

import pytest

from app.scorer_publish import (
    ScorerPublishError,
    _is_deterministic_scorer,
    scorer_to_online_md,
)


# ---- detection -------------------------------------------------------------


class TestIsDeterministicScorer:
    def test_pure_python_check_is_deterministic(self):
        code = (
            "def safety_no_pii(output, input, metadata):\n"
            "    if re.search(r'[0-9]{3}-[0-9]{2}-[0-9]{4}', output):\n"
            "        return 0.0\n"
            "    return 1.0\n"
        )
        assert _is_deterministic_scorer(code) is True

    def test_json_schema_check_is_deterministic(self):
        code = (
            "def safety_valid_json(output, input, metadata):\n"
            "    try:\n"
            "        obj = json.loads(output)\n"
            "    except Exception:\n"
            "        return 0.0\n"
            "    return 1.0 if json_schema_ok(obj, {'type': 'object', 'required': ['title']}) else 0.0\n"
        )
        assert _is_deterministic_scorer(code) is True

    def test_judge_prompt_makes_it_non_deterministic(self):
        code = (
            "def alignment_tone(output, input, metadata):\n"
            "    judge_prompt = f'Rate the tone of {output} given {input}.'\n"
            "    return call_judge(judge_prompt)\n"
        )
        assert _is_deterministic_scorer(code) is False

    def test_call_judge_alone_makes_it_non_deterministic(self):
        # Hypothetical scorer that builds the prompt inline (no named
        # `judge_prompt` variable). Still LLM-based — must not be treated
        # as deterministic.
        code = (
            "def alignment_tone(output, input, metadata):\n"
            "    return call_judge(f'Rate the tone of {output} given {input}.')\n"
        )
        assert _is_deterministic_scorer(code) is False

    def test_mentions_in_docstring_dont_count(self):
        # The AST path correctly ignores string occurrences — only real
        # assignments and calls trigger non-deterministic.
        code = (
            "def safety_no_secrets(output, input, metadata):\n"
            "    '''This scorer used to call call_judge but is now deterministic.'''\n"
            "    return 0.0 if 'sk-' in output else 1.0\n"
        )
        assert _is_deterministic_scorer(code) is True

    def test_unparseable_code_falls_back_textually(self):
        # The generator occasionally emits Python that doesn't parse
        # (bare {} in f-strings, etc). Textual fallback should still spot
        # an LLM-based scorer by string occurrence.
        broken = (
            "def alignment_x(output, input, metadata):\n"
            "    judge_prompt = f'Rate {output} — must not be {}'\n"  # bad fstring
            "    return call_judge(judge_prompt)\n"
        )
        # Sanity: it really is unparseable.
        import ast as _ast
        with pytest.raises(SyntaxError):
            _ast.parse(broken)
        assert _is_deterministic_scorer(broken) is False


# ---- scorer_to_online_md ---------------------------------------------------


class TestScorerToOnlineMd:
    def test_deterministic_scorer_emits_code_based_markdown(self):
        # The whole point of this test file: a deterministic scorer must
        # round-trip through the publish bridge without raising, producing
        # a code-based .md a user can paste into Braintrust's code-scorer
        # editor. Pre-fix this raised DeterministicScorerNotPublishable.
        code = (
            "def safety_valid_json(output, input, metadata):\n"
            "    try:\n"
            "        json.loads(output)\n"
            "    except Exception:\n"
            "        return 0.0\n"
            "    return 1.0\n"
        )
        scorer = {
            "name": "safety_valid_json",
            "description": "Output must be valid JSON.",
            "type": "safety",
            "code": code,
        }
        md = scorer_to_online_md(
            scorer, turn_type="generate", session_id="abc", scope="prompt_x"
        )

        # Frontmatter shape — same keys as judge scorers plus
        # `scoring_method: deterministic` so downstream tooling can tell
        # them apart without re-parsing the body.
        assert md.startswith("---\nname: safety_valid_json\n")
        assert "scoring_method: deterministic" in md
        assert "scorer_type: safety" in md
        assert "turn_type: generate" in md
        assert "source_session: abc" in md

        # Body contains the function source inside a fenced python block
        # — that's what makes it pasteable into a Braintrust code-based
        # online scorer.
        assert "```python" in md
        assert "def safety_valid_json(output, input, metadata):" in md
        assert "json.loads(output)" in md
        # And the namespace note so the user knows what's available at
        # runtime (the generator strips `import` lines).
        assert "json_schema_ok" in md

        # No judge-prompt artifacts leaked in (no Mustache, no rubric).
        assert "{{input}}" not in md
        assert "{{output}}" not in md
        assert "`pass`" not in md

    def test_judge_scorer_publishes_normally(self):
        scorer = {
            "name": "alignment_tone",
            "description": "Tone matches the seed's good/bad.",
            "type": "alignment",
            "code": (
                "def alignment_tone(output, input, metadata):\n"
                "    judge_prompt = f'Input: {input}\\nOutput: {output}\\nGrade the tone.'\n"
                "    return call_judge(judge_prompt)\n"
            ),
        }
        md = scorer_to_online_md(scorer, turn_type="generate", session_id="abc")
        # Frontmatter shape unchanged for judge scorers — but now also
        # carries `scoring_method: judge` so callers can branch on it.
        assert md.startswith("---\nname: alignment_tone\n")
        assert "turn_type: generate" in md
        assert "scorer_type: alignment" in md
        assert "scoring_method: judge" in md
        # Mustache-ified.
        assert "{{input}}" in md
        assert "{{output}}" in md
        # Choice-rubric tail appended.
        assert "`pass`" in md and "`fail`" in md
        # Judge body is a prompt — not wrapped in a python fence.
        assert "```python" not in md

    def test_missing_name_or_code_still_errors(self):
        with pytest.raises(ScorerPublishError):
            scorer_to_online_md({"name": "x", "code": ""})
        with pytest.raises(ScorerPublishError):
            scorer_to_online_md({"name": "", "code": "def x(): pass"})

    def test_judge_scorer_with_unsupported_interpolation_errors(self):
        # A judge scorer whose judge_prompt interpolates a function call
        # (rather than a bare name) can't be a static Braintrust template.
        # Must surface as a real ScorerPublishError so the LLM gets
        # regenerated — must NOT silently fall back to code-based.
        scorer = {
            "name": "alignment_y",
            "type": "alignment",
            "code": (
                "def alignment_y(output, input, metadata):\n"
                "    judge_prompt = f'Rate {output.upper()} given {input}.'\n"
                "    return call_judge(judge_prompt)\n"
            ),
        }
        with pytest.raises(ScorerPublishError):
            scorer_to_online_md(scorer)
