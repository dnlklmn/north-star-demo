"""Per-IP daily quota for public-playground deployments.

When ``PLAYGROUND_DAILY_LIMIT`` is set to a positive int, every LLM-calling
endpoint (wired via ``Depends(enforce_quota)``) increments a per-IP daily
counter; once the counter exceeds the limit, the dependency raises HTTP 429
until midnight UTC.

This module is self-contained — same convention as ``llm_cache.py``:
  * It owns its DB table (``playground_quota``, created via ``create_table``
    from ``db._create_tables``).
  * It registers a response-header middleware in ``setup()`` on app startup.
  * Only ``main.py`` (for ``setup()`` + ``Depends(enforce_quota)``) and
    ``db.py`` (for ``create_table``) import from here.

The module is a no-op by default: with ``PLAYGROUND_DAILY_LIMIT`` unset or
zero, ``enforce_quota`` returns immediately without touching the DB, and
``setup()`` skips middleware registration so a self-hosted instance pays
nothing for the playground path.

IP identification:
  * If ``X-Forwarded-For`` is present, the LAST entry is used. The first
    entry is the client-supplied address (spoofable) and the last entry is
    what the most-recent trusted hop saw — the only value that can be
    trusted when the deployment sits behind a known proxy/load-balancer.
  * The IP is salted with ``QUOTA_IP_SALT`` (a non-secret default is used
    if unset, with a warning) and SHA-256'd before storage. We never log
    or persist the raw IP.
"""

from __future__ import annotations

import hashlib
import logging
import os
from datetime import date, datetime, time, timedelta, timezone

import asyncpg
from fastapi import FastAPI, HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)


# Default salt — public-facing prototypes that forget to set the env var
# shouldn't crash, but they SHOULD complain loudly so the operator notices.
# Hashing without a per-deploy salt means a rainbow table of common IPs maps
# to a known ip_hash; not catastrophic (we don't expose ip_hash to anyone),
# but worth a warning.
_DEFAULT_SALT = "northstar-quota-default-salt-please-override"

# Env var names — module-level constants so callers (and tests) don't have to
# re-spell them.
_ENV_LIMIT = "PLAYGROUND_DAILY_LIMIT"
_ENV_SALT = "QUOTA_IP_SALT"


# --- Schema ---


async def create_table(conn: asyncpg.Connection) -> None:
    """Create the quota table. Called from db._create_tables()."""
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS playground_quota (
            ip_hash   TEXT NOT NULL,
            day       DATE NOT NULL,
            run_count INT  NOT NULL DEFAULT 0,
            PRIMARY KEY (ip_hash, day)
        );
        """
    )


# --- Limit / salt readers ---


def _read_limit() -> int:
    """Parse ``PLAYGROUND_DAILY_LIMIT`` → int. 0 (or unset/garbage) = disabled."""
    raw = os.environ.get(_ENV_LIMIT, "").strip()
    if not raw:
        return 0
    try:
        n = int(raw)
    except ValueError:
        logger.warning(
            "quota: %s=%r is not an integer, treating as disabled",
            _ENV_LIMIT, raw,
        )
        return 0
    return max(0, n)


def _read_salt() -> str:
    salt = os.environ.get(_ENV_SALT)
    if salt:
        return salt
    return _DEFAULT_SALT


# --- IP hashing ---


def _client_ip(request: Request) -> str:
    """Return the IP we'll quota on.

    Trusts the LAST entry of ``X-Forwarded-For`` if present — that's what the
    most-recent trusted hop observed. The first entry is the client-supplied
    address and is trivially spoofable. With no XFF, fall back to the direct
    socket peer (``request.client.host``).
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1]
    if request.client and request.client.host:
        return request.client.host
    # Last-resort: a fixed marker, so a missing client doesn't crash the path.
    # All such requests share one bucket — fine for our threat model (this is
    # the playground throttle, not a security boundary).
    return "unknown"


def hash_ip(request: Request) -> str:
    """Salted SHA-256 of the trusted client IP. Hex digest."""
    raw_ip = _client_ip(request)
    salt = _read_salt()
    h = hashlib.sha256()
    h.update(salt.encode("utf-8"))
    h.update(b"|")
    h.update(raw_ip.encode("utf-8"))
    return h.hexdigest()


# --- Time helpers ---


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


def _seconds_until_midnight_utc() -> int:
    now = datetime.now(timezone.utc)
    tomorrow = (now + timedelta(days=1)).date()
    midnight = datetime.combine(tomorrow, time.min, tzinfo=timezone.utc)
    delta = midnight - now
    # Clamp at 1 so a freshly-rolled day still hints at "try again soon"
    # rather than emitting 0 (which some clients treat as "no wait").
    return max(1, int(delta.total_seconds()))


# --- DB increment ---


async def _increment(ip_hash: str, today: date) -> int:
    """Atomic upsert returning the new run_count for (ip_hash, today)."""
    from . import db  # local import — pool may not be ready at module import

    pool = await db.get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO playground_quota (ip_hash, day, run_count)
            VALUES ($1, $2, 1)
            ON CONFLICT (ip_hash, day)
            DO UPDATE SET run_count = playground_quota.run_count + 1
            RETURNING run_count
            """,
            ip_hash, today,
        )
    return int(row["run_count"]) if row else 1


async def _peek(ip_hash: str, today: date) -> int:
    """Read the current count without incrementing — used by /config."""
    from . import db

    pool = await db.get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT run_count FROM playground_quota WHERE ip_hash = $1 AND day = $2",
            ip_hash, today,
        )
    return int(row["run_count"]) if row else 0


# --- Dependency ---


# State key on request.state where we stash the quota numbers for the
# response-header middleware to read after the endpoint returns.
_STATE_KEY = "quota"


async def enforce_quota(request: Request) -> None:
    """FastAPI dependency: increment per-IP daily count, 429 once it exceeds.

    No-op (and skips the DB entirely) when ``PLAYGROUND_DAILY_LIMIT`` is unset
    or 0. When active and the increment pushes the count over the limit, we
    raise 429 with ``Retry-After`` (seconds until midnight UTC) and
    ``X-Quota-Limit`` / ``X-Quota-Remaining`` headers. On allowed calls we
    stash the same numbers on ``request.state.quota`` so the response-header
    middleware (registered by ``setup()``) can attach them after the endpoint
    runs — FastAPI dependencies can't directly mutate the response.
    """
    limit = _read_limit()
    if limit <= 0:
        return

    ip_hash = hash_ip(request)
    today = _today_utc()
    try:
        count = await _increment(ip_hash, today)
    except Exception as e:  # noqa: BLE001
        # DB unavailable / transient error — fall open. The quota is a soft
        # throttle for cost; refusing to serve traffic because Postgres
        # blinked is worse than the rare double-spend that might leak through.
        logger.warning("quota: DB increment failed, allowing request: %s", e)
        return

    if count > limit:
        retry_after = _seconds_until_midnight_utc()
        raise HTTPException(
            status_code=429,
            detail="Daily playground limit reached. Try again tomorrow.",
            headers={
                "Retry-After": str(retry_after),
                "X-Quota-Limit": str(limit),
                "X-Quota-Remaining": "0",
            },
        )

    # Stash numbers for the response-header middleware.
    request.state.__setattr__(
        _STATE_KEY,
        {"limit": limit, "remaining": max(0, limit - count)},
    )


async def get_quota_status(request: Request) -> dict:
    """Helper for the /config endpoint (PR 3).

    Returns ``{"daily_limit": int|None, "runs_remaining": int|None}``.
    Both fields are ``None`` when quota is disabled.
    """
    limit = _read_limit()
    if limit <= 0:
        return {"daily_limit": None, "runs_remaining": None}
    try:
        count = await _peek(hash_ip(request), _today_utc())
    except Exception as e:  # noqa: BLE001
        logger.warning("quota: peek failed: %s", e)
        return {"daily_limit": limit, "runs_remaining": None}
    return {
        "daily_limit": limit,
        "runs_remaining": max(0, limit - count),
    }


# --- Response-header middleware ---


class _QuotaHeaderMiddleware(BaseHTTPMiddleware):
    """Read ``request.state.quota`` (populated by ``enforce_quota``) and
    attach ``X-Quota-Limit`` / ``X-Quota-Remaining`` to the response.

    Endpoints that don't depend on ``enforce_quota`` won't have the state
    attribute — those responses pass through unchanged.
    """

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        data = getattr(request.state, _STATE_KEY, None)
        if isinstance(data, dict):
            response.headers["X-Quota-Limit"] = str(data.get("limit", ""))
            response.headers["X-Quota-Remaining"] = str(data.get("remaining", ""))
        return response


# --- Setup hook (called from main.lifespan) ---


def setup(app: FastAPI | None = None) -> bool:
    """Activate the quota module if ``PLAYGROUND_DAILY_LIMIT`` is set > 0.

    Registers the response-header middleware on ``app``. Logs a warning when
    the IP salt is at its default (operator forgot to set ``QUOTA_IP_SALT``).
    Returns True if active, False if disabled.

    The ``app`` argument is optional only so existing call sites that forget
    to pass it don't blow up — in practice main.lifespan always passes the
    FastAPI instance.
    """
    limit = _read_limit()
    if limit <= 0:
        logger.info("quota: disabled (set %s>0 to activate)", _ENV_LIMIT)
        return False

    if not os.environ.get(_ENV_SALT):
        logger.warning(
            "quota: %s is unset — using a default salt. Set a per-deploy "
            "value to harden the ip_hash against rainbow lookups.",
            _ENV_SALT,
        )

    if app is None:
        logger.warning(
            "quota: setup() called without an app; header middleware NOT "
            "registered. Pass the FastAPI instance from lifespan."
        )
    else:
        app.add_middleware(_QuotaHeaderMiddleware)

    logger.info(
        "quota: enabled (limit=%d/day, header middleware registered)", limit,
    )
    return True
