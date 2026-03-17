"""Agent control flow — decides what to do each turn.

No prompts live here (see prompt.py).
No LLM calls live here (see tools.py).
This file only manages state transitions and orchestrates calls.

Flow:
1. First turn (no charter yet) → generate + validate + suggest
2. Regenerate (from intake) → regenerate full charter + validate + suggest
3. Chat turn (charter exists) → converse, maybe update sections, suggest
4. Fallback → ask for input
"""

from __future__ import annotations

import logging

from .models import (
    AgentStatus,
    AlignmentEntry,
    DimensionCriteria,
    DimensionStatus,
    SessionState,
    Suggestion,
    SuggestedStory,
    ValidationStatus,
)
from .db import create_turn
from .tools import (
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
    ):
        self.message = message
        self.tool_calls = tool_calls or []
        self.suggestions = suggestions or []
        self.suggested_stories = suggested_stories or []
        self.actions = actions or []
        self.action_suggestions = action_suggestions or []


async def run_agent_turn(
    state: SessionState,
    user_message: str | None = None,
    regenerate: bool = False,
) -> AgentResult:
    """Run one turn of the agent loop.

    Modes:
    1. First turn (no charter yet) → generate + validate + suggest
    2. regenerate=True (from intake screen) → regenerate full charter + validate + suggest
    3. Chat turn (charter exists, user discussing) → converse, maybe update, suggest
    """
    # Append user message to conversation history
    if user_message:
        state.input.conversation_history.append({
            "role": "user",
            "content": user_message,
        })

    has_input = state.input.business_goals or state.input.user_stories
    has_charter = bool(state.charter.coverage.criteria or state.charter.alignment)

    # --- First turn or explicit regenerate ---
    if has_input and (not has_charter or regenerate):
        return await _generate_and_validate(state)

    # --- Chat turn ---
    if has_charter and user_message:
        return await _chat_turn(state, user_message)

    # --- Fallback ---
    msg = "Tell me about the AI feature you're building — what does it do, and what does a good result look like?"
    state.input.conversation_history.append({"role": "assistant", "content": msg})
    return AgentResult(msg)


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
    import json
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
    ) if v.alignment else False

    return dims_pass and alignment_pass
