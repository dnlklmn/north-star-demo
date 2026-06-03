"""HTTP client for the RunFeature container service.

Tiny on purpose. The container speaks the same JSON shapes as
``backend/app/contracts.py`` — we just POST the request, validate the
response against ``RunFeatureResult`` (so the frozen Trace contract is
enforced once, here), and return it.

Configured by env var ``CONTAINER_URL`` (e.g. ``http://localhost:8088``).
Importing this module does not require any network or container to be up.
"""
from __future__ import annotations

import json
import os
from typing import Optional
from urllib import error as urllib_error
from urllib import request as urllib_request

from . import contracts as c

DEFAULT_TIMEOUT_SECONDS = float(os.environ.get("RUNNER_CONTAINER_TIMEOUT", "300"))


def container_url() -> Optional[str]:
    """Return the configured container URL, or None if unset."""
    url = os.environ.get("CONTAINER_URL", "").strip()
    return url or None


def health(url: Optional[str] = None, timeout: float = 5.0) -> dict:
    """GET /health. Raises on transport errors; returns the parsed JSON body."""
    base = (url or container_url() or "").rstrip("/")
    if not base:
        raise RuntimeError("CONTAINER_URL is not set")
    req = urllib_request.Request(f"{base}/health", method="GET")
    with urllib_request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — local URL
        return json.loads(resp.read().decode("utf-8") or "{}")


def invoke(
    req: c.RunFeatureRequest,
    *,
    url: Optional[str] = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> c.RunFeatureResult:
    """POST /run-feature and return the validated RunFeatureResult.

    Any HTTP / transport failure is surfaced as a structured ``RunFeatureResult``
    with ``error`` set, never as an exception — same contract as
    ``runner.run_feature``.
    """
    base = (url or container_url() or "").rstrip("/")
    if not base:
        return c.RunFeatureResult(output="", error="CONTAINER_URL is not set")

    payload = req.model_dump(mode="json")
    body = json.dumps(payload).encode("utf-8")
    http_req = urllib_request.Request(
        f"{base}/run-feature",
        data=body,
        method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib_request.urlopen(http_req, timeout=timeout) as resp:  # noqa: S310
            raw = resp.read().decode("utf-8") or "{}"
    except urllib_error.HTTPError as exc:
        # Read whatever body the server returned — it's likely a structured error.
        try:
            err_body = exc.read().decode("utf-8")
            parsed = json.loads(err_body)
            return c.RunFeatureResult.model_validate(parsed)
        except Exception:
            return c.RunFeatureResult(
                output="",
                error=f"container HTTP {exc.code}: {exc.reason}",
            )
    except urllib_error.URLError as exc:
        return c.RunFeatureResult(output="", error=f"container unreachable: {exc.reason}")
    except Exception as exc:  # noqa: BLE001 — transport-level fallback
        return c.RunFeatureResult(output="", error=f"container call failed: {exc}")

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        return c.RunFeatureResult(output="", error=f"container returned non-JSON: {exc}")

    try:
        return c.RunFeatureResult.model_validate(parsed)
    except Exception as exc:  # pydantic ValidationError or otherwise
        return c.RunFeatureResult(
            output=str(parsed.get("output", "")) if isinstance(parsed, dict) else "",
            error=f"container returned invalid RunFeatureResult: {exc}",
        )
