"""CLI wrapper around backend/app/eval_runner.py.

Two input modes:
  1. --session-id <uuid>    Fetch dataset + charter + scorers live from a
                            running North Star backend.
  2. --dataset-file + --scorers-file + --skill-file
                            Use files you already exported / hand-wrote.

For each approved row, the task runs the skill (SKILL.md body as system prompt)
via Claude, then every North Star scorer runs against the output. Results stream
into Braintrust as an Eval experiment.

Triggering rows (should_trigger in (true, false)) are skipped by default since
Braintrust isn't the right tool for routing evals — pass --include-triggering
to include them anyway.

Usage:
    export ANTHROPIC_API_KEY=sk-ant-...
    export BRAINTRUST_API_KEY=...
    python run_eval.py --session-id <uuid> --project my-skill-eval
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys

import httpx
from dotenv import load_dotenv

# The shared runner lives in the backend package. The backend venv installs
# `north-star` editable, so `from app.eval_runner import ...` resolves without
# extra PYTHONPATH gymnastics when this script runs inside that venv.
from app.eval_runner import DEFAULT_JUDGE_MODEL, DEFAULT_MODEL, run_eval_sync  # noqa: E402

load_dotenv()

DEFAULT_NORTH_STAR_URL = os.environ.get("NORTH_STAR_URL", "http://localhost:8080")


def fetch_from_north_star(session_id: str, base_url: str) -> tuple[list[dict], list[dict], str]:
    """Pull dataset rows, scorers, and skill body from a running backend."""
    with httpx.Client(base_url=base_url, timeout=30.0) as client:
        session = client.get(f"/sessions/{session_id}").raise_for_status().json()
        charter = session["state"]["charter"]
        skill_body = (charter.get("task") or {}).get("skill_body") or ""
        if not skill_body:
            raise SystemExit(
                f"Session {session_id} has no skill_body on charter.task. "
                "Seed it from a SKILL.md first."
            )
        scorers = session["state"].get("scorers") or []
        if not scorers:
            raise SystemExit(
                f"Session {session_id} has no scorers. "
                "Generate them via POST /sessions/{id}/generate-scorers first."
            )
        dataset = client.get(f"/sessions/{session_id}/dataset").raise_for_status().json()
        examples = dataset.get("examples") or []
        return examples, scorers, skill_body


def load_local_files(
    dataset_file: str, scorers_file: str, skill_file: str
) -> tuple[list[dict], list[dict], str]:
    dataset_raw = json.loads(pathlib.Path(dataset_file).expanduser().read_text())
    rows = dataset_raw if isinstance(dataset_raw, list) else dataset_raw.get("examples")
    if rows is None:
        raise SystemExit(f"Unrecognized dataset shape in {dataset_file}")

    scorers_raw = json.loads(pathlib.Path(scorers_file).expanduser().read_text())
    scorers = scorers_raw if isinstance(scorers_raw, list) else scorers_raw.get("scorers")
    if scorers is None:
        raise SystemExit(f"Unrecognized scorers shape in {scorers_file}")

    skill_body = pathlib.Path(skill_file).expanduser().read_text()
    if skill_body.startswith("---"):
        parts = skill_body.split("---", 2)
        if len(parts) == 3:
            skill_body = parts[2].lstrip()

    return rows, scorers, skill_body


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = parser.add_argument_group("source")
    src.add_argument("--session-id", help="North Star session UUID")
    src.add_argument("--north-star-url", default=DEFAULT_NORTH_STAR_URL)
    src.add_argument("--dataset-file")
    src.add_argument("--scorers-file")
    src.add_argument("--skill-file")

    run = parser.add_argument_group("run")
    run.add_argument("--project", default="northstar-eval")
    run.add_argument("--experiment", help="Optional experiment name")
    run.add_argument("--model", default=DEFAULT_MODEL)
    run.add_argument("--judge-model", default=DEFAULT_JUDGE_MODEL)
    run.add_argument("--include-triggering", action="store_true")
    run.add_argument("--limit", type=int)

    args = parser.parse_args()

    if args.session_id:
        examples, scorers, skill_body = fetch_from_north_star(args.session_id, args.north_star_url)
    elif args.dataset_file and args.scorers_file and args.skill_file:
        examples, scorers, skill_body = load_local_files(args.dataset_file, args.scorers_file, args.skill_file)
    else:
        parser.error("provide --session-id OR (--dataset-file + --scorers-file + --skill-file)")

    braintrust_key = os.environ.get("BRAINTRUST_API_KEY")
    if not braintrust_key:
        raise SystemExit("BRAINTRUST_API_KEY not set")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("ANTHROPIC_API_KEY not set")

    print(
        f"Running eval in project '{args.project}' "
        f"({len(examples)} examples in dataset, model={args.model}, judge={args.judge_model})",
        file=sys.stderr,
    )

    result = run_eval_sync(
        skill_body=skill_body,
        scorer_defs=scorers,
        examples=examples,
        braintrust_api_key=braintrust_key,
        project=args.project,
        experiment_name=args.experiment,
        model=args.model,
        judge_model=args.judge_model,
        include_triggering=args.include_triggering,
        limit=args.limit,
    )

    print(f"\nEvaluated {result.rows_evaluated}/{result.rows_total} rows")
    if result.experiment_url:
        print(f"Experiment: {result.experiment_url}")
    if result.scorer_averages:
        print("\nPer-scorer averages:")
        for name, avg in result.scorer_averages.items():
            print(f"  {name:<40} {avg:.3f}")


if __name__ == "__main__":
    main()
