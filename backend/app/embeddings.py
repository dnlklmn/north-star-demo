"""Embedding-provider abstraction + Voyage AI implementation.

## Why this module exists

Tier 2 of the scoring roadmap (kNN against labels, cascade routing,
Coverage / Balance / Rot as distribution signals) needs vectors. This
module is the single seam through which the rest of the codebase reaches
for them — every other call site (synthesis path, backfill endpoint,
runtime kNN helper) goes through ``embed_texts`` and never knows which
provider returned the floats.

## Provider choice — Voyage AI ``voyage-3-lite``

- 512 dimensions — small JSONB rows, faster cosine. Pre-prod we are
  pessimising for *flexibility* (swap providers without a migration) not
  for retrieval recall on millions of rows.
- $0.02 / 1M input tokens — same order as OpenAI ``text-embedding-3-small``;
  cost is not the differentiator here.
- Anthropic-recommended partner; fits the existing provider story (we
  already speak Anthropic + OpenRouter for chat).
- No SDK — just one httpx POST. Trivial to swap.

If you want to swap providers later: implement a new ``_EmbeddingProvider``
subclass and change ``_default_provider()``. The DB column is named
generically (``embedding``) but co-stored with ``embedding_model`` so
the kNN reader can refuse-to-match across mismatched providers — see
``db.py::get_labeled_embeddings``.

## Storage shape

Pre-prod we store embeddings as JSONB on ``examples.embedding`` (a flat
``list[float]``). Cosine runs in Python over the row set; on a few
hundred examples this is microseconds. When we cross ~50K embeddings in
a single dataset we'll move to pgvector — the migration is a one-shot
copy + index create + reader swap, scheduled when the load actually
shows up.

## Caching

The in-process LRU is keyed on ``(model, text)`` and exists to keep the
backfill endpoint and the runtime kNN helper from re-billing for the
same text in the same process. It is NOT a persistence layer — the DB
column is the persistence layer. Cache misses cost an HTTP roundtrip;
cache hits cost a dict lookup.
"""

from __future__ import annotations

import logging
import math
import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable

import httpx

logger = logging.getLogger(__name__)


# ---- Public surface --------------------------------------------------------


DEFAULT_MODEL = "voyage-3-lite"
DEFAULT_DIMENSIONS = 512  # what voyage-3-lite returns


@dataclass(frozen=True)
class EmbeddingResult:
    """One embedded text. ``model`` is co-returned so callers can persist it
    alongside the vector — a mismatch at query time is a routing bug we want
    to detect, not silently retrieve through.
    """

    text: str
    vector: list[float]
    model: str


def embed_texts(
    texts: Iterable[str],
    *,
    model: str | None = None,
    batch_size: int = 128,
) -> list[EmbeddingResult]:
    """Embed a list of texts, batched and cached.

    Empty / whitespace-only texts are returned as zero-vectors of the
    expected dimension — cosine against a zero vector is 0 by convention,
    which kNN reads as "no signal". Raising instead would force every
    caller to defensively filter, which is the wrong default for a
    pipeline that legitimately encounters blank rows.

    Order is preserved: ``embed_texts([a, b, c])[i].text == [a, b, c][i]``.
    """
    chosen_model = model or _resolve_model()
    provider = _default_provider()

    inputs = list(texts)
    if not inputs:
        return []

    # Bucket by cache hit/miss so we only ship the misses across the wire.
    results: list[EmbeddingResult | None] = [None] * len(inputs)
    to_fetch: list[tuple[int, str]] = []
    for idx, raw in enumerate(inputs):
        text = (raw or "").strip()
        if not text:
            results[idx] = EmbeddingResult(text=raw or "", vector=[0.0] * provider.dimensions, model=chosen_model)
            continue
        cached = _cache_get(chosen_model, text)
        if cached is not None:
            results[idx] = EmbeddingResult(text=raw, vector=cached, model=chosen_model)
        else:
            to_fetch.append((idx, text))

    # Ship the misses in batches. The provider may impose a max-per-call;
    # voyage-3-lite is currently 128 per request, hence the default batch.
    for start in range(0, len(to_fetch), batch_size):
        chunk = to_fetch[start : start + batch_size]
        vectors = provider.embed([t for _, t in chunk], model=chosen_model)
        for (idx, text), vec in zip(chunk, vectors, strict=True):
            _cache_put(chosen_model, text, vec)
            results[idx] = EmbeddingResult(text=inputs[idx], vector=vec, model=chosen_model)

    # Every slot filled by construction; mypy/pyright don't see that.
    return [r for r in results if r is not None]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity, safe on zero vectors (returns 0.0 instead of NaN).

    Used by the runtime kNN helper. Defined here so the provider abstraction
    and the math live in the same file — there's only ever one of these in
    the codebase, and centralising it prevents a future "small refactor"
    from accidentally writing a second copy that handles zero vectors
    differently.
    """
    if len(a) != len(b):
        raise ValueError(f"vector dimension mismatch: {len(a)} vs {len(b)}")
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b, strict=True):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


# ---- Provider plumbing -----------------------------------------------------


class _EmbeddingProvider:
    """Minimal protocol — every provider returns a list[list[float]] in input order."""

    dimensions: int

    def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        raise NotImplementedError


class _VoyageProvider(_EmbeddingProvider):
    """Voyage AI — one POST per batch, no SDK.

    The Voyage API is shape-compatible with OpenAI's embeddings endpoint
    (``{model, input: [str], ...}`` → ``{data: [{embedding: [float]}]}``),
    which is why the response parsing here looks unsurprising. We use
    ``input_type="document"`` — Voyage's docs recommend a different
    string for query-time embedding, but North Star's kNN is symmetric
    (we embed dataset items at write time AND the runtime output at
    scoring time the same way; the relative geometry is what matters).
    """

    dimensions = DEFAULT_DIMENSIONS

    def __init__(self) -> None:
        self._url = "https://api.voyageai.com/v1/embeddings"

    def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        key = _voyage_key()
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        payload = {"input": texts, "model": model, "input_type": "document"}
        # 30s is generous — Voyage typically returns <1s for batches of 128.
        # We give it room for occasional cold-path latency rather than
        # tightening to a number that makes the first request of the day flaky.
        with httpx.Client(timeout=httpx.Timeout(30.0)) as client:
            resp = client.post(self._url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
        items = data.get("data") or []
        if len(items) != len(texts):
            raise RuntimeError(
                f"Voyage returned {len(items)} embeddings for {len(texts)} inputs — provider contract broken"
            )
        # The API returns items in input order; we don't reorder by `index`
        # because the contract is documented as preserved. If a future
        # provider reorders, swap in `sorted(items, key=lambda d: d["index"])`.
        return [item["embedding"] for item in items]


def _voyage_key() -> str:
    """Read VOYAGE_API_KEY from env. Single source — every Voyage call goes
    through this so a missing key fails loudly with one consistent error,
    not three different KeyErrors from different call sites."""
    key = os.environ.get("VOYAGE_API_KEY")
    if not key:
        raise RuntimeError(
            "VOYAGE_API_KEY is not set. The kNN scorer + embedding-based "
            "signals require an embedding provider; set VOYAGE_API_KEY in "
            "your environment (see .env.example) or override the provider "
            "via embeddings._set_provider_for_tests()."
        )
    return key


# Module-private singletons. The provider is swappable for tests — see
# ``_set_provider_for_tests`` below. We don't expose a public setter because
# in production there is exactly one provider and rebuilding the cache mid-
# process to switch is a foot-gun.
_provider: _EmbeddingProvider | None = None


def _default_provider() -> _EmbeddingProvider:
    global _provider
    if _provider is None:
        _provider = _VoyageProvider()
    return _provider


def _set_provider_for_tests(provider: _EmbeddingProvider | None) -> None:
    """Inject a fake provider in tests. Pass ``None`` to reset to default.

    Intentionally underscore-prefixed: production code that wants a
    different provider should subclass and modify ``_default_provider``,
    not flip a runtime switch.
    """
    global _provider
    _provider = provider
    _cache_clear()


def _resolve_model() -> str:
    """Allow MODEL override via env without forcing the API surface to plumb it
    through every call site. Production overrides this once; tests set it
    explicitly via the ``model=`` kwarg."""
    return os.environ.get("EMBEDDING_MODEL") or DEFAULT_MODEL


# ---- Cache -----------------------------------------------------------------
#
# Plain dict, capped, FIFO eviction. lru_cache would work but doesn't expose
# the underlying dict for stats / test reset cleanly, and our access pattern
# (mostly read-once-per-text within a single backfill run) doesn't benefit
# from LRU semantics over FIFO. The cap is large enough to hold a full
# session's dataset (a few thousand examples) without churning.


_CACHE_CAP = 8192
_cache: dict[tuple[str, str], list[float]] = {}
_cache_order: list[tuple[str, str]] = []


def _cache_get(model: str, text: str) -> list[float] | None:
    return _cache.get((model, text))


def _cache_put(model: str, text: str, vector: list[float]) -> None:
    key = (model, text)
    if key in _cache:
        return
    if len(_cache) >= _CACHE_CAP:
        # FIFO eviction. Cheap and good-enough for the bounded backfill /
        # eval-run access pattern; if we ever see the cap pressure in
        # production we'll revisit with real numbers.
        oldest = _cache_order.pop(0)
        _cache.pop(oldest, None)
    _cache[key] = vector
    _cache_order.append(key)


def _cache_clear() -> None:
    _cache.clear()
    _cache_order.clear()


def cache_stats() -> dict[str, int]:
    """Exposed for tests + an eventual /diagnostics endpoint. The numbers
    aren't load-bearing — they exist so we can confirm batching actually
    saved roundtrips during a backfill."""
    return {"size": len(_cache), "cap": _CACHE_CAP}


# Module-level constants for callers that need to know vector shape ahead
# of time (e.g. the zero-vector synthesis in ``embed_texts``).
@lru_cache(maxsize=1)
def expected_dimensions() -> int:
    return _default_provider().dimensions
