"""Unit tests for app.agent_task — the tool-use loop that runs the skill
under test in eval mode.

These tests don't hit Anthropic. They feed a fake client a scripted sequence
of responses (text → tool_use → tool_result → text) and assert that:
  - the loop dispatches tool calls and feeds results back
  - sandbox path enforcement refuses paths outside the workspace
  - artifacts written during the run are picked up in the manifest
  - the iteration cap prevents runaway loops
  - trace metadata makes it back into per_row via attach_traces_to_per_row

The fake client mimics just the surface of anthropic.Anthropic that
agent_task touches: messages.create returning an object with .content,
.stop_reason. Nothing more.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from app import agent_task


# --- Test doubles ---------------------------------------------------------

@dataclass
class _Block:
    """Minimal stand-in for an SDK content block."""
    type: str
    text: str = ""
    id: str = ""
    name: str = ""
    input: dict = None  # type: ignore[assignment]


@dataclass
class _Response:
    content: list
    stop_reason: str


class _ScriptedClient:
    """Returns a pre-baked sequence of responses on each .messages.create call.

    Lets us script "text only" / "tool use" / "tool use + final text" turns
    without spinning up the real Anthropic SDK. The captured `calls` list
    lets tests assert what was sent on each iteration.
    """

    def __init__(self, responses: list[_Response]):
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []
        self.messages = self  # so client.messages.create works

    def create(self, **kwargs):
        # Deep-copy `messages` so later loop mutations don't retroactively
        # change what the test sees for an earlier call.
        import copy as _copy
        snap = dict(kwargs)
        if "messages" in snap:
            snap["messages"] = _copy.deepcopy(snap["messages"])
        self.calls.append(snap)
        if not self._responses:
            # Belt-and-suspenders — an empty script means tests forgot a turn.
            raise AssertionError("ScriptedClient ran out of responses")
        return self._responses.pop(0)


def _text(text: str) -> _Block:
    return _Block(type="text", text=text)


def _tool_use(name: str, tool_input: dict, *, id: str = "tu_1") -> _Block:
    return _Block(type="tool_use", id=id, name=name, input=tool_input)


# --- Sandbox tests --------------------------------------------------------

class TestSandbox:
    def test_resolve_in_sandbox_accepts_relative(self, tmp_path: Path):
        ws = tmp_path / "ws"
        ws.mkdir()
        resolved = agent_task._resolve_in_sandbox(ws, "out.txt")
        assert resolved == (ws / "out.txt").resolve()

    def test_resolve_in_sandbox_rejects_absolute(self, tmp_path: Path):
        ws = tmp_path / "ws"
        ws.mkdir()
        with pytest.raises(agent_task.SandboxViolation):
            agent_task._resolve_in_sandbox(ws, "/etc/passwd")

    def test_resolve_in_sandbox_rejects_parent_traversal(self, tmp_path: Path):
        ws = tmp_path / "ws"
        ws.mkdir()
        with pytest.raises(agent_task.SandboxViolation):
            agent_task._resolve_in_sandbox(ws, "../escape.txt")


class TestExecuteTool:
    def test_write_then_read_roundtrip(self, tmp_path: Path):
        result, err = agent_task._execute_tool(
            "write_file", {"path": "a.txt", "content": "hello"}, tmp_path, allow_bash=False,
        )
        assert err is False
        assert (tmp_path / "a.txt").read_text() == "hello"

        result, err = agent_task._execute_tool(
            "read_file", {"path": "a.txt"}, tmp_path, allow_bash=False,
        )
        assert err is False
        assert result == "hello"

    def test_read_missing_file_is_error(self, tmp_path: Path):
        result, err = agent_task._execute_tool(
            "read_file", {"path": "missing.txt"}, tmp_path, allow_bash=False,
        )
        assert err is True
        assert "not found" in result

    def test_edit_file_replaces_first_match(self, tmp_path: Path):
        (tmp_path / "doc.md").write_text("foo bar foo")
        _, err = agent_task._execute_tool(
            "edit_file",
            {"path": "doc.md", "find": "foo", "replace": "BAZ"},
            tmp_path,
            allow_bash=False,
        )
        assert err is False
        assert (tmp_path / "doc.md").read_text() == "BAZ bar foo"

    def test_edit_file_missing_find_is_error(self, tmp_path: Path):
        (tmp_path / "doc.md").write_text("hello")
        _, err = agent_task._execute_tool(
            "edit_file",
            {"path": "doc.md", "find": "xxx", "replace": "yyy"},
            tmp_path,
            allow_bash=False,
        )
        assert err is True

    def test_list_dir_lists_contents(self, tmp_path: Path):
        (tmp_path / "a.txt").write_text("x")
        (tmp_path / "sub").mkdir()
        result, err = agent_task._execute_tool(
            "list_dir", {"path": "."}, tmp_path, allow_bash=False,
        )
        assert err is False
        assert "a.txt" in result
        assert "sub/" in result

    def test_run_bash_disabled_by_default(self, tmp_path: Path):
        result, err = agent_task._execute_tool(
            "run_bash", {"command": "echo hi"}, tmp_path, allow_bash=False,
        )
        assert err is True
        assert "disabled" in result

    def test_unknown_tool_is_error(self, tmp_path: Path):
        result, err = agent_task._execute_tool(
            "nonexistent_tool", {}, tmp_path, allow_bash=False,
        )
        assert err is True
        assert "unknown" in result


# --- Agent loop tests -----------------------------------------------------

class TestAgentLoop:
    def test_text_only_response_returns_immediately(self, tmp_path: Path):
        client = _ScriptedClient([
            _Response(content=[_text("just words")], stop_reason="end_turn"),
        ])
        trace = agent_task._run_agent_loop(
            client,  # type: ignore[arg-type]
            model="m",
            skill_body="sys",
            user_input="prompt",
            workspace=tmp_path,
            allow_bash=False,
            max_iterations=5,
            max_tokens=1024,
        )
        assert trace.final_text == "just words"
        assert trace.iterations == 1
        assert trace.tool_calls == []
        assert trace.stop_reason == "end_turn"
        assert trace.halted is None

    def test_tool_use_loop_dispatches_and_continues(self, tmp_path: Path):
        client = _ScriptedClient([
            _Response(
                content=[_tool_use("write_file", {"path": "out.txt", "content": "DATA"})],
                stop_reason="tool_use",
            ),
            _Response(content=[_text("done")], stop_reason="end_turn"),
        ])
        trace = agent_task._run_agent_loop(
            client,  # type: ignore[arg-type]
            model="m",
            skill_body="sys",
            user_input="please write the file",
            workspace=tmp_path,
            allow_bash=False,
            max_iterations=5,
            max_tokens=1024,
        )
        assert trace.iterations == 2
        assert trace.final_text == "done"
        assert len(trace.tool_calls) == 1
        assert trace.tool_calls[0].name == "write_file"
        assert trace.tool_calls[0].is_error is False
        assert (tmp_path / "out.txt").read_text() == "DATA"

        # Second create call must include the tool_result for the prior tool_use.
        second_messages = client.calls[1]["messages"]
        # last user turn carries the tool_result block
        last_user = second_messages[-1]
        assert last_user["role"] == "user"
        assert any(b.get("type") == "tool_result" for b in last_user["content"])

    def test_iteration_cap_halts_runaway_loop(self, tmp_path: Path):
        # Every response asks for another tool use → must stop at the cap.
        responses = [
            _Response(
                content=[_tool_use("list_dir", {"path": "."}, id=f"tu_{i}")],
                stop_reason="tool_use",
            )
            for i in range(10)
        ]
        client = _ScriptedClient(responses)
        trace = agent_task._run_agent_loop(
            client,  # type: ignore[arg-type]
            model="m",
            skill_body="sys",
            user_input="loop forever",
            workspace=tmp_path,
            allow_bash=False,
            max_iterations=3,
            max_tokens=512,
        )
        assert trace.iterations == 3
        assert trace.halted is not None and "iteration cap" in trace.halted

    def test_sandbox_violation_is_reported_as_tool_error(self, tmp_path: Path):
        client = _ScriptedClient([
            _Response(
                content=[_tool_use("write_file", {"path": "/etc/evil", "content": "x"})],
                stop_reason="tool_use",
            ),
            _Response(content=[_text("ok i stopped")], stop_reason="end_turn"),
        ])
        trace = agent_task._run_agent_loop(
            client,  # type: ignore[arg-type]
            model="m",
            skill_body="sys",
            user_input="be evil",
            workspace=tmp_path,
            allow_bash=False,
            max_iterations=3,
            max_tokens=512,
        )
        assert len(trace.tool_calls) == 1
        assert trace.tool_calls[0].is_error is True
        assert "sandbox" in trace.tool_calls[0].result.lower()
        assert not (tmp_path.parent / "etc").exists()


# --- Artifact collection --------------------------------------------------

class TestCollectArtifacts:
    def test_collects_text_files(self, tmp_path: Path):
        (tmp_path / "a.txt").write_text("hello")
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "b.md").write_text("# title")
        artifacts = agent_task._collect_artifacts(tmp_path)
        paths = sorted(a["path"] for a in artifacts)
        assert paths == ["a.txt", "sub/b.md"]
        assert all(a["preview"] is not None for a in artifacts)
        assert all(a["sha256"] for a in artifacts)

    def test_marks_binary_files(self, tmp_path: Path):
        (tmp_path / "blob.bin").write_bytes(b"\xff\xfe\x00\x01")
        artifacts = agent_task._collect_artifacts(tmp_path)
        assert len(artifacts) == 1
        assert artifacts[0]["binary"] is True
        assert artifacts[0]["preview"] is None


# --- Trace attachment -----------------------------------------------------

class TestAttachTraces:
    def test_merges_trace_into_per_row_metadata(self):
        trace = agent_task.AgentRunTrace(
            final_text="ok",
            iterations=2,
            stop_reason="end_turn",
        )
        traces = {"row-1": trace}
        per_row = [
            {"input": "x", "output": "ok", "metadata": {"id": "row-1", "feature_area": "fa"}},
            {"input": "y", "output": "ok", "metadata": {"id": "row-2"}},
        ]
        agent_task.attach_traces_to_per_row(per_row, traces)
        assert "agent" in per_row[0]["metadata"]
        assert per_row[0]["metadata"]["agent"]["iterations"] == 2
        # untouched row has no agent key
        assert "agent" not in per_row[1]["metadata"]
        # original feature_area preserved
        assert per_row[0]["metadata"]["feature_area"] == "fa"

    def test_no_traces_is_a_noop(self):
        per_row = [{"metadata": {"id": "x"}}]
        agent_task.attach_traces_to_per_row(per_row, {})
        assert per_row[0]["metadata"] == {"id": "x"}


# --- Truncation -----------------------------------------------------------

class TestTruncate:
    def test_truncate_text_under_cap_unchanged(self):
        assert agent_task._truncate_text("short", 100) == "short"

    def test_truncate_text_over_cap(self):
        out = agent_task._truncate_text("x" * 50, 10)
        assert out.startswith("xxxxxxxxxx")
        assert "truncated" in out

    def test_truncate_blob_handles_nested(self):
        blob = {"a": "x" * 5000, "b": ["y" * 5000]}
        out = agent_task._truncate_blob(blob)
        assert "truncated" in out["a"]
        assert "truncated" in out["b"][0]


# --- make_agent_task end-to-end ------------------------------------------

class TestMakeAgentTask:
    def test_task_returns_final_text_and_calls_trace_sink(self, tmp_path: Path):
        client = _ScriptedClient([
            _Response(
                content=[_tool_use("write_file", {"path": "f.txt", "content": "v"})],
                stop_reason="tool_use",
            ),
            _Response(content=[_text("all done")], stop_reason="end_turn"),
        ])
        captured: dict[str, agent_task.AgentRunTrace] = {}
        task = agent_task.make_agent_task(
            client,  # type: ignore[arg-type]
            skill_body="sys",
            model="m",
            sandbox_root=tmp_path / "runs",
            allow_bash=False,
            max_iterations=3,
            trace_sink=lambda rid, t: captured.update({rid: t}),
        )
        result = task({"input": "go", "metadata": {"id": "row-A"}})
        assert result == "all done"
        assert "row-A" in captured
        trace = captured["row-A"]
        assert len(trace.tool_calls) == 1
        # Artifacts manifest reflects the file we wrote.
        assert any(a["path"] == "f.txt" for a in trace.artifacts)
        # Workspace is row-scoped.
        assert (tmp_path / "runs" / "row-A" / "f.txt").exists()

    def test_task_falls_back_to_input_digest_when_no_id(self, tmp_path: Path):
        client = _ScriptedClient([
            _Response(content=[_text("ok")], stop_reason="end_turn"),
        ])
        captured: dict[str, agent_task.AgentRunTrace] = {}
        task = agent_task.make_agent_task(
            client,  # type: ignore[arg-type]
            skill_body="sys",
            model="m",
            sandbox_root=tmp_path / "runs",
            trace_sink=lambda rid, t: captured.update({rid: t}),
        )
        # No metadata.id; the task synthesizes an id from the input string.
        result = task({"input": "hello"})
        assert result == "ok"
        assert len(captured) == 1
