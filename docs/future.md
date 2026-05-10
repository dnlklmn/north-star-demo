# Future ideas

## Prompt optimization loop (Managed Agents + Outcomes)

Once a user has a charter and a labeled dataset in North Star, the natural next
surface is: **use them to improve the user's actual prompt/AI feature, not just
measure it.**

The shape is meta-prompt-optimization (DSPy-style):

1. User points North Star at their current prompt + dataset.
2. A Managed Agents session runs the prompt against dataset rows, scores the
   outputs against the charter, and proposes a revised prompt.
3. Repeat until pass rate clears a threshold or `max_iterations` is hit.

### Why this fits Managed Agents specifically

This is the one scenario where the platform earns its keep over our existing
FastAPI + Anthropic SDK stack:

- **Outcomes** is exactly the right primitive — `user.define_outcome` with a
  rubric like "pass rate on dataset ≥ 85%" or per-dimension thresholds derived
  from the charter (Coverage, Balance, Alignment, Rot). The grader iterates
  automatically; per-criterion gaps feed back into the next prompt revision.
- **Code execution in the session container** runs the user's prompt against
  dataset rows and computes the score — we don't have to host that compute.
- **`max_iterations`** caps token spend so a runaway loop can't burn budget.
- **File mounts** — dataset goes in as a CSV resource, results come back via
  `/mnt/session/outputs/`.
- **SSE event stream** drives a "watch your prompt improve" UI.

### Why this is a separate feature, not a migration

The charter authoring app stays exactly as it is — tightly orchestrated 5-phase
flow, custom extraction blocks, PostgreSQL turn logging, debounced reeval. None
of that benefits from Managed Agents.

The optimization loop is launched as a *new* surface ("Run optimization against
my charter") that creates a Managed Agents session in the background, streams
events back to the UI, and reports the final improved prompt. Different
product, different infra, lives alongside.

### What's already built and what isn't

- **Scenario A — score the dataset (evaluation)** is essentially done in
  `north-star-eval.py`. Future work there is optimization, not architecture:
  `asyncio.gather` over `AsyncAnthropic`, prompt caching on the judge system
  prompt, structured outputs to replace the regex JSON parse, optionally
  Batches API at 50% cost if eval volume grows.
- **Scenario B — iterate the prompt until it passes** is the unbuilt piece and
  the more compelling product surface. It's something users genuinely can't
  easily build themselves, and it's the logical next step after charter +
  dataset authoring.

### Open questions before building

- What does the rubric look like exactly? Pass rate is the obvious one, but
  the charter has structure (Coverage / Balance / Alignment / Rot) and we
  could grade against each dimension separately.
- How do users hand us their prompt? Pasted into the UI? Pulled from a
  repo via the GitHub MCP server?
- What's the right `max_iterations` default? 3 is the API default, 20 is the
  ceiling. Probably 5-ish to start, with the user able to bump it.
- Cost ceiling per run — `output_config.task_budget` (Opus 4.7 beta) lets us
  cap cumulative token spend across the loop, distinct from `max_tokens` per
  response. Worth using once we know rough per-run usage.
