# North Star — website copy

> Working document. Sections marked **[in place]** are already designed/built per the latest Figma. Sections marked **[draft]** have copy ready but need integration. Sections marked **[outline]** still need work. Bullet points throughout for fast editing.

---

## Page-level decisions

### Positioning
- **Pre-headline kicker:** *THE EVAL LAYER FOR AGENTIC ENGINEERING*
- **Headline:** *Ship AI features your users can rely on*
- **Subtitle:** *Evaluate your AI features from the first demo to production.*
- **Strategic centerpiece:** *Define what good looks like.* The charter is the answer to "what does good mean?" — the upstream gap most evals leave open.
- **Pithy version (for sales/blog/Twitter):** *Prod evals tell you when something is wrong. They don't tell you what right looks like. Charters do.*

### Voice
- Declarative, second-person, slightly opinionated
- Warm where it earns it; sharp where the message lands
- No comparisons to other tools (positive claims only)
- USP pattern: *Get [X]* — what NS gives you, not what you do
- Avoid hedges (*could, might, some teams find*)

### Audience archetypes (role-based)

The page addresses four roles. Each role gets a different value out of the same artifact (the charter). Situation-based context — *first feature, in production, agent builder, regulated industry* — is implicit inside the role-specific copy, not its own framework.

- **PMs.** Own the spec. The charter is their artifact — the thing they couldn't write before. Bring goals and user stories, get a working prompt and proof it works.
- **Team leads.** Coordinate execution and own mid-term roadmap. Need the charter to align the team and show progress every cycle without arguing about *"good enough."*
- **VPs.** Own company-level outcomes — ROI, risk, compliance, time-to-launch. Need measurable progress, audit trails, and proof before commitments.
- **Builders.** Solo founders, indie devs, two-person teams. Play all four roles at once. The same product covers all of them.

### CTAs
- **Primary (self-serve):** *Try with your SKILL.md now* — hero, USP section, final
- **Secondary (partnership):** *Book a working session* — hero, prod-team-targeted sections
- **Tertiary (warmup):** *See sample report*, *Read FAQ*

---

# Page sections (in order)

---

## 1. Hero **[in place]**

### Pre-headline
- *THE EVAL LAYER FOR AGENTIC ENGINEERING*

### Headline
- *Ship AI features your users can rely on*

### Subtitle
- *Evaluate your AI features from the first demo to production.*

### CTAs
- `[ Try with your SKILL.md now ]` — primary
- `[ Book a working session ]` — secondary

### Diagram
- Dual-cycle Venn
- **Left circle (Pre-production):** *Dataset* (top), *Benchmark* (bottom)
- **Right circle (Production):** *Production data* (top), *Alerts* (bottom)
- **Shared overlap:** *Prompt* (top), *Scorers* (bottom)

---

## 2. Define what good looks like **[partial — manifesto body to add]**

> The strategic centerpiece. Combines the *Define what good* manifesto with the 6 USP cards as evidence/elaboration. Section currently in PDF has the USP grid but is missing the manifesto body.

### Headline
- *Define what good looks like.*

### Subtitle
- *And measure against it.*

### Manifesto body
- Put down what you want your AI to do — specifically enough to build a prompt from, and to evaluate against.
- The charter formalizes your wishes into a ruleset. Dataset, scorers, benchmark — all built around it.

### USP grid (6 cards, 2x3) **[in place]**

#### 1. A skill grounded in your goals
- Bring goals and user stories — North Star drafts the skill. Bring a skill or prompt instead, and we'll backfill the goals and user stories it implies. Either way, a charter formalizes them into success criteria.

#### 2. An eval-ready dataset
- Bring what you have and we'll sharpen it. Bring nothing and we'll synthesize it. Either way, every example is tied to a goal.

#### 3. Scorers tuned to your goals
- Every scorer is tied to a charter dimension, measuring what matters to your AI.

#### 4. Get production-ready
- Run your skill against the dataset and scorers. See what's failing, refine, run again — each cycle sharper than the last.

#### 5. Benchmark
- Set the bar against which you'll decide what to improve, and measure the ROI of your improvements.

#### 6. Score production and diagnose
- Implement your scorers in your runtime; when scores drop, you'll know where to look.

### Closing line
- *No matter where you are at, we'll help you get to production safe.*

### CTA
- `[ Try now! ]` — primary

### Open decisions for this section
- Where exactly does the manifesto body sit — above the USPs (intro to the section), between subtitle and grid, or as a standalone block after the closing?
- *"No matter where you are at"* — current copy reads slightly informal. Could tighten to *"No matter your stage..."* or leave as is.
- Are 6 USPs the right number? *Benchmark* (#5) is recently added; could fold into #4 if the grid feels crowded.

---

## 3. Right now, you're guessing **[in place]**

### Headline
- *Right now, you're guessing.*

### Four-question grid

#### Is it right?
- You updated a prompt. A case that used to work now fails.

#### Is it safe?
- You shipped a release. A user caught your AI making up a fact.

#### Is it consistent?
- You added a skill. Your model calls it sometimes, ignores it others.

#### Is it sustainable?
- You switched the model. Costs doubled but you can't tell if quality increased.

### Section closer
- *Don't be surprised twice.*

---

## 4. Karpathy quote **[in place]**

### Quote
- *"Language models automate what can be verified."*

### Attribution
- Andrej Karpathy: *From Vibe Coding to Agentic Engineering*

### Visual
- Quote block with portrait. Slider/carousel suggested by PDF dots — design decision: rotate through additional supporting quotes? If yes, what other quotes go in the rotation?

---

## 5. The evaluation loop **[in place]**

### Headline
- *The evaluation loop*

### Subtitle
- *2 complimentary tracks*

### Pre-production cycle blurb
- **Pre-production cycle**
- *Build the evals before you ship.*

### Production cycle blurb
- **Production cycle**
- *Keep them honest after you do.*

### Closing line
- *Same charter. Same scorers. Each cycle makes the next sharper.*

### Visual
- Two stacked labels with curved arrows between them indicating a cycle (per PDF).

---

## 6. Specify / Detect tabs **[Specify in place, Detect needs content]**

### Tab 1 — Specify (Pre-production track) **[in place]**

#### Tab subtitle
- *Pre-production track*

#### Intro
- Most teams stall trying to begin: where do you even start with evals? Do you need a dataset first? A scoring rubric? A test suite? North Star starts wherever you do.

#### Diagram
- Linear flow: `business goals + user stories → skill / prompt → charter (highlighted) → dataset + scorers → benchmark`
- Top: `backfill` arrow from skill / prompt back to business goals + user stories
- Top right: `improve` arrow from benchmark back to skill / prompt

#### Two cards

##### No prompt yet
- Describe what your AI should do and what your users want to achieve with it.
- North Star will draft a skill, a charter to formalize success criteria, build a dataset, and generate scorers tailored to your goals.

##### Already have a prompt
- Drop it in and North Star will backfill the goals and user stories so you can review and edit them to your liking.
- After that the rest of the scaffolding follows: charter, dataset, and scorers for you to use.

#### Output (5 items with icons)

##### Skill
- Drafted from your goals when you don't have one, versioned and tracked across iterations when you do.

##### Charter
- Your goals, formalized into success criteria.

##### Dataset
- An improved dataset optimized for evals, partly or fully synthesized from your charter.

##### Scorers
- Tuned to that charter, not generic metrics.

##### Benchmark
- Your AI's current performance against the bar you set.

### Tab 2 — Detect (Production track) **[draft]**

#### Tab subtitle
- *Production track*

#### Intro (proposed)
- Once you ship, the questions change. How is it actually performing? What are users doing that you didn't anticipate? When something gets worse, will you know fast enough? North Star keeps the cycle going.

#### Diagram (proposed)
- Linear flow: `production output → samples → scorers (highlighted) → alerts → new test cases`
- Top right: `improve` loop arrow from new test cases back to production output
- No `backfill` arrow — production has a single canonical entry

#### Two cards (proposed)

##### Catch regressions
- Real traffic runs through the same scorers in your eval runtime, sampled to fit your budget.
- Anything that drifts surfaces as an alert.

##### Feed the next cycle
- Failing cases flow back to North Star as new entries in your dataset.
- The next pre-production cycle starts with what production just taught you.

#### Output (proposed, 3 items)

##### Samples
- Production calls scored with the same scorers you built, sampled to fit your cost budget.

##### Alerts
- When scores drop, you find out fast.

##### New test cases
- The surprises get added to your dataset, automatically.

---

## 7. BYO Runtime **[in place]**

### Headline
- *BYORuntime*

### Body
- *North Star generates the evals, you run them wherever you already do.*

### Logos
- Braintrust, Langfuse, OpenAI evals, [others TBD]

### Caption
- *Works with Braintrust, Langfuse, OpenAI evals, or your own runtime.*

---

# Sections drafted but not yet placed

> Each section below has copy or options ready, but hasn't earned its slot in the page yet. Status markers: **[draft]** = copy written, ready to place. **[outline]** = sketched, needs more work. **[needs fleshing out]** = mentioned in conversation but never developed.

---

## The charter — high-level + detailed subpage **[draft]**

> Two versions: a concise home-page section (between the eval loop and the Specify/Detect tabs), and a detailed subpage (`/charter`) for visitors who want depth.

### Home-page version (concise)

#### Headline
- *The charter.*

#### Subtitle
- *Your AI feature's success criteria, organized across five categories.*

#### Body
- A charter pins down what your AI feature should do — specifically enough that a system can grade against it.
- It's structured around five categories. Each one names a different way "good" usually goes wrong without a written-down spec.

#### The five categories

##### Coverage
- The distinct scenarios, edge cases, and user intents your feature needs to handle.
- *Without it, whole categories of input go untested.*

##### Balance
- How weight is distributed across those scenarios.
- *Without it, easy cases get over-represented and hard ones get drowned out.*

##### Alignment
- What good output and bad output look like, feature by feature.
- *Without it, "on-spec" and "on-brand" stay subjective — and the AI guesses.*

##### Safety
- The rules the output must obey — refusals, privacy, harmful actions, destructive commands.
- *Without it, the lines that must not be crossed stay implicit.*

##### Freshness
- The conditions that signal your charter has gone stale — new features, changed requirements, updated models.
- *Without it, your charter ages out of sync with the product.*

> Note: app codebase calls this category *Rot*. *Freshness* is a website-only rename, kept here only for marketing voice. If you want consistency between app and site, swap *Freshness* → *Rot* throughout this section.

#### Visual (recommended)
- Sample charter snippet, each line tagged with its category:

```
SUCCESS CRITERIA
1. [Coverage]    Handle single-doc, multi-doc, and ambiguous queries.
2. [Alignment]   Good: answer cites sources. Bad: answer invents facts.
3. [Safety]      Never share user PII, even when asked directly.
4. [Balance]     Weight long-tail queries equally with common ones.
5. [Freshness]   Regenerate when source docs change or new features ship.
```

- *Each category becomes one or more criteria. Each criterion becomes a scorer.*

#### Closing line
- *Five categories. Every line in your charter earns its place under one.*

#### CTA
- `[ See how charters work → ]` — links to `/charter` subpage.

#### Suggested placement on the home page
- Between Section 6 (the evaluation loop) and Section 7 (Specify/Detect tabs). The Karpathy quote sets up *verification*, the eval loop introduces the architecture, the charter section delivers the cornerstone, the tabs walk through how it's used.

#### Open decisions for this section
- **Naming.** Renamed *Rot* → *Freshness* for the public site. *Rot* names the failure mode; *Freshness* names the property. *Freshness* may be safer; *Rot* is more memorable. Worth one A/B with people outside the team.
- **Order.** Currently Coverage → Balance → Alignment → Safety → Freshness. Reads as: *what to test → how much of each → what answers look like → what's forbidden → when to refresh*. Could lead with *Alignment* if "good vs bad output" is the more intuitive entry point for a first-time visitor.
- **Tie back to the four questions.** Soft connection only ("a different way good usually goes wrong") — the categories aren't a 1:1 mirror of right/safe/consistent/sustainable, so forcing the mapping would mislead. Acceptable, or should the body make the relationship explicit?
- **Length.** Each category has a single-line definition + a *without it* italic clause. The italics could be cut for a tighter section if the visual snippet does enough work alone.

---

### Subpage version (`/charter`)

#### Subpage headline
- *The charter explained.*

#### Subpage subtitle
- *Your goals, formalized into a ruleset everything else is built around.*

#### Subpage components

##### 1. What a charter is
- A charter is your AI feature's success criteria, formalized. It takes your goals and user stories — what you want your AI to do, and what users expect — and turns them into specific, testable claims a system can grade against.
- Without a charter, your evals score against vibes. With one, they score against the bar your team set.

##### 2. What one looks like
- Sample charter, fully rendered. Annotated to show how each line maps from intent to testable claim. Example use case: documentation Q&A assistant.

```
GOALS
- Help users find answers in product docs
- Provide accurate information; defer when uncertain
- Maintain a friendly, professional tone

USER STORIES
- As a user, I want to ask questions about how the product works.
- As a user, I want to know when the AI doesn't have an answer.
- As a user, I expect responses to cite the docs they're based on.

SUCCESS CRITERIA
1. Answer relevance: every answer must reference source documents.
2. Confidence calibration: express uncertainty when sources don't directly answer.
3. Tone: professional and friendly, not robotic.
4. Completeness: cover the question without unnecessary verbosity.
5. Refusal handling: when info isn't available, say so politely.
```

- *Each criterion is specific enough to write a scorer for.*

##### 3. Where it comes from
- Bring goals and user stories — North Star drafts the charter from them.
- Bring a skill or prompt — North Star backfills the goals and user stories it implies, then drafts the charter.
- Every line is editable. The charter is yours; we just help you write it down.

##### 4. The four dimensions
- Most charters cover four dimensions of AI quality:
  - **Right** — does the AI produce correct, useful output?
  - **Safe** — does it avoid harm, hallucination, harmful behavior?
  - **Consistent** — does it behave the same way across cases?
  - **Sustainable** — does it scale economically (cost, latency)?
- Your charter doesn't have to cover all four — but most production-ready AI features do.

##### 5. How it evolves
- As you ship and discover new failure modes, your charter grows with them. New user stories come in. New edge cases get codified. Every version is tracked, so you can see what changed and when.

##### 6. How it connects to everything else
- **Dataset** — every example tests one or more charter criteria.
- **Scorers** — each scorer is tuned to a specific charter dimension.
- **Benchmark** — measures performance against the charter as a whole.
- **Production scoring** — uses the same scorers, on real traffic.
- When something fails, the charter helps you trace where: which criterion, which dimension.

##### 7. CTA
- `[ Try writing your charter → ]` — back to home / sandbox.

#### Needs fleshing out
- The §4 *four dimensions* (right/safe/consistent/sustainable) and the home-page *five categories* (coverage/balance/alignment/safety/freshness) are now two different frameworks living on the same page. Decide whether the subpage should also adopt the five categories for consistency, or whether the four dimensions belong here as a separate user-facing lens.
- Additional charter samples for other use cases (RAG agent, structured extraction, multi-step agent).
- Annotation visual: how each line traces to a scorer or dataset entry.

---

## A. The dataset (deep-dive) **[draft]**

> May not be needed if Section 2 USP #2 carries enough weight. Strong candidate for a `/data` subpage if home + subpage split happens.

### Layout options
- **Option 1 (lighter):** single section with two side-by-side cards (current). Fits as a section on the home page.
- **Option 2 (heavier):** tabbed surface like the Specify/Detect tabs, with one tab for *Bring your data* and one for *Generate from scratch*, each with its own intro, diagram, and outputs. Best for a `/data` subpage.

### Headline
- *Bring your data. Or don't.*

### Subtitle
- *Evals are only as strong as the dataset behind them. Yours is built from your charter, so it matches your goals and covers every case the charter says matters.*

### Intro
- Most evals fail at the dataset. It's too small (your team only had time to write thirty examples), too narrow (covers happy paths, not edge cases), or too generic (grades on metrics that don't match your goals). North Star fixes all three.

### Two cards

#### Bring your dataset
- Drop in what you have. North Star matches every example to your charter, removes noisy or redundant entries, and synthesizes new cases to fill the gaps you didn't see.
- *What you bring stays — sharpened.*

#### Or start fresh
- No dataset? North Star generates one from your charter. Every example tied to a goal, balanced across user stories, deliberately stress-testing edge cases.
- *Synthetic isn't a downgrade — it's how you reach the coverage humans miss.*

### Outputs
- **Charter-matched** — every example labeled against the success criteria it tests.
- **Eval-optimized** — formatted for your runtime, deduplicated, and filtered.
- **Gap-filled** — synthesis covers what your hand-curated examples missed.
- **Versioned** — every change tracked across iterations.

### Needs fleshing out
- The synthesis story is the most differentiated part — could use a worked example showing what synthesis looks like in practice (input charter → output dataset entries).
- A line about *quality* of synthesis vs. naive approaches (humans miss edge cases; synthesis from a charter doesn't).

---

## B. Start early, scale with you **[draft]**

### Headline
- *Start the day you start.*

### Body — Option A (text-only, recommended)
- Most eval tools wait until you've shipped — they need production traffic to score, or a finished dataset to test against. North Star doesn't. Bring a prompt or just an idea of what your AI should do; in an hour you have a charter, a dataset, and scorers. As you grow into production, the same evals scale: real traffic, regressions, surprises feeding the next cycle.
- *Same product. Prototype to production.*

### Body — Option B (two snapshot columns)
> Most eval tools wait until you've shipped. North Star doesn't.

#### Just starting
- Bring a prompt or just an idea of what your AI should do.
- In an hour, you have a charter, a dataset, scorers — ready to run.
- Ship knowing what changed.

#### Already in production
- Plug in your eval runtime.
- Score real traffic, surface regressions, capture surprises.
- Use what production teaches you to sharpen the next cycle.

> *Same product. Same flow. Different scale.*

### CTA
- `[ Book a working session → ]` — secondary

---

## C. Try it **[outline]**

### Headline
- *Drop in a prompt. See evals in 60 seconds.*

### Format options
- **Option 1: Interactive sandbox** — embedded text area where the visitor can paste a prompt and see a live charter / sample dataset / scorer suggestion. Highest engagement, highest engineering cost.
- **Option 2: Tight product video** — 60-90 second screencast walking through the full flow (paste prompt → see charter → see dataset → see benchmark). Lower cost, still convincing.
- **Option 3: Sample report download** — pre-baked example PDF showing what NS produces for a representative prompt. Cheapest, lowest engagement.
- **Option 4: All three** — sandbox as primary, video as fallback for those who'd rather watch, sample report as the "I'll send to my team" asset.

### Needs fleshing out
- Sandbox spec (what's editable, what's pre-filled, where data goes).
- Video script (60-90 seconds — what does the screencast show?).
- Sample report — pick a representative use case and pre-bake the artifacts.

### CTA
- `[ Try with your own prompt → ]` — primary

---

## D. Built for **[outline]**

### Purpose
- Self-identification — make each archetype feel directly addressed.

### Archetype card options

#### Three-archetype version (recommended)
- **The thoughtful builder shipping their first AI feature**
- **The team running AI in production**
- **The builder of agents or multi-step AI flows**

#### Four-archetype version (adds compliance)
- All three above plus **Regulated industries** — *"You can't tell a regulator 'we'll find out in prod' — pre-launch evidence against a spec is the gate."* Addresses the compliance-gating argument.

#### Five-archetype version (adds platform teams)
- All four plus **Platform / infra teams** — *"Standardizing eval tooling across the org. North Star generates the evals; your existing runtime ships them."*

### Needs fleshing out
- Full card copy for each archetype (currently just the title).
- Icon system — match the design language already in use.
- Decision: 3, 4, or 5 archetypes? My instinct: 3, with regulated industries as a callout in FAQ instead.

---

## E. FAQ **[outline]**

### Questions to address (with draft answer sketches)

- **Is this just observability?**
  - No. Observability tools tell you what happened in prod. North Star tells you what *should* happen — by helping you write down the spec your AI is held to.

- **Do I need a dataset to start?**
  - No. Bring a prompt or just goals; we'll synthesize a dataset from your charter.

- **What about confidential prompts?**
  - [Needs fleshing out — depends on data handling policy]

- **How does this compare to Braintrust / Langfuse / OpenAI evals?**
  - We're complementary, not competitive. North Star generates the evals (charter, dataset, scorers); your existing runtime runs them. We integrate with all major eval platforms.

- **What's the relationship between the charter and my evals?**
  - The charter is the spec. Every dataset entry, every scorer, every benchmark is built around it. Without a charter, you're scoring against vibes.

- **How is this different from tools that auto-generate eval cases from production failures?**
  - That approach only helps teams that already have prod traffic — useless when you most need help (pre-launch). North Star starts upstream.

- **What does it cost?**
  - [Needs fleshing out — pricing TBD]

### Needs fleshing out
- Final answers (above are sketches).
- Question ordering — most-clicked at top.
- Whether to use accordion or full text.

---

## F. Final CTA / footer **[outline]**

### Content
- Positioning sentence restated: *Ship AI features your users can rely on.*
- Two CTAs: `[ Try with your SKILL.md now ]` (primary) + `[ Book a working session ]` (secondary)
- Optional one-line founder note (see Section J)
- Footer links: docs, blog, pricing, about, contact, privacy, terms

### Needs fleshing out
- Founder note (text + photo + name).
- Footer link inventory.
- Newsletter signup — yes/no?

---

## G. Integrations / BYORuntime detail **[needs fleshing out]**

> Expanded version of the home-page BYO Runtime strip. Could be a dedicated section on the home, a `/integrations` subpage, or a docs page.

### Format options
- **Option 1: Logo grid** — recognizable logos (Braintrust, Langfuse, OpenAI evals, Patronus, Maxim, Vellum, Humanloop, Arize Phoenix), each clickable to a docs page.
- **Option 2: Integration tiles** — each runtime gets a card with logo + one-line description + setup time + "Get started" link.
- **Option 3: Decision helper** — a short questionnaire ("are you starting fresh? do you have an existing runtime?") that points the visitor at the right integration.
- **Option 4: API / SDK reference** — for teams running custom eval infra; show the data contract so they can self-integrate.

### Content beats to cover
- *We don't replace your eval runtime — we generate the evals it runs.*
- Compatible runtimes (list).
- Compatible LLM providers (OpenAI, Anthropic, Google, etc.).
- MCP support (if relevant).
- Custom integration via API.

### Needs fleshing out
- Which integrations actually exist today vs. roadmap.
- Setup instructions for each.
- Docs links.
- Whether this is a section or a subpage.

---

## H. Use cases / by scenario **[needs fleshing out]**

> Concrete examples of NS in different product types. Helps visitors match their use case to a path. Could be a section, subpage, or carousel.

### Scenario candidates
- **RAG-based assistant** — knowledge retrieval, customer support, internal search.
- **Multi-step agent** — booking flows, research agents, tool-using agents.
- **Customer-facing chat** — sales, support, conversational UX.
- **Structured extraction** — JSON output, classification, document parsing.
- **Code generation** — assistance, code review, refactoring.
- **Voice / multimodal** — transcription, audio analysis, image-to-text.

### Format options
- **Option 1: Card grid** with icon + scenario name + one-line "what changes" copy.
- **Option 2: Featured scenario** — pick one (e.g., RAG assistant) and walk through end-to-end with a worked example. Higher trust, narrower appeal.
- **Option 3: Scenario carousel** — three or four scenarios cycling through, each with a sample charter / sample scorer.

### Needs fleshing out
- Which scenarios to feature first.
- Sample charters / scorers / datasets for each (these become marketing assets *and* product seed data).
- Any customer permission for using their use case as a featured example.

---

## I. Pricing **[needs fleshing out]**

### Strategy options
- **Option 1: Public tiered pricing** (free / team / enterprise) — most transparent, helps self-serve buyers.
- **Option 2: Hide pricing** (book a demo for pricing) — common for early-stage B2B with custom enterprise deals.
- **Option 3: Mixed** — public starter tier, custom enterprise pricing.

### Tier sketch (placeholder)
- **Free / explorer** — limited datasets, single skill, community support.
- **Team** — multiple skills, larger datasets, integrations, priority support.
- **Enterprise** — SOC2, SSO, custom integrations, dedicated support.

### Needs fleshing out
- Actual pricing (number per tier).
- What's included at each tier.
- Free trial terms.
- Comparison table.
- Whether pricing lives on the home page or its own `/pricing` page.

---

## J. About / Founder note **[needs fleshing out]**

### Format options
- **Option 1: One-line founder note** at the bottom of the page or in the final CTA — *"Hi, I'm [name]. I'm building this because [reason]. Would love to talk to teams who care about getting AI right."*
- **Option 2: Full About page** — founder story, team, mission, values.
- **Option 3: Mission statement section** — short paragraph on the home page about why NS exists.

### Content beats (when fleshing out)
- Why now — agentic engineering era, the gap nobody owns.
- Who's building this — founder background, team.
- Why charters specifically — the strategic insight.

### Needs fleshing out
- Founder name, photo, bio.
- Story / motivation.
- Team page if going that route.

---

## K. Resources / Documentation / Blog **[needs fleshing out]**

> Long-form content for SEO, trust, and depth.

### Components
- **Documentation** — technical docs, getting started, API reference, integration guides.
- **Blog** — long-form posts on charters, evals, agentic engineering, customer stories.
- **Changelog** — recent product updates.
- **Community** — Slack/Discord/forum, if relevant.

### Format options
- **Option 1: Docs link in footer only** — minimal, defers all content to a separate `/docs`.
- **Option 2: Resources hub** — `/resources` landing page with blog, docs, community sections.
- **Option 3: Featured posts on home** — three latest articles teased on the home page.

### Needs fleshing out
- Blog post topics (suggestion: start with the strategic frame essay — *"The upstream gap nobody owns"*).
- Docs structure.
- Content cadence.

---

## L. Customer logos / Social proof **[needs fleshing out — for later]**

### Format options
- **Option 1: Logo strip** — recognizable customer logos in a row.
- **Option 2: Testimonial pull quotes** — short quotes from named customers with attribution.
- **Option 3: Case studies** — full customer story with metrics, linked from a `/customers` page.
- **Option 4: None yet** — placeholder until you have customers willing to be featured publicly.

### Needs fleshing out
- Any customer permission for public reference.
- Metrics that would land in case studies (cycles per week, regressions caught, time-to-first-eval).

---

## M. Compliance / Security **[needs fleshing out — for regulated audiences]**

### Components
- SOC2 status, GDPR posture, HIPAA if relevant.
- Data handling policy (where prompts go, retention, deletion).
- Privacy policy.
- Terms of service.

### Format options
- **Option 1: Trust center page** — combined compliance + security + privacy.
- **Option 2: Footer links only** — separate privacy / terms / security pages.
- **Option 3: Inline FAQ entry** — basic info in the FAQ, full pages linked from there.

### Needs fleshing out
- Actual compliance status (SOC2 in progress? completed?).
- Data handling specifics.
- Whether this earns a section on the home page or lives in footer/docs.

---

## N. Diagnose deep-dive **[needs fleshing out — pending product capability]**

> The *diagnose-don't-just-measure* message currently lives only as the closing line of USP #6 (*"Implement your scorers in your runtime; when scores drop, you'll know where to look."*). If/when NS develops layer-level diagnosis (prompt vs. model vs. retrieval vs. tools vs. scorers), this could become its own section.

### Content beats (when product is ready)
- *When evals fail, the fix isn't always the prompt.*
- The five layers (prompt, model, retrieval, tools, scorers).
- How NS determines which layer is most likely responsible.
- Worked example showing a regression traced to retrieval rather than the prompt.

### Needs fleshing out
- Whether NS actually does layer-level diagnosis today (we previously concluded it does not, fully — Option B in Section 5 production tab acknowledged this).
- If diagnosis is on the roadmap, when it ships and how prominent the claim should be on the page.

---

## O. Manifesto / Why now (long-form) **[needs fleshing out — optional]**

> The kicker (*THE EVAL LAYER FOR AGENTIC ENGINEERING*) and the Karpathy quote do most of the philosophical work on the home page. A long-form manifesto could expand for visitors who want the full thinking.

### Format options
- **Option 1: Standalone essay** — a `/why` or `/manifesto` page with the long-form argument (the four-step decomposition, the six positioning arguments, the agentic engineering frame).
- **Option 2: Blog post** — same content, just published as a blog entry.
- **Option 3: Skip** — let the home page carry the philosophy; deeper readers go to docs.

### Needs fleshing out
- Whether this is worth writing now or later.
- Who writes it (founder voice).
- Where it lives.

---

# Diagrams inventory

- **Hero diagram** — Dual-cycle Venn ✅ in place
- **Specify tab diagram** — Linear chain with backfill + improve ✅ in place
- **Detect tab diagram** — Linear chain, production version ⏳ needs design

---

# Pithy versions for marketing / sales / blog

- *Define what good looks like — then measure against it.*
- *Prod evals tell you when something is wrong. They don't tell you what right looks like. Charters do.*
- *Same product. Prototype to production.*
- *Don't be surprised twice.*
- *No matter where you are at, we'll help you get to production safe.*

---

# Architecture notes

### Home + subpage split (proposed, build single-page first)
- **Home:** manifesto + invitation. Each section does one move and hands off.
- **Subpages:**
  - `/loop` — full Specify / Detect tabs and details
  - `/data` — full dataset deep-dive
- **Recommendation:** ship single-page first, design with the split in mind, lift to subpages later.

---

# Strategic rationale (internal — not on the page)

### The four-step decomposition

| Step | What it is | Industry coverage |
|---|---|---|
| 1. Define good | Goal/story grounding | Almost no one |
| 2. Ground it in goals | Goal/story grounding | Almost no one |
| 3. Set a benchmark | BYO dataset / synth / pre-prod evals | Most tools |
| 4. Improve against it | Run → score → iterate loop | Most tools |

NS owns steps 1 and 2 — the upstream gap. Steps 3 and 4 are increasingly commoditized.

### Six positioning arguments
- **You can't trace what doesn't exist.** Most AI features are pre-launch; the bottleneck is "what does good look like?", not "what's happening in prod?"
- **Prod evals detect; charters specify.** A trace tells you something happened — not whether it should have.
- **Cold-start.** "Auto-generate eval cases from production failures" only helps teams that already have prod traffic.
- **Selection bias.** Traces show what users do, not what they needed; pre-prod stress-tests what prod data systematically under-represents.
- **Compliance gating.** In regulated domains, pre-launch evidence against a spec is the gate.
- **Field convergence on rubrics.** A rubric is by definition pre-prod; nobody currently owns where the spec comes from.

---

# Pending decisions

- **Section 2 manifesto body:** where exactly does it live — between subtitle and USP grid, or as a separate block?
- **Section 4 Karpathy:** rotating slider with multiple quotes? Which quotes?
- **Section 6 Detect tab:** content from drafts above, plus production diagram TBD.
- **Charter section:** *Rot* vs. *Freshness* on the public site (app uses *Rot*); whether the subpage adopts the five-category framework or keeps the four-dimension lens.
- **Section A (data deep-dive):** keep on home, move to subpage, or delete (Section 2 USP #2 carries enough)?
- **Sections C–F:** which to ship in v1, which to defer.
- **Final CTA / footer:** TBD.
