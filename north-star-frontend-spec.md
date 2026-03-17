# Frontend Spec
**Charter generation agent — eval-driven development platform**

*Spec for the UI that surfaces the agent conversation and the live charter. Built to be evaluated against the north-star charter.*

---

## Stack

- **Framework:** React
- **Styling:** Tailwind
- **State:** React state + polling the `/sessions/{id}` endpoint after each turn
- **API:** calls the backend endpoints defined in the backend spec

---

## Layout

Split screen, two panels side by side.

```
┌─────────────────────────┬─────────────────────────┐
│                         │                         │
│    Conversation         │    Live Charter         │
│    (left panel)         │    (right panel)        │
│                         │                         │
│                         │                         │
└─────────────────────────┴─────────────────────────┘
```

On mobile: stacked vertically, conversation on top, charter below.

During review mode: conversation panel collapses, charter expands to full width.

---

## Left panel — conversation

### Progress bar
At the top of the panel. Shows which stage the agent is in.

```
[Intake] → [Drafting] → [Refining] → [Review]
```

Stages map to `agent_status` in state:
- `drafting` → Drafting
- `questioning` → Refining
- `soft_ok` → Refining (with soft OK banner)
- `hard_ok | review` → Review

---

### Chat messages
Standard chat layout. Agent messages on the left, user messages on the right.

Each agent message that contains a question includes a small tag showing which part of the charter is being worked on:

```
[Coverage] What does a bad outcome look like for a user of this feature?
```

The tag is subtle — a small coloured label, not prominent. It's there for users who want context, not mandatory to read.

---

### Soft OK banner
Appears between the last agent message and the input when `agent_status = "soft_ok"`.

```
┌─────────────────────────────────────────────────┐
│ I've done my best with what I have. A few        │
│ criteria are still uncertain:                    │
│ · Alignment — fit assessment criterion           │
│ · Rot — update triggers not specific enough      │
│                                                  │
│ [Keep refining]        [Proceed to review →]     │
└─────────────────────────────────────────────────┘
```

---

### Hard OK transition
When `agent_status = "hard_ok"`, the agent sends a completion message and the panel transitions automatically to review mode after 2 seconds. No button needed — the transition is smooth and automatic.

---

### Input
Simple text input at the bottom of the panel. Disabled while the agent is processing. Shows a typing indicator while waiting for the agent response.

"Proceed to review" link below the input — always visible, lets the user jump to review at any point.

---

## Right panel — live charter

Shows the charter as it builds. Each of the four dimensions is a collapsible section.

### Dimension section

```
▼ Coverage                                    ● good
  ───────────────────────────────────────────
  · Technical and non-technical roles         ✓
  · Senior and junior roles                   ✓
  · Sparse and detailed job descriptions      ✓
  · Large and small applicant pools           ⚠

▼ Alignment                                   ⚠ 2 weak
  ───────────────────────────────────────────
  Fit assessment                              ✓
  Strengths summary                           ⚠
  Interview questions                         ✓
  Red flags                                   ✗
```

Status indicators per criterion:
- `✓` green — passes validation
- `⚠` amber — weak, agent is working on it
- `✗` red — fails validation, needs attention
- `·` grey — pending, not yet validated

Section-level status badge:
- `● good` — all criteria passing
- `⚠ N weak` — some criteria still weak
- `✗ incomplete` — dimension not yet drafted

---

### Validation detail
Clicking a `⚠` or `✗` criterion expands a small tooltip showing the plain-language reason from the validation result.

```
⚠ Strengths summary
  "This criterion says outputs should be 'specific' —
   but what would a non-specific output look like?
   Needs an example of what bad looks like."
```

---

### In-progress indicator
When the agent calls `ask_user()` and tags a criterion, that criterion's indicator pulses to show it's being actively worked on. This connects the conversation on the left to the charter on the right — the user can see which question is fixing which criterion.

---

## Review mode

When `agent_status = "review"`, the layout changes:

- Conversation panel collapses to a narrow sidebar showing a summary of the session (rounds taken, what was refined)
- Charter expands to full width
- Each criterion becomes editable inline
- Weak criteria (flagged at soft OK finalization) are highlighted in amber with a note: "This criterion was uncertain — review before generating a dataset"
- A "Finalise charter" button appears at the bottom

### Editing a criterion
Clicking any criterion opens it for inline editing. The user types directly in the criterion text. On blur, the edit is saved to state via `PATCH /sessions/{id}/charter`.

No validation runs during review — the user is in control. Validation is an agent tool, not a review-mode feature.

---

## States and transitions

```
session created
      ↓
left panel: "Tell me about the AI feature you're building..."
right panel: all dimensions grey/pending
      ↓
agent drafts charter
right panel: sections start populating, indicators appear
      ↓
agent validates
right panel: indicators update to ✓ / ⚠ / ✗
      ↓
agent asks questions (questioning)
left panel: questions with charter tags
right panel: targeted criteria pulse
      ↓
[repeat validate → question loop]
      ↓
soft OK OR hard OK
      ↓
review mode
left panel: collapses to summary
right panel: expands, editable, finalise button
```

---

## Empty and loading states

- **New session, no charter yet:** right panel shows the four dimension sections as empty placeholders with light grey background
- **Agent processing:** show a typing indicator in the chat, dim the charter panel slightly
- **Validation running:** criterion indicators show a loading spinner briefly before resolving to ✓ / ⚠ / ✗
- **Session lost / error:** show an error banner in the left panel, offer to retry the last turn

---

## What this UI is evaluated against

From the north-star charter's alignment criteria, the frontend is doing its job if:

- A non-technical user can follow the conversation without encountering technical language
- The user can see at any point which criteria are passing, weak, or failing
- The connection between a question in the conversation and the criterion it's fixing is clear
- The soft OK gives the user a genuine choice without pressure
- The review mode makes it easy to edit weak criteria without starting over
