"""Unit tests for app.spend_cap.estimate_cost_cents.

Cost estimation is pure math + a substring lookup against a constant table —
no DB, no env, no network. The middleware behaviour around it (DB writes,
HTTP 503 raising) is exercised end-to-end by the smoke test against a live
postgres; here we just pin the pricing table down so an accidental key
rename or a typo'd zero doesn't silently make the cap stop counting.
"""

from __future__ import annotations

from app.spend_cap import MODEL_PRICES_PER_1M_CENTS, estimate_cost_cents


class TestEstimateCostCents:
    def test_sonnet_4_5_basic(self):
        # 1M input tokens at 300 cents/M = 300 cents; 1M output at 1500 = 1500.
        # Bare family name should match its own entry exactly.
        assert estimate_cost_cents("claude-sonnet-4-5", 1_000_000, 1_000_000) == 1800

    def test_opus_4_7_snapshot_substring_match(self):
        # Dated snapshot collapses onto the family entry. Verifies the
        # longest-prefix logic — `claude-opus-4-7` must beat any shorter
        # accidental match.
        cost = estimate_cost_cents("claude-opus-4-7-20251020", 1_000_000, 1_000_000)
        # 1500 in + 7500 out = 9000.
        assert cost == 9000

    def test_haiku_4_5_small_call(self):
        # 1000 input tokens at 80 cents/M = 0.08 cents → CEIL to 1 cent.
        # We ceiling-divide so small-but-nonzero calls aren't silently free
        # under a budget cap. A $5 cap with 0.08-cent calls would otherwise
        # never trip if every call floored to 0.
        assert estimate_cost_cents("claude-haiku-4-5", 1_000, 1_000) == 1
        # 100k in + 100k out = 8 + 40 = 48 cents (the larger-scale math
        # is unchanged; ceiling only matters at sub-cent magnitudes).
        assert estimate_cost_cents("claude-haiku-4-5", 100_000, 100_000) == 48

    def test_unknown_model_returns_zero(self):
        # Models not in the table must return 0 — the cap silently
        # ignores them rather than blowing up. A warning is logged but
        # not asserted on here.
        assert estimate_cost_cents("gpt-4-turbo", 1_000_000, 1_000_000) == 0
        assert estimate_cost_cents("", 1000, 1000) == 0

    def test_zero_tokens(self):
        # Zero-token calls (e.g. cached responses or weird metadata) must
        # not produce negative or surprising results.
        assert estimate_cost_cents("claude-sonnet-4-5", 0, 0) == 0

    def test_sonnet_4_6_beats_sonnet_4(self):
        # Sanity check: `claude-sonnet-4-6-20251010` must match the more
        # specific 4-6 family, NOT the generic claude-sonnet-4 entry. They
        # happen to have the same price today, but if pricing diverges this
        # test will catch the wrong-key bug.
        # Force them to differ for the duration of the test.
        original = MODEL_PRICES_PER_1M_CENTS["claude-sonnet-4-6"].copy()
        MODEL_PRICES_PER_1M_CENTS["claude-sonnet-4-6"] = {"input": 999, "output": 999}
        try:
            cost = estimate_cost_cents(
                "claude-sonnet-4-6-20251010", 1_000_000, 1_000_000
            )
            assert cost == 1998  # 999 + 999, NOT 1800 (sonnet-4 price)
        finally:
            MODEL_PRICES_PER_1M_CENTS["claude-sonnet-4-6"] = original
