# North Star Production Monitoring with Langfuse — Implementation Plan

> **Superseded.** We are using Braintrust for offline evaluation already (`braintrust.wrap_anthropic` and `braintrust.Eval()` in `backend/app/eval_runner.py`). The right call is to extend that integration into production monitoring rather than introduce a second tool. See `north-star-braintrust-plan.md` for the active plan. Keeping this document for reference and for the Langfuse-vs-Braintrust comparison notes.

---


## Why this matters

We need to dogfood production monitoring on North Star itself. Two reasons.

- **Practical.** We have real production traffic on our own product (design partners, internal use). We should be measuring its quality the way we want our customers to measure theirs.
- **Strategic.** Setting this up ourselves teaches us exactly what a customer feels when they wire North Star into their stack alongside an eval execution harness. Every friction point we hit will be one our customers hit too. Every scorer that does not produce useful signal will teach us something about the product roadmap.

## End state

When this is done, the team has:

- Every Charter Agent LLM call captured as a trace in Langfuse, with metadata about which phase (goals, users, stories, charter, dataset) it belongs to
- Quality scorers running on every charter generated, using our existing judge prompt
- Additional scorers for the other phases (goal extraction quality, conversation quality)
- Dashboards showing quality over time, cost per session, latency, and error rates
- Slack or email alerts on regressions

---

## Setup steps

### Step 1 — Pick a deployment mode (1 hour)

- **Langfuse Cloud (recommended for first pass).** Free tier. Sign up at langfuse.com, get API keys. Fastest to get running. Data sits in Langfuse's cloud.
- **Self-host via Docker (only if data residency matters).** `docker compose` setup, point to your own Postgres. Takes a half day. Worth doing only if you cannot send data to Langfuse Cloud.

For dogfooding, start with Cloud. Move to self-host if/when you have customers who care.

### Step 2 — Install the SDK (15 minutes)

```bash
cd backend
pip install langfuse
```

Add env vars to `.env`:

```
LANGFUSE_PUBLIC_KEY=...
LANGFUSE_SECRET_KEY=...
LANGFUSE_HOST=https://cloud.langfuse.com
```

### Step 3 — Instrument the LLM calls (half day)

Touch one file: `backend/app/tools.py`. This is where all LLM calls live (per CLAUDE.md), so this is the only place that needs to change.

Pattern (depending on which Langfuse SDK pattern you prefer):

- **Wrapped client**: replace `anthropic.Anthropic()` with the Langfuse-wrapped client. Auto-traces inputs, outputs, latency, token counts.
- **Decorator**: add `@observe()` on each tool function. Slightly more explicit, lets you control trace structure.

For each call, attach metadata in the trace:

- `session_id` — the Charter session this call belongs to
- `phase` — one of goals, users, stories, charter, dataset
- `user_id` — whoever is interacting (or anonymous design partner ID)
- `model_name` — so cost-per-model is visible
- `turn_number` — within the session

That metadata is what lets every later view (filter, group, alert) work cleanly.

### Step 4 — Configure scorers (half day)

In Langfuse, scorers are "evaluations" that run against captured traces. Start with three.

**Scorer 1 — Charter quality (uses existing `north-star-judge-prompt.md`)**

- Triggered on: every trace where `phase = "charter"` and a charter has been generated
- Returns: per-dimension score (Coverage, Balance, Alignment, Rot) and an overall verdict
- Frequency: every charter (low volume, no sampling needed)

This is the fastest one to ship since the prompt already exists. The result of this scorer is the headline number on the dashboard.

**Scorer 2 — Goal extraction quality (new, smaller LLM-as-judge)**

- Prompt: "Given this user conversation and the goals the agent extracted, score the extraction on completeness (did it capture everything the user said?), specificity (are the goals concrete?), and faithfulness (no hallucinated goals?). Return a 0-1 score per dimension and an overall verdict."
- Triggered on: every trace where `phase = "goals"` and at least one goal was extracted
- Returns: numeric score per dimension

**Scorer 3 — Conversation quality (new)**

- Prompt: "Did the agent ask a good question? Score on: specificity (is it concrete and answerable?), non-repetition (does it advance from what's already known?), phase appropriateness (is it the right kind of question for this phase?). Return a 0-1 score per dimension."
- Triggered on: every trace where phase is in {goals, users, stories} (the discovery phases)
- Sample at 1 in 5 to keep cost down

Each scorer prompt lives in the codebase (suggest `backend/app/scorers/` directory), versioned with git. The Langfuse config points at the prompt by reference so changes go through review.

### Step 5 — Build dashboards (1-2 hours)

Langfuse comes with built-in views. Create custom dashboards for:

- **Quality trends.** Charter overall score over time, per dimension. Sparklines for Coverage, Balance, Alignment, Rot.
- **Cost per session.** Total token spend per completed Charter session. This is the data behind the cost-with-quality story we tell customers.
- **Latency per phase.** 50th, 95th, 99th percentile turn latency by phase. Flags slow phases.
- **Error rates.** API errors, parsing errors, tool failures, broken extractions. Per phase.
- **Funnel.** How many sessions reach each phase (goals → users → stories → charter → dataset). Where do users drop off?

### Step 6 — Alerts (1 hour)

Set up Slack or email alerts on:

- Charter overall score drops below 70% in any 24-hour window
- Cost per session exceeds [TBD, set after first week of baseline data] in any 24-hour window
- Error rate exceeds 5% in any 1-hour window
- Latency at any phase exceeds 30 seconds for the 95th percentile

Thresholds need a baseline. Set them after the first week of clean data. Until then, just watch the dashboard.

### Step 7 — Operating rhythm (ongoing)

- **Daily.** Glance at the dashboard. 30 seconds.
- **Weekly.** Review trends. What got better, what got worse. Which scorers are surfacing real signal vs noise. Decide one thing to change.
- **Monthly.** Look at the data with fresh eyes. Patterns in the misses. Charter dimensions that are consistently weak. Time to update system prompts? Time to change models?

---

## What this gets you

### Operationally

- A real number for "how good is the Charter Agent today" you can point to
- Confidence to make changes (system prompts, model choice, agent logic) without flying blind
- Early warning on regressions (caught in production rather than via bug report from a design partner)
- Cost data to back up model-choice decisions

### Strategically (the dogfooding payoff)

- You know what setup time looks like for a customer doing the same thing. Where they hit friction. What is missing from existing tools.
- You know which scorers actually surface useful signal vs which look good on paper but produce noise.
- You have your own case study. "We use North Star to monitor North Star. Here is what we learned in 90 days." Strong content marketing piece, strong investor story.
- You feel the pain of writing scorers from scratch and that pain becomes the strongest argument for why the Charter Agent itself matters.

### Concrete things you can ship in the next quarter because of this

- A "monitor mode" feature in the Charter Agent that auto-generates scorers from a charter and connects them to Langfuse (or whatever execution harness the customer uses) — basically productizing what you just did manually
- A blog post about dogfooding eval-driven development on the Charter Agent itself
- Better selling material: "we use our own product to ship our own product"
- A real, informed decision on the open strategic question: do we build native production monitoring, or stay layered on top of Langfuse / Braintrust?

---

## What you should NOT do as part of this

- **Build production monitoring features into North Star itself.** Use Langfuse for now. The whole point of dogfooding is to find out whether you NEED to build it natively. Building it before you know is the trap we are trying to avoid.
- **Optimize the scorers prematurely.** Start with rough versions and let real data show you where they need work. The first version of a scorer is almost always wrong in some interesting way.
- **Try to monitor every metric on day one.** Pick the three things you actually want to see (charter quality, cost per session, error rate). Add more as gaps appear in the dashboard.

---

## Time budget

Realistic time for one engineer to get this running:

- **Day 1.** Langfuse setup, SDK install, `tools.py` instrumentation. End of day: traces are landing.
- **Day 2.** Scorer configuration, dashboard setup. End of day: you can see quality numbers.
- **Day 3.** Alerts, first weekly review meeting structure. End of day: this is operational.

Three working days. Plus ongoing review time (about an hour a week).

---

## Open questions to resolve while building

- Sampling rate for the conversation quality scorer (every trace, 1 in 5, 1 in 10?)
- Whether to capture full prompts and outputs in Langfuse or just metadata (privacy / cost tradeoff)
- Whether to keep scorer prompts in the North Star repo (git-versioned) or in Langfuse (less version control, easier to edit)
- What thresholds to set on the alerts (need a week of baseline first)
- Whether to expose Langfuse data anywhere in the North Star UI itself (probably not for v1, but worth flagging — could be a customer-facing feature later)
