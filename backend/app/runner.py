"""RunFeature — the single feature-execution seam.

The same contract powers the Evaluate step and the deployed feature, so
"what you evaluated is what you ship". See `docs/quick-demo-plan.md`.

Backends (selected via the RUNNER_BACKEND env var):
  * ``mock``      — canned output + trace. No API key or infra needed, so every
                    other track can build against a stable RunFeature today.
  * ``inprocess`` — real ``messages.create`` (single-shot). Reuses the canonical
                    ``tools.get_client`` factory (Anthropic / OpenRouter). This
                    is today's non-agent behavior, mapped into ``contracts.Trace``.
  * ``container`` — Claude Agent SDK in a container (the flexible path). This is
                    Track 1's build; stubbed here so the seam is stable first.

Input assembly (text + files) lives here too, so it's the *only* place that
knows how to turn a typed ``FeatureInput`` into an LLM message.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Union

from . import contracts as c

# ---------------------------------------------------------------------------
# Input assembly — typed FeatureInput -> LLM message content.
# ---------------------------------------------------------------------------

# Anthropic message content is either a bare string or a list of content blocks.
MessageContent = Union[str, list[dict[str, Any]]]


def assemble_message(req: c.RunFeatureRequest) -> MessageContent:
    """Turn a feature input into Anthropic message content, per the input schema.

    - A bare string (single-text-field shorthand) passes through unchanged ->
      byte-for-byte today's behavior.
    - A field map becomes a content-block array: scalars as text blocks; file /
      image fields as their resolved content blocks.
    """
    inp = req.input
    if isinstance(inp, str):
        return inp

    blocks: list[dict[str, Any]] = []
    by_name = {f.name: f for f in req.input_schema.fields}
    for name, val in inp.items():
        if val is None:
            continue
        field = by_name.get(name)
        is_artifact = field is not None and field.type in (
            c.InputFieldType.file,
            c.InputFieldType.image,
        )
        if is_artifact and isinstance(val, dict):
            blocks.append(_artifact_block(name, val))
        else:
            rendered = val if isinstance(val, str) else json.dumps(val)
            blocks.append({"type": "text", "text": f"{name}: {rendered}"})
    return blocks or ""


def _artifact_block(field_name: str, ref: dict[str, Any]) -> dict[str, Any]:
    """Map an ArtifactRef onto an Anthropic content block.

    TODO(track-1/track-4): resolve ``ref['ref']`` against the artifact store and
    emit a real ``image`` / ``document`` block (or stage the file into the
    container working dir for agent mode). Until the artifact store exists we
    emit a descriptive text placeholder so text/scalar inputs work end to end.
    """
    filename = ref.get("filename", "file")
    mime = ref.get("mime", "application/octet-stream")
    locator = ref.get("ref", "")
    return {
        "type": "text",
        "text": f"[{field_name}: attached file {filename} ({mime}); artifact ref {locator}]",
    }


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------


def _run_mock(req: c.RunFeatureRequest) -> c.RunFeatureResult:
    msg = assemble_message(req)
    preview = msg if isinstance(msg, str) else json.dumps(msg)
    preview = preview[:120]
    return c.RunFeatureResult(
        output=f"[mock:{req.skill_id}] processed {len(preview)} chars of input",
        trace=c.Trace(
            final_text="mock final text",
            iterations=1,
            stop_reason="end_turn",
            model="mock",
            tool_calls=[
                c.ToolCall(
                    name="mock_tool",
                    input={"echo": preview},
                    result="ok",
                    duration_ms=1,
                )
            ],
        ),
    )


def _run_inprocess(req: c.RunFeatureRequest) -> c.RunFeatureResult:
    if req.mode == c.RunMode.agent:
        # The in-process tool-use loop lives in agent_task.py; wiring it behind
        # this seam is part of Track 1 (alongside the container backend). Until
        # then the honest behavior is to refuse rather than silently downgrade.
        raise NotImplementedError(
            "inprocess agent mode not wired yet — use RUNNER_BACKEND=mock, "
            "mode=single_shot, or the container backend (Track 1)."
        )

    from . import tools  # local import: keeps contracts/runner import-light

    client = tools.get_client()
    model = tools._resolve_model(req.model or tools.get_model())
    started = time.monotonic()
    resp = client.messages.create(
        model=model,
        max_tokens=2048,
        system=req.skill_body,
        messages=[{"role": "user", "content": assemble_message(req)}],
    )
    latency_ms = int((time.monotonic() - started) * 1000)
    output = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
    return c.RunFeatureResult(
        output=output,
        trace=c.Trace(
            final_text=output,
            iterations=1,
            stop_reason=resp.stop_reason,
            model=model,
            input_tokens=getattr(resp.usage, "input_tokens", None),
            output_tokens=getattr(resp.usage, "output_tokens", None),
            latency_ms=latency_ms,
        ),
    )


def _run_container(req: c.RunFeatureRequest) -> c.RunFeatureResult:
    # Track 1: when CONTAINER_URL is set we route through the
    # runner_container service (Claude Agent / Anthropic SDK in a box).
    # Otherwise keep the historical "not built yet" surface so unconfigured
    # deployments fail loudly rather than silently downgrade.
    if os.environ.get("CONTAINER_URL", "").strip():
        from . import runner_container_client  # local import — optional path

        return runner_container_client.invoke(req)
    raise NotImplementedError(
        "container backend requires CONTAINER_URL (e.g. http://localhost:8088); "
        "see backend/runner_container/README.md."
    )


_BACKENDS = {
    "mock": _run_mock,
    "inprocess": _run_inprocess,
    "container": _run_container,
}


def active_backend() -> str:
    return os.environ.get("RUNNER_BACKEND", "inprocess")


def run_feature(req: c.RunFeatureRequest) -> c.RunFeatureResult:
    """Execute a feature against one input. Never raises — failures come back as
    a result with ``error`` set, so orchestrator / observer get structured errors."""
    backend = _BACKENDS.get(active_backend())
    if backend is None:
        return c.RunFeatureResult(
            output="", error=f"unknown RUNNER_BACKEND={active_backend()!r}"
        )
    try:
        return backend(req)
    except Exception as exc:  # noqa: BLE001 — surface any backend failure structurally
        return c.RunFeatureResult(output="", error=f"{type(exc).__name__}: {exc}")
