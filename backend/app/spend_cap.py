"""Daily spend cap.

Soft safety net for public-playground deployments: estimate the cost of every
real (non-cached) LLM call, accumulate it into a single-row-per-day table,
and start refusing requests with HTTP 503 once the configured ceiling is hit.
Resets at UTC midnight (next day → new row → counter back at zero).

This module is self-contained:
  - It owns its DB table (`daily_spend`, created from db.py).
  - It registers itself as a middleware via `setup()` on app startup.
  - Nothing in the rest of the codebase imports from here except `main.py`
    (for `setup()`) and `db.py` (for `create_table()`).

To enable, set `DAILY_SPEND_CAP_CENTS` to a positive integer. Unset / zero /
unparseable → middleware is never registered (zero overhead when disabled).
The env var presence IS the on/off flag — there is no separate playground
toggle. Same module is dormant in private / internal deployments where you
don't want a cap.

Cost estimation is a substring match against `MODEL_PRICES_PER_1M_CENTS`,
so dated snapshots like `claude-sonnet-4-6-20251010` collapse onto their
family entry. Unknown models cost 0 (logged) — the cap is an approximation,
not an exact bill.

Cache interaction: middlewares run in registration order, with cache
registered first → cache is OUTERMOST. A cache hit short-circuits before
reaching this middleware, so we never see (and never count) it. Cache
misses bubble through here on the way out, get counted, and increment the
day's running total.

Failure mode: a DB read/write hiccup must NOT take the platform down. The
read-the-current-total step swallows errors and falls through (assume
under cap). Writes on the way out also swallow errors. The ONE place we
refuse to fall through is when the read SUCCEEDS and shows we're over the
cap — that's the soft-safety case the cap exists for.
"""

from __future__ import annotations

import logging
import os
from datetime import date
from typing import Any, Awaitable, Callable

import asyncpg
from fastapi import HTTPException

logger = logging.getLogger(__name__)


# --- Model pricing table ---
#
# Cents per 1,000,000 tokens, split by input / output. Substring matching
# below means a snapshot ID like `claude-sonnet-4-6-20251010` collapses to
# the `claude-sonnet-4-6` family entry. Unknown families cost 0 (logged).
MODEL_PRICES_PER_1M_CENTS: dict[str, dict[str, int]] = {
    "claude-sonnet-4": {"input": 300, "output": 1500},
    "claude-sonnet-4-5": {"input": 300, "output": 1500},
    "claude-sonnet-4-6": {"input": 300, "output": 1500},
    "claude-opus-4-5": {"input": 1500, "output": 7500},
    "claude-opus-4-7": {"input": 1500, "output": 7500},
    "claude-haiku-4-5": {"input": 80, "output": 400},
}


def estimate_cost_cents(model: str, input_tokens: int, output_tokens: int) -> int:
    """Cents-cost estimate for a single call. Returns 0 for unknown models.

    Substring match against `MODEL_PRICES_PER_1M_CENTS` keys, ordered longest
    first so e.g. `claude-sonnet-4-6-20251010` matches `claude-sonnet-4-6`
    (longest prefix) instead of accidentally hitting the shorter
    `claude-sonnet-4` entry.
    """
    if not model:
        logger.warning("spend_cap: empty model name, treating cost as 0")
        return 0
    # Sort by descending length so longer-and-more-specific prefixes win
    # over generic ones. Critical: `claude-sonnet-4-6` must beat
    # `claude-sonnet-4` for snapshots like `claude-sonnet-4-6-20251010`.
    for key in sorted(MODEL_PRICES_PER_1M_CENTS, key=len, reverse=True):
        if key in model:
            prices = MODEL_PRICES_PER_1M_CENTS[key]
            # Microcents: prices are cents per 1M tokens, so tokens × price gives
            # the cost in (cents × 1_000_000) = microcents. We ceiling-divide to
            # cents so a 1000-token call (0.08 microcents → 0.08 cents actual)
            # rounds UP to 1 cent rather than floor-dividing to 0. Over-estimating
            # is the safe direction for a soft budget cap: small-but-nonzero
            # calls would otherwise be free forever, and a 500-cent ($5) cap with
            # 0.08-cent-each calls would NEVER trip if each one floored to 0.
            microcents = (
                prices["input"] * max(0, input_tokens)
                + prices["output"] * max(0, output_tokens)
            )
            if microcents == 0:
                return 0
            # Ceiling division: any non-zero cost → at least 1 cent.
            return max(1, -(-microcents // 1_000_000))
    logger.warning(f"spend_cap: unknown model {model!r}, treating cost as 0")
    return 0


# --- Schema ---

async def create_table(conn: asyncpg.Connection) -> None:
    """Create the daily_spend table. Called from db._create_tables()."""
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS daily_spend (
            day                   DATE PRIMARY KEY,
            run_count             INT NOT NULL DEFAULT 0,
            estimated_cost_cents  INT NOT NULL DEFAULT 0,
            last_updated          TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    """)


# --- DB helpers ---

async def _read_today_cents(pool: asyncpg.Pool, today: date) -> int:
    """Current cents spent today. Missing row → 0."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT estimated_cost_cents FROM daily_spend WHERE day = $1",
            today,
        )
    return int(row["estimated_cost_cents"]) if row else 0


async def _bump_today(pool: asyncpg.Pool, today: date, cost_cents: int) -> int:
    """Increment today's row (creating it if absent). Returns the new total.

    ON CONFLICT keeps this atomic against concurrent calls — two parallel
    LLM calls finishing at the same instant will both correctly fold into
    the same row without losing one of the increments.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO daily_spend (day, run_count, estimated_cost_cents)
            VALUES ($1, 1, $2)
            ON CONFLICT (day) DO UPDATE
              SET run_count = daily_spend.run_count + 1,
                  estimated_cost_cents = daily_spend.estimated_cost_cents
                                       + EXCLUDED.estimated_cost_cents,
                  last_updated = now()
            RETURNING estimated_cost_cents
            """,
            today,
            cost_cents,
        )
    return int(row["estimated_cost_cents"])


async def get_today_stats(pool: asyncpg.Pool, today: date | None = None) -> dict:
    """Read the current day's row for /admin/spend. Returns zeros when
    the day's row doesn't exist yet (no LLM call made yet today)."""
    if today is None:
        today = date.today()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT day, run_count, estimated_cost_cents, last_updated "
            "FROM daily_spend WHERE day = $1",
            today,
        )
    if row is None:
        return {
            "day": today.isoformat(),
            "run_count": 0,
            "estimated_cost_cents": 0,
            "last_updated": None,
        }
    return {
        "day": row["day"].isoformat(),
        "run_count": int(row["run_count"]),
        "estimated_cost_cents": int(row["estimated_cost_cents"]),
        "last_updated": row["last_updated"].isoformat() if row["last_updated"] else None,
    }


# --- Cap state (set in setup()) ---

# Cached at setup() time. The middleware is only registered when the env
# var is set to a positive int, so by the time spend_cap_middleware runs
# this is always a positive int.
_cap_cents: int = 0


# --- Middleware ---

async def spend_cap_middleware(
    descriptor: dict[str, Any],
    call_next: Callable[[], Awaitable[tuple[str, dict]]],
) -> tuple[str, dict]:
    """Refuse LLM calls once the day's estimated spend crosses the cap.

    Pre-call: read today's running total. If >= cap, raise 503. If the read
    itself errors, log and fall through — the cap is a soft safety net, and
    locking everyone out on a transient DB blip is worse than briefly
    over-spending.

    Post-call: estimate the cost of this call from the meta dict (tokens,
    model). Cache hits (`meta["cached"] is True`) cost nothing, so we don't
    increment. Write errors are logged but never propagated — losing one
    accounting tick is fine; failing the request the user already paid for
    in latency is not.
    """
    # Local import — same pattern as llm_cache, avoids poisoning module
    # import if the pool hasn't been built yet (e.g. during early startup
    # or unit-test import).
    from . import db

    try:
        pool = await db.get_pool()
    except Exception as e:  # pragma: no cover — pool always up in real runs
        logger.warning(f"spend_cap: pool unavailable, passing through: {e}")
        return await call_next()

    today = date.today()

    # --- Pre-call: are we already over the cap? ---
    try:
        current = await _read_today_cents(pool, today)
    except Exception as e:
        # Read failure is non-fatal — cap is a soft safety net. Log and
        # fall through so a flaky DB doesn't black out the whole service.
        logger.warning(f"spend_cap: pre-call read failed, passing through: {e}")
        current = None

    if current is not None and current >= _cap_cents:
        logger.warning(
            f"spend_cap: BLOCK kind={descriptor.get('kind')} "
            f"model={descriptor.get('model')} "
            f"today_cents={current} cap_cents={_cap_cents}"
        )
        raise HTTPException(
            status_code=503,
            detail="Daily playground budget exceeded. Service will resume tomorrow.",
        )

    # --- Real call ---
    text, meta = await call_next()

    # --- Post-call: account ---
    # Cached responses cost nothing — the cache layer already short-circuited
    # the real provider call. Counting a cache hit would mean the cap
    # punishes deployments for *saving* money, which is backwards.
    if meta.get("cached"):
        return text, meta

    input_tokens = int(meta.get("input_tokens") or 0)
    output_tokens = int(meta.get("output_tokens") or 0)
    model = meta.get("model") or descriptor.get("model") or ""
    cost = estimate_cost_cents(model, input_tokens, output_tokens)

    if cost <= 0:
        # Either an unknown model or a degenerate 0-token call. Still bump
        # run_count so /admin/spend reflects activity, but cost stays 0.
        cost = 0

    try:
        new_total = await _bump_today(pool, today, cost)
    except Exception as e:
        # Write failure: log and move on. We'd rather under-count than
        # break the request the caller already burned latency on.
        logger.warning(f"spend_cap: post-call write failed: {e}")
        return text, meta

    # 50%-of-cap alert. Logged once per call that crosses any new tick,
    # which is noisier than a one-shot alert but keeps the implementation
    # stateless across restarts.
    if new_total > _cap_cents // 2:
        logger.warning(
            f"spend_cap: ALERT today_cents={new_total} cap_cents={_cap_cents} "
            f"({100 * new_total // max(1, _cap_cents)}% used)"
        )

    return text, meta


# --- Setup hook (called from main.lifespan) ---

def setup() -> bool:
    """Register the spend-cap middleware if DAILY_SPEND_CAP_CENTS is set.

    Returns True if registered, False if disabled / misconfigured. Call once
    at app startup, after the DB pool is initialised and AFTER llm_cache.setup()
    so the cache sits outside the cap (cache hits don't count toward spend).
    """
    global _cap_cents

    raw = os.environ.get("DAILY_SPEND_CAP_CENTS", "").strip()
    if not raw:
        logger.info("spend_cap: disabled (DAILY_SPEND_CAP_CENTS unset)")
        return False
    try:
        cap = int(raw)
    except ValueError:
        logger.warning(
            f"spend_cap: disabled (DAILY_SPEND_CAP_CENTS={raw!r} not an integer)"
        )
        return False
    if cap <= 0:
        logger.info(f"spend_cap: disabled (DAILY_SPEND_CAP_CENTS={cap} is non-positive)")
        return False

    _cap_cents = cap
    from . import tools
    tools.register_llm_middleware(spend_cap_middleware)
    logger.info(f"spend_cap: middleware registered (cap={cap} cents/day)")
    return True
