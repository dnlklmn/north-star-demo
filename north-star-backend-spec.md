# Backend Spec
**Charter generation agent — eval-driven development platform**

*Spec for the backend that runs the agent loop, manages state, and exposes the API the frontend consumes.*

---

## Stack

- **Runtime:** Python 3.11+
- **Framework:** FastAPI
- **LLM:** Claude API with tool use
- **Database:** PostgreSQL (sessions and charters), with JSON columns for flexible charter structure
- **State storage:** session state stored in Postgres, read on every turn
- **Auth:** simple API key to start — user auth can come later

---

## API endpoints

### `POST /sessions`
Create a new charter generation session.

**Request:**
```json
{
  "initial_input": {
    "business_goals": "string | null",
    "user_stories": "string | null",
    "raw_docs": "string | null"
  }
}
```
**Response:**
```json
{
  "session_id": "string",
  "agent_status": "drafting",
  "message": "string"
}
```

---

### `POST /sessions/{session_id}/message`
Send a user message to the agent. This is the main turn endpoint — the agent reads the message, updates state, runs the loop step, and returns a response.

**Request:**
```json
{
  "message": "string"
}
```
**Response:**
```json
{
  "message": "string",
  "agent_status": "questioning | soft_ok | hard_ok | review",
  "state": { /* full session state — see agent spec */ },
  "tool_calls": [ /* which tools were called this turn, for debugging */ ]
}
```

---

### `POST /sessions/{session_id}/proceed`
User-initiated soft OK — proceed to review regardless of validation status.

**Response:**
```json
{
  "agent_status": "review",
  "state": { /* full session state with weak criteria flagged */ }
}
```

---

### `GET /sessions/{session_id}`
Get current session state. Used by the frontend to poll or restore a session.

**Response:** full session state object

---

### `PATCH /sessions/{session_id}/charter`
User edits to the charter during review. Accepts a partial charter update and writes it to state.

**Request:** partial charter object (only the fields being edited)
**Response:** updated session state

---

### `POST /sessions/{session_id}/finalize`
Mark the charter as finalised and ready for dataset generation. Called after the user is satisfied with the review.

**Response:**
```json
{
  "charter_id": "string",
  "session_id": "string",
  "charter": { /* final charter object */ }
}
```

---

## Agent runner

The core backend module. Called by the `/message` endpoint on every turn.

```
function run_agent_turn(session_id, user_message):
  1. load session state from db
  2. append user_message to conversation_history
  3. call Claude API with:
       - system prompt (from system_prompt module)
       - conversation history
       - tool definitions
       - current state as context
  4. handle tool calls in response:
       - generate_draft → call generate_draft_handler(), update state.charter
       - validate_charter → call validate_charter_handler(), update state.validation
       - ask_user → extract questions, update state.agent_status = "questioning"
       - signal_soft_ok → update state.agent_status = "soft_ok"
       - finalize → update state.agent_status = "review"
  5. check exit conditions:
       - all validation passing → set agent_status = "hard_ok", call finalize
       - rounds_of_questions >= 3 and still failing → call signal_soft_ok
  6. save updated state to db
  7. return response message + updated state
```

---

## Tool handlers

### `generate_draft_handler(session_state)`
Calls Claude with the current input and a focused prompt to produce a structured charter object. Returns a charter with all four dimensions populated.

- Uses a dedicated generation prompt (separate from the main system prompt) that includes few-shot examples of good charters
- Returns structured JSON matching the charter schema
- Handles partial input gracefully — produces what it can and marks the rest as "pending"

### `validate_charter_handler(charter)`
Calls Claude with the current charter and the validation rules from the agent spec. For each criterion, returns pass/weak/untested with a plain-language reason for anything that isn't passing.

- Runs as a separate LLM call with a focused validation prompt
- Each criterion is validated independently — no holistic judgment
- Returns structured JSON matching the validation schema

### `system_prompt_builder()`
Builds the system prompt from its four sections (role, charter structure, validation rules, conversation rules). Loads few-shot examples from a separate examples file so they can be updated independently.

---

## Database schema

### `sessions`
```
id              uuid primary key
created_at      timestamp
agent_status    text
state           jsonb  -- full session state object
conversation    jsonb  -- array of message turns
```

### `charters`
```
id              uuid primary key
session_id      uuid references sessions(id)
created_at      timestamp
finalised_at    timestamp | null
charter         jsonb  -- final charter object
weak_criteria   jsonb  -- list of criteria flagged as weak at finalization
```

---

## Error handling

- **LLM timeout:** retry up to 3 times with exponential backoff, then return an error message to the user
- **Malformed tool response:** log the error, return the conversation without a state update, ask the user to rephrase
- **Validation loop:** if validate_charter returns all-pass but generate_draft keeps changing the charter, cap at 5 generate/validate cycles and surface soft OK
- **Empty input:** if the user sends an empty or very short message, ask a clarifying question rather than attempting a draft

---

## Logging

Log every turn with:
- session_id
- agent_status before and after
- which tools were called
- validation result (pass/fail counts)
- rounds_of_questions
- whether the turn ended in a question, soft OK, hard OK, or review

This is the data that feeds your own evals for the agent — without it you can't measure criterion testability rate, rounds to completion, or edit rate during review.

---

## Environment variables

```
ANTHROPIC_API_KEY
DATABASE_URL
MODEL_NAME              # e.g. claude-opus-4-5-20251101
MAX_QUESTION_ROUNDS     # default 3
```
