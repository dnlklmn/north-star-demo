"""Unit tests for ``app.provider_fallback``.

The middleware sits in the LLM call chain and, on ``LLMBillingError`` from
the primary provider, swaps to the other provider via the request-scoped
``_request_api_key`` ContextVar and retries once. These tests exercise
that contract without touching the real Anthropic SDK.

Why this matters: a user with both Anthropic and OpenRouter keys
configured should not see their workflow break just because one provider
is out of credits. Before this middleware, Anthropic took hard priority
and an exhausted Anthropic key meant a 402 even when OpenRouter was set.
"""

from __future__ import annotations

import os

import pytest

from app import provider_fallback, tools
from app.tools import LLMBillingError, _request_api_key


@pytest.fixture
def isolate_env(monkeypatch):
    """Strip provider env vars so each test sets exactly what it needs.

    The smoke / local-dev environment has a real ANTHROPIC_API_KEY; leaving
    it in place would let the middleware "succeed" by retrying against a
    real key. Each test sets the keys it wants and we restore afterward
    via monkeypatch.
    """
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    # Clean up the per-request ContextVar between tests — set() can leak if a
    # previous test ran the middleware and the finally didn't fire (e.g.
    # because the test itself raised). reset() guards against that.
    token = _request_api_key.set(None)
    yield
    _request_api_key.reset(token)


@pytest.fixture
def isolated_middlewares():
    """Wipe the middleware chain so tests don't accumulate state.

    The chain is module-global by design (registered once in lifespan), but
    tests register and inspect it per-case. clear before + after keeps each
    test's setup local.
    """
    tools.clear_llm_middlewares()
    yield
    tools.clear_llm_middlewares()


# ---- _other_provider_key ---------------------------------------------------


class TestOtherProviderKey:
    def test_returns_openrouter_when_anthropic_is_current(self, isolate_env, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-primary")
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-fallback")
        assert provider_fallback._other_provider_key() == "sk-or-fallback"

    def test_returns_anthropic_when_openrouter_is_current(self, isolate_env, monkeypatch):
        # OpenRouter is "current" when ANTHROPIC is unset and OPENROUTER is set.
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-primary")
        # ANTHROPIC unset here — but we set it to simulate "other provider
        # available" anyway. The function should return it.
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-fallback")
        # Now ANTHROPIC is "current" (priority). Swap the perspective: when
        # the per-request key is openrouter-shaped, openrouter is current and
        # the fallback should be Anthropic.
        _request_api_key.set("sk-or-explicit")
        assert provider_fallback._other_provider_key() == "sk-ant-fallback"

    def test_returns_none_when_only_one_provider_configured(self, isolate_env, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-only")
        # OPENROUTER unset.
        assert provider_fallback._other_provider_key() is None

    def test_returns_none_when_neither_provider_configured(self, isolate_env):
        assert provider_fallback._other_provider_key() is None


# ---- provider_fallback_middleware ------------------------------------------


async def _run_middleware(terminal):
    """Tiny harness that drives the middleware with a fake terminal.

    The middleware's `call_next` is just `terminal` here — no other
    middlewares are in the chain — so we can observe exactly how many times
    it gets invoked and what ContextVar state is visible on each call.
    """
    descriptor: dict = {"kind": "test"}
    return await provider_fallback.provider_fallback_middleware(
        descriptor, terminal
    )


class TestProviderFallbackMiddleware:
    @pytest.mark.asyncio
    async def test_passes_through_on_success(
        self, isolate_env, isolated_middlewares, monkeypatch
    ):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-x")
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-y")
        calls = 0

        async def terminal():
            nonlocal calls
            calls += 1
            return ("ok", {"model": "x"})

        result = await _run_middleware(terminal)
        assert result == ("ok", {"model": "x"})
        assert calls == 1  # No retry when no error.

    @pytest.mark.asyncio
    async def test_retries_on_billing_error_with_other_provider(
        self, isolate_env, isolated_middlewares, monkeypatch
    ):
        # The success-after-retry case: Anthropic billing fails, OpenRouter
        # succeeds, the middleware returns the OpenRouter response.
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-primary")
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-fallback")
        calls = 0
        seen_keys: list[str | None] = []

        async def terminal():
            nonlocal calls
            calls += 1
            seen_keys.append(_request_api_key.get(None))
            if calls == 1:
                raise LLMBillingError("credit balance is too low", provider="anthropic")
            return ("from-openrouter", {"model": "anthropic/claude-sonnet-4-5"})

        result = await _run_middleware(terminal)
        assert result[0] == "from-openrouter"
        assert calls == 2  # One failure + one retry.
        # First attempt: no per-request key (env-var default = Anthropic).
        # Second attempt: per-request key set to the OpenRouter fallback.
        assert seen_keys == [None, "sk-or-fallback"]
        # After the middleware returns, the ContextVar must be back to None —
        # the swap must not leak to subsequent calls in this task.
        assert _request_api_key.get(None) is None

    @pytest.mark.asyncio
    async def test_no_retry_when_other_provider_not_configured(
        self, isolate_env, isolated_middlewares, monkeypatch
    ):
        # The "only one provider" case. Anthropic billing fails, OpenRouter
        # isn't set — nothing to fall back to, so the error propagates.
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-only")
        calls = 0

        async def terminal():
            nonlocal calls
            calls += 1
            raise LLMBillingError("credit balance is too low", provider="anthropic")

        with pytest.raises(LLMBillingError) as exc:
            await _run_middleware(terminal)
        assert calls == 1  # No retry attempted.
        assert exc.value.provider == "anthropic"

    @pytest.mark.asyncio
    async def test_no_retry_when_request_key_was_explicit(
        self, isolate_env, isolated_middlewares, monkeypatch
    ):
        # Caller pinned a provider via per-request key — we must respect that
        # choice. Swapping silently would mask a deliberate decision.
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-default")
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-default")
        _request_api_key.set("sk-or-explicit")
        calls = 0

        async def terminal():
            nonlocal calls
            calls += 1
            raise LLMBillingError("credit balance is too low", provider="openrouter")

        with pytest.raises(LLMBillingError):
            await _run_middleware(terminal)
        assert calls == 1

    @pytest.mark.asyncio
    async def test_no_retry_on_non_billing_error(
        self, isolate_env, isolated_middlewares, monkeypatch
    ):
        # Auth and model errors mean the call is misconfigured, not exhausted —
        # silently swapping providers would hide the misconfiguration.
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-x")
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-y")
        calls = 0

        async def terminal():
            nonlocal calls
            calls += 1
            raise tools.LLMAuthError("bad key", provider="anthropic")

        with pytest.raises(tools.LLMAuthError):
            await _run_middleware(terminal)
        assert calls == 1

    @pytest.mark.asyncio
    async def test_reraises_original_error_when_both_exhausted(
        self, isolate_env, isolated_middlewares, monkeypatch
    ):
        # Both providers drained — the 402 banner should name the user's
        # primary key (Anthropic), not the silently-tried fallback.
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-primary")
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-fallback")
        calls = 0

        async def terminal():
            nonlocal calls
            calls += 1
            raise LLMBillingError(
                "credit balance is too low",
                provider="anthropic" if calls == 1 else "openrouter",
            )

        with pytest.raises(LLMBillingError) as exc:
            await _run_middleware(terminal)
        assert calls == 2  # Tried, retried, both billed-out.
        # Original error wins so the user fixes the right account.
        assert exc.value.provider == "anthropic"

    @pytest.mark.asyncio
    async def test_context_var_restored_after_retry_failure(
        self, isolate_env, isolated_middlewares, monkeypatch
    ):
        # If both providers fail, the finally must still reset the
        # ContextVar — otherwise the fallback key leaks into the next call
        # in this async task and silently changes provider state.
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-primary")
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-fallback")

        async def terminal():
            raise LLMBillingError("dry", provider="anthropic")

        with pytest.raises(LLMBillingError):
            await _run_middleware(terminal)
        assert _request_api_key.get(None) is None


# ---- setup() ---------------------------------------------------------------


class TestSetup:
    def test_registers_by_default(self, isolated_middlewares, monkeypatch):
        monkeypatch.delenv("PROVIDER_FALLBACK_ENABLED", raising=False)
        registered = provider_fallback.setup()
        assert registered is True
        assert provider_fallback.provider_fallback_middleware in tools._llm_middlewares

    def test_disabled_via_env(self, isolated_middlewares, monkeypatch):
        monkeypatch.setenv("PROVIDER_FALLBACK_ENABLED", "false")
        registered = provider_fallback.setup()
        assert registered is False
        assert provider_fallback.provider_fallback_middleware not in tools._llm_middlewares
