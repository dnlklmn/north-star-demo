"""Sample project: authoring a SKILL.md for quarterly investor update memos.

Persona: founder / COO drafting a recurring memo to investors. Exercises
agent-mode for .docx production — the model must actually produce a Word
file with the right section headings, not just narrate that it did.
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
    "Use when a founder, COO, or operator asks for a quarterly or monthly "
    "investor update memo. Takes a list of KPIs and qualitative notes and "
    "produces a .docx file with the four canonical sections — Highlights, "
    "KPIs, Risks, Asks — formatted for a Word or Google Docs reader. Do "
    "NOT trigger on internal status updates, team standups, marketing "
    "copy, or fundraising pitch material."
)


def build_sample(skill_body: str) -> Sample:
    return Sample(
        id="investor_memo",
        name="Quarterly investor update memo",
        blurb="A SKILL.md that turns KPIs + notes into a structured .docx investor update with Highlights / KPIs / Risks / Asks.",
        skill_name="quarterly-investor-update",
        skill_description=_DESCRIPTION,
        skill_body=skill_body,
        # `task` is intentionally omitted — see expense_reconciliation.py.
        seed={
            "goals": [
                "Produce a structured .docx memo with the four canonical sections that investors expect.",
                "Compute KPI deltas accurately and surface them in a table — never extrapolate or forecast unless explicitly asked.",
                "Tone is plain and factual; no marketing language, no invented metrics or milestones.",
            ],
            "users": [
                "Founder drafting a recurring investor update",
                "COO or operator preparing the periodic memo",
            ],
            "positive_stories": [
                {
                    "who": "Founder drafting a recurring investor update",
                    "what": "paste this quarter's KPIs and qualitative notes and get a structured .docx memo back",
                    "why": "I have a draft to edit instead of staring at a blank page.",
                },
                {
                    "who": "COO or operator preparing the periodic memo",
                    "what": "compute deltas between this period and prior period in the KPIs table",
                    "why": "investors can see the trend without manual math.",
                },
                {
                    "who": "Founder drafting a recurring investor update",
                    "what": "leave the Asks section empty when there are no asks this period",
                    "why": "I don't manufacture asks for the sake of filling the section.",
                },
            ],
            "off_target_stories": [
                {
                    "who": "Founder drafting a recurring investor update",
                    "what": "draft the team standup or weekly internal status update",
                    "why": "internal updates are a different audience — refuse and suggest the standup skill.",
                },
                {
                    "who": "COO or operator preparing the periodic memo",
                    "what": "write a fundraising pitch narrative or deck text",
                    "why": "pitch material has a different shape; this skill only handles update memos.",
                },
            ],
        },
        charter=Charter(
            task=TaskDefinition(
                input_description=(
                    "List of KPIs (this-period and prior-period values) plus "
                    "qualitative notes (milestones, risks, asks). Period is "
                    "monthly or quarterly."
                ),
                output_description=(
                    ".docx with four sections in order: Highlights, KPIs "
                    "(table with computed deltas), Risks (bulleted, with "
                    "owners), Asks (bulleted, or 'No asks this period.')."
                ),
                sample_input=(
                    "KPIs: MRR $42k -> $51k; paid logos 18 -> 23; churn "
                    "2.1% -> 2.8%.\nNotes: eng team milestone; Q3 renewal "
                    "softness; want warm intros to Series B fintech buyers."
                ),
                sample_output=(
                    "investor_update_q2.docx with four labelled sections; "
                    "KPIs table includes MRR (+$9k, +21%), logos (+5, +28%), "
                    "churn (+0.7pp); Risks ('Q3 renewals — [OWNER]'); Asks "
                    "(warm intros to Series B fintech buyers)."
                ),
            ),
            coverage=DimensionCriteria(
                criteria=[
                    "Output contains the four canonical sections in order: Highlights, KPIs, Risks, Asks.",
                    "KPIs table has columns: Metric / This period / Prior period / Δ — and deltas are computed correctly.",
                    "Risks bullets each name an accountable owner (use [OWNER] placeholder if missing).",
                    "Asks section uses 'No asks this period.' when the user provides none — does not invent asks.",
                    "Highlights bullets are one sentence each, leading with what changed.",
                ],
                negative_criteria=[
                    "Refuses to draft internal status updates or team standups.",
                    "Refuses to write marketing copy or launch announcements.",
                    "Refuses to draft fundraising pitch narratives or deck text.",
                ],
            ),
            balance=DimensionCriteria(
                criteria=[
                    "1-3 KPIs: table is compact, no per-metric narrative paragraph.",
                    "10+ KPIs: keep table format; only narrate the 3 most-changed in Highlights.",
                    "No asks: section reads 'No asks this period.' — section is not omitted.",
                    "No risks: section reads 'No new risks this period.' — section is not omitted.",
                ],
            ),
            alignment=[
                AlignmentEntry(
                    feature_area="Tone",
                    good="\"MRR grew from $42k to $51k (+21%).\"",
                    bad="\"We had an incredible quarter — MRR rocketed to $51k in a thrilling display of momentum.\"",
                ),
                AlignmentEntry(
                    feature_area="Delta accuracy",
                    good="\"Churn 2.1% -> 2.8% (Δ +0.7pp)\"",
                    bad="\"Churn 2.1% -> 2.8% (Δ +33%)\" (computing percentage change on a percentage)",
                ),
                AlignmentEntry(
                    feature_area="No invented forward-looking claims",
                    good="\"Q3 renewals look soft (owner: [OWNER]).\"",
                    bad="\"Q3 renewals look soft — we project MRR will decline 15% next quarter.\"",
                ),
            ],
            rot=DimensionCriteria(
                criteria=[
                    "Never invent KPIs, numbers, milestones, or risks not present in the user's input.",
                    "Never extrapolate or forecast — the memo is about what happened.",
                    "If a KPI lacks a prior-period number, show Δ as '—' rather than fabricating one.",
                ],
            ),
            safety=DimensionCriteria(),
        ),
        examples=[
            Example(
                feature_area="Standard quarterly memo",
                input=(
                    "KPIs:\n"
                    "- MRR $42,000 -> $51,000\n"
                    "- Paid logos 18 -> 23\n"
                    "- Churn 2.1% -> 2.8%\n\n"
                    "Notes:\n"
                    "- Closed 12-person engineering hiring milestone\n"
                    "- Q3 renewal pipeline looks soft\n"
                    "- Want warm intros to Series B fintech buyers"
                ),
                expected_output=(
                    "investor_update.docx with four sections: Highlights "
                    "(eng milestone, MRR +21%, churn +0.7pp), KPIs table "
                    "with three rows and computed deltas, Risks ('Q3 "
                    "renewals soft — [OWNER]'), Asks ('warm intros to "
                    "Series B fintech buyers')."
                ),
                coverage_tags=["four sections present", "delta accuracy"],
                label="good",
                should_trigger=True,
            ),
            Example(
                feature_area="Missing prior-period value",
                input=(
                    "KPIs:\n"
                    "- MRR $51,000 (no prior-period number on hand)\n"
                    "- NPS 42 -> 47\n\n"
                    "Notes: launched the new dashboard."
                ),
                expected_output=(
                    "investor_update.docx with Highlights (dashboard "
                    "launch, NPS up 5pts), KPIs table with MRR row showing "
                    "Δ='—' (no prior value) and NPS row with Δ=+5pts, no "
                    "Risks bullets ('No new risks this period.'), no Asks "
                    "('No asks this period.')."
                ),
                coverage_tags=["four sections present", "missing prior period"],
                label="good",
                should_trigger=True,
            ),
            Example(
                feature_area="No asks, no risks",
                input=(
                    "KPIs:\n- MRR $51k -> $58k\n- Logos 23 -> 28\n\n"
                    "Notes: steady quarter, no new risks, no asks."
                ),
                expected_output=(
                    "investor_update.docx with Highlights (MRR +14%, logos "
                    "+5), KPIs table, Risks section reading 'No new risks "
                    "this period.', Asks section reading 'No asks this "
                    "period.'"
                ),
                coverage_tags=["empty sections rendered correctly"],
                label="good",
                should_trigger=True,
            ),
            Example(
                feature_area="Refusal: internal status",
                input="Draft the team standup for tomorrow morning. Items: shipped feature X, blocked on Y.",
                expected_output="",
                coverage_tags=["refuses internal status"],
                label="good",
                label_reason="Off-target — different audience and format.",
                should_trigger=False,
            ),
            Example(
                feature_area="Refusal: pitch narrative",
                input="Write our pitch deck narrative — we're raising a Series A.",
                expected_output="",
                coverage_tags=["refuses pitch material"],
                label="good",
                label_reason="Off-target — pitch decks are not update memos.",
                should_trigger=False,
            ),
        ],
    )
