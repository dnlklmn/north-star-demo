"""Provider-fallback middleware: retry on the other provider when the
current one is out of credits.

Today the LLM call stack (``tools.py``) picks Anthropic when its key is set
and OpenRouter only when Anthropic's key is absent. That's a hard priority
— if ``ANTHROPIC_API_KEY`` is set but the account is drained, the call
fails with ``LLMBillingError`` and ``OPENROUTER_API_KEY`` is never tried
even when both are configured.

This middleware closes that gap. When the terminal SDK call raises
``LLMBillingError`` and the *other* provider's key is set, it swaps
providers (by setting the request-scoped ``_request_api_key`` ContextVar
that ``get_client`` and ``_resolve_model`` both read) and retries the call
once. If the fallback provider is also out of credits, it re-raises the
*original* error so the 402 handler reports the user's primary key, not
the fallback.

Why a middleware and not in-line in ``_call_llm_sync``:
  - Slots into the existing chain alongside cache and spend cap.
  - Wraps every middleware-routed call site uniformly; new sites get the
    behaviour for free as long as they go through ``_dispatch_llm``.
  - Stays test-isolated — the chain can be wiped between tests.

Position in the chain: INNERMOST. Cache (outer) short-circuits hits before
the fallback runs; spend cap (middle) counts whichever provider actually
succeeded. The fallback only ever sees real terminal-call failures, which
is exactly when a provider swap is appropriate.

The middleware is a no-op when:
  - Only one provider's key is set — nothing to fall back to.
  - A per-request key was set explicitly via ``set_request_api_key``
    — the caller chose this provider; we don't second-guess them.
  - The error isn't ``LLMBillingError`` — auth/model errors mean the call
    is misconfigured, not exhausted, and silently swapping providers
    would mask the misconfiguration.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Awaitable, Callable

from .tools import (
    LLMBillingError,
    _is_openrouter_key,
    _request_api_key,
)

logger = logging.getLogger(__name__)


def _other_provider_key() -> str | None:
    """Return the API key for the provider NOT currently in use, or None
    when it isn't configured.

    "Currently in use" is decided the same way ``_current_provider`` decides
    it: if a per-request key is set, that key's provider is current; otherwise
    we look at env var presence. This middleware also bails out when a
    per-request key is set (the caller picked the provider on purpose), so in
    practice this function only runs in the env-var case — but the per-request
    branch is included for completeness and so a future caller that wants the
    middleware to apply even with a per-request key gets sensible behaviour.
    """
    request_key = _request_api_key.get(None)
    if request_key is not None:
        if _is_openrouter_key(request_key):
            return os.environ.get("ANTHROPIC_API_KEY") or None
        return os.environ.get("OPENROUTER_API_KEY") or None
    # Env-var case: Anthropic is the default when its key is set, otherwise
    # OpenRouter. Mirror tools.get_client priority.
    if os.environ.get("ANTHROPIC_API_KEY"):
        return os.environ.get("OPENROUTER_API_KEY") or None
    if os.environ.get("OPENROUTER_API_KEY"):
        return os.environ.get("ANTHROPIC_API_KEY") or None
    return None


async def provider_fallback_middleware(
    descriptor: dict[str, Any],
    call_next: Callable[[], Awaitable[tuple[str, Any]]],
) -> tuple[str, Any]:
    """Retry once on the other provider when the current one is out of credits.

    The retry path uses the existing per-request key mechanism: setting the
    ``_request_api_key`` ContextVar makes ``get_client`` build a fresh
    (non-cached) client bound to that key, and ``_resolve_model`` adjust the
    model name to whatever shape the new provider expects. So this middleware
    only needs to flip the ContextVar — every other concern (auth, base URL,
    model name) follows automatically.
    """
    try:
        return await call_next()
    except LLMBillingError as primary_err:
        # Caller explicitly picked a provider — respect it. Auto-switching
        # would mask a real configuration choice (e.g. a session that uses
        # an OpenRouter key on purpose because the Anthropic key has lower
        # rate limits).
        if _request_api_key.get(None) is not None:
            raise

        fallback_key = _other_provider_key()
        if not fallback_key:
            # Only one provider configured — nothing to fall back to.
            raise

        fallback_provider = (
            "openrouter" if _is_openrouter_key(fallback_key) else "anthropic"
        )
        logger.warning(
            "provider_fallback: %s out of credits; retrying via %s",
            primary_err.provider,
            fallback_provider,
        )

        token = _request_api_key.set(fallback_key)
        try:
            return await call_next()
        except LLMBillingError as fallback_err:
            # Both providers exhausted. Preserve the ORIGINAL error so the
            # 402 banner names the user's default provider (the one they
            # probably need to top up), not the fallback we tried silently.
            logger.error(
                "provider_fallback: fallback %s also out of credits — "
                "both providers appear drained",
                fallback_err.provider,
            )
            raise primary_err
        finally:
            # Always restore so the swap doesn't leak across calls in this
            # async context — important for tests and for the cached client
            # singleton, which would otherwise stay bound to the fallback.
            _request_api_key.reset(token)


# --- Setup hook (called from main.lifespan) ---

def setup() -> bool:
    """Register the provider-fallback middleware unless explicitly disabled.

    Returns True if registered. Disable via
    ``PROVIDER_FALLBACK_ENABLED=false`` if you specifically want the call
    to fail loudly when the primary provider is out of credits — e.g. a
    monitoring run where silently swapping providers would hide the issue.

    Call this AFTER cache + spend_cap setup so the fallback ends up as the
    innermost layer. Inner placement means cache hits don't trigger
    fallback attempts and spend cap correctly counts whichever provider
    actually served the request.
    """
    if os.environ.get("PROVIDER_FALLBACK_ENABLED", "true").lower() in (
        "0",
        "false",
        "no",
    ):
        logger.info("provider_fallback: disabled via PROVIDER_FALLBACK_ENABLED")
        return False
    from . import tools
    tools.register_llm_middleware(provider_fallback_middleware)
    logger.info("provider_fallback: middleware registered")
    return True
