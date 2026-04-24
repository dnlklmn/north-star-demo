# North Star

**Eval-driven development for Claude Code skills.**

Most eval workflows start with a dataset or a scorer. North Star starts earlier: *what does a skill actually need to do, and what should it stay out of?* It turns a SKILL.md into a charter (the quality spec), a golden dataset (curated rows), scorers (LLM-as-judge functions), and an end-to-end eval harness that runs in Braintrust. Then it closes the loop — read eval failures, propose SKILL.md edits, save a new version, run again, compare.

---

## The loop, in one diagram

```
           ┌──────────────────┐
           │   SKILL.md v1    │◄────────────── Iterate ──────────────┐
           └────────┬─────────┘                                       │
                    │ paste                                           │
                    ▼                                                 │
           ┌──────────────────┐                                       │
           │  Skill seed      │  ── LLM: build_skill_seed_prompt ──┐  │
           │  (goals, users,  │                                    │  │
           │   pos+off-target │                                    │  │
           │   stories, task) │                                    │  │
           └────────┬─────────┘                                    │  │
                    ▼                                              │  │
           ┌──────────────────┐                                    │  │
           │    Charter       │  ── LLM: build_generate_draft     │  │
           │  Coverage(+neg)  │         build_validate_charter    │  │
           │  Balance         │         build_generate_suggestions│  │
           │  Alignment       │                                    │  │
           │  Rot             │                                    │  │
           │  Safety          │                                    │  │
           └────────┬─────────┘                                    │  │
                    ▼                                              │  │
           ┌──────────────────┐                                    │  │
           │    Dataset       │  ── LLM: build_synthesize_examples│  │
           │  input/output    │         build_review_examples     │  │
           │  should_trigger  │         build_gap_analysis        │  │
           │  is_adversarial  │         build_revise_examples     │  │
           └────────┬─────────┘                                    │  │
                    ▼                                              │  │
           ┌──────────────────┐                                    │  │
           │    Scorers       │  ── LLM: build_generate_scorers   │  │
           │  per alignment,  │                                    │  │
           │  coverage, safety│                                    │  │
           └────────┬─────────┘                                    │  │
                    ▼                                              │  │
           ┌──────────────────┐                                    │  │
           │  Evaluations     │  ── Runs eval_runner.py via        │  │
           │  (Braintrust)    │         Braintrust SDK             │  │
           │  scores + trace  │                                    │  │
           └────────┬─────────┘                                    │  │
                    ▼                                              │  │
           ┌──────────────────┐                                    │  │
           │    Improve       │  ── LLM: build_suggest_improvements│  │
           │  accept/dismiss  │                                    │  │
           │  edits → v2      │────────────────────────────────────┘  │
           └──────────────────┘                                       │
                    │                                                 │
                    └─── save new SKILL.md version ───────────────────┘
```

Every step is visible, editable, and reversible. You never have to run an LLM call you can't inspect.

---

## Workflows

### Skill-first *(primary)*

1. Home → **New skill eval** → [NewSkillEval](frontend/src/pages/NewSkillEval.tsx) page.
2. Paste SKILL.md (frontmatter optional — auto-parsed).
3. Backend runs `call_skill_seed` → extracts **goals + user roles + positive stories + off-target stories + task description** in one LLM call.
4. Land on the **Skill** tab to review what was extracted. Jump across tabs to edit anything.
5. Generate Charter → Scorers → Dataset → Run eval → Analyze failures → Suggest SKILL.md edits → save v2.
6. Re-run eval: per-scorer deltas vs the previous run tell you whether the edit helped.

### Start from scratch *(secondary)*

Small escape link on the NewSkillEval page. Creates a session with no `skill_body`, lands on the Goals tab. Follows the original guided-discovery flow (one question per turn, three discovery phases). Useful for evaluating non-skill AI features.

---

## Architecture

```
frontend/          React 19 + TypeScript + Tailwind v4 + Vite
backend/app/       FastAPI + Anthropic SDK + asyncpg (PostgreSQL)
evals/             Standalone CLI (evals/run_eval.py) — shares backend/app/eval_runner.py
```

### Backend layers

The key decision: **prompts, LLM calls, and control flow live in separate files.** Prompts change weekly; control flow rarely does. Mixing them meant every prompt tweak risked breaking orchestration.

```
prompt.py          All prompts. One function per prompt. Edit here to change
                   agent behavior — no other file needs to change.

tools.py           LLM call wrappers. Each call_X function:
                   - builds the prompt via prompt.build_X
                   - calls Claude (with per-request API key support)
                   - parses the response into Pydantic models
                   - returns (structured_data, [call_metadata])

eval_runner.py     Shared Braintrust eval logic — used by the UI's
                   /run-eval endpoint and by the CLI (evals/run_eval.py).

agent.py           Control flow. State transitions, orchestration, turn
                   logging. No prompts, no direct LLM calls.

main.py            FastAPI endpoints. Translates HTTP → agent turns or
                   direct tool calls. Handles per-request API keys via
                   middleware.

models.py          Pydantic models — one source of truth for frontend +
                   backend shapes (via Pydantic → TypeScript mirroring
                   in types.ts).

db.py              PostgreSQL via asyncpg. Idempotent schema migrations
                   in init_db.
```

### Frontend structure

Tabbed layout. Every tab is a review + edit surface; the conversational agent ("Polaris") is hidden by default but accessible if you want it.

| Tab | File | Purpose |
|---|---|---|
| Skill | [SkillPanel.tsx](frontend/src/components/SkillPanel.tsx) | Edit SKILL.md · version history · diffs |
| Business Goals | [GoalsPanel.tsx](frontend/src/components/GoalsPanel.tsx) | Review/edit extracted goals · suggestions |
| User Stories | [UsersPanel.tsx](frontend/src/components/UsersPanel.tsx) | Review/edit positive + off-target stories |
| Charter | [CharterPanel.tsx](frontend/src/components/CharterPanel.tsx) | Task def · Coverage · Balance · Alignment · Rot · Safety · View as document |
| Dataset | [ExampleReview.tsx](frontend/src/components/ExampleReview.tsx) | Generate/import/review examples · coverage map |
| Scorers | [ScorersPanel.tsx](frontend/src/components/ScorersPanel.tsx) | Generate Python scorer functions |
| Evaluations | [EvaluatePanel.tsx](frontend/src/components/EvaluatePanel.tsx) | Run on Braintrust · see scores, deltas, traces |
| Improve | [ImprovePanel.tsx](frontend/src/components/ImprovePanel.tsx) | Propose SKILL.md edits · accept → new version |

---

## Sections, one by one

Each section describes the tab's purpose, the prompts it fires, the data it produces, and the knobs users turn.

### Skill

**Purpose:** the source of truth. The SKILL.md body lives here; every other artifact is downstream.

**Prompts fired:**
- `build_skill_seed_prompt(skill_body, name, description)` — one-shot extraction of goals, users, positive + off-target stories, and task definition when the user first pastes.

**Data produced:** `SessionState.charter.task.skill_body` + `skill_versions[]` (append-only history) + `active_skill_version_id` pointer.

**Interactions:** paste, edit, save as v+1, diff v2 vs v1, restore an earlier version.

**Lineage:** each downstream artifact (goals/users/stories/charter/dataset/scorers) records which skill version it was generated against via `state.generated_at_skill_version`. When the active skill advances, stale tabs show a banner with **Update suggestions** + **Regenerate** buttons.

---

### Business Goals

**Purpose:** what the business needs from the skill. Auto-extracted from SKILL.md on seed; editable.

**Prompts fired:**
- `build_suggest_goals_prompt(goals)` — proposes complementary goals.
- `build_evaluate_goals_prompt(goals)` — flags goals that are too broad / not measurable / not independent.

**Knobs:** add, edit, delete, accept suggestion, dismiss suggestion.

---

### User Stories

**Purpose:** who uses the skill and what they're trying to do. In triggered mode, stories carry a `kind` field: `positive` (skill should fire) or `off_target` (skill should NOT fire). Off-target stories become the negative-space coverage criteria.

**Prompts fired:**
- `build_suggest_stories_prompt(goals, stories)` — proposes missing stories grounded in current goals.

**Data shape per story:** `{ who, what, why, kind }`.

---

### Charter

**Purpose:** the quality specification. Six tabs under the Charter panel:

| Sub-tab | What it defines |
|---|---|
| Task Definition | Input/output format + skill metadata (name, description, body) |
| Coverage | Positive criteria (scenarios to handle) + `negative_criteria` (off-target) |
| Balance | Which scenarios to weight, positive/negative ratio |
| Alignment | Per-feature-area good/bad definitions (observable, not intent-level) |
| Rot | Conditions under which the charter needs refreshing |
| Safety | Output-level rules (prompt-injection resistance, credential containment, URL allow-list, etc). Triggered mode only. |

**Prompts fired:**
- `build_generate_draft_prompt(state, creativity)` — generates the charter JSON. In triggered mode, anchors on the SKILL.md body + extracted state. In scratch mode, uses the conversation transcript.
- `build_validate_charter_prompt(state)` — returns pass/weak/fail per dimension, strict about specificity + testability. Triggered mode also enforces that `coverage.negative_criteria` is non-empty and safety criteria are populated for side-effecting skills.
- `build_generate_suggestions_prompt(state)` — per-tab suggestions for weak/empty sections, with deduplication baked into the prompt + parser.
- `build_conversational_turn_prompt(state, user_message)` — fallback when the user opens Polaris chat.

**Viewing:** top-right **View as document** button opens [CharterDocument.tsx](frontend/src/components/CharterDocument.tsx) — the full charter as one markdown page with a copy-to-clipboard button.

---

### Dataset

**Purpose:** the rows the skill will actually be evaluated against.

**Row shape:**
```
{
  id,
  input, expected_output, feature_area, coverage_tags, label,
  should_trigger,      // true | false | null (standard mode)
  is_adversarial,      // true | null (safety probe)
  review_status,       // pending | approved | rejected | needs_edit
  judge_verdict,       // { suggested_label, confidence, reasoning, issues,
                       //   trigger_verdict?, execution_verdict? }
  revision_suggestion
}
```

**Prompts fired:**
- `build_synthesize_examples_prompt(charter, ...)` — generates rows. In triggered mode, emits two populations: `should_trigger=true` rows (execution-eval) and `should_trigger=false` rows (routing). When safety criteria exist, also generates one adversarial row per criterion.
- `build_review_examples_prompt(charter, examples)` — LLM-as-judge. In triggered mode, emits a composite verdict: `trigger_verdict` (routing correctness) + `execution_verdict` (output quality).
- `build_gap_analysis_prompt(charter, stats, examples)` — finds coverage holes, feature-area holes, under-represented scenarios.
- `build_revise_examples_prompt(charter, examples_with_verdicts)` — proposes minimal targeted fixes for flagged rows. Users accept, edit, or dismiss — never auto-applied.
- `build_dataset_chat_prompt(charter, stats, message, history)` — conversational dataset curation (fallback surface).

---

### Scorers

**Purpose:** executable Python scoring functions.

**Prompts fired:**
- `build_generate_scorers_prompt(charter)` — emits one scorer per alignment entry, one per coverage criterion, and one per safety criterion. Each is a complete function with signature `def <name>(output: str, input: str) -> float`, an embedded LLM-as-judge prompt, and a call to an injected `call_judge(prompt) -> float` helper.

**Output shape per scorer:** `{ name, type: "alignment" | "coverage" | "safety", description, code }`.

Safety scorers are strict — their judge prompts are instructed that violations should never score above 0.3.

---

### Evaluations

**Purpose:** run the dataset through Claude (with SKILL.md as system prompt) → score with the scorers → pipe into Braintrust.

**Backend:**
- `POST /sessions/{id}/run-eval` queues a run, persists a row in the `eval_runs` table, spawns an asyncio background task that invokes `eval_runner.run_eval_sync` off the event loop.
- Each run captures a `charter_snapshot` + `skill_version_id` so old runs can be reviewed in context.
- `GET /sessions/{id}/eval-runs/{run_id}` polls status; the UI polls every 2s until terminal.

**What the eval does:**
1. Compiles scorer source code into callable Python (injects `call_judge` helper).
2. Filters dataset rows (`review_status=approved`; skips `should_trigger=false` unless user opts in).
3. For each row, calls Claude with SKILL.md as system prompt (via `braintrust.wrap_anthropic`).
4. Runs each scorer against `(output, input, expected)`. Judge reasoning is captured in scorer metadata so you can debug 0% scorers by reading the exact LLM response that produced them.
5. Results stream into Braintrust and into the `per_row` JSONB column.

**UI features:**
- Per-scorer averages with **delta vs previous run** (`+12pp` / `-4pp`) — shows whether the last SKILL.md edit improved things.
- Run history list (persists across backend restarts).
- **View charter** link on each run — opens the exact charter used (not the live one).
- **Improve skill** button — jumps to Improve tab with auto-analyze triggered.

---

### Improve

**Purpose:** turn eval failures into SKILL.md edits.

**Prompts fired:**
- `build_suggest_improvements_prompt(skill_body, eval_run, charter)` — analyzes patterns across failing rows (scorer < 0.6), proposes 2–5 minimal edits with row + scorer citations.

**Edit shape:** either find/replace (verbatim `find` string must appear in SKILL.md) or append. Each suggestion carries `kind` (`add_rule` / `clarify_rule` / `add_example` / `reword` / `other`), `confidence`, `source_row_ids`, and `source_scorer_names`.

**Interactions:**
- Accept/dismiss per suggestion. Accepted suggestions collapse into one-line diff previews (`old text → new text` or `append: new text`).
- Preview the combined diff before saving.
- Save as v+1 → charter.task.skill_body updates → **Run evaluations** CTA appears → click it to bounce back to the Evaluations tab with an auto-triggered new run using the same config as last time.

Linked to the main loop: save v2 → re-run → see deltas vs v1.

---

## Prompt catalog *(one-line index)*

All in [prompt.py](backend/app/prompt.py). One function per prompt. To change agent behavior, edit here — no other file should need to change.

**Skill**
- `build_skill_seed_prompt` — one-shot extraction from SKILL.md

**Goals / Stories (discovery + helpers)**
- `build_discovery_turn_prompt` — routes by phase (goals / users / stories). Used in scratch mode.
- `build_suggest_goals_prompt`, `build_evaluate_goals_prompt`, `build_suggest_stories_prompt`

**Charter**
- `build_generate_draft_prompt` — generates charter (branches on skill mode)
- `build_validate_charter_prompt` — pass/weak/fail per dimension
- `build_generate_suggestions_prompt` — per-tab suggestions with dedup rules
- `build_conversational_turn_prompt` — Polaris chat refinement

**Dataset**
- `build_synthesize_examples_prompt` — generate rows (branches on triggered mode + safety)
- `build_review_examples_prompt` — judge verdicts (splits into trigger + execution verdicts)
- `build_gap_analysis_prompt` — find coverage holes
- `build_revise_examples_prompt` — fix flagged rows
- `build_dataset_chat_prompt` — conversational curation

**Scorers**
- `build_generate_scorers_prompt` — emit Python LLM-as-judge functions

**Improve**
- `build_suggest_improvements_prompt` — analyze eval failures, propose SKILL.md edits

**Schema helpers**
- `build_detect_schema_prompt`, `build_infer_schema_prompt`, `build_import_url_prompt`

---

## Eval harness

[evals/run_eval.py](evals/run_eval.py) is the standalone CLI. The backend's `/run-eval` endpoint invokes the same shared module ([eval_runner.py](backend/app/eval_runner.py)), so CLI and UI runs are guaranteed identical.

```bash
# from the backend venv, after seeding a session:
python evals/run_eval.py --session-id <uuid> --project my-skill-eval
```

See [evals/README.md](evals/README.md) for the full CLI reference.

---

## Database

PostgreSQL. Idempotent schema migrations in [db.py](backend/app/db.py)'s `init_db`. Tables:

| Table | Purpose |
|---|---|
| `sessions` | Full session state as JSONB (charter, validation, input, conversation_history, skill_versions, lineage map) |
| `charters` | Immutable charter snapshots created on finalize |
| `turns` | Every LLM interaction logged with full input/output/metadata for replay + judging |
| `datasets` | Dataset metadata with charter snapshot + stats |
| `examples` | Dataset rows with verdict, revision suggestion, should_trigger, is_adversarial |
| `settings` | Single-row settings (model, creativity, max_rounds) |
| `eval_runs` | Persisted Braintrust runs — status, scorer averages, per-row results, skill_version_id, charter_snapshot |
| `judgements` | Scores per turn when `POST /judge/run` is invoked |

Migrations added over time:
- `examples.revision_suggestion JSONB`
- `examples.should_trigger BOOLEAN`
- `examples.is_adversarial BOOLEAN`
- `examples.expected_output` — DROP NOT NULL (required for should_trigger=false rows)
- `eval_runs.charter_snapshot JSONB`

---

## API endpoints *(grouped)*

**Sessions** — `POST /sessions`, `GET /sessions`, `GET/PATCH/DELETE /sessions/{id}`, `PATCH /sessions/{id}/name`, `PATCH /sessions/{id}/input`, `PATCH /sessions/{id}/mode`

**Skill** — `POST /sessions/{id}/skill-seed`, `GET /sessions/{id}/skill-versions`, `POST /sessions/{id}/skill-versions`, `POST /sessions/{id}/skill-versions/restore`

**Agent (scratch mode + Polaris chat)** — `POST /sessions/{id}/message`, `POST /sessions/{id}/advance-phase`, `POST /sessions/{id}/proceed`, `PATCH /sessions/{id}/charter`, `POST /sessions/{id}/validate`, `POST /sessions/{id}/suggest`, `POST /sessions/{id}/finalize`

**Dataset** — `POST/GET /sessions/{id}/dataset`, `POST /datasets/{id}/synthesize`, `POST /datasets/{id}/import`, `POST /datasets/{id}/review`, `POST /datasets/{id}/suggest-revisions`, `GET /datasets/{id}/gaps`, `POST /datasets/{id}/enrich`, `POST /datasets/{id}/chat`, `GET /datasets/{id}/export`, `GET /datasets/{id}/export/skill-creator`, `POST /datasets/{id}/infer-schema`

**Scorers** — `POST /sessions/{id}/generate-scorers`, `PATCH /sessions/{id}/scorers`

**Evaluations** — `POST /sessions/{id}/run-eval`, `GET /sessions/{id}/eval-runs`, `GET /sessions/{id}/eval-runs/{run_id}`, `POST /sessions/{id}/suggest-improvements`

**Schema detection** — `POST /sessions/{id}/detect-schema`, `POST /sessions/{id}/import-from-url`

---

## Setup

```bash
# backend
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e .
cp .env.example .env  # fill in values
uvicorn app.main:app --port 8080 --reload

# frontend (separate terminal)
cd frontend
npm install --legacy-peer-deps
npm run dev

# database — PostgreSQL must be running locally
createdb northstar
```

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | `postgresql://localhost:5432/northstar` |
| `ANTHROPIC_API_KEY` | one of | Claude API key |
| `OPENROUTER_API_KEY` | one of | OpenRouter key — auto-detected by `sk-or-` prefix. Ignored when `ANTHROPIC_API_KEY` is set. |
| `BRAINTRUST_API_KEY` | for UI evals | Can also be entered in the Evaluations tab and stored in localStorage |
| `MODEL_NAME` | no | Default: `claude-sonnet-4-20250514` |
| `EVAL_MODEL` | no | Model for the task function in eval runs. Default: `claude-opus-4-7` |
| `JUDGE_MODEL` | no | Model for LLM-as-judge scorers. Default: `claude-sonnet-4-20250514` |
| `MAX_QUESTION_ROUNDS` | no | Scratch-mode refinement rounds. Default: 3 |

Per-request keys: the frontend sends `X-Anthropic-Key` / `X-Braintrust-Key` headers pulled from localStorage — users can run without a server-side key by pasting their own.

---

## Future plans

These are discussed but not built. Listed roughly by value / effort.

### Claude Agent SDK integration *(biggest unlock)*

Today the eval's `task()` function calls the bare Anthropic Messages API with SKILL.md as a system prompt. This tests whether the skill's **instructions** produce good text, but:

- Tool-using skills (file writes, image generation, URL fetches) produce *hallucinated* outputs — "I've generated the image at /tmp/foo.png" with no file.
- **Routing** (does Claude Code actually load this skill?) is side-stepped — we pre-inject the body rather than letting the description-based router decide.

Integrating the Claude Agent SDK would fix both. The `task()` becomes an agent loop that loads the skill by description, allows tool calls, and captures real artifacts. You'd also get:
- **Tool-call traces** per row (critical for multi-step skills where step 3 fails).
- **Runtime safety signal** (did the skill actually call `curl evil.com`, did it write outside the sandbox).
- **Token + latency budgets** under realistic tool usage.

Estimated scope: ~1 week. Requires sandboxing for file writes, a domain allow-list, and Braintrust tracing for tool-call spans.

### Two-way connectors

Today connectors are one-way (North Star exports datasets + scorers → Braintrust / skill-creator). Two-way means results come back:

| Signal source | Feeds | What it catches |
|---|---|---|
| Eval platform results (regression, judge disagreement) | **Dataset** | Flaky rows, regressed cases, wrong labels |
| Product telemetry (thumbs, edits, escalations) | **Charter** | Missed stories, goals the user didn't state, new user types |

Without two-way connectors, the Rot dimension only captures *intent drift* ("did the goals change"), not *production drift* ("are scores degrading"). Production drift is what makes the loop iterative rather than one-shot.

### Runtime safety dimension

The Safety charter dimension scores output-level violations today (prompt injection, credential echo, URL allow-list). Runtime safety (did the skill actually call a disallowed domain, did it write outside an allowed path) requires the Agent SDK integration above — they're linked.

### Validation + lineage polish

- Add `Safety` to the `Validation` schema so the Charter tab gates on safety weakness the same way it does for coverage.
- Stamp lineage on manual edits, not just on generate — right now editing a goal doesn't refresh the version banner.
- Multi-session charter comparison (useful when A/B'ing two different SKILL.md structures).

### Eval harness polish

- Persist the Braintrust experiment URL + full per-row traces for historical runs (currently only the URL is stored).
- Support non-Braintrust backends (Promptfoo, custom runners) via an eval-runner plugin interface.
- Auto-promote interesting production rows into the dataset (requires two-way telemetry).

---

## Ideal use cases

**Strong fit:**

- **Claude Code skills** with text-centric output. `internal-comms`, `claude-api`, `skill-creator`, `doc-coauthoring` work well — the full loop (charter → dataset → eval → improve) holds end-to-end.
- **Guardrail iteration.** When your biggest risk is the skill firing on the wrong prompt or mishandling adversarial input, the negative coverage + safety + adversarial dataset rows give you a direct measurement.
- **Skill description tuning.** Export `should_trigger=false` rows through `/export/skill-creator` for dedicated routing evals.
- **Small teams owning a skill end-to-end.** The charter + eval + improve loop is tight enough that one person can iterate in minutes.

**Less strong fit (as of today):**

- **Tool-using skills** (`docx`, `pdf`, `xlsx`, `slack-gif-creator`, `webapp-testing`, anything producing file artifacts). The `task()` runs bare Claude, so tool-produced artifacts don't actually materialize. Wait for Agent SDK integration or scope evals to the text-portion of output.
- **Very large datasets** (1000+ rows). Current UI renders all rows; per-row API calls to the judge aren't batched aggressively. Fine for demo-sized iteration, not production-scale benchmarking.
- **Multi-agent flows** where routing happens across multiple skills. The harness only evaluates one skill at a time.
- **Continuous production monitoring.** This is an authoring + iteration tool. For prod monitoring you'd wire Braintrust or Langfuse directly into your app and consume North Star's dataset as a seed.

**Not a fit:**

- **Non-LLM evaluation.** If "good" is measured by deterministic passing tests (SQL correctness, etc.), an LLM-as-judge charter is overkill.
- **Compliance / regulatory evals** where scorer provenance must be traceable to a human. Our scorers are LLM-authored; a regulated environment would need human-written scorer code at minimum.

---

## Docs

- [Process notes + design decisions](docs/process.md) — how the project was built, connector design, phase history
- [Dataset spec](docs/dataset-spec.md) — dataset model + review + enrichment flows
- [Session summary](docs/session-summary.md) — earlier design-phase output
- [evals/](evals/README.md) — standalone eval CLI
- [CLAUDE.md](CLAUDE.md) — project-level instructions for AI coding agents

