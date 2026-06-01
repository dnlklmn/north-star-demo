"""LLM response cache.

Caches successful LLM responses by a content hash of (model, prompt-shape,
max_tokens, temperature). On a cache hit, the wrapped call returns the stored
response without touching the provider — pure cost win whenever the exact
same prompt is re-sent.

This module is self-contained:
  - It owns its DB table (`llm_response_cache`, created from db.py).
  - It registers itself as a middleware via `setup()` on app startup.
  - Nothing in the rest of the codebase imports from here except `main.py`
    (for `setup()`) and `db.py` (for `create_table()`).

To disable globally, set `LLM_CACHE_ENABLED=false`. Default is on — caching
identical prompts is a pure cost win regardless of deployment.

The cache key covers everything that affects the model's output:
  - model name
  - the rendered prompt content (single prompt OR messages list OR
    prefix+suffix OR system+messages+tools)
  - max_tokens (changes truncation behaviour)
  - temperature (different temps may produce different responses)

The cache does NOT cover the Polaris tool-use loop — each iteration's
output depends on the previous iteration's tool results, so cache hits
would be rare and the implementation would be fragile.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any, Awaitable, Callable

import asyncpg

logger = logging.getLogger(__name__)


# --- Schema ---

async def create_table(conn: asyncpg.Connection) -> None:
    """Create the cache table. Called from db._create_tables()."""
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS llm_response_cache (
            cache_key       TEXT PRIMARY KEY,
            model           TEXT NOT NULL,
            response_text   TEXT NOT NULL,
            response_meta   JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            hit_count       INT NOT NULL DEFAULT 0,
            last_hit_at     TIMESTAMPTZ
        );
    """)


# --- Key building ---

def build_cache_key(descriptor: dict[str, Any]) -> str:
    """Hash a normalised descriptor to a stable cache key.

    The descriptor must include enough information to fully determine the
    model's output. Different call shapes (single prompt / prefix+suffix /
    messages+tools) get separate namespaces via the `kind` field, so a single
    prompt and a tools-call with the same text don't collide.
    """
    # json.dumps with sort_keys gives a canonical representation.
    blob = json.dumps(descriptor, sort_keys=True, default=str, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# --- Lookup / store ---

async def _lookup(pool: asyncpg.Pool, key: str) -> dict | None:
    """Return cached row or None. Increments hit_count on hit."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE llm_response_cache
            SET hit_count = hit_count + 1, last_hit_at = now()
            WHERE cache_key = $1
            RETURNING response_text, response_meta, model
            """,
            key,
        )
    if not row:
        return None
    meta = row["response_meta"]
    # asyncpg returns jsonb as either str or dict depending on version.
    if isinstance(meta, str):
        meta = json.loads(meta)
    return {"text": row["response_text"], "meta": meta, "model": row["model"]}


async def _store(pool: asyncpg.Pool, key: str, model: str, text: str, meta: dict) -> None:
    """Insert a new cache entry. No-op if the key already exists (race-safe)."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO llm_response_cache (cache_key, model, response_text, response_meta)
            VALUES ($1, $2, $3, $4::jsonb)
            ON CONFLICT (cache_key) DO NOTHING
            """,
            key,
            model,
            text,
            json.dumps(meta, default=str),
        )


# --- Middleware ---

async def llm_cache_middleware(
    descriptor: dict[str, Any],
    call_next: Callable[[], Awaitable[tuple[str, dict]]],
) -> tuple[str, dict]:
    """Middleware that wraps an LLM call with a content-keyed cache.

    On hit: returns the cached text + metadata, with `cached: True` and
    zeroed-out token counts added so downstream accounting can distinguish
    a replay from a fresh call.

    On miss: calls `call_next()`, stores the result, returns it untouched.

    Errors in the cache layer never block the underlying call — we log and
    fall through. The cache is a cost optimisation, not a critical path.
    """
    # Import locally so a missing/uninitialised pool during early startup
    # doesn't poison module import.
    from . import db

    try:
        pool = await db.get_pool()
    except Exception as e:  # pragma: no cover — pool always up in real runs
        logger.warning(f"llm_cache: pool unavailable, skipping cache: {e}")
        return await call_next()

    key = build_cache_key(descriptor)

    try:
        hit = await _lookup(pool, key)
    except Exception as e:
        logger.warning(f"llm_cache: lookup failed, falling through: {e}")
        hit = None

    if hit is not None:
        logger.info(
            f"llm_cache HIT: kind={descriptor.get('kind')} "
            f"model={hit['model']} key={key[:12]}…"
        )
        meta = dict(hit["meta"])
        # Mark as cached and zero usage so cost accounting doesn't double-count.
        meta["cached"] = True
        meta["input_tokens"] = 0
        meta["output_tokens"] = 0
        meta["cache_creation_input_tokens"] = 0
        meta["cache_read_input_tokens"] = 0
        meta["latency_ms"] = 0
        return hit["text"], meta

    # Miss — call the real LLM, then store.
    text, meta = await call_next()
    try:
        await _store(pool, key, meta.get("model", "unknown"), text, meta)
        logger.info(
            f"llm_cache STORE: kind={descriptor.get('kind')} "
            f"model={meta.get('model')} key={key[:12]}…"
        )
    except Exception as e:
        logger.warning(f"llm_cache: store failed (response still returned): {e}")

    return text, meta


# --- Setup hook (called from main.lifespan) ---

def setup() -> bool:
    """Register the cache middleware unless explicitly disabled.

    Returns True if registered, False if disabled by env. Call once at app
    startup, after the DB pool is initialised.
    """
    if os.environ.get("LLM_CACHE_ENABLED", "true").lower() in ("0", "false", "no"):
        logger.info("llm_cache: disabled via LLM_CACHE_ENABLED")
        return False
    from . import tools
    tools.register_llm_middleware(llm_cache_middleware)
    logger.info("llm_cache: middleware registered")
    return True
