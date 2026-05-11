---
name: monthly-expense-reconciliation
description: Use when the user pastes a list of transactions (bank export, screenshots transcribed, mixed sources) and asks to categorize them into a monthly expense spreadsheet with category totals. Produces an .xlsx file with one row per transaction, a category column, and a summary tab using SUMIF formulas. Triggers on phrases like "reconcile my expenses", "categorize these transactions", "build my expense spreadsheet". Do NOT trigger on tax-advice requests, investment analysis, or budget-forecasting questions.
---

# Monthly expense reconciliation

This skill turns a messy paste of transactions into a clean .xlsx file with categorized rows and a summary tab.

## When to use

- The user pastes raw transactions (one per line, in any rough format) AND asks for categorization or reconciliation.
- The user provides a mixed-format dump (bank export, screenshot transcription, manual notes) and asks for a clean spreadsheet.

## When NOT to use

- The user asks for tax advice on their expenses → defer to a tax professional.
- The user asks "is this expense deductible?" → outside scope.
- The user wants budget forecasting or projections → different skill.
- The user wants to negotiate a bill → unrelated.

## Output format

Produce a single .xlsx file with two tabs:

1. **Transactions** — one row per transaction. Columns: `Date | Description | Amount | Currency | Category`.
2. **Summary** — one row per category with a `SUMIF` formula totaling that category from the Transactions tab. End with a grand-total row using `SUM`.

Use the user's prior month's category set if they reference one; otherwise use these six: `Software & Subscriptions`, `Travel`, `Meals & Entertainment`, `Office Supplies`, `Professional Services`, `Other`.

## Behavioral rules

- Always emit formulas (`=SUMIF(...)`, `=SUM(...)`), never hard-coded totals. The user must be able to add a row and have totals update.
- Convert all amounts to a single currency only if the user specifies one. Otherwise keep mixed currencies and add a `Currency` column.
- If a transaction is genuinely ambiguous, place it in `Other` and add a comment cell flagging it for review.
- Do not invent merchants, dates, or amounts. If a line is unparseable, list it under a "Could not parse" section in the chat response — do not silently drop it.

## Example

Input: `5/3 AWS $14.20, 5/4 lunch with Sarah at Joe's $32, 5/8 Linear annual $96`

Output: an `.xlsx` with three rows in the Transactions tab (Software / Meals / Software) and a Summary tab with two `SUMIF` formulas plus a grand total.
