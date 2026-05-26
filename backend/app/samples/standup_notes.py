"""Sample project: authoring a SKILL.md for daily standup notes.

Persona: team lead or engineer drafting a recurring async standup post.
The prose-only sample — no tools, no artifact. Proves the standard eval
path still works without agent-mode and that charter dimensions
(coverage / alignment / off-target) earn their keep even when there's
no file to inspect.
"""

from __future__ import annotations

from ..models import (
    AlignmentEntry,
    Charter,
    DimensionCriteria,
    Example,
    TaskDefinition,
)
from . import Sample


_DESCRIPTION = (
    "Use when a team member pastes a bullet list of what they did, what "
    "they're working on next, and any blockers, and asks for a formatted "
    "standup update suitable for Slack, a daily-update doc, or async "
    "standup tools. Do NOT trigger on weekly summaries, retrospectives, "
    "performance reviews, or status reports that aren't standups."
)


def build_sample(skill_body: str) -> Sample:
    return Sample(
        id="standup_notes",
        name="Daily standup notes",
        blurb="A SKILL.md that turns rough bullet points into a consistent Yesterday / Today / Blockers standup post. No tool calls.",
        skill_name="daily-standup-notes",
        skill_description=_DESCRIPTION,
        skill_body=skill_body,
        # `task` is intentionally omitted — see expense_reconciliation.py.
        seed={
            "goals": [
                "Turn a rough paste into a consistent three-section standup post with terse, first-person bullets.",
                "Never invent items the user didn't mention — no padding, no inferred blockers, no guessed 'Today' from 'Yesterday'.",
                "Stay narrow — refuse weekly summaries, retros, and performance reviews; redirect to the right format.",
            ],
            "users": [
                "Engineer posting in an async standup channel",
                "Team lead pasting items quickly between meetings",
            ],
            "positive_stories": [
                {
                    "who": "Engineer posting in an async standup channel",
                    "what": "paste a rough mix of bullets and prose and get a clean Yesterday / Today / Blockers post",
                    "why": "I post the same format every day without thinking about it.",
                },
                {
                    "who": "Team lead pasting items quickly between meetings",
                    "what": "preserve ticket IDs and PR numbers exactly as I wrote them",
                    "why": "my team can click through to the actual work.",
                },
                {
                    "who": "Engineer posting in an async standup channel",
                    "what": "say 'nothing blocking' and have the Blockers section render '- None'",
                    "why": "the section is always present and I don't have to think about it.",
                },
            ],
            "off_target_stories": [
                {
                    "who": "Engineer posting in an async standup channel",
                    "what": "draft the weekly summary for the team channel",
                    "why": "weekly summaries have a different shape — refuse and redirect.",
                },
                {
                    "who": "Team lead pasting items quickly between meetings",
                    "what": "write a retrospective for last sprint",
                    "why": "retros are reflective, not a quick status — different skill.",
                },
            ],
        },
        charter=Charter(
            task=TaskDefinition(
                input_description=(
                    "A short paste of recent work — bullets, prose, or a "
                    "mix — covering what was done, what's next, and "
                    "optionally blockers."
                ),
                output_description=(
                    "Markdown standup post with three sections — Yesterday, "
                    "Today, Blockers — each a short bulleted list."
                ),
                sample_input=(
                    "did the auth refactor, paired with Maya on the bug. "
                    "today: starting the rate-limit work. nothing blocking."
                ),
                sample_output=(
                    "**Yesterday**\n- Auth refactor\n- Paired with Maya on the bug\n\n"
                    "**Today**\n- Start rate-limit work\n\n"
                    "**Blockers**\n- None"
                ),
            ),
            coverage=DimensionCriteria(
                criteria=[
                    "Output contains exactly three sections — Yesterday, Today, Blockers — in that order.",
                    "Each bullet is at most one short sentence.",
                    "Blockers reads '- None' when the user didn't mention any.",
                    "Ticket IDs (LIN-1234) and PR numbers (PR #482) are preserved literally.",
                    "When the user provides no 'Today' items, the skill asks rather than guessing.",
                ],
                negative_criteria=[
                    "Refuses weekly summaries.",
                    "Refuses retrospectives.",
                    "Refuses performance reviews or self-evaluations.",
                ],
            ),
            balance=DimensionCriteria(
                criteria=[
                    "1-3 items per section: each on its own line, no nesting.",
                    "10+ items: still single-level bullets — do not introduce headings or sub-bullets.",
                    "Prose input is summarized to bullets, not preserved as paragraphs.",
                ],
            ),
            alignment=[
                AlignmentEntry(
                    feature_area="Bullet voice",
                    good="\"- Auth refactor\"",
                    bad="\"- Continued working on the auth refactor that I started yesterday\"",
                ),
                AlignmentEntry(
                    feature_area="Ticket preservation",
                    good="\"- Closed LIN-1234, opened PR #482\"",
                    bad="\"- Closed a ticket and opened a pull request\"",
                ),
                AlignmentEntry(
                    feature_area="Empty blockers",
                    good="\"**Blockers**\n- None\"",
                    bad="\"**Blockers**\n- Waiting on review for PR #482\" (invented — user said nothing blocking)",
                ),
            ],
            rot=DimensionCriteria(
                criteria=[
                    "Never invent items the user didn't mention.",
                    "Never guess a 'Today' list from a 'Yesterday' list — ask instead.",
                    "Never add filler ('Just finished...', 'Continued working on...') to a bullet.",
                ],
            ),
            safety=DimensionCriteria(),
        ),
        examples=[
            Example(
                feature_area="Mixed prose input",
                input=(
                    "did the auth refactor, paired with Maya on the bug. "
                    "today: starting the rate-limit work. nothing blocking."
                ),
                expected_output=(
                    "**Yesterday**\n- Auth refactor\n- Paired with Maya on the bug\n\n"
                    "**Today**\n- Start rate-limit work\n\n"
                    "**Blockers**\n- None"
                ),
                coverage_tags=["three sections present", "no invented blockers"],
                label="good",
                should_trigger=True,
            ),
            Example(
                feature_area="Ticket IDs preserved",
                input=(
                    "yesterday: closed LIN-1234, opened PR #482. today: review "
                    "PR #482, start LIN-1240. blocker: need design review on "
                    "the modal."
                ),
                expected_output=(
                    "**Yesterday**\n- Closed LIN-1234\n- Opened PR #482\n\n"
                    "**Today**\n- Review PR #482\n- Start LIN-1240\n\n"
                    "**Blockers**\n- Need design review on the modal"
                ),
                coverage_tags=["ticket preservation"],
                label="good",
                should_trigger=True,
            ),
            Example(
                feature_area="Missing Today list",
                input="yesterday I shipped the new dashboard. no blockers.",
                expected_output=(
                    "Skill asks the user what they're working on today rather "
                    "than guessing from yesterday. No standup post is produced."
                ),
                coverage_tags=["asks when missing"],
                label="good",
                label_reason=(
                    "Trigger-but-ask-back row: skill correctly triggers (it's "
                    "a standup ask) but should clarify rather than produce. "
                    "Distinct from off-target refusal rows."
                ),
                should_trigger=True,
            ),
            Example(
                feature_area="Refusal: weekly summary",
                input=(
                    "Draft my weekly summary for the team channel — covered "
                    "auth refactor, the bug bash, two new hires onboarded."
                ),
                expected_output="",
                coverage_tags=["refuses weekly summary"],
                label="good",
                label_reason="Off-target — weekly summary, not a standup.",
                should_trigger=False,
            ),
            Example(
                feature_area="Refusal: retrospective",
                input="Write up our sprint retro — what went well, what didn't.",
                expected_output="",
                coverage_tags=["refuses retrospective"],
                label="good",
                label_reason="Off-target — retros are reflective, different skill.",
                should_trigger=False,
            ),
        ],
    )
