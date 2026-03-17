# User Stories
**Charter generation agent — eval-driven development platform**

*What users need the agent to do, in their own terms.*

---

## Primary user: product manager or business owner building on AI

### Define what "good" looks like
As a PM, I want to define what a good AI output looks like for my feature — in terms I can evaluate myself — so I'm not dependent on a developer to tell me if the AI is working.

**Why this is important:** if only devs can evaluate output quality, product has no agency over improvement.

---

### Know if my charter is good enough
As a PM, I want to know whether my charter is specific enough before I invest in building a dataset — so I don't build on a weak foundation.

**Why this is important:** a vague charter produces a dataset that produces misleading evals. The mistake is expensive to catch late.

---

### Get there without knowing what a charter is
As a business owner with no eval experience, I want to be guided to a good charter through a conversation — so I don't need to understand the methodology to benefit from it.

**Why this is important:** the product only works if non-technical people can use it without a learning curve.

---

### Understand why the AI is failing
As a PM, I want to see specifically where my AI is falling short against my criteria — not just a score — so I know what to fix.

**Why this is important:** a score without a reason produces no action.

---

### Keep the charter current
As a PM, I want to update my charter when the product changes — and understand which dataset examples are now stale — so my evals don't drift from reality.

**Why this is important:** an outdated charter is worse than no charter — it measures the wrong thing with false confidence.

---

### Compare versions
As a PM, I want to know whether a change to my AI was an improvement against my charter — so iteration is evidence-based, not opinion-based.

**Why this is important:** without comparison, you can't learn from changes.

---

## Secondary user: developer building or improving the AI pipeline

### Know what to build toward
As a developer, I want a precise spec for what good output looks like — so I have a target, not a vague goal.

**Why this is important:** developers currently guess what product wants. The charter replaces the guess.

---

### Know if a change was an improvement
As a developer, I want to run evals before and after a change and see the delta — so I can ship with confidence.

**Why this is important:** without evals, shipping is guessing.
