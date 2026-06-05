#!/usr/bin/env python3
"""Export a session's training corpus to JSONL.

Thin CLI wrapper around the ``GET /sessions/{id}/training-corpus`` endpoint.
Streams the response line-by-line so even a session with hundreds of eval
runs doesn't blow up. Use this for one-off corpus exports for analysis,
the parsing-reliability study, or seed material for an eventual
distillation run.

The endpoint joins eval runs × dataset examples and yields one JSON object
per (eval_run, dataset_row, scorer) pairing. See
``docs/tier3a-training-data-capture.md`` for the row shape.

Examples:

    # Default — judge-only samples for the whole session
    scripts/export_training_corpus.py <session_id> > corpus.jsonl

    # Include gated-out + deterministic scorers (accounting / debugging)
    scripts/export_training_corpus.py <session_id> --include-skipped --include-deterministic

    # Hit a non-localhost backend
    scripts/export_training_corpus.py <session_id> --base-url https://north-star.example.com
"""

from __future__ import annotations

import argparse
import os
import sys

import httpx


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("session_id", help="The session whose corpus to export.")
    p.add_argument("--base-url", default="http://localhost:5001", help="Backend URL (default: %(default)s)")
    p.add_argument("--include-skipped", action="store_true", help="Include gated-out scorer entries.")
    p.add_argument("--include-deterministic", action="store_true", help="Include deterministic scorers (no judge text).")
    p.add_argument("--eval-run-limit", type=int, default=50, help="Max eval runs to walk (default: %(default)s).")
    p.add_argument("--output", "-o", default="-", help="Output path; '-' for stdout (default: %(default)s).")
    args = p.parse_args()

    # The backend reads X-Anthropic-Key for non-DB endpoints; this endpoint
    # doesn't actually call the LLM, but the header costs nothing to forward
    # when a key is in env. Keeps behaviour consistent if the endpoint ever
    # adds auth.
    headers: dict[str, str] = {}
    key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    if key:
        headers["X-Anthropic-Key"] = key

    url = (
        f"{args.base_url.rstrip('/')}/sessions/{args.session_id}/training-corpus"
        f"?include_skipped={'true' if args.include_skipped else 'false'}"
        f"&include_deterministic={'true' if args.include_deterministic else 'false'}"
        f"&eval_run_limit={args.eval_run_limit}"
    )

    out = sys.stdout.buffer if args.output == "-" else open(args.output, "wb")
    n = 0
    try:
        # 5-minute read timeout — large sessions can be slow to stream the
        # join end-to-end. Per-line yield from the backend means we make
        # forward progress steadily, but the WHOLE export can still take a
        # while on hundreds of eval runs.
        with httpx.stream("GET", url, headers=headers, timeout=httpx.Timeout(60.0, read=300.0)) as r:
            r.raise_for_status()
            for line in r.iter_lines():
                if not line:
                    continue
                if isinstance(line, str):
                    out.write((line + "\n").encode("utf-8"))
                else:
                    out.write(line + b"\n")
                n += 1
    except httpx.HTTPStatusError as e:
        body = e.response.text[:500] if e.response is not None else ""
        print(f"error: HTTP {e.response.status_code if e.response else '?'}: {body}", file=sys.stderr)
        return 2
    except httpx.HTTPError as e:
        print(f"error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    finally:
        if out is not sys.stdout.buffer:
            out.close()

    where = "stdout" if args.output == "-" else args.output
    print(f"Wrote {n} training samples to {where}.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
