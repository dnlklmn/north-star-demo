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
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .models import (
    Charter,
    DimensionCriteria,
    DimensionStatus,
    SessionInput,
    SessionState,
    TaskDefinition,
)
from .prompt import (
    build_evaluate_goals_prompt,
    build_generate_draft_prompt,
    build_skill_seed_prompt,
    build_suggest_goals_prompt,
    build_suggest_stories_prompt,
)


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


# --- skill_seed (turn_type = "skill_seed") ---
#
# Seeds a fresh project from a pasted SKILL.md: the prompt extracts goals,
# users, positive_stories, off_target_stories, and a task description in one
# pass. The snapshot stores the raw skill body + name + description; we stash
# them into the SessionState's task fields so the registry's build_prompt
# shim can pluck them back out (prompt builders don't take SessionState
# directly — see _build_prompt_skill_seed below).

_SKILL_SEED_PLACEHOLDER_BODY = "<paste the SKILL.md body — markdown content the agent reads>"
_SKILL_SEED_PLACEHOLDER_NAME = "<skill name (optional)>"
_SKILL_SEED_PLACEHOLDER_DESC = "<one-line skill description (optional)>"


def _state_with_skill(body: str, name: str | None, desc: str | None) -> SessionState:
    """Stash skill_seed inputs in a SessionState by populating the task fields.

    These mirror where call_skill_seed reads from in production (via the
    SkillSeedRequest model), so the round-trip (snapshot → state → prompt)
    matches what the live agent does."""
    return SessionState(
        input=SessionInput(),
        charter=Charter(
            task=TaskDefinition(
                input_description="",
                output_description="",
                skill_name=name,
                skill_description=desc,
                skill_body=body,
            ),
            coverage=DimensionCriteria(criteria=[], status=DimensionStatus.pending),
            balance=DimensionCriteria(criteria=[], status=DimensionStatus.pending),
            alignment=[],
            rot=DimensionCriteria(criteria=[], status=DimensionStatus.pending),
            safety=DimensionCriteria(criteria=[], status=DimensionStatus.pending),
        ),
    )


def _state_for_skill_seed(snapshot: dict) -> SessionState:
    return _state_with_skill(
        snapshot.get("skill_body", "") or "",
        snapshot.get("skill_name"),
        snapshot.get("skill_description"),
    )


def _build_prompt_skill_seed(state: SessionState) -> str:
    return build_skill_seed_prompt(
        state.charter.task.skill_body or "",
        state.charter.task.skill_name,
        state.charter.task.skill_description,
    )


_SKILL_SEED_PROMPT_TEXT = build_skill_seed_prompt(
    _SKILL_SEED_PLACEHOLDER_BODY,
    _SKILL_SEED_PLACEHOLDER_NAME,
    _SKILL_SEED_PLACEHOLDER_DESC,
)


def _substitute_for_skill_seed(body: str, snapshot: dict) -> str:
    """Replace skill_seed placeholders in `body` with the row's actual fields.
    Empty/None values render as ``(none provided)`` so the prompt stays valid
    even when the seed only had a body and no name/description."""
    skill_body = (snapshot.get("skill_body") or "").strip() or "(none provided)"
    name = (snapshot.get("skill_name") or "").strip() or "(none provided)"
    desc = (snapshot.get("skill_description") or "").strip() or "(none provided)"
    return (
        body
        .replace(_SKILL_SEED_PLACEHOLDER_BODY, skill_body)
        .replace(_SKILL_SEED_PLACEHOLDER_NAME, name)
        .replace(_SKILL_SEED_PLACEHOLDER_DESC, desc)
    )


# --- suggest_goals (turn_type = "suggest_goals") ---

_SUGGEST_GOALS_PLACEHOLDER = "<existing goals — one per line>"


def _state_with_goals(goals: list[str]) -> SessionState:
    """Stash goal lists in SessionState.input.goals — the structured field
    the goals UI persists, and what the registry's substitute joins back into
    the rendered prompt body."""
    return SessionState(input=SessionInput(goals=list(goals)))


def _state_for_suggest_goals(snapshot: dict) -> SessionState:
    return _state_with_goals(snapshot.get("goals") or [])


def _build_prompt_suggest_goals(state: SessionState) -> str:
    return build_suggest_goals_prompt(state.input.goals or [])


_SUGGEST_GOALS_PROMPT_TEXT = build_suggest_goals_prompt([_SUGGEST_GOALS_PLACEHOLDER])


def _substitute_for_goal_list(body: str, snapshot: dict, placeholder: str) -> str:
    """Replace a single placeholder with a `- item` bullet list of the row's
    goals. Used by both suggest_goals and evaluate_goals (same input shape)."""
    goals = snapshot.get("goals") or []
    rendered = "\n".join(f"- {g}" for g in goals if g and g.strip()) or "(none provided)"
    return body.replace(placeholder, rendered)


def _substitute_for_suggest_goals(body: str, snapshot: dict) -> str:
    return _substitute_for_goal_list(body, snapshot, _SUGGEST_GOALS_PLACEHOLDER)


# --- evaluate_goals (turn_type = "evaluate_goals") ---

_EVALUATE_GOALS_PLACEHOLDER = "<goals to evaluate — one per line>"
_EVALUATE_GOALS_PROMPT_TEXT = build_evaluate_goals_prompt([_EVALUATE_GOALS_PLACEHOLDER])


def _state_for_evaluate_goals(snapshot: dict) -> SessionState:
    return _state_with_goals(snapshot.get("goals") or [])


def _build_prompt_evaluate_goals(state: SessionState) -> str:
    return build_evaluate_goals_prompt(state.input.goals or [])


def _substitute_for_evaluate_goals(body: str, snapshot: dict) -> str:
    return _substitute_for_goal_list(body, snapshot, _EVALUATE_GOALS_PLACEHOLDER)


# --- suggest_stories (turn_type = "suggest_stories") ---

_SUGGEST_STORIES_GOALS_PLACEHOLDER = "<existing goals — one per line>"
_SUGGEST_STORIES_STORIES_PLACEHOLDER = (
    '<existing stories — JSON array of {"who", "what", "why"} objects>'
)


def _state_with_goals_and_stories(goals: list[str], stories: list[dict]) -> SessionState:
    """Stash both lists in SessionInput.{goals, story_groups}. story_groups
    is the structured form the UI uses; we collapse here into a single bag
    keyed by role for prompt-builder consumption."""
    role_to_stories: dict[str, list[dict]] = {}
    for s in stories or []:
        if not isinstance(s, dict):
            continue
        who = (s.get("who") or "").strip()
        if not who:
            continue
        role_to_stories.setdefault(who, []).append({
            "what": s.get("what", ""),
            "why": s.get("why", ""),
            "kind": s.get("kind", "positive"),
        })
    story_groups = [{"role": role, "stories": items} for role, items in role_to_stories.items()]
    return SessionState(
        input=SessionInput(goals=list(goals), story_groups=story_groups),
    )


def _state_for_suggest_stories(snapshot: dict) -> SessionState:
    return _state_with_goals_and_stories(
        snapshot.get("goals") or [],
        snapshot.get("stories") or [],
    )


def _flatten_story_groups(state: SessionState) -> list[dict]:
    out: list[dict] = []
    for group in state.input.story_groups or []:
        role = group.get("role") if isinstance(group, dict) else None
        for item in (group.get("stories") if isinstance(group, dict) else []) or []:
            if not isinstance(item, dict):
                continue
            out.append({
                "who": role,
                "what": item.get("what", ""),
                "why": item.get("why", ""),
            })
    return out


def _build_prompt_suggest_stories(state: SessionState) -> str:
    return build_suggest_stories_prompt(state.input.goals or [], _flatten_story_groups(state))


_SUGGEST_STORIES_PROMPT_TEXT = build_suggest_stories_prompt(
    [_SUGGEST_STORIES_GOALS_PLACEHOLDER],
    [{"who": _SUGGEST_STORIES_STORIES_PLACEHOLDER, "what": "", "why": ""}],
)


def _substitute_for_suggest_stories(body: str, snapshot: dict) -> str:
    """Substitute both placeholders. Goals render as a bullet list; stories
    render as a JSON array (matches the agent's runtime input shape).

    Filters non-dict story entries to match what `_state_with_goals_and_stories`
    accepts during state reconstruction — the two paths must agree on what
    counts as a valid story or replay diverges from rendered prompt content.
    """
    goals = snapshot.get("goals") or []
    stories = [s for s in (snapshot.get("stories") or []) if isinstance(s, dict)]
    goals_block = "\n".join(f"- {g}" for g in goals if g and g.strip()) or "(none provided)"
    stories_block = json.dumps(stories, indent=2) if stories else "[]"
    return (
        body
        .replace(_SUGGEST_STORIES_GOALS_PLACEHOLDER, goals_block)
        .replace(_SUGGEST_STORIES_STORIES_PLACEHOLDER, stories_block)
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
    "skill_seed": PromptTarget(
        target="skill_seed",
        label="Seed from SKILL.md",
        builder_name="build_skill_seed_prompt",
        description=(
            "Bootstraps a fresh project from a pasted SKILL.md — extracts goals, "
            "users, positive stories, off-target stories, and a task definition."
        ),
        prompt_text=_SKILL_SEED_PROMPT_TEXT,
        build_state_from_snapshot=_state_for_skill_seed,
        build_prompt=_build_prompt_skill_seed,
        substitute_placeholders=_substitute_for_skill_seed,
        source_path=_source_location(build_skill_seed_prompt),
    ),
    "suggest_goals": PromptTarget(
        target="suggest_goals",
        label="Suggest additional goals",
        builder_name="build_suggest_goals_prompt",
        description=(
            "Proposes additional business goals that complement the user's "
            "current goal list — fires on the goals-input debounce in the UI."
        ),
        prompt_text=_SUGGEST_GOALS_PROMPT_TEXT,
        build_state_from_snapshot=_state_for_suggest_goals,
        build_prompt=_build_prompt_suggest_goals,
        substitute_placeholders=_substitute_for_suggest_goals,
        source_path=_source_location(build_suggest_goals_prompt),
    ),
    "evaluate_goals": PromptTarget(
        target="evaluate_goals",
        label="Evaluate goal quality",
        builder_name="build_evaluate_goals_prompt",
        description=(
            "Grades each business goal — flags vague or unmeasurable goals "
            "and proposes concrete rewrites. Drives the in-row feedback chips."
        ),
        prompt_text=_EVALUATE_GOALS_PROMPT_TEXT,
        build_state_from_snapshot=_state_for_evaluate_goals,
        build_prompt=_build_prompt_evaluate_goals,
        substitute_placeholders=_substitute_for_evaluate_goals,
        source_path=_source_location(build_evaluate_goals_prompt),
    ),
    "suggest_stories": PromptTarget(
        target="suggest_stories",
        label="Suggest user stories",
        builder_name="build_suggest_stories_prompt",
        description=(
            "Proposes additional user stories given the goals and any stories "
            "already captured — fires when the stories panel needs more options."
        ),
        prompt_text=_SUGGEST_STORIES_PROMPT_TEXT,
        build_state_from_snapshot=_state_for_suggest_stories,
        build_prompt=_build_prompt_suggest_stories,
        substitute_placeholders=_substitute_for_suggest_stories,
        source_path=_source_location(build_suggest_stories_prompt),
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
