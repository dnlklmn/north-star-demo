# Process

How this project was built and where it's going.

---

## Phase 1: Design (complete)

Developed the eval-driven development methodology and applied it to both a client scenario (job hunting platform) and the product itself.

**Outputs:**
- 9-step methodology (goals → stories → charter → specs → dataset → judge → evals → feedback)
- Charter structure: Coverage, Balance, Alignment, Rot
- Full specs for agent, backend, and frontend
- 6-example labeled dataset (`north-star-dataset.json`)
- Judge prompt with 4 rubrics
- Eval script (`north-star-eval.py`)
- Spec review with 6 corrections (sparse input, conflict detection, language rules, etc.)

See `docs/session-summary.md` for full details.

---

## Phase 2: Build (complete)

Built the working app from the specs. Deviated from spec where it made sense.

### Backend

Separated agent code into three layers for maintainability:
- **prompt.py** — all prompts, one function per prompt
- **tools.py** — LLM call wrappers with metadata capture (model, tokens, latency)
- **agent.py** — pure control flow, no prompts, no LLM calls

Added turn-level persistence beyond what the spec called for. Every LLM interaction is logged to a `turns` table with full input/output context. This enables replay, debugging, and batch judging.

Added on-demand judge system. `POST /judge/run` scores unjudged turns with dimension-specific rubrics per turn type (generate, validate, chat, suggest). Runs when you decide, not on every turn.

### Frontend

Evolved from the spec's 2-panel layout to a 3-column layout:

| Input | Charter | Agent |
|-------|---------|-------|
| Business goals, role-grouped user stories, suggested stories | Four dimensions with inline editing, suggestions, live completion | Chat with text selection → respond |

### Database

4 tables: `sessions`, `charters`, `turns`, `judgements`

---

## Phase 3: Chat-First Discovery + Dataset (complete)

Replaced the static input form with a structured, one-question-at-a-time conversational flow and added full dataset management.

### Discovery flow

Split discovery into 3 sub-phases: **goals → users → stories**. Each phase:
- Agent asks one question per turn using consulting frameworks (issue tree decomposition, JTBD, MECE)
- Extracts entities (goals, users, stories) from conversation via structured extraction blocks
- Users can also edit extracted items directly in the left panel
- Phase advances via explicit user action ("Move to Users →") or agent readiness signal

### Charter improvements

- **Flat layout** — removed collapsible cards, all sections visible
- **Radar chart** — SVG spider chart showing all 4 dimension scores
- **Unified progress bars** — percentage + action text + soft OK threshold marker
- **Task definition** — 2-field (input/output) with multi-entry support
- **Manual add** — "+ Add" buttons for criteria and alignment entries
- **Debounced reevaluation** — 3-second timer on edits, then background re-validation

### Dataset features

- **Generate examples** — minimum coverage (1 per scenario) or custom amount via modal
- **Import** from CSV/JSON files
- **Auto-review** with LLM judge (label, confidence, reasoning per example)
- **Coverage map** — criteria × feature area matrix with radar chart, gap detection
- **Fill gaps** — generate targeted examples for uncovered scenarios
- **Keyboard navigation** — arrow keys to navigate, A/R/E/L shortcuts for review
- **Export** approved examples as JSON

### 5-step progress bar

Goals → Users → Stories → Charter → Dataset. Each step shows count badges, descriptions, and allows clicking back to completed steps.

### Key technical decisions

| Decision | Rationale |
|----------|-----------|
| One question per turn | Prevents overwhelming users. Consulting methodology (issue trees, JTBD) ensures depth. |
| Extraction blocks (not tool calls) | Simpler parsing, works with any model. Embedded in LLM response text. |
| Deduplication by first 40 chars | Prevents re-extraction of previously identified items. Case-insensitive matching. |
| Per-scenario → total count | User thinks in total examples, backend thinks in per-scenario. Modal handles conversion. |
| Optimistic UI + debounced background | Non-blocking editing. User sees changes instantly, agent catches up after 3s debounce. |

---

## Phase 4: Evaluate (next)

### Run evals on real sessions
- Use the app to generate several charters with different inputs
- Run `POST /judge/run` to score all turns
- Compare judge scores against manual assessment
- Identify where the agent is weakest

### Calibrate the judge
- Run `north-star-eval.py` against the labeled dataset examples
- Compare judge output to expected labels
- Adjust judge prompts based on disagreements

### Fix known agent issues
- **Over-generation**: agent sometimes produces 5+ criteria from sparse input
- **Chat regeneration**: agent sometimes regenerates the full charter on chat turns
- **Brevity**: agent responses still too verbose despite prompt instructions

---

## Phase 5: Iterate (future)

- Output specs per feature area
- Multi-session charter comparison
- Team collaboration (multiple users on one charter)
- Document import
- Production feedback loops (see *Connector design* below)

---

## Connector design

North Star stops at the dataset. Running evals happens in external frameworks — `skill-creator` for triggering evals, Braintrust / Promptfoo / custom harnesses for execution. Connectors ship the dataset out and, in the two-way version, ingest signal back.

### One-way vs two-way

**One-way (export-only):** North Star pushes dataset rows to the target framework's format. Low commitment, ship first.

**Two-way (export + ingest):** results flow back and feed two separate surfaces of the charter:

| Signal source | Feeds | What it catches |
|---------------|-------|-----------------|
| Eval platform results (pass/fail per row, judge disagreement) | **Dataset quality** | Regression on known cases, flaky rows, flawed labels |
| Product telemetry (thumbs, edits, escalations, unexpected prompts) | **Charter** | Missed stories, goals the user didn't state, new user types |

### Implications for Rot

Without two-way connectors, Rot is limited to **intent drift** — "does this charter still match the goals/users/stories the user described?" Introspective only: the agent re-reads the charter against stated intent.

**Production drift** — "eval scores degrading, new failure modes emerging in the wild" — requires results flowing back. That is what makes eval-driven development iterative rather than one-shot.

### Shipping order

1. **Export connectors first.** One per target framework (skill-creator, Braintrust, Promptfoo, custom JSON). Immediate value.
2. **Eval-platform ingest.** Parse results into North Star, flag regressed rows, re-run the judge on label disagreements. Feeds dataset quality.
3. **Product telemetry ingest.** Biggest payoff for PM/business users but requires a live product. Feeds charter suggestions ("users keep asking X, no story covers it — add one?").

### Connector contract (sketch)

Each connector declares:
- `export(dataset) -> framework_payload` — required
- `ingest(framework_result) -> { row_updates, charter_suggestions }` — optional, unlocks two-way

Framework-specific quirks (skill-creator wants `{prompt, should_trigger}`, Braintrust wants `{input, expected, metadata}`) live in the connector, not in North Star's core schema.

---

## Architecture decisions

| Decision | Rationale |
|----------|-----------|
| Separate prompt/tools/agent | Prompts change constantly during iteration. Control flow changes rarely. Keep them apart so prompt tuning doesn't risk breaking orchestration. |
| Turn-level logging | You can't improve what you can't measure. Logging every LLM call with full context lets you replay, debug, and judge any interaction. |
| On-demand judging | Running judge on every turn adds latency and cost. Batch judging when you're ready to look at results is cheaper and gives you control. |
| 3-column layout | Input, output, and agent all visible simultaneously. No mode switching. User can work on input while reading agent feedback. |
| Suggestions as first-class UI | One-click additions reduce friction. The agent can propose, the user decides. Acceptance feeds back to the agent. |
| Non-blocking editing | The agent thinking shouldn't block the user from working. Charter editing and input changes happen locally, agent catches up. |
