# evals/ — run a North Star dataset through Claude, score with Braintrust

This is the execution-eval harness for North Star. It takes:

- a **SKILL.md body** (the skill under test),
- a **dataset** of input/expected_output rows (authored + reviewed in North Star),
- a set of **scorer functions** (generated from your charter in North Star's Scorers tab),

and runs them through a Braintrust Eval. Each row becomes one span in the Braintrust UI, with per-scorer verdicts you can diff across runs as you iterate the skill.

---

## Setup

```bash
# From this directory (or the backend .venv — same anthropic dep):
pip install -r requirements.txt

export ANTHROPIC_API_KEY=sk-ant-...
export BRAINTRUST_API_KEY=...    # get one at braintrust.dev
```

Optional env vars:

| Var              | Default                      | Purpose                                |
|------------------|------------------------------|----------------------------------------|
| `EVAL_MODEL`     | `claude-opus-4-7`            | Model that runs the skill              |
| `JUDGE_MODEL`    | `claude-sonnet-4-20250514`   | Model for LLM-as-judge scorers         |
| `NORTH_STAR_URL` | `http://localhost:8080`      | Backend URL for `--session-id` mode    |

---

## Running against a live North Star session

Easiest path. Your North Star backend is running, you've built a charter, generated scorers, approved some dataset rows, and seeded from a SKILL.md.

```bash
python run_eval.py \
    --session-id <uuid> \
    --project my-skill-eval \
    --limit 10          # optional — quick smoke run
```

The script pulls three things from the backend:

1. `GET /sessions/{id}` → `charter.task.skill_body` + `scorers`
2. `GET /sessions/{id}/dataset` → approved example rows
3. Runs the Braintrust Eval.

You'll see a link to the run in the Braintrust UI printed on completion.

---

## Running against local files

If you've exported everything or hand-wrote fixtures:

```bash
python run_eval.py \
    --dataset-file ./dataset.json \
    --scorers-file ./scorers.json \
    --skill-file   ./skill.md \
    --project my-skill-eval
```

**`dataset.json`** — either the raw list, or the full export shape:

```json
{
  "examples": [
    {
      "id": "abc",
      "input": "...prompt...",
      "expected_output": "...what a good skill would produce...",
      "feature_area": "...",
      "coverage_tags": ["..."],
      "label": "good",
      "review_status": "approved",
      "should_trigger": null
    }
  ]
}
```

Only rows with `review_status in (null, "approved")` run. Rows with `should_trigger in (true, false)` are skipped by default — those belong in `skill-creator` for routing evals. Override with `--include-triggering`.

**`scorers.json`** — the list North Star's `/generate-scorers` endpoint emits:

```json
{
  "scorers": [
    {
      "name": "alignment_idiomatic_sdk_use",
      "type": "alignment",
      "description": "Checks for idiomatic Anthropic SDK patterns.",
      "code": "def alignment_idiomatic_sdk_use(output, input):\n    prompt = f'...'\n    return call_judge(prompt)\n"
    }
  ]
}
```

Each scorer's `code` is `exec`'d in a fresh namespace with `call_judge` injected. The resulting function is wrapped to match Braintrust's scorer signature (`{name, score, metadata}`).

**`skill.md`** — plain markdown. If the file starts with YAML frontmatter, it's stripped automatically so only the instructional body goes into the system prompt.

---

## How a row flows

```
row {input, expected_output}
  │
  ▼
task(row)                       # Anthropic call, SKILL.md as system prompt
  │  → output (string)
  ▼
for each scorer in scorers:
    scorer(output, expected_output, input) → {score: 0.0–1.0, reasoning}
  │
  ▼
Braintrust stores: input, output, expected, per-scorer scores, trace
```

`braintrust.wrap_anthropic()` wraps the task's client so every Claude call becomes a child span under the row — you see tokens, latency, and the raw response without writing logging yourself.

---

## What this eval DOES NOT do

- **Triggering / routing evals.** "Would Claude Code load this skill on this prompt?" Braintrust can't observe that decision. Use `skill-creator`'s eval with the `/export/skill-creator` output instead.
- **Production traffic monitoring.** Wire `wrap_anthropic()` into your app directly if you want live traces; that's orthogonal.
- **Dataset versioning.** Each run creates a new experiment; the dataset is pulled fresh every time. If you want versioned datasets in Braintrust, replace the inline `data=` with `braintrust.init_dataset(...)` and push on edits from North Star.

---

## Iteration loop

1. Edit SKILL.md (or the charter → regenerate scorers).
2. `python run_eval.py --session-id <uuid> --project my-skill-eval`
3. Open the Braintrust UI, diff against the previous run.
4. Find a row where scores dropped → look at the trace → identify what broke.
5. Either fix the skill, fix a flawed dataset row, or add a new row to cover the surprise.
6. Repeat.

This is the "eval-driven development" loop closed — charter in North Star, execution verdicts in Braintrust, human judgment on the diffs.

---

## Troubleshooting

**"No usable scorers compiled"** — your scorers list is empty or all scorers failed to exec. Check the session's Scorers tab; regenerate if empty.

**"Session has no skill_body"** — the session wasn't seeded via `/skill-seed`. Either re-seed from a SKILL.md, or patch `charter.task.skill_body` manually.

**"No eligible dataset rows"** — you have rows but none are approved. Run the review flow in the Dataset tab, or drop the `review_status` filter by editing `build_braintrust_rows`.

**Scorer always returns 0.0** — `call_judge` expects the judge model to return a single float. If your scorer's judge prompt asks for a rubric/JSON instead, the parser falls back to 0.0. Fix the prompt to say "return a single number 0-1" at the end.
