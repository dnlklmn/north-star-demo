"""LLM call wrappers — send prompts, parse responses.

Each function calls Claude and returns structured data.
Prompts come from prompt.py. Parsing logic lives here.
"""

from __future__ import annotations

import json
import logging
import os
import time

import anthropic

from .models import (
    AlignmentEntry,
    AlignmentValidation,
    Charter,
    DimensionCriteria,
    DimensionStatus,
    SessionState,
    Suggestion,
    SuggestedStory,
    Validation,
    ValidationStatus,
)
from .prompt import (
    build_generate_draft_prompt,
    build_validate_charter_prompt,
    build_conversational_turn_prompt,
    build_generate_suggestions_prompt,
    build_synthesize_examples_prompt,
    build_review_examples_prompt,
    build_dataset_chat_prompt,
    build_gap_analysis_prompt,
    build_detect_schema_prompt,
    build_infer_schema_prompt,
    build_import_url_prompt,
)

logger = logging.getLogger(__name__)

_client: anthropic.Anthropic | None = None

# Cached settings (refreshed each LLM call)
_cached_settings: dict | None = None


def get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


def get_model() -> str:
    if _cached_settings and _cached_settings.get("model_name"):
        return _cached_settings["model_name"]
    return os.environ.get("MODEL_NAME", "claude-sonnet-4-20250514")


def get_creativity() -> float:
    if _cached_settings and "creativity" in _cached_settings:
        return float(_cached_settings["creativity"])
    return 0.2


def get_max_rounds() -> int:
    if _cached_settings and "max_rounds" in _cached_settings:
        return int(_cached_settings["max_rounds"])
    return int(os.environ.get("MAX_QUESTION_ROUNDS", "3"))


async def _refresh_settings() -> None:
    """Load settings from DB into cache."""
    global _cached_settings
    try:
        from . import db
        _cached_settings = await db.get_settings()
    except Exception:
        _cached_settings = None


# --- LLM call helpers ---

def _call_llm(prompt: str, max_tokens: int = 4096) -> tuple[str, dict]:
    """Call Claude and return (response_text, call_metadata)."""
    model = get_model()
    creativity = get_creativity()
    # Map creativity (0-1) to temperature (0-1)
    temperature = creativity

    start = time.time()
    response = get_client().messages.create(
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
        messages=[{"role": "user", "content": prompt}],
    )
    elapsed_ms = int((time.time() - start) * 1000)
    text = response.content[0].text if response.content else ""
    metadata = {
        "model": model,
        "prompt": prompt,
        "raw_response": text,
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "latency_ms": elapsed_ms,
        "temperature": temperature,
    }
    return text, metadata


# --- LLM call wrappers ---

async def call_generate_draft(state: SessionState) -> tuple[Charter, list[dict]]:
    """Generate a charter draft. Returns (parsed Charter, call metadata list)."""
    await _refresh_settings()
    prompt = build_generate_draft_prompt(state, creativity=get_creativity())
    text, meta = _call_llm(prompt, max_tokens=4096)
    charter_data = _extract_json(text)

    charter = Charter(
        coverage=DimensionCriteria(
            criteria=charter_data.get("coverage", {}).get("criteria", []),
            status=DimensionStatus.pending,
        ),
        balance=DimensionCriteria(
            criteria=charter_data.get("balance", {}).get("criteria", []),
            status=DimensionStatus.pending,
        ),
        alignment=[
            AlignmentEntry(
                feature_area=a.get("feature_area", ""),
                good=a.get("good", ""),
                bad=a.get("bad", ""),
                status=DimensionStatus.pending,
            )
            for a in charter_data.get("alignment", [])
        ],
        rot=DimensionCriteria(
            criteria=charter_data.get("rot", {}).get("criteria", []),
            status=DimensionStatus.pending,
        ),
    )
    return charter, [meta]


async def call_validate_charter(state: SessionState) -> tuple[Validation, list[dict]]:
    """Validate the current charter. Returns (parsed Validation, call metadata list)."""
    await _refresh_settings()
    prompt = build_validate_charter_prompt(state)
    text, meta = _call_llm(prompt, max_tokens=2048)
    val_data = _extract_json(text)

    validation = Validation(
        coverage=_parse_validation_status(val_data.get("coverage", "untested")),
        balance=_parse_validation_status(val_data.get("balance", "untested")),
        alignment=[
            AlignmentValidation(
                feature_area=a.get("feature_area", ""),
                status=_parse_validation_status(a.get("status", "untested")),
                weak_reason=a.get("weak_reason"),
            )
            for a in val_data.get("alignment", [])
        ],
        rot=_parse_validation_status(val_data.get("rot", "untested")),
        overall=_parse_validation_status(val_data.get("overall", "untested")),
    )

    _update_charter_statuses(state.charter, validation)
    return validation, [meta]


async def call_conversational_turn(state: SessionState, user_message: str) -> tuple[str, list[dict]]:
    """Send a conversational turn. Returns (raw text, call metadata list)."""
    await _refresh_settings()
    prompt = build_conversational_turn_prompt(state, user_message)
    text, meta = _call_llm(prompt, max_tokens=2048)
    return text, [meta]


async def call_generate_suggestions(state: SessionState) -> tuple[tuple[list[Suggestion], list[SuggestedStory]], list[dict]]:
    """Generate suggestions for weak/empty sections. Returns ((suggestions, stories), call metadata list)."""
    await _refresh_settings()
    prompt = build_generate_suggestions_prompt(state)
    text, meta = _call_llm(prompt, max_tokens=1024)
    data = _extract_json(text)

    suggestions = [
        Suggestion(
            section=s["section"],
            text=s["text"],
            good=s.get("good"),
            bad=s.get("bad"),
        )
        for s in data.get("suggestions", [])
    ]
    suggested_stories = [
        SuggestedStory(who=s["who"], what=s["what"], why=s.get("why", ""))
        for s in data.get("user_stories", [])
    ]
    return (suggestions, suggested_stories), [meta]


async def call_suggest_goals(goals: list[str]) -> tuple[list[str], list[dict]]:
    """Suggest additional business goals. Returns (suggestions, call metadata list)."""
    from .prompt import build_suggest_goals_prompt
    await _refresh_settings()
    prompt = build_suggest_goals_prompt(goals)
    text, meta = _call_llm(prompt, max_tokens=512)
    data = _extract_json(text)
    return data.get("suggestions", []), [meta]


async def call_evaluate_goals(goals: list[str]) -> tuple[list[dict], list[dict]]:
    """Evaluate business goal quality. Returns (feedback list, call metadata list)."""
    from .prompt import build_evaluate_goals_prompt
    await _refresh_settings()
    prompt = build_evaluate_goals_prompt(goals)
    text, meta = _call_llm(prompt, max_tokens=512)
    data = _extract_json(text)
    return data.get("feedback", []), [meta]


async def call_suggest_stories(goals: list[str], stories: list[dict]) -> tuple[list[dict], list[dict]]:
    """Suggest additional user stories. Returns (suggestions, call metadata list)."""
    from .prompt import build_suggest_stories_prompt
    await _refresh_settings()
    prompt = build_suggest_stories_prompt(goals, stories)
    text, meta = _call_llm(prompt, max_tokens=512)
    data = _extract_json(text)
    return data.get("suggestions", []), [meta]


# --- Dataset phase tools ---

async def call_synthesize_examples(
    charter: dict,
    feature_areas: list[str] | None = None,
    coverage_criteria: list[str] | None = None,
    count: int = 2,
) -> tuple[list[dict], list[dict]]:
    """Generate synthetic examples from charter. Returns (examples, call metadata list)."""
    await _refresh_settings()
    prompt = build_synthesize_examples_prompt(charter, feature_areas, coverage_criteria, count)
    text, meta = _call_llm(prompt, max_tokens=8192)
    data = _extract_json(text)
    return data.get("examples", []), [meta]


async def call_review_examples(charter: dict, examples: list[dict]) -> tuple[list[dict], list[dict]]:
    """Auto-review examples against charter. Returns (reviews, call metadata list)."""
    await _refresh_settings()
    prompt = build_review_examples_prompt(charter, examples)
    text, meta = _call_llm(prompt, max_tokens=4096)
    data = _extract_json(text)
    return data.get("reviews", []), [meta]


async def call_dataset_chat(
    charter: dict,
    dataset_stats: dict,
    user_message: str,
    conversation_history: list[dict],
) -> tuple[str, list[dict]]:
    """Chat turn in dataset phase. Returns (response text, call metadata list)."""
    await _refresh_settings()
    prompt = build_dataset_chat_prompt(charter, dataset_stats, user_message, conversation_history)
    text, meta = _call_llm(prompt, max_tokens=2048)
    return text, [meta]


async def call_gap_analysis(charter: dict, dataset_stats: dict, examples: list[dict]) -> tuple[dict, list[dict]]:
    """Analyze dataset gaps against charter. Returns (gap analysis, call metadata list)."""
    await _refresh_settings()
    prompt = build_gap_analysis_prompt(charter, dataset_stats, examples)
    text, meta = _call_llm(prompt, max_tokens=2048)
    data = _extract_json(text)
    return data, [meta]


# --- Schema detection tools ---

async def call_detect_schema(content: str, content_type: str = "auto") -> tuple[dict, list[dict]]:
    """Detect schema from pasted content. Returns (schema data, call metadata list)."""
    await _refresh_settings()
    prompt = build_detect_schema_prompt(content, content_type)
    text, meta = _call_llm(prompt, max_tokens=2048)
    data = _extract_json(text)
    return data, [meta]


async def call_infer_schema(examples: list[dict], charter: dict) -> tuple[dict, list[dict]]:
    """Infer schema from existing examples. Returns (inferred schema, call metadata list)."""
    await _refresh_settings()
    prompt = build_infer_schema_prompt(examples, charter)
    text, meta = _call_llm(prompt, max_tokens=2048)
    data = _extract_json(text)
    return data, [meta]


async def call_import_from_url(content: str, url: str, detected_type: str) -> tuple[dict, list[dict]]:
    """Extract schema from URL content. Returns (schema data, call metadata list)."""
    await _refresh_settings()
    prompt = build_import_url_prompt(content, url, detected_type)
    text, meta = _call_llm(prompt, max_tokens=2048)
    data = _extract_json(text)
    return data, [meta]


# --- Response parsing helpers ---

def parse_charter_update(text: str) -> tuple[dict | None, str]:
    """Extract ```charter-update``` block from response text.
    Returns (update_data, remaining_text)."""
    if "```charter-update" not in text:
        return None, text

    try:
        start = text.index("```charter-update") + len("```charter-update")
        end = text.index("```", start)
        update_json = text[start:end].strip()
        update_data = json.loads(update_json)
        remaining = text[:text.index("```charter-update")] + text[end + 3:]
        return update_data, remaining
    except (ValueError, json.JSONDecodeError) as e:
        logger.warning(f"Failed to parse charter update: {e}")
        return None, text


def parse_suggestions(text: str) -> tuple[list[Suggestion], list[SuggestedStory], str]:
    """Extract ```suggestions``` block from response text.
    Returns (suggestions, stories, remaining_text)."""
    if "```suggestions" not in text:
        return [], [], text

    try:
        start = text.index("```suggestions") + len("```suggestions")
        end = text.index("```", start)
        sug_json = text[start:end].strip()
        sug_data = json.loads(sug_json)

        suggestions = [
            Suggestion(
                section=s["section"],
                text=s["text"],
                good=s.get("good"),
                bad=s.get("bad"),
            )
            for s in sug_data.get("suggestions", [])
        ]
        stories = [
            SuggestedStory(who=s["who"], what=s["what"], why=s.get("why", ""))
            for s in sug_data.get("user_stories", [])
        ]
        remaining = text[:text.index("```suggestions")] + text[end + 3:]
        return suggestions, stories, remaining
    except (ValueError, json.JSONDecodeError) as e:
        logger.warning(f"Failed to parse suggestions: {e}")
        return [], [], text


# --- Internal helpers ---

def _update_charter_statuses(charter: Charter, validation: Validation) -> None:
    """Update charter dimension statuses based on validation results."""
    charter.coverage.status = _val_to_dim_status(validation.coverage)
    charter.balance.status = _val_to_dim_status(validation.balance)
    charter.rot.status = _val_to_dim_status(validation.rot)

    for av in validation.alignment:
        for ae in charter.alignment:
            if ae.feature_area == av.feature_area:
                ae.status = _val_to_dim_status(av.status)


def _val_to_dim_status(vs: ValidationStatus) -> DimensionStatus:
    if vs == ValidationStatus.passing:
        return DimensionStatus.good
    if vs == ValidationStatus.weak:
        return DimensionStatus.weak
    return DimensionStatus.pending


def _parse_validation_status(s: str) -> ValidationStatus:
    mapping = {
        "pass": ValidationStatus.passing,
        "weak": ValidationStatus.weak,
        "fail": ValidationStatus.fail,
    }
    return mapping.get(s, ValidationStatus.untested)


def _extract_json(text: str) -> dict:
    """Extract JSON from LLM response text, handling markdown code blocks."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines[1:] if not l.strip().startswith("```")]
        text = "\n".join(lines)
    start = text.find("{")
    end = text.rfind("}") + 1
    if start >= 0 and end > start:
        text = text[start:end]
    return json.loads(text)
