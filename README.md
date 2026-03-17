# North Star

An eval-driven development platform. A charter generation agent helps product and business people define what good AI output looks like for their AI features — before writing a single eval.

## What it does

You describe your AI feature (business goals + user stories), and the agent builds a **charter** — a structured document with four dimensions:

- **Coverage** — What input scenarios must be tested ("customer asks about a delayed order with no ETA")
- **Balance** — Which scenarios to weight more heavily and why ("escalation cases over-represented because that's where frustration occurs")
- **Alignment** — What good vs bad output looks like per feature area (observable, not intent-level)
- **Rot** — When examples become stale ("when the return policy changes")

The agent generates a draft, validates it against testability criteria, then refines through conversation. Every criterion must be specific enough that two people would make the same yes/no judgement on the same output.

## Architecture

```
frontend/          React 19 + TypeScript + Tailwind CSS v4 + Vite
backend/app/       FastAPI + Claude API + PostgreSQL
```

### Three-column UI

| Input | Charter | Agent |
|-------|---------|-------|
| Business goals, user stories grouped by role | Four charter dimensions with inline editing, suggestions | Conversational agent with text selection → respond |

### Backend structure

The backend separates concerns into three layers:

- **prompt.py** — All prompts. One function per prompt. Edit here to change what the agent says.
- **tools.py** — LLM call wrappers. Sends prompts to Claude, parses responses. Each call returns structured data + call metadata (model, tokens, latency).
- **agent.py** — Control flow only. Decides what to do each turn, orchestrates tool calls, logs turns. No prompts, no LLM calls.

### Agent flow

```
User sends input
  → agent.py decides mode (generate / chat / fallback)
  → tools.py calls Claude (prompt from prompt.py)
  → agent.py logs turn to DB (input, raw output, parsed result)
  → agent.py updates state, returns result to API
```

**Three modes:**

1. **Generate** (first turn or regenerate) — generate draft → validate → decide status → suggest
2. **Chat** (charter exists) — conversational turn → parse charter updates + suggestions → maybe revalidate
3. **Fallback** (no input) — ask for input

## Database

PostgreSQL with four tables:

### sessions
The main state store. One row per user session containing full state as JSONB (charter, validation, input, conversation history).

### charters
Immutable snapshots created on finalization. Contains the final charter + weak criteria at time of finalization.

### turns
**Every LLM interaction is logged.** One row per agent step (generate, validate, chat, suggest). Contains:
- `input_snapshot` — state at time of call
- `llm_calls` — array of `{model, prompt, raw_response, input_tokens, output_tokens, latency_ms}`
- `parsed_output` — structured result after parsing
- `agent_message` — final message shown to user
- `suggestions` — suggestions returned

This gives you full replay capability for any interaction.

### judgements
Decoupled quality scoring. Each row links to a turn and contains:
- `judge_model` — which model judged
- `scores` — dimension-specific scores (0.0–1.0), varying by turn type
- `reasoning` — judge's explanation

## Judging

The judge runs **on demand**, not on every turn. Call `POST /judge/run` when you want to evaluate agent quality.

```bash
# Judge all unjudged turns
curl -X POST http://localhost:5000/judge/run

# Judge turns for a specific session
curl -X POST "http://localhost:5000/judge/run?session_id=abc-123"

# View results
curl http://localhost:5000/judge/results
curl "http://localhost:5000/judge/results?session_id=abc-123"
```

**Scoring dimensions by turn type:**

| Turn type | Dimensions |
|-----------|-----------|
| generate | specificity, traceability, completeness, conciseness |
| validate | accuracy, strictness, actionability |
| chat | relevance, brevity, question_quality, update_accuracy |
| suggest | relevance, specificity, diversity |

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /sessions | Create session, run initial agent turn |
| POST | /sessions/{id}/message | Send user message, get agent response |
| POST | /sessions/{id}/proceed | Advance to review phase |
| GET | /sessions/{id} | Get full session state |
| PATCH | /sessions/{id}/charter | Edit charter items |
| POST | /sessions/{id}/finalize | Finalize charter |
| GET | /sessions/{id}/turns | Inspect all turns (debug) |
| POST | /judge/run | Run judge on unjudged turns |
| GET | /judge/results | View judgement scores |

## Setup

### Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Set environment variables
cp .env.example .env  # then edit with your values
# DATABASE_URL=postgresql://localhost:5432/northstar
# ANTHROPIC_API_KEY=sk-...

uvicorn app.main:app --port 5000
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
| ANTHROPIC_API_KEY | (required) | Claude API key |
| MODEL_NAME | claude-sonnet-4-20250514 | Model for agent + judge |
| MAX_QUESTION_ROUNDS | 3 | Rounds before soft_ok |
