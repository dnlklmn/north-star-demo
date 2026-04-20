# Plan: Remove Chat-First UX, Move to Direct Data Manipulation

## Context

The current app forces users through a chat-based agent conversation to build and refine charters. This adds friction — users want to directly input and manipulate the data they work with. The goal is to shift to a **tabbed single-view layout** where each phase (Input, Charter, Dataset) is a focused screen, with AI available as button-triggered actions and an optional collapsible assistant — not the primary interaction mode.

**Decision: Skip OpenUI.** The data structures are well-defined (Charter has fixed dimensions, Examples have a fixed schema). Current Tailwind components already support inline editing. No generative UI framework needed.

---

## Layout: Tabbed/Phased Single View

Replace the current multi-column layout with a single main content area that switches between phases via tabs or step navigation:

```
┌─────────────────────────────────────────────────┐
│  [Input]  [Charter]  [Examples]    [? AI assist] │  ← tab bar + optional assistant toggle
├─────────────────────────────────────────────────┤
│                                                  │
│           Active phase content                   │
│           (full width, scrollable)               │
│                                                  │
│                                                  │
├─────────────────────────────────────────────────┤
│  Phase-specific action bar                       │  ← Generate / Validate / Export etc.
└─────────────────────────────────────────────────┘
```

- **Input tab**: Business goals + user stories (existing InputColumn content, expanded to full width)
- **Charter tab**: All four dimensions + task definition, directly editable, with per-section AI action buttons
- **Examples tab**: Dataset examples table with generate/review/export actions
- **AI assistant**: Collapsible side panel (slide-out drawer), not a permanent column. Same agent, available when needed, but not the default interaction

---

## Implementation Phases

### Phase 1: Frontend layout restructuring

**Goal:** Replace multi-column layout with tabbed single view.

**Files to modify:**
- `frontend/src/App.tsx` — Major restructure:
  - Replace `openColumns`/`selectColumn`/`isColumnOpen` column management with a simple `activeTab: 'input' | 'charter' | 'examples'` state
  - Remove the column toggle/collapse logic and `CollapsedColumn` rendering
  - Add tab bar component at the top
  - Render only the active tab's content at full width
  - Keep `ConversationPanel` but move it to a slide-out drawer (toggle button in tab bar)
  - Tab availability: Input always available; Charter available after first generate; Examples available after finalize
- `frontend/src/components/InputColumn.tsx` — Adapt to full-width layout (currently constrained to column width)
- `frontend/src/components/CharterPanel.tsx` — Adapt to full-width (currently squeezed into a column)
- `frontend/src/components/ExampleReview.tsx` — Already fairly full-width, minor adjustments

**New component:**
- `frontend/src/components/TabBar.tsx` — Simple tab navigation with phase indicators

### Phase 2: Button-triggered AI actions on CharterPanel

**Goal:** Add explicit AI action buttons so users don't need to chat to get AI help.

**Files to modify:**
- `frontend/src/components/CharterPanel.tsx`:
  - Add "Validate" button to header → calls validate endpoint, shows results inline
  - Add "AI Suggest" button per dimension section → calls suggest endpoint scoped to that section
  - Add "Add criterion" button per section for manual entry (not just through suggestions)
  - Add "Add alignment entry" button for manual alignment rows
- `frontend/src/api.ts`:
  - Add `validateCharter(sessionId)` function
  - Add `suggestForSection(sessionId, section)` function
- `frontend/src/App.tsx`:
  - Add `handleValidate` and `handleSuggestSection` callbacks
  - Wire them to CharterPanel props

**Backend additions (new endpoints alongside existing ones):**
- `backend/app/main.py`:
  - `POST /sessions/{id}/validate` — calls `call_validate_charter` from tools.py, returns validation
  - `POST /sessions/{id}/suggest-section` — calls a focused suggestion prompt for one section
- `backend/app/prompt.py`:
  - Add `build_suggest_section_prompt(state, section)` for targeted per-section suggestions
- `backend/app/models.py`:
  - Add request/response models for new endpoints

### Phase 3: Simplify the ConversationPanel into an optional assistant

**Goal:** Keep the agent accessible but as a secondary, on-demand tool.

**Changes:**
- Move ConversationPanel into a slide-out drawer (right side)
- Toggle via a button in the tab bar (e.g., sparkles icon + "Ask AI")
- The agent still uses the existing `/sessions/{id}/message` and `/datasets/{id}/chat` endpoints
- Remove `showAgent` state, replace with `showAssistant` boolean for the drawer
- Remove debounced background message sending (no longer auto-sending edits to the agent)
- Remove `SoftOkBanner` — the agent-driven review flow is replaced by explicit Validate button

### Phase 4: State model cleanup

**Goal:** Simplify types and remove chat-first artifacts.

- `frontend/src/types.ts`:
  - Keep `AgentStatus` for backward compat but stop driving UI flow from it
  - Remove `conversation_history` from `SessionInput` (or make optional)
  - Remove `rounds_of_questions` from `SessionState` (or make optional)
- `frontend/src/App.tsx`:
  - Remove `messages` as a primary state driver — only used when assistant drawer is open
  - Remove `pendingChangesRef`/`debounceTimerRef` and debounced background sending
  - Remove `handleProceed`/`handleKeepRefining` (agent-flow specific)
  - Simplify `handleSubmitIntake` to just call createSession + getSession without managing messages

---

## What stays the same

- All existing backend endpoints remain functional (no breaking changes)
- `patchCharter` for direct editing (already works)
- Dataset action endpoints (`synthesize`, `review`, `gaps`, `export`, `import`)
- Schema detection (`detect-schema`, `import-from-url`)
- CharterPanel's inline editing (CriterionRow, AlignmentRow, EditableField, TaskField)
- The agent itself — just accessed differently

## Verification

1. Start dev server (`npm run dev` + backend)
2. Create a session with business goals → should see charter tab become active after generate
3. Click "Validate" on charter → should show inline validation results
4. Click "AI Suggest" on a section → should show suggestions for that section
5. Manually add/edit criteria → should persist via patchCharter
6. Open AI assistant drawer → should be able to chat with agent
7. Finalize → Examples tab becomes available
8. Generate/review/export examples from the Examples tab
