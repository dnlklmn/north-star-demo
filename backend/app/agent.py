"""Agent control flow — decides what to do each turn.

No prompts live here (see prompt.py).
No LLM calls live here (see tools.py).
This file only manages state transitions and orchestrates calls.

Flow:
1. Generate (no seed yet) → generate + validate + suggest
2. Regenerate → regenerate full seed + validate + suggest
3. Chat turn (seed exists) → converse, maybe update sections, suggest
"""

from __future__ import annotations

import json
import logging

from .models import (
    AgentStatus,
    AlignmentEntry,
    DimensionStatus,
    SessionState,
    Suggestion,
    SuggestedStory,
    ValidationStatus,
)
from .db import create_turn
from .tools import (
    call_generate_draft,
    call_validate_seed,
    call_conversational_turn,
    call_generate_suggestions,
    call_dataset_chat,
    get_max_rounds,
    parse_seed_update,
    parse_suggestions,
    set_trace_meta,
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
    1. regenerate → regenerate seed
    2. Seed exists + user message → chat turn to refine
    3. No seed → generate one from current input
    """
    # Append user message to conversation history
    if user_message:
        state.input.conversation_history.append({
            "role": "user",
            "content": user_message,
        })

    has_seed = bool(state.seed.coverage.criteria or state.seed.alignment)
    phase = "seed" if has_seed else None

    with set_trace_meta(
        session_id=state.session_id,
        phase=phase,
        turn_number=state.rounds_of_questions,
    ):
        # --- Explicit regenerate (force seed generation, even if empty) ---
        if regenerate:
            return await _generate_and_validate(state)

        # --- Seed exists → chat turn ---
        if has_seed and user_message:
            return await _chat_turn(state, user_message)

        # --- No seed yet → generate one from current input ---
        return await _generate_and_validate(state)


async def _generate_and_validate(state: SessionState) -> AgentResult:
    """Generate a seed draft, validate it, generate suggestions."""
    # Step 1: Generate
    state.agent_status = AgentStatus.drafting
    seed, gen_calls = await call_generate_draft(state)
    state.seed = seed

    await create_turn(
        session_id=state.session_id,
        turn_type="generate",
        input_snapshot={"business_goals": state.input.business_goals, "user_stories": state.input.user_stories},
        llm_calls=gen_calls,
        parsed_output=state.seed.model_dump(),
        agent_message=None,
        suggestions=None,
    )

    # Step 2: Validate
    state.agent_status = AgentStatus.validating
    validation, val_calls = await call_validate_seed(state)
    state.validation = validation

    await create_turn(
        session_id=state.session_id,
        turn_type="validate",
        input_snapshot={"seed": state.seed.model_dump()},
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
        input_snapshot={"seed": state.seed.model_dump(), "validation": state.validation.model_dump()},
        llm_calls=sug_calls,
        parsed_output=None,
        agent_message=msg,
        suggestions={"suggestions": [s.model_dump() for s in suggestions], "stories": [s.model_dump() for s in suggested_stories]},
    )

    return AgentResult(
        msg,
        tool_calls=["generate_draft", "validate_seed"],
        suggestions=suggestions,
        suggested_stories=suggested_stories,
    )


async def _chat_turn(state: SessionState, user_message: str) -> AgentResult:
    """Handle a chat message — converse, maybe update seed sections."""
    seed_before = state.seed.model_dump()

    # Get response from Claude
    raw_text, chat_calls = await call_conversational_turn(state, user_message)

    # Parse structured blocks from the response
    update_data, text = parse_seed_update(raw_text)
    suggestions, suggested_stories, text = parse_suggestions(text)
    text = text.strip() or "What else would you like to refine?"

    # Apply seed update if present
    if update_data:
        _apply_seed_update(state, update_data)
        validation, val_calls = await call_validate_seed(state)
        state.validation = validation
        chat_calls.extend(val_calls)

    state.rounds_of_questions += 1
    state.input.conversation_history.append({"role": "assistant", "content": text})

    await create_turn(
        session_id=state.session_id,
        turn_type="chat",
        input_snapshot={"user_message": user_message, "seed_before": seed_before},
        llm_calls=chat_calls,
        parsed_output={"seed_update": update_data} if update_data else None,
        agent_message=text,
        suggestions={"suggestions": [s.model_dump() for s in suggestions], "stories": [s.model_dump() for s in suggested_stories]} if suggestions else None,
    )

    return AgentResult(
        message=text,
        suggestions=suggestions,
        suggested_stories=suggested_stories,
    )


# --- State helpers (no LLM calls) ---

def _apply_seed_update(state: SessionState, update_data: dict) -> None:
    """Apply a partial seed update from a conversational turn."""
    if "coverage" in update_data:
        cov = update_data["coverage"]
        if isinstance(cov, dict):
            if "criteria" in cov:
                state.seed.coverage.criteria = cov["criteria"]
            if "negative_criteria" in cov:
                state.seed.coverage.negative_criteria = cov["negative_criteria"]
        elif isinstance(cov, list):
            state.seed.coverage.criteria = cov

    if "balance" in update_data:
        bal = update_data["balance"]
        if isinstance(bal, dict) and "criteria" in bal:
            state.seed.balance.criteria = bal["criteria"]
        elif isinstance(bal, list):
            state.seed.balance.criteria = bal

    if "rot" in update_data:
        rot = update_data["rot"]
        if isinstance(rot, dict) and "criteria" in rot:
            state.seed.rot.criteria = rot["criteria"]
        elif isinstance(rot, list):
            state.seed.rot.criteria = rot

    if "safety" in update_data:
        saf = update_data["safety"]
        if isinstance(saf, dict) and "criteria" in saf:
            state.seed.safety.criteria = saf["criteria"]
        elif isinstance(saf, list):
            state.seed.safety.criteria = saf

    if "alignment" in update_data:
        state.seed.alignment = [
            AlignmentEntry(
                feature_area=a.get("feature_area", ""),
                good=a.get("good", ""),
                bad=a.get("bad", ""),
                status=DimensionStatus.pending,
            )
            for a in update_data["alignment"]
        ]


def _summarize_weak(state: SessionState) -> str:
    """Summarize which parts of the seed are weak."""
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

    seed = state.seed.model_dump()
    with set_trace_meta(session_id=state.session_id, phase="dataset"):
        raw_text, chat_calls = await call_dataset_chat(
            seed, dataset_stats, user_message, state.input.conversation_history,
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


async def run_polaris_chat(
    state: SessionState | None,
    user_message: str,
    context: dict,
) -> dict:
    """Run a Polaris turn — global tool-using assistant.

    `state` is None when chatting from the home page (no project selected).
    `context` is the frontend-supplied blob: route, session_id, dataset_id,
    selected_example_id, phase. The model reads this from the system prompt
    rather than calling tools to discover it.

    Returns:
        {
          "message": str,
          "tool_calls": [...],          # full log for telemetry
          "tool_summary": [...],        # subset shown in the chat (auto/confirm/nav)
          "proposals": [...],           # confirm-tier envelopes the UI renders as chips
          "navs": [...],                # nav envelopes the UI dispatches
        }
    """
    from . import polaris_tools
    from .tools import call_llm_with_tools, set_trace_meta
    from .prompt import build_polaris_system_prompt

    ctx = polaris_tools.ToolCtx(
        session_id=context.get("session_id"),
        dataset_id=context.get("dataset_id"),
        selected_example_id=context.get("selected_example_id"),
        route=context.get("route"),
        phase=context.get("phase"),
    )

    seed_summary = state.seed.model_dump() if state else None
    system = build_polaris_system_prompt(context, seed_summary)

    # Conversation history — only user/assistant text, no tool blocks. We
    # persist text-only turns to keep the JSONB column bounded; the full
    # tool transcript lives in the `turns` table.
    history: list[dict] = []
    if state is not None:
        for entry in state.input.conversation_history or []:
            role = entry.get("role")
            content = entry.get("content")
            if role in ("user", "assistant") and isinstance(content, str) and content.strip():
                history.append({"role": role, "content": content})

    messages = [*history, {"role": "user", "content": user_message}]

    async def _handler(name: str, args: dict) -> dict:
        return await polaris_tools.dispatch(name, ctx, args)

    with set_trace_meta(session_id=ctx.session_id, phase="polaris"):
        text, tool_log, llm_meta = await call_llm_with_tools(
            system=system,
            messages=messages,
            tool_schemas=polaris_tools.tool_schemas_for_model(),
            handler=_handler,
            max_iters=12,
            max_tokens=4096,
        )

    proposals: list[dict] = []
    navs: list[dict] = []
    summary: list[dict] = []
    for entry in tool_log:
        result = entry.get("result") or {}
        tier = polaris_tools.get_tier(entry["name"]) or "auto"
        item = {"name": entry["name"], "args": entry["args"], "tier": tier}
        if isinstance(result, dict) and result.get("_proposal"):
            proposals.append({
                "tool": result.get("tool"),
                "args": result.get("args") or {},
                "label": result.get("label") or entry["name"],
                "reason": result.get("reason") or "",
            })
            item["proposal"] = True
        elif isinstance(result, dict) and result.get("_nav"):
            navs.append({
                "target": result.get("target"),
                "props": result.get("props") or {},
            })
            item["nav"] = result.get("target")
        else:
            item["ok"] = bool(isinstance(result, dict) and (result.get("ok") or "examples" in result or "id" in result or "stats" in result or "projects" in result or "runs" in result or "turns" in result or "coverage_matrix" in result))
            if isinstance(result, dict) and "error" in result:
                item["error"] = result["error"]
        summary.append(item)

    # Persist conversation text to history.
    if state is not None:
        state.input.conversation_history.append({"role": "user", "content": user_message})
        if text:
            state.input.conversation_history.append({"role": "assistant", "content": text})

        # Persist only the compact summary (one line per call) into the JSONB
        # column. The full tool_log can include hundreds of rows from
        # list_examples or thousands from generated payloads — fine in memory
        # for the response, but we don't want it ballooning every turn row.
        await create_turn(
            session_id=state.session_id,
            turn_type="polaris_chat",
            input_snapshot={"user_message": user_message, "context": context},
            llm_calls=llm_meta,
            parsed_output={"summary": summary, "proposals": proposals, "navs": navs},
            agent_message=text,
        )

    return {
        "message": text,
        "tool_calls": tool_log,
        "tool_summary": summary,
        "proposals": proposals,
        "navs": navs,
    }


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
