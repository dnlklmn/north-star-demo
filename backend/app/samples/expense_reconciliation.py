"""Sample project: authoring a SKILL.md for monthly expense reconciliation.

Persona: freelancer / small-business owner who pastes raw transactions and
expects a categorized .xlsx back. Exercises the agent-mode tool-use loop —
the skill must actually produce a file with formulas, not just promise one.
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
    "Use when the user pastes a list of transactions (bank export, "
    "screenshots transcribed, mixed sources) and asks to categorize them "
    "into a monthly expense spreadsheet with category totals. Produces an "
    ".xlsx file with one row per transaction, a category column, and a "
    "summary tab using SUMIF formulas. Do NOT trigger on tax-advice "
    "requests, investment analysis, or budget-forecasting questions."
)


def build_sample(skill_body: str) -> Sample:
    return Sample(
        id="expense_reconciliation",
        name="Monthly expense reconciliation",
        blurb="A SKILL.md that turns messy transactions into a categorized .xlsx with SUMIF totals.",
        skill_name="monthly-expense-reconciliation",
        skill_description=_DESCRIPTION,
        skill_body=skill_body,
        # `task` is intentionally omitted — the charter below carries the
        # authoritative task definition. _apply_seed_data preserves an
        # already-populated charter.task when seed.task is missing.
        seed={
            "goals": [
                "Categorize a messy list of transactions into a clean monthly expense spreadsheet.",
                "Produce live SUMIF / SUM formulas so totals update when rows are added.",
                "Stay strictly within reconciliation — refuse tax-advice, forecasting, and bill-negotiation requests.",
            ],
            "users": [
                "Freelancer doing monthly bookkeeping",
                "Small-business owner tracking expenses",
            ],
            "positive_stories": [
                {
                    "who": "Freelancer doing monthly bookkeeping",
                    "what": "paste my Stripe transactions and get a categorized monthly expense xlsx",
                    "why": "I can hand it to my accountant without manual cleanup.",
                },
                {
                    "who": "Small-business owner tracking expenses",
                    "what": "upload mixed-format expense notes and get a clean spreadsheet with category totals",
                    "why": "I have a single source of truth for the month.",
                },
                {
                    "who": "Freelancer doing monthly bookkeeping",
                    "what": "reuse last month's category labels when reconciling this month",
                    "why": "month-over-month comparison stays valid.",
                },
            ],
            "off_target_stories": [
                {
                    "who": "Freelancer doing monthly bookkeeping",
                    "what": "ask which expenses are tax-deductible",
                    "why": "I want a deduction summary — but this is tax advice and out of scope.",
                },
                {
                    "who": "Small-business owner tracking expenses",
                    "what": "ask for a forecast of next quarter's spending",
                    "why": "I want to plan — but forecasting is a different skill.",
                },
            ],
        },
        charter=Charter(
            task=TaskDefinition(
                input_description=(
                    "A paste of transactions (one per line, mixed format) "
                    "plus optional category preferences from prior months."
                ),
                output_description=(
                    "An .xlsx file with Transactions and Summary tabs. "
                    "Summary tab uses live SUMIF formulas plus a grand total."
                ),
                sample_input=(
                    "5/3 AWS $14.20\n5/4 lunch with Sarah at Joe's $32\n"
                    "5/8 Linear annual $96"
                ),
                sample_output=(
                    "expenses.xlsx with two tabs. Transactions: 3 rows "
                    "(Software / Meals / Software). Summary: SUMIF per "
                    "category plus =SUM grand total."
                ),
            ),
            coverage=DimensionCriteria(
                criteria=[
                    "Every transaction in the input appears as a row in the Transactions tab.",
                    "Summary tab uses live SUMIF formulas, never hardcoded totals.",
                    "Category labels are stable — reuse the user's prior set when referenced, otherwise the standard six.",
                    "Mixed currencies are preserved; conversion only happens when the user names a target currency.",
                    "Unparseable lines surface in the chat reply, never silently dropped.",
                ],
                negative_criteria=[
                    "Refuses to give tax advice or rule on deductibility.",
                    "Refuses to forecast future spending.",
                    "Does not negotiate bills or draft vendor outreach.",
                ],
            ),
            balance=DimensionCriteria(
                criteria=[
                    "1-10 transactions: single-pass output, no per-category preamble.",
                    "50+ transactions: include a count and flag any line placed in Other.",
                    "Same-currency inputs may omit the Currency column; mixed-currency inputs must keep it.",
                ],
            ),
            alignment=[
                AlignmentEntry(
                    feature_area="Formula correctness",
                    good="=SUMIF(Transactions!E:E, \"Software & Subscriptions\", Transactions!C:C)",
                    bad="$110.20  (hardcoded total)",
                ),
                AlignmentEntry(
                    feature_area="Category consistency",
                    good="Software & Subscriptions  (matches the standard set)",
                    bad="SaaS, Subs, AWS-related  (new categories proliferating)",
                ),
                AlignmentEntry(
                    feature_area="Refusal on out-of-scope ask",
                    good="I focus on reconciliation. For deductibility questions, please consult a tax professional.",
                    bad="Lunches are 50% deductible, AWS is fully deductible...",
                ),
            ],
            rot=DimensionCriteria(
                criteria=[
                    "Never fabricate transactions not present in the input.",
                    "Never silently drop unparseable lines — list them explicitly.",
                    "Never modify user-supplied amounts.",
                ],
            ),
            safety=DimensionCriteria(),
        ),
        examples=[
            Example(
                feature_area="Basic reconciliation",
                input="5/3 AWS $14.20\n5/4 lunch at Joe's $32",
                expected_output=(
                    "expenses.xlsx with 2 rows in Transactions "
                    "(Software & Subscriptions, Meals & Entertainment) and "
                    "a Summary tab with 2 SUMIF rows plus a SUM grand total."
                ),
                coverage_tags=["formula correctness", "category consistency"],
                label="good",
                should_trigger=True,
            ),
            Example(
                feature_area="Mixed currencies",
                input="10 Apr Notion £8\n12 Apr Figma $45",
                expected_output=(
                    "expenses.xlsx with Currency column preserved. £8 and "
                    "$45 kept distinct; Summary totals computed per category "
                    "without currency conversion."
                ),
                coverage_tags=["formula correctness"],
                label="good",
                should_trigger=True,
            ),
            Example(
                feature_area="Unparseable line handling",
                input="5/3 AWS $14.20\n5/4 ??? unparseable thing\n5/8 Linear $96",
                expected_output=(
                    "expenses.xlsx with 2 parseable rows. Chat reply includes "
                    "a 'Could not parse' section listing the middle line; the "
                    "line is not silently dropped or invented."
                ),
                coverage_tags=["unparseable lines surfaced"],
                label="good",
                should_trigger=True,
            ),
            Example(
                feature_area="Refusal: tax advice",
                input="Which of these are tax-deductible? AWS $14, lunch $32",
                expected_output="",
                coverage_tags=["refuses tax advice"],
                label="good",
                label_reason="Off-target — should refuse, scope is reconciliation not tax advice.",
                should_trigger=False,
            ),
            Example(
                feature_area="Refusal: forecasting",
                input="Based on this month's spend, project Q3 for me.",
                expected_output="",
                coverage_tags=["refuses forecasting"],
                label="good",
                label_reason="Off-target — forecasting is a separate skill.",
                should_trigger=False,
            ),
            Example(
                feature_area="Category reuse",
                input=(
                    "Last month I used: Software, Travel, Misc.\n"
                    "Categorize: 5/3 AWS $14, 5/5 train $48"
                ),
                expected_output=(
                    "expenses.xlsx using the user's three labels (Software, "
                    "Travel, Misc), not the default six. AWS → Software, "
                    "train → Travel."
                ),
                coverage_tags=["category consistency"],
                label="good",
                should_trigger=True,
            ),
        ],
    )
