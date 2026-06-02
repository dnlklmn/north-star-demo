# North Star Production Monitoring with Braintrust — Implementation Plan

## Why Braintrust (not Langfuse)

We already use Braintrust for offline evaluation. The eval runner in `backend/app/eval_runner.py` wraps the Anthropic client with `braintrust.wrap_anthropic`, runs scorers via `braintrust.Eval()`, and the UI exposes a Braintrust API key setting. Adding production monitoring is an extension of an existing integration, not a new tool to learn. One platform, one mental model, one set of credentials.

We may eventually support Langfuse as a customer-facing integration option (it is open source and widely adopted). But for our own internal monitoring, Braintrust is the right call.

## Why this matters (the dogfooding story)

- **Practical.** We have real production traffic on our own product (design partners, internal use). We should be measuring its quality the way we want our customers to measure theirs.
- **Strategic.** Setting this up ourselves teaches us exactly what a customer feels when they wire a Charter Agent project into Braintrust alongside their existing eval setup. Every friction point we hit will be one our customers hit too. Every scorer that does not produce useful signal will teach us something about the product roadmap.
- **Marketing.** "We use North Star to monitor North Star, all running on Braintrust" is a great line. Use it.

---

## End state

When this is done, the team has:

- Every Charter Agent LLM call captured as a trace in Braintrust, with metadata about which phase (goals, users, stories, charter, dataset) it belongs to
- Online scorers (Braintrust's term for scorers running on production traces, sometimes called auto-evals) running on every charter generated, using our existing judge prompt
- Additional online scorers for the discovery phases (goal extraction quality, conversation quality)
- Dashboards showing quality over time, cost per session, latency, and error rates
- Slack or email alerts on regressions

---

## Setup steps

### Step 1 — Create a production project in Braintrust (15 minutes)

- Log into Braintrust. Create a new project, suggest the name `north-star-prod`.
- Keep the existing offline eval project separate so dashboards do not get mixed.
- Generate a project-scoped API key. Store as `BRAINTRUST_PROD_API_KEY` env var (separate from the existing UI-supplied key for offline runs).

### Step 2 — Wrap the production Anthropic client (half day)

This is the only meaningful code change. Right now `braintrust.wrap_anthropic` is used inside `eval_runner.py` (offline eval path). Production code in `backend/app/tools.py` does not log to Braintrust.

The change:

- In `tools.py`, where the Anthropic client is constructed for live agent calls, wrap it with `braintrust.wrap_anthropic`, pointing at the new `north-star-prod` project.
- Pattern (paraphrasing the existing `eval_runner.py` usage):

```python
import braintrust

braintrust.login(api_key=os.environ["BRAINTRUST_PROD_API_KEY"])

client = braintrust.wrap_anthropic(
    anthropic.Anthropic(api_key=anthropic_api_key),
    project_name="north-star-prod",
)
```

- For each call, attach metadata in the trace span:
  - `session_id` — the Charter session this call belongs to
  - `phase` — one of goals, users, stories, charter, dataset
  - `user_id` — whoever is interacting (or anonymous design partner ID)
  - `model_name` — for cost-per-model breakdowns
  - `turn_number` — within the session

This metadata is what lets every later view (filter, group, alert) work cleanly.

### Step 3 — Configure online scorers (half day)

In Braintrust, scorers can run automatically on captured production traces. Three to start.

**Scorer 1 — Charter quality (uses existing `north-star-judge-prompt.md`)**

- Triggered on: every trace where `phase = "charter"` and a charter has been generated
- Returns: per-dimension score (Coverage, Balance, Alignment, Rot) and an overall verdict
- Frequency: every charter (low volume, no sampling needed)

This is the fastest scorer to ship. The prompt already exists. The result is the headline number on the dashboard.

**Scorer 2 — Goal extraction quality (new LLM-as-judge)**

- Prompt: "Given this user conversation and the goals the agent extracted, score the extraction on completeness (did it capture everything the user said?), specificity (are the goals concrete?), and faithfulness (no hallucinated goals?). Return a 0-1 score per dimension and an overall verdict."
- Triggered on: every trace where `phase = "goals"` and at least one goal was extracted
- Returns: numeric score per dimension

**Scorer 3 — Conversation quality (new)**

- Prompt: "Did the agent ask a good question? Score on specificity (concrete and answerable), non-repetition (advances from what's already known), phase appropriateness (right kind of question for this phase). Return a 0-1 score per dimension."
- Triggered on: every trace where phase is in {goals, users, stories} (the discovery phases)
- Sample at 1 in 5 to keep cost down

Each scorer prompt lives in the codebase (suggest `backend/app/scorers/` directory), versioned with git. The Braintrust scorer config references the prompt by file path or imports it. Changes go through normal code review.

**Carry forward the model-flexibility pattern from `eval_runner.py`.** The offline eval runner already supports judge models via either Anthropic directly or OpenRouter (any model slug containing `/` routes through OpenRouter). The online scorers should use the same `_build_judge_client` helper or its equivalent. This matters more for production than for offline eval: online scorers run on every (or every Nth) production trace, so being able to pick a cheaper or faster scorer model without code changes is real cost and latency leverage. Defaults worth considering: Sonnet for the charter scorer (high stakes, less frequent), Haiku or a cheaper OpenRouter model for the conversation quality scorer (lower stakes, runs constantly).

### Step 4 — Build dashboards (1-2 hours)

Braintrust has solid built-in views. Configure dashboards for:

- **Quality trends.** Charter overall score over time, per dimension. Sparklines for Coverage, Balance, Alignment, Rot.
- **Cost per session.** Total token spend per completed Charter session. The data behind the cost-with-quality story we tell customers.
- **Latency per phase.** 50th, 95th, 99th percentile turn latency by phase. Flags slow phases.
- **Error rates.** API errors, parsing errors, tool failures, broken extractions. Per phase.
- **Funnel.** How many sessions reach each phase (goals → users → stories → charter → dataset). Where do users drop off?

### Step 5 — Alerts (1 hour)

Braintrust supports alerts via webhook (Slack) and email. Configure:

- Charter overall score drops below 70% in any 24-hour window
- Cost per session exceeds [TBD, set after first week of baseline data] in any 24-hour window
- Error rate exceeds 5% in any 1-hour window
- Latency at any phase exceeds 30 seconds for the 95th percentile

Thresholds need a baseline. Set them after the first week of clean data. Until then, just watch the dashboard.

### Step 6 — Operating rhythm (ongoing)

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

- You know what setup time looks like for a customer doing the same thing on Braintrust. Where they hit friction. What is missing.
- You know which scorers actually surface useful signal vs which look good on paper but produce noise.
- You have your own case study. "We use North Star to monitor North Star on Braintrust. Here is what we learned in 90 days." Strong content marketing, strong investor story.
- You feel the pain of writing scorers from scratch and that pain becomes the strongest argument for why the Charter Agent itself matters.

### Concrete things you can ship in the next quarter because of this

- A "monitor mode" feature in the Charter Agent that auto-generates online scorers from a charter and pushes them into Braintrust (or another harness the customer uses) — productizing what you just did manually
- A blog post about dogfooding eval-driven development on the Charter Agent, with real numbers
- Better selling material: "we use our own product to ship our own product"
- A real, informed decision on the open strategic question: do we build native production monitoring, or stay layered on top of Braintrust / Langfuse / others?

---

## What you should NOT do as part of this

- **Build production monitoring features into North Star itself.** Use Braintrust. The whole point of dogfooding is to find out whether we NEED to build it natively. Building it before we know is the trap we are trying to avoid.
- **Optimize the scorers prematurely.** Start with rough versions and let real data show where they need work. The first version of a scorer is almost always wrong in some interesting way.
- **Try to monitor every metric on day one.** Pick the three things you actually want to see (charter quality, cost per session, error rate). Add more as gaps appear.

---

## Time budget

Realistic for one engineer who already knows the codebase:

- **Half day.** Wrap the production Anthropic client in `tools.py` with `braintrust.wrap_anthropic`. Verify traces are landing in the new project.
- **Half day.** Configure the three online scorers in Braintrust. Verify they fire correctly on a few real sessions.
- **Half day.** Set up dashboards and alerts. Define operating rhythm.

About one full day, since most of the integration plumbing already exists from the offline eval work.

---

## Open questions to resolve while building

- Sampling rate for the conversation quality scorer (every trace, 1 in 5, 1 in 10?)
- Whether to capture full prompts and outputs in Braintrust or just metadata (privacy / cost tradeoff)
- Whether to also run the same scorers on offline eval datasets to confirm parity (probably yes — same scorer should give comparable scores in both modes)
- What thresholds to set on the alerts (need a week of baseline first)
- Whether to expose Braintrust scores anywhere in the North Star UI itself (probably not for v1, but worth flagging — could be a customer-facing feature later)
- Which scorer model to use for which scorer. The offline eval runner already supports Anthropic and OpenRouter routing; the online scorers should reuse that flexibility from day one. Charter scorer probably wants a strong model (Sonnet or above), conversation quality scorer can probably use a cheaper one (Haiku or OpenRouter equivalent). Decision should be made deliberately, not by accident.

---

## Related: when (and whether) to add Langfuse later

Not soon, and probably not for our own use. But worth a separate conversation when we start thinking about customer-facing integrations.

- **For our internal use:** Braintrust covers everything we need. No reason to add another tool.
- **For customer integrations:** Many design partners and future customers will already use Langfuse (24K stars, broader OSS adoption). Supporting Langfuse as a "destination" the Charter Agent can write scorers into is probably a year-one customer-facing feature. Different decision from internal tooling.
- **For the open core SDK:** When we ship the SDK described in the pitch deck (slide 7), it should ideally write to multiple harnesses. Braintrust first because we know it. Langfuse second because it has the broadest reach. Others as customers ask.
