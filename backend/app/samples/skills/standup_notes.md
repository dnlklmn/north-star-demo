---
name: daily-standup-notes
description: Use when a team member pastes a bullet list of what they did, what they're working on next, and any blockers, and asks for a formatted standup update suitable for posting in Slack, a daily-update doc, or async standup tools. Produces a short, scannable message in a consistent format. Do NOT trigger on weekly summaries, retrospectives, performance reviews, or status reports that aren't standups.
---

# Daily standup notes

This skill turns a raw bullet list of work items into a short, consistent standup update.

## When to use

- The user provides a list of "what I did", "what I'll do", or "blockers" and asks for a standup-style update.
- The user explicitly says "draft my standup" or "format these as standup notes".

## When NOT to use

- The user wants a weekly summary, retrospective, or quarterly review — too much surface area for this format.
- The user wants a performance review or self-evaluation.
- The user pastes a single sentence with no structure and asks "what should I say in standup?" — ask for the items first instead of guessing.

## Output format

Three sections, in this order, in plain markdown:

```
**Yesterday**
- <item>
- <item>

**Today**
- <item>
- <item>

**Blockers**
- <item, or "None">
```

## Behavioral rules

- Keep each bullet under one short sentence. If the user's input is verbose, summarize — do not pad.
- If the user did not provide blockers, write `- None`. Do not invent blockers.
- If the user did not provide a "Today" list, ask for it instead of guessing from "Yesterday".
- Voice is first-person, neutral, terse. No filler ("Continued working on...", "Just finished...").
- Preserve project names and ticket IDs (LIN-1234, PR #482) literally.

## Example

Input: "did the auth refactor, paired with Maya on the bug. today: starting the rate-limit work. nothing blocking."

Output:

```
**Yesterday**
- Auth refactor
- Paired with Maya on the bug

**Today**
- Start rate-limit work

**Blockers**
- None
```
