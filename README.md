# North Star

An eval-driven development platform. Formalize your business goals and user stories so you're evaluating against the right thing — before writing a single eval.

## The idea

Most AI evaluation starts with the dataset or the scorer. North Star starts earlier: what does your product actually need to do, and for whom?

You work through a guided flow — defining business goals, identifying users, writing stories — and the app generates a **charter**: a structured quality definition with four dimensions:

- **Coverage** — Input scenarios that must be tested ("customer asks about a delayed order with no ETA")
- **Balance** — Which scenarios to weight more heavily ("escalation cases over-represented because that's where frustration occurs")
- **Alignment** — What good vs bad output looks like per feature area (observable, not intent-level)
- **Rot** — When criteria become stale ("when the return policy changes")

The charter is the source of truth. Everything downstream derives from it:

1. **Generate a golden dataset** — synthetic examples covering every criterion x feature area
2. **Review and curate** — auto-judge examples against the charter, approve/reject/edit
3. **Suggest revisions** — for examples that fail review, propose minimal targeted fixes (accept, dismiss, or edit — never auto-applied)
4. **Generate scorers** — executable Python evaluation functions derived from charter criteria
5. **Analyze coverage gaps** — find what's missing and generate targeted examples to fill holes

---

## Phases

The app is a step-by-step flow. Each phase builds on the previous one.

### Phase 1: Goals

Define what the business needs from this AI feature. Add goals directly, get AI suggestions for complementary goals, and get quality feedback (too broad? not measurable? not independent?).

### Phase 2: Users

Identify who interacts with the feature — direct users, upstream data providers, downstream consumers. Group them by role.

### Phase 3: Stories

For each user type, describe what they need to accomplish and why. The app structures these as who/what/why stories. AI can suggest stories you might be missing based on your goals.

### Phase 4: Charter

The app generates a charter from your goals and stories, then validates each dimension for testability. You refine by editing criteria directly — adding, removing, rewording. An AI assistant is available for conversational refinement if needed. Each edit triggers revalidation.

The charter includes a **task definition** (what the app receives and produces, with sample input/output) so generated examples match the actual format.

### Phase 5: Dataset

Once the charter is set:

- **Generate** examples from charter (coverage criterion x feature area x good/bad label)
- **Import** existing data from CSV or JSON
- **Auto-review** with LLM judge — each example gets a verdict: suggested label, confidence, reasoning, issues
- **Suggest revisions** — for examples with issues, proposes targeted fixes (original vs proposed diff). Accept, dismiss, or edit with the revision pre-filled.
- **Gap analysis** — coverage matrix showing which scenarios lack examples, then generate to fill
- **Export** approved examples as JSON

### Phase 6: Scorers

Generates complete Python evaluation functions from the charter:

- **Alignment scorers** — one per alignment entry, with an LLM-as-judge prompt grounded in the good/bad definitions
- **Coverage scorers** — one per coverage criterion, checking if the output handles that scenario

Each scorer is a working function (`def scorer_name(output, input) -> float` returning 0.0-1.0) with a complete judge prompt, not a stub.

---

## Architecture

```
frontend/          React 19 + TypeScript + Tailwind CSS v4 + Vite
backend/app/       FastAPI + Claude API + PostgreSQL
```

### Backend layers

```
prompt.py    All prompts. One function per prompt. Edit here to change agent behavior.
tools.py     LLM call wrappers. Sends prompts to Claude, parses responses.
             Each call returns (structured_data, [call_metadata]).
agent.py     Control flow only. State transitions, orchestration.
             No prompts, no direct LLM calls.
main.py      API endpoints + request handling.
models.py    Pydantic models for all request/response validation.
db.py        PostgreSQL persistence layer.
```

### Agent orchestration (agent.py)

The agent is a state machine. `run_agent_turn()` routes based on current state:

```
User action
  |
  +-- Discovery phase (goals/users/stories)?
  |     -> One question per turn, extract entities, check readiness
  |
  +-- Charter phase (first entry or regenerate)?
  |     -> Generate draft -> Validate -> Determine status -> Suggest
  |
  +-- Has charter + user message?
  |     -> Conversational turn with optional charter-update block
  |     -> Revalidate if charter was modified
  |
  -> Log turn to DB (input, raw output, parsed result, call metadata)
  -> Update state, return result
```

### Frontend structure

Tabbed layout with direct manipulation:

| Tab | What you do |
|-----|-------------|
| **Goals** | Add/edit/remove business goals, get suggestions and quality feedback |
| **Users** | Define user types grouped by role |
| **Stories** | Write who/what/why stories per user type |
| **Charter** | View/edit all four dimensions, accept suggestions, see validation status |
| **Dataset** | Table of examples with filters, review workflow, generate/import/export |
| **Scorers** | Generate and download evaluation functions |

---

## Prompts

Every LLM interaction uses a prompt function in `prompt.py`.

### Discovery prompts

| Function | Purpose |
|----------|---------|
| `build_discovery_turn_prompt(state, user_message)` | Routes to phase-specific sub-prompt (goals/users/stories). Returns message + extraction block. |

### Charter prompts

| Function | Purpose |
|----------|---------|
| `build_generate_draft_prompt(state, creativity)` | Generates charter JSON from goals + stories. Creativity controls inference level. |
| `build_validate_charter_prompt(state)` | Checks each dimension for testability. Returns pass/weak/fail per dimension. |
| `build_conversational_turn_prompt(state, user_message)` | Conversational refinement with optional charter-update and suggestions blocks. |
| `build_generate_suggestions_prompt(state)` | Proposes concrete items for empty/weak charter sections. |

### Helper prompts (stateless)

| Function | Purpose |
|----------|---------|
| `build_suggest_goals_prompt(goals)` | Suggests complementary business goals. |
| `build_evaluate_goals_prompt(goals)` | Flags goals that are too broad, too technical, not measurable. |
| `build_suggest_stories_prompt(goals, stories)` | Suggests user stories aligned with existing goals. |

### Dataset prompts

| Function | Purpose |
|----------|---------|
| `build_synthesize_examples_prompt(charter, ...)` | Generates labeled examples per coverage criterion x feature area. |
| `build_review_examples_prompt(charter, examples)` | Judges examples against charter. Returns verdict per example. |
| `build_dataset_chat_prompt(charter, stats, message, history)` | Conversational dataset curation with action blocks. |
| `build_gap_analysis_prompt(charter, stats, examples)` | Analyzes coverage matrix, identifies gaps. |

### Scorer and revision prompts

| Function | Purpose |
|----------|---------|
| `build_generate_scorers_prompt(charter)` | Generates complete Python LLM-as-judge functions from charter criteria. |
| `build_revise_examples_prompt(charter, examples_with_verdicts)` | Proposes targeted revisions to fix review issues. |

### Schema detection prompts

| Function | Purpose |
|----------|---------|
| `build_detect_schema_prompt(content, content_type)` | Detects format and infers structure from pasted content. |
| `build_infer_schema_prompt(examples, charter)` | Infers input/output format from existing examples. |
| `build_import_url_prompt(content, url, detected_type)` | Extracts task definition from URL content. |

---

## API endpoints

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions` | Create session |
| GET | `/sessions` | List all sessions |
| GET | `/sessions/{id}` | Get session state |
| PATCH | `/sessions/{id}/name` | Rename |
| PATCH | `/sessions/{id}/input` | Save goals/stories |
| DELETE | `/sessions/{id}` | Delete |

### Agent

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions/{id}/message` | Send message, get response |
| POST | `/sessions/{id}/advance-phase` | Advance discovery phase |
| POST | `/sessions/{id}/proceed` | Proceed to review |
| PATCH | `/sessions/{id}/charter` | Edit charter |
| POST | `/sessions/{id}/validate` | Run validation |
| POST | `/sessions/{id}/suggest` | Generate suggestions |
| POST | `/sessions/{id}/finalize` | Finalize charter |

### Dataset

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions/{id}/dataset` | Create dataset |
| GET | `/sessions/{id}/dataset` | Get dataset with examples |
| POST | `/datasets/{id}/synthesize` | Generate examples |
| POST | `/datasets/{id}/import` | Import examples |
| POST | `/datasets/{id}/review` | Auto-review |
| POST | `/datasets/{id}/suggest-revisions` | Suggest fixes for flagged examples |
| GET | `/datasets/{id}/gaps` | Gap analysis |
| POST | `/datasets/{id}/export` | Export approved examples |
| POST | `/datasets/{id}/examples` | Create example |
| PATCH | `/datasets/{id}/examples/{eid}` | Update example |
| DELETE | `/datasets/{id}/examples/{eid}` | Delete example |

### Scorers

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions/{id}/generate-scorers` | Generate scorers from charter |
| PATCH | `/sessions/{id}/scorers` | Save scorers |

### Schema detection

| Method | Path | Description |
|--------|------|-------------|
| POST | `/detect-schema` | Detect schema from pasted content |
| POST | `/infer-schema` | Infer schema from examples |
| POST | `/import-from-url` | Extract schema from URL |

---

## Database

PostgreSQL with five tables:

| Table | Purpose |
|-------|---------|
| **sessions** | Full session state as JSONB (charter, validation, input, conversation history). |
| **charters** | Immutable snapshots created on finalization. |
| **turns** | Every LLM interaction logged with full input/output/metadata for replay. |
| **examples** | Dataset examples with verdict, revision suggestion, coverage tags. |
| **datasets** | Dataset metadata with charter snapshot and stats. |

---

## Setup

### Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e .

cp .env.example .env  # edit with your values
uvicorn app.main:app --port 8080 --reload
```

### Frontend
```bash
cd frontend
npm install --legacy-peer-deps
npm run dev
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| DATABASE_URL | postgresql://localhost:5432/northstar | PostgreSQL connection |
| ANTHROPIC_API_KEY | (required*) | Claude API key |
| OPENROUTER_API_KEY | — | OpenRouter API key (used only if `ANTHROPIC_API_KEY` is not set) |
| MODEL_NAME | claude-sonnet-4-20250514 | Model for all LLM calls |
| MAX_QUESTION_ROUNDS | 3 | Refinement rounds before soft_ok |

*Either `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` must be set. Anthropic takes priority when both are present. OpenRouter keys are auto-detected by their `sk-or-` prefix.
