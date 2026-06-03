# RunFeature container

A small HTTP service that wraps the Claude Agent / Anthropic SDK and exposes a
single endpoint, `POST /run-feature`, matching the
`RunFeatureRequest` / `RunFeatureResult` contracts in `backend/app/contracts.py`.

This unlocks the "any skill" promise: instead of the 4-tool hardcoded in-process
loop in `backend/app/agent_task.py`, run features inside a sandboxed container
with full filesystem + optional bash, and a frozen Trace shape that the existing
Evaluate UI already knows how to render.

## What's inside

- `server.ts` — Node 20 HTTP server. Drives a manual Anthropic-SDK tool-use
  loop and produces a `Trace` matching `backend/app/contracts.py:Trace`.
- `Dockerfile` — Node + Python base. Python is included for skills that shell
  out to docx/xlsx/pdf tooling.
- `docker-compose.yml` — one-liner local stack on port 8088.
- (no source for `@anthropic-ai/claude-agent-sdk` is required — see below.)

## SDK choice

The package described as "Claude Agent SDK" is `@anthropic-ai/claude-agent-sdk`.
It is listed as an optional dependency in `package.json`; the runtime uses
whichever Anthropic client is installed. To minimize blast radius and keep
trace capture explicit, **this build drives the loop manually using the public
`@anthropic-ai/sdk`** — every `tool_use` / `tool_result` pair is intercepted
and written into `trace.tool_calls[]`. If you'd rather hand control to the
Agent SDK's `query()` helper, swap `runAgent()` in `server.ts` — the wire
contract is unchanged.

## Build and run

```bash
# from repo root
docker compose -f backend/runner_container/docker-compose.yml up --build
```

Or without compose:

```bash
cd backend/runner_container
docker build -t northstar/runner-container:dev .
docker run --rm -p 8088:8088 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  northstar/runner-container:dev
```

## Environment variables

| Variable            | Default                       | Purpose                                                |
|---------------------|-------------------------------|--------------------------------------------------------|
| `ANTHROPIC_API_KEY` | (required)                    | Claude API key for the inner agent.                    |
| `MODEL_NAME`        | `claude-sonnet-4-20250514`    | Default model when the request doesn't pin one.        |
| `PORT`              | `8088`                        | HTTP port.                                             |
| `HOST`              | `0.0.0.0`                     | Bind address.                                          |

## Wiring it into the backend

Set both env vars on the FastAPI process:

```bash
export RUNNER_BACKEND=container
export CONTAINER_URL=http://localhost:8088
```

`backend/app/runner.py:_run_container` calls
`backend/app/runner_container_client.invoke(req)` when `CONTAINER_URL` is set.

## Endpoint

`POST /run-feature` — body is a JSON `RunFeatureRequest`, response is a JSON
`RunFeatureResult`. Both shapes are listed near the top of `server.ts` and
mirror the Pydantic models in `backend/app/contracts.py`.

`GET /health` — `{ "ok": true, "model": "..." }`.

## Trace mapping contract

Every `RunFeatureResult.trace` returned by this service satisfies the
*frozen* keys required by the frontend `AgentRowMetadata` (see
`frontend/src/types.ts`): `tool_calls`, `artifacts`, `iterations`,
`stop_reason`, `halted`, `workspace`. Additive UI-optional keys
(`final_text`, `model`, `input_tokens`, `output_tokens`, `latency_ms`) are
also populated when known. The Python client validates each response with
`Trace.model_validate` before returning it.
