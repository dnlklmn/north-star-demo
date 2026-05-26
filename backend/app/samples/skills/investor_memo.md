---
name: quarterly-investor-update
description: Use when a founder, COO, or operator asks for a quarterly (or monthly) investor update memo. Takes a list of KPIs and qualitative notes and produces a .docx file with the four canonical sections — Highlights, KPIs, Risks, Asks — formatted for a Word/Google Docs reader. Triggers on phrases like "draft an investor update", "write the Q2 memo", "investor letter from these numbers". Do NOT trigger on internal status updates, team standups, or marketing copy.
---

# Quarterly investor update memo

This skill drafts a structured investor update memo from a list of metrics and qualitative notes. The output is a `.docx` that can be edited and sent directly.

## When to use

- The user is preparing a periodic (monthly / quarterly) update for investors and provides numbers + qualitative notes.
- The user asks for an "investor memo" or "investor update" explicitly.

## When NOT to use

- The user wants an internal status update for the team → different scope; refuse or defer to a standup skill.
- The user asks for marketing copy or a launch announcement → not the same form.
- The user asks for fundraising pitch material (deck, narrative) → different artifact.

## Output format

A `.docx` with these exact section headings, in this order:

1. **Highlights** — 3 to 5 bullets, each one sentence. Lead with what changed, not adjectives.
2. **KPIs** — a small table: `Metric | This period | Prior period | Δ`. Include each KPI the user provided. Compute the Δ. Do NOT extrapolate or forecast.
3. **Risks** — bullets, each naming the risk AND the owner accountable for it. If the user hasn't named an owner, write `[OWNER]` as a placeholder rather than guessing.
4. **Asks** — bullets, each a concrete request (intro, hire referral, advice on X). Empty section if the user has none — write "No asks this period."

## Behavioral rules

- Tone is plain and factual. No marketing language ("exciting", "thrilled", "incredible momentum").
- Do not invent KPIs, numbers, milestones, or risks. Every datum traces to the user's input.
- Do not project forward. The memo is about what *happened*, not what will happen — unless the user explicitly asks for a forward-looking section.
- If a KPI lacks a prior-period number, show the Δ column as `—` rather than fabricating one.

## Example

Input: KPIs (MRR $42k → $51k; paid logos 18 → 23; churn 2.1% → 2.8%) + notes (closed a 12-person eng team milestone; renewal pipeline looks soft for Q3; need warm intros to Series B fintech buyers).

Output: a `.docx` with four sections — Highlights (closed eng milestone, MRR up 21%, churn ticked up), KPIs table with three rows and computed deltas, Risks (Q3 renewals — owner `[OWNER]`), Asks (warm intros to Series B fintech buyers).
