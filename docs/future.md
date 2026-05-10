# Future: Support ticket coach (browser extension)

## Idea

A browser extension that helps people write better tickets/issues on any web form (Zendesk, Jira, Linear, GitHub Issues, internal tools). Live checklist + LLM judge against a North Star charter, with a one-click rewrite/clarifying-question generator.

This is a canonical North Star demo: non-technical user authors a charter for "good support ticket," the charter becomes the runtime judge, real anonymized tickets become the labeled dataset.

## Charter dimensions (starting point)

- **Coverage:** problem statement, expected vs. actual, repro steps, environment, impact, what was already tried
- **Balance:** weight requirements by ticket type (bug vs. feature vs. billing — don't demand repro steps on "change my email")
- **Alignment:** severity claim justified by impact; routing hints present; sentiment separated from facts
- **Rot:** stale environment info, vague "doesn't work," unstructured walls of text, screenshots without context

## Architecture

```
Extension (MV3)
├── content script    → reads active textarea/contenteditable, injects sidebar
├── background worker → debounce + call backend
└── popup             → project selector, settings, auth

North Star backend (small additions)
├── GET  /api/extension/charter?project_id=…  → returns live skill_body for the linked project
├── POST /api/extension/evaluate              → LLM judge against that charter
└── POST /api/extension/rewrite               → LLM rewrite under charter constraints
```

## Linking to a North Star project (instead of hardcoding the charter)

This is the key design decision and it does map cleanly onto what already exists:

- Each session/project already has `charter.task.skill_body` plus `skill_name` / `skill_description` (`backend/app/main.py:561`, `:775`).
- `GET /sessions` already lists projects.
- The extension's settings would store `{ project_id, api_token }`. On every evaluation it fetches the latest `skill_body` (cached briefly) and uses it as the judge prompt.
- Iterating on the charter in North Star → next extension evaluation picks up the change automatically. No redeploy.

What we'd need to add to North Star:
1. A scoped API token per user (read-only access to their own projects' charters).
2. A "Use in extension" panel on a project page that surfaces the project ID + a copy-token button.
3. A stable, prompt-shaped export of the charter for judge use (probably already close — `skill_body` is the right field, but may need a thin wrapper that includes charter dimensions too).

## Demo scope (1–2 days)

- Hardcoded backend URL, single shared token (no multi-user yet)
- Extension popup: paste project ID → save
- Sidebar: "click this textarea to attach" → live checklist + one rewrite button
- Test on Zendesk, GitHub Issues, and a plain `<textarea>` test page

If the loop feels good, then invest in:
- Per-user API tokens
- Domain allowlist + privacy controls (drafts leave the browser — needs a clear off switch)
- Smart field detection (Zendesk has many textareas; auto-attach is fiddly)
- Cost controls: cache by draft hash, re-evaluate only on meaningful change (new sentence, not every keystroke)

## Open questions / risks

- **Privacy:** sending draft content to a backend is the #1 trust issue for a browser extension. Needs explicit allowlist + visible "off" state. Consider local-only mode with a user-supplied API key for power users.
- **Charter shape for runtime use:** the charter today is structured for human review and dataset generation. May need a "judge view" that compiles dimensions into a single prompt. Worth prototyping before committing.
- **Auto-detect vs. manual attach:** auto-detecting "this is a ticket form" across arbitrary sites is brittle. Manual click-to-attach is uglier but reliable — start there.
- **Who pays for inference:** fine for a demo with a shared key; needs auth + metering before any real launch.
- **Charter authoring UX:** support leads are the target authors. Confirm they'll actually go through the discovery flow, or whether we ship a default "support ticket" charter they fork and tweak (probably the latter).

## Why this is worth a demo

- Tight, visible loop: edit charter in North Star → next ticket draft scores differently. Easy to show in a 2-minute video.
- Tool-agnostic story beats a Zendesk-only app for breadth of audience.
- Forces us to prove the charter is useful as a runtime artifact, not just a design artifact — which is the strongest version of North Star's pitch.
