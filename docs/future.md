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
  `north-star-eval.py`. The architecture is correct; what's left is
  optimization (see next section).
- **Scenario B — iterate the prompt until it passes** is the unbuilt piece and
  the more compelling product surface. It's something users genuinely can't
  easily build themselves, and it's the logical next step after charter +
  dataset authoring.

## Scenario A optimizations — how to build them

These are improvements to the existing `north-star-eval.py`. None require
architectural changes; do them in this order, each is independent.

### 1. Parallelize judge calls with `AsyncAnthropic`

Today the eval loop is `for example in dataset: judge(good); judge(bad)` —
2N sequential calls. With `asyncio.gather` over `AsyncAnthropic` the entire
eval runs in roughly the latency of a single judge call.

```python
import asyncio
from anthropic import AsyncAnthropic

client = AsyncAnthropic()

async def judge_charter(charter: dict) -> dict | None:
    response = await client.messages.create(
        model=MODEL, max_tokens=1024, system=judge_prompt,
        messages=[{"role": "user", "content": format_for_judge(charter)}],
    )
    ...

async def run_eval():
    tasks = []
    for ex in dataset:
        tasks.append(judge_charter(ex["good_output"]))
        tasks.append(judge_charter(ex["bad_output"]))
    verdicts = await asyncio.gather(*tasks)
    # zip back into rows
```

Cap concurrency with `asyncio.Semaphore(10)` if the API rate-limits.

### 2. Cache the judge system prompt

The judge prompt is identical across every call. Wrap the system field in
the cached form so we pay full cost once per 5-minute window and ~0.1× on
every subsequent call:

```python
response = await client.messages.create(
    model=MODEL,
    max_tokens=1024,
    system=[{
        "type": "text",
        "text": judge_prompt,
        "cache_control": {"type": "ephemeral"},
    }],
    messages=[{"role": "user", "content": format_for_judge(charter)}],
)
```

Verify it's working by checking `response.usage.cache_read_input_tokens` is
non-zero on the second call onward. The judge prompt needs to be ≥ 2048
tokens on Sonnet 4.6 / ≥ 4096 on Opus to cache at all — check
`shared/prompt-caching.md` for the full table if we change models.

### 3. Replace regex JSON parsing with structured outputs

The `re.search(r"\{.*\}", text, re.DOTALL)` step is a known failure mode —
the judge can return prose, double-encoded JSON, or wrapped fences and the
parse silently fails. Use `output_config.format` with a JSON schema:

```python
response = await client.messages.create(
    model=MODEL,
    max_tokens=1024,
    system=[{"type": "text", "text": judge_prompt,
             "cache_control": {"type": "ephemeral"}}],
    messages=[{"role": "user", "content": format_for_judge(charter)}],
    output_config={
        "format": {
            "type": "json_schema",
            "schema": {
                "type": "object",
                "properties": {
                    "overall": {"type": "string", "enum": ["good", "bad"]},
                    "violations": {"type": "array", "items": {"type": "string"}},
                    "dimensions": {
                        "type": "object",
                        "additionalProperties": {
                            "type": "object",
                            "properties": {
                                "status": {"type": "string", "enum": ["pass", "fail"]},
                                "reason": {"type": "string"},
                            },
                            "required": ["status", "reason"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["overall", "violations", "dimensions"],
                "additionalProperties": False,
            },
        },
    },
)
verdict = json.loads(response.content[0].text)  # guaranteed parseable
```

Or use `client.messages.parse()` with a Pydantic model for typed access —
slightly cleaner, same effect.

### 4. Migrate the model and bump tokens

`north-star-eval.py` pins `claude-opus-4-5-20251101`. Move to
`claude-opus-4-7` (or `claude-sonnet-4-6` if the eval can tolerate the
intelligence drop for the cost win). On Opus 4.7, drop any sampling params
if we ever add them, and use `thinking={"type": "adaptive"}` if we want the
judge to reason more carefully on borderline cases. `max_tokens=1024` is
fine for the current verdict shape, but bump to 2048 if we add `thinking`.

### 5. Batches API — only if eval volume grows

Skip until we're running this in CI on every prompt change or sweeping over
judge variants. At current dataset size (handful of examples × 2 charters)
the per-request latency win from parallelization matters more than the 50%
cost reduction from batching. Revisit when an eval run starts to feel
expensive.

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
