"""Unit tests for ``app.embeddings`` — Tier 2 B1.

Three things matter here:

1. **Provider abstraction**: ``embed_texts`` doesn't actually call Voyage
   in tests — we swap in a fake provider via ``_set_provider_for_tests``
   so the test suite never depends on a network round-trip or an env var.
2. **Caching**: the in-process LRU should dedupe the same ``(model, text)``
   so backfill across overlapping example sets doesn't re-bill.
3. **Batching**: large inputs get chunked at ``batch_size``, and ORDER is
   preserved across the chunks — the contract callers rely on.

Cosine_similarity is tested too — it's load-bearing for the kNN voter and
has explicit zero-vector handling that should not silently return NaN.
"""

from __future__ import annotations

import pytest

from app import embeddings as emb


class _FakeProvider(emb._EmbeddingProvider):
    """Deterministic stand-in for Voyage. Echoes the text length as a 4-d
    one-hot so we get distinguishable vectors without depending on a real
    embedding distribution. Counts ``embed`` calls so cache + batching can
    be asserted directly.
    """

    dimensions = 4

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        self.calls.append(list(texts))
        out: list[list[float]] = []
        for t in texts:
            v = [0.0, 0.0, 0.0, 0.0]
            v[len(t) % 4] = 1.0
            out.append(v)
        return out


@pytest.fixture(autouse=True)
def _fake_provider() -> _FakeProvider:
    """Every test in this file uses the fake provider — auto-applied to
    keep the network out of the path. ``_set_provider_for_tests(None)``
    after each test resets module-level state so a test that sets a
    different fake doesn't leak."""
    provider = _FakeProvider()
    emb._set_provider_for_tests(provider)
    yield provider
    emb._set_provider_for_tests(None)


def test_embed_texts_preserves_order(_fake_provider: _FakeProvider) -> None:
    """Order in == order out, even across batches. This is the contract
    every downstream caller relies on — pairing example_id ↔ vector by
    index, not by re-matching text."""
    texts = ["a", "bb", "ccc", "dddd"]
    results = emb.embed_texts(texts, model="test-model")
    assert len(results) == 4
    assert [r.text for r in results] == texts


def test_embed_texts_batches_at_size(_fake_provider: _FakeProvider) -> None:
    """A 200-item input with batch_size=64 should split into 4 calls
    (64 + 64 + 64 + 8). Without the chunking, the test would log 1 call."""
    texts = [f"item-{i}" for i in range(200)]
    emb.embed_texts(texts, model="test-model", batch_size=64)
    assert len(_fake_provider.calls) == 4
    assert [len(c) for c in _fake_provider.calls] == [64, 64, 64, 8]


def test_embed_texts_cache_dedupes(_fake_provider: _FakeProvider) -> None:
    """Re-embedding the same text in a single process should hit the
    cache. The fake provider's call log is the asserter — second pass
    should not re-call for any text the first pass embedded."""
    first_batch = ["x", "y", "z"]
    emb.embed_texts(first_batch, model="test-model")
    first_call_count = len(_fake_provider.calls)
    # Re-embed identical inputs.
    emb.embed_texts(first_batch, model="test-model")
    assert len(_fake_provider.calls) == first_call_count  # no new wire calls


def test_embed_texts_cache_misses_get_through(_fake_provider: _FakeProvider) -> None:
    """Mixed cache hits + misses: the hits skip the provider, the misses
    ship in a single batch. We verify by counting the items in the
    second call: should be ONLY the new miss, not the whole input."""
    emb.embed_texts(["cached"], model="test-model")
    emb.embed_texts(["cached", "fresh"], model="test-model")
    assert _fake_provider.calls[-1] == ["fresh"]


def test_embed_texts_blank_returns_zero_vector(_fake_provider: _FakeProvider) -> None:
    """Whitespace-only inputs should not be billed — return a zero vector
    of the provider's dimension so cosine cleanly evaluates to 0."""
    results = emb.embed_texts(["", "   ", "real"], model="test-model")
    assert results[0].vector == [0.0] * 4
    assert results[1].vector == [0.0] * 4
    assert any(v != 0.0 for v in results[2].vector)
    # No provider call for the blanks — only ``real`` was shipped.
    assert _fake_provider.calls == [["real"]]


def test_embed_texts_per_model_cache(_fake_provider: _FakeProvider) -> None:
    """Same text under two different model strings should NOT share cache
    — vectors aren't comparable across models, and a cross-model hit
    would silently poison cosine."""
    emb.embed_texts(["same"], model="model-a")
    emb.embed_texts(["same"], model="model-b")
    assert len(_fake_provider.calls) == 2


def test_cosine_similarity_unit_vectors_self() -> None:
    """sim(v, v) == 1.0 for any nonzero vector."""
    v = [0.5, 0.5, 0.5, 0.5]
    assert emb.cosine_similarity(v, v) == pytest.approx(1.0)


def test_cosine_similarity_orthogonal() -> None:
    """sim of orthogonal vectors is 0."""
    a = [1.0, 0.0]
    b = [0.0, 1.0]
    assert emb.cosine_similarity(a, b) == pytest.approx(0.0)


def test_cosine_similarity_opposite() -> None:
    """sim of antiparallel vectors is -1."""
    a = [1.0, 0.0]
    b = [-1.0, 0.0]
    assert emb.cosine_similarity(a, b) == pytest.approx(-1.0)


def test_cosine_similarity_zero_vector_is_zero_not_nan() -> None:
    """A zero vector against anything is 0 — NOT NaN. The kNN voter
    depends on this; without it a single blank example would poison the
    aggregate vote."""
    assert emb.cosine_similarity([0.0, 0.0], [1.0, 1.0]) == 0.0
    assert emb.cosine_similarity([1.0, 1.0], [0.0, 0.0]) == 0.0
    assert emb.cosine_similarity([0.0, 0.0], [0.0, 0.0]) == 0.0


def test_cosine_similarity_dim_mismatch_raises() -> None:
    """Different-length vectors are a routing bug — caller mixed two
    providers. Raise loudly rather than truncate or pad silently."""
    with pytest.raises(ValueError):
        emb.cosine_similarity([1.0, 0.0], [1.0, 0.0, 0.0])


def test_embed_texts_empty_input_returns_empty() -> None:
    """Empty input → empty output, no provider call."""
    fake = _FakeProvider()
    emb._set_provider_for_tests(fake)
    try:
        assert emb.embed_texts([], model="test-model") == []
        assert fake.calls == []
    finally:
        emb._set_provider_for_tests(None)
