"""Feature flags — per-deployment toggles read from environment.

Each flag is independent: there is no umbrella "playground mode" switch.
The module reads env vars once at import time and exposes simple
predicates plus a FastAPI dependency for the disabled-endpoint pattern.

Env vars consumed:
  - POLARIS_ENABLED (default "true"): whether the Polaris tool-using
    assistant is exposed. Disable in public-playground deployments where
    arbitrary tool use is too expensive / risky.
  - PUBLIC_API_KEY (no default): a per-app marker used by the frontend
    to distinguish a public deployment from a private one. Backend
    treats it as opaque — presence is the signal.

This module owns no DB table and registers no middleware; it is a thin
config reader. `setup()` exists only for symmetry with other self-
contained modules and just logs the resolved flag state at startup.
"""

from __future__ import annotations

import logging
import os

from fastapi import HTTPException

logger = logging.getLogger(__name__)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off", "")


# Resolved at module import. Process restart needed to flip these — they
# describe how the deployment is configured, not per-request state.
POLARIS_ENABLED: bool = _env_bool("POLARIS_ENABLED", True)
PUBLIC_API_KEY: str | None = os.environ.get("PUBLIC_API_KEY") or None


def is_polaris_enabled() -> bool:
    """Whether the Polaris assistant endpoint should accept requests."""
    return POLARIS_ENABLED


def is_public_deployment() -> bool:
    """Whether this process is configured as a public-playground deployment.

    The signal is presence of `PUBLIC_API_KEY` — a private deployment
    won't set it. The frontend doesn't get the key value (it stays
    server-side), only the boolean derived here via /config.
    """
    return PUBLIC_API_KEY is not None


def require_polaris_enabled() -> None:
    """FastAPI dependency: 403 when Polaris is disabled in this deployment.

    Used on endpoints under /polaris/* that should be hidden in public
    playground deployments. Returns silently when the flag is on.
    """
    if not POLARIS_ENABLED:
        raise HTTPException(
            status_code=403,
            detail="Polaris is disabled in this deployment.",
        )


def setup() -> None:
    """Log the resolved feature-flag state. Idempotent."""
    logger.info(
        "feature_flags: polaris_enabled=%s public_deployment=%s",
        POLARIS_ENABLED,
        is_public_deployment(),
    )
