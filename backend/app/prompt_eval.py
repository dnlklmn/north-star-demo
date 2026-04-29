"""Prompt-eval support: registry of evaluable North Star prompts.

A prompt-eval project samples `turns` rows for a given turn_type, replays the
prompt under test against each, and scores the new output.

The "Prompt" panel of a prompt-eval workspace shows the *actual prompt* being
evaluated — rendered once at module load with placeholder text marking the
variable parts — so the user starts from the real thing, not a paraphrase.
That same rendered text is what we feed into call_skill_seed to derive
goals/users/stories/charter, exactly the way a SKILL.md body would be used in
a regular skill eval. Editing it tunes the seed pass; the prompt that runs
at eval time still lives in prompt.py and is invoked by prompt_target.
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .models import (
    SessionInput,
    SessionState,
)
from .prompt import build_generate_draft_prompt


def _source_location(fn: Callable) -> str | None:
    """Return a short repo-relative 'path:line' pointer to the prompt builder
    so the UI can tell the user where to edit. Returns None if the function
    isn't backed by a source file (e.g. defined in a REPL)."""
    try:
        src_file = inspect.getsourcefile(fn) or inspect.getfile(fn)
        if not src_file:
            return None
        _, line = inspect.getsourcelines(fn)
        # Trim to the repo root so the UI shows "backend/app/prompt.py:337"
        # rather than "/Users/.../north-star/backend/app/prompt.py:337".
        path = Path(src_file).resolve()
        for parent in path.parents:
            if (parent / ".git").exists():
                return f"{path.relative_to(parent)}:{line}"
        return f"{path.name}:{line}"
    except (OSError, TypeError):
        return None


@dataclass
class PromptTarget:
    """Static description of a North Star prompt that can be evaluated."""
    target: str  # matches turns.turn_type
    label: str
    builder_name: str
    description: str
    # The actual prompt under test, rendered once with placeholder variables so
    # both (a) the user sees the real thing in the Prompt panel and (b) the
    # seed pass has something concrete to extract goals/users/stories from.
    prompt_text: str
    build_state_from_snapshot: Callable[[dict], SessionState]
    build_prompt: Callable[[SessionState], str]
    # Substitute the placeholder strings in `body` with values from the row's
    # snapshot. Lets the eval task use the user's *edited* body as the prompt
    # template, with each row's actual goals/stories filled in at run time.
    # Without this, every prompt-eval would have to re-call build_prompt and
    # the user's in-app edits wouldn't affect what runs.
    substitute_placeholders: Callable[[str, dict], str]
    # Repo-relative "path:line" pointer to the prompt builder, computed from
    # the build_prompt function via inspect. Lets the UI show "edit this file
    # to change the prompt under test" without us hardcoding paths.
    source_path: str | None = None


# --- generate_draft (turn_type = "generate") ---

def _state_for_generate(snapshot: dict) -> SessionState:
    """Reconstruct the minimal SessionState that _generate_and_validate held
    when call_generate_draft was called. The snapshot is just goals/stories
    text — no charter (the charter is the *output*)."""
    return SessionState(
        input=SessionInput(
            business_goals=snapshot.get("business_goals"),
            user_stories=snapshot.get("user_stories"),
        ),
    )


# Render the prompt with placeholder text for its variable parts, so the user
# (and the seed LLM) sees the real prompt structure with the bits that change
# per-call clearly marked. Computed once at import — these renders are pure.
_GENERATE_PLACEHOLDER_BUSINESS_GOALS = "<your business goals — free-form text>"
_GENERATE_PLACEHOLDER_USER_STORIES = '<your user stories — "As a X, I want Y, so that Z" lines>'
_GENERATE_PLACEHOLDER_STATE = SessionState(
    input=SessionInput(
        business_goals=_GENERATE_PLACEHOLDER_BUSINESS_GOALS,
        user_stories=_GENERATE_PLACEHOLDER_USER_STORIES,
    ),
)
_GENERATE_PROMPT_TEXT = build_generate_draft_prompt(_GENERATE_PLACEHOLDER_STATE)


def _substitute_for_generate(body: str, snapshot: dict) -> str:
    """Replace generate-target placeholders in `body` with the row's actual
    goals/stories. Exact-string substitution — if the user edited the
    placeholder text itself we silently fall through, which is the right
    failure mode (their edits become a static prompt, no surprise vars)."""
    business_goals = (snapshot.get("business_goals") or "").strip() or "(none provided)"
    user_stories = (snapshot.get("user_stories") or "").strip() or "(none provided)"
    return (
        body
        .replace(_GENERATE_PLACEHOLDER_BUSINESS_GOALS, business_goals)
        .replace(_GENERATE_PLACEHOLDER_USER_STORIES, user_stories)
    )


# --- registry ---

PROMPT_TARGETS: dict[str, PromptTarget] = {
    "generate": PromptTarget(
        target="generate",
        label="Generate charter draft",
        builder_name="build_generate_draft_prompt",
        description=(
            "Generates a structured charter (Coverage / Balance / Alignment / Rot / "
            "Safety) from the user's business goals and user stories."
        ),
        prompt_text=_GENERATE_PROMPT_TEXT,
        build_state_from_snapshot=_state_for_generate,
        build_prompt=build_generate_draft_prompt,
        substitute_placeholders=_substitute_for_generate,
        source_path=_source_location(build_generate_draft_prompt),
    ),
}


def get_prompt_target(target: str) -> PromptTarget | None:
    return PROMPT_TARGETS.get(target)


def list_prompt_targets() -> list[dict]:
    return [
        {
            "target": pt.target,
            "label": pt.label,
            "builder_name": pt.builder_name,
            "description": pt.description,
            "source_path": pt.source_path,
            "prompt_text": pt.prompt_text,
        }
        for pt in PROMPT_TARGETS.values()
    ]
