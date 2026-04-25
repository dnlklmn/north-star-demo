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
    TaskDefinition,
    Validation,
    ValidationStatus,
)
from .prompt import (
    build_discovery_turn_prompt,
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
    build_generate_scorers_prompt,
    build_revise_examples_prompt,
)

logger = logging.getLogger(__name__)

_client: anthropic.Anthropic | None = None

# Per-request API key (set via contextvars for thread safety)
import contextvars
_request_api_key: contextvars.ContextVar[str | None] = contextvars.ContextVar('_request_api_key', default=None)

# Cached settings (refreshed each LLM call)
_cached_settings: dict | None = None

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def _is_openrouter_key(key: str) -> bool:
    return key.startswith("sk-or-")


def set_request_api_key(key: str | None) -> None:
    """Set the API key for the current request context."""
    _request_api_key.set(key)


def get_client() -> anthropic.Anthropic:
    """Get an Anthropic client — uses per-request key if provided, else env var.

    Supports OpenRouter keys (prefix ``sk-or-``).  When an OpenRouter key is
    detected the client is configured with OpenRouter's base URL.  Priority for
    env-var keys: ANTHROPIC_API_KEY > OPENROUTER_API_KEY.
    """
    global _client
    request_key = _request_api_key.get(None)
    if request_key:
        # Per-request key: create a fresh client (not cached)
        if _is_openrouter_key(request_key):
            return anthropic.Anthropic(api_key=request_key, base_url=OPENROUTER_BASE_URL)
        return anthropic.Anthropic(api_key=request_key)
    # Default: use env var (cached singleton)
    if _client is None:
        or_key = os.environ.get("OPENROUTER_API_KEY")
        if not os.environ.get("ANTHROPIC_API_KEY") and or_key:
            _client = anthropic.Anthropic(api_key=or_key, base_url=OPENROUTER_BASE_URL)
        else:
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

class LLMBillingError(Exception):
    """Raised when the LLM provider rejects a request because the account
    can't be billed — out of credits, missing payment method, expired card.
    Surfaces as HTTP 402 so the frontend can show a dedicated banner with a
    link to the provider's billing page."""

    def __init__(self, message: str, provider: str = "anthropic"):
        super().__init__(message)
        self.provider = provider


def _is_billing_error(err: Exception) -> bool:
    """Detect 'out of credits' / 'billing' style errors from Anthropic and
    OpenRouter. Both providers return 400-class errors with a textual body
    we have to pattern-match on — no dedicated error class for this case."""
    msg = str(err).lower()
    needles = (
        "credit balance is too low",
        "credit_balance",
        "insufficient_credits",
        "insufficient credits",
        "billing",
        "payment required",
        "out of credit",
    )
    return any(n in msg for n in needles)


def _call_llm(prompt: str, max_tokens: int = 4096) -> tuple[str, dict]:
    """Call Claude and return (response_text, call_metadata)."""
    model = get_model()
    creativity = get_creativity()
    # Map creativity (0-1) to temperature (0-1)
    temperature = creativity

    logger.info(f"_call_llm: model={model}, max_tokens={max_tokens}, prompt_len={len(prompt)}")
    start = time.time()
    try:
        response = get_client().messages.create(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as e:
        logger.error(f"_call_llm FAILED: {type(e).__name__}: {e}")
        # Translate billing-style failures into a typed exception so the API
        # layer can return a friendly 402 instead of a generic 500.
        if _is_billing_error(e):
            raise LLMBillingError(str(e)) from e
        raise
    elapsed_ms = int((time.time() - start) * 1000)
    logger.info(f"_call_llm: OK in {elapsed_ms}ms, output_tokens={response.usage.output_tokens}")
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

async def call_discovery_turn(state: SessionState, user_message: str | None) -> tuple[str, dict | None, list[dict]]:
    """Run a discovery turn. Returns (conversational_text, extraction_data, call metadata list).

    extraction_data is a dict with keys: goals, stories, ready_for_charter
    """
    await _refresh_settings()
    prompt = build_discovery_turn_prompt(state, user_message)
    text, meta = _call_llm(prompt, max_tokens=2048)

    # Parse extraction block
    extraction = None
    clean_text = text
    if "```extraction" in text:
        try:
            start = text.index("```extraction") + len("```extraction")
            end = text.index("```", start)
            extraction_json = text[start:end].strip()
            extraction = json.loads(extraction_json)
            clean_text = text[:text.index("```extraction")] + text[end + 3:]
        except (ValueError, json.JSONDecodeError) as e:
            logger.warning(f"Failed to parse extraction block: {e}")

    clean_text = clean_text.strip()
    return clean_text, extraction, [meta]


async def call_generate_draft(state: SessionState) -> tuple[Charter, list[dict]]:
    """Generate a charter draft. Returns (parsed Charter, call metadata list)."""
    await _refresh_settings()
    prompt = build_generate_draft_prompt(state, creativity=get_creativity())
    text, meta = _call_llm(prompt, max_tokens=4096)
    charter_data = _extract_json(text)

    task_data = charter_data.get("task", {})
    # Preserve skill metadata from the existing state — the generation prompt doesn't re-emit it.
    existing_task = state.charter.task
    coverage_data = charter_data.get("coverage", {})
    safety_data = charter_data.get("safety", {}) or {}
    charter = Charter(
        task=TaskDefinition(
            input_description=task_data.get("input_description", ""),
            output_description=task_data.get("output_description", ""),
            sample_input=task_data.get("sample_input"),
            sample_output=task_data.get("sample_output"),
            skill_name=existing_task.skill_name,
            skill_description=existing_task.skill_description,
            skill_body=existing_task.skill_body,
        ),
        coverage=DimensionCriteria(
            criteria=coverage_data.get("criteria", []),
            negative_criteria=coverage_data.get("negative_criteria", []) or [],
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
        safety=DimensionCriteria(
            criteria=safety_data.get("criteria", []) or [],
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
    return (_dedupe_suggestions(suggestions), _dedupe_stories(suggested_stories)), [meta]


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


# --- Scorer generation tools ---

async def call_generate_scorers(charter: dict) -> tuple[list[dict], list[dict]]:
    """Generate evaluation scorers from charter. Returns (scorers, call metadata list)."""
    await _refresh_settings()
    prompt = build_generate_scorers_prompt(charter)
    text, meta = _call_llm(prompt, max_tokens=8192)
    data = _extract_json(text)
    return data.get("scorers", []), [meta]


# --- Revision suggestion tools ---

async def call_revise_examples(charter: dict, examples_with_verdicts: list[dict]) -> tuple[list[dict], list[dict]]:
    """Suggest revisions for examples that failed review. Returns (revisions, call metadata list)."""
    await _refresh_settings()
    prompt = build_revise_examples_prompt(charter, examples_with_verdicts)
    text, meta = _call_llm(prompt, max_tokens=8192)
    data = _extract_json(text)
    return data.get("revisions", []), [meta]


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


async def call_suggest_improvements(
    skill_body: str,
    eval_run: dict,
    charter: dict,
) -> tuple[dict, list[dict]]:
    """Analyze eval failures + current SKILL.md, propose targeted edits.

    Returns dict with keys: summary, suggestions (list).
    """
    from .prompt import build_suggest_improvements_prompt
    await _refresh_settings()
    prompt = build_suggest_improvements_prompt(skill_body, eval_run, charter)
    text, meta = _call_llm(prompt, max_tokens=4096)
    data = _extract_json(text)
    return data, [meta]


async def call_skill_seed(
    skill_body: str,
    skill_name: str | None,
    skill_description: str | None,
) -> tuple[dict, list[dict]]:
    """Seed goals/users/stories/task from a SKILL.md body.

    Returns a dict with keys: goals, users, positive_stories, off_target_stories,
    task, summary. Used in triggered mode to bootstrap a session from the skill
    the user wants to evaluate.
    """
    from .prompt import build_skill_seed_prompt
    await _refresh_settings()
    prompt = build_skill_seed_prompt(skill_body, skill_name, skill_description)
    text, meta = _call_llm(prompt, max_tokens=4096)
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


def _dedupe_suggestions(items: list[Suggestion]) -> list[Suggestion]:
    """Collapse near-duplicate suggestions within a batch.

    Key = (section, first 40 chars of lowercased/whitespace-collapsed text).
    The LLM sometimes emits 3 variants of the same idea with trivial rewording
    ('fires' vs 'activates' vs 'triggers') — this catches those before they
    reach the UI."""
    seen: set[tuple[str, str]] = set()
    result: list[Suggestion] = []
    for s in items:
        normalized = " ".join((s.text or "").lower().split())[:40]
        key = (s.section, normalized)
        if key in seen:
            continue
        seen.add(key)
        result.append(s)
    return result


def _dedupe_stories(items: list[SuggestedStory]) -> list[SuggestedStory]:
    seen: set[tuple[str, str]] = set()
    result: list[SuggestedStory] = []
    for s in items:
        normalized = " ".join((s.what or "").lower().split())[:40]
        key = ((s.who or "").lower(), normalized)
        if key in seen:
            continue
        seen.add(key)
        result.append(s)
    return result


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
        return _dedupe_suggestions(suggestions), _dedupe_stories(stories), remaining
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
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse LLM JSON response: {e}\nText: {text[:500]}")
        return {}
