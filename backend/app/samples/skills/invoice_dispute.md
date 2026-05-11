---
name: vendor-invoice-dispute-letter
description: Use when the user has received a vendor invoice they disagree with (wrong line items, double-billing, an unexpected late fee, charges for services not rendered) and asks for a formal dispute or inquiry letter. Reads the invoice PDF or pasted text, identifies the disputed items, and produces a formal letter (as a PDF or plain text) citing specific line items, amounts, and a clear requested resolution. Triggers on phrases like "dispute this invoice", "write a letter about this charge", "this bill is wrong". Do NOT trigger on payment-negotiation, contract-rewriting, or legal-advice requests.
---

# Vendor invoice dispute letter

This skill turns a vendor invoice the user disputes into a formal, fact-based dispute letter that cites specific line items.

## When to use

- The user provides an invoice (PDF, image transcribed, or pasted text) AND identifies one or more line items they dispute.
- The user wants a formal written record they can send to the vendor.

## When NOT to use

- The user wants to negotiate a discount on a future invoice → different skill.
- The user asks whether the dispute would hold up legally → that is legal advice, refuse.
- The user asks for a rewrite of the vendor contract → out of scope.
- The user only wants to vent and is not preparing a letter → ask first; don't auto-draft.

## Inputs

You will receive one of:
- A path to an invoice PDF — read it.
- Pasted invoice text.
- A photo of an invoice that has already been transcribed into text by the user.

Plus a short statement of what the user is disputing ("the second line item was already paid last month", "this late fee shouldn't apply, payment cleared on the due date").

## Output format

Produce a letter — either as a plain-text response or, if the user asks for a file, as a `.pdf`. The letter MUST contain:

1. **Header** — sender name (placeholder `[YOUR NAME]` if not provided), date, vendor name + address (from invoice).
2. **Subject line** — references the invoice number and date.
3. **Body** — a factual paragraph stating what is being disputed, citing each line item by description, line number, and amount. One paragraph per dispute.
4. **Requested resolution** — explicit and bounded (e.g., "Please credit $42.00 against my account and reissue a corrected invoice").
5. **Closing** — neutral professional sign-off.

## Behavioral rules

- Never invent amounts, line item descriptions, dates, invoice numbers, or vendor details. Every fact in the letter must trace to the invoice or the user's stated dispute.
- Tone is formal and factual. No threats, no claims about legal recourse, no emotional language.
- If the invoice is unreadable or critical fields are missing, ask the user to provide them rather than guessing.
- If the user's dispute statement contradicts what's on the invoice (e.g. they say they were double-billed but only one charge is present), point this out and stop — don't manufacture a dispute.

## Example

Input: `invoice_4421.pdf` + "the $89 'expedited handling' fee shouldn't apply — I selected standard shipping."

Output: a one-page formal letter citing invoice #4421 dated 2026-04-12, identifying the "Expedited handling — $89.00" line item, stating the user selected standard shipping, and requesting credit of $89.00.
