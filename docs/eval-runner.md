# Eval runner

How North Star executes an eval run (Evaluate tab → `POST /sessions/{id}/run-eval`,
and the `evals/run_eval.py` CLI). All of this lives in `backend/app/eval_runner.py`.

## Local by default

Eval runs execute **entirely in-process** — no external service, no API key. For
each approved dataset row the runner:

1. runs the task (the skill body as a system prompt, a prompt template, or an
   agent loop — see the three `make_*` task builders) to produce an output, then
2. runs each compiled scorer (`compile_scorers`) over that output. Scorers are
   generated Python that call an LLM-as-judge (`_Judge`) and return a `0..1`
   score, or `None` to opt out of a row (coverage/alignment gating).

Results are aggregated into an `EvalResult` (`per_row` + per-scorer averages),
persisted to the `eval_runs` table, and rendered by the Evaluate tab. This is
the `_run_local` function — it replaced a `braintrust.Eval()` call that did the
same map-over-rows-and-score loop we already owned the pieces for.

### Concurrency

`_run_local` processes rows with a bounded thread pool. Work is I/O-bound
(Anthropic HTTP for the task + judge), so threads give real speedup.

- `EVAL_MAX_CONCURRENCY` (default `5`) — max rows processed in parallel.

The judge's reasoning side-channel (`_Judge.last_response` / `.last_parsed`,
read by the scorer adapter to attach "why did this score 30%?" text to each row)
is backed by `threading.local()`, so concurrent rows never clobber each other's
reasoning. `scorer_traces` is keyed by `(row_id, scorer_name)`, so its writes are
race-free too. If you change the adapter's reset→call→read pattern, keep it
within a single thread.

## Optional: mirror to a Braintrust dashboard

The previous implementation ran every eval through Braintrust and required an API
key. That path is **kept intact but dormant** behind a flag, in case we want the
hosted experiment dashboard back:

- `EVAL_USE_BRAINTRUST=1` **and** a Braintrust key present (the
  `X-Braintrust-Key` header, or `BRAINTRUST_API_KEY` env, or the CLI's
  `BRAINTRUST_API_KEY`) → `run_eval_sync` uses `braintrust.Eval()` +
  `_extract_summary()` instead of `_run_local`, and `EvalResult.experiment_url`
  points at the Braintrust experiment.

When the flag is off (the default) the key is ignored entirely and
`experiment_url` is `null`. The frontend already renders the "View in Braintrust"
link conditionally, so a null URL degrades gracefully.

To fully retire Braintrust later: delete `_extract_summary`, the
`use_braintrust` branch in `run_eval_sync`, and the `braintrust` import — **but**
see the next section first.

## Not the same as production tracing

Separately from eval runs, `backend/app/tools.py` (`_ensure_braintrust_inited`,
`_maybe_wrap`) logs every backend LLM call (seed gen, scorer gen, etc.) to
Braintrust as traces. That path is gated on a **different** env var,
`BRAINTRUST_PROD_API_KEY`, and is unaffected by the eval runner's mode. This is
why the `braintrust` package stays in `requirements.txt` even though eval runs no
longer need it.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `EVAL_MAX_CONCURRENCY` | `5` | Rows scored in parallel by the local runner |
| `EVAL_USE_BRAINTRUST` | unset | `1` → mirror eval runs to a Braintrust dashboard (needs a Braintrust key) |
| `EVAL_MODEL` | `claude-opus-4-7` | Model that runs the skill under test |
| `JUDGE_MODEL` | `claude-sonnet-4-5-20250929` | LLM-as-judge model for scorers |
| `BRAINTRUST_PROD_API_KEY` | unset | Independent: production LLM-call tracing in tools.py |
