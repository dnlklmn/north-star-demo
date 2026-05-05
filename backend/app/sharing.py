"""Project sharing, live SSE updates, and capacity alerts.

Internally, North Star "projects" are called "sessions". This module provides:

* A per-request access primitive (`Access`, `resolve_access`) that lets every
  mutating endpoint distinguish owners from token-bearing collaborators.
* An in-process broadcaster so every state mutation emits an SSE event the
  open clients pick up without polling.
* A capacity monitor that fires alerts (stderr + optional webhook) when the
  number of in-flight LLM calls or open SSE connections crosses a threshold.

Roles:
    'owner'  — direct access (no token).
    'editor' — read + mutate.
    'viewer' — read only.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from typing import Literal

from fastapi import Header, HTTPException, Request

from . import db

logger = logging.getLogger(__name__)


@dataclass
class Access:
    """Per-request authorization context.

    Resolved by `resolve_access`. Endpoints inject this and (for writes) call
    `require_writer` before mutating. `via_token` is True for any non-owner
    caller — used by the share-token management endpoints to refuse callers
    that aren't the owner.
    """
    session_id: str
    role: Literal["owner", "editor", "viewer"]
    via_token: bool


async def resolve_access(
    session_id: str,
    request: Request,
    x_share_token: str | None = Header(default=None, alias="X-Share-Token"),
) -> Access:
    """FastAPI dependency: resolve the role for this request on this session.

    Accepts the share token via either the `X-Share-Token` header (regular
    fetch calls) or the `?token=` query param (EventSource SSE, which can't
    set custom headers). Both paths route through `db.resolve_share_token`,
    which checks revocation and existence in one query.

    Returns owner access when no token is presented. Owner authorization is
    implicit in this prototype — there's no separate auth layer in front of
    North Star, so anyone with the session URL is the owner. Layering on a
    real owner check is a separate piece of work.
    """
    token = x_share_token or request.query_params.get("token")
    if not token:
        return Access(session_id=session_id, role="owner", via_token=False)

    row = await db.resolve_share_token(token)
    if row is None or row.get("session_id") != session_id:
        # Don't leak which leg failed — both shapes look like 403 to the
        # caller. Reduces guessable attack surface for token enumeration.
        raise HTTPException(status_code=403, detail="Invalid or revoked share token.")

    role = row.get("role")
    if role not in ("viewer", "editor"):
        raise HTTPException(status_code=403, detail="Share token has an unrecognized role.")

    return Access(session_id=session_id, role=role, via_token=True)


def require_writer(access: Access) -> None:
    """Raise 403 if the resolved access is read-only.

    Called at the top of every mutating endpoint. Owners and editors pass;
    viewers are refused.
    """
    if access.role == "viewer":
        raise HTTPException(status_code=403, detail="This share token is read-only.")


# --- Broadcaster --------------------------------------------------------------

class Broadcaster:
    """In-process pub/sub for per-session state-change events.

    Each SSE subscriber gets a bounded queue (maxsize=64). When a queue is
    full we drop the event and log — better than blocking the publisher and
    stalling the entire request, and the client can re-fetch on reconnect.

    In-process is fine for a single-uvicorn-worker deployment. Multi-worker
    or multi-pod deployments would need Redis pub/sub or similar; not built
    here because that's not the current shape.
    """

    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = {}
        self._lock = asyncio.Lock()

    async def subscribe(self, session_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        async with self._lock:
            self._subs.setdefault(session_id, set()).add(q)
        return q

    def unsubscribe(self, session_id: str, q: asyncio.Queue) -> None:
        # Best-effort sync unsubscribe — called from `finally` blocks where
        # awaiting the lock could race the cancellation. Worst case is a
        # transient extra reference; the queue is dropped on the next iter.
        subs = self._subs.get(session_id)
        if not subs:
            return
        subs.discard(q)
        if not subs:
            self._subs.pop(session_id, None)

    async def publish(self, session_id: str, event: dict) -> None:
        subs = list(self._subs.get(session_id, ()))
        for q in subs:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning(
                    "Broadcaster: dropped event for %s — queue full (slow consumer)",
                    session_id,
                )


# --- Capacity monitor ---------------------------------------------------------

class CapacityMonitor:
    """Coarse counters for SSE connections + agent in-flight LLM calls.

    Crosses a threshold → fires `_alert` (stderr log + optional webhook),
    with a per-kind cooldown so a sustained burst doesn't spam the channel.

    Defaults:
        sse_connections     threshold 50
        agent_inflight      threshold 5
        cooldown            300s

    All overridable via env. The webhook payload is intentionally minimal
    (`text` field only) — works as-is with Slack incoming webhooks and is
    easy to fan out to anything else.
    """

    _COOLDOWN_S = 300.0

    def __init__(self) -> None:
        self._gauges: dict[str, int] = {
            "sse_connections": 0,
            "agent_inflight": 0,
        }
        self._thresholds: dict[str, int] = {
            "sse_connections": int(os.environ.get("SSE_ALERT_THRESHOLD", "50")),
            "agent_inflight": int(os.environ.get("AGENT_INFLIGHT_ALERT_THRESHOLD", "5")),
        }
        self._last_alert: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def inc(self, kind: str) -> None:
        async with self._lock:
            value = self._gauges.get(kind, 0) + 1
            self._gauges[kind] = value
            threshold = self._thresholds.get(kind)
            should_alert = (
                threshold is not None
                and value >= threshold
                and self._can_alert(kind)
            )
            if should_alert:
                # Stamp the cooldown atomically with the decision to alert.
                # If we waited until inside _alert (outside the lock), two
                # concurrent inc()s could both see _can_alert=True and
                # double-fire before either updated the timestamp.
                self._last_alert[kind] = time.monotonic()
        if should_alert:
            # Fire outside the lock — webhook POST shouldn't block other
            # increments. Failures inside _alert are swallowed so a bad
            # webhook URL can't take the request path with it.
            await self._alert(kind, value, threshold)

    async def dec(self, kind: str) -> None:
        async with self._lock:
            self._gauges[kind] = max(0, self._gauges.get(kind, 0) - 1)

    def _can_alert(self, kind: str) -> bool:
        last = self._last_alert.get(kind)
        if last is None:
            return True
        return (time.monotonic() - last) >= self._COOLDOWN_S

    async def _alert(self, kind: str, value: int, threshold: int | None) -> None:
        # Cooldown stamp is set by the caller atomically with the decision to
        # alert (see inc()) so two concurrent crossings can't both fire.
        msg = f"[north-star] {kind} = {value} (threshold {threshold})"
        logger.warning(msg)
        webhook = os.environ.get("ALERT_WEBHOOK_URL")
        if not webhook:
            return
        try:
            # Lazy import — httpx is already a transitive dep but keeping
            # the import local matches the rest of this module's pattern
            # and avoids paying the import cost when no webhook is set.
            import httpx

            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(webhook, json={"text": msg})
        except Exception:  # noqa: BLE001
            # Webhook failures must never escape — observability mustn't
            # break the request. Debug-level so it's reachable when needed
            # but doesn't pollute warn-level logs.
            logger.debug("CapacityMonitor: webhook POST failed", exc_info=True)

    def snapshot(self) -> dict:
        return dict(self._gauges)


# Module-level singletons. Imported by main.py + db.py.
broadcaster = Broadcaster()
capacity = CapacityMonitor()
