# Charter
**Charter generation agent — eval-driven development platform**

*The criteria that define what good output looks like for the charter generation feature. Guides both dataset creation and evaluation.*

---

## Coverage
*What input scenarios must be represented*

**Input completeness**
- Sparse inputs — vague business goals with minimal user stories ("we want the AI to be better")
- Detailed inputs — full PRD or product spec with well-defined user stories
- Partial inputs — some dimensions clear, others missing
- Conflicting inputs — business goals and user stories that point in different directions

**User type**
- Non-technical user who struggles to articulate criteria — needs more guidance, answers in intent rather than observable behaviour
- Product-savvy user who knows what they want but not how to express it as eval criteria
- User who has never heard of evals or charters

**AI use case type**
- Customer-facing features (chatbots, assistants, recommendation)
- Internal tooling (summarisation, classification, data extraction)
- Decision-support features (candidate matching, lead scoring, risk assessment)

**Feature scope**
- Single feature area — one thing the AI does
- Multiple feature areas — several distinct outputs to evaluate

**Existing data**
- Company has no existing AI output data
- Company has production data but no evals
- Company has existing evals they want to improve

---

## Balance
*How edge cases should be weighted*

**Sparse and vague inputs should be heavily over-represented.** These are the hardest cases and the most likely to produce weak charters. If the agent only works well with detailed inputs, it fails most real users.

**Conflicting inputs need dedicated coverage.** When business goals and user stories point in different directions, the agent needs to surface the conflict rather than paper over it. This is a failure mode that's easy to miss and expensive later.

**Non-technical users should be over-represented.** The product's core value proposition is accessibility. If it only works for people who already understand evals, it hasn't solved the problem.

---

## Alignment
*What "good charter generation output" actually means*

**Coverage dimension**
Good: specific enough that you could generate a concrete example for each scenario listed — "a customer support query where the user is angry and the AI fails to acknowledge the emotion before solving the problem."
Bad: generic categories that don't constrain example generation — "various types of user queries."

**Balance dimension**
Good: specifies which scenarios to over-represent and why — traceable to the hardest or highest-stakes cases for this specific product.
Bad: lists balance without reasoning — "include edge cases" with no guidance on which ones or why.

**Alignment dimension**
Good: each criterion is stated as observable behaviour in product language — "the response acknowledges the user's specific situation before giving advice." A non-technical person can look at an output and make a consistent yes/no call.
Bad: criteria stated as intent — "the response should be helpful and empathetic." No two people will evaluate this the same way.

**Rot dimension**
Good: specific update triggers tied to real product events — "when the output format changes," "when a new feature area is added," "when production data shows a new failure pattern."
Bad: generic rot conditions — "when the product changes" or no rot conditions at all.

**Across all dimensions**
Good: no criterion is so broad that an LLM judge produces different labels on the same output across multiple runs.
Bad: any criterion that, when given to an LLM judge, generates inconsistent labels — this is the ultimate testability failure.

---

## Rot
*When a charter generation example becomes stale*

- The charter format changes — new dimensions added, existing ones restructured
- The agent's conversation flow changes significantly — examples built on an old flow no longer reflect real sessions
- A new AI use case category becomes common that isn't represented in existing examples
- The definition of "testable criterion" evolves — what counts as specific enough changes as the methodology matures
- Production data surfaces a new failure pattern not covered by existing examples

**Review cadence:** review after any significant change to the agent's system prompt or conversation flow. Otherwise audit quarterly.
