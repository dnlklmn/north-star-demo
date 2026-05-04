"""Convert generated Python scorers into Braintrust online-scorer markdown.

Generated scorers (the ones `call_generate_scorers` emits, persisted on
``state.scorers``) are Python functions that wrap an LLM-as-judge prompt:

    def alignment_goals_extraction(output: str, input: str) -> float:
        \"\"\"...\"\"\"
        judge_prompt = f\"\"\"...{input}...{output}...\"\"\"
        return call_judge(judge_prompt)

That shape is what the offline eval harness ``evals/run_eval.py`` runs. It is
NOT what Braintrust's online-scorer UI accepts — that wants a prompt template
with Mustache placeholders ``{{input}}`` / ``{{output}}`` plus YAML
frontmatter telling our ``online_scorers.py`` registry how to filter and
which model to use.

This module bridges the two: read a scorer dict, find the ``judge_prompt``
f-string in its code, rewrite ``{input}`` / ``{output}`` to ``{{input}}`` /
``{{output}}``, wrap with frontmatter, return ready-to-write markdown.

Used by ``main._export_generated_scorers`` (live, on every /generate-scorers
call) and by the ``online_scorers.py publish`` CLI (retroactive, for sessions
generated before this bridge existed).
"""

from __future__ import annotations

import ast
import re
from typing import Any


class ScorerPublishError(ValueError):
    """Raised when a generated scorer's code can't be converted to a Braintrust
    online-scorer prompt — usually because the LLM produced something that
    doesn't match the expected ``judge_prompt = f'...'`` shape."""


def _extract_judge_prompt(code: str) -> str:
    """Pull the f-string assigned to ``judge_prompt`` out of a scorer's code.

    Tries ast parsing first (handles all valid Python f-strings cleanly,
    rejects unsupported interpolations like function calls). Falls back to
    a textual scan when the LLM emits Python that doesn't parse — e.g.
    bare ``{}`` literals inside an f-string from a prompt that mentions
    "empty object" — because for our purposes we only need the prompt's
    string content. The f-string nature only matters at Python-eval time;
    Braintrust gets a Mustache template with ``{{input}}`` / ``{{output}}``,
    so any other braces are passed through verbatim either way.
    """
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return _extract_judge_prompt_textual(code)

    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        # Match `judge_prompt = ...` (single target, simple name).
        targets = node.targets
        if len(targets) != 1 or not isinstance(targets[0], ast.Name):
            continue
        if targets[0].id != "judge_prompt":
            continue

        value = node.value
        # f-string → JoinedStr with FormattedValue + Constant parts.
        if isinstance(value, ast.JoinedStr):
            parts: list[str] = []
            for v in value.values:
                if isinstance(v, ast.Constant) and isinstance(v.value, str):
                    parts.append(v.value)
                elif isinstance(v, ast.FormattedValue):
                    # Only safe interpolations are bare names — anything else
                    # (function calls, attribute access) means the prompt
                    # depends on more than {input}/{output} and can't be a
                    # static Braintrust template. Reject loudly.
                    if isinstance(v.value, ast.Name):
                        parts.append("{" + v.value.id + "}")
                    else:
                        raise ScorerPublishError(
                            "judge_prompt has a non-name interpolation; "
                            "only bare {input}/{output} substitutions are supported"
                        )
            return "".join(parts)

        # Plain string literal — no interpolation. Still valid (the prompt
        # doesn't read input/output, so the scorer is constant — weird, but
        # we'll let it through).
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            return value.value

        raise ScorerPublishError(
            f"judge_prompt is not a string or f-string (got {type(value).__name__})"
        )

    raise ScorerPublishError("scorer code has no `judge_prompt = ...` assignment")


def _extract_judge_prompt_textual(code: str) -> str:
    """Fallback prompt extraction for scorer code that doesn't parse.

    Locates a triple-quoted f-string assigned to ``judge_prompt`` and returns
    the raw inner text. Used when the LLM produced Python with a bad f-string
    (e.g. ``{}`` literals) — the body is still useful as a prompt template.
    """
    for opener, closer in (('f"""', '"""'), ("f'''", "'''")):
        idx = code.find("judge_prompt")
        if idx < 0:
            continue
        # Walk forward from the assignment to the f-string opener.
        eq = code.find("=", idx)
        if eq < 0:
            continue
        start = code.find(opener, eq)
        if start < 0:
            continue
        body_start = start + len(opener)
        end = code.find(closer, body_start)
        if end < 0:
            continue
        return code[body_start:end]

    raise ScorerPublishError(
        "scorer code has no recognisable `judge_prompt = f\"\"\"...\"\"\"` block"
    )


def _to_mustache(prompt: str) -> str:
    """Convert Python f-string braces to Braintrust Mustache placeholders.

    Only ``{input}`` and ``{output}`` are recognized — those are the
    placeholders the judge prompt uses to splat the trace's I/O, so they
    have to round-trip exactly. Other single-brace content (rare in scorer
    prompts, but possible if the LLM mentions ``{}`` literally as data) is
    left untouched: Braintrust doesn't escape literal braces, so wrapping
    them as ``{{ ... }}`` would mangle them.
    """
    # Lookarounds keep us from double-escaping if the body is run through
    # this fn twice (idempotency for republishing) — we only match a single
    # `{` not preceded/followed by another brace.
    out = re.sub(r"(?<!\{)\{(input|output)\}(?!\})", r"{{\1}}", prompt)
    return out


# Trailing rubric Braintrust online scorers can parse out of the box. Choice
# scorers expect the model to end its response with one of these labels —
# Braintrust UI maps each to a numeric score (1.0 / 0.5 / 0.0 by default,
# tunable in the UI). We swap the generated scorers' "respond with ONLY a
# float" tail for this rubric so the same Braintrust config that already
# powers the hand-curated scorers (charter_quality, skill_seed_quality, etc.)
# works for the generated ones — no per-scorer custom parser needed.
_CHOICE_RUBRIC = """## How to respond

Give 1-2 sentences of reasoning, then end your response with ONE of these labels on its own line:

- `pass` — fully meets the criterion above
- `partial` — partly meets it, with notable gaps
- `fail` — does not meet it, or scorer payload was missing

The Braintrust online-scorer UI maps `pass` → 1.0, `partial` → 0.5, `fail` → 0.0.
"""

# Heuristic to recognise the LLM-generated tail we replace. The generated-
# scorer prompt template (build_generate_scorers_prompt in prompt.py) tells
# the LLM to write "respond with ONLY a single float", and the LLM has been
# remarkably consistent about that wording — but we still anchor on a stable
# substring rather than the exact phrase to survive small drift.
#
# Both patterns are anchored to end-of-string with `\Z` so we never devour
# more than the closing rubric — matching mid-prompt would silently truncate
# a judge prompt that happens to mention "score" or "respond" in its body.
_FLOAT_TAIL_PATTERNS = (
    re.compile(r"\n\s*Score (?:the )?[\w\s]*?on a scale of 0\.0 to 1\.0.*\Z", re.S | re.I),
    re.compile(r"\n\s*Respond with ONLY a single float[^\n]*\n?\Z", re.I),
)


def _normalize_response_tail(prompt: str) -> str:
    """Replace the generated-scorer's "respond with a float" tail with a
    Braintrust choice-scorer rubric.

    Why this is needed: Braintrust's default online-scorer parser is choice-
    based — it pattern-matches the model's response against a set of labels
    you configure in the UI. A free-form "0.85" doesn't match any label, so
    Braintrust silently records 0. The generated scorer prompts were written
    for a Python ``call_judge`` helper that parsed the float; that contract
    doesn't survive the move to Braintrust online scorers.

    Returning a structured choice (`pass` / `partial` / `fail`) lets the
    same Braintrust UI config that already runs ``skill_seed_quality`` &
    friends parse our generated scorers too — no per-scorer setup needed.

    Idempotent: if the prompt already contains a choice rubric (because we
    re-publish a session), we leave it alone.
    """
    if "`pass`" in prompt and "`fail`" in prompt:
        return prompt  # already converted
    cleaned = prompt
    for pattern in _FLOAT_TAIL_PATTERNS:
        cleaned = pattern.sub("", cleaned)
    cleaned = cleaned.rstrip() + "\n\n" + _CHOICE_RUBRIC
    return cleaned


def _yaml_escape(value: str) -> str:
    """Escape a string for inclusion in a single-line YAML frontmatter value.

    We emit unquoted strings most of the time — but if the description has
    a colon, leading dash, or starts with a quote, the YAML parser gets
    confused. Fall back to a double-quoted form with backslash-escaping in
    those cases. Keeps the frontmatter parser in online_scorers.py happy.
    """
    if not value:
        return ""
    # Trigger characters: leading punctuation YAML treats as structural,
    # or anything that breaks our hand parser (which splits on the first ":").
    needs_quote = (
        value[0] in "-?:[]{}!&*|>'\"%@`"
        or ": " in value
        or value.endswith(":")
        or "\n" in value
    )
    if not needs_quote:
        return value
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
    return f'"{escaped}"'


def scorer_to_online_md(
    scorer: dict[str, Any],
    *,
    turn_type: str | None = None,
    session_id: str | None = None,
    scope: str | None = None,
    generated_at: str | None = None,
) -> str:
    """Render a generated scorer dict as Braintrust online-scorer markdown.

    ``scorer`` is a dict with keys ``name``, ``description``, ``type``,
    ``code`` (matches what ``call_generate_scorers`` returns).

    ``turn_type`` is the Braintrust trace filter — for prompt-eval projects
    this is the ``prompt_target`` (e.g. ``"skill_seed"``) so the scorer fires
    on that prompt's traces and nothing else. Pass ``None`` to leave the
    filter blank — the user fills it in manually in the UI.
    """
    name = scorer.get("name")
    code = scorer.get("code")
    if not name or not code:
        raise ScorerPublishError("scorer is missing name or code")

    description = (scorer.get("description") or "").strip()
    scorer_type = (scorer.get("type") or "").strip()

    raw_prompt = _extract_judge_prompt(code)
    body = _normalize_response_tail(_to_mustache(raw_prompt)).strip()

    # Frontmatter: keep keys aligned with backend/app/scorers/*.md so the
    # online_scorers.py parser handles them without a special case.
    lines = ["---", f"name: {name}"]
    if turn_type:
        lines.append(f"turn_type: {turn_type}")
    if description:
        lines.append(f"description: {_yaml_escape(description)}")
    if scorer_type:
        lines.append(f"scorer_type: {scorer_type}")
    if session_id:
        lines.append(f"source_session: {session_id}")
    if scope:
        lines.append(f"source_scope: {scope}")
    if generated_at:
        lines.append(f"generated_at: {generated_at}")
    lines.append("---")
    lines.append("")
    lines.append(body)
    lines.append("")
    return "\n".join(lines)
