# Quick Demo Plan — PRD → Feature in Prod

> Status: **draft for discussion** (2026-06-02). Captures decisions made while planning the
> stripped-down preview demo. Intended to survive the eventual fork.

## Goal

Show the whole pipeline end to end: **a person writes what they want their AI feature to do (a PRD),
clicks one button, and ends up with a real, running, evaluated feature behind a live link.**

Non-negotiable: it must work for **any skill the user can describe**, not a fixed set of types.
If it only works for a couple of skill types, we'd have to constrain what PRDs people can submit —
which kills the premise.

## Cross-cutting product principle: always show what's happening

At every step — generation, eval runs, and especially the self-improvement loop — the user must
**always see a hint of what's going on**. Never a blank spinner. This is not just demo polish; it is
the product's engagement and monetization engine:

- Visible progress (what changed, why, the pass-rate moving) is what makes people **want to keep
  improving their prompt** instead of stopping at "good enough."
- That desire to keep iterating is what they pay for. The loop running behind an opaque spinner
  converts once; a loop you can *watch get better* invites the next iteration.

Treat "is this step legible to the user?" as a requirement on every feature below, not a nice-to-have.

---

## The one architectural decision everything hangs on

The current feature-execution path is a hand-rolled mini-agent with a **fixed, hand-coded toolset**
(`agent_task.py:387` — read/write/edit/list_dir + optional bash, text-only I/O, sandboxed paths,
sync in a FastAPI thread). SKILL.md is **pasted as a system prompt**, never executed as a real skill
(`eval_runner.py:450`). Adding capability today = hand-adding another tool. That never reaches
"works with any skill."

**Decision: replace the executor with the Claude Agent SDK running inside a container.** This gives
real SKILL.md execution, the full tool suite + MCP + any modality for free, and isolation for running
arbitrary *generated* skills safely. The objections noted in `agent_task.py:24` (Node dependency,
async-only, in-process threading) all dissolve once execution moves **out of process into the
container** — FastAPI just dispatches a job and reads back the result.

### The seam

Everything talks to one interface; the backend can evolve without touching the UI:

```
RunFeature(input conforming to the seed's input schema) -> { output, trace }
```

- **One runner, two callers.** The Evaluate step and the Deploy step both call `RunFeature`.
  What you evaluated is exactly what you ship.
- **The container is also the live link.** Expose the runner as a long-lived HTTP service; that
  service *is* the deployed feature and the shareable URL.
- **Flexibility + container + live link are a single decision**, not three. You can't have
  "any skill" *and* safe in-process execution — arbitrary generated bash/fs/network on the host is a
  security problem. Flexibility forces isolation; isolation is the container; the container is the link.

---

## Build order

### Phase 0 — The flexible runner (the spine, build first)

- Container image: Node + Claude Code / Claude Agent SDK + Python (for skills that need it).
- Long-lived service exposing `RunFeature(input) -> {output, trace}`.
- Generated SKILL.md (+ any bundled files) mounted/copied in; agent runs with the full default
  toolset; **use the SDK's own message/tool-call stream as the trace** (map it to the shape
  `EvaluatePanel.tsx` already renders — don't reimplement `agent_task.py`'s capture).
- **Input schema gap:** dataset `input` is always a `string` today (`models.py:362`). For binary-input
  skills (pdf/docx *in*), inputs must become artifact references (path / URL / base64), and the seed's
  input schema drives both the dataset rows and the deploy input form. Decide the artifact convention here.
- Rewire the Evaluate step to call `RunFeature` instead of the in-process loop.

### Phase 1 — PRD box → MVP build (orchestrate what exists)

One text box + a few example PRDs to prime it. "Build feature" chains existing endpoints with progress UI:

1. seed Goals from the PRD → `generate_skill_from_goals` (`main.py:540`)
2. Seed / input schema (the "charter": task I/O + coverage/balance/alignment)
3. `create_dataset` (`main.py:2524`) — synth examples
4. `generate_scorers_endpoint` (`main.py:1633`) — writes scorers to `scorers/generated/skill__<id>/`
5. `run_eval` (`main.py:3721`) — now executing through `RunFeature`

This phase is **orchestration, not new capability** — each tab already has an endpoint.

### Phase 2 — Run + the self-improvement loop (the centerpiece)

This is the magic of the demo — "it improves itself until it's good enough to deploy" — and the
thing that earns the "comfortable to deploy to production" claim. Keep it; don't cut it. But it has
to be **bounded, watchable, and honest.**

- **Base run + results view** largely exists (`analyze_gaps` `main.py:3152`, `judge_agreement`
  `main.py:3253`).
- **The loop:** run evals → analyze failures → improve → re-run, until the pass bar is met.
- **Bound it:** hard cap on rounds (~3–5) + a timeout, so it always terminates with something to show.
- **Watchable, not a spinner** (see the cross-cutting principle): each round surfaces *what it changed*,
  *why*, and the *pass-rate delta*. The watching is the engagement hook, not overhead.
- **Optimize the feature, not the measure.** The loop must improve the **skill/feature** and treat the
  scorers + charter as (mostly) fixed ground truth. If it can edit scorers to pass, it will game them
  (Goodhart) and the green checkmark becomes meaningless — fatal when the output is "deploy to prod."
- **Define "passes" precisely.** "Everything passes 75%" should mean **every individual scorer ≥ 75%**,
  not a 75% aggregate. Per-scorer is harder to game and is what makes "ready to deploy" trustworthy.
- **Pre-bake a fallback run** for live demos (belt-and-suspenders against a live stall — not a substitute
  for the real loop).

### Phase 3 — Deploy + Share

- Deploy = point the live link at the `RunFeature` service for this feature; input form generated from
  the seed's input schema.
- Observer = reuse the existing trace UI for single calls. The production-monitoring view is **Phase 4**.
- Share = **live link** (the runner service URL). Acceptable interim compromises on the way:
  a results report (charter + pass rates + traces) or a recorded run.

### Phase 4 — Production monitoring (Observer) — start of the flywheel

Once a feature is live, watch it the same way we evaluated it. This is not a new system — it reuses the
runner and the scorers we already built:

- **Log every prod call.** Each invocation goes through `RunFeature`, which already returns
  `{output, trace}`. Persist that to a prod-log store (mirror the `turns` table pattern) — input,
  output, full trace, latency, errors.
- **Run the same scorers on live output.** Reuse the generated scorers from the build
  (`scorers/generated/skill__<id>/`). The scorers that gated deploy now monitor prod. There's an
  existing seam: `scorer_publish.py` already emits Braintrust **online-scorer** format, which is the
  "score production logs" mechanism — either lean on Braintrust online scoring, or score in our own
  prod-log store.
- **All scorers are prod-eligible — by design.** Generated scorers are **reference-free**: they take
  `(output, input, metadata)` and judge against the seed criteria; `expected_output` is never passed
  to a scorer (`eval_runner.py:300`). So a brand-new prod input scores *identically* to a dataset row —
  no gold answer required. (The golden dataset's `expected_output` is display/record-only today; it can
  optionally serve as few-shot exemplars or an out-of-distribution signal in prod, but isn't needed for
  scoring.)
- **Async scoring UX:** each scorer is its own LLM-as-judge call, so output + trace render immediately
  and scorer results populate a beat later. Design the Observer for "scores arriving," not instant.
- **Cost is real:** LLM-as-judge on every call adds up. Plan for **sampling** (score a %, always score
  errors/outliers). For the demo's low volume, scoring all calls is fine — note the knob.
- **Observer view** (extends the existing trace UI): per-call traces, scorer pass-rates over time,
  and an **outlier list** (lowest-scoring / failing calls) — outlier ranking that was deferred earlier
  lands here as the core of the view.
- **Legibility = engagement** (cross-cutting principle): a live dashboard of "your feature is holding
  at 82%, here are the 3 calls that slipped" is exactly what pulls users back in to keep improving.

**This is the on-ramp to the flywheel:** low-scoring prod traces become candidate dataset rows →
feed the Phase 2 self-improvement loop → redeploy. That deploy → monitor → improve → redeploy cycle is
the recurring reason to keep using (and paying for) the product. Closing the loop fully (auto-promoting
prod samples into the baseline) stays deferred (see below), but Phase 4 builds the half that surfaces
*which* calls are worth promoting.

---

## Explicitly out of scope for the preview

- **Auto**-promoting sampled prod data into the baseline (Phase 4 surfaces *which* calls are worth
  promoting; auto-promotion + the closed redeploy cycle come after the preview)
- Outlier ranking / auto-suggestions post-eval
- Multi-tenant scale, auth hardening on the live link

## Parallel execution plan (how to build it with multiple agents)

The whole point of the `RunFeature` seam is that it lets work fan out. The strategy is:
**freeze the contracts → stub the runner → build every track against the stub in parallel →
swap the real runner in at integration.** Nobody waits for the container to exist.

### Stage A — Freeze the contracts (blocking, small, do first)

One agent drafts the integration contracts everything else codes against. This is the only truly
sequential step; getting it wrong is what makes parallel work diverge. Deliverables:

1. `RunFeature(input) -> {output, trace}` signature + the **trace schema** (the exact shape
   `EvaluatePanel.tsx` already renders — derive it from the existing renderer).
2. **Input/artifact convention** — LOCKED (see the dedicated section below): typed `input_schema` on the
   seed, files-by-reference, `RunFeature` assembles the message. Just encode it as types/stubs here.
3. **Prod-log record shape** (input, output, trace, scores, latency, errors).
4. **Loop contract**: definition of "passes" (every scorer ≥ 75%), round cap, and the per-round
   "what changed / why / delta" event shape the UI consumes.

Output is a short `contracts.md` + stub types. Worth a quick adversarial review before the fan-out.

### Stage B — Parallel tracks (fan out against the frozen contracts + a stubbed `RunFeature`)

| Track | Builds | Depends on (contract only) | Phase |
|-------|--------|----------------------------|-------|
| **1. Runner core** (highest risk) | Agent-SDK-in-container service implementing `RunFeature`; map SDK message stream → trace schema | RunFeature + trace schema | 0 |
| **2. PRD orchestrator** | One text box → chains `generate_skill` (`main.py:540`) → seed → `create_dataset` (`2524`) → `generate_scorers` (`1633`) → `run_eval` (`3721`) with progress UI | RunFeature stub + loop events | 1 |
| **3. Self-improvement loop** | Bounded analyze→improve→rerun; optimize-feature-not-scorers guardrail; per-round visibility | loop contract + run_eval results | 2 |
| **4. Deploy / live link** | Expose runner service as a URL; input form generated from the seed input schema | input convention + RunFeature | 3 |
| **5. Observer / prod monitoring** | Prod-log store; run scorers on live output; traces + pass-rate-over-time + outliers (reuse `EvaluatePanel` trace render) | prod-log shape + trace schema | 4 |
| **6. Legibility layer** (cross-cutting) | Shared "show what's happening" progress primitives used by Tracks 2, 3, 5 | loop/progress event shapes | all |

Tracks 2–6 build against a **mock `RunFeature`** returning canned `{output, trace}`, so they never
block on Track 1. Track 1 should start with a **spike** (prove SDK-in-container emits a trace we can map)
before its full build — it's the riskiest unknown.

### Collision strategy (critical for parallel agents)

`main.py` is a shared monolith — concurrent edits there will conflict. Mitigations:
- **Prefer new modules** (`runner.py`, `orchestrator.py`, `improve_loop.py`, `prod_log.py`) over editing
  `main.py`; register endpoints via thin one-liners to shrink the shared surface.
- **Run mutating tracks in isolated git worktrees**, merge at integration.
- Partition frontend by component: each track owns its panel(s); shared primitives live only in Track 6.

### Stage C — Integration (sequential)

Swap mock `RunFeature` for the real runner (Track 1); wire tracks together; one end-to-end pass
PRD → build → loop → deploy → try-it-in-prod → see traces + scores. Verify in the live preview.

### As an orchestrated workflow

Shape: **spike (Track 1 feasibility) → Stage A contract (1 agent, reviewed) → Stage B (6 parallel
tracks, worktree-isolated) → Stage C integration + verification**. This requires explicit opt-in to run
(it spawns many agents) — say the word and I'll author and launch it.

## LOCKED decision — input/artifact convention

Resolves the highest-leverage open question. This is a Stage A contract; four tracks depend on it.

**Current state being replaced:** everything is a plain UTF-8 string today — `Example.input: str`
(`models.py:279`), seed input is free-text `input_description` + `sample_input` (`models.py:69`), the
user message is always plain-string `content` (`eval_runner.py:455`), and there is zero file/image support.

### 1. Typed `input_schema` on the seed (the source of truth)

A new ordered list of fields on the seed. Each field:

```
{ name, type, required, description, enum?, mime? }
type ∈ { text, longtext, number, boolean, enum, json, file, image }
```

Keep human-readable `input_description` alongside it. **The simplest skill = a single `text` field,
which is byte-for-byte today's behavior** (so nothing existing breaks). This one object drives the
deploy form, the synthesizer, and the runner — describe the inputs once, everything downstream is
generated from it. (Chosen over free-text, which can't auto-build a form, and full JSON-Schema, which
is overkill and less reliable to generate.)

### 2. Backward-compatible row input

A dataset row's `input` is **either** a plain string (the single-`text`-field shorthand → existing
datasets keep working) **or** a JSON object keyed by field name. No migration required.

### 3. Files by reference, never inline

A `file`/`image` field's value is an artifact reference `{ type, mime, ref, filename }`. `ref` points to
an **artifact store** (local dir for the demo, object storage later). Never base64 in the row/DB.

### 4. `RunFeature` is the only place that assembles the message

From the typed input it builds either:
- **single-shot:** an Anthropic **content-block array** (text + `image`/`document` blocks), or
- **agent mode (SDK-in-container):** **stage files into the working dir**, hand the agent text + paths;
  it reads them with file tools.

Same contract for eval rows and prod inputs — what you evaluated is what you ship, files included.

### 5. Files enter the dataset two ways (BOTH)

- **Upload fixtures:** user uploads real sample files; rows reference them. Covers "parse this real
  (possibly messy/scanned) doc" fidelity.
- **Generate-and-render:** synthesizer generates text content, we render it into the target format
  (markdown→PDF/docx, rows→CSV). Covers "generate a doc" skills and scales dataset size automatically.

The synthesizer reads `input_schema` per field: invents values for text/json/enum, and for `file`/`image`
fields either renders generated content or draws from the uploaded fixture pool.

### 6. Scorers unchanged

Scorers still receive `input` (serialized to string if structured) — signature untouched. Edge case: a
scorer needing a file's *content* receives resolved text, not raw bytes (fine for criteria judging).

## LOCKED decision — trace schema

The frontend already renders a trace and producer/consumer match exactly today (no mismatch). So we
**freeze the existing shape as the canonical trace** and make every runner map *into* it.

- **Frozen rendering contract** = today's `AgentRowMetadata` (`types.ts:519`, produced by
  `AgentRunTrace.to_metadata()` in `agent_task.py:316`):
  `tool_calls[]{name,input,result,is_error,duration_ms}`, `artifacts[]{path,size,sha256,preview,binary}`,
  `iterations`, `stop_reason`, `halted`, `workspace`. `EvaluatePanel.tsx:2671` renders exactly these.
- **The SDK-in-container runner maps onto this**: each SDK `tool_use`+`tool_result` pair → one
  `tool_calls[]` entry; files written → `artifacts[]`; final assistant text → `final_text`; last
  message's stop reason → `stop_reason`; loop turns → `iterations`. This is Track 1's mapping job.
- **Additive, UI-optional fields** (current UI ignores unknown keys): `final_text`, `model`,
  `input_tokens`, `output_tokens`, `latency_ms`. Safe to add now; richer rendering later.
- **Net effect:** `EvaluatePanel` renders traces from the old in-process loop *and* the new SDK runner
  *and* production calls, unchanged. One trace shape across eval and prod.

Encoded as code in `backend/app/contracts.py` (`Trace`) and `frontend/src/types.ts` (`FeatureTrace`).

## Open questions to resolve next

1. **Container runtime/host** — where does the runner service live (local Docker for demo, then a
   cloud target)? Per-feature container vs. one service handling many features?
2. **Trace mapping** — exact shape `EvaluatePanel.tsx` expects vs. what the SDK emits.
3. **MCP / external tools** — does a generated skill declare which MCP servers / APIs it needs, and
   how is that permissioned at build time?
4. **Cold-start latency** — warm pool vs. long-lived service, given eval runs many rows.
5. **Artifact store** — where do uploaded/generated files live (local dir for demo → object storage)?
   How are `ref`s addressed and garbage-collected?
6. **Prod-log store** — own store (mirror the `turns` table) vs. Braintrust logs for production traces +
   online scoring. Which is the source of truth the Observer reads from?
7. **Prod scoring policy** — score every call vs. sample (and always-score errors/outliers); who pays
   for the LLM-as-judge cost at volume.

## Build status

**Stage A — DONE & verified (2026-06-03).** The blocking, sequential foundation is in place:

- Contracts as code: `backend/app/contracts.py` (Pydantic) + matching `frontend/src/types.ts`
  (`FeatureTrace`, `InputSchema`, `RunFeatureRequest/Result`, `LoopRoundEvent`, `ProdLogRecord`).
  Frontend `tsc --noEmit` passes; every backend model instantiates.
- Trace schema locked (frozen `AgentRowMetadata` shape) — see the LOCKED section above.
- Input/artifact convention locked and encoded.
- **`RunFeature` seam:** `backend/app/runner.py` with three backends — `mock` (works now, no key/infra),
  `inprocess` single-shot (real `messages.create` via `tools.get_client`), and `container` (stubbed for
  Track 1). Input assembly (text + file blocks) lives here. Verified: mock run, multi-field assembly,
  structured errors on unimplemented paths.

**Next:** fan out Stage B tracks against the stable mock seam (Tracks 2/4/5 need no infra; Track 1 fills
in the `inprocess`-agent + `container` backends and the artifact store).

**Stage B — DONE (2026-06-03, parallel workflow `wf_29a9fdf4-fe2`).** Six tracks built concurrently in
isolated git worktrees against the locked contracts, each verified at the type/import/router level. Live
under `.claude/worktrees/wf_29a9fdf4-fe2-{1..6}/`:

| # | Track | Headline deliverables | Verified |
|---|-------|-----------------------|----------|
| 1 | Runner container | `backend/runner_container/` (Dockerfile, Node server.ts, compose); `backend/app/runner_container_client.py`; tiny `_run_container` edit | Server smoke-tested with `npx tsx`; frozen Trace shape round-trips through Python client. Docker build itself unverified (no daemon). |
| 2 | PRD orchestrator | `backend/app/orchestrator.py` (`POST /orchestrate-build` SSE); `frontend/src/components/PRDBox.tsx` | Router + route registered; `tsc` clean. Evaluate stage is mock until real `run_feature` is wired. |
| 3 | Self-improvement loop | `backend/app/improve_loop.py` (`POST /api/improve-loop` SSE); `ImproveLoopPanel.tsx` | Anti-Goodhart guard rejects scorer/charter patches; LoopRoundEvent validates; SSE end-to-end via TestClient. |
| 4 | Deploy / live link | `backend/app/deploy.py`; `frontend/src/lib/inputSchemaForm.tsx` (form generator from InputSchema); `DeployPanel.tsx` | Deploy → form-render → run-prod-call → in-memory log all green via TestClient. |
| 5 | Observer / monitoring | `backend/app/prod_log.py` (ingest + list + outliers + pass-rate); `ObserverPanel.tsx`; `AgentTraceView.tsx` (reuses frozen Trace shape) | Outlier ordering + since-filter + scorer-result attach verified. In-memory store, persist later. |
| 6 | Legibility primitives | `useEventStream.ts`; `legibility/{ProgressStream,RoundCard,ScoreBar}.tsx` | `tsc` clean; Tailwind v4 tokens only; downstream tracks reuse. |

The workflow produced an **integration plan** with merge order (T6 → T1 → T2 → T4 → T5 → T3),
expected conflicts (mostly duplicate-copy artifacts: discard the worktree copies of `contracts.py` /
`runner.py` / `types.ts` since they're byte-identical to main), the exact `main.py` / `App.tsx` wiring,
and the mock-backend smoke path (PRD → SSE stages → loop rounds → deploy → form-submit → traces+scores).

**Stage C — DONE & smoke-verified (2026-06-03).** All Stage B tracks merged into main and wired:

- **23 new files** copied from the 6 worktrees (none of the duplicate Stage-A copies — those stay
  as the originals on main).
- **`backend/app/main.py`** — added four `include_router` calls + the deploy→prod_log sink (via a
  tiny sync adapter that schedules the async `prod_log.post_prod_log` on the running loop).
- **`backend/app/runner.py`** — Track 1's `_run_container` body: routes to
  `runner_container_client.invoke(req)` when `CONTAINER_URL` is set.
- **`frontend/src/App.tsx`** — added `/build` route mounting `PRDBox`.
- **`frontend/src/pages/ProjectWorkspace.tsx`** — extended `ActiveTab` union with `improve`/`deploy`/
  `observer`, added a new SidebarGroup with three items (soft-gated on skill/scorers), added three
  conditional render blocks for the new panels.

**Verified (`RUNNER_BACKEND=mock`):**
- Backend boots cleanly; 10 demo routes register including `/orchestrate-build`, `/api/improve-loop`,
  `/api/deploy/{skill_id}`, `/api/deployed/{skill_id}/run`, `/api/prod-log/...`, `/deployed/{skill_id}`.
- Frontend `tsc --noEmit`: exit 0.
- End-to-end HTTP smoke: deploy → run → prod-log list returns the record → public deploy page
  serves an HTML form. All ✓.

**Next, in order of payoff:**
1. **Click-through verify in browser** — start the dev servers, paste a PRD on `/build`, watch SSE
   stages, hit Improve tab, hit Deploy, try the live feature, watch Observer.
2. **Swap mock evaluate for real `run_feature`** in `orchestrator._stage_evaluate` so pass-rates
   reflect actual generated-skill behavior (not the 0.55–0.85 placeholder).
3. **Bind `improve_loop.set_deps(...)`** — wire `load_state` to pull the persisted skill_body +
   last eval scores from DB, `persist_skill` to write a new skill version, `run_eval` to invoke
   the orchestrator's eval stage. Until this lands, the loop uses its built-in mock evaluator
   (good enough to demo, not real).
4. **Persist deploy + prod-log** beyond uvicorn reload (Postgres tables mirroring the `turns`
   pattern; sketched in module headers).
5. **Real container backend** — run `docker compose up --build` in `backend/runner_container/`,
   `export RUNNER_BACKEND=container CONTAINER_URL=http://localhost:8088` — and you're running
   the Agent SDK in a sandboxed container instead of the in-process loop.
6. **Bolt `input_schema` onto the persisted `Seed`** — the typed schema currently defaults to a
   single text field; once persisted, every existing feature can describe richer typed inputs.
