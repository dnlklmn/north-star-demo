"""Backfill suggest_goals / evaluate_goals / suggest_stories turns.

Hits the three stateless endpoints with varied realistic inputs across a
spread of product domains so prompt-eval has dataset rows to sample. Each
call logs a turn under the supplied session_id (any real session will do —
the turns table only needs a valid FK; nothing about the source session
matters for prompt-eval sampling, which filters by turn_type only).

Run from the backend dir with the dev server up on port 8080:

    python scripts/backfill_prompt_eval_turns.py \\
        --session-id <existing-session-uuid> \\
        --base-url http://localhost:8080

Idempotent in the trivial sense — running it twice just adds more rows.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from typing import Any

import httpx


# Goal sets across distinct product domains, each with mixed goal quality
# (some specific + measurable, some vague) so evaluate_goals has both signal
# kinds and suggest_goals has space to extend.
GOAL_FIXTURES: list[list[str]] = [
    [
        "Reduce time-to-first-response on customer tickets by 40%",
        "Improve customer satisfaction",
    ],
    [
        "Generate code reviews that catch obvious bugs in pull requests",
        "Avoid suggesting changes that contradict the project's existing style",
        "Be helpful to developers",
    ],
    [
        "Draft internal status emails that follow our weekly template",
        "Match the tone of the channel — formal for #leadership, informal for #eng",
        "Cover wins, blockers, and next steps in every draft",
    ],
    [
        "Answer documentation questions using only what's in our internal docs",
        "Cite the doc page each answer came from",
        "Refuse to answer questions outside the docs scope",
    ],
    [
        "Summarize meeting transcripts into bulleted action items with owners",
        "Capture decisions and disagreements separately",
        "Stay under 250 words regardless of meeting length",
    ],
    [
        "Screen incoming candidate resumes against the role's requirements list",
        "Flag mismatches with a one-line reason",
        "Never reject a candidate solely on years-of-experience heuristics",
    ],
    [
        "Extract talking points from sales call transcripts",
        "Identify customer objections and the rep's response",
        "Tag each call with stage (discovery, demo, negotiation, closed)",
    ],
    [
        "Generate marketing email subject lines under 50 characters",
        "Match brand voice (warm, direct, no jargon)",
        "Avoid clickbait phrasing the brand guide forbids",
    ],
    [
        "Suggest the next task to work on based on calendar and priorities",
        "Be productive",
    ],
    [
        "Surface anomalies in product analytics dashboards",
        "Explain the anomaly in business terms, not statistical ones",
        "Distinguish weekly seasonal patterns from real changes",
    ],
    [
        "Improve user experience",
        "Drive engagement",
        "Reduce churn",
    ],
    [
        "Convert support transcripts into FAQ entries grouped by topic",
        "De-duplicate near-identical questions across transcripts",
    ],
]


# Stories paired with the goal-set index they extend — gives suggest_stories
# realistic seed material so the suggestions have something to extend rather
# than starting from empty.
STORY_FIXTURES: list[list[dict[str, str]]] = [
    [
        {"who": "support agent", "what": "see a draft reply within 30 seconds of opening a ticket", "why": "I can review and send instead of writing from scratch"},
    ],
    [
        {"who": "senior engineer", "what": "get review comments scoped to the diff, not the whole file", "why": "I don't have to wade through unrelated suggestions"},
        {"who": "junior engineer", "what": "have the reviewer explain why a change matters", "why": "I learn the reasoning instead of just the rule"},
    ],
    [
        {"who": "engineering manager", "what": "draft my weekly update from a list of bullets", "why": "I don't have to remember the template structure each week"},
    ],
    [
        {"who": "new hire", "what": "ask 'how do I deploy a hotfix' and get the runbook excerpt", "why": "I find the answer without bothering my onboarding buddy"},
    ],
    [
        {"who": "team lead", "what": "see the action items from a 60-minute planning meeting in 3 minutes of reading", "why": "I can act on them before context fades"},
    ],
    [
        {"who": "recruiter", "what": "see why a candidate didn't match the role requirements", "why": "I can give them honest feedback or surface them for a different role"},
    ],
    [
        {"who": "sales manager", "what": "review the talking points from yesterday's calls in one screen", "why": "I can coach reps on what worked and what didn't"},
    ],
    [
        {"who": "marketing manager", "what": "see 5 subject-line variants for an email campaign", "why": "I can pick one or remix without drafting from scratch"},
    ],
    [],  # Personal task planner: deliberately starts story-empty
    [
        {"who": "product analyst", "what": "see a plain-language explanation of why DAU dropped on Tuesday", "why": "I can decide whether to investigate or move on"},
    ],
    [],  # Vague-goals fixture: deliberately starts story-empty
    [],  # FAQ extraction: deliberately starts story-empty
]


async def hit(
    client: httpx.AsyncClient,
    base_url: str,
    path: str,
    payload: dict[str, Any],
    label: str,
    headers: dict[str, str] | None = None,
) -> tuple[bool, str]:
    """Fire one endpoint call. Returns (success, short_message)."""
    try:
        resp = await client.post(
            f"{base_url}{path}",
            json=payload,
            headers=headers or {},
            timeout=60,
        )
    except Exception as e:  # noqa: BLE001
        return False, f"{label}: request failed — {e}"
    if resp.status_code != 200:
        return False, f"{label}: HTTP {resp.status_code} — {resp.text[:200]}"
    body = resp.json()
    # Cheap shape check: the response carries either suggestions or feedback.
    if "suggestions" in body:
        n = len(body["suggestions"])
        return True, f"{label}: {n} suggestions"
    if "feedback" in body:
        n = len(body["feedback"])
        return True, f"{label}: {n} feedback items"
    return True, f"{label}: ok"


async def backfill(session_id: str, base_url: str, concurrency: int, api_key: str | None) -> None:
    """Fan out one call per fixture per endpoint, capped by `concurrency`.

    Concurrency=4 is a friendly default — the dev server is single-process and
    the LLM provider's per-key rate limits will throttle anyway. Push higher
    if you're impatient and the provider can keep up.
    """
    semaphore = asyncio.Semaphore(concurrency)
    # Per-request API key forwarded via the same header the frontend uses.
    # OpenRouter keys (sk-or-…) are auto-routed by the backend's client builder;
    # Anthropic keys (sk-ant-…) hit Anthropic directly. None falls through to
    # the backend's env-var fallback (which is the dead Anthropic key here).
    headers = {"X-Anthropic-Key": api_key} if api_key else {}

    async def with_sema(coro):
        async with semaphore:
            return await coro

    async with httpx.AsyncClient() as client:
        tasks: list[Any] = []

        for i, goals in enumerate(GOAL_FIXTURES):
            tasks.append(with_sema(hit(
                client, base_url, "/suggest-goals",
                {"goals": goals, "session_id": session_id},
                f"suggest_goals[{i}]",
                headers,
            )))
            tasks.append(with_sema(hit(
                client, base_url, "/evaluate-goals",
                {"goals": goals, "session_id": session_id},
                f"evaluate_goals[{i}]",
                headers,
            )))
            stories = STORY_FIXTURES[i] if i < len(STORY_FIXTURES) else []
            tasks.append(with_sema(hit(
                client, base_url, "/suggest-stories",
                {"goals": goals, "stories": stories, "session_id": session_id},
                f"suggest_stories[{i}]",
                headers,
            )))

        start = time.time()
        results = await asyncio.gather(*tasks)
        elapsed = time.time() - start

    ok = sum(1 for s, _ in results if s)
    fail = len(results) - ok
    print(f"\nDone in {elapsed:.1f}s: {ok} ok, {fail} failed (out of {len(results)} calls)")
    for success, msg in results:
        prefix = "✓" if success else "✗"
        print(f"  {prefix} {msg}")
    if fail:
        sys.exit(1)


def main() -> None:
    import os
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--session-id", required=True, help="Existing session UUID — turns will be FK'd here")
    p.add_argument("--base-url", default="http://localhost:8080", help="Backend base URL")
    p.add_argument("--concurrency", type=int, default=4, help="Parallel in-flight requests")
    p.add_argument(
        "--api-key",
        default=None,
        help=(
            "API key forwarded as X-Anthropic-Key. Accepts sk-ant-… (Anthropic) "
            "or sk-or-… (OpenRouter). Falls back to OPENROUTER_API_KEY / "
            "ANTHROPIC_API_KEY env vars in that order."
        ),
    )
    args = p.parse_args()

    api_key = args.api_key or os.environ.get("OPENROUTER_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("WARNING: no --api-key, OPENROUTER_API_KEY, or ANTHROPIC_API_KEY found.")
        print("The backend will use its own env-var fallback, which may be out of credit.")

    print(f"Backfilling against {args.base_url} (session {args.session_id}, concurrency {args.concurrency})")
    if api_key:
        # Don't echo a long prefix — first 10 chars include `sk-or-v1-` plus
        # account fingerprint, which is enough to recognize the key on a
        # shoulder-surfed terminal or shared screenshot. Last 4 alone is the
        # standard hygiene pattern.
        provider = "OpenRouter" if api_key.startswith("sk-or-") else "Anthropic"
        print(f"Using {provider} key (…{api_key[-4:]})")
    print(f"Calls: {len(GOAL_FIXTURES)} goal-sets × 3 endpoints = {len(GOAL_FIXTURES) * 3}")
    asyncio.run(backfill(args.session_id, args.base_url, args.concurrency, api_key))


if __name__ == "__main__":
    main()
