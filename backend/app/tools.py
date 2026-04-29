"""LLM call wrappers — send prompts, parse responses.

Each function calls Claude and returns structured data.
Prompts come from prompt.py. Parsing logic lives here.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
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
    build_retag_examples_against_charter_prompt,
    build_validate_charter_prompt,
    build_conversational_turn_prompt,
    build_generate_suggestions_prompt,
    build_synthesize_examples_prompt,
    build_synthesize_examples_cell_prefix,
    build_synthesize_examples_cell_suffix,
    build_review_examples_prompt,
    build_dataset_chat_prompt,
    build_gap_analysis_prompt,
    _build_coverage_matrix,
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

# OpenRouter exposes an Anthropic-compatible endpoint at /api/v1/messages.
# The Anthropic SDK appends `/v1/messages` to whatever base_url it's given,
# so the base must end at `/api` — using `/api/v1` causes a double `/v1/v1/`
# path that 404s into OpenRouter's HTML homepage, which the SDK then mis-
# parses into garbage and the call returns nonsense (or 500s downstream).
OPENROUTER_BASE_URL = "https://openrouter.ai/api"


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
    return os.environ.get("MODEL_NAME", "claude-sonnet-4-5-20250929")


def _is_request_using_openrouter() -> bool:
    """True when the current request will hit OpenRouter, either because the
    per-request key is an `sk-or-` key or because the env-var fallback resolves
    to OpenRouter (no ANTHROPIC_API_KEY but OPENROUTER_API_KEY set)."""
    request_key = _request_api_key.get(None)
    if request_key:
        return _is_openrouter_key(request_key)
    return (
        not os.environ.get("ANTHROPIC_API_KEY")
        and bool(os.environ.get("OPENROUTER_API_KEY"))
    )


_DATE_SUFFIX_RE = re.compile(r"-\d{8}$")


def _resolve_model(name: str) -> str:
    """Map an Anthropic-native model id to the form the active provider expects.

    OpenRouter doesn't accept bare Anthropic ids like `claude-sonnet-4-20250514`
    — it wants `anthropic/claude-sonnet-4`. When the request is going to
    OpenRouter and the configured model isn't already namespaced, strip any
    `-YYYYMMDD` suffix and prefix `anthropic/`. Direct-Anthropic calls are
    unchanged."""
    if not _is_request_using_openrouter():
        return name
    if "/" in name:
        return name
    return f"anthropic/{_DATE_SUFFIX_RE.sub('', name)}"


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


class LLMAuthError(Exception):
    """Raised when the provider rejects the API key (wrong key, key for the
    wrong provider, or model id the provider doesn't recognize). Surfaces as
    HTTP 401 so the frontend's existing 'invalid key' path catches it instead
    of falling through to a generic 500."""

    def __init__(self, message: str, provider: str = "anthropic"):
        super().__init__(message)
        self.provider = provider


def _current_provider() -> str:
    return "openrouter" if _is_request_using_openrouter() else "anthropic"


def _is_auth_error(err: Exception) -> bool:
    """Detect auth/model-id failures across providers. Anthropic and OpenRouter
    both return 4xx with a textual body — no shared error class."""
    msg = str(err).lower()
    needles = (
        "authentication",
        "missing authentication header",
        "invalid api key",
        "invalid_api_key",
        "invalid x-api-key",
        "unauthorized",
        "user_not_found",
        "no auth credentials",
        "model not found",
        "no endpoints found",
        "not a valid model",
    )
    return any(n in msg for n in needles)


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

    resolved_model = _resolve_model(model)
    logger.info(
        f"_call_llm: model={model}, resolved={resolved_model}, "
        f"provider={_current_provider()}, max_tokens={max_tokens}, "
        f"prompt_len={len(prompt)}"
    )
    start = time.time()
    try:
        response = get_client().messages.create(
            model=resolved_model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as e:
        logger.error(f"_call_llm FAILED: {type(e).__name__}: {e}")
        # Translate provider 4xx failures into typed exceptions so the API
        # layer can return a friendly 402/401 instead of a generic 500.
        if _is_billing_error(e):
            raise LLMBillingError(str(e), provider=_current_provider()) from e
        if _is_auth_error(e):
            raise LLMAuthError(str(e), provider=_current_provider()) from e
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


def _call_llm_cached(prefix: str, suffix: str, max_tokens: int = 4096) -> tuple[str, dict]:
    """Call Claude with a cacheable prefix block + per-call suffix.

    Sends the prompt as two text content blocks. The first carries
    `cache_control: ephemeral` so Anthropic caches it (~5 minute TTL) and
    subsequent calls within the window pay near-zero for that prefix. Use
    this when fanning out many calls that share a long context — e.g. the
    per-cell synth fan-out.

    On providers that don't honor cache_control (some OpenRouter models),
    the field is ignored and the call still works at full price; this
    function never errors out due to caching support.
    """
    model = get_model()
    creativity = get_creativity()
    temperature = creativity

    resolved_model = _resolve_model(model)
    logger.info(
        f"_call_llm_cached: model={model}, resolved={resolved_model}, "
        f"provider={_current_provider()}, max_tokens={max_tokens}, "
        f"prefix_len={len(prefix)}, suffix_len={len(suffix)}"
    )
    start = time.time()
    try:
        response = get_client().messages.create(
            model=resolved_model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": prefix,
                            "cache_control": {"type": "ephemeral"},
                        },
                        {"type": "text", "text": suffix},
                    ],
                }
            ],
        )
    except Exception as e:
        logger.error(f"_call_llm_cached FAILED: {type(e).__name__}: {e}")
        if _is_billing_error(e):
            raise LLMBillingError(str(e), provider=_current_provider()) from e
        if _is_auth_error(e):
            raise LLMAuthError(str(e), provider=_current_provider()) from e
        raise
    elapsed_ms = int((time.time() - start) * 1000)
    usage = response.usage
    # Cache-related fields only present on responses for cached calls; treat
    # as 0 when missing so logging works on providers that ignore them.
    cache_creation = getattr(usage, "cache_creation_input_tokens", 0) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    logger.info(
        f"_call_llm_cached: OK in {elapsed_ms}ms, "
        f"input={usage.input_tokens}, output={usage.output_tokens}, "
        f"cache_create={cache_creation}, cache_read={cache_read}"
    )
    text = response.content[0].text if response.content else ""
    metadata = {
        "model": model,
        # Store the assembled prompt for replay parity with _call_llm. Keep
        # both halves so debugging tools can see the split.
        "prompt": prefix + suffix,
        "prompt_prefix": prefix,
        "prompt_suffix": suffix,
        "raw_response": text,
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cache_creation_input_tokens": cache_creation,
        "cache_read_input_tokens": cache_read,
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

    # Defensive: some providers/models occasionally emit entries missing
    # required fields. Drop those instead of 500-ing the whole turn — losing
    # one suggestion is better than the user retrying the entire charter gen.
    suggestions = [
        Suggestion(
            section=s.get("section", ""),
            text=s.get("text", ""),
            good=s.get("good"),
            bad=s.get("bad"),
        )
        for s in data.get("suggestions", [])
        if isinstance(s, dict) and s.get("section") and s.get("text")
    ]
    suggested_stories = [
        SuggestedStory(who=s.get("who", ""), what=s.get("what", ""), why=s.get("why", ""))
        for s in data.get("user_stories", [])
        if isinstance(s, dict) and s.get("who") and s.get("what")
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

# Concurrency cap for per-cell synth fan-out. The backend talks to a single
# upstream LLM provider; ~5 in-flight requests is a safe ceiling that keeps
# latency low without rate-limiting risk.
_SYNTH_CELL_CONCURRENCY = 5


def _has_off_target_or_safety(charter: dict) -> bool:
    """Whether the charter requires off-target or safety rows in synthesis.

    Per-cell fan-out scopes generation to a single (criterion × feature_area)
    intersection, which doesn't accommodate the cross-cutting off-target and
    safety populations. When either is present we fall back to a single-call
    synth so those rows still get produced as the prompt expects.
    """
    coverage = charter.get("coverage") or {}
    if coverage.get("negative_criteria"):
        return True
    safety = charter.get("safety") or {}
    if safety.get("criteria"):
        return True
    task = charter.get("task") or {}
    # Triggered mode without explicit negatives is still single-call territory
    # because the prompt's TRIGGERED RULES generate two populations regardless.
    if task.get("skill_description"):
        return True
    return False


async def _synth_one_cell(
    prefix: str,
    feature_area: str,
    coverage_criterion: str,
    count: int,
    semaphore: asyncio.Semaphore,
) -> tuple[list[dict], dict]:
    """Generate examples for a single (criterion × area) cell.

    Takes a pre-built cacheable `prefix` so the first cell call seeds the
    Anthropic prompt cache and the rest hit it. The suffix is small and
    varies per cell.
    """
    suffix = build_synthesize_examples_cell_suffix(coverage_criterion, feature_area, count)
    async with semaphore:
        # _call_llm_cached is sync (blocking SDK). Run it in a worker thread
        # so asyncio.gather can actually parallelize across cells.
        text, meta = await asyncio.to_thread(_call_llm_cached, prefix, suffix, 4096)
    data = _extract_json(text)
    return data.get("examples", []), meta


async def call_synthesize_examples(
    charter: dict,
    feature_areas: list[str] | None = None,
    coverage_criteria: list[str] | None = None,
    count: int = 2,
) -> tuple[list[dict], list[dict]]:
    """Generate synthetic examples from charter. Returns (examples, call metadata list).

    Strategy:
    - Default path: fan out one LLM call per (criterion × area) cell so the
      grid is filled evenly. The previous single-call approach asked the LLM
      to fill the whole grid in one response, which clipped at the token cap
      and led to ratty coverage (some cells with many examples, others with 0).
    - Fallback path: when the charter has off-target or safety rows, do one
      single call. Those populations cut across the grid and don't slot into
      a per-cell scope cleanly.
    """
    await _refresh_settings()

    target_areas = feature_areas or [a.get("feature_area", "") for a in charter.get("alignment", [])]
    target_areas = [a for a in target_areas if a]
    target_coverage = coverage_criteria or (charter.get("coverage") or {}).get("criteria") or []
    target_coverage = [c for c in target_coverage if c]

    cell_count = len(target_areas) * len(target_coverage)
    falls_back = _has_off_target_or_safety(charter) or cell_count <= 1

    if falls_back:
        prompt = build_synthesize_examples_prompt(charter, feature_areas, coverage_criteria, count)
        text, meta = _call_llm(prompt, max_tokens=8192)
        data = _extract_json(text)
        return data.get("examples", []), [meta]

    # Per-cell fan-out. Build the cacheable prefix once and reuse — Anthropic
    # caches it on the first call, and every subsequent call reads from the
    # cache for ~10x cheaper input tokens.
    prefix = build_synthesize_examples_cell_prefix(charter)
    semaphore = asyncio.Semaphore(_SYNTH_CELL_CONCURRENCY)
    tasks = [
        _synth_one_cell(prefix, fa, crit, count, semaphore)
        for fa in target_areas
        for crit in target_coverage
    ]
    logger.info(
        f"call_synthesize_examples: fanning out {len(tasks)} cell(s) "
        f"({len(target_coverage)} criteria × {len(target_areas)} areas, "
        f"concurrency={_SYNTH_CELL_CONCURRENCY})"
    )
    results = await asyncio.gather(*tasks, return_exceptions=True)

    examples: list[dict] = []
    metas: list[dict] = []
    failures = 0
    for r in results:
        if isinstance(r, BaseException):
            failures += 1
            logger.warning(f"call_synthesize_examples: cell failed: {type(r).__name__}: {r}")
            # Re-raise billing errors so the API surfaces them — non-billing
            # failures are tolerated so a partial grid still saves.
            if isinstance(r, LLMBillingError):
                raise r
            continue
        cell_examples, cell_meta = r
        examples.extend(cell_examples)
        metas.append(cell_meta)
    if failures:
        logger.warning(
            f"call_synthesize_examples: {failures}/{len(tasks)} cell(s) failed; "
            f"returning {len(examples)} example(s)"
        )
    return examples, metas


async def call_review_examples(charter: dict, examples: list[dict]) -> tuple[list[dict], list[dict]]:
    """Auto-review examples against charter. Returns (reviews, call metadata list)."""
    await _refresh_settings()
    prompt = build_review_examples_prompt(charter, examples)
    text, meta = _call_llm(prompt, max_tokens=4096)
    data = _extract_json(text)
    return data.get("reviews", []), [meta]


async def call_retag_examples_against_charter(
    charter: dict, examples: list[dict],
) -> tuple[list[dict], list[dict]]:
    """Re-tag examples (feature_area + coverage_tags) against the charter.

    Returns (retags, call metadata list). Each retag is
    {example_id, feature_area, coverage_tags}. Used by prompt-eval to align
    the auto-seeded dataset with the just-generated charter so the Coverage
    Map matrix becomes useful.
    """
    await _refresh_settings()
    prompt = build_retag_examples_against_charter_prompt(charter, examples)
    text, meta = _call_llm(prompt, max_tokens=4096)
    data = _extract_json(text)
    return data.get("retags", []), [meta]


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
    """Analyze dataset gaps against charter. Returns (gap analysis, call metadata list).

    The coverage matrix is computed in code (deterministic), not delegated to
    the LLM. The LLM's role is the textual analysis — gaps, balance issues,
    summary. Otherwise an LLM that paraphrases criterion strings or drops
    rows would silently zero out cells that actually have examples.
    """
    await _refresh_settings()
    prompt = build_gap_analysis_prompt(charter, dataset_stats, examples)
    text, meta = _call_llm(prompt, max_tokens=2048)
    data = _extract_json(text)
    # Override whatever matrix the LLM produced with the deterministic count.
    data["coverage_matrix"] = _build_coverage_matrix(charter, examples)
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
