# Business Goals
**Charter generation agent — eval-driven development platform**

*Why we're building this, what success looks like.*

---

## Why build this

Most teams building on AI can't systematically improve their product because they've never defined what "better" means. The charter generation agent exists to solve the first and hardest part of that problem: translating business intent into testable criteria that non-technical people can own.

---

## Goals

### Help product and business people own the definition of good
Right now evals are a dev artifact because the tooling is dev-facing. The agent needs to make charter creation accessible to someone with no ML or engineering background.

**How we'd measure it:** % of charters produced without dev involvement; user role distribution among charter creators

---

### Produce charters specific enough to generate consistent datasets
A charter is only valuable if it can generate labeled examples that an LLM judge can evaluate consistently. Vague criteria produce noisy evals.

**How we'd measure it:** criterion testability rate (% of criteria that pass the "how would you know?" test); dataset hit rate (% of generation attempts that produce usable labeled pairs)

---

### Reduce time from business goal to working eval pipeline
The faster a team can go from "we want to improve X" to "we have evals running," the more iterations they can do. Speed is a proxy for how much friction the agent removes.

**How we'd measure it:** time from first input to charter approved for dataset generation; number of question rounds before completion

---

### Keep evals connected to business goals over time
Evals drift. The charter is the mechanism that keeps them grounded. The agent needs to support charter evolution as the product changes, not just initial creation.

**How we'd measure it:** charter revision rate; correlation between charter updates and business goal changes

---

### Make improvement visible
Teams need to see whether changes to their AI are actually improvements. The platform needs to produce metrics that are meaningful to product and business people, not just engineers.

**How we'd measure it:** eval score trend over time; whether score changes predict downstream business metrics

---

## How these goals connect to the charter

| Business goal | Charter dimension it drives |
|---|---|
| Product/business ownership | Alignment — criteria must be in product language |
| Dataset specificity | Alignment — criteria must be observable and testable |
| Speed | Coverage — must handle sparse inputs efficiently |
| Staying connected to goals | Rot — charter must have clear update triggers |
| Visible improvement | Alignment — eval outputs must be interpretable by non-technical users |
