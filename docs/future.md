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

## Support ticket coach (browser extension)

A browser extension that helps people write better tickets/issues on any web form (Zendesk, Jira, Linear, GitHub Issues, internal tools). Live checklist + LLM judge against a North Star charter, with a one-click rewrite/clarifying-question generator.

This is a canonical North Star demo: non-technical user authors a charter for "good support ticket," the charter becomes the runtime judge, real anonymized tickets become the labeled dataset.

### Charter dimensions (starting point)

- **Coverage:** problem statement, expected vs. actual, repro steps, environment, impact, what was already tried
- **Balance:** weight requirements by ticket type (bug vs. feature vs. billing — don't demand repro steps on "change my email")
- **Alignment:** severity claim justified by impact; routing hints present; sentiment separated from facts
- **Rot:** stale environment info, vague "doesn't work," unstructured walls of text, screenshots without context

### Architecture

```
Extension (MV3)
├── content script    → reads active textarea/contenteditable, injects sidebar
├── background worker → debounce + call backend
└── popup             → project selector, settings, auth

North Star backend (small additions)
├── GET  /api/extension/charter?project_id=…  → returns live skill_body for the linked project
├── POST /api/extension/evaluate              → LLM judge against that charter
└── POST /api/extension/rewrite               → LLM rewrite under charter constraints
```

### Linking to a North Star project (instead of hardcoding the charter)

This is the key design decision and it does map cleanly onto what already exists:

- Each session/project already has `charter.task.skill_body` plus `skill_name` / `skill_description` (`backend/app/main.py:561`, `:775`).
- `GET /sessions` already lists projects.
- The extension's settings would store `{ project_id, api_token }`. On every evaluation it fetches the latest `skill_body` (cached briefly) and uses it as the judge prompt.
- Iterating on the charter in North Star → next extension evaluation picks up the change automatically. No redeploy.

What we'd need to add to North Star:
1. A scoped API token per user (read-only access to their own projects' charters).
2. A "Use in extension" panel on a project page that surfaces the project ID + a copy-token button.
3. A stable, prompt-shaped export of the charter for judge use (probably already close — `skill_body` is the right field, but may need a thin wrapper that includes charter dimensions too).

### Demo scope (1–2 days)

- Hardcoded backend URL, single shared token (no multi-user yet)
- Extension popup: paste project ID → save
- Sidebar: "click this textarea to attach" → live checklist + one rewrite button
- Test on Zendesk, GitHub Issues, and a plain `<textarea>` test page

If the loop feels good, then invest in:
- Per-user API tokens
- Domain allowlist + privacy controls (drafts leave the browser — needs a clear off switch)
- Smart field detection (Zendesk has many textareas; auto-attach is fiddly)
- Cost controls: cache by draft hash, re-evaluate only on meaningful change (new sentence, not every keystroke)

### Open questions / risks

- **Privacy:** sending draft content to a backend is the #1 trust issue for a browser extension. Needs explicit allowlist + visible "off" state. Consider local-only mode with a user-supplied API key for power users.
- **Charter shape for runtime use:** the charter today is structured for human review and dataset generation. May need a "judge view" that compiles dimensions into a single prompt. Worth prototyping before committing.
- **Auto-detect vs. manual attach:** auto-detecting "this is a ticket form" across arbitrary sites is brittle. Manual click-to-attach is uglier but reliable — start there.
- **Who pays for inference:** fine for a demo with a shared key; needs auth + metering before any real launch.
- **Charter authoring UX:** support leads are the target authors. Confirm they'll actually go through the discovery flow, or whether we ship a default "support ticket" charter they fork and tweak (probably the latter).

### Why this is worth a demo

- Tight, visible loop: edit charter in North Star → next ticket draft scores differently. Easy to show in a 2-minute video.
- Tool-agnostic story beats a Zendesk-only app for breadth of audience.
- Forces us to prove the charter is useful as a runtime artifact, not just a design artifact — which is the strongest version of North Star's pitch.

## Bundled reference files alongside SKILL.md

Today North Star generates a `SKILL.md` body from goals + stories + charter.
A skill bundle can ship more than the markdown file — Claude Code skills
support *progressive disclosure*, where SKILL.md points at additional files
Claude reads on demand. North Star already owns the data needed to generate
those files; the open questions are which to add and when.

### What to generate

Three reference file types fall cleanly out of state North Star already owns:

- **`examples.md`** — canonical input → ideal output pairs, sourced from the
  highest-scoring positive rows in the dataset. The skill body says "see
  examples.md for the shape" and Claude reads it on demand.
- **`off-target.md`** — adjacent requests that should NOT trigger the skill,
  sourced from `kind: "off_target"` stories. Unique leverage: most
  hand-written skills forget to document anti-examples.
- **`criteria.md`** — coverage / alignment criteria from the charter,
  formatted as a self-check list the skill can consult before responding.

Scripts (Python / shell helpers the skill invokes via Bash) are a natural
further extension, but not for the first cut — they pull North Star into
code-gen territory where evals get harder. Stick to data-derived references
first.

### When to generate / refresh

Trigger generation at the moment a candidate skill version is promoted to
**active**. Activation is already the user's "I endorse this version"
gesture, so piggybacking reference generation avoids a second approval loop
and guarantees references match a known-good skill body.

UX shape:

- Inline with the activation action — single confirm with a "refresh
  references" toggle (default on), not a follow-up modal.
- First activation → toggle reads "generate" (refs don't exist yet).
- Subsequent activations → toggle reads "refresh."
- Skip-if-unchanged: if the dataset / charter inputs haven't moved since
  the last activation, skip silently rather than churning identical files.

### Staleness after activation

Activation-time generation handles the common case but doesn't cover drift:
users keep relabeling the dataset after activating, and references built at
activation time fall behind. Reuse the existing `generated_at_skill_version`
pattern (already used for SKILL.md regenerate banners) per reference file —
each ref tracks the dataset/charter version it was built from, banner
appears when underlying state moves.

Per-ref staleness, not one global flag. The three ref types have different
volatility:

| Reference     | Changes when                          | Volatility |
|---------------|---------------------------------------|------------|
| examples.md   | Dataset rows added / relabeled        | High       |
| off-target.md | Off-target stories edited             | Medium     |
| criteria.md   | Charter coverage/alignment edited     | Low        |

A single global "references stale" banner would cry wolf every relabel.

### Approval model

Human-gated, mirroring SKILL.md regen — agent regenerates → diff modal →
user accepts. References ship inside the skill bundle and shape Claude's
behavior at runtime, so silent updates from a relabel could quietly change
skill output in ways the author didn't intend. Auto-publish is tempting for
`examples.md` but the cost of getting it wrong outweighs the cost of one
click.

### Why this is North Star's leverage

The win is not "we generate more files." It's that every reference file is
grounded in evaluated data — examples come from rows the user labeled good,
off-target patterns come from stories the user marked as such, criteria
come from a charter the user approved. The skill ships with receipts.
