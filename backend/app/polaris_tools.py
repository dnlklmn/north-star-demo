"""Polaris tool registry — every meaningful app action exposed to the agent.

CLI parity is the design constraint: anything you can do by clicking should be
doable by talking. The chat frontend and a future CLI both consume this same
registry.

A tool has four parts:
  - name + description + JSON schema (sent to the model)
  - tier            (auto | confirm | nav — drives UI gating)
  - handler(ctx, args) (executes the action; for `confirm` tier returns a
                        proposal payload instead of mutating)

Tier rules (mechanical, not model judgement):
  - auto:    reads, navs, single-row reversible writes (approve, relabel, edit
             a single field). Executes immediately.
  - confirm: multi-row writes, anything that triggers an LLM call, anything
             irreversible (delete, finalize, export). Returns a proposal that
             surfaces in the UI as a chip; the user clicks to fire the
             underlying tool a second time with `confirmed=true`.
  - nav:     read-only side effect on the frontend (route change, drawer
             open). Backend just acknowledges.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Optional

from . import db

logger = logging.getLogger(__name__)

Tier = Literal["auto", "confirm", "nav"]


@dataclass
class ToolCtx:
    """Per-request context handed to every handler.

    Mirrors what the frontend `context` blob carries so the model never has
    to ask "where am I." Fields are optional because the chat is global —
    you can talk to Polaris from the home page with no project selected.
    """
    session_id: Optional[str] = None
    dataset_id: Optional[str] = None
    selected_example_id: Optional[str] = None
    route: Optional[str] = None
    phase: Optional[str] = None


@dataclass
class ToolDef:
    name: str
    description: str
    schema: dict
    tier: Tier
    handler: Callable[[ToolCtx, dict], Awaitable[dict]]


REGISTRY: dict[str, ToolDef] = {}


def tool(
    name: str,
    description: str,
    schema: dict,
    tier: Tier = "auto",
):
    """Decorator: register a Polaris tool.

    The schema is `input_schema` per Anthropic's tool-use contract — wrapping
    happens in `tool_schemas_for_model()`.
    """
    def decorator(fn: Callable[[ToolCtx, dict], Awaitable[dict]]):
        if name in REGISTRY:
            raise ValueError(f"Duplicate Polaris tool: {name}")
        REGISTRY[name] = ToolDef(name=name, description=description, schema=schema, tier=tier, handler=fn)
        return fn
    return decorator


def tool_schemas_for_model() -> list[dict]:
    """Render every registered tool into Anthropic tool-use format."""
    return [
        {
            "name": t.name,
            "description": t.description,
            "input_schema": t.schema,
        }
        for t in REGISTRY.values()
    ]


async def dispatch(name: str, ctx: ToolCtx, args: dict) -> dict:
    """Execute a tool by name. Returns a JSON-serializable result.

    Confirm-tier tools: when `args.get('confirmed')` is False (default), the
    handler short-circuits and returns a proposal envelope. When True, it
    executes for real.
    """
    td = REGISTRY.get(name)
    if td is None:
        return {"error": f"unknown tool: {name}"}
    return await td.handler(ctx, args)


# Convenience used by handlers that need to short-circuit until confirmed.
def _proposal(name: str, args: dict, label: str, reason: str) -> dict:
    return {
        "_proposal": True,
        "tool": name,
        "args": args,
        "label": label,
        "reason": reason,
    }


def _nav(target: str, props: dict | None = None) -> dict:
    return {"_nav": True, "target": target, "props": props or {}}


def _confirm_schema(extra: dict | None = None, required: list[str] | None = None) -> dict:
    """Wrap a tool's args with the standard `confirmed: bool` toggle.

    Confirm-tier handlers short-circuit when `confirmed` is False (returning a
    proposal envelope) and execute when True. The frontend re-issues the same
    tool call with `confirmed=True` after the user clicks the chip.
    """
    props: dict[str, Any] = {"confirmed": {"type": "boolean", "default": False}}
    if extra:
        props.update(extra)
    return {
        "type": "object",
        "properties": props,
        "required": required or [],
        "additionalProperties": False,
    }


# ============================================================================
# READ TOOLS — always auto, never mutate.
# ============================================================================


@tool(
    "list_projects",
    "List all projects (sessions). Returns id, name, kind, last activity.",
    {"type": "object", "properties": {"limit": {"type": "integer", "default": 20}}, "additionalProperties": False},
    tier="auto",
)
async def _list_projects(ctx: ToolCtx, args: dict) -> dict:
    rows = await db.list_sessions(limit=args.get("limit", 20))
    return {
        "projects": [
            {
                "id": r["id"],
                "name": r.get("name") or "(unnamed)",
                "kind": r.get("kind"),
                "updated_at": str(r.get("updated_at") or ""),
            }
            for r in rows
        ]
    }


@tool(
    "get_project",
    "Get the current (or named) project: state, charter summary, dataset summary, phase.",
    {
        "type": "object",
        "properties": {"session_id": {"type": "string", "description": "Defaults to current session."}},
        "additionalProperties": False,
    },
    tier="auto",
)
async def _get_project(ctx: ToolCtx, args: dict) -> dict:
    sid = args.get("session_id") or ctx.session_id
    if not sid:
        return {"error": "no session in context"}
    row = await db.get_session(sid)
    if not row:
        return {"error": "session not found"}
    state = row.get("state", {})
    charter = state.get("charter", {})
    dataset = await db.get_dataset_by_session(sid)
    return {
        "id": sid,
        "name": row.get("name"),
        "discovery_phase": state.get("discovery_phase"),
        "agent_status": state.get("agent_status"),
        "n_goals": len(state.get("extracted_goals") or []),
        "n_users": len(state.get("extracted_users") or []),
        "n_stories": len(state.get("extracted_stories") or []),
        "has_charter": bool(charter.get("alignment") or charter.get("coverage", {}).get("criteria")),
        "n_alignment": len(charter.get("alignment") or []),
        "n_coverage_criteria": len((charter.get("coverage") or {}).get("criteria") or []),
        "n_scorers": len(state.get("scorers") or []),
        "dataset_id": dataset["id"] if dataset else None,
    }


@tool(
    "get_scorers",
    "Open the scorers tab and list the scorers — name, type, description, enabled flag. UI navigates so the user sees them.",
    {"type": "object", "properties": {"session_id": {"type": "string"}}, "additionalProperties": False},
    tier="auto",
)
async def _get_scorers(ctx: ToolCtx, args: dict) -> dict:
    sid = args.get("session_id") or ctx.session_id
    if not sid:
        return {"error": "no session in context"}
    row = await db.get_session(sid)
    if not row:
        return {"error": "session not found"}
    scorers = (row.get("state") or {}).get("scorers") or []
    return {
        **_nav("phase", {"phase": "scorers"}),
        "count": len(scorers),
        "scorers": [
            {
                "name": s.get("name"),
                "type": s.get("type"),
                "description": s.get("description"),
                "enabled": s.get("enabled", True),
            }
            for s in scorers
        ],
    }


@tool(
    "get_charter",
    "Open the charter view and return the charter (task, alignment, coverage, balance, rot). UI navigates to the charter tab so the user sees what you're describing.",
    {"type": "object", "properties": {"session_id": {"type": "string"}}, "additionalProperties": False},
    tier="auto",
)
async def _get_charter(ctx: ToolCtx, args: dict) -> dict:
    sid = args.get("session_id") or ctx.session_id
    if not sid:
        return {"error": "no session in context"}
    row = await db.get_session(sid)
    if not row:
        return {"error": "session not found"}
    charter = row.get("state", {}).get("charter", {})
    return {**_nav("phase", {"phase": "charter"}), "charter": charter}


@tool(
    "get_dataset_overview",
    "Counts and breakdowns for the current dataset: total, by_review_status, by_label, by_feature_area.",
    {"type": "object", "properties": {"dataset_id": {"type": "string"}}, "additionalProperties": False},
    tier="auto",
)
async def _get_dataset_overview(ctx: ToolCtx, args: dict) -> dict:
    did = args.get("dataset_id") or ctx.dataset_id
    if not did:
        return {"error": "no dataset in context"}
    # Read the cached stats from the dataset row instead of recomputing —
    # `update_dataset_stats` writes to the row and triggers an SSE broadcast,
    # which is wrong for a tool the agent calls liberally to peek at state.
    ds = await db.get_dataset(did)
    if not ds:
        return {"error": "dataset not found"}
    return {
        **_nav("phase", {"phase": "dataset"}),
        "dataset_id": did,
        "version": ds.get("version"),
        "stats": ds.get("stats") or {},
    }


@tool(
    "list_examples",
    "List examples in the current dataset, optionally filtered. Returns short previews — call get_example for full bodies.",
    {
        "type": "object",
        "properties": {
            "feature_area": {"type": "string"},
            "label": {"type": "string", "enum": ["good", "bad", "unlabeled"]},
            "review_status": {"type": "string", "enum": ["pending", "approved", "rejected", "needs_edit"]},
            "source": {"type": "string", "enum": ["manual", "synthetic", "turn", "import"]},
            "query": {"type": "string", "description": "Substring match against input text."},
            "limit": {"type": "integer", "default": 20, "maximum": 100},
        },
        "additionalProperties": False,
    },
    tier="auto",
)
async def _list_examples(ctx: ToolCtx, args: dict) -> dict:
    did = args.get("dataset_id") or ctx.dataset_id
    if not did:
        return {"error": "no dataset in context"}
    rows = await db.get_examples(
        did,
        feature_area=args.get("feature_area"),
        label=args.get("label"),
        review_status=args.get("review_status"),
        source=args.get("source"),
    )
    q = (args.get("query") or "").lower().strip()
    if q:
        rows = [r for r in rows if q in (r.get("input") or "").lower()]
    limit = min(int(args.get("limit") or 20), 100)
    rows = rows[:limit]
    return {
        # Open the dataset tab so the user can see the rows in the UI rather
        # than relying on the chat reply for the list. Filters provided here
        # are only used server-side for the count summary; to actually drive
        # the UI filter, prefer set_dataset_filter.
        **_nav("phase", {"phase": "dataset"}),
        "count": len(rows),
        "examples": [
            {
                "id": r["id"],
                "feature_area": r.get("feature_area"),
                "input_preview": (r.get("input") or "")[:200],
                "label": r.get("label"),
                "review_status": r.get("review_status"),
                "source": r.get("source"),
                "is_adversarial": r.get("is_adversarial"),
                "judge_label": (r.get("judge_verdict") or {}).get("suggested_label"),
                "judge_confidence": (r.get("judge_verdict") or {}).get("confidence"),
            }
            for r in rows
        ],
    }


@tool(
    "get_example",
    "Full record for one example, including judge verdict and revision suggestion.",
    {"type": "object", "properties": {"example_id": {"type": "string"}}, "required": ["example_id"]},
    tier="auto",
)
async def _get_example(ctx: ToolCtx, args: dict) -> dict:
    did = ctx.dataset_id
    if not did:
        return {"error": "no dataset in context"}
    rows = await db.get_examples(did)
    row = next((r for r in rows if r["id"] == args["example_id"]), None)
    if not row:
        return {"error": "example not found"}
    # Open the example panel so the user is looking at the same row Polaris
    # describes. Frontend handler switches to dataset tab + selects the row.
    return {**_nav("example", {"example_id": row["id"]}), "example": row}


@tool(
    "get_coverage_gaps",
    "Deterministic coverage matrix (criterion × feature_area counts) plus empty/underfilled cells. No LLM call.",
    {"type": "object", "properties": {}, "additionalProperties": False},
    tier="auto",
)
async def _get_coverage_gaps(ctx: ToolCtx, args: dict) -> dict:
    did = ctx.dataset_id
    if not did:
        return {"error": "no dataset in context"}
    ds = await db.get_dataset(did)
    if not ds:
        return {"error": "dataset not found"}
    charter = ds.get("charter_snapshot") or {}
    examples = await db.get_examples(did)
    from .prompt import _build_coverage_matrix
    matrix = _build_coverage_matrix(charter, examples)
    empty: list[dict] = []
    underfilled: list[dict] = []
    for criterion, by_fa in matrix.items():
        for fa, n in by_fa.items():
            if n == 0:
                empty.append({"criterion": criterion, "feature_area": fa})
            elif n == 1:
                underfilled.append({"criterion": criterion, "feature_area": fa, "count": n})
    return {
        # Open the coverage map so the user sees the cells visually.
        **_nav("coverage_map", {}),
        "coverage_matrix": matrix,
        "empty_cells": empty,
        "underfilled_cells": underfilled,
    }


@tool(
    "get_eval_runs",
    "Recent eval runs: id, scorer pass rates, status.",
    {"type": "object", "properties": {"limit": {"type": "integer", "default": 5}}, "additionalProperties": False},
    tier="auto",
)
async def _get_eval_runs(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.session_id:
        return {"error": "no session in context"}
    rows = await db.list_eval_runs(ctx.session_id, limit=int(args.get("limit") or 5))
    return {
        # Open the evaluate tab so eval runs are visible in their own list,
        # not just summarized in chat.
        **_nav("phase", {"phase": "evaluate"}),
        "runs": [
            {
                "id": r["id"],
                "status": r.get("status"),
                "created_at": str(r.get("created_at") or ""),
                "n_examples": r.get("n_examples"),
                "summary": r.get("summary"),
            }
            for r in rows
        ],
    }


@tool(
    "get_settings",
    "Current server-side settings (model, creativity, etc.).",
    {"type": "object", "properties": {}, "additionalProperties": False},
    tier="auto",
)
async def _get_settings(ctx: ToolCtx, args: dict) -> dict:
    settings = await db.get_settings() or {}
    return {**_nav("settings", {}), "settings": settings}


@tool(
    "get_activity",
    "Recent agent turns for the current project — useful for 'what just happened.'",
    {"type": "object", "properties": {"limit": {"type": "integer", "default": 20}}, "additionalProperties": False},
    tier="auto",
)
async def _get_activity(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.session_id:
        return {"error": "no session in context"}
    rows = await db.get_activity(ctx.session_id, limit=int(args.get("limit") or 20))
    return {
        "turns": [
            {
                "id": r["id"],
                "turn_type": r.get("turn_type"),
                "created_at": str(r.get("created_at") or ""),
            }
            for r in rows
        ]
    }


# ============================================================================
# INLINE WRITE TOOLS — single-row, reversible, no LLM call.
# ============================================================================


@tool(
    "rename_project",
    "Rename the current project.",
    {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
    tier="auto",
)
async def _rename_project(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.session_id:
        return {"error": "no session in context"}
    row = await db.update_session_name(ctx.session_id, args["name"])
    return {"ok": True, "name": row.get("name")}


@tool(
    "approve_example",
    "Mark an example as approved.",
    {
        "type": "object",
        "properties": {"example_id": {"type": "string"}, "reviewer_notes": {"type": "string"}},
        "required": ["example_id"],
    },
    tier="auto",
)
async def _approve_example(ctx: ToolCtx, args: dict) -> dict:
    fields = {"review_status": "approved"}
    if args.get("reviewer_notes"):
        fields["reviewer_notes"] = args["reviewer_notes"]
    row = await db.update_example(args["example_id"], fields)
    return {"ok": True, "example_id": row["id"], "review_status": row["review_status"]}


@tool(
    "reject_example",
    "Mark an example as rejected.",
    {
        "type": "object",
        "properties": {"example_id": {"type": "string"}, "reviewer_notes": {"type": "string"}},
        "required": ["example_id"],
    },
    tier="auto",
)
async def _reject_example(ctx: ToolCtx, args: dict) -> dict:
    fields = {"review_status": "rejected"}
    if args.get("reviewer_notes"):
        fields["reviewer_notes"] = args["reviewer_notes"]
    row = await db.update_example(args["example_id"], fields)
    return {"ok": True, "example_id": row["id"], "review_status": row["review_status"]}


@tool(
    "relabel_example",
    "Set an example's label (good / bad / unlabeled). Use this when the user says 'mark as good/bad' or 'relabel.'",
    {
        "type": "object",
        "properties": {
            "example_id": {"type": "string"},
            "label": {"type": "string", "enum": ["good", "bad", "unlabeled"]},
            "label_reason": {"type": "string"},
        },
        "required": ["example_id", "label"],
    },
    tier="auto",
)
async def _relabel_example(ctx: ToolCtx, args: dict) -> dict:
    fields: dict[str, Any] = {"label": args["label"]}
    if args.get("label_reason"):
        fields["label_reason"] = args["label_reason"]
    row = await db.update_example(args["example_id"], fields)
    return {"ok": True, "example_id": row["id"], "label": row["label"]}


@tool(
    "update_example",
    "Generic edit for any single-example field (input, expected_output, feature_area, coverage_tags, is_adversarial, should_trigger). Prefer the explicit tools (approve/reject/relabel) when they apply.",
    {
        "type": "object",
        "properties": {
            "example_id": {"type": "string"},
            "fields": {
                "type": "object",
                "description": "Subset of {feature_area, input, expected_output, coverage_tags, is_adversarial, should_trigger, reviewer_notes}.",
                "additionalProperties": True,
            },
        },
        "required": ["example_id", "fields"],
    },
    tier="auto",
)
async def _update_example(ctx: ToolCtx, args: dict) -> dict:
    row = await db.update_example(args["example_id"], args.get("fields") or {})
    return {"ok": True, "example_id": row["id"]}


@tool(
    "delete_example",
    "Delete a single example. Irreversible — confirms first.",
    _confirm_schema({"example_id": {"type": "string"}}, required=["example_id"]),
    tier="confirm",
)
async def _delete_example(ctx: ToolCtx, args: dict) -> dict:
    if not args.get("confirmed"):
        return _proposal(
            "delete_example", args,
            label="Delete this example",
            reason="Irreversible — the row will be removed.",
        )
    ok = await db.delete_example(args["example_id"])
    return {"ok": bool(ok), "example_id": args["example_id"]}


@tool(
    "create_example",
    "Add a new example to the current dataset.",
    {
        "type": "object",
        "properties": {
            "feature_area": {"type": "string"},
            "input": {"type": "string"},
            "expected_output": {"type": "string"},
            "label": {"type": "string", "enum": ["good", "bad", "unlabeled"], "default": "unlabeled"},
            "coverage_tags": {"type": "array", "items": {"type": "string"}},
            "is_adversarial": {"type": "boolean"},
        },
        "required": ["feature_area", "input"],
    },
    tier="auto",
)
async def _create_example(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.dataset_id:
        return {"error": "no dataset in context"}
    row = await db.create_example(
        dataset_id=ctx.dataset_id,
        feature_area=args["feature_area"],
        input_text=args["input"],
        expected_output=args.get("expected_output", ""),
        coverage_tags=args.get("coverage_tags") or [],
        source="manual",
        label=args.get("label", "unlabeled"),
        is_adversarial=args.get("is_adversarial"),
    )
    await db.update_dataset_stats(ctx.dataset_id)
    return {"ok": True, "example_id": row["id"]}


_PATCH_CHARTER_KEYS = {"task", "alignment", "coverage", "balance", "rot"}


@tool(
    "patch_charter",
    "Update one or more charter fields. Touches local state only — does NOT regenerate. The merged charter is validated; invalid shapes are rejected without writing.",
    {
        "type": "object",
        "properties": {
            "fields": {
                "type": "object",
                "description": "Subset of {task, alignment, coverage, balance, rot}. Replaces the named fields wholesale.",
                "additionalProperties": True,
            },
        },
        "required": ["fields"],
    },
    tier="auto",
)
async def _patch_charter(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.session_id:
        return {"error": "no session in context"}
    fields = args.get("fields") or {}
    bad_keys = [k for k in fields if k not in _PATCH_CHARTER_KEYS]
    if bad_keys:
        return {"error": f"unknown charter fields: {bad_keys}"}
    row = await db.get_session(ctx.session_id)
    if not row:
        return {"error": "session not found"}
    state = row["state"]
    charter = dict(state.get("charter") or {})
    for k, v in fields.items():
        charter[k] = v
    # Validate the merged shape before persisting — the model's instinct is
    # to write the JSON it just printed, which can include malformed
    # alignment/coverage trees that crash on next read. Pydantic catches it.
    from .models import Charter
    try:
        Charter.model_validate(charter)
    except Exception as e:  # noqa: BLE001
        return {"error": f"charter validation failed: {e}"}
    state["charter"] = charter
    await db.update_session(ctx.session_id, state, state.get("conversation_history") or [])
    return {"ok": True, "updated_fields": list(fields.keys())}


# Settings the agent is allowed to touch. `model_name` is excluded — switching
# models mid-conversation is the kind of footgun a one-line typo could cause.
_SETTINGS_ALLOWED = {"creativity", "max_rounds"}


@tool(
    "update_settings",
    "Update agent runtime settings (creativity 0-1, max_rounds). Confirms before writing.",
    _confirm_schema({
        "fields": {
            "type": "object",
            "description": "Subset of {creativity, max_rounds}.",
            "additionalProperties": True,
        },
    }, required=["fields"]),
    tier="confirm",
)
async def _update_settings(ctx: ToolCtx, args: dict) -> dict:
    fields = args.get("fields") or {}
    bad = [k for k in fields if k not in _SETTINGS_ALLOWED]
    if bad:
        return {"error": f"settings keys not exposed to chat: {bad}"}
    if not args.get("confirmed"):
        return _proposal(
            "update_settings", args,
            label=f"Update settings: {', '.join(fields.keys())}",
            reason="Affects every subsequent agent call.",
        )
    out = await db.update_settings(fields)
    return {"ok": True, "settings": out}


# ============================================================================
# CONFIRM-TIER WRITES — multi-row, expensive, or irreversible.
# Handlers return a proposal envelope unless args.confirmed is True.
# ============================================================================


@tool(
    "create_project",
    "Create a new project. Confirms before creating to avoid accidental ones during conversation.",
    _confirm_schema({"name": {"type": "string"}, "kind": {"type": "string", "default": "charter"}}),
    tier="confirm",
)
async def _create_project(ctx: ToolCtx, args: dict) -> dict:
    if not args.get("confirmed"):
        return _proposal(
            "create_project", args,
            label=f"Create project '{args.get('name', 'untitled')}'",
            reason="A new project will be created.",
        )
    from .models import SessionState as _SS
    state = _SS(session_id="").model_dump()
    import uuid
    sid = str(uuid.uuid4())
    state["session_id"] = sid
    row = await db.create_session(sid, state, name=args.get("name"))
    return {"ok": True, "session_id": row["id"]}


@tool(
    "delete_project",
    "Permanently delete the current project, all its turns, dataset, and examples.",
    _confirm_schema({"session_id": {"type": "string"}}),
    tier="confirm",
)
async def _delete_project(ctx: ToolCtx, args: dict) -> dict:
    sid = args.get("session_id") or ctx.session_id
    if not sid:
        return {"error": "no session in context"}
    if not args.get("confirmed"):
        return _proposal(
            "delete_project", {**args, "session_id": sid},
            label="Delete this project",
            reason="This is irreversible. All turns, charter, and examples will be removed.",
        )
    await db.delete_session(sid)
    return {"ok": True, "deleted_session_id": sid}


@tool(
    "synthesize_examples",
    "Generate synthetic examples via an LLM call. Costs tokens — confirm first.",
    _confirm_schema({
        "feature_areas": {"type": "array", "items": {"type": "string"}},
        "coverage_criteria": {"type": "array", "items": {"type": "string"}},
        "count_per_scenario": {"type": "integer", "default": 2, "maximum": 10},
    }),
    tier="confirm",
)
async def _synthesize_examples(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.dataset_id:
        return {"error": "no dataset in context"}
    if not args.get("confirmed"):
        n = args.get("count_per_scenario", 2)
        scope = ", ".join(args.get("feature_areas") or args.get("coverage_criteria") or ["all scenarios"])
        return _proposal(
            "synthesize_examples", args,
            label=f"Generate {n}/scenario for {scope}",
            reason="Costs LLM tokens; new examples will be added to the dataset.",
        )
    from .tools import call_synthesize_examples
    ds = await db.get_dataset(ctx.dataset_id)
    if not ds:
        return {"error": "dataset not found"}
    generated, _meta = await call_synthesize_examples(
        ds.get("charter_snapshot") or {},
        feature_areas=args.get("feature_areas"),
        coverage_criteria=args.get("coverage_criteria"),
        count=args.get("count_per_scenario", 2),
    )
    for ex in generated:
        ex["source"] = "synthetic"
    created = await db.bulk_create_examples(ctx.dataset_id, generated)
    await db.update_dataset_stats(ctx.dataset_id)
    return {"ok": True, "generated": len(created)}


@tool(
    "auto_review",
    "Run the LLM judge across pending examples. Costs tokens proportional to row count.",
    _confirm_schema(),
    tier="confirm",
)
async def _auto_review(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.dataset_id:
        return {"error": "no dataset in context"}
    if not args.get("confirmed"):
        return _proposal(
            "auto_review", args,
            label="Auto-review pending examples",
            reason="Runs the LLM judge across every pending row.",
        )
    from .tools import call_review_examples
    ds = await db.get_dataset(ctx.dataset_id)
    if not ds:
        return {"error": "dataset not found"}
    pending = await db.get_examples(ctx.dataset_id, review_status="pending")
    reviews, _meta = await call_review_examples(ds.get("charter_snapshot") or {}, pending)
    for r in reviews:
        eid = r.get("example_id")
        if not eid:
            continue
        await db.update_example(eid, {
            "judge_verdict": {
                "suggested_label": r.get("suggested_label"),
                "confidence": r.get("confidence"),
                "reasoning": r.get("reasoning"),
            }
        })
    return {"ok": True, "reviewed": len(reviews)}


@tool(
    "enrich_gaps",
    "Generate examples specifically for under-covered scenarios. Confirms — costs tokens.",
    _confirm_schema({
        "gap_type": {"type": "string", "enum": ["coverage", "feature_area", "label"]},
        "targets": {"type": "array", "items": {"type": "string"}},
        "count": {"type": "integer", "default": 2, "maximum": 10},
    }, required=["gap_type", "targets"]),
    tier="confirm",
)
async def _enrich_gaps(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.dataset_id:
        return {"error": "no dataset in context"}
    if not args.get("confirmed"):
        return _proposal(
            "enrich_gaps", args,
            label=f"Enrich {args.get('gap_type')} gaps: {', '.join(args.get('targets') or [])}",
            reason="Costs LLM tokens; new synthetic examples will be added.",
        )
    from .tools import call_synthesize_examples
    ds = await db.get_dataset(ctx.dataset_id)
    if not ds:
        return {"error": "dataset not found"}
    charter = ds.get("charter_snapshot") or {}
    gtype = args["gap_type"]
    targets = args["targets"]
    count = args.get("count", 2)
    if gtype == "coverage":
        generated, _ = await call_synthesize_examples(charter, coverage_criteria=targets, count=count)
    else:
        generated, _ = await call_synthesize_examples(charter, feature_areas=targets, count=count)
    for ex in generated:
        ex["source"] = "synthetic"
    created = await db.bulk_create_examples(ctx.dataset_id, generated)
    await db.update_dataset_stats(ctx.dataset_id)
    return {"ok": True, "generated": len(created)}


@tool(
    "export_dataset",
    "Export the current dataset as JSON for download. Confirms because the user explicitly chose to share data.",
    _confirm_schema(),
    tier="confirm",
)
async def _export_dataset(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.dataset_id:
        return {"error": "no dataset in context"}
    if not args.get("confirmed"):
        return _proposal(
            "export_dataset", args,
            label="Export dataset as JSON",
            reason="Generates a downloadable file with all approved examples.",
        )
    payload = await db.export_dataset(ctx.dataset_id)
    return {"ok": True, "n_examples": len(payload.get("examples", [])), "payload": payload}


# Eval/scorer/finalize aren't wired to backend handlers yet — they need the
# request-shaped payloads + access checks the existing endpoints carry.
# Until that lands, the confirmed-step navigates the user to the right place
# and tells the model that no action ran. This avoids the "I started the
# eval" hallucination that misleads users into waiting for a result that
# isn't coming.


# `run_eval` and `generate_scorers` both need session context that lives on
# the frontend (Braintrust key, run config, etc.). The tool can't reach those
# from the backend without plumbing headers all the way through ToolCtx. So
# the confirmed step emits a dedicated nav envelope that the frontend
# interprets as "open the tab AND fire its primary action with current
# config" — the same path the manual button click takes. The model is told
# the action is in flight so it doesn't tell the user to click anything.


@tool(
    "run_eval",
    "Start an eval run with the current project configuration. Confirms first because eval runs cost real money and time.",
    _confirm_schema(),
    tier="confirm",
)
async def _run_eval(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.session_id:
        return {"error": "no session in context"}
    if not args.get("confirmed"):
        return _proposal(
            "run_eval", args,
            label="Start an eval run",
            reason="Runs the eval against the current dataset + scorers + skill body. Costs LLM tokens and Braintrust API time.",
        )
    return {
        **_nav("eval_run_start", {}),
        "note": "Eval run started with the project's current config. The user can watch progress on the Evaluate tab.",
    }


@tool(
    "generate_scorers",
    "Draft scorers from the current charter. Costs LLM tokens; confirms first.",
    _confirm_schema(),
    tier="confirm",
)
async def _generate_scorers(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.session_id:
        return {"error": "no session in context"}
    if not args.get("confirmed"):
        return _proposal(
            "generate_scorers", args,
            label="Draft scorers from the charter",
            reason="Costs LLM tokens. Replaces existing scorer code — any manual edits will be lost.",
        )
    return {
        **_nav("scorers_generate", {}),
        "note": "Scorer-draft started. The user can review on the Scorers tab.",
    }


@tool(
    "analyze_eval_run",
    "Analyze an eval run for what to fix — runs the same 'Analyze' button on the Evaluate tab. "
    "If no run_id is given, defaults to the active run (or the latest done/failed one). "
    "Costs LLM tokens; confirms first.",
    _confirm_schema({
        "run_id": {
            "type": "string",
            "description": "Specific eval-run id. Omit to analyze the active/latest run.",
        },
    }),
    tier="confirm",
)
async def _analyze_eval_run(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.session_id:
        return {"error": "no session in context"}
    if not args.get("confirmed"):
        return _proposal(
            "analyze_eval_run", args,
            label="Analyze this eval run",
            reason="Runs the suggest-improvements pass over the run's failed rows. Costs LLM tokens.",
        )
    return {
        **_nav("eval_run_analyze", {"run_id": args.get("run_id")}),
        "note": "Analysis started — improvement suggestions will populate on the Evaluate tab.",
    }


@tool(
    "promote_skill_version",
    "Promote the candidate skill version to active. Irreversible without restoring the previous version manually.",
    _confirm_schema({
        "version_id": {
            "type": "string",
            "description": "Specific version id. Omit to promote the current candidate.",
        },
    }),
    tier="confirm",
)
async def _promote_skill_version(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.session_id:
        return {"error": "no session in context"}
    if not args.get("confirmed"):
        return _proposal(
            "promote_skill_version", args,
            label="Promote the candidate version",
            reason="The candidate becomes the active skill body. The previous active stays in history.",
        )
    return {
        **_nav("skill_version_promote", {"version_id": args.get("version_id")}),
        "note": "Promotion in flight.",
    }


@tool(
    "discard_skill_version",
    "Discard the candidate skill version so the active body stays. Reversible only by re-running the analyze + apply flow.",
    _confirm_schema({
        "version_id": {
            "type": "string",
            "description": "Specific version id. Omit to discard the current candidate.",
        },
    }),
    tier="confirm",
)
async def _discard_skill_version(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.session_id:
        return {"error": "no session in context"}
    if not args.get("confirmed"):
        return _proposal(
            "discard_skill_version", args,
            label="Discard the candidate version",
            reason="The candidate is removed and the active body stays as-is.",
        )
    return {
        **_nav("skill_version_discard", {"version_id": args.get("version_id")}),
        "note": "Discard in flight.",
    }


@tool(
    "cancel_eval_run",
    "Cancel an in-flight eval run.",
    _confirm_schema({
        "run_id": {"type": "string", "description": "Run id. Omit to cancel the active run."},
    }),
    tier="confirm",
)
async def _cancel_eval_run(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.session_id:
        return {"error": "no session in context"}
    if not args.get("confirmed"):
        return _proposal(
            "cancel_eval_run", args,
            label="Cancel the eval run",
            reason="In-flight rows stop; completed rows stay in history.",
        )
    return {
        **_nav("eval_run_cancel", {"run_id": args.get("run_id")}),
        "note": "Cancellation requested.",
    }


@tool(
    "finalize_charter",
    "Open the charter view so the user can lock the charter as final. Polaris does not finalize charters itself yet.",
    _confirm_schema(),
    tier="confirm",
)
async def _finalize_charter(ctx: ToolCtx, args: dict) -> dict:
    if not ctx.session_id:
        return {"error": "no session in context"}
    if not args.get("confirmed"):
        return _proposal(
            "finalize_charter", args,
            label="Open the charter view",
            reason="Polaris will jump you to the Charter tab; you finalize from there.",
        )
    return {
        **_nav("phase", {"phase": "charter"}),
        "note": "Navigated to charter tab. The user finalizes from there — Polaris did not execute it.",
    }


# ============================================================================
# NAV TOOLS — frontend-side effect only.
# ============================================================================


@tool(
    "nav_home",
    "Open the projects list (home page).",
    {"type": "object", "properties": {}, "additionalProperties": False},
    tier="nav",
)
async def _nav_home(ctx: ToolCtx, args: dict) -> dict:
    return _nav("home")


@tool(
    "nav_project",
    "Open a project workspace by id.",
    {"type": "object", "properties": {"session_id": {"type": "string"}}, "required": ["session_id"]},
    tier="nav",
)
async def _nav_project(ctx: ToolCtx, args: dict) -> dict:
    return _nav("project", {"session_id": args["session_id"]})


@tool(
    "nav_phase",
    "Switch the current workspace to a tab. Mirrors the in-app tabs exactly.",
    {
        "type": "object",
        "properties": {
            "phase": {
                "type": "string",
                "enum": ["skill", "goals", "users", "charter", "dataset", "scorers", "evaluate"],
            }
        },
        "required": ["phase"],
    },
    tier="nav",
)
async def _nav_phase(ctx: ToolCtx, args: dict) -> dict:
    return _nav("phase", {"phase": args["phase"]})


@tool(
    "nav_example",
    "Open the detail view for a specific example.",
    {"type": "object", "properties": {"example_id": {"type": "string"}}, "required": ["example_id"]},
    tier="nav",
)
async def _nav_example(ctx: ToolCtx, args: dict) -> dict:
    return _nav("example", {"example_id": args["example_id"]})


@tool(
    "nav_coverage_map",
    "Open the coverage map.",
    {"type": "object", "properties": {}, "additionalProperties": False},
    tier="nav",
)
async def _nav_coverage_map(ctx: ToolCtx, args: dict) -> dict:
    return _nav("coverage_map")


@tool(
    "nav_settings",
    "Open the settings drawer.",
    {"type": "object", "properties": {}, "additionalProperties": False},
    tier="nav",
)
async def _nav_settings(ctx: ToolCtx, args: dict) -> dict:
    return _nav("settings")


@tool(
    "nav_share",
    "Open the share-token modal for the current project.",
    {"type": "object", "properties": {}, "additionalProperties": False},
    tier="nav",
)
async def _nav_share(ctx: ToolCtx, args: dict) -> dict:
    return _nav("share")


@tool(
    "nav_eval_run",
    "Open a specific eval run by id.",
    {"type": "object", "properties": {"run_id": {"type": "string"}}, "required": ["run_id"]},
    tier="nav",
)
async def _nav_eval_run(ctx: ToolCtx, args: dict) -> dict:
    return _nav("eval_run", {"run_id": args["run_id"]})


@tool(
    "set_dataset_filter",
    "Apply filters to the dataset table in the UI (feature_area / label / review_status). "
    "Use this when the user asks to filter, narrow, or focus the list — DO NOT call list_examples for filtering. "
    "Pass an empty string for any field to clear it. Switches to the dataset tab as a side effect.",
    {
        "type": "object",
        "properties": {
            "feature_area": {"type": "string", "description": "Exact feature area name, or empty to clear."},
            "label": {"type": "string", "enum": ["", "good", "bad", "unlabeled"]},
            "review_status": {"type": "string", "enum": ["", "pending", "approved", "rejected", "needs_edit"]},
        },
        "additionalProperties": False,
    },
    tier="nav",
)
async def _set_dataset_filter(ctx: ToolCtx, args: dict) -> dict:
    # Only forward keys the user actually specified — undefined ones leave
    # the existing UI filter alone, while explicit "" means clear.
    props = {k: v for k, v in args.items() if k in {"feature_area", "label", "review_status"}}
    return _nav("dataset_filter", props)


# ============================================================================
# Tier lookup helper (used by the frontend rendering layer indirectly via the
# `_proposal` / `_nav` envelope conventions, but exposed here for completeness).
# ============================================================================


def get_tier(name: str) -> Optional[Tier]:
    td = REGISTRY.get(name)
    return td.tier if td else None
