# North Star

An eval-driven development platform. A charter generation agent helps product and business people define what good AI output looks like for their AI features — before writing a single eval.

## What it does

You describe your AI feature through a guided conversation, and the agent builds a **charter** — a structured document with four dimensions:

- **Coverage** — What input scenarios must be tested ("customer asks about a delayed order with no ETA")
- **Balance** — Which scenarios to weight more heavily and why ("escalation cases over-represented because that's where frustration occurs")
- **Alignment** — What good vs bad output looks like per feature area (observable, not intent-level)
- **Rot** — When examples become stale ("when the return policy changes")

The agent then helps you **generate a labeled dataset** from the charter, review examples, analyze coverage gaps, and export for evaluation.

## Flow

The app guides users through 5 phases:

1. **Goals** — Define business goals through one-question-at-a-time conversation
2. **Users** — Identify user types and personas
3. **Stories** — Describe what each user type needs to accomplish
4. **Charter** — Agent generates and validates the charter; user refines via conversation or direct editing
5. **Dataset** — Generate examples, review (manual or auto), analyze coverage, export

Each discovery phase (goals, users, stories) uses structured extraction — the agent asks one question per turn and extracts entities from the conversation. Users can also edit the extracted items directly in the left panel.

## Architecture

```
frontend/          React 19 + TypeScript + Tailwind CSS v4 + Vite
backend/app/       FastAPI + Claude API + PostgreSQL
```

### Three-column UI

| Input | Charter / Dataset | Agent |
|-------|-------------------|-------|
| Business goals, user types, stories grouped by role | Charter dimensions with radar chart, progress bars, inline editing, suggestions | Conversational agent, one question at a time |

### Backend structure

The backend separates concerns into three layers:

- **prompt.py** — All prompts. One function per prompt. Edit here to change what the agent says.
- **tools.py** — LLM call wrappers. Sends prompts to Claude, parses responses. Each call returns structured data + call metadata (model, tokens, latency).
- **agent.py** — Control flow only. Decides what to do each turn, orchestrates tool calls, logs turns. No prompts, no LLM calls.

### Agent flow

```
User sends input
  → agent.py decides mode (discovery / generate / chat / fallback)
  → tools.py calls Claude (prompt from prompt.py)
  → agent.py logs turn to DB (input, raw output, parsed result)
  → agent.py updates state, returns result to API
```

**Modes:**

1. **Discovery** (goals/users/stories phases) — one question per turn, extract entities, signal readiness to advance
2. **Generate** (charter phase, first entry or regenerate) — generate draft → validate → decide status → suggest
3. **Chat** (charter exists) — conversational turn → parse charter updates + suggestions → maybe revalidate
4. **Dataset** — generate examples, review, gap analysis, coverage map

## Database

PostgreSQL with four tables:

### sessions
The main state store. One row per user session containing full state as JSONB (charter, validation, input, conversation history, discovery phase).

### charters
Immutable snapshots created on finalization. Contains the final charter + weak criteria at time of finalization.

### turns
**Every LLM interaction is logged.** One row per agent step (discover, generate, validate, chat, suggest, synthesize, review). Contains:
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

## Dataset features

- **Generate examples** from charter — minimum coverage (1 per scenario) or custom amount
- **Import** from CSV or JSON
- **Auto-review** with LLM judge (label suggestions + confidence)
- **Coverage map** — matrix of criteria × feature areas with radar chart visualization
- **Gap analysis** — identify uncovered scenarios and generate targeted examples
- **Keyboard navigation** — arrow keys, A/R/E/L shortcuts for review workflow
- **Export** approved examples as JSON

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /sessions | Create session, run initial agent turn |
| POST | /sessions/{id}/message | Send user message, get agent response |
| POST | /sessions/{id}/advance-phase | Advance to next discovery phase or charter |
| GET | /sessions/{id} | Get full session state |
| PATCH | /sessions/{id}/charter | Edit charter items |
| PATCH | /sessions/{id}/goals | Edit extracted goals |
| PATCH | /sessions/{id}/users | Edit extracted users |
| PATCH | /sessions/{id}/stories | Edit extracted stories |
| POST | /sessions/{id}/proceed | Advance to dataset phase |
| POST | /sessions/{id}/finalize | Finalize charter |
| POST | /datasets/{id}/synthesize | Generate examples |
| POST | /datasets/{id}/review | Auto-review examples |
| GET | /datasets/{id}/gaps | Coverage gap analysis |
| POST | /datasets/{id}/export | Export approved examples |
| POST | /judge/run | Run judge on unjudged turns |
| GET | /judge/results | View judgement scores |

## Setup

### Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e .

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
