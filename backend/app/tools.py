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
from contextlib import contextmanager
from contextvars import ContextVar

import anthropic
import braintrust

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
import contextvars  # noqa: E402

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


# --- Braintrust production monitoring ---
#
# When BRAINTRUST_PROD_API_KEY is set, every Anthropic call out of get_client()
# is wrapped with braintrust.wrap_anthropic and logged to the project named by
# BRAINTRUST_PROD_PROJECT (default: "north-star-prod"). When the env var is
# unset, all monitoring code is a near-zero-overhead no-op.
#
# Metadata flow:
#   1. set_trace_meta(session_id=..., phase=..., turn_number=...) is opened by
#      agent.py / main.py at the request/handler boundary.
#   2. trace_call(turn_type) is opened inside each call_* tool. It pulls the
#      ContextVar metadata, attaches turn_type + model_name, and starts a
#      Braintrust span. The wrap_anthropic SDK call inside lands as a child
#      span and inherits trace-level filterability.

# _braintrust_inited: None=not tried, "active"=ready, "disabled"/"failed"=skip.
_braintrust_inited: str | None = None
_trace_meta: ContextVar[dict | None] = ContextVar("_trace_meta", default=None)
# Explicit reference to the @traced (turn-level) span so _call_llm can log
# input/output onto it without depending on braintrust.current_span() — that
# call resolves to whatever the SDK considers active, which after a
# wrap_anthropic call is not reliably the parent span (NoopSpan / sibling).
_active_traced_span: ContextVar[object | None] = ContextVar("_active_traced_span", default=None)


def _braintrust_prod_enabled() -> bool:
    return bool(os.environ.get("BRAINTRUST_PROD_API_KEY"))


def _ensure_braintrust_inited() -> bool:
    """Lazy-init the Braintrust prod logger. Idempotent. Returns True iff active.

    Failure is logged once and remembered — we never want a Braintrust outage
    or misconfig to break production LLM traffic.
    """
    global _braintrust_inited
    if _braintrust_inited is not None:
        return _braintrust_inited == "active"
    if not _braintrust_prod_enabled():
        _braintrust_inited = "disabled"
        return False
    try:
        api_key = os.environ["BRAINTRUST_PROD_API_KEY"]
        project = os.environ.get("BRAINTRUST_PROD_PROJECT", "north-star-prod")
        braintrust.login(api_key=api_key)
        braintrust.init_logger(project=project)
        _braintrust_inited = "active"
        logger.info(f"Braintrust prod monitoring enabled — project={project}")
        return True
    except Exception as e:
        logger.warning(f"Braintrust init failed; production tracing disabled: {e}")
        _braintrust_inited = "failed"
        return False


def _maybe_wrap(client: anthropic.Anthropic) -> anthropic.Anthropic:
    """Wrap with braintrust.wrap_anthropic when prod monitoring is on; else passthrough."""
    if not _ensure_braintrust_inited():
        return client
    try:
        return braintrust.wrap_anthropic(client)
    except Exception as e:
        logger.warning(f"Braintrust wrap_anthropic failed; returning unwrapped client: {e}")
        return client


@contextmanager
def set_trace_meta(**kwargs):
    """Set/extend trace metadata for any LLM calls inside this block.

    Composes with metadata set by an outer block — None values are filtered so
    they don't override existing keys. Cheap when monitoring is off (just a
    contextvar push/pop), so it's safe to leave wrapping handlers unconditionally.
    """
    current = _trace_meta.get() or {}
    merged = {**current, **{k: v for k, v in kwargs.items() if v is not None}}
    token = _trace_meta.set(merged)
    try:
        yield
    finally:
        _trace_meta.reset(token)


def traced(turn_type: str):
    """Decorator: wrap an async ``call_*`` tool in a Braintrust trace span.

    Every Anthropic call inside the wrapped function lands as a child span of
    this one, with the contextvar trace metadata (session_id, phase, etc.)
    attached. No-op when monitoring is off.
    """
    from functools import wraps

    def decorator(fn):
        @wraps(fn)
        async def wrapper(*args, **kwargs):
            with trace_call(turn_type):
                return await fn(*args, **kwargs)
        return wrapper
    return decorator


def _bubble_io_to_parent_span(prompt: str, output: str) -> None:
    """Write the prompt + response onto the @traced parent span.

    wrap_anthropic logs the API call to its own child span. The parent span
    (where filterable metadata lives) gets nothing by default, so Braintrust
    online scorers that resolve ``{{input}}`` and ``{{output}}`` against the
    trace root substitute empty strings — and the judge model rightly says
    "no charter was provided" and picks ``bad``.

    We hold an explicit reference to the @traced span via a ContextVar (set in
    ``trace_call``) rather than reading ``braintrust.current_span()``, because
    after the wrap_anthropic API call returns, the SDK's notion of "current"
    can be a NoopSpan or sibling — its ``.log(...)`` would silently no-op,
    leaving scorer input/output empty. Logging directly onto the captured
    parent span sidesteps that ambiguity. Best-effort; never raises.
    """
    if not _ensure_braintrust_inited():
        return
    span = _active_traced_span.get(None)
    if span is None:
        return
    try:
        span.log(input=prompt, output=output)
    except Exception as e:
        logger.warning(f"Braintrust bubble I/O failed: {e}")


@contextmanager
def trace_call(turn_type: str, **extra):
    """Open a Braintrust span around an LLM call. No-op when monitoring is off.

    Metadata = contextvar-set trace meta + ``extra`` kwargs + {turn_type, model_name}.
    Inside the block, wrap_anthropic API calls are recorded as child spans of
    this one, so trace-level filters in Braintrust (e.g. ``phase = "charter"``)
    match every leaf span underneath.
    """
    if not _ensure_braintrust_inited():
        yield None
        return
    base = _trace_meta.get() or {}
    metadata = {
        **base,
        **{k: v for k, v in extra.items() if v is not None},
        "turn_type": turn_type,
        "model_name": get_model(),
    }
    try:
        span_cm = braintrust.start_span(name=turn_type, type="task")
    except Exception as e:
        logger.warning(f"Braintrust start_span failed: {e}")
        yield None
        return
    try:
        with span_cm as span:
            try:
                span.log(metadata=metadata)
            except Exception as e:
                logger.warning(f"Braintrust span.log failed: {e}")
            # Expose this span to _bubble_io_to_parent_span so it can log
            # input/output without relying on braintrust.current_span() (which
            # may resolve to a child / NoopSpan after wrap_anthropic returns).
            token = _active_traced_span.set(span)
            try:
                yield span
            finally:
                _active_traced_span.reset(token)
    except Exception:
        # Re-raise — span context manager already captured the exception in
        # the trace, but we don't want to swallow real errors.
        raise


def get_client() -> anthropic.Anthropic:
    """Get an Anthropic client — uses per-request key if provided, else env var.

    Supports OpenRouter keys (prefix ``sk-or-``).  When an OpenRouter key is
    detected the client is configured with OpenRouter's base URL.  Priority for
    env-var keys: ANTHROPIC_API_KEY > OPENROUTER_API_KEY.

    When ``BRAINTRUST_PROD_API_KEY`` is set, the returned client is wrapped
    with braintrust.wrap_anthropic so every call is captured as a span.
    """
    global _client
    request_key = _request_api_key.get(None)
    if request_key:
        # Per-request key: create a fresh client (not cached)
        if _is_openrouter_key(request_key):
            return _maybe_wrap(anthropic.Anthropic(api_key=request_key, base_url=OPENROUTER_BASE_URL))
        return _maybe_wrap(anthropic.Anthropic(api_key=request_key))
    # Default: use env var (cached singleton)
    if _client is None:
        or_key = os.environ.get("OPENROUTER_API_KEY")
        if not os.environ.get("ANTHROPIC_API_KEY") and or_key:
            _client = _maybe_wrap(anthropic.Anthropic(api_key=or_key, base_url=OPENROUTER_BASE_URL))
        else:
            _client = _maybe_wrap(anthropic.Anthropic())
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
    """Raised when the provider rejects the API key itself — wrong key, key
    for the wrong provider, missing auth header. Surfaces as HTTP 401 with
    "Check the API key in Settings" copy. Distinct from LLMModelError so the
    frontend doesn't tell the user to check their key when the key is fine
    but they typed an unrecognized model id."""

    def __init__(self, message: str, provider: str = "anthropic"):
        super().__init__(message)
        self.provider = provider


class LLMModelError(Exception):
    """Raised when the provider accepts the auth but rejects the model id —
    typo, retired snapshot, model not entitled on this account, etc.
    Surfaces as HTTP 422 with copy that points the user at the model
    selector rather than the API key field."""

    def __init__(self, message: str, provider: str = "anthropic"):
        super().__init__(message)
        self.provider = provider


def _current_provider() -> str:
    return "openrouter" if _is_request_using_openrouter() else "anthropic"


def _is_model_error(err: Exception) -> bool:
    """Detect 'model id is wrong' style failures. Auth is fine; the model
    name doesn't resolve on the provider side. Pattern-matched because no
    SDK exposes a distinct error class for this."""
    msg = str(err).lower()
    needles = (
        "model not found",
        "model_not_found",
        "no endpoints found",
        "not a valid model",
        "unknown model",
        "model does not exist",
    )
    return any(n in msg for n in needles)


def _is_auth_error(err: Exception) -> bool:
    """Detect auth-failure responses. Strict: only matches phrases that
    actually indicate an auth problem. Model-not-found used to live here
    too but mislabeled "wrong model id" as "check your API key" in the UI
    — that case now goes through _is_model_error."""
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
    )
    return any(n in msg for n in needles)


def _is_billing_error(err: Exception) -> bool:
    """Detect 'out of credits' / 'billing' style errors from Anthropic and
    OpenRouter. Both providers return 400-class errors with a textual body
    we have to pattern-match on — no dedicated error class for this case.

    Needles are deliberately specific. The bare substring "billing" used to
    live in this list and produced false positives — Anthropic error footers
    sometimes mention "contact billing@anthropic.com" on unrelated failures,
    which would surface to users as a misleading "billing issue" banner.
    """
    msg = str(err).lower()
    needles = (
        "credit balance is too low",
        "credit_balance",
        "insufficient_credits",
        "insufficient credits",
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
        # layer can return a friendly 402/401/422 instead of a generic 500.
        # Order matters: model-not-found checks first (its phrasing has no
        # overlap with auth/billing strings, but checking first keeps the
        # intent obvious).
        if _is_billing_error(e):
            raise LLMBillingError(str(e), provider=_current_provider()) from e
        if _is_model_error(e):
            raise LLMModelError(str(e), provider=_current_provider()) from e
        if _is_auth_error(e):
            raise LLMAuthError(str(e), provider=_current_provider()) from e
        raise
    elapsed_ms = int((time.time() - start) * 1000)
    logger.info(f"_call_llm: OK in {elapsed_ms}ms, output_tokens={response.usage.output_tokens}")
    text = response.content[0].text if response.content else ""
    _bubble_io_to_parent_span(prompt, text)
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
    _bubble_io_to_parent_span(prefix + suffix, text)
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

@traced("discovery")
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

    # Overwrite the generic prompt/raw-text bubble with discovery-specific
    # clean values for the online scorers (goal_extraction_quality,
    # conversation_quality). Both fire on this @traced("discovery") span:
    #   * input  = formatted conversation history + a phase tag — gives
    #              conversation_quality the phase it asks about, and gives
    #              goal_extraction_quality the user statements it's checking
    #              the extraction against.
    #   * output = the agent's clean text question + the extraction block as
    #              fenced JSON. conversation_quality reads the question;
    #              goal_extraction_quality reads the extraction block.
    try:
        from .prompt import _format_conversation  # local import: avoid cycle at module load
        convo = _format_conversation(state.input.conversation_history)
        phase_tag = f"[Current discovery phase: {state.discovery_phase.value}]"
        bubble_input = f"{phase_tag}\n\n{convo}"
        if user_message:
            bubble_input += f"\n\nuser (latest): {user_message}"
        output_parts = [clean_text]
        if extraction:
            output_parts.append("```extraction\n" + json.dumps(extraction, indent=2) + "\n```")
        _bubble_io_to_parent_span(bubble_input, "\n\n".join(output_parts))
    except Exception as e:
        logger.warning(f"Discovery scorer payload bubble failed: {e}")

    return clean_text, extraction, [meta]


def _build_charter_conversation_summary(state: SessionState) -> str:
    """Distill SessionState into a clean conversation string for the charter
    scorer. The raw ``generate_draft`` prompt is mostly schema/instructions —
    the scorer's ``{{conversation}}`` placeholder needs the actual user-stated
    goals, users, and stories. Keep it short and unambiguous.
    """
    parts: list[str] = []
    goals = state.extracted_goals or []
    if not goals and state.input.business_goals:
        goals = [g.strip() for g in state.input.business_goals.splitlines() if g.strip()]
    if goals:
        parts.append("Business goals:\n" + "\n".join(f"- {g}" for g in goals))
    users = state.extracted_users or []
    if users:
        parts.append("Users:\n" + "\n".join(f"- {u}" for u in users))
    stories = state.extracted_stories or []
    if stories:
        story_lines = []
        for s in stories:
            who = s.get("who", "?")
            what = s.get("what", "?")
            why = s.get("why", "")
            kind = s.get("kind", "positive")
            tag = " [off-target]" if kind == "off_target" else ""
            story_lines.append(f"- As a {who}, I want to {what}, so that {why}{tag}")
        parts.append("Stories:\n" + "\n".join(story_lines))
    if not parts and state.input.user_stories:
        parts.append("Raw user stories text:\n" + state.input.user_stories)
    return "\n\n".join(parts) if parts else "(no conversation captured)"


@traced("generate_draft")
async def call_generate_draft(state: SessionState) -> tuple[Charter, list[dict]]:
    """Generate a charter draft. Returns (parsed Charter, call metadata list)."""
    await _refresh_settings()
    prompt = build_generate_draft_prompt(state, creativity=get_creativity())
    text, meta = _call_llm(prompt, max_tokens=4096)
    charter_data = _extract_json(text)

    # Charter-specific scorer payload. The generic _call_llm bubble already
    # logged input=prompt / output=text on this span, but Braintrust online
    # scorers can be brittle about where they read input/output from. Logging
    # the parsed charter + a distilled conversation onto explicit metadata
    # fields lets charter_quality.md reference them via {{metadata.charter}} /
    # {{metadata.conversation}} — which Braintrust resolves directly from the
    # matched span's metadata bag, no inference involved.
    # Overwrite the generic prompt/raw-text that _call_llm bubbled onto this
    # span with charter-specific clean values. Braintrust online scorers
    # accept {{input}}/{{output}} as first-class placeholders (custom
    # metadata keys are flagged as undefined in the prompt validator), so we
    # put the conversation summary in input and the parsed charter JSON in
    # output. Subsequent span.log() calls merge/overwrite — last write wins.
    try:
        _bubble_io_to_parent_span(
            _build_charter_conversation_summary(state),
            json.dumps(charter_data, indent=2),
        )
    except Exception as e:
        logger.warning(f"Charter scorer payload bubble failed: {e}")

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


@traced("validate_charter")
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


@traced("conversational")
async def call_conversational_turn(state: SessionState, user_message: str) -> tuple[str, list[dict]]:
    """Send a conversational turn. Returns (raw text, call metadata list)."""
    await _refresh_settings()
    prompt = build_conversational_turn_prompt(state, user_message)
    text, meta = _call_llm(prompt, max_tokens=2048)
    return text, [meta]


@traced("suggestions")
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


@traced("suggest_goals")
async def call_suggest_goals(goals: list[str]) -> tuple[list[str], list[dict]]:
    """Suggest additional business goals. Returns (suggestions, call metadata list)."""
    from .prompt import build_suggest_goals_prompt
    await _refresh_settings()
    prompt = build_suggest_goals_prompt(goals)
    text, meta = _call_llm(prompt, max_tokens=512)
    data = _extract_json(text)
    suggestions = data.get("suggestions", [])
    # Scorer payload: existing goals as input, suggestions as output.
    try:
        bubble_input = "Existing goals:\n" + ("\n".join(f"- {g}" for g in goals) or "(none)")
        bubble_output = "Suggested goals:\n" + ("\n".join(f"- {s}" for s in suggestions) or "(none)")
        _bubble_io_to_parent_span(bubble_input, bubble_output)
    except Exception as e:
        logger.warning(f"suggest_goals scorer payload bubble failed: {e}")
    return suggestions, [meta]


@traced("evaluate_goals")
async def call_evaluate_goals(goals: list[str]) -> tuple[list[dict], list[dict]]:
    """Evaluate business goal quality. Returns (feedback list, call metadata list)."""
    from .prompt import build_evaluate_goals_prompt
    await _refresh_settings()
    prompt = build_evaluate_goals_prompt(goals)
    text, meta = _call_llm(prompt, max_tokens=512)
    data = _extract_json(text)
    feedback = data.get("feedback", [])
    # Scorer payload: goals as input, per-goal feedback (issue + suggestion) as output.
    try:
        bubble_input = "Goals to evaluate:\n" + ("\n".join(f"- {g}" for g in goals) or "(none)")
        bubble_output = json.dumps(feedback, indent=2)
        _bubble_io_to_parent_span(bubble_input, bubble_output)
    except Exception as e:
        logger.warning(f"evaluate_goals scorer payload bubble failed: {e}")
    return feedback, [meta]


@traced("generate_skill_from_goals")
async def call_generate_skill_from_goals(
    goals: list[str],
    stories: list[dict],
    project_name: str | None,
) -> tuple[str, list[dict]]:
    """Generate a full SKILL.md body. Returns (body, call metadata list)."""
    from .prompt import build_generate_skill_from_goals_prompt
    await _refresh_settings()
    prompt = build_generate_skill_from_goals_prompt(goals, stories, project_name)
    text, meta = _call_llm(prompt, max_tokens=2048)
    body = text.strip()
    # Strip accidental code fences if the model wrapped output despite the
    # explicit instruction not to.
    if body.startswith("```"):
        lines = body.splitlines()
        # Drop leading and trailing fence lines.
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        body = "\n".join(lines).strip()
    try:
        bubble_input = (
            "Goals:\n" + ("\n".join(f"- {g}" for g in goals) or "(none)")
            + "\n\nStories:\n"
            + ("\n".join(
                f"- As a {s.get('who','')}, I want to {s.get('what','')}" for s in stories
            ) or "(none)")
        )
        _bubble_io_to_parent_span(bubble_input, body)
    except Exception as e:
        logger.warning(f"generate_skill_from_goals scorer payload bubble failed: {e}")
    return body, [meta]


@traced("suggest_skill")
async def call_suggest_skill(
    goals: list[str],
    stories: list[dict],
    current_body: str | None,
) -> tuple[list[dict], list[dict]]:
    """Suggest SKILL.md content ideas. Returns (suggestions, call metadata list).

    Each suggestion is ``{"summary": str, "where": str | None}``. The model is
    instructed to point at the section the suggestion belongs in; we accept
    legacy plain-string entries too so older clients / cached prompts still
    deserialize cleanly.
    """
    from .prompt import build_suggest_skill_prompt
    await _refresh_settings()
    prompt = build_suggest_skill_prompt(goals, stories, current_body)
    text, meta = _call_llm(prompt, max_tokens=768)
    data = _extract_json(text)
    suggestions: list[dict] = []
    for s in data.get("suggestions", []):
        if isinstance(s, str) and s.strip():
            suggestions.append({"summary": s.strip(), "where": None})
        elif isinstance(s, dict):
            summary = (s.get("summary") or "").strip()
            where = (s.get("where") or "").strip() or None
            if summary:
                suggestions.append({"summary": summary, "where": where})
    try:
        bubble_input = (
            "Goals:\n" + ("\n".join(f"- {g}" for g in goals) or "(none)")
            + "\n\nStories:\n"
            + ("\n".join(
                f"- As a {s.get('who','')}, I want to {s.get('what','')}" for s in stories
            ) or "(none)")
        )
        bubble_output = "Skill suggestions:\n" + (
            "\n".join(
                f"- {s['summary']}"
                + (f"  →  {s['where']}" if s.get("where") else "")
                for s in suggestions
            ) or "(none)"
        )
        _bubble_io_to_parent_span(bubble_input, bubble_output)
    except Exception as e:
        logger.warning(f"suggest_skill scorer payload bubble failed: {e}")
    return suggestions, [meta]


@traced("suggest_stories")
async def call_suggest_stories(goals: list[str], stories: list[dict]) -> tuple[list[dict], list[dict]]:
    """Suggest additional user stories. Returns (suggestions, call metadata list)."""
    from .prompt import build_suggest_stories_prompt
    await _refresh_settings()
    prompt = build_suggest_stories_prompt(goals, stories)
    text, meta = _call_llm(prompt, max_tokens=512)
    data = _extract_json(text)
    suggestions = data.get("suggestions", [])
    # Scorer payload: goals + existing stories as input, suggested stories as output.
    try:
        existing_stories = []
        for s in stories or []:
            who = s.get("who") if isinstance(s, dict) else None
            what = s.get("what") if isinstance(s, dict) else None
            why = s.get("why") if isinstance(s, dict) else None
            if who and what:
                existing_stories.append(f"- As a {who}, I want to {what}, so that {why or '...'}")
        bubble_input = (
            "Goals:\n" + ("\n".join(f"- {g}" for g in goals) or "(none)") +
            "\n\nExisting stories:\n" + ("\n".join(existing_stories) or "(none)")
        )
        bubble_output = "Suggested stories:\n" + json.dumps(suggestions, indent=2)
        _bubble_io_to_parent_span(bubble_input, bubble_output)
    except Exception as e:
        logger.warning(f"suggest_stories scorer payload bubble failed: {e}")
    return suggestions, [meta]


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


@traced("synthesize_examples")
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


@traced("review_examples")
async def call_review_examples(charter: dict, examples: list[dict]) -> tuple[list[dict], list[dict]]:
    """Auto-review examples against charter. Returns (reviews, call metadata list)."""
    await _refresh_settings()
    prompt = build_review_examples_prompt(charter, examples)
    text, meta = _call_llm(prompt, max_tokens=4096)
    data = _extract_json(text)
    return data.get("reviews", []), [meta]


@traced("retag_examples")
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


@traced("dataset_chat")
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


@traced("gap_analysis")
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

@traced("generate_scorers")
async def call_generate_scorers(
    charter: dict,
    agent_contract: str | None = None,
) -> tuple[list[dict], list[dict]]:
    """Generate evaluation scorers from charter. Returns (scorers, call metadata list).

    ``agent_contract`` is the verbatim prompt / SKILL.md the system being
    scored operates under. See build_generate_scorers_prompt for why this
    matters — without it, scorers can be written with criteria the agent
    can never satisfy because the LLM has to guess what the agent does.
    """
    await _refresh_settings()
    prompt = build_generate_scorers_prompt(charter, agent_contract=agent_contract)
    text, meta = _call_llm(prompt, max_tokens=8192)
    data = _extract_json(text)
    return data.get("scorers", []), [meta]


# --- Revision suggestion tools ---

@traced("revise_examples")
async def call_revise_examples(charter: dict, examples_with_verdicts: list[dict]) -> tuple[list[dict], list[dict]]:
    """Suggest revisions for examples that failed review. Returns (revisions, call metadata list)."""
    await _refresh_settings()
    prompt = build_revise_examples_prompt(charter, examples_with_verdicts)
    text, meta = _call_llm(prompt, max_tokens=8192)
    data = _extract_json(text)
    return data.get("revisions", []), [meta]


# --- Schema detection tools ---

@traced("detect_schema")
async def call_detect_schema(content: str, content_type: str = "auto") -> tuple[dict, list[dict]]:
    """Detect schema from pasted content. Returns (schema data, call metadata list)."""
    await _refresh_settings()
    prompt = build_detect_schema_prompt(content, content_type)
    text, meta = _call_llm(prompt, max_tokens=2048)
    data = _extract_json(text)
    return data, [meta]


@traced("infer_schema")
async def call_infer_schema(examples: list[dict], charter: dict) -> tuple[dict, list[dict]]:
    """Infer schema from existing examples. Returns (inferred schema, call metadata list)."""
    await _refresh_settings()
    prompt = build_infer_schema_prompt(examples, charter)
    text, meta = _call_llm(prompt, max_tokens=2048)
    data = _extract_json(text)
    return data, [meta]


@traced("import_from_url")
async def call_import_from_url(content: str, url: str, detected_type: str) -> tuple[dict, list[dict]]:
    """Extract schema from URL content. Returns (schema data, call metadata list)."""
    await _refresh_settings()
    prompt = build_import_url_prompt(content, url, detected_type)
    text, meta = _call_llm(prompt, max_tokens=2048)
    data = _extract_json(text)
    return data, [meta]


@traced("suggest_improvements")
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


@traced("skill_seed")
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
    # Scorer payload: SKILL.md content (with name/description header) as
    # input, the parsed seed bundle (goals/users/stories/task) as output.
    try:
        header_lines = []
        if skill_name:
            header_lines.append(f"Skill name: {skill_name}")
        if skill_description:
            header_lines.append(f"Skill description: {skill_description}")
        header = "\n".join(header_lines)
        bubble_input = (header + "\n\n" if header else "") + "SKILL.md:\n" + (skill_body or "(empty)")
        bubble_output = json.dumps(data, indent=2)
        _bubble_io_to_parent_span(bubble_input, bubble_output)
    except Exception as e:
        logger.warning(f"skill_seed scorer payload bubble failed: {e}")
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
        lines = [line for line in lines[1:] if not line.strip().startswith("```")]
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
