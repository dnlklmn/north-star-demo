"""Deploy — turn a built feature into a live URL.

After a feature passes the self-improvement loop the user gets a real URL
that serves an input form auto-generated from the seed's ``input_schema``.
Form submissions hit ``runner.run_feature`` and the result (output + trace +
scorer results) comes back to the page.

The same handler also logs every prod call so Track 5's observer can
display traces + scorer results alongside the in-app evaluate rows.

Endpoints exposed via :data:`router` (mount on the main app):

- ``POST /api/deploy/{skill_id}``           — register a feature for deployment
- ``GET  /api/deploy/{skill_id}``           — retrieve the deployment record
- ``GET  /api/deploy``                      — list all deployments (debug)
- ``GET  /deployed/{skill_id}``             — minimal HTML page with a form
- ``POST /api/deployed/{skill_id}/run``     — run the deployed feature

Storage is an in-memory dict — fine for the demo, swap for the DB later.
"""
from __future__ import annotations

import html
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import contracts as c
from . import runner

router = APIRouter()


# ---------------------------------------------------------------------------
# Storage — in-memory for the demo.
# ---------------------------------------------------------------------------


class DeploymentRecord(BaseModel):
    """Everything needed to run + score a deployed feature.

    Captures the *exact* skill body and scorer set at deploy time so the
    live URL stays stable even if the user keeps iterating in the app.
    """

    skill_id: str
    skill_body: str
    input_schema: c.InputSchema = Field(default_factory=c.InputSchema)
    scorers: list[str] = Field(default_factory=list)  # scorer names
    model: Optional[str] = None
    mode: c.RunMode = c.RunMode.agent
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    title: Optional[str] = None  # display name on the deployed page


_DEPLOYMENTS: dict[str, DeploymentRecord] = {}
# Fallback prod log used when no external logger has been wired in.
_LOCAL_PROD_LOG: list[c.ProdLogRecord] = []


# A pluggable hook so Track 5's observer can capture prod calls without us
# importing it (and vice versa). Track 5 registers itself via
# :func:`register_prod_logger`; until then we fall back to ``_LOCAL_PROD_LOG``.
ProdLogger = Callable[[c.ProdLogRecord], None]
_prod_logger: Optional[ProdLogger] = None


def register_prod_logger(fn: Optional[ProdLogger]) -> None:
    """Wire a sink for prod-log records. Pass ``None`` to clear (tests)."""
    global _prod_logger
    _prod_logger = fn


def _log_prod_call(rec: c.ProdLogRecord) -> None:
    if _prod_logger is not None:
        try:
            _prod_logger(rec)
            return
        except Exception:  # noqa: BLE001 — fallback to local log on logger failure
            pass
    _LOCAL_PROD_LOG.append(rec)


def get_local_prod_log() -> list[c.ProdLogRecord]:
    """Test/debug accessor — the fallback in-memory log."""
    return list(_LOCAL_PROD_LOG)


def get_deployment(skill_id: str) -> Optional[DeploymentRecord]:
    return _DEPLOYMENTS.get(skill_id)


# ---------------------------------------------------------------------------
# Request / response models for the management endpoints.
# ---------------------------------------------------------------------------


class DeployRequest(BaseModel):
    skill_body: str
    input_schema: c.InputSchema = Field(default_factory=c.InputSchema)
    scorers: list[str] = Field(default_factory=list)
    model: Optional[str] = None
    mode: c.RunMode = c.RunMode.agent
    title: Optional[str] = None


class DeployResponse(BaseModel):
    skill_id: str
    url: str           # absolute URL to the deployed page
    api_url: str       # absolute URL clients POST to
    created_at: str


class RunDeployedResponse(BaseModel):
    output: str
    trace: c.Trace
    error: Optional[str] = None
    scoring_pending: bool = True
    log_id: str


# ---------------------------------------------------------------------------
# Form rendering — InputSchema -> minimal HTML form.
# Exported separately so unit tests can assert on the generated markup.
# ---------------------------------------------------------------------------


def render_input_form(schema: c.InputSchema, action: str) -> str:
    """Return a fragment of HTML (a <form>) that matches ``schema``.

    One control per field, in declared order. JSON / file / image inputs get
    typed controls so a future Track 4 follow-up can wire an artifact-upload
    endpoint without changing the form contract.
    """
    parts: list[str] = [
        f'<form id="run-form" method="post" action="{html.escape(action)}" '
        'enctype="multipart/form-data">'
    ]
    for field in schema.fields:
        parts.append(_render_field(field))
    parts.append('<button type="submit">Run</button>')
    parts.append("</form>")
    return "\n".join(parts)


def _render_field(field: c.InputField) -> str:
    name = html.escape(field.name)
    desc = html.escape(field.description or "")
    required = " required" if field.required else ""
    label = (
        f'<label for="f-{name}"><strong>{name}</strong>'
        + (f' <span class="desc">{desc}</span>' if desc else "")
        + "</label>"
    )

    t = field.type
    control: str
    if t == c.InputFieldType.text:
        control = f'<input id="f-{name}" name="{name}" type="text"{required} />'
    elif t == c.InputFieldType.longtext:
        control = f'<textarea id="f-{name}" name="{name}" rows="6"{required}></textarea>'
    elif t == c.InputFieldType.number:
        control = (
            f'<input id="f-{name}" name="{name}" type="number" step="any"{required} />'
        )
    elif t == c.InputFieldType.boolean:
        control = f'<input id="f-{name}" name="{name}" type="checkbox" value="true" />'
    elif t == c.InputFieldType.enum:
        opts = "".join(
            f'<option value="{html.escape(v)}">{html.escape(v)}</option>'
            for v in field.enum
        )
        control = (
            f'<select id="f-{name}" name="{name}"{required}>'
            + ('<option value="">--</option>' if not field.required else "")
            + opts
            + "</select>"
        )
    elif t == c.InputFieldType.json:
        control = (
            f'<textarea id="f-{name}" name="{name}" rows="4" '
            f'placeholder="JSON value"{required}></textarea>'
        )
    elif t in (c.InputFieldType.file, c.InputFieldType.image):
        accept = ""
        if field.mime:
            accept = f' accept="{html.escape(field.mime)}"'
        elif t == c.InputFieldType.image:
            accept = ' accept="image/*"'
        control = f'<input id="f-{name}" name="{name}" type="file"{accept}{required} />'
    else:  # pragma: no cover — exhaustive on the enum
        control = f'<input id="f-{name}" name="{name}" type="text"{required} />'

    return f'<div class="field">{label}<div class="control">{control}</div></div>'


def _render_page(dep: DeploymentRecord, action: str) -> str:
    title = html.escape(dep.title or f"Feature: {dep.skill_id}")
    form = render_input_form(dep.input_schema, action)
    # Inline JS intercepts the form submit, POSTs JSON to the run endpoint,
    # and renders the result without leaving the page. Keep it dependency-free.
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>{title}</title>
<style>
  body {{ font-family: ui-sans-serif, system-ui, sans-serif; max-width: 720px;
          margin: 2rem auto; padding: 0 1rem; color: #111; }}
  h1 {{ font-size: 1.25rem; }}
  .field {{ margin-bottom: 1rem; }}
  .field label {{ display: block; margin-bottom: 0.25rem; }}
  .desc {{ color: #666; font-weight: normal; font-size: 0.9em; }}
  input[type=text], input[type=number], textarea, select {{
      width: 100%; box-sizing: border-box; padding: 0.5rem;
      border: 1px solid #ccc; border-radius: 6px; font: inherit;
  }}
  button {{ background: #111; color: #fff; border: none; padding: 0.6rem 1rem;
            border-radius: 6px; font: inherit; cursor: pointer; }}
  #result {{ margin-top: 1.5rem; padding: 1rem; border: 1px solid #eee;
              border-radius: 8px; white-space: pre-wrap; }}
  #result.error {{ border-color: #d33; background: #fff5f5; }}
  .meta {{ color: #666; font-size: 0.85em; margin-top: 0.5rem; }}
</style>
</head>
<body>
<h1>{title}</h1>
<p class="meta">Deployed feature. Submissions are scored and logged.</p>
{form}
<div id="result" hidden></div>
<script>
  const form = document.getElementById('run-form');
  const result = document.getElementById('result');
  form.addEventListener('submit', async (ev) => {{
    ev.preventDefault();
    result.hidden = false;
    result.classList.remove('error');
    result.textContent = 'Running...';
    const fd = new FormData(form);
    const input = {{}};
    for (const [k, v] of fd.entries()) {{
      if (v instanceof File) {{
        // For the demo we stub the artifact ref. A real upload endpoint
        // would replace this with a server-issued locator.
        input[k] = {{ type: 'file', mime: v.type || 'application/octet-stream',
                      ref: 'pending:' + v.name, filename: v.name }};
      }} else {{
        input[k] = v;
      }}
    }}
    try {{
      const resp = await fetch('{html.escape(action)}', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ input }}),
      }});
      const data = await resp.json();
      if (data.error) {{
        result.classList.add('error');
        result.textContent = 'Error: ' + data.error;
        return;
      }}
      result.textContent = data.output || '(empty output)';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = 'log id: ' + (data.log_id || '-')
        + (data.scoring_pending ? ' • scoring in progress…' : '');
      result.appendChild(meta);
    }} catch (e) {{
      result.classList.add('error');
      result.textContent = 'Network error: ' + e;
    }}
  }});
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# Endpoints.
# ---------------------------------------------------------------------------


def _absolute_url(request: Request, path: str) -> str:
    """Build a URL safe to share. Honors forwarded headers if the app is
    fronted by a proxy in production; falls back to the request's host."""
    base = str(request.base_url).rstrip("/")
    return f"{base}{path}"


@router.post("/api/deploy/{skill_id}", response_model=DeployResponse)
async def deploy_skill(skill_id: str, body: DeployRequest, request: Request) -> DeployResponse:
    rec = DeploymentRecord(
        skill_id=skill_id,
        skill_body=body.skill_body,
        input_schema=body.input_schema,
        scorers=body.scorers,
        model=body.model,
        mode=body.mode,
        title=body.title,
    )
    _DEPLOYMENTS[skill_id] = rec
    return DeployResponse(
        skill_id=skill_id,
        url=_absolute_url(request, f"/deployed/{skill_id}"),
        api_url=_absolute_url(request, f"/api/deployed/{skill_id}/run"),
        created_at=rec.created_at,
    )


@router.get("/api/deploy/{skill_id}", response_model=DeploymentRecord)
async def get_deploy(skill_id: str) -> DeploymentRecord:
    rec = _DEPLOYMENTS.get(skill_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="not deployed")
    return rec


@router.get("/api/deploy")
async def list_deploys() -> dict[str, Any]:
    return {
        "deployments": [
            {"skill_id": d.skill_id, "title": d.title, "created_at": d.created_at}
            for d in _DEPLOYMENTS.values()
        ]
    }


@router.get("/deployed/{skill_id}")
async def deployed_page(skill_id: str, request: Request) -> Any:
    from fastapi.responses import HTMLResponse

    dep = _DEPLOYMENTS.get(skill_id)
    if dep is None:
        return HTMLResponse(
            f"<h1>Not deployed</h1><p>No deployment for skill <code>"
            f"{html.escape(skill_id)}</code>.</p>",
            status_code=404,
        )
    action = f"/api/deployed/{skill_id}/run"
    return HTMLResponse(_render_page(dep, action))


class _RunBody(BaseModel):
    input: c.FeatureInput


@router.post("/api/deployed/{skill_id}/run", response_model=RunDeployedResponse)
async def run_deployed(skill_id: str, body: _RunBody) -> RunDeployedResponse:
    dep = _DEPLOYMENTS.get(skill_id)
    if dep is None:
        raise HTTPException(status_code=404, detail="not deployed")

    # Normalize: if schema is single-text-field and we got a dict with one
    # entry, also accept a bare string — but the form always sends a dict,
    # so this is mostly defensive for API clients.
    feature_input = body.input
    if (
        dep.input_schema.is_single_text
        and isinstance(feature_input, dict)
        and len(feature_input) == 1
    ):
        only_val = next(iter(feature_input.values()))
        if isinstance(only_val, str):
            feature_input = only_val

    req = c.RunFeatureRequest(
        skill_id=dep.skill_id,
        skill_body=dep.skill_body,
        input_schema=dep.input_schema,
        input=feature_input,
        mode=dep.mode,
        model=dep.model,
    )
    started = time.monotonic()
    result = runner.run_feature(req)
    latency_ms = int((time.monotonic() - started) * 1000)

    log_id = uuid.uuid4().hex
    rec = c.ProdLogRecord(
        id=log_id,
        skill_id=dep.skill_id,
        input=feature_input,
        output=result.output,
        trace=result.trace,
        scores=[c.ScorerResult(scorer=s, score=None) for s in dep.scorers],
        latency_ms=latency_ms,
        error=result.error,
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    _log_prod_call(rec)

    return RunDeployedResponse(
        output=result.output,
        trace=result.trace,
        error=result.error,
        scoring_pending=bool(dep.scorers),
        log_id=log_id,
    )


# ---------------------------------------------------------------------------
# Test helpers — keep imports light; only used by tests / dev tools.
# ---------------------------------------------------------------------------


def _reset_for_tests() -> None:
    _DEPLOYMENTS.clear()
    _LOCAL_PROD_LOG.clear()
    register_prod_logger(None)
