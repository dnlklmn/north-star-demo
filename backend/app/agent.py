"""Agent control flow — decides what to do each turn.

No prompts live here (see prompt.py).
No LLM calls live here (see tools.py).
This file only manages state transitions and orchestrates calls.

Flow:
1. Discovery goals phase → elicit business goals one question at a time
2. Discovery stories phase → elicit user stories one question at a time
3. Generate (explicit trigger via /advance-phase) → generate + validate + suggest
4. Regenerate → regenerate full charter + validate + suggest
5. Chat turn (charter exists) → converse, maybe update sections, suggest
"""

from __future__ import annotations

import json
import logging

from .models import (
    AgentStatus,
    AlignmentEntry,
    DiscoveryPhase,
    DimensionStatus,
    SessionState,
    Suggestion,
    SuggestedStory,
    ValidationStatus,
)
from .db import create_turn
from .tools import (
    call_discovery_turn,
    call_generate_draft,
    call_validate_charter,
    call_conversational_turn,
    call_generate_suggestions,
    call_dataset_chat,
    get_max_rounds,
    parse_charter_update,
    parse_suggestions,
)

logger = logging.getLogger(__name__)


class AgentResult:
    """Result from an agent turn."""
    def __init__(
        self,
        message: str,
        tool_calls: list[str] | None = None,
        suggestions: list[Suggestion] | None = None,
        suggested_stories: list[SuggestedStory] | None = None,
        actions: list[dict] | None = None,
        action_suggestions: list[dict] | None = None,
        extracted_goals: list[str] | None = None,
        extracted_users: list[str] | None = None,
        extracted_stories: list[dict] | None = None,
    ):
        self.message = message
        self.tool_calls = tool_calls or []
        self.suggestions = suggestions or []
        self.suggested_stories = suggested_stories or []
        self.actions = actions or []
        self.action_suggestions = action_suggestions or []
        self.extracted_goals = extracted_goals or []
        self.extracted_users = extracted_users or []
        self.extracted_stories = extracted_stories or []
        self.ready_for_users = False
        self.ready_for_stories = False
        self.ready_for_charter = False
        self.suggested_goals: list[str] = []
        self.suggested_users: list[str] = []
        self.suggested_stories_options: list[dict] = []


async def run_agent_turn(
    state: SessionState,
    user_message: str | None = None,
    regenerate: bool = False,
) -> AgentResult:
    """Run one turn of the agent loop.

    Modes:
    1. No charter → discovery turn (goals or stories phase)
    2. Charter exists + regenerate → regenerate charter
    3. Charter exists + user message → chat turn to refine
    """
    # Append user message to conversation history
    if user_message:
        state.input.conversation_history.append({
            "role": "user",
            "content": user_message,
        })

    has_charter = bool(state.charter.coverage.criteria or state.charter.alignment)

    # --- Explicit regenerate ---
    if has_charter and regenerate:
        return await _generate_and_validate(state)

    # --- Charter exists → chat turn ---
    if has_charter and user_message:
        return await _chat_turn(state, user_message)

    # --- No charter → discovery (goals or stories phase) ---
    return await _discovery_turn(state, user_message)


async def _discovery_turn(state: SessionState, user_message: str | None) -> AgentResult:
    """Run a discovery turn — elicit goals, users, or stories depending on phase."""
    state.agent_status = AgentStatus.discovery

    text, extraction, calls = await call_discovery_turn(state, user_message)

    # Apply extractions
    ready_for_users = False
    ready_for_stories = False
    ready_for_charter = False

    if extraction:
        new_goals = extraction.get("goals", [])
        new_users = extraction.get("users", [])
        new_stories = extraction.get("stories", [])
        ready_for_users = extraction.get("ready_for_users", False)
        ready_for_stories = extraction.get("ready_for_stories", False)
        ready_for_charter = extraction.get("ready_for_charter", False)

        # Append new goals (deduplicate)
        existing_goals_lower = {g.lower() for g in state.extracted_goals}
        for g in new_goals:
            if g and g.lower() not in existing_goals_lower:
                state.extracted_goals.append(g)
                existing_goals_lower.add(g.lower())

        # Append new users (deduplicate)
        existing_users_lower = {u.lower() for u in state.extracted_users}
        for u in new_users:
            if u and u.lower() not in existing_users_lower:
                state.extracted_users.append(u)
                existing_users_lower.add(u.lower())

        # Append new stories (deduplicate by who+what similarity)
        existing_story_keys = {
            (s.get("who", "").lower(), s.get("what", "").lower().strip()[:40])
            for s in state.extracted_stories
        }
        for s in new_stories:
            if s.get("who") and s.get("what"):
                key = (s["who"].lower(), s["what"].lower().strip()[:40])
                if key not in existing_story_keys:
                    state.extracted_stories.append(s)
                    existing_story_keys.add(key)

    state.discovery_rounds += 1
    state.input.conversation_history.append({"role": "assistant", "content": text})

    await create_turn(
        session_id=state.session_id,
        turn_type="discovery",
        input_snapshot={
            "user_message": user_message,
            "round": state.discovery_rounds,
            "phase": state.discovery_phase.value,
        },
        llm_calls=calls,
        parsed_output=extraction,
        agent_message=text,
    )

    result = AgentResult(
        message=text,
        extracted_goals=state.extracted_goals,
        extracted_users=state.extracted_users,
        extracted_stories=state.extracted_stories,
    )
    result.ready_for_users = ready_for_users
    result.ready_for_stories = ready_for_stories
    result.ready_for_charter = ready_for_charter

    # Pass through suggested clickable options
    if extraction:
        result.suggested_goals = extraction.get("suggested_goals", [])
        result.suggested_users = extraction.get("suggested_users", [])
        result.suggested_stories_options = extraction.get("suggested_stories", [])

    return result


async def advance_phase(state: SessionState) -> AgentResult:
    """Advance the discovery phase: goals→users→stories→charter generation."""
    if state.discovery_phase == DiscoveryPhase.goals:
        # Move to users phase
        state.discovery_phase = DiscoveryPhase.users
        return await _discovery_turn(state, None)

    elif state.discovery_phase == DiscoveryPhase.users:
        # Move to stories phase
        state.discovery_phase = DiscoveryPhase.stories
        return await _discovery_turn(state, None)

    elif state.discovery_phase == DiscoveryPhase.stories:
        # Move to charter generation
        _build_input_from_extractions(state)
        result = await _generate_and_validate(state)
        state.input.conversation_history.append({"role": "assistant", "content": result.message})
        return result

    # Fallback
    return AgentResult(message="Already past discovery.")


def _build_input_from_extractions(state: SessionState) -> None:
    """Build business_goals and user_stories text from extracted data."""
    if state.extracted_goals:
        state.input.business_goals = "\n".join(f"- {g}" for g in state.extracted_goals)
    if state.extracted_stories:
        parts = []
        for s in state.extracted_stories:
            who = s.get("who", "user")
            what = s.get("what", "")
            why = s.get("why", "")
            parts.append(f"As a {who}, I want to {what}" + (f", so that {why}" if why else ""))
        state.input.user_stories = "\n".join(parts)


async def _generate_and_validate(state: SessionState) -> AgentResult:
    """Generate a charter draft, validate it, generate suggestions."""
    # Step 1: Generate
    state.agent_status = AgentStatus.drafting
    charter, gen_calls = await call_generate_draft(state)
    state.charter = charter

    await create_turn(
        session_id=state.session_id,
        turn_type="generate",
        input_snapshot={"business_goals": state.input.business_goals, "user_stories": state.input.user_stories},
        llm_calls=gen_calls,
        parsed_output=state.charter.model_dump(),
        agent_message=None,
        suggestions=None,
    )

    # Step 2: Validate
    state.agent_status = AgentStatus.validating
    validation, val_calls = await call_validate_charter(state)
    state.validation = validation

    await create_turn(
        session_id=state.session_id,
        turn_type="validate",
        input_snapshot={"charter": state.charter.model_dump()},
        llm_calls=val_calls,
        parsed_output=state.validation.model_dump(),
        agent_message=None,
        suggestions=None,
    )

    # Step 3: Decide status
    max_rounds = get_max_rounds()

    if _all_passing(state):
        state.agent_status = AgentStatus.review
        msg = "I've built the document and all criteria are passing. It's ready for your review."
    elif state.rounds_of_questions >= max_rounds:
        state.agent_status = AgentStatus.soft_ok
        msg = "I've built a first draft. Some criteria still need work — take a look at the right panel."
    else:
        state.agent_status = AgentStatus.questioning
        weak_parts = _summarize_weak(state)
        msg = f"I've updated the document based on what you provided. {weak_parts} Take a look at the right panel — what would you like to refine?"

    state.input.conversation_history.append({"role": "assistant", "content": msg})

    # Step 4: Generate suggestions
    (suggestions, suggested_stories), sug_calls = await call_generate_suggestions(state)

    await create_turn(
        session_id=state.session_id,
        turn_type="suggest",
        input_snapshot={"charter": state.charter.model_dump(), "validation": state.validation.model_dump()},
        llm_calls=sug_calls,
        parsed_output=None,
        agent_message=msg,
        suggestions={"suggestions": [s.model_dump() for s in suggestions], "stories": [s.model_dump() for s in suggested_stories]},
    )

    return AgentResult(
        msg,
        tool_calls=["generate_draft", "validate_charter"],
        suggestions=suggestions,
        suggested_stories=suggested_stories,
    )


async def _chat_turn(state: SessionState, user_message: str) -> AgentResult:
    """Handle a chat message — converse, maybe update charter sections."""
    charter_before = state.charter.model_dump()

    # Get response from Claude
    raw_text, chat_calls = await call_conversational_turn(state, user_message)

    # Parse structured blocks from the response
    update_data, text = parse_charter_update(raw_text)
    suggestions, suggested_stories, text = parse_suggestions(text)
    text = text.strip() or "What else would you like to refine?"

    # Apply charter update if present
    if update_data:
        _apply_charter_update(state, update_data)
        validation, val_calls = await call_validate_charter(state)
        state.validation = validation
        chat_calls.extend(val_calls)

    state.rounds_of_questions += 1
    state.input.conversation_history.append({"role": "assistant", "content": text})

    await create_turn(
        session_id=state.session_id,
        turn_type="chat",
        input_snapshot={"user_message": user_message, "charter_before": charter_before},
        llm_calls=chat_calls,
        parsed_output={"charter_update": update_data} if update_data else None,
        agent_message=text,
        suggestions={"suggestions": [s.model_dump() for s in suggestions], "stories": [s.model_dump() for s in suggested_stories]} if suggestions else None,
    )

    return AgentResult(
        message=text,
        suggestions=suggestions,
        suggested_stories=suggested_stories,
    )


# --- State helpers (no LLM calls) ---

def _apply_charter_update(state: SessionState, update_data: dict) -> None:
    """Apply a partial charter update from a conversational turn."""
    if "coverage" in update_data:
        cov = update_data["coverage"]
        if isinstance(cov, dict) and "criteria" in cov:
            state.charter.coverage.criteria = cov["criteria"]
        elif isinstance(cov, list):
            state.charter.coverage.criteria = cov

    if "balance" in update_data:
        bal = update_data["balance"]
        if isinstance(bal, dict) and "criteria" in bal:
            state.charter.balance.criteria = bal["criteria"]
        elif isinstance(bal, list):
            state.charter.balance.criteria = bal

    if "rot" in update_data:
        rot = update_data["rot"]
        if isinstance(rot, dict) and "criteria" in rot:
            state.charter.rot.criteria = rot["criteria"]
        elif isinstance(rot, list):
            state.charter.rot.criteria = rot

    if "alignment" in update_data:
        state.charter.alignment = [
            AlignmentEntry(
                feature_area=a.get("feature_area", ""),
                good=a.get("good", ""),
                bad=a.get("bad", ""),
                status=DimensionStatus.pending,
            )
            for a in update_data["alignment"]
        ]


def _summarize_weak(state: SessionState) -> str:
    """Summarize which parts of the charter are weak."""
    weak = []
    v = state.validation
    if v.coverage in (ValidationStatus.weak, ValidationStatus.fail):
        weak.append("coverage scenarios")
    if v.balance in (ValidationStatus.weak, ValidationStatus.fail):
        weak.append("weighting decisions")
    if v.rot in (ValidationStatus.weak, ValidationStatus.fail):
        weak.append("update triggers")
    for a in v.alignment:
        if a.status in (ValidationStatus.weak, ValidationStatus.fail):
            weak.append(f"the {a.feature_area} criteria")

    if not weak:
        return "Everything looks solid so far."
    if len(weak) == 1:
        return f"I think {weak[0]} could be stronger."
    return f"A few areas could be stronger: {', '.join(weak[:-1])}, and {weak[-1]}."


async def run_dataset_chat(
    state: SessionState,
    user_message: str,
    dataset_stats: dict,
) -> AgentResult:
    """Handle a chat message in the dataset phase."""
    state.input.conversation_history.append({
        "role": "user",
        "content": user_message,
    })

    charter = state.charter.model_dump()
    raw_text, chat_calls = await call_dataset_chat(
        charter, dataset_stats, user_message, state.input.conversation_history,
    )

    # Check for dataset-action blocks (can have multiple)
    actions = []
    text = raw_text
    while "```dataset-action" in text:
        try:
            start = text.index("```dataset-action") + len("```dataset-action")
            end = text.index("```", start)
            action_data = json.loads(text[start:end].strip())
            actions.append(action_data)
            text = text[:text.index("```dataset-action")] + text[end + 3:]
        except (ValueError, json.JSONDecodeError):
            break

    # Check for suggestions block
    action_suggestions = []
    if "```suggestions" in text:
        try:
            start = text.index("```suggestions") + len("```suggestions")
            end = text.index("```", start)
            suggestions_data = json.loads(text[start:end].strip())
            if isinstance(suggestions_data, list):
                action_suggestions = suggestions_data
            text = text[:text.index("```suggestions")] + text[end + 3:]
        except (ValueError, json.JSONDecodeError):
            pass

    text = text.strip() or "How can I help with the dataset?"

    state.input.conversation_history.append({"role": "assistant", "content": text})

    await create_turn(
        session_id=state.session_id,
        turn_type="dataset_chat",
        input_snapshot={"user_message": user_message, "dataset_stats": dataset_stats},
        llm_calls=chat_calls,
        parsed_output={"actions": actions, "suggestions": action_suggestions} if actions or action_suggestions else None,
        agent_message=text,
    )

    result = AgentResult(message=text, actions=actions)
    result.action_suggestions = action_suggestions
    return result


def _all_passing(state: SessionState) -> bool:
    """Check if all validation criteria pass."""
    v = state.validation
    if v.overall == ValidationStatus.passing:
        return True
    dims_pass = (
        v.coverage == ValidationStatus.passing
        and v.balance == ValidationStatus.passing
        and v.rot == ValidationStatus.passing
    )
    alignment_pass = all(
        a.status == ValidationStatus.passing for a in v.alignment
    ) if v.alignment else True

    return dims_pass and alignment_pass
