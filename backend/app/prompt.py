"""All prompts for the charter generation agent.

Each prompt is a function that takes state and returns a string.
When you want to change what the agent says or how it reasons, edit here.

Prompts:
- build_system_prompt() — system prompt for tool-use agent loop (unused currently)
- build_generate_draft_prompt(state) — generate charter JSON from user input
- build_validate_charter_prompt(state) — validate charter against testability criteria
- build_conversational_turn_prompt(state, user_message) — chat turn with optional charter updates
- build_generate_suggestions_prompt(state) — suggest items for weak/empty sections
"""

from __future__ import annotations

import json
from pathlib import Path

from .models import SessionState

DATASET_PATH = Path(__file__).parent.parent.parent / "north-star-dataset.json"


def load_few_shot_examples() -> list[dict]:
    """Load examples from the dataset file."""
    if not DATASET_PATH.exists():
        return []
    with open(DATASET_PATH) as f:
        return json.load(f)


def _format_conversation(history: list[dict]) -> str:
    if not history:
        return "(No conversation yet)"
    parts = []
    for msg in history:
        role = msg.get("role", "unknown")
        content = msg.get("content", "")
        parts.append(f"{role}: {content}")
    return "\n".join(parts)


def build_system_prompt() -> str:
    examples = load_few_shot_examples()
    example_text = _format_examples(examples[:3])

    return f"""{SECTION_1_ROLE}

{SECTION_2_CHARTER_STRUCTURE}

{example_text}

{SECTION_3_VALIDATION}

{SECTION_4_CONVERSATION}"""


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
    coverage = charter.get("coverage", {}).get("criteria", [])
    balance = charter.get("balance", {}).get("criteria", [])
    alignment = charter.get("alignment", [])

    target_areas = feature_areas or [a.get("feature_area", "") for a in alignment]
    target_coverage = coverage_criteria or coverage

    alignment_context = ""
    for a in alignment:
        if a.get("feature_area") in target_areas:
            alignment_context += f"\n### {a['feature_area']}\nGood: {a.get('good', '')}\nBad: {a.get('bad', '')}\n"

    return f"""Generate labeled examples for a dataset based on this charter.

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
- **input**: a concrete, specific scenario (not generic — include names, numbers, specifics)
- **expected_output**: what the AI would actually say/produce
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
- Inputs must be SPECIFIC scenarios with concrete details (names, numbers, dates, situations)
- Expected outputs must be realistic — what the AI would actually produce, not a summary of what it should do
- Good outputs must match the alignment "good" definition exactly
- Bad outputs must match the alignment "bad" definition exactly — they should be realistically bad, not cartoonishly wrong
- Coverage tags must reference actual coverage criteria from the charter
- Each example must be independently evaluable — all context needed is in the input"""


def build_review_examples_prompt(charter: dict, examples: list[dict]) -> str:
    alignment = charter.get("alignment", [])
    coverage = charter.get("coverage", {}).get("criteria", [])

    alignment_context = ""
    for a in alignment:
        alignment_context += f"\n### {a.get('feature_area', '')}\nGood: {a.get('good', '')}\nBad: {a.get('bad', '')}\n"

    examples_text = json.dumps(examples, indent=2)

    return f"""Review these dataset examples against the charter definitions.

## Charter alignment definitions:
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
    alignment = charter.get("alignment", [])
    coverage = charter.get("coverage", {}).get("criteria", [])

    alignment_context = ""
    for a in alignment:
        alignment_context += f"- **{a.get('feature_area', '')}**: good = {a.get('good', '')[:80]}... | bad = {a.get('bad', '')[:80]}...\n"

    return f"""You are helping a user build and curate a dataset for evaluating their AI feature. You helped them build the charter that defines quality — now you're helping them create examples that match it.

## Charter summary

### Feature areas:
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

Rules:
- Be BRIEF. 1-3 sentences.
- Use plain language — no technical jargon
- When suggesting examples, be specific and concrete
- Reference the charter definitions when explaining quality judgements
- If the user asks to generate examples, describe what you'd generate and ask for confirmation

If you need to return structured data (examples to add, updates to make), use:
```dataset-action
{{"action": "generate", "feature_areas": ["..."], "count": 2}}
```
or
```dataset-action
{{"action": "review", "example_ids": ["..."]}}
```"""


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


def _format_examples(examples: list[dict]) -> str:
    """Format dataset examples as few-shot demonstrations."""
    if not examples:
        return ""

    parts = []
    for ex in examples:
        scenario = ex.get("scenario", "")
        good = ex.get("good_output", {})
        bad = ex.get("bad_output", {})

        good_alignment = [
            {"feature_area": a.get("feature_area"), "good": a.get("good"), "bad": a.get("bad")}
            for a in good.get("alignment", [])
        ]
        bad_alignment = [
            {"feature_area": a.get("feature_area"), "good": a.get("good"), "bad": a.get("bad")}
            for a in bad.get("alignment", [])
        ]

        parts.append(f"""### Example: {scenario}

**Good output:**
Coverage: {json.dumps(good.get('coverage', {}).get('criteria', []), indent=2)}
Balance: {json.dumps(good.get('balance', {}).get('criteria', []), indent=2)}
Alignment: {json.dumps(good_alignment, indent=2)}
Rot: {json.dumps(good.get('rot', {}).get('criteria', []), indent=2)}

Why this is good: {good.get('label_reason', '')}

**Bad output:**
Coverage: {json.dumps(bad.get('coverage', {}).get('criteria', []), indent=2)}
Alignment: {json.dumps(bad_alignment, indent=2)}

Why this is bad: {bad.get('label_reason', '')}""")

    return "\n\n".join(parts)
