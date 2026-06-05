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

### Phase 2 — Structure the per-sub-criterion verdicts ✅

**Path taken:** Phase 2a (parse-at-extract). Shipped via
`backend/app/training_corpus.py::parse_judge_response`. ~100% hit rate on
the strict-framed corpus (post-#51); gracefully handles the two legacy
formats (Format A `**N. Name**: MET (1.0)` and Format B
`**N. Name (0):**`) for historical eval runs.

Phase 2b (structured scorer return) was the escape valve — never needed.

### Phase 3 — Training-shape view ✅

Shipped in the same PR as Phase 2a. Python-layer materialisation rather
than a Postgres VIEW — the parser regex is non-trivial and porting it to
PL/pgSQL would fragment the test surface. The
`build_training_samples` function produces exactly the row shape from
the "What a training sample looks like" table above, and the
`GET /sessions/{id}/training-corpus` endpoint streams the materialised
join as NDJSON. `scripts/export_training_corpus.py` is the CLI wrapper
for one-off exports.

The shape is iterable: when reviewer-disagreement UX lands (open question
below), `human_verdict` and `failure_modes` join here naturally with no
schema migration.

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

### Sub-criteria parsing reliability — measured

Decided empirically against live judge responses produced by Haiku 4.5.

**v0 (loose framing — "one line each"):** 56% correct on a 68-sample
corpus across 4 scorers / 2 specs. Failure modes were not parser bugs
but real format inconsistency — Haiku used two distinct line shapes
depending on the verdict (`**N. Name**: MET (1.0)` for high scores,
`**N. Name (0):**` for low scores) and sometimes dropped the trailing
`SCORE:` line entirely.

**After framing tightening:** 100% correct on a re-run of the same
corpus (5 skills, 68 samples, 4 scorers). The framing change forces
ONE format with literal `[PASS|PARTIAL|FAIL|N/A]` labels, mandatory
`(weight)`, em-dash separator, and a required final `SCORE:` line.
Score agreement (parser SCORE: vs runtime saved score) was 68/68 in
both runs — when the SCORE: line is present, the parser never mis-reads
the value.

**Verdict: Phase 2a wins (parse-at-extract-time).** Reliability is
high enough that a script can extract structured per-sub-criterion
verdicts from existing `judge_response` strings without a runtime or
scorer-adapter change. Phase 2b (structured scorer return) is no
longer needed.

**Followup (separate PR):** ship the actual extraction step — walk
the captured corpus and produce a `judge_per_sub_criteria` shape that
the Phase 3 training-shape view can join on.

The measurement scripts live in `scripts/generate_judge_corpus.py`
(corpus generator) and `scripts/measure_parsing_hit_rate.py` (v0
parser + classifier). Rerun them whenever the generator prompt or
the runtime framing changes to catch regressions early.

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
