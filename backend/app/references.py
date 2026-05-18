"""Bundled reference files that ship alongside SKILL.md.

Three deterministic, data-derived markdown files generated from existing
North Star state at skill-activation time:

- examples.md   — input → ideal output pairs from positive (label="good") rows
- off-target.md — stories with kind="off_target": requests the skill should NOT handle
- criteria.md   — charter coverage / alignment criteria as a self-check list

The win isn't "more files" — it's that every line is grounded in evaluated
data (rows the user labeled good, stories they marked off-target, criteria
they approved). The skill ships with receipts.

Each generator is pure: it takes the relevant slice of state and returns a
(body, signature) tuple. The signature is sha256 over the normalized inputs
so the caller can skip regeneration when nothing has moved.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Iterable

from .models import REFERENCE_FILENAMES, REFERENCE_KINDS, Charter, SkillReference


# Cap pulled from the dataset to keep examples.md scannable. The skill itself
# only reads the file on demand, but a 200-row appendix isn't more useful than
# a focused 12 — and progressive disclosure works against you when the file
# becomes a haystack.
MAX_EXAMPLES = 12

# How many characters to keep per input / output excerpt. The full row is
# stored on the dataset; this file is the cheat sheet, not the archive.
MAX_EXCERPT_CHARS = 1200


def _sig(payload: object) -> str:
    """Stable sha256 over a JSON-normalized payload. sort_keys + default=str
    so dict ordering and datetime objects don't perturb the hash."""
    blob = json.dumps(payload, sort_keys=True, default=str, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _truncate(text: str | None, limit: int = MAX_EXCERPT_CHARS) -> str:
    if not text:
        return ""
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


# --- examples.md ---------------------------------------------------------

def _select_example_rows(examples: list[dict]) -> list[dict]:
    """Filter to label='good' and cap at MAX_EXAMPLES.

    Ordered by created_at via the upstream SQL ORDER BY. We could rank by
    judge score, but the highest-scoring rows are also the least
    informative (everyone agrees they're correct); a balanced sample of
    user-endorsed positives is fine for the first cut."""
    goods = [
        ex for ex in examples
        if (ex.get("label") or "").lower() == "good"
        and (ex.get("input") or "").strip()
    ]
    return goods[:MAX_EXAMPLES]


def build_examples_md(examples: list[dict]) -> tuple[str, str]:
    rows = _select_example_rows(examples)
    sig_payload = {
        "kind": "examples",
        "count": len(rows),
        "rows": [
            {
                "id": r.get("id"),
                "input": _truncate(r.get("input")),
                "expected": _truncate(r.get("expected_output")),
                "feature_area": r.get("feature_area"),
                "should_trigger": r.get("should_trigger"),
            }
            for r in rows
        ],
    }
    signature = _sig(sig_payload)

    lines: list[str] = [
        "# Examples",
        "",
        "Canonical input → ideal output pairs from the positive rows in the",
        "North Star dataset. Use them as a shape guide before producing your own",
        "output.",
        "",
    ]

    if not rows:
        lines += [
            "_No labeled-good examples yet — label rows in the Dataset tab to populate this file._",
            "",
        ]
        return "\n".join(lines).rstrip() + "\n", signature

    for i, row in enumerate(rows, 1):
        area = row.get("feature_area") or "general"
        header = f"## Example {i} — {area}"
        # Triggered-mode rows may have should_trigger=False; surface that.
        should_trigger = row.get("should_trigger")
        if should_trigger is False:
            header += "  (should NOT trigger the skill)"
        lines.append(header)
        lines.append("")
        lines.append("**Input**")
        lines.append("")
        lines.append("```")
        lines.append(_truncate(row.get("input")))
        lines.append("```")
        lines.append("")
        expected = _truncate(row.get("expected_output"))
        if expected:
            lines.append("**Ideal output**")
            lines.append("")
            lines.append("```")
            lines.append(expected)
            lines.append("```")
            lines.append("")
        reason = (row.get("label_reason") or "").strip()
        if reason:
            lines.append(f"_Why it's good:_ {reason}")
            lines.append("")

    return "\n".join(lines).rstrip() + "\n", signature


# --- off-target.md -------------------------------------------------------

def _select_off_target_stories(stories: Iterable[dict]) -> list[dict]:
    return [
        s for s in stories
        if (s.get("kind") or "").lower() == "off_target"
        and (s.get("what") or "").strip()
    ]


def build_off_target_md(stories: list[dict]) -> tuple[str, str]:
    offs = _select_off_target_stories(stories)
    sig_payload = {
        "kind": "off_target",
        "stories": [
            {
                "who": (s.get("who") or "").strip(),
                "what": (s.get("what") or "").strip(),
                "why": (s.get("why") or "").strip(),
            }
            for s in offs
        ],
    }
    signature = _sig(sig_payload)

    lines: list[str] = [
        "# Off-target requests",
        "",
        "Adjacent asks that should NOT invoke this skill. If a user request",
        "matches one of these patterns, decline or hand off rather than",
        "engaging.",
        "",
    ]

    if not offs:
        lines += [
            "_No off-target stories captured yet — add them in the Stories tab to populate this file._",
            "",
        ]
        return "\n".join(lines).rstrip() + "\n", signature

    for s in offs:
        who = (s.get("who") or "Someone").strip()
        what = (s.get("what") or "").strip()
        why = (s.get("why") or "").strip()
        lines.append(f"- **{who}** — {what}")
        if why:
            lines.append(f"  - _Why this is off-target:_ {why}")

    lines.append("")
    return "\n".join(lines).rstrip() + "\n", signature


# --- criteria.md ---------------------------------------------------------

def _criteria_payload(charter: Charter | dict) -> dict:
    if isinstance(charter, Charter):
        data = charter.model_dump()
    else:
        data = charter or {}
    cov = data.get("coverage") or {}
    align = data.get("alignment") or []
    return {
        "coverage": cov.get("criteria") or [],
        "negative_coverage": cov.get("negative_criteria") or [],
        "alignment": [
            {
                "feature_area": a.get("feature_area") or "",
                "good": a.get("good") or "",
                "bad": a.get("bad") or "",
            }
            for a in align
        ],
    }


def build_criteria_md(charter: Charter | dict) -> tuple[str, str]:
    payload = _criteria_payload(charter)
    signature = _sig({"kind": "criteria", **payload})

    lines: list[str] = [
        "# Self-check criteria",
        "",
        "Before responding, walk this list. Each item maps to a North Star",
        "charter criterion the author approved.",
        "",
    ]

    cov = payload["coverage"]
    if cov:
        lines.append("## Coverage")
        lines.append("")
        for c in cov:
            lines.append(f"- [ ] {c}")
        lines.append("")

    neg = payload["negative_coverage"]
    if neg:
        lines.append("## Out of scope (do not handle)")
        lines.append("")
        for c in neg:
            lines.append(f"- [ ] Confirm this is **not** what's being asked: {c}")
        lines.append("")

    align = payload["alignment"]
    if align:
        lines.append("## Alignment")
        lines.append("")
        for a in align:
            area = a.get("feature_area") or "general"
            lines.append(f"### {area}")
            lines.append("")
            good = (a.get("good") or "").strip()
            bad = (a.get("bad") or "").strip()
            if good:
                lines.append(f"- ✅ Aim for: {good}")
            if bad:
                lines.append(f"- ❌ Avoid: {bad}")
            lines.append("")

    if not (cov or neg or align):
        lines.append(
            "_No charter criteria yet — define them in the Charter tab to populate this file._"
        )
        lines.append("")

    return "\n".join(lines).rstrip() + "\n", signature


# --- Orchestration -------------------------------------------------------

def generate_reference(
    kind: str,
    *,
    examples: list[dict] | None = None,
    stories: list[dict] | None = None,
    charter: Charter | dict | None = None,
) -> tuple[str, str]:
    """Return (body, signature) for the given reference kind.

    Callers pass only what's relevant; unused arguments are ignored so the
    same call site can branch on `kind` without juggling parameters.
    """
    if kind == "examples":
        return build_examples_md(examples or [])
    if kind == "off_target":
        return build_off_target_md(stories or [])
    if kind == "criteria":
        return build_criteria_md(charter or {})
    raise ValueError(f"Unknown reference kind: {kind!r}")


def make_reference_record(
    kind: str,
    body: str,
    signature: str,
    skill_version_id: str | None,
) -> dict:
    """Build the dict that lives in SessionState.skill_references."""
    if kind not in REFERENCE_KINDS:
        raise ValueError(f"Unknown reference kind: {kind!r}")
    return SkillReference(
        kind=kind,
        filename=REFERENCE_FILENAMES[kind],
        body=body,
        generated_at_skill_version_id=skill_version_id,
        source_signature=signature,
        updated_at=datetime.now(timezone.utc),
    ).model_dump(mode="json")
