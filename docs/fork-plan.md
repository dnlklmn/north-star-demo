# Fork plan — Shooting Star

> Companion to `docs/quick-demo-plan.md`. This is the precise recipe to lift the
> PRD → prod demo out of North Star and into its own fresh repo called
> **shooting-star**. Plan now, execute later.

## Product shape (locked)

A **single page**, no navigation, three states:

```
IDLE       → text box + "Build feature" + a few example PRDs to prime
BUILDING   → live checkmark list (✓ generated skill, ✓ … , ✓ Deployed)
              Improve loop rounds appear inline ("✓ Improved round 1: 3/4 → 4/4 pass")
DONE       → two panels side by side:
              ┌──────────────┐  ┌──────────────────────┐
              │  Try it      │  │  Observer            │
              │  (auto-form  │  │  recent calls, scores,
              │   from input │  │  traces, pass rate)  │
              │   schema)    │  │                      │
              └──────────────┘  └──────────────────────┘
```

Refresh = restart. Nothing persists. No projects, no tabs, no auth, no DB.

## Target repo structure

```
shooting-star/
├── README.md                  (new — the pitch + how to run)
├── .gitignore
├── docs/
│   ├── quick-demo-plan.md     (copy from north-star)
│   └── fork-plan.md           (this file)
├── backend/
│   ├── pyproject.toml         (new — minimal deps)
│   ├── .env.example
│   └── app/
│       ├── __init__.py
│       ├── main.py            (NEW, ~60 lines — see below)
│       ├── contracts.py       (copy verbatim)
│       ├── runner.py          (copy verbatim)
│       ├── runner_container_client.py
│       ├── orchestrator.py    (copy, then extend — see below)
│       ├── improve_loop.py    (copy verbatim)
│       ├── deploy.py          (copy verbatim)
│       ├── prod_log.py        (copy verbatim)
│       ├── llm.py             (NEW — extracted from tools.py)
│       ├── prompts.py         (NEW — extracted from prompt.py)
│       └── scorers/generated/.gitkeep
│   └── runner_container/      (copy entire dir, .gitignore handles node_modules)
└── frontend/
    ├── package.json           (new — minimal deps)
    ├── vite.config.ts
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── main.tsx           (new — minimal mount)
        ├── App.tsx            (NEW — single-page state machine)
        ├── api.ts             (NEW — minimal)
        ├── types.ts           (carry over the contract types only)
        ├── components/
        │   ├── PRDBox.tsx
        │   ├── BuildStream.tsx (NEW — checkmark list)
        │   ├── DeployPanel.tsx
        │   ├── ObserverPanel.tsx
        │   ├── ImproveLoopPanel.tsx
        │   ├── AgentTraceView.tsx
        │   ├── ApiKeyBanner.tsx (carry over, simplify)
        │   └── legibility/    (entire dir)
        └── lib/
            ├── inputSchemaForm.tsx
            └── useEventStream.ts
```

~30 source files, plus the runner_container.

## What to carry over (with absolute paths from north-star)

Copy verbatim — these are already correct:

| Source (north-star) | Destination (shooting-star) |
|---|---|
| `backend/app/contracts.py`            | `backend/app/contracts.py` |
| `backend/app/runner.py`               | `backend/app/runner.py` |
| `backend/app/runner_container_client.py` | `backend/app/runner_container_client.py` |
| `backend/app/orchestrator.py`         | `backend/app/orchestrator.py` (then extend, see below) |
| `backend/app/improve_loop.py`         | `backend/app/improve_loop.py` |
| `backend/app/deploy.py`               | `backend/app/deploy.py` |
| `backend/app/prod_log.py`             | `backend/app/prod_log.py` |
| `backend/runner_container/`           | `backend/runner_container/` (exclude `node_modules`) |
| `frontend/src/components/PRDBox.tsx`  | `frontend/src/components/PRDBox.tsx` |
| `frontend/src/components/DeployPanel.tsx`     | same |
| `frontend/src/components/ObserverPanel.tsx`   | same |
| `frontend/src/components/ImproveLoopPanel.tsx`| same |
| `frontend/src/components/AgentTraceView.tsx`  | same |
| `frontend/src/components/legibility/`         | same (entire dir) |
| `frontend/src/lib/inputSchemaForm.tsx` | same |
| `frontend/src/lib/useEventStream.ts`   | same |
| `frontend/src/components/ApiKeyBanner.tsx` | same (simplify) |
| `docs/quick-demo-plan.md`             | `docs/quick-demo-plan.md` |

Carry the **PRD-pipeline contract block only** from `frontend/src/types.ts`
(lines roughly 528–635 — InputSchema, FeatureTrace, RunFeatureRequest/Result,
LoopConfig, LoopRoundEvent, ScorerResult, ProdLogRecord). Skip the rest of
that file (it's the original app's session/state types).

## What does NOT carry over

The whole existing app: every file in `backend/app/` not listed above (db,
sharing, quota, feature_flags, agent.py, eval_runner.py, scorer_publish.py,
prompt_eval.py, polaris_tools, 4000-line `main.py`, all the DB migration
code…). Every page/component on the frontend except the demo ones. The
entire conversational-discovery / charter-discovery / dataset-chat UX.

## Files to write fresh

### `backend/app/main.py` (~60 lines, replaces north-star's ~4000)

```python
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from .llm import set_request_api_key
from .orchestrator import router as orchestrator_router
from . import improve_loop, deploy as deploy_module, prod_log
import asyncio as _asyncio


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield  # nothing to init — pure in-memory


app = FastAPI(title="Shooting Star", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5000"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ApiKeyMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        key = request.headers.get("x-anthropic-key")
        set_request_api_key(key or None)
        return await call_next(request)


app.add_middleware(ApiKeyMiddleware)

app.include_router(orchestrator_router)
app.include_router(improve_loop.router)
app.include_router(deploy_module.router)
app.include_router(prod_log.router)


# deploy → prod_log: deploy's hook is sync, post_prod_log is async; schedule it.
def _deploy_to_prod_log(record):
    _asyncio.create_task(prod_log.post_prod_log(record))


deploy_module.register_prod_logger(_deploy_to_prod_log)


@app.get("/health")
async def health():
    return {
        "ok": True,
        "runner": os.environ.get("RUNNER_BACKEND", "inprocess"),
    }
```

That's the whole backend entry point. No DB, no auth, no quota, no sharing,
no Braintrust, no Polaris.

### `backend/app/llm.py` — extracted from `tools.py`

Carry over **only** what the four demo modules and prompts need:
- `get_client`, `get_model`, `_resolve_model`, `_is_openrouter_key`
- `set_request_api_key` + the `_request_api_key` contextvar
- The `_call_llm*` helpers actually used
- These call_*'s that orchestrator and friends import:
  - `call_generate_skill_from_goals`
  - `call_generate_scorers`
  - `call_synthesize_examples`
  - (whatever the prod_log judge uses — likely a small `judge_score` helper)

Easiest approach: copy `tools.py` as-is, rename to `llm.py`, then in a focused
follow-up delete every function/import that has zero references inside
shooting-star. Expect to drop ~60% of lines. Don't optimize prematurely
during the lift.

### `backend/app/prompts.py` — extracted from `prompt.py`

Same story: copy `prompt.py` as-is, rename to `prompts.py`, then strip the
prompt functions not used by the demo's LLM call wrappers. The conversational
discovery prompts and charter-validation prompts can all go.

### `backend/pyproject.toml` — minimal deps

```toml
[project]
name = "shooting-star-backend"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "fastapi",
  "uvicorn[standard]",
  "anthropic",
  "pydantic>=2",
  "python-dotenv",
]
```

No asyncpg, no braintrust, no sharing-related deps. Compare to north-star's
`pyproject.toml` and drop everything that isn't needed.

### `frontend/src/App.tsx` — single-page state machine

```tsx
import { useState } from 'react'
import PRDBox from './components/PRDBox'
import BuildStream from './components/BuildStream'
import { DeployPanel } from './components/DeployPanel'
import ObserverPanel from './components/ObserverPanel'
import ApiKeyBanner from './components/ApiKeyBanner'
import type { InputSchema, DeploymentInfo } from './types'

type DemoState =
  | { phase: 'idle' }
  | { phase: 'building'; prd: string }
  | {
      phase: 'done'
      skillId: string
      skillBody: string
      inputSchema: InputSchema
      scorers: string[]
      deployment: DeploymentInfo
    }

export default function App() {
  const [state, setState] = useState<DemoState>({ phase: 'idle' })

  return (
    <div className="min-h-screen bg-background text-foreground">
      <ApiKeyBanner />
      <main className="max-w-4xl mx-auto p-6">
        {state.phase === 'idle' && (
          <PRDBox
            // PRDBox triggers the stream; we just need the PRD text to
            // hand to BuildStream which owns the SSE connection.
            onSubmit={(prd) => setState({ phase: 'building', prd })}
          />
        )}

        {state.phase === 'building' && (
          <BuildStream
            prd={state.prd}
            onDone={(payload) => setState({ phase: 'done', ...payload })}
          />
        )}

        {state.phase === 'done' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <DeployPanel
              skillId={state.skillId}
              skillBody={state.skillBody}
              inputSchema={state.inputSchema}
              scorers={state.scorers}
              // The orchestrator already deployed — show the URL, skip the deploy button
              initialDeployment={state.deployment}
            />
            <ObserverPanel skillId={state.skillId} />
          </div>
        )}
      </main>
    </div>
  )
}
```

No `react-router-dom` (one page, no routes). PRDBox needs a small change:
add an `onSubmit(prd)` prop and let `BuildStream` own the SSE connection.

### `frontend/src/components/BuildStream.tsx` — NEW

Owns the SSE connection to `/orchestrate-build`, renders a vertical list of
checkmarks. Each event is one line: stage label + tick + optional detail
(scorer pass-rate, round number, etc.). When the stream emits the final
`done` event with the deployment payload, calls `onDone()` to flip App to
the DONE state.

Reuses `useEventStream` from `lib/`.

Props:
```tsx
interface Props {
  prd: string
  onDone: (payload: {
    skillId: string
    skillBody: string
    inputSchema: InputSchema
    scorers: string[]
    deployment: DeploymentInfo
  }) => void
}
```

This is the only **new** frontend component. Everything else carries over.

## Orchestrator changes needed (the auto-improve + auto-deploy chain)

Today the orchestrator streams `init → seed → skill → dataset → scorers →
evaluate → done`. For the new UX it needs to **also** chain the improve loop
and the deploy step:

```
init
  ↓
skill           (call_generate_skill_from_goals)
seed            (lightweight — fill input_schema, dimensions)
dataset         (call_synthesize_examples)
scorers         (call_generate_scorers — writes scorers/generated/skill__<id>/)
evaluate        (call run_feature on every dataset row, score with scorers, compute pass rate)
                if every scorer ≥ 0.75 → skip to deploy
                else → enter improve loop
improve_round_1 \
improve_round_2  } emit LoopRoundEvent stream from improve_loop.run_loop(...)
…                /
deploy          (call deploy.deploy_skill() with the skill_id + input_schema + scorers)
done            payload: { skill_id, skill_body, input_schema, scorers, deployment }
```

Each event is shaped `{stage, status, detail, payload?}` — BuildStream
renders it as a checkmark line. The improve-loop rounds reuse the existing
LoopRoundEvent (just re-emit it as `{stage: 'improve_round', detail: ...}`).

The "evaluate" stage today is mocked; replace it with a real loop calling
`runner.run_feature(...)` against each dataset row and the generated
scorers. (Track 3's `_default_run_eval` mock is okay as a *fallback* if no
API key, so the demo can run dry.)

When the final pass condition is met, orchestrator calls deploy and embeds
the resulting `DeploymentInfo` in the final `done` event so the frontend can
flip to DONE without a second round-trip.

## Step-by-step execution (when you do the lift)

1. `gh repo create shooting-star --private --clone` (or however you create it)
2. `cd shooting-star`
3. Make the directory skeleton above (`mkdir -p backend/app frontend/src/{components,lib}`)
4. Copy the files in the table above with `cp` from north-star (absolute paths).
5. Write the fresh files: `backend/app/main.py`, `frontend/src/App.tsx`,
   `frontend/src/components/BuildStream.tsx`, `frontend/src/main.tsx`,
   `frontend/{package.json,vite.config.ts,tsconfig.json,index.html}`,
   `backend/pyproject.toml`, `.env.example`, `.gitignore`, `README.md`.
6. Rename `tools.py → llm.py`, `prompt.py → prompts.py` (full copies first,
   trim later).
7. Update all imports in the copied modules: `from .tools import …` →
   `from .llm import …`, `from .prompt import …` → `from .prompts import …`.
8. Update orchestrator to chain improve + deploy as described above.
9. Smoke: `RUNNER_BACKEND=mock` uvicorn + `npm run dev`, paste a PRD, watch
   it run end-to-end.
10. Iterate: trim llm.py and prompts.py to drop unused functions; replace
    the mock evaluate with real `run_feature`; bind `improve_loop.set_deps`.

## Decisions (locked)

### 1. Server-side default key with a hard spend cap

No `X-Anthropic-Key` header from the browser, no `ApiKeyBanner`. Backend reads
`ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` from env (with the existing
`tools.get_client()` precedence — Anthropic wins when both are set, OpenRouter
otherwise). One key, paid by you.

**This makes a spend cap mandatory, not optional** — without it, anyone with the
URL drains the key. Sketch:

```python
# backend/app/cap.py — in-memory spend cap, enforced before every LLM call.
import os
from collections import defaultdict
from time import monotonic
from threading import Lock

# Limits are USD-equivalents, modeled in tokens for simplicity. Two windows
# stacked: a generous daily wall and a tight per-session wall so one user
# can't burn the whole day. Tune in env.
DAILY_TOKEN_CAP    = int(os.environ.get("SS_DAILY_TOKEN_CAP",    "5000000"))
SESSION_TOKEN_CAP  = int(os.environ.get("SS_SESSION_TOKEN_CAP",  "500000"))
DAY_SECONDS = 86400

_lock = Lock()
_daily = {"window_started": monotonic(), "tokens": 0}
_per_session: dict[str, int] = defaultdict(int)


class CapExceeded(Exception):
    pass


def check_and_charge(session_id: str, tokens: int) -> None:
    """Raise CapExceeded if this call would breach a cap. Otherwise charge it."""
    with _lock:
        # Roll the daily window
        if monotonic() - _daily["window_started"] > DAY_SECONDS:
            _daily["window_started"] = monotonic()
            _daily["tokens"] = 0
        if _daily["tokens"] + tokens > DAILY_TOKEN_CAP:
            raise CapExceeded(f"daily cap hit ({DAILY_TOKEN_CAP} tokens)")
        if _per_session[session_id] + tokens > SESSION_TOKEN_CAP:
            raise CapExceeded(f"session cap hit ({SESSION_TOKEN_CAP} tokens)")
        _daily["tokens"] += tokens
        _per_session[session_id] += tokens


def remaining(session_id: str) -> dict[str, int]:
    with _lock:
        return {
            "daily": max(0, DAILY_TOKEN_CAP - _daily["tokens"]),
            "session": max(0, SESSION_TOKEN_CAP - _per_session[session_id]),
        }
```

Wire it into `llm.py`'s `_call_llm*` helpers: **estimate** input tokens before
the call (rough char-count → tokens), call `check_and_charge` with the
estimate, then **reconcile** with the actual response.usage after. Reject with
HTTP 429 + a clear message ("daily demo budget reached — try again tomorrow").

Surface remaining quota via `/health` for debugging:
```python
@app.get("/health")
async def health():
    return {"ok": True, "cap": cap.remaining("global")}
```

For the demo's volume, in-memory is fine. Persistence is a follow-up if you
want the cap to survive restarts.

### 2. Inprocess runner first, container later

Ship shooting-star v1 with `RUNNER_BACKEND=inprocess` (single-shot
`messages.create`). It works for any text/JSON-in-text-out skill — which is
~all PRD examples a coworker would paste. The container backend exists and
the seam is already there (`runner.py::_run_container`), so flipping later is
a single env-var change + `docker compose up --build`, no code reshape.

**The honest trade-off:** v1 can't truly demonstrate file/tool-using skills.
A PRD like "summarize this PDF" will run, but the generated skill will hit
the single-shot path and just *say* "I'd parse the PDF and…" without
actually doing it. Two ways to handle this:
- (a) Lean in: a one-line note in BuildStream when the generated skill
  declares tools — *"this skill wants to use tools; flip RUNNER_BACKEND to
  container to run it end-to-end"*. Honest, no surprise.
- (b) Restrict the PRD examples shown in the textbox to text-in/text-out
  flavors, so the demo always lands cleanly.

Recommend **(a)**. The container backend's effort is real — Dockerfile is
written and unverified, the host needs a daemon, and per-feature isolation
adds operational weight — so deferring it to a focused follow-up keeps v1
shippable. The seam means there's no v1→v2 rebuild penalty.

### 3. Share link = unguessable URL + spend cap as the safety net

Today's deploy URL is `/deployed/{skill_id}`. Make `skill_id` a UUID at
deploy time (not a slug) — unguessable. Then anyone with the URL can run the
feature; the spend cap from #1 is what stops abuse.

For the "coworker can try it" case, this is enough: paste the URL into Slack
and they can try. No login, no friction.

**When you need real public sharing later**, the minimal upgrade is two
things, no architecture change:
- A per-deployment expiry (`expires_at` on `DeploymentRecord`, return 410 Gone
  when stale).
- An optional `owner_token` cookie set when the *creator* deploys, so the
  creator can re-deploy / delete without auth, but visitors can only run.

Both are 50-line additions to `deploy.py`. Doing them now is premature — UUID
+ spend cap is already enough for the coworker case.
