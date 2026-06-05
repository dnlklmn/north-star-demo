# Tier 3A — Training-data capture for the house judge

> **Purpose.** Capture every judge call + human label in a joinable,
> training-ready shape *now*, so when North Star eventually trains a
> distilled small house judge (Tier 3B), the corpus already exists.
> This is the lowest-regret step in the scoring roadmap — it costs
> almost nothing today, and it is the only thing you can't backfill
> later.

## Context

The deep-research synthesis (June 2026) and the hybrid-scoring landing
(#40) gave us a clear strategic split:

- **Commodity layer** — JSON-validity / regex / length checks (the four
  deterministic categories we already ship). These are CI's job for
  any feature, agentic or not. We don't extend them; we treat them as a
  floor.
- **Eval-platform value layer** — the things only North Star can do
  because *only North Star has the labeled corpus*: embedding-based
  scoring (kNN against labels, cascade routing, distribution signals
  for Coverage / Balance / Rot) and a distilled small judge trained on
  your accumulated labels.

The labeled corpus is the moat. Tier 3A is about hygiene: making sure
every judge call + every human review labels something in a shape we
can join, query, and ultimately train on. Once that's in place we can
build embedding triage, kNN scorers, and the distilled judge on top
without scrambling for data.

## What a training sample looks like

A row in the eventual training corpus needs to carry:

| Field | Source today | Purpose |
|---|---|---|
| `input` | `eval_runs.per_row[i].input` | what the model under test received |
| `output` | `eval_runs.per_row[i].output` | what the model produced |
| `scorer_name` | `eval_runs.per_row[i].scorer_metadata[name]` key | which scorer rendered the verdict |
| `dimension` | scorer's `type` (coverage / alignment / safety) | groups scorers by charter dimension |
| `sub_criteria` | derived from the CoT-rubric judge prompt | for per-sub-criterion supervision |
| `judge_score` | `scorer_metadata[name].score` | the float verdict |
| `judge_reasoning` | `scorer_metadata[name].judge_response` | full CoT reasoning text |
| `judge_per_sub_criteria` | parsed from `judge_reasoning` | structured verdict-per-criterion (Tier 3A phase 2) |
| `human_label` | `dataset.examples[id].label` ∈ {good, bad, null} | supervision signal |
| `human_review_status` | `dataset.examples[id].review_status` | approved / rejected / null |
| `human_notes` | per-row notes (already captured on eval_runs) | qualitative signal |
| `agreement` | derived: did judge ≈ human? | informativeness signal — disagreements are the most valuable training rows |
| `model_used` | `eval_runs.judge_model_used` | which model issued the verdict |
| `seed_snapshot` | `eval_runs.seed_snapshot` | charter at scoring time |
| `eval_run_id` | foreign key | provenance |
| `created_at` | from `eval_runs.finished_at` | for time-series drift analysis |

## Gap analysis — today vs ideal

What's already captured cleanly:

- ✅ `input`, `output`, `scorer_name`, `dimension`, `judge_score`,
  `human_label`, `human_review_status`, `model_used`, `seed_snapshot`,
  `eval_run_id`, `created_at` — all present today, joinable across
  `eval_runs.per_row` + `datasets.examples`.

What's lossy or unstructured:

- ⚠️ `judge_reasoning` is **truncated to the first 2000 characters** in
  `eval_runner.compile_scorers` (`metadata_out["judge_response"] =
  judge_text[:2000]`). Modern CoT-rubric judges produce 2-5K of
  reasoning per scorer. **We are silently losing supervision signal on
  every eval run.** Fix in this PR.
- ⚠️ `judge_per_sub_criteria` is **not structured** — the CoT-rubric
  framing (`#40`) makes the judge reason per sub-criterion inline, but
  we never parse it into a typed shape. Phase 2 (separate PR) — either
  a parse-at-extract-time step or a richer scorer-side return contract.
- ⚠️ `sub_criteria` (the rubric itself) lives in the generator's prompt
  output but isn't echoed back on the scorer dict. Phase 2.
- ⚠️ `agreement` is derived, not stored. Compute at view time.

## Staged plan

### Phase 1 — Capture, lossless, no schema change

**Goal:** stop losing data. Defer corpus shape design.

**Scope:**
- Untruncate `judge_response` in `eval_runner.compile_scorers`. Store
  the full text; let UI apply its own display cap if needed (the
  Evaluate panel already uses a wrapping `<pre>` in an
  expand-on-demand surface — no UI change required).
- Update CLAUDE.md to note this is now the canonical capture surface.

**Risk:** JSONB row size grows ~2-5× per scorer-row. The `eval_runs.per_row`
JSONB is fetched-as-one when rendering an eval run. 100 rows × 20 scorers ×
4KB ≈ 8MB JSONB — substantial but TOAST-friendly and well under any practical
Postgres limit. If we hit pain on read latency later, the fix is to lift
`scorer_metadata` into its own table — not to re-truncate.

**This PR.**

### Phase 2 — Structure the per-sub-criterion verdicts

**Goal:** make rubric decomposition extractable.

**Scope:** either
- **(a) Parse-at-extract-time** — write a small parser that walks
  `judge_response` and pulls out the numbered sub-criteria + per-criterion
  verdict lines the CoT-rubric prompt asks for. Pure derived data; lives in
  a corpus-export script, not the storage layer.
- **(b) Richer scorer return shape** — have the scorer body return
  `{score: float, sub_criteria_verdicts: list[dict]}` instead of a bare
  float. Requires generator + runtime + scorer adapter changes. More
  invasive; only worth it if (a) proves unreliable.

Recommend (a) first; escalate to (b) only if parser misclassification rate
exceeds a threshold (TBD — set bar once we have ~100 reviewed samples to
measure against).

### Phase 3 — Training-shape view

**Goal:** one query → all training data.

**Scope:** a Postgres VIEW or materialized view that joins
`eval_runs.per_row` (unnested) with `datasets.examples` on row id, with
`scorer_metadata` unnested into one row per (eval_run, dataset_row,
scorer_name). Each row of the view is one training sample matching the
table above.

No data migration — purely declarative. Iterate the view shape as the
training requirements firm up.

### Phase 4 — Distillation (Tier 3B)

Outside this doc's scope. Triggers once the corpus crosses ~1k labeled
rows per dimension and we have a Cohen's κ threshold to validate
against. Then: frontier judge as teacher, fine-tune an open judge
(Prometheus 2 / Glider / Selene), shadow-mode vs frontier, promote
per-dimension once κ clears the bar.

## Non-goals for Tier 3A

- ❌ Building the training pipeline. That's Tier 3B, gated on a
  populated corpus.
- ❌ Choosing the open judge model family. Premature; depends on what
  the data looks like.
- ❌ Embedding-based scoring (Tier 2). Independent track — the
  embedding column on dataset items will land on its own PR with
  Coverage/Balance/Rot signals + kNN scorer.
- ❌ Restructuring `eval_runs.per_row` storage. The JSONB blob works
  fine for now; lifting `scorer_metadata` into its own table is a
  Phase 3+ concern only if read latency degrades.

## Open questions

### Sub-criteria parsing reliability — how we'll actually measure

The Phase 2 path (a) vs (b) decision is empirical, not architectural.
Concretely:

1. Wait for ~50 full-CoT samples to accumulate post-#49 (uncapped).
2. Define "correct parse": extracted sub-criteria count matches the
   rubric's prompted count, each item has a recognisable verdict
   (PASS / PARTIAL / FAIL or numeric), no false-positives.
3. Write a v0 parser, run it on the sample, classify each result as
   Correct / Partial / Missed / False-positive against a hand-review.
4. Decide by hit-rate:
   - **≥90%** → Phase 2a (parse-at-extract-time, pure derived data).
   - **70-90%** → tighten the CoT-rubric generator prompt to enforce
     a stricter line format (e.g. each sub-criterion ends with
     `[PASS]` / `[PARTIAL]` / `[FAIL]`), re-test.
   - **<70%** → Phase 2b (scorers return
     `{score, sub_criteria_verdicts: [...]}` instead of a bare float).

The middle band's instinct — make parsing reliable by tightening the
generator's output contract — is the cheapest fix and worth trying
before any runtime/adapter changes.

### Disagreement labeling + richer-than-good-bad verdicts

`good`/`bad` is a lossy supervision signal. The most informative
training rows are the ones where the human and the judge **disagree**,
and today the schema can't tell those apart from cases where they
agree.

**Proposal — three separable axes** on each reviewed row, all optional
(any subset gives more signal than the binary today):

1. **Output verdict** (richer scale)
   - `excellent` (exceeds the bar)
   - `good` (meets the bar)
   - `partial` (meets some criteria, misses others)
   - `bad` (fails the bar)
   - `unsure` (reviewer can't tell)

   The middle states (`partial`, `unsure`) carry the most product value
   — they identify where coaching actually moves the needle, and where
   reviewer training data is needed.

2. **Judge agreement** (the training signal)
   - `agree` — judge's score reflects reality
   - `judge-too-harsh` — judge said worse than it actually is
   - `judge-too-lenient` — judge said better than it actually is
   - `judge-missed-the-point` — judge graded the wrong thing

   This is the supervision signal that fuels Phase 4 distillation.
   Disagreements are gold.

3. **Failure-mode tags** (multi-select)
   - `hallucination`, `wrong-tone`, `format`, `out-of-scope`,
     `missing-required`, `safety`, `other`

   Aggregate views ("how often does our judge mistake X for Y?")
   become possible.

**Storage shape:** add a `human_verdict` JSONB column to
`eval_runs.per_row[i]` (or a sibling table keyed by `(eval_run_id,
row_id)`) carrying
`{output_verdict, judge_agreement, failure_modes: [...], notes}`. The
legacy `examples.label` (good/bad) stays intact; this is additive. The
Phase 3 training-shape view reads either or both — and joins
preferentially on `human_verdict` when present, falling back to the
binary label.

**UX shape:** same row-detail panel that today has the notes field.
Add three compact controls above the notes (verdict dropdown, judge
agreement chips, failure-mode multi-select). Every field is optional;
the reviewer can spend 2 seconds or 30 depending on the case.

**Scope:** this is its own PR, not a follow-up of Tier 3A phase 1.
Schedule once we have ~100 reviewed rows under the existing binary
scheme, so the UX redesign can be measured against the current click
cost.

### PII in training samples

If `input` / `output` contains user PII, the corpus needs governance.
Likely fine for skill-eval (synthetic data) but not for prompt-eval on
production traces. Add a per-session opt-out before any export.
