# Dataset Management Spec

Extends the platform from charter generation into dataset creation, review, and curation. The same agent that builds the charter helps create and curate the dataset.

---

## Concepts

### Example

An input/output pair for one of the charter's feature areas. The atomic unit of a dataset.

```
{
  id: string
  feature_area: string          // maps to a charter alignment entry
  input: string                 // the scenario / user input
  expected_output: string       // what good output looks like
  coverage_tags: string[]       // which coverage criteria this hits
  source: "imported" | "synthetic" | "manual"
  label: "good" | "bad" | "unlabeled"
  label_reason: string | null
  review_status: "pending" | "approved" | "rejected" | "needs_edit"
  reviewer_notes: string | null
  judge_verdict: { suggested_label, confidence, reasoning } | null
  created_at: timestamp
  updated_at: timestamp
}
```

- **feature_area** links to the charter's alignment entries — this is how we know which good/bad definition to judge against
- **coverage_tags** link to charter coverage criteria — this is how we find gaps
- **source** tracks provenance
- **label** (what is this example?) and **review_status** (has a human verified it?) are separate concerns

### Dataset

A versioned collection of examples tied to a charter.

```
{
  id: string
  session_id: string            // links to the charter session
  version: number               // increments on each snapshot
  parent_version_id: string | null
  name: string
  status: "draft" | "in_review" | "approved"
  stats: {                      // cached, updated on mutations
    total: number
    by_review_status: { pending, approved, rejected, needs_edit }
    by_label: { good, bad, unlabeled }
    by_feature_area: { [area]: number }
    coverage_gaps: string[]     // coverage criteria with 0 examples
    balance_gaps: string[]      // under-represented per balance criteria
  }
  charter_snapshot: Charter     // charter at time of version creation
  created_at: timestamp
}
```

### Versioning

Each dataset version is an immutable snapshot. When the user enriches or modifies examples and wants to save progress, a new version is created. The working state is always "draft" until explicitly versioned.

- **Create version**: snapshot current examples + charter state → new version row, examples are copied
- **Compare versions**: diff example counts, coverage gaps, approval rates
- **Roll back**: restore a previous version as the new working draft

---

## Two paths in

### Path A: Import

User has existing data (production logs, test cases, labeled examples).

1. Upload JSON or CSV
2. Map fields — minimum: `input` and `expected_output`. Agent suggests mappings if column names are ambiguous.
3. Assign feature areas — agent suggests based on charter alignment entries, user confirms
4. Tag coverage criteria — agent suggests based on charter coverage entries
5. All imported examples start as `label: "unlabeled"`, `review_status: "pending"`

**JSON format** (array of objects):
```json
[
  {
    "input": "Customer asks about delayed order #4521",
    "expected_output": "Your order #4521 is currently delayed...",
    "feature_area": "order tracking",
    "label": "good"
  }
]
```

Only `input` and `expected_output` are required. Everything else is optional and can be assigned during review.

**CSV format**: headers map to the same fields. First row is header.

### Path B: Synthesize

No existing data. Agent generates examples from the charter.

1. For each coverage criterion, generate 1+ example
2. For each feature area, generate both good and bad outputs (guided by alignment definitions)
3. Balance criteria guide how many examples per scenario type
4. All synthetic examples start as `review_status: "pending"` — never auto-approved
5. Labels are pre-assigned since the agent generates good/bad intentionally

The agent uses the charter as its only source of truth:
- Coverage criteria → input scenarios
- Alignment definitions → expected outputs (good and bad)
- Balance criteria → distribution weighting
- Rot criteria → metadata about staleness conditions

### Hybrid

Most real usage will combine both paths. Import what you have, identify gaps via coverage analysis, synthesize examples for the gaps, review everything.

---

## Review flow

The core interaction. A human looks at each example and decides.

### Actions per example

| Action | Effect |
|--------|--------|
| **Approve** | `review_status: "approved"`, example is part of the dataset |
| **Edit** | Inline edit input/output, then approve |
| **Reject** | `review_status: "rejected"`, example is excluded |
| **Relabel** | Flip `label` between good/bad/unlabeled |
| **Flag** | `review_status: "needs_edit"`, add reviewer notes |

### Auto-review (judge)

Run the judge against all pending examples. For each example, the judge checks:
- Does the input match a coverage scenario?
- Does the output match the alignment definition for its feature area and label?
- Is the label correct given the output quality?

Returns a `judge_verdict` with suggested label, confidence, and reasoning. Shown as a suggestion — human has final say.

### Charter context during review

The review UI always shows the relevant charter context for the current example:
- The alignment definition (good/bad) for the example's feature area
- Which coverage criteria the example maps to
- The balance guidance for this scenario type

This is how a reviewer makes consistent yes/no calls — they're comparing the example against the charter, not using personal judgement.

---

## Charter change detection

When the charter is edited after a dataset exists:

1. **Detect affected examples** — if an alignment definition changes, flag all examples in that feature area. If a coverage criterion is added/removed, flag coverage gaps.
2. **Notify the user** — "The charter has changed. X examples may need re-review."
3. **Offer re-review** — run the judge against affected examples with the updated charter
4. **Track lineage** — the dataset version records which charter snapshot it was reviewed against

This prevents drift between what the charter says and what the dataset contains.

---

## Enrichment

After initial review, the dataset has gaps. Enrichment fills them.

### Gap types

| Gap | Detection | Resolution |
|-----|-----------|------------|
| **Coverage gap** | Coverage criterion has 0 approved examples | Generate or manually add examples |
| **Balance gap** | Scenario type is under-represented per balance criteria | Generate more examples for that type |
| **Label gap** | Feature area has only good examples (or only bad) | Generate the missing label type |
| **Weak examples** | Judge gave low confidence | Flag for human attention |
| **Feature area gap** | Feature area has 0 examples | Generate examples for all coverage scenarios in that area |

### Enrichment flow

1. Run gap analysis → shows what's missing
2. User picks which gaps to fill
3. Agent generates candidate examples for selected gaps
4. New examples enter review flow (always `review_status: "pending"`)
5. Repeat until coverage is satisfactory

---

## Database

### New tables

```sql
CREATE TABLE datasets (
  id              TEXT PRIMARY KEY,
  session_id      TEXT REFERENCES sessions(id),
  version         INTEGER NOT NULL DEFAULT 1,
  parent_version_id TEXT REFERENCES datasets(id),
  name            TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',
  stats           JSONB NOT NULL DEFAULT '{}',
  charter_snapshot JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE examples (
  id              TEXT PRIMARY KEY,
  dataset_id      TEXT REFERENCES datasets(id),
  feature_area    TEXT NOT NULL,
  input           TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  coverage_tags   JSONB NOT NULL DEFAULT '[]',
  source          TEXT NOT NULL DEFAULT 'manual',
  label           TEXT NOT NULL DEFAULT 'unlabeled',
  label_reason    TEXT,
  review_status   TEXT NOT NULL DEFAULT 'pending',
  reviewer_notes  TEXT,
  judge_verdict   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_examples_dataset ON examples(dataset_id);
CREATE INDEX idx_examples_review ON examples(dataset_id, review_status);
CREATE INDEX idx_examples_feature ON examples(dataset_id, feature_area);
```

### DB functions

- `create_dataset(session_id, name, charter_snapshot)` → dataset row
- `get_dataset(dataset_id)` → dataset with stats
- `create_version(dataset_id)` → new version with copied examples
- `get_versions(session_id)` → version history
- `create_example(dataset_id, ...)` → example row
- `bulk_create_examples(dataset_id, examples[])` → batch insert
- `get_examples(dataset_id, filters)` → filtered example list
- `update_example(example_id, fields)` → update example
- `get_coverage_analysis(dataset_id)` → gaps and stats
- `export_dataset(dataset_id)` → JSON export of approved examples

---

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | /sessions/{id}/dataset | Create dataset for this session's charter |
| GET | /sessions/{id}/dataset | Get current dataset with stats |
| GET | /datasets/{id}/versions | List all versions |
| POST | /datasets/{id}/version | Create new version snapshot |
| POST | /datasets/{id}/import | Upload examples (JSON/CSV) |
| POST | /datasets/{id}/synthesize | Generate examples from charter |
| GET | /datasets/{id}/examples | List examples (filter: feature_area, label, review_status, source) |
| PATCH | /datasets/{id}/examples/{eid} | Edit example, change label, approve/reject |
| POST | /datasets/{id}/examples | Add manual example |
| DELETE | /datasets/{id}/examples/{eid} | Remove example |
| POST | /datasets/{id}/review | Run auto-review (judge against charter) |
| GET | /datasets/{id}/gaps | Coverage + balance gap analysis |
| POST | /datasets/{id}/enrich | Generate examples for specified gaps |
| GET | /datasets/{id}/export | Export approved examples as JSON |

---

## UI

### App phases

The app has two phases, with the agent column persistent throughout:

```
Phase 1: Charter          Phase 2: Dataset
┌─────────┬───────────┐   ┌─────────┬───────────┐
│  Input   │  Charter  │   │ Charter │ Examples  │
│          │           │   │ (read)  │ (review)  │
│  goals   │  4 dims   │   │         │           │
│  stories │  editing  │   │ context │ cards     │
│          │           │   │ for     │ approve   │
│          │           │   │ review  │ edit      │
│          │           │   │         │ reject    │
└─────────┴───────────┘   └─────────┴───────────┘
           ┌──────────┐              ┌──────────┐
           │  Agent   │              │  Agent   │
           │ (dark bg)│              │ (dark bg)│
           │          │              │          │
           │  same    │              │  same    │
           │  agent   │              │  agent   │
           └──────────┘              └──────────┘
```

### Phase transition

After charter finalization, the left column changes from input (goals/stories) to a read-only charter view. The center column changes from charter editing to example review. The agent column stays — same conversation, same context.

The finalize button becomes "Start dataset" which transitions to Phase 2.

### Layout: Phase 2

**Left column — Charter (read-only context)**
- Shows all four charter dimensions
- Currently selected feature area is highlighted
- Alignment definition (good/bad) shown prominently for the feature area of the current example
- Coverage criteria shown with checkmarks for criteria that have approved examples
- Non-editable in this phase (go back to Phase 1 to edit, which triggers change detection)

**Center column — Example review**
- Top bar: filter by feature_area, label, review_status, source + action buttons (Import, Generate, Auto-review, Export)
- Example cards showing:
  - Input (the scenario)
  - Expected output
  - Source badge (imported / synthetic / manual)
  - Label badge (good / bad / unlabeled)
  - Judge verdict (if auto-review has run): suggested label + confidence
  - Review actions: Approve / Edit / Reject / Relabel / Flag
- Inline editing: click to edit input or output directly
- Empty state: "Import existing data or generate examples from your charter"
- Batch actions: approve all, reject filtered, etc.

**Right column — Agent (persistent, dark background)**
- Same agent conversation from charter phase
- Agent is now aware of dataset context
- Can ask: "generate 3 more examples for the escalation feature area"
- Can ask: "why did the judge flag this example?"
- Can ask: "what coverage gaps do we still have?"
- Background is visually separated — darker than the rest of the app to distinguish it as a persistent tool panel rather than content

### Coverage map (floating overlay)

Triggered by a button in the top bar ("Coverage map" or a grid icon).

Shows a matrix/heatmap:
- Rows: coverage criteria
- Columns: feature areas
- Cells: count of approved examples (colored: 0 = red, 1-2 = amber, 3+ = green)
- Bottom row: balance indicator — is the distribution matching balance criteria?

This is an overlay/modal, not a permanent panel. The user opens it to assess gaps, then closes it and works on filling them.

### Agent column styling

The agent column needs stronger visual separation:

```css
/* New CSS variable for agent panel */
:root {
  --agent-bg: #f0f0f0;        /* light mode: slightly darker than surface */
}
.dark {
  --agent-bg: #050505;         /* dark mode: darker than background */
}
```

The agent column uses `bg-agent` (or equivalent) to be visually distinct from content panels. This communicates "persistent tool" rather than "content you're editing."

---

## Agent behavior in dataset phase

The agent's system prompt extends when entering the dataset phase. It gains:

### New capabilities
- "Generate examples for [feature area / coverage criterion]"
- "Explain why this example was flagged"
- "Suggest improvements for this example"
- "Run coverage analysis"
- "What gaps remain?"

### Context awareness
The agent always has access to:
- The finalized charter
- Current dataset stats (total examples, gaps, approval rate)
- The example currently being reviewed (if any)

### Conversational patterns
- User selects an example → agent shows charter context: "This example is for **order tracking**. Good output should: [alignment definition]. The judge gave it **medium confidence** because [reason]."
- User asks "what's missing?" → agent runs gap analysis and summarizes: "You have 0 examples for 'customer asks about delayed order.' Want me to generate some?"
- User says "generate bad examples for returns" → agent creates intentionally bad outputs per the alignment definition, adds as pending examples

---

## Export

`GET /datasets/{id}/export` returns all approved examples as JSON:

```json
{
  "dataset_id": "...",
  "charter_id": "...",
  "version": 3,
  "exported_at": "2026-03-17T...",
  "examples": [
    {
      "id": "...",
      "feature_area": "order tracking",
      "input": "Customer asks about delayed order #4521",
      "expected_output": "Your order #4521 is currently delayed...",
      "coverage_tags": ["delayed order", "no ETA"],
      "label": "good",
      "label_reason": "Matches alignment: states exact status without caveats"
    }
  ]
}
```

Only approved examples are exported. The export includes the charter version it was reviewed against.
