# Session Summary: Eval-Driven Development Platform

## What we built

A methodology and set of artifacts for a product that helps companies improve their AI features by putting datasets and evals at the center of the process.

The core thesis: **the bottleneck in AI improvement is the inability to agree on what "better" means.** Datasets and evals should be a product artifact, owned by product and business — not a dev artifact that lives in a repo nobody reads.

---

## The methodology

We developed a 9-step eval-driven development process:

1. Define business goals
2. Write user stories
3. Identify feature areas
4. Write a charter (Coverage, Balance, Alignment, Rot)
5. Define output specs per feature area
6. Build a labeled dataset
7. Write a judge prompt (LLM-as-judge)
8. Write and run evals
9. Set up production feedback loops

The charter is the anchor document. It defines what good data looks like, guides dataset creation, and prevents eval drift. The four charter dimensions:

- **Coverage** — what inputs must the dataset include?
- **Balance** — which cases are hardest and most important (over-represent these)?
- **Alignment** — what does good vs. bad output look like, per feature area?
- **Rot** — when does the dataset go stale?

---

## Client application: job hunting platform

We applied the full methodology to a real client scenario — a job hunting platform with an AI candidate matching feature.

**Documents produced:**
- `business-goals.md` — 5 business goals for the platform
- `hiring-manager-goals.md` — user stories across Screening, Evaluating, and Deciding stages
- `candidate-matching-charter.md` — charter for the AI matching feature, with 6 feature areas
- `output-specs.md` — output specs for all 6 feature areas (fit assessment, strengths summary, interview questions, red flags, candidate comparison, pass reasoning)
- `dataset-fit-assessment.json` — 11 labeled examples for the fit assessment feature area

---

## Own product application: the charter generation agent

We then used the methodology on the product itself — the agent that generates charters from business goals and user stories.

**Documents produced:**
- `north-star-business-goals.md` — 5 goals for the platform
- `north-star-user-stories.md` — 8 user stories (primary: PM/business owner; secondary: developer)
- `north-star-charter.md` — charter for the charter generation agent feature
- `north-star-agent-spec.md` — full LLM agent spec (loop, tools, state, system prompt, eval criteria)
- `north-star-backend-spec.md` — FastAPI backend (6 endpoints, agent runner, DB schema)
- `north-star-frontend-spec.md` — React + Tailwind split-screen UI (left: conversation, right: live charter)
- `north-star-dataset.json` — 6 labeled examples (sparse input, detailed input, conflicting input, partial input, existing evals, two-sentence input)
- `north-star-judge-prompt.md` — LLM judge with 4 rubrics (Coverage, Balance, Alignment, Rot) and JSON output
- `north-star-eval.py` — Python eval script using Anthropic SDK; runs each dataset example through the judge and reports accuracy

---

## Spec review

Before building, we ran a gap analysis on the agent spec against the charter and dataset. Six changes made to `north-star-agent-spec.md`:

1. **Sparse input handling** — agent asks one clarifying question before generating when input is very sparse
2. **Loop updated** — new step 2: sparse input → ask_user() before drafting
3. **Conflict detection** — `validate_charter` now requires conflicting inputs to be surfaced in the Balance section, not resolved or ignored
4. **Language rules** — banned words list added to conversation rules (charter, eval, criterion, dataset, LLM, prompt, etc.) — agent must use plain language with non-technical users
5. **`raw_docs` removed** — stripped from state object; document import not needed for MVP
6. **`hard_ok` removed** — `agent_status` simplified to `drafting | validating | questioning | soft_ok | review`; system prompt few-shot examples now explicitly sourced from `north-star-dataset.json`

---

## Key decisions

- **All outputs as .md files** — not .docx
- **Don't overwrite existing documents** — new documents get a prefix (e.g. `north-star-`)
- **Dataset is a design artifact** — maintaining a dataset is itself a design process; the charter guides both creation and ongoing curation
- **Judge is conservative** — a false positive (calling a weak charter good) is worse than a false negative
- **MVP scope** — no document import, no hard_ok transition, agent goes straight to review when all criteria pass

---

## Next step

Build the app. The specs are ready:

- Agent loop, tools, and state → `north-star-agent-spec.md`
- Backend API and DB → `north-star-backend-spec.md`
- Frontend UI → `north-star-frontend-spec.md`

Once there are real outputs, run `north-star-eval.py` to measure how well the agent generates charters, then calibrate the judge and iterate.
