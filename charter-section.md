## The charter **[draft — refined]**

> Replaces the home-page version of the charter section. The five categories below are the actual structure of a North Star charter (with *Rot* renamed to *Freshness* for marketing). Definitions are paraphrased from the in-app descriptions, kept generic and one-line where possible.

### Headline
- *The charter.*

### Subtitle
- *Your AI feature's success criteria, organized across five categories.*

### Body
- A charter pins down what your AI feature should do — specifically enough that a system can grade against it.
- It's structured around five categories. Each one names a different way "good" usually goes wrong without a written-down spec.

### The five categories

#### Coverage
- The distinct scenarios, edge cases, and user intents your feature needs to handle.
- *Without it, whole categories of input go untested.*

#### Balance
- How weight is distributed across those scenarios.
- *Without it, easy cases get over-represented and hard ones get drowned out.*

#### Alignment
- What good output and bad output look like, feature by feature.
- *Without it, "on-spec" and "on-brand" stay subjective — and the AI guesses.*

#### Safety
- The rules the output must obey — refusals, privacy, harmful actions, destructive commands.
- *Without it, the lines that must not be crossed stay implicit.*

#### Freshness
- The conditions that signal your charter has gone stale — new features, changed requirements, updated models.
- *Without it, your charter ages out of sync with the product.*

### Visual (recommended)
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

### Closing line
- *Five categories. Every line in your charter earns its place under one.*

### CTA
- `[ See how charters work → ]` — links to `/charter` subpage.

### Open decisions
- **Naming.** Renamed *Rot* → *Freshness* for the public site. *Rot* names the failure mode; *Freshness* names the property. *Freshness* may be safer; *Rot* is more memorable. Worth one A/B with people outside the team.
- **Order.** Currently Coverage → Balance → Alignment → Safety → Freshness. Reads as: *what to test → how much of each → what answers look like → what's forbidden → when to refresh*. Could lead with *Alignment* if "good vs bad output" is the more intuitive entry point for a first-time visitor.
- **Tie back to the four questions.** Soft connection only ("a different way good usually goes wrong") — the categories aren't a 1:1 mirror of right/safe/consistent/sustainable, so forcing the mapping would mislead. Acceptable, or should the body make the relationship explicit?
- **Length.** Each category has a single-line definition + a *without it* italic clause. The italics could be cut for a tighter section if the visual snippet does enough work alone.
