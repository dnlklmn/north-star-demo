"""All prompts for the charter generation agent.

Each prompt is a function that takes state and returns a string.
When you want to change what the agent says or how it reasons, edit here.

Prompts:
- build_discovery_turn_prompt(state, user_message) — discovery phase: elicit goals and stories
- build_generate_draft_prompt(state) — generate charter JSON from user input
- build_validate_charter_prompt(state) — validate charter against testability criteria
- build_conversational_turn_prompt(state, user_message) — chat turn with optional charter updates
- build_generate_suggestions_prompt(state) — suggest items for weak/empty sections
"""

from __future__ import annotations

import json

from .models import SessionState


def _format_conversation(history: list[dict]) -> str:
    if not history:
        return "(No conversation yet)"
    parts = []
    for msg in history:
        role = msg.get("role", "unknown")
        content = msg.get("content", "")
        parts.append(f"{role}: {content}")
    return "\n".join(parts)


SECTION_5_DISCOVERY_FRAMEWORKS = """## Discovery frameworks

Use these frameworks naturally in conversation. NEVER name the framework — just use the technique.

### Issue tree decomposition (for breaking down business objectives)
When the user states a high-level goal, break it into 2-3 sub-problems:
- "You mentioned increasing retention — what are the main reasons people leave today?"
- "There are a few angles here: onboarding, daily usage, and re-engagement. Which matters most right now?"

### Jobs To Be Done (for eliciting user stories)
Ask what job the user is hiring the feature to do:
- "When someone opens this feature, what are they trying to get done?"
- "What would they do instead if this feature didn't exist?"
- "When would they say 'that worked' vs 'that was useless'?"

### 5 Whys (for probing vague answers)
When the user gives a surface-level answer, dig deeper:
- "You said the output should be 'helpful' — what would an unhelpful response look like in practice?"
- "What specifically would make someone trust this result vs. dismiss it?"
- Keep probing until you reach something observable and testable.

### MECE — Mutually Exclusive, Collectively Exhaustive (for checking completeness)
Before signalling readiness, verify coverage:
- "We've talked about [X, Y, Z]. Are there other types of users or situations we haven't covered?"
- "Are these scenarios distinct, or do some of them overlap?"

### Hypothesis-driven questioning (for speed)
Instead of open-ended questions, propose a specific hypothesis for the user to confirm or refute:
- "It sounds like the main goal is reducing support tickets — is that right, or is it more about customer satisfaction?"
- "I'd guess the hardest case is when [specific scenario]. Does that match your experience?"
This is faster than open-ended questions and gets better answers from busy people."""


def build_discovery_turn_prompt(state: SessionState, user_message: str | None) -> str:
    """Build the prompt for a discovery turn — eliciting goals and stories.

    Adapts behavior based on state.discovery_phase ('goals' or 'stories').
    """
    goals_so_far = state.extracted_goals
    stories_so_far = state.extracted_stories
    round_num = state.discovery_rounds
    phase = state.discovery_phase.value if hasattr(state.discovery_phase, 'value') else state.discovery_phase

    goals_text = "\n".join(f"- {g}" for g in goals_so_far) if goals_so_far else "(None yet)"
    stories_text = json.dumps(stories_so_far, indent=2) if stories_so_far else "(None yet)"

    users_text = "\n".join(f"- {u}" for u in state.extracted_users) if state.extracted_users else "(None yet)"

    # Phase-specific guidance
    if phase == "goals":
        return _build_goals_phase_prompt(goals_text, stories_text, round_num, state, user_message)
    elif phase == "users":
        return _build_users_phase_prompt(goals_text, users_text, round_num, state, user_message)
    else:
        return _build_stories_phase_prompt(goals_text, users_text, stories_text, round_num, state, user_message)


def _build_goals_phase_prompt(goals_text: str, stories_text: str, round_num: int, state, user_message: str | None) -> str:
    """Prompt for the goals discovery phase."""

    if round_num == 0:
        framework_hint = """This is the FIRST turn. The user just started.
- Greet them briefly and ask what AI feature they're building and what business problem it solves.
- ONE question only."""
    elif round_num == 1:
        framework_hint = """EARLY turn. The user just described their feature/problem.
- FIRST: Extract any concrete business goals the user stated or clearly implied. Even if they described it loosely, distill it into 1-2 clear goal statements and put them in the "goals" array. For example, if they say "we're building a matching tool to help recruiters find candidates faster", extract "Fill positions faster" as a goal.
- Use issue tree decomposition: split their stated goal into 2-3 sub-problems.
- Use hypothesis-driven questioning: propose a specific interpretation and ask them to confirm or correct.
- ONE question only — pick the most important sub-problem to explore."""
    elif len(state.extracted_goals) == 0:
        framework_hint = """You still have NO extracted goals. Focus on getting a concrete, specific business objective.
- Use 5 Whys: probe vague answers until you reach something measurable.
- Propose a specific goal for them to confirm: "It sounds like the main goal is [X] — is that right?"
- ONE question only."""
    else:
        framework_hint = f"""You have {len(state.extracted_goals)} goal(s). Check completeness.
- Use MECE: "We've identified [goals]. Are there other business objectives this feature serves, or does that cover it?"
- If the goals feel complete (2-3 solid goals, or user confirms they're done), set ready_for_users to true.
- ONE question only."""

    return f"""You are a product consultant helping someone define what "good" looks like for their AI feature. Right now you are in the GOALS phase — your job is to understand the business objectives behind this feature.

{SECTION_5_DISCOVERY_FRAMEWORKS}

## Current state

Business goals extracted so far:
{goals_text}

Discovery round: {round_num}

## Guidance for this turn
{framework_hint}

## Conversation so far
{_format_conversation(state.input.conversation_history)}

## User's message
{f'"{user_message}"' if user_message else "(No message — this is the opening turn)"}

## Your response has TWO parts

PART 1 (required): Your conversational message.
- 1-2 sentences acknowledging what you learned, then exactly ONE question.
- CRITICAL: Ask exactly ONE question. Never two. Pick the single most important thing to learn next.
- Do NOT embed the options in your message text. Just ask the question — the options will be shown as clickable buttons below your message.
- Never use these words: charter, eval, criterion, dataset, LLM, prompt, model, framework, methodology, MECE, JTBD

PART 2 (required): Extraction block.
```extraction
{{
  "goals": ["any NEW business goals from this turn — only what the user actually said or clearly implied"],
  "stories": [],
  "ready_for_users": false,
  "suggested_goals": ["2-4 concrete goal options the user can click to add — short, specific, action-oriented"]
}}
```

## Rules
- Extract goals ONLY from what the user ACTUALLY said — do not invent
- Goals should be concrete business objectives, not vague wishes
- Do NOT extract stories in the goals phase — leave stories empty
- Set ready_for_users to true when you have at least 2 clear goals OR the user says they want to move on
- If a user manually added goals (shown in the list above), acknowledge them briefly
- IMPORTANT: suggested_goals are clickable options shown as buttons. They should be SHORT (3-8 words each), concrete, and directly addable as business goals. For example: "Fill positions faster", "Improve hire quality", "Reduce recruiter workload". Do NOT repeat goals already extracted.
- If there is not enough context yet to suggest meaningful goals, return an EMPTY suggested_goals array — do not guess."""


def _build_users_phase_prompt(goals_text: str, users_text: str, round_num: int, state, user_message: str | None) -> str:
    """Prompt for the users discovery phase — identify who uses the feature."""

    num_users = len(state.extracted_users)

    if num_users == 0:
        framework_hint = """You just entered the USERS phase. The business goals are settled.
- Start with Jobs To Be Done: "Who are the main people that will interact with this feature?"
- Think about both direct users AND stakeholders affected by the output.
- ONE question only."""
    elif num_users == 1:
        framework_hint = f"""You have {num_users} user type so far.
- Explore if there are other types: "Besides {state.extracted_users[0]}, is there anyone else who interacts with this — maybe someone who reviews the output or is affected by it?"
- ONE question only."""
    else:
        framework_hint = f"""You have {num_users} user types. Check for completeness.
- Use MECE: "We've identified {', '.join(state.extracted_users)}. Are there other people involved — maybe someone upstream who provides input or downstream who acts on the output?"
- If the user types feel complete, set ready_for_stories to true.
- ONE question only."""

    return f"""You are a product consultant helping someone define what "good" looks like for their AI feature. The business goals are settled. Now you're in the USERS phase — your job is to identify all the different types of people who interact with this feature.

{SECTION_5_DISCOVERY_FRAMEWORKS}

## Confirmed business goals
{goals_text}

## User types identified so far
{users_text}

## Guidance for this turn
{framework_hint}

## Conversation so far
{_format_conversation(state.input.conversation_history)}

## User's message
{f'"{user_message}"' if user_message else "(No message — this is the opening of the users phase)"}

## Your response has TWO parts

PART 1 (required): Your conversational message.
- 1-2 sentences acknowledging what you learned, then exactly ONE question.
- CRITICAL: Ask exactly ONE question. Never two. Pick the single most important thing to learn next.
- Do NOT embed the options in your message text. Just ask the question — the options will be shown as clickable buttons below your message.
- Never use these words: charter, eval, criterion, dataset, LLM, prompt, model, framework, methodology, MECE, JTBD

PART 2 (required): Extraction block.
```extraction
{{
  "goals": [],
  "users": ["any NEW user types from this turn — short role labels like 'recruiter', 'hiring manager', 'candidate'"],
  "stories": [],
  "ready_for_stories": false,
  "suggested_users": ["2-4 user type suggestions the user can click to add — short role labels"]
}}
```

## Rules
- Extract user types ONLY from what the user ACTUALLY said — do not invent
- User types should be short role labels: "recruiter", "hiring manager", "candidate", "admin"
- Set ready_for_stories to true when you have at least 2 user types OR the user says they want to move on
- If a user manually added user types (shown above), acknowledge them briefly
- IMPORTANT: suggested_users are clickable options shown as buttons. They should be SHORT (1-3 words), concrete role labels. Do NOT repeat users already extracted.
- If there is not enough context yet to suggest meaningful user types, return an EMPTY suggested_users array — do not guess."""


def _build_stories_phase_prompt(goals_text: str, users_text: str, stories_text: str, round_num: int, state, user_message: str | None) -> str:
    """Prompt for the stories discovery phase — define what each user type wants to achieve."""

    num_stories = len(state.extracted_stories)
    users_list = state.extracted_users

    # Figure out which users still need stories
    users_with_stories = {s.get("who", "").lower() for s in state.extracted_stories}
    users_without_stories = [u for u in users_list if u.lower() not in users_with_stories]

    if num_stories == 0:
        focus_user = users_list[0] if users_list else "the user"
        framework_hint = f"""You just entered the STORIES phase. The user types are settled: {', '.join(users_list)}.
- Start with the first user type: "Let's start with the {focus_user}. What are they trying to accomplish when they use this feature?"
- Use Jobs To Be Done framing.
- ONE question only."""
    elif users_without_stories:
        next_user = users_without_stories[0]
        framework_hint = f"""You have {num_stories} stories so far, but haven't covered: {', '.join(users_without_stories)}.
- Move to the next user: "Now let's think about the {next_user}. What do they need from this feature?"
- ONE question only."""
    else:
        framework_hint = f"""You have {num_stories} stories covering all user types. Check for completeness.
- "Are there other things any of these users need to do, or does this cover the main scenarios?"
- If stories feel complete, set ready_for_charter to true.
- ONE question only."""

    return f"""You are a product consultant helping someone define what "good" looks like for their AI feature. The business goals and user types are settled. Now you're in the STORIES phase — for each user type, define what they want to achieve.

{SECTION_5_DISCOVERY_FRAMEWORKS}

## Confirmed business goals
{goals_text}

## Confirmed user types
{users_text}

## User stories extracted so far
{stories_text}

## Guidance for this turn
{framework_hint}

## Conversation so far
{_format_conversation(state.input.conversation_history)}

## User's message
{f'"{user_message}"' if user_message else "(No message — this is the opening of the stories phase)"}

## Your response has TWO parts

PART 1 (required): Your conversational message.
- 1-2 sentences acknowledging what you learned, then exactly ONE question.
- CRITICAL: Ask exactly ONE question. Never two. Pick the single most important thing to learn next.
- Do NOT embed the options in your message text. Just ask the question — the options will be shown as clickable buttons below your message.
- Never use these words: charter, eval, criterion, dataset, LLM, prompt, model, framework, methodology, MECE, JTBD

PART 2 (required): Extraction block.
```extraction
{{
  "goals": [],
  "users": [],
  "stories": [{{"who": "user type", "what": "what they do", "why": "why it matters"}}],
  "ready_for_charter": false,
  "suggested_stories": [{{"who": "user type", "what": "what they do", "why": "why it matters"}}]
}}
```

## Rules
- Extract stories ONLY from what the user ACTUALLY said in THIS turn — do not invent
- CRITICAL: Only extract NEW stories from this turn's message. Do NOT re-extract or refine stories that are already in the "User stories extracted so far" list above. If the user is elaborating on an existing story (e.g. adding detail to a story already extracted), do NOT create a new story — the existing one already covers it.
- Stories follow: As a [who], I want to [what], so that [why]
- The "who" MUST be one of the confirmed user types: {', '.join(users_list)}
- Set ready_for_charter to true when each user type has at least 1 story and you feel confident, OR the user says they want to move on
- If a user manually added stories (shown above), acknowledge them briefly
- IMPORTANT: suggested_stories are clickable options shown as buttons. Each should be a complete user story with who/what/why. Suggest stories for user types that don't have any yet. Do NOT repeat stories already extracted.
- If there is not enough context yet to suggest meaningful stories, return an EMPTY suggested_stories array — do not guess."""


def build_generate_draft_prompt(state: SessionState, creativity: float = 0.2) -> str:
    # Adjust strictness instructions based on creativity level
    if creativity < 0.3:
        creativity_rules = """CRITICAL RULES — read carefully:
- ONLY include criteria that are DIRECTLY supported by what the user actually said.
- DO NOT invent, assume, or extrapolate. If the user said one thing, generate one criterion — not five.
- If a section has no supporting input, leave its criteria array EMPTY []. This is expected and correct.
- It is MUCH BETTER to have 1-2 specific criteria than 5 vague ones.
- If the input is sparse, generate a sparse charter. The conversation will fill in the gaps."""
    elif creativity < 0.6:
        creativity_rules = """RULES:
- Start with criteria DIRECTLY supported by the user's input.
- You may add 1-2 reasonable inferences per section if they are strongly implied by the context.
- Clearly distinguish between what the user said and what you inferred.
- If a section has no supporting input, you may add one inferred criterion OR leave it empty.
- Prefer specific criteria over vague ones, but reasonable generalizations are acceptable."""
    else:
        creativity_rules = """RULES:
- Use the user's input as a starting point, then expand with reasonable inferences.
- Feel free to suggest criteria the user likely hasn't thought of yet based on common patterns for this type of product.
- Fill all sections — use your best judgment for areas the user hasn't addressed yet.
- Be creative with coverage scenarios and alignment definitions.
- Still ground everything in observable, testable criteria — creative doesn't mean vague."""

    return f"""Generate a charter based on the following input. Return ONLY valid JSON matching the schema.

Business goals: {state.input.business_goals or 'Not provided'}
User stories: {state.input.user_stories or 'Not provided'}

Conversation so far:
{_format_conversation(state.input.conversation_history)}

Return a JSON object with this exact structure:
{{
  "task": {{
    "input_description": "what the app receives (e.g., 'business goals + user stories as freeform text')",
    "output_description": "what the app produces (e.g., 'structured charter JSON with coverage, alignment sections')",
    "sample_input": "optional: a brief example of typical input",
    "sample_output": "optional: a brief example of typical output"
  }},
  "coverage": {{
    "criteria": ["list of specific coverage scenarios"]
  }},
  "balance": {{
    "criteria": ["list of over-representation decisions with reasoning"]
  }},
  "alignment": [
    {{
      "feature_area": "name",
      "good": "description of good output — observable, specific",
      "bad": "description of bad output — observable, specific"
    }}
  ],
  "rot": {{
    "criteria": ["list of specific product events that trigger updates"]
  }}
}}

{creativity_rules}

General quality rules:
- Every criterion must be stated as observable behaviour in product language.
- A non-technical person must be able to make a consistent yes/no call.
- Coverage scenarios must name specific input types or edge cases.
- Balance criteria must reference specific trade-offs.
- Alignment good/bad must describe observable differences a user would notice.
- Rot triggers must be tied to specific product events."""


def build_validate_charter_prompt(state: SessionState) -> str:
    charter_json = state.charter.model_dump()

    return f"""Validate this charter against testability criteria. Be STRICT. Your job is to catch weak spots so the conversation can improve them.

Charter to validate:
{json.dumps(charter_json, indent=2)}

Original input from the user:
Business goals: {state.input.business_goals or 'Not provided'}
User stories: {state.input.user_stories or 'Not provided'}

For each criterion, ask these questions:
1. "Is this criterion DIRECTLY traceable to something the user actually said?" — if it was invented/assumed by the system, mark it "weak".
2. "Can I generate a concrete test example that either passes or fails this criterion?" — if not, mark it "weak" or "fail".
3. "Would two different people produce the same yes/no judgement on the same output?" — if not, mark it "weak".

Validation rules (be harsh):
- An EMPTY section (no criteria) should be marked "fail" — it needs content.
- A section with only generic/vague criteria should be marked "weak" — it needs specifics from the user.
- A criterion that could apply to any AI feature (not specific to THIS product) is "weak".
- Coverage: each scenario must name a specific input type, edge case, or user situation.
- Balance: each decision must reference a specific trade-off with a concrete reason.
- Alignment: good/bad must describe observable differences that a non-technical person can judge.
- Rot: triggers must be tied to specific product events, not generic "when things change".
- "pass" means: specific, testable, traceable to user input, and unambiguous.
- When in doubt, mark "weak". It's better to ask the user than to let vague criteria through.

Return ONLY valid JSON:
{{
  "coverage": "pass" | "weak" | "fail",
  "coverage_reasons": ["reason for any non-pass"],
  "balance": "pass" | "weak" | "fail",
  "balance_reasons": ["reason for any non-pass"],
  "alignment": [
    {{
      "feature_area": "name",
      "status": "pass" | "weak" | "fail",
      "weak_reason": "reason or null"
    }}
  ],
  "rot": "pass" | "weak" | "fail",
  "rot_reasons": ["reason for any non-pass"],
  "overall": "pass" | "partial" | "fail"
}}"""


def build_conversational_turn_prompt(state: SessionState, user_message: str) -> str:
    charter_json = state.charter.model_dump()
    validation_json = state.validation.model_dump()

    return f"""You are helping a user define what good AI output looks like for their feature.

Here's what they told you:
Business goals: {state.input.business_goals or 'Not provided'}
User stories: {state.input.user_stories or 'Not provided'}

Current charter:
{json.dumps(charter_json, indent=2)}

Current validation status:
{json.dumps(validation_json, indent=2)}

Conversation so far:
{_format_conversation(state.input.conversation_history)}

The user just said: "{user_message}"

Your job:
1. If the user's message contains NEW INFORMATION that can improve a specific section of the charter, return a JSON block with the updated section. ONLY include sections that should change.
2. Ask 1-2 follow-up questions to keep refining.
3. If the user is asking to focus on a specific area (like "coverage" or "alignment"), ask questions about that area.
4. ALWAYS include SUGGESTIONS — specific items the user could add to the charter with a single click. These should be concrete, actionable options based on the conversation so far.

Response format — your response has up to three parts, in this order:

PART 1 (optional): If you have updates for the charter, start with:
```charter-update
{{"coverage": {{"criteria": ["updated list"]}}, "alignment": [{{"feature_area": "...", "good": "...", "bad": "..."}}]}}
```

PART 2 (required): Your conversational message to the user.

PART 3 (required): Suggestions the user can accept with one click:
```suggestions
{{
  "suggestions": [
    {{"section": "coverage", "text": "a specific scenario to add"}},
    {{"section": "balance", "text": "a specific trade-off to add"}},
    {{"section": "alignment", "text": "Feature area name", "good": "what good looks like", "bad": "what bad looks like"}},
    {{"section": "rot", "text": "a specific trigger to add"}}
  ],
  "user_stories": [
    {{"who": "product manager", "what": "define quality standards for a new feature", "why": "ensure consistent AI output"}}
  ]
}}
```

Rules for suggestions:
- Generate 2-5 suggestions across different sections, focused on weak/empty areas
- Each suggestion must be SPECIFIC and CONCRETE — not generic
- Suggestions should be things you think are likely correct based on the conversation
- Include 0-2 user story suggestions when the conversation reveals new user types or use cases
- Suggestions for coverage should be specific scenarios (e.g., "when a candidate has 10+ years experience but no degree")
- Suggestions for alignment should have concrete good/bad descriptions

Rules for your message:
- Never use technical words like: charter, eval, criterion, dataset, LLM, prompt, model
- Ask about their product and users, not about the document
- Only update a section when the user has given you concrete new information
- Keep updates minimal — only change what the user's input directly improves
- Be BRIEF. 2-4 sentences max for your commentary. No fluff, no repetition.

Formatting rules for your conversational message (PART 2):
- Keep it short: 1-2 sentences of commentary, then questions
- Each question MUST be on its own line, starting with "? " followed by the section tag
- Use these EXACT section tags: Coverage, Balance, Alignment, Rot (no brackets needed)
- Format: "? SectionTag Your question here?"
- Example format:
  Got it, added coverage for edge cases.

  ? Coverage What happens when a user submits an empty form?
  ? Alignment What does a good error message look like vs a bad one?
- Do NOT combine multiple questions into one line
- Do NOT use bullet points for questions — always use "? SectionTag" prefix
- Do NOT use brackets around section tags — just the word"""


def build_generate_suggestions_prompt(state: SessionState) -> str:
    charter_json = state.charter.model_dump()
    validation_json = state.validation.model_dump()

    return f"""Based on this user's input and the current state of their charter, suggest specific items they could add.

Business goals: {state.input.business_goals or 'Not provided'}
User stories: {state.input.user_stories or 'Not provided'}

Current charter:
{json.dumps(charter_json, indent=2)}

Validation status:
{json.dumps(validation_json, indent=2)}

Generate suggestions for sections that are empty, weak, or could be stronger. Each suggestion should be a SPECIFIC, CONCRETE item the user is likely to agree with based on their input.

Return ONLY valid JSON:
{{
  "suggestions": [
    {{"section": "coverage", "text": "a specific scenario"}},
    {{"section": "balance", "text": "a specific trade-off"}},
    {{"section": "alignment", "text": "Feature area name", "good": "what good looks like", "bad": "what bad looks like"}},
    {{"section": "rot", "text": "a specific trigger"}}
  ],
  "user_stories": [
    {{"who": "role", "what": "capability", "why": "benefit"}}
  ]
}}

Rules:
- 3-6 suggestions total, focused on empty/weak sections
- Each must be specific to THIS product, not generic
- Coverage: specific input types, edge cases, user scenarios
- Balance: specific trade-offs with reasoning
- Alignment: feature areas with concrete observable good/bad
- Rot: specific product events that would change the rules
- User stories: 0-2, only if the input reveals user types not yet captured
- Think about what the user PROBABLY means but hasn't said explicitly yet"""


def build_suggest_goals_prompt(goals: list[str]) -> str:
    goals_text = "\n".join(f"- {g}" for g in goals if g.strip())

    return f"""You are helping a product person define business goals for an AI feature they are building.

They have entered these goals so far:
{goals_text}

Suggest 2-4 additional business goals they likely haven't thought of yet. These should be:
- Specific and concrete (not vague platitudes)
- Complementary to what they already have (fill gaps, not repeat)
- Written in the same style/voice as their existing goals
- Focused on observable business outcomes

Return ONLY valid JSON:
{{
  "suggestions": [
    "goal text here",
    "another goal text"
  ]
}}"""


def build_suggest_stories_prompt(goals: list[str], stories: list[dict]) -> str:
    goals_text = "\n".join(f"- {g}" for g in goals if g.strip())

    existing_stories_text = ""
    if stories:
        for s in stories:
            who = s.get("who", "")
            what = s.get("what", "")
            why = s.get("why", "")
            existing_stories_text += f"- As a {who}, I want to {what}, so that {why}\n"
    else:
        existing_stories_text = "(none yet)"

    return f"""You are helping a product person define user stories for an AI feature they are building.

They have these business goals:
{goals_text}

And these existing user stories:
{existing_stories_text}

Suggest 2-3 additional user stories they likely haven't thought of yet. These should be:
- Specific and concrete (not vague platitudes)
- Complementary to what they already have (fill gaps, not duplicate existing stories)
- Written from the perspective of a real user role
- Aligned with the business goals listed above

Each suggestion must have:
- "who": the user role (e.g., "product manager", "end user")
- "what": the action they want to perform
- "why": the reason/benefit

Return ONLY valid JSON:
{{
  "suggestions": [
    {{"who": "...", "what": "...", "why": "..."}},
    {{"who": "...", "what": "...", "why": "..."}}
  ]
}}"""


def build_evaluate_goals_prompt(goals: list[str]) -> str:
    goals_text = "\n".join(f"{i+1}. {g}" for i, g in enumerate(goals) if g.strip())

    return f"""You are helping a product person define business goals for an AI feature. Review each goal for quality.

Goals to evaluate:
{goals_text}

For each goal, check:
1. **Too broad** — Could this apply to any product? (e.g. "Improve user experience" is too broad; "Reduce candidate screening time from 2 hours to 15 minutes" is specific)
2. **Too technical** — Is this an implementation detail, not a business outcome? (e.g. "Use RAG for retrieval" is technical; "Surface relevant documents without manual search" is a business goal)
3. **Not independent** — Is this a subset or restatement of another goal in the list?
4. **Not measurable** — Could you tell if this goal was achieved? It should describe an observable outcome.

Return ONLY valid JSON:
{{
  "feedback": [
    {{
      "goal": "the original goal text",
      "issue": "brief description of the problem, or null if the goal is fine",
      "suggestion": "an improved version of the goal, or null if the goal is fine"
    }}
  ]
}}

Rules:
- Return one entry per goal, in the same order as the input
- If a goal is good, set both issue and suggestion to null
- Be concise — issues should be 5-10 words max (e.g., "Too broad — could apply to any product")
- Suggestions should be concrete rewrites in the same voice as the original
- Don't be overly harsh — only flag real problems. A goal that's reasonably specific and measurable is fine.
- At least some goals should pass without issues — don't nitpick everything"""


SECTION_1_ROLE = """You are a charter builder. Your job is to help product and business people define what good AI output looks like for their specific feature — in terms they can evaluate themselves, without technical knowledge.

The output is a charter: a structured set of criteria that guides dataset creation and evaluation. You should feel like a thoughtful conversation partner, not a form.

You take whatever input is available — business goals, user stories, or raw conversation — and produce a validated charter through a structured loop. You generate first, then validate, then refine through questions."""


SECTION_2_CHARTER_STRUCTURE = """## The document structure

The document you're building has four sections:

### Coverage
What input scenarios must be represented in the dataset.
- Good: specific enough to generate a concrete example — "Customer asks about an order that is delayed with no clear resolution"
- Bad: generic categories — "Various order tracking scenarios"

### Balance
Which scenarios to weight more heavily and why.
- Good: traceable to hard or high-stakes cases — "Escalation and failure scenarios should be over-represented — these are where customer frustration actually occurs"
- Bad: generic — "Include a mix of easy and difficult scenarios"

### Alignment
What good and bad output actually looks like for each feature area. Each entry has a feature area name, a description of good output, and a description of bad output.
- Good: observable behaviour in product language, consistent yes/no call — "The response states the current order status using the exact information available — 'Your order is out for delivery, expected by 6pm today' — without adding caveats or information not in the system"
- Bad: intent-level — "The response is helpful and accurate"

### Rot
When examples become stale and need updating.
- Good: specific product events as triggers — "When the return policy changes — eligible windows, eligible items, or return process steps"
- Bad: generic — "When the business changes"

## Examples of good and bad output"""


SECTION_3_VALIDATION = """## Validation rules

For every criterion you write, apply the testability heuristic: ask "how would you know?" If the answer requires a judgment call that different people would make differently, the criterion is too vague.

Secondary checks for each criterion:
- Is this in product language? (not technical jargon)
- Can I generate a concrete pass/fail example for this?
- Would a judge produce consistent labels on the same output across multiple runs?

### Conflict detection
If the input contains signals that point in different directions (e.g. business goals push automation, user stories push human control), you must surface the conflict explicitly in the Balance section — not resolve it or ignore it. A document that papers over a genuine conflict in the input fails validation."""


SECTION_4_CONVERSATION = """## Conversation rules

- Ask one or two questions per turn, never more
- Tag every question to the specific section it is trying to improve
- Explain why each question matters in plain language
- Give progress signals after each turn: what is now covered, what still needs work
- Never ask for information already provided in the session
- Never use these words in conversation: charter, eval, criterion, dataset, dimension, LLM, prompt, embedding, token, model. Surface the concepts without the labels. Say "the document we're building" not "the charter". Say "a test case" not "an eval example". Say "what you're measuring" not "your eval criteria".
- If the user gives a vague answer, probe rather than accept: "you mentioned it should feel trustworthy — what would an untrustworthy response look like in practice?"
- If the user says they don't know what something means, explain it in terms of their product — never in methodology terms
- When all criteria pass, say so clearly and transition to review
- When you've asked 3 rounds of questions and criteria are still weak, surface what's uncertain and give the user the choice to keep going or proceed to review

## What you must never do
- Ask more than 2 questions per turn
- Ask for something already provided
- Use technical language in questions or explanations
- Mark a criterion as passing without running validation
- Override or resist a user's decision to proceed to review
- Write alignment criteria in technical language — every criterion must be evaluable by a non-technical person
- Produce a document with empty sections — all four must have content before finishing"""


# --- Dataset phase prompts ---

def build_synthesize_examples_prompt(charter: dict, feature_areas: list[str] | None = None, coverage_criteria: list[str] | None = None, count: int = 2) -> str:
    task = charter.get("task", {})
    coverage = charter.get("coverage", {}).get("criteria", [])
    balance = charter.get("balance", {}).get("criteria", [])
    alignment = charter.get("alignment", [])

    target_areas = feature_areas or [a.get("feature_area", "") for a in alignment]
    target_coverage = coverage_criteria or coverage

    alignment_context = ""
    for a in alignment:
        if a.get("feature_area") in target_areas:
            alignment_context += f"\n### {a['feature_area']}\nGood: {a.get('good', '')}\nBad: {a.get('bad', '')}\n"

    # Build task definition section
    task_section = ""
    if task.get("input_description") or task.get("output_description"):
        task_section = f"""## Task Definition (what the app does)

**Input format**: {task.get('input_description') or 'Not specified'}
**Output format**: {task.get('output_description') or 'Not specified'}
"""
        if task.get("sample_input"):
            task_section += f"""
**Sample input** (MATCH THIS FORMAT EXACTLY):
```
{task.get('sample_input')}
```
IMPORTANT: Generated inputs must match this sample's structure, length, and level of detail.
Do NOT add extra context, metrics, dates, or details not present in the sample.
"""
        if task.get("sample_output"):
            task_section += f"""
**Sample output** (MATCH THIS FORMAT EXACTLY):
```
{task.get('sample_output')}
```
IMPORTANT: Generated outputs must match this sample's structure and format.
"""

    return f"""Generate labeled examples for a dataset based on this charter.

{task_section}
## Charter context

### Coverage criteria (input scenarios to represent):
{json.dumps(target_coverage, indent=2)}

### Balance criteria (weighting guidance):
{json.dumps(balance, indent=2)}

### Alignment definitions (what good/bad looks like):
{alignment_context}

## Task

For each coverage criterion × feature area combination, generate {count} examples:
- One with label "good" — the expected_output matches the alignment definition for good
- One with label "bad" — the expected_output matches the alignment definition for bad

Each example must have:
- **feature_area**: which feature area this tests
- **input**: a concrete, specific scenario matching the INPUT FORMAT above (not generic — include specifics)
- **expected_output**: what the AI would actually produce, matching the OUTPUT FORMAT above
- **coverage_tags**: which coverage criteria this hits
- **label**: "good" or "bad"
- **label_reason**: one sentence explaining why this output is good or bad per the alignment definition

Return ONLY valid JSON:
{{
  "examples": [
    {{
      "feature_area": "...",
      "input": "...",
      "expected_output": "...",
      "coverage_tags": ["..."],
      "label": "good",
      "label_reason": "..."
    }}
  ]
}}

CRITICAL RULES:
- Inputs must match the INPUT FORMAT specified in the task definition
- Expected outputs must match the OUTPUT FORMAT specified in the task definition
- Inputs must be SPECIFIC scenarios with concrete details (names, numbers, dates, situations)
- Expected outputs must be realistic — what the AI would actually produce, not a summary of what it should do
- Good outputs must match the alignment "good" definition exactly
- Bad outputs must match the alignment "bad" definition exactly — they should be realistically bad, not cartoonishly wrong
- Coverage tags must reference actual coverage criteria from the charter
- Each example must be independently evaluable — all context needed is in the input"""


def build_review_examples_prompt(charter: dict, examples: list[dict]) -> str:
    task = charter.get("task", {})
    alignment = charter.get("alignment", [])
    coverage = charter.get("coverage", {}).get("criteria", [])

    alignment_context = ""
    for a in alignment:
        alignment_context += f"\n### {a.get('feature_area', '')}\nGood: {a.get('good', '')}\nBad: {a.get('bad', '')}\n"

    examples_text = json.dumps(examples, indent=2)

    # Build task context
    task_context = ""
    if task.get("input_description") or task.get("output_description"):
        task_context = f"""## Task Definition
**Input format**: {task.get('input_description') or 'Not specified'}
**Output format**: {task.get('output_description') or 'Not specified'}

"""

    return f"""Review these dataset examples against the charter definitions.

{task_context}## Charter alignment definitions:
{alignment_context}

## Charter coverage criteria:
{json.dumps(coverage, indent=2)}

## Examples to review:
{examples_text}

For each example, evaluate:
1. Does the input match a coverage scenario? Which one(s)?
2. Does the expected_output match the alignment definition for its feature area and label?
3. Is the label correct — would a non-technical reviewer agree this is good/bad?
4. Is the example self-contained — does it have enough context to evaluate independently?

Return ONLY valid JSON:
{{
  "reviews": [
    {{
      "example_id": "...",
      "suggested_label": "good" | "bad",
      "confidence": "high" | "medium" | "low",
      "reasoning": "one sentence",
      "coverage_match": ["list of coverage criteria this matches"],
      "issues": ["list of problems found, if any"]
    }}
  ]
}}

Be conservative: if you're unsure whether an example matches the alignment definition, flag it as low confidence."""


def build_dataset_chat_prompt(charter: dict, dataset_stats: dict, user_message: str, conversation_history: list[dict]) -> str:
    task = charter.get("task", {})
    alignment = charter.get("alignment", [])
    coverage = charter.get("coverage", {}).get("criteria", [])

    alignment_context = ""
    for a in alignment:
        alignment_context += f"- **{a.get('feature_area', '')}**: good = {a.get('good', '')[:80]}... | bad = {a.get('bad', '')[:80]}...\n"

    # Build task context
    task_context = ""
    if task.get("input_description") or task.get("output_description"):
        task_context = f"""### Task Definition (what the app does)
**Input**: {task.get('input_description') or 'Not specified'}
**Output**: {task.get('output_description') or 'Not specified'}

"""

    return f"""You are helping a user build and curate a dataset for evaluating their AI feature. You helped them build the charter that defines quality — now you're helping them create examples that match it.

## Charter summary

{task_context}### Feature areas:
{alignment_context}

### Coverage criteria:
{json.dumps(coverage, indent=2)}

## Current dataset stats:
{json.dumps(dataset_stats, indent=2)}

## Conversation so far:
{_format_conversation(conversation_history)}

## User says: "{user_message}"

You can help with:
- Generating examples for specific feature areas or coverage criteria
- Explaining why the judge flagged an example
- Identifying coverage gaps
- Suggesting improvements to specific examples
- Answering questions about the charter definitions

## Available Actions
You can execute actions in the app by including action blocks. Use these when the user asks you to DO something (not just explain).

**Generate examples:**
```dataset-action
{{"action": "generate", "count": 2}}
```
Use when: user asks to "create examples", "generate more", "make some test cases", etc.
- count: number of examples per scenario (default 2)

**Show coverage map:**
```dataset-action
{{"action": "show_coverage"}}
```
Use when: user asks about "gaps", "what's missing", "coverage", "which scenarios need examples"

**Auto-review pending examples:**
```dataset-action
{{"action": "auto_review"}}
```
Use when: user asks to "review examples", "check examples", "judge the examples"

**Export dataset:**
```dataset-action
{{"action": "export"}}
```
Use when: user asks to "export", "download", "save the dataset"

**Approve an example:** (when discussing a specific example)
```dataset-action
{{"action": "approve", "example_id": "..."}}
```

**Reject an example:**
```dataset-action
{{"action": "reject", "example_id": "..."}}
```

## Suggesting Actions
You can also suggest actions the user might want to take. Include a suggestions block:
```suggestions
[
  {{"action": "generate", "label": "Generate examples", "reason": "No examples yet"}},
  {{"action": "show_coverage", "label": "Check coverage", "reason": "See which scenarios need examples"}}
]
```

Suggest actions when:
- Dataset is empty → suggest "Generate examples"
- Many pending items → suggest "Auto-review"
- All reviewed → suggest "Check coverage" and "Export"
- Coverage gaps exist → suggest "Generate more for gaps"

## Rules:
- Be BRIEF. 1-3 sentences max.
- Use plain language — no technical jargon
- When user asks you to DO something, include the action block AND a brief confirmation
- Example: "I'll generate 3 examples per scenario for you." + action block
- Don't ask for confirmation before acting — just do it
- If the request is ambiguous, pick sensible defaults and act
- Proactively suggest helpful next actions based on the dataset state"""


def build_gap_analysis_prompt(charter: dict, dataset_stats: dict, examples: list[dict]) -> str:
    coverage = charter.get("coverage", {}).get("criteria", [])
    balance = charter.get("balance", {}).get("criteria", [])
    alignment = charter.get("alignment", [])

    feature_areas = [a.get("feature_area", "") for a in alignment]

    # Build coverage matrix
    coverage_matrix: dict[str, dict[str, int]] = {}
    for crit in coverage:
        coverage_matrix[crit] = {fa: 0 for fa in feature_areas}

    for ex in examples:
        if ex.get("review_status") != "approved":
            continue
        for tag in ex.get("coverage_tags", []):
            if tag in coverage_matrix:
                fa = ex.get("feature_area", "")
                if fa in coverage_matrix[tag]:
                    coverage_matrix[tag][fa] += 1

    return f"""Analyze this dataset for gaps against the charter.

## Charter coverage criteria:
{json.dumps(coverage, indent=2)}

## Charter balance criteria:
{json.dumps(balance, indent=2)}

## Feature areas:
{json.dumps(feature_areas, indent=2)}

## Coverage matrix (approved examples per criterion × feature area):
{json.dumps(coverage_matrix, indent=2)}

## Dataset stats:
{json.dumps(dataset_stats, indent=2)}

Identify:
1. **Coverage gaps**: which coverage criteria have 0 approved examples?
2. **Feature area gaps**: which feature areas have 0 examples?
3. **Balance issues**: are the balance criteria being respected? (which scenario types are under-represented?)
4. **Label gaps**: which feature areas are missing good or bad examples?

Return ONLY valid JSON:
{{
  "coverage_gaps": ["criteria with 0 examples"],
  "feature_area_gaps": ["feature areas with 0 examples"],
  "balance_issues": ["description of under-represented scenarios"],
  "label_gaps": [{{"feature_area": "...", "missing": "good|bad"}}],
  "coverage_matrix": {{"criterion": {{"feature_area": count}}}},
  "summary": "2-3 sentence summary of the dataset's completeness"
}}"""


# --- Schema detection prompts ---

def build_detect_schema_prompt(content: str, content_type: str = "auto") -> str:
    """Build prompt for detecting schema from pasted sample data."""
    type_hint = ""
    if content_type != "auto":
        type_hint = f"\nThe user indicated the content type is: {content_type}"

    return f"""Analyze the following sample data and detect its schema/structure.
{type_hint}

Sample content:
```
{content}
```

Your job is to:
1. Detect the format (JSON object, JSON array, CSV, or freeform text)
2. If structured (JSON/CSV), identify the fields and their types
3. Generate a clear, human-readable description of what this data represents

Return ONLY valid JSON:
{{
  "detected_format": "json_object" | "json_array" | "csv" | "freeform_text",
  "input_description": "A clear description of what this input represents (e.g., 'A customer support ticket with subject, body, and priority fields')",
  "output_description": "",
  "fields": [
    {{"name": "field_name", "type": "string|number|boolean|array|object", "example": "sample value"}}
  ],
  "sample_input": "The cleaned/formatted sample for use as a template"
}}

Rules:
- input_description should be 1-2 sentences describing what this data IS, not technical details
- For JSON, list top-level fields. For nested objects, use "object" type
- For CSV, list column names as fields
- For freeform text, fields can be empty or contain semantic sections if apparent
- sample_input should be the cleaned version of the input (formatted JSON, trimmed text, etc.)
- Keep descriptions in plain language a non-technical person would understand"""


def build_infer_schema_prompt(examples: list[dict], charter: dict) -> str:
    """Build prompt for inferring schema from existing dataset examples."""
    # Format examples for the prompt
    examples_text = json.dumps(examples[:10], indent=2)  # Limit to 10 examples

    alignment = charter.get("alignment", [])
    feature_areas = [a.get("feature_area", "") for a in alignment]

    return f"""Analyze these dataset examples to infer the input/output format for this application.

Feature areas in the charter: {json.dumps(feature_areas)}

Examples from the dataset:
{examples_text}

Based on these examples, determine:
1. What format do the inputs follow? (structure, typical content, length)
2. What format do the outputs follow?
3. Are there consistent patterns across examples?

Return ONLY valid JSON:
{{
  "task": {{
    "input_description": "Description of the input format based on patterns observed",
    "output_description": "Description of the output format based on patterns observed",
    "sample_input": "A representative sample input based on the examples",
    "sample_output": "A representative sample output based on the examples"
  }},
  "confidence": "high" | "medium" | "low",
  "example_count": {len(examples)},
  "pattern_notes": "What patterns were detected (e.g., 'All inputs are JSON with customer_id and query fields, outputs are structured responses with answer and confidence')"
}}

Rules:
- Use "high" confidence if examples are consistent and patterns are clear
- Use "medium" if there's some variation but a general pattern exists
- Use "low" if examples are very diverse or patterns are unclear
- sample_input/output should be realistic examples that represent the typical format
- Keep descriptions in plain language"""


def build_import_url_prompt(content: str, url: str, detected_type: str) -> str:
    """Build prompt for extracting schema from URL content."""
    return f"""Extract the input/output schema from this content fetched from: {url}

Detected content type: {detected_type}

Content:
```
{content[:8000]}
```

Based on this content, determine the task definition:
- If this is an OpenAPI/Swagger spec, extract request/response schemas from the endpoints
- If this is JSON data, infer the schema from the structure
- If this is documentation (HTML/Markdown), extract example inputs and outputs

Return ONLY valid JSON:
{{
  "task": {{
    "input_description": "What the app receives (inferred from the spec/data/docs)",
    "output_description": "What the app produces (inferred from the spec/data/docs)",
    "sample_input": "A concrete example of the input format",
    "sample_output": "A concrete example of the output format (if available)"
  }},
  "detected_type": "json_data" | "openapi" | "html_docs",
  "notes": "Any additional context about what was found"
}}

Rules:
- For OpenAPI specs, focus on the most relevant/common endpoint
- For JSON data, treat it as sample input and describe its structure
- For documentation, extract any code examples or sample data
- Keep descriptions clear and in plain language"""


