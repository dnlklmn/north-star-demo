"""Tests for the kNN gating in ``build_generate_scorers_prompt``.

What this proves:

1. **Off by default** — the kNN section + emit block do NOT appear when
   ``knn_available=False``. Pre-Tier-2 callers (the run_eval CLI harness,
   existing sessions) keep emitting the same scorer mix they always did.
2. **On when flagged** — when ``knn_available=True``, the LLM sees:
   - A new method choice in the "scoring METHOD" section
   - An emit-block instructing it to add ONE kNN scorer
   - The actual pool size, so it can reason about signal strength
3. **Allowlist tracks** — the runtime-helper allowlist always mentions
   ``knn_vote`` (because the runtime ALWAYS injects it; the gate is about
   whether the LLM is encouraged to use it, not whether the helper exists
   in the namespace).

We don't test the LLM's response — that's an integration concern. We
test the prompt SHAPE because that's the contract the LLM reads.
"""

from __future__ import annotations

from app.prompt import build_generate_scorers_prompt


_MINIMAL_SEED = {
    "task": {"input_description": "user query", "output_description": "answer"},
    "coverage": {"criteria": [{"text": "FAQ-style question"}]},
    "balance": {"criteria": []},
    "alignment": [
        {"feature_area": "concise", "good": "short", "bad": "verbose"},
    ],
    "rot": {"criteria": []},
    "safety": {"criteria": []},
}


def test_knn_block_omitted_when_unavailable() -> None:
    """The default path (no labeled+embedded pool yet) must NOT mention
    kNN anywhere in the prompt body — the LLM is bad at "you can use this
    but don't" instructions; omitting it cleanly avoids the trap."""
    prompt = build_generate_scorers_prompt(_MINIMAL_SEED)
    assert "kNN-against-labels" not in prompt
    assert "knn_quality_signal" not in prompt
    assert "labeled+embedded rows" not in prompt


def test_knn_block_present_when_available() -> None:
    """When the flag is on, the kNN section + the emit-block both appear,
    and the actual pool size is interpolated so the LLM can reason about
    signal strength."""
    prompt = build_generate_scorers_prompt(
        _MINIMAL_SEED,
        knn_available=True,
        knn_pool_size=42,
    )
    # Method choice (the "scoring METHOD" section)
    assert "kNN-against-labels" in prompt
    # Emit instructions (the "emit at most ONE" section)
    assert "knn_quality_signal" in prompt
    # Pool size is interpolated — exact value present so the LLM knows
    # the corpus depth without having to guess
    assert "42" in prompt


def test_knn_allowlist_always_present() -> None:
    """``knn_vote`` is ALWAYS in the runtime-helper allowlist. The runtime
    injects it unconditionally (it's a no-op closure when the pool is
    empty); the prompt gate only controls whether the LLM is *encouraged*
    to emit a kNN scorer, not whether the helper exists."""
    # Off path
    prompt_off = build_generate_scorers_prompt(_MINIMAL_SEED)
    assert "knn_vote" in prompt_off
    # On path
    prompt_on = build_generate_scorers_prompt(
        _MINIMAL_SEED, knn_available=True, knn_pool_size=10
    )
    assert "knn_vote" in prompt_on


def test_knn_block_recommends_at_most_one_scorer() -> None:
    """Guard against the LLM emitting a kNN scorer per criterion. The
    pool is voted-against in aggregate; per-criterion kNN scorers would
    all return the same score and pollute averages."""
    prompt = build_generate_scorers_prompt(
        _MINIMAL_SEED, knn_available=True, knn_pool_size=20
    )
    # The "at MOST ONE" phrasing is the load-bearing guidance
    assert "at MOST ONE" in prompt or "at most ONE" in prompt


def test_knn_emit_block_specifies_alignment_type() -> None:
    """The kNN scorer must be typed alignment — it grades an output-level
    quality property, not a coverage scenario. Coverage scorers gate on a
    tag; kNN votes against the whole pool, so coverage-typing would
    create a contradictory gate."""
    prompt = build_generate_scorers_prompt(
        _MINIMAL_SEED, knn_available=True, knn_pool_size=10
    )
    # The emit-block says `type: "alignment"`
    assert '"alignment"' in prompt
    # And `target_tag: null` (no gating)
    assert "target_tag: null" in prompt or "null" in prompt
