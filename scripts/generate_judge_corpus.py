#!/usr/bin/env python3
"""Generate a corpus of judge responses by running the full North Star
flow over a catalog of diverse skill specs, then dump every captured
``judge_response`` for the Tier 3A sub-criteria parsing study.

Why this exists: the planning doc (docs/tier3a-training-data-capture.md)
calls for sampling ~50 real CoT-rubric judge responses to decide between
Phase 2a (parse-at-extract) and Phase 2b (structured scorer return).
With no production traffic yet, the only way to get real samples is to
run the flow ourselves. This script automates that.

Flow per skill spec:

    1. POST /sessions                            create_session
    2. PATCH /sessions/{id}/input                set goals + stories
    3. POST /sessions/{id}/generate-skill-from-goals
                                                   gen skill (auto-analyzes
                                                   on the frontend now;
                                                   we replicate by also
                                                   calling skill-import
                                                   directly here)
    4. POST /sessions/{id}/skill-import          analyze (idempotent)
    5. POST /sessions/{id}/dataset               create dataset
    6. POST /datasets/{id}/synthesize            synth examples
    7. POST /sessions/{id}/generate-scorers      hybrid generator
    8. POST /sessions/{id}/run-eval              kick off eval
    9. GET  /sessions/{id}/eval-runs/{run_id}    poll to terminal
   10. Extract per_row[*].scorer_metadata[*].judge_response

Each captured judge_response lands as one JSONL row in the corpus file
along with provenance (session_id, eval_run_id, scorer_name, score,
scorer_type, model_used). That's what the parser study reads.

Two modes:

  parsing  — defaults tuned for the parsing study: ~5 diverse skills,
             ~20 rows each, count_per_scenario=4. Yields ~300 judge
             samples; cheap (under $10 on Haiku); same prompt format
             exercised against varied content.

  corpus   — broader: configurable N skills (default 50), fewer rows
             each. Stress-tests the generator + builds a demo corpus.
             Most-expensive option; only run when you have time + budget.

Requires the North Star backend running locally (or pass --base-url).
Reads ANTHROPIC_API_KEY (or OPENROUTER_API_KEY) and BRAINTRUST_API_KEY
from env.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx


# ---------------------------------------------------------------------------
# Seed catalog — diverse skill specs covering varied output shapes
# ---------------------------------------------------------------------------
#
# Variety axes matter more than count for the parsing study: each spec
# exercises the CoT-rubric judge prompt against a different content shape.
# Categories:
#   - JSON-output skills (strict schema)
#   - Prose-output skills (tone-heavy, subjective)
#   - Mixed markdown (structure + prose)
#   - Numeric / format-strict outputs
#
# Each spec is intentionally minimal — goals + a couple of stories. The
# /generate-skill-from-goals endpoint fills in the rest, then skill-import
# extracts task input/output descriptions and off-target stories.

SKILL_CATALOG: list[dict[str, Any]] = [
    {
        "name": "meeting-notes-summarizer",
        "description": "Turn raw meeting notes into a TL;DR + bullet decisions",
        "goals": [
            "Produce a 1-2 sentence TL;DR summarizing the meeting's outcome",
            "List concrete decisions and action items with owners",
            "Stay under 200 words total",
        ],
        "story_groups": [
            {
                "role": "product manager",
                "stories": [
                    {"what": "paste in raw notes and get a clean summary", "why": "share with absent stakeholders"},
                    {"what": "see action items with owners called out", "why": "follow up next week"},
                ],
            },
        ],
    },
    {
        "name": "form-field-extractor",
        "description": "Pull structured fields from unstructured customer messages",
        "goals": [
            "Extract customer name, order number, and request type into JSON",
            "Output strictly valid JSON with no extra commentary",
            "Use null when a field can't be found rather than guessing",
        ],
        "story_groups": [
            {
                "role": "support engineer",
                "stories": [
                    {"what": "paste in a support ticket and get parsed fields", "why": "feed downstream automation"},
                    {"what": "see null for missing fields, never a hallucinated value", "why": "preserve data integrity"},
                ],
            },
        ],
    },
    {
        "name": "customer-support-reply",
        "description": "Draft a customer-support reply matching brand tone",
        "goals": [
            "Acknowledge the issue in the first sentence",
            "Stay warm but concise — no fluff, no over-apologizing",
            "End with a clear next step or question",
        ],
        "story_groups": [
            {
                "role": "support agent",
                "stories": [
                    {"what": "get a draft reply for a tricky complaint", "why": "save typing time but keep my voice"},
                    {"what": "see a reply that doesn't grovel or over-promise", "why": "stays consistent with brand voice"},
                ],
            },
        ],
    },
    {
        "name": "code-review-comment",
        "description": "Generate constructive code review feedback in markdown",
        "goals": [
            "Identify the most important issue in the diff first",
            "Suggest a concrete improvement with a code example",
            "Stay professional and avoid nitpicking",
        ],
        "story_groups": [
            {
                "role": "senior engineer",
                "stories": [
                    {"what": "paste in a diff and get focused review notes", "why": "speed up PR reviews"},
                    {"what": "see code examples in suggestions", "why": "easier to act on than vague feedback"},
                ],
            },
        ],
    },
    {
        "name": "bug-report-triager",
        "description": "Classify incoming bug reports into priority + component",
        "goals": [
            "Output priority (P0/P1/P2/P3), component, and a 1-line summary",
            "Format as a tiny JSON object with exactly those three fields",
            "Be conservative — only P0 for true production outages",
        ],
        "story_groups": [
            {
                "role": "on-call engineer",
                "stories": [
                    {"what": "auto-triage incoming bug reports", "why": "stop spending an hour each morning"},
                    {"what": "see priorities that don't inflate", "why": "preserve P0 meaning for real outages"},
                ],
            },
        ],
    },
    {
        "name": "product-description-writer",
        "description": "Write a 50-100 word product description for an ecommerce listing",
        "goals": [
            "Lead with the single most-important benefit",
            "Avoid marketing fluff words (amazing, revolutionary, best-in-class)",
            "End with one specific use case or scenario",
        ],
        "story_groups": [
            {
                "role": "ecommerce manager",
                "stories": [
                    {"what": "draft descriptions from spec sheets", "why": "ship new SKUs faster"},
                    {"what": "see descriptions without salesy adjectives", "why": "matches our brand voice"},
                ],
            },
        ],
    },
    {
        "name": "calendar-invite-extractor",
        "description": "Parse a meeting request email into calendar-invite fields",
        "goals": [
            "Extract title, attendees (emails), start time (ISO 8601), duration in minutes",
            "Return JSON with these four keys exactly",
            "If a time is ambiguous, return null for start_time rather than guessing",
        ],
        "story_groups": [
            {
                "role": "executive assistant",
                "stories": [
                    {"what": "paste in a request email and get the calendar event", "why": "saves the manual entry step"},
                    {"what": "see null when a time is ambiguous", "why": "prevents booking the wrong slot"},
                ],
            },
        ],
    },
    {
        "name": "recipe-scaler",
        "description": "Scale a recipe's ingredient list to a different serving count",
        "goals": [
            "Multiply each ingredient quantity by the new/old ratio",
            "Preserve original units; convert only when fractions become awkward",
            "Round sensibly — no 'use 0.3333 eggs'",
        ],
        "story_groups": [
            {
                "role": "home cook",
                "stories": [
                    {"what": "scale a 4-serving recipe to 10", "why": "dinner party"},
                    {"what": "see whole eggs and reasonable fractions", "why": "actually cookable"},
                ],
            },
        ],
    },
    {
        "name": "release-notes-writer",
        "description": "Convert a list of PR descriptions into user-facing release notes",
        "goals": [
            "Group changes into Features / Fixes / Improvements",
            "Write each bullet in user-impact terms, not engineering jargon",
            "Drop internal-only refactors entirely",
        ],
        "story_groups": [
            {
                "role": "product marketing",
                "stories": [
                    {"what": "turn a sprint's PRs into release notes", "why": "ship the update notification"},
                    {"what": "see user-facing wording, not commit messages", "why": "customers actually understand"},
                ],
            },
        ],
    },
    {
        "name": "sql-query-explainer",
        "description": "Explain what a SQL query does in plain English",
        "goals": [
            "Describe the query's intent in one sentence",
            "Walk through the joins and filters in order",
            "Flag any potential performance issues (missing index, full scan)",
        ],
        "story_groups": [
            {
                "role": "data analyst",
                "stories": [
                    {"what": "paste in someone else's SQL and understand it fast", "why": "before modifying"},
                    {"what": "see performance flags called out", "why": "avoid breaking prod"},
                ],
            },
        ],
    },
]


# ---------------------------------------------------------------------------
# CLI args + runtime config
# ---------------------------------------------------------------------------

@dataclass
class Config:
    base_url: str
    anthropic_key: str | None
    openrouter_key: str | None
    braintrust_key: str | None
    mode: str
    n_skills: int
    n_rows_per_scenario: int
    parallel: int
    output_path: Path
    project_name: str
    poll_interval_s: float
    poll_timeout_s: float

    @property
    def auth_headers(self) -> dict[str, str]:
        h: dict[str, str] = {"Content-Type": "application/json"}
        # The backend reads X-Anthropic-Key. OpenRouter keys go in the same
        # header because the backend's get_client() detects `sk-or-` prefix
        # and routes to OpenRouter. So we just hand whichever key we have,
        # preferring OpenRouter when present so we don't burn Anthropic
        # spend on a corpus generation job.
        key = self.openrouter_key or self.anthropic_key
        if key:
            h["X-Anthropic-Key"] = key
        if self.braintrust_key:
            h["X-Braintrust-Key"] = self.braintrust_key
        return h


def parse_args() -> Config:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base-url", default="http://localhost:5000", help="Backend URL (default: %(default)s)")
    p.add_argument(
        "--mode",
        choices=("parsing", "corpus"),
        default="parsing",
        help="parsing: small batch tuned for the Tier 3A parsing study. "
             "corpus: larger N for stress test / demo. Default: %(default)s.",
    )
    p.add_argument("--n-skills", type=int, default=None, help="Override skill count (default: 5 in parsing mode, 50 in corpus mode)")
    p.add_argument("--n-rows-per-scenario", type=int, default=None, help="Rows per (alignment × coverage) cell (default: 4 in parsing mode, 1 in corpus mode)")
    p.add_argument("--parallel", type=int, default=3, help="Max concurrent skill pipelines (default: %(default)s)")
    p.add_argument("--output", default="judge_corpus.jsonl", help="Output JSONL path (default: %(default)s)")
    p.add_argument("--project", default="north-star-corpus", help="Braintrust project name for the runs (default: %(default)s)")
    p.add_argument("--poll-interval", type=float, default=5.0, help="Seconds between eval-run status polls (default: %(default)s)")
    p.add_argument("--poll-timeout", type=float, default=600.0, help="Max seconds to wait per eval run (default: %(default)s)")
    args = p.parse_args()

    # Resolve mode-aware defaults so callers can keep `--mode parsing` ergonomic.
    if args.n_skills is None:
        args.n_skills = 5 if args.mode == "parsing" else 50
    if args.n_rows_per_scenario is None:
        args.n_rows_per_scenario = 4 if args.mode == "parsing" else 1

    return Config(
        base_url=args.base_url.rstrip("/"),
        anthropic_key=os.environ.get("ANTHROPIC_API_KEY"),
        openrouter_key=os.environ.get("OPENROUTER_API_KEY"),
        braintrust_key=os.environ.get("BRAINTRUST_API_KEY"),
        mode=args.mode,
        n_skills=args.n_skills,
        n_rows_per_scenario=args.n_rows_per_scenario,
        parallel=args.parallel,
        output_path=Path(args.output),
        project_name=args.project,
        poll_interval_s=args.poll_interval,
        poll_timeout_s=args.poll_timeout,
    )


# ---------------------------------------------------------------------------
# Per-skill pipeline
# ---------------------------------------------------------------------------

@dataclass
class SkillResult:
    spec_name: str
    session_id: str
    eval_run_id: str | None
    status: str
    rows_evaluated: int
    judge_response_count: int
    error: str | None = None
    samples: list[dict[str, Any]] = field(default_factory=list)


async def run_skill(
    client: httpx.AsyncClient,
    cfg: Config,
    spec: dict[str, Any],
    spec_idx: int,
) -> SkillResult:
    """Drive one skill spec through the full flow.

    Returns a SkillResult with the captured judge_response samples. Failures
    at any pipeline step are caught and surfaced through the result; we
    don't want one broken spec to kill the whole run.
    """
    name = spec["name"]
    log = lambda msg: print(f"  [{spec_idx:02d}/{cfg.n_skills} {name}] {msg}", flush=True)

    try:
        # 1. Create session
        r = await client.post(
            f"{cfg.base_url}/sessions",
            json={
                "initial_input": {"goals": [], "story_groups": []},
                "name": f"corpus-{name}",
            },
        )
        r.raise_for_status()
        session_id = r.json()["session_id"]
        log(f"session {session_id[:8]}")

        # 2. Set goals + stories — the seed of the whole flow
        r = await client.patch(
            f"{cfg.base_url}/sessions/{session_id}/input",
            json={
                "goals": spec["goals"],
                "story_groups": spec["story_groups"],
            },
        )
        r.raise_for_status()

        # 3. Generate skill from goals (LLM call)
        r = await client.post(
            f"{cfg.base_url}/sessions/{session_id}/generate-skill-from-goals",
            json={},
            timeout=120.0,
        )
        r.raise_for_status()
        skill_body = r.json()["body"]
        skill_name = r.json().get("name") or spec["name"]
        skill_description = r.json().get("description") or spec.get("description")
        log(f"skill {len(skill_body)} chars")

        # 4. Analyze (idempotent — frontend chains this, but we're hitting
        # the backend directly so we call it explicitly to populate the
        # extracted_* fields seed generation needs).
        r = await client.post(
            f"{cfg.base_url}/sessions/{session_id}/skill-import",
            json={
                "skill_body": skill_body,
                "skill_name": skill_name,
                "skill_description": skill_description,
            },
            timeout=180.0,
        )
        r.raise_for_status()
        log("analyzed")

        # 5. Create dataset
        r = await client.post(
            f"{cfg.base_url}/sessions/{session_id}/dataset",
            json={"name": f"corpus-{name}-ds"},
        )
        r.raise_for_status()
        dataset_id = r.json()["id"]

        # 6. Synthesize examples — variety amplification happens here, in
        # the LLM's per-cell scenario generation. count_per_scenario=4 in
        # parsing mode = ~16-24 rows per skill depending on dimension count.
        r = await client.post(
            f"{cfg.base_url}/datasets/{dataset_id}/synthesize",
            json={"count_per_scenario": cfg.n_rows_per_scenario},
            timeout=600.0,
        )
        r.raise_for_status()
        generated = r.json().get("generated", 0)
        log(f"synth {generated} rows")

        # 7. Generate scorers (hybrid pass — deterministic + judge)
        r = await client.post(
            f"{cfg.base_url}/sessions/{session_id}/generate-scorers",
            json={},
            timeout=180.0,
        )
        r.raise_for_status()
        scorers = r.json().get("scorers", [])
        log(f"scorers {len(scorers)}")

        # 8. Run eval — this is what generates judge_response. We default to
        # not setting limit so all synth'd rows run. include_triggering=True
        # because we want maximum data variety for the parsing study.
        r = await client.post(
            f"{cfg.base_url}/sessions/{session_id}/run-eval",
            json={
                "project": cfg.project_name,
                "experiment_name": f"corpus-{name}",
                "include_triggering": True,
            },
            timeout=60.0,
        )
        r.raise_for_status()
        run_id = r.json()["run_id"]
        log(f"eval {run_id[:8]} started")

        # 9. Poll to terminal — eval is async, may take minutes for many rows
        eval_summary = await _poll_eval(client, cfg, session_id, run_id, log)

        # 10. Pull captured judge_response samples
        samples = _extract_judge_samples(eval_summary, spec_name=name, run_id=run_id)
        log(f"done · {len(samples)} judge samples captured")

        return SkillResult(
            spec_name=name,
            session_id=session_id,
            eval_run_id=run_id,
            status=eval_summary.get("status", "unknown"),
            rows_evaluated=eval_summary.get("rows_evaluated", 0),
            judge_response_count=len(samples),
            samples=samples,
        )

    except httpx.HTTPStatusError as e:
        body = e.response.text[:300] if e.response is not None else ""
        log(f"HTTP {e.response.status_code if e.response else '?'}: {body}")
        return SkillResult(
            spec_name=name, session_id="", eval_run_id=None,
            status="http_error", rows_evaluated=0, judge_response_count=0,
            error=f"{e}: {body}",
        )
    except Exception as e:  # noqa: BLE001
        log(f"FAILED: {type(e).__name__}: {e}")
        return SkillResult(
            spec_name=name, session_id="", eval_run_id=None,
            status="exception", rows_evaluated=0, judge_response_count=0,
            error=f"{type(e).__name__}: {e}",
        )


async def _poll_eval(
    client: httpx.AsyncClient,
    cfg: Config,
    session_id: str,
    run_id: str,
    log,
) -> dict[str, Any]:
    """Poll the eval-run status until it hits a terminal state or times out.

    Returns the final EvalRunSummary dict. Doesn't raise on terminal-but-
    failed — the caller decides what to do with non-`done` statuses.
    """
    terminal = {"done", "failed", "error", "cancelled"}
    start = time.monotonic()
    last_status = None
    while True:
        if time.monotonic() - start > cfg.poll_timeout_s:
            log(f"poll timed out after {cfg.poll_timeout_s:.0f}s")
            return {"status": "timeout", "rows_evaluated": 0, "per_row": []}
        r = await client.get(f"{cfg.base_url}/sessions/{session_id}/eval-runs/{run_id}")
        r.raise_for_status()
        data = r.json()
        status = data.get("status")
        if status != last_status:
            log(f"eval status={status} rows={data.get('rows_evaluated', 0)}/{data.get('rows_total', 0)}")
            last_status = status
        if status in terminal:
            return data
        await asyncio.sleep(cfg.poll_interval_s)


def _extract_judge_samples(eval_summary: dict[str, Any], spec_name: str, run_id: str) -> list[dict[str, Any]]:
    """Pull each captured judge_response out of an EvalRunSummary, one
    JSONL-shaped row per (dataset_row, scorer_name) pairing.

    Only includes scorers that actually invoked the judge (i.e. have a
    judge_response). Deterministic scorers — which are the whole point of
    hybrid scoring — are skipped here because they don't produce judge
    output to parse. They're tallied separately in the run summary.
    """
    samples: list[dict[str, Any]] = []
    per_row = eval_summary.get("per_row") or []
    judge_model = eval_summary.get("judge_model_used")
    for row in per_row:
        scorer_metadata = row.get("scorer_metadata") or {}
        if not isinstance(scorer_metadata, dict):
            continue
        for scorer_name, meta in scorer_metadata.items():
            if not isinstance(meta, dict):
                continue
            judge_response = meta.get("judge_response")
            if not judge_response:
                # Deterministic scorer (no LLM call) — skip for the parsing
                # study, which is about judge output formatting.
                continue
            samples.append({
                "spec_name": spec_name,
                "eval_run_id": run_id,
                "row_id": row.get("input", {}).get("id") if isinstance(row.get("input"), dict) else None,
                "scorer_name": scorer_name,
                "score": meta.get("score"),
                "judge_response": judge_response,
                "judge_model": judge_model,
            })
    return samples


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

async def main_async(cfg: Config) -> int:
    if not cfg.anthropic_key and not cfg.openrouter_key:
        print("error: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY", file=sys.stderr)
        return 2
    if not cfg.braintrust_key:
        print("error: set BRAINTRUST_API_KEY (eval runs require Braintrust)", file=sys.stderr)
        return 2

    # Pick N specs from the catalog. If N exceeds the catalog, cycle with
    # an index suffix so each session has a unique name in the backend.
    specs = _select_specs(cfg.n_skills)
    print(
        f"\nMode: {cfg.mode}  ·  Skills: {cfg.n_skills}  ·  Rows-per-scenario: {cfg.n_rows_per_scenario}  ·  Parallel: {cfg.parallel}\n"
        f"Backend: {cfg.base_url}  ·  Auth: {'OpenRouter' if cfg.openrouter_key else 'Anthropic'}  ·  Project: {cfg.project_name}\n"
        f"Output: {cfg.output_path}\n",
        flush=True,
    )

    semaphore = asyncio.Semaphore(cfg.parallel)
    results: list[SkillResult] = []

    async with httpx.AsyncClient(
        headers=cfg.auth_headers,
        timeout=httpx.Timeout(60.0, read=180.0),  # generous for slow LLM endpoints
    ) as client:
        async def bounded(spec: dict, idx: int) -> SkillResult:
            async with semaphore:
                return await run_skill(client, cfg, spec, idx)

        tasks = [bounded(spec, i + 1) for i, spec in enumerate(specs)]
        for coro in asyncio.as_completed(tasks):
            r = await coro
            results.append(r)
            # Stream samples to disk as they arrive so a mid-run crash
            # doesn't lose what's already gathered.
            _append_samples(cfg.output_path, r.samples)

    _print_summary(results, cfg)
    return 0


def _select_specs(n: int) -> list[dict[str, Any]]:
    """Pick N specs from the catalog. Cycles with -2/-3 suffix when n exceeds catalog size.

    Cycling instead of bailing because a corpus-mode run wants N=50 and we
    only have ~10 specs. Reusing each one with rotated story content from
    the catalog gives the LLM enough variation per cycle to produce
    different scorers and datasets — what we care about is the judge
    response format, which isn't affected by spec reuse.
    """
    if n <= len(SKILL_CATALOG):
        # Random sample preserves catalog diversity when n < catalog size.
        rng = random.Random(0xC0DE)
        return rng.sample(SKILL_CATALOG, n)
    out = []
    for i in range(n):
        base = SKILL_CATALOG[i % len(SKILL_CATALOG)]
        if i < len(SKILL_CATALOG):
            out.append(base)
        else:
            out.append({**base, "name": f"{base['name']}-v{i // len(SKILL_CATALOG) + 1}"})
    return out


def _append_samples(path: Path, samples: list[dict[str, Any]]) -> None:
    """Append JSONL rows; create parent dir if missing."""
    if not samples:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        for s in samples:
            f.write(json.dumps(s) + "\n")


def _print_summary(results: list[SkillResult], cfg: Config) -> None:
    total_samples = sum(r.judge_response_count for r in results)
    successful = [r for r in results if r.status == "done"]
    failed = [r for r in results if r.status not in ("done", "unknown")]

    print("\n" + "=" * 72)
    print(f"Done. Wrote {total_samples} judge samples to {cfg.output_path}")
    print(f"  Successful: {len(successful)}/{len(results)}")
    if failed:
        print(f"  Failed: {len(failed)}")
        for r in failed[:10]:
            print(f"    · {r.spec_name}: {r.status} — {r.error or '(no detail)'}")
        if len(failed) > 10:
            print(f"    · ...and {len(failed) - 10} more")

    if total_samples > 0:
        # Quick parser-friendliness preview so the user knows whether the
        # captured corpus looks usable before they kick off the analysis.
        sample = results[0].samples[0] if results[0].samples else None
        if sample:
            preview = sample["judge_response"][:300]
            print(f"\nSample judge_response (first 300 chars):\n  {preview!r}")
    print("=" * 72)


def main() -> int:
    return asyncio.run(main_async(parse_args()))


if __name__ == "__main__":
    sys.exit(main())
