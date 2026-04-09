# CLAUDE.md

## Project overview

North Star is an eval-driven development platform. A charter generation agent helps product/business people define what good AI output looks like — before writing a single eval. Users describe their AI feature through guided conversation, and the agent builds a charter (Coverage, Balance, Alignment, Rot) then helps generate a labeled dataset.

## Tech stack

- **Frontend:** React 19 + TypeScript + Vite 8 + Tailwind CSS v4 (uses `@theme` directive, not `tailwind.config.js`)
- **Backend:** FastAPI + Python 3.11+ + Anthropic SDK + PostgreSQL (asyncpg)
- **LLM:** Claude API via Anthropic SDK

## Architecture

```
frontend/src/          React SPA
backend/app/           FastAPI app
  prompt.py            All prompts (one function per prompt, edit here to change agent behavior)
  tools.py             LLM call wrappers (sends prompts, parses responses, captures metadata)
  agent.py             Control flow only (state transitions, orchestration — no prompts, no LLM calls)
  main.py              API endpoints + request handling
  models.py            Pydantic models
  db.py                PostgreSQL persistence layer
```

## Key patterns

- **5-phase state machine:** goals → users → stories → charter → dataset. Phase advances via `/advance-phase` endpoint.
- **Discovery phases:** One question per turn. Agent extracts goals/users/stories from conversation via `extraction` blocks in LLM responses.
- **Debounced reevaluation:** Charter edits trigger a 3-second debounce timer, then background re-validation via the agent.
- **Optimistic UI updates:** Frontend updates state immediately, agent catches up asynchronously.
- **Turn logging:** Every LLM interaction logged to `turns` table with full input/output/metadata for replay and judging.

## Commands

### Backend
```bash
cd backend
uv sync --dev         # Install deps (creates .venv automatically)
uv run uvicorn app.main:app --port 5000 --reload
```

### Frontend
```bash
cd frontend
npm install --legacy-peer-deps
npm run dev          # Dev server on :5173
npx tsc --noEmit     # Type check
```

### Database
```bash
# PostgreSQL must be running
# DATABASE_URL=postgresql://localhost:5432/northstar
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| DATABASE_URL | Yes | PostgreSQL connection string |
| ANTHROPIC_API_KEY | Yes | Claude API key |
| MODEL_NAME | No | Defaults to claude-sonnet-4-20250514 |

## Tailwind CSS v4 notes

- Uses `@theme` directive in CSS, not a JS config file
- Color tokens: `text-foreground`, `text-muted-foreground`, `bg-surface-raised`, `bg-background`, `border-border`, `bg-accent`, `text-accent-foreground`
- **Important:** `text-muted` maps to a background color — use `text-muted-foreground` for text

## Code conventions

- Frontend components live in `frontend/src/components/`. Sub-components for examples are in `components/examples/`.
- Types are centralized in `frontend/src/types.ts`.
- API client is in `frontend/src/api.ts` — all fetch calls go through here.
- Backend uses Pydantic models for all request/response validation.
- Agent extraction uses fenced code blocks (`\`\`\`extraction ... \`\`\``) parsed from LLM responses, not tool calls.
- Deduplication of extracted items (goals, users, stories) uses first-40-chars matching (case-insensitive).
