import DocsLayout from "../../components/docs/DocsLayout";
import CodeBlock from "../../components/docs/CodeBlock";
import {
  Prose,
  H1,
  H2,
  Lede,
  P,
  UL,
  LI,
  Code,
  Strong,
  A,
} from "../../components/docs/Prose";

const LOOP_DIAGRAM = `           ┌──────────────────┐
           │   SKILL.md v1    │◄──────── Iterate ─────────┐
           └────────┬─────────┘                            │
                    │ paste                                │
                    ▼                                      │
           ┌──────────────────┐                            │
           │  Skill seed      │  one-shot extraction       │
           │  goals · users · │                            │
           │  pos+off-target  │                            │
           │  stories · task  │                            │
           └────────┬─────────┘                            │
                    ▼                                      │
           ┌──────────────────┐                            │
           │    Charter       │  Coverage · Balance ·      │
           │                  │  Alignment · Rot · Safety  │
           └────────┬─────────┘                            │
                    ▼                                      │
           ┌──────────────────┐                            │
           │    Dataset       │  inputs · expected ·       │
           │                  │  should_trigger · adversarial
           └────────┬─────────┘                            │
                    ▼                                      │
           ┌──────────────────┐                            │
           │    Scorers       │  per-alignment / coverage /│
           │                  │  safety LLM-as-judge       │
           └────────┬─────────┘                            │
                    ▼                                      │
           ┌──────────────────┐                            │
           │  Evaluations     │  on Braintrust ·           │
           │                  │  scores + traces + deltas  │
           └────────┬─────────┘                            │
                    ▼                                      │
           ┌──────────────────┐                            │
           │    Improve       │  edits → SKILL.md v+1 ─────┘
           └──────────────────┘`;

export default function Overview() {
  return (
    <DocsLayout>
      <Prose>
        <H1>North Star</H1>
        <Lede>
          Eval-driven development for Claude Code skills, prompts, and
          AI features. Define what good looks like — then measure it.
        </Lede>

        <P>
          Most eval workflows start with a dataset or a scorer. North Star
          starts earlier: <Strong>what does this AI feature actually need to do, and
          what should it stay out of?</Strong> It turns a SKILL.md (or a prompt, or
          a guided conversation) into a charter — the quality spec — then a
          golden dataset, executable scorers, and an end-to-end eval harness
          that runs on Braintrust. Then it closes the loop: read the failures,
          propose edits, save a new version, run again, compare deltas.
        </P>

        <P>
          Every step is visible, editable, and reversible. You never have to
          run an LLM call you can't inspect.
        </P>

        <H2>The loop</H2>
        <CodeBlock>{LOOP_DIAGRAM}</CodeBlock>

        <H2>Where to start</H2>
        <UL>
          <LI>
            <A to="/docs/concepts">Concepts</A> — eval-driven development,
            charter dimensions, triggered vs scratch mode.
          </LI>
          <LI>
            <A to="/docs/getting-started">Getting started</A> — set up the
            backend + frontend, then walk through your first skill eval.
          </LI>
          <LI>
            <A to="/docs/workspace">Workspace tour</A> — what each tab does,
            what data it produces, what knobs you turn.
          </LI>
          <LI>
            <A to="/docs/agent">Agent internals</A> — how prompts, LLM calls,
            and control flow are split across the codebase.
          </LI>
          <LI>
            <A to="/docs/evals">Evals & monitoring</A> — the eval harness, the
            CLI, Braintrust integration, online scorers in production.
          </LI>
          <LI>
            <A to="/docs/reference">Reference</A> — API endpoints, database
            schema, environment variables, file map, ideal-use guide.
          </LI>
        </UL>

        <H2>Two workflows</H2>
        <P>
          <Strong>Skill-first (primary).</Strong> Paste a SKILL.md from the New
          skill eval modal. The backend extracts goals, user roles, positive
          and off-target stories, and a task description in one LLM call. You
          land on the Goals tab and walk forward through Charter → Scorers →
          Dataset → Evaluations → Improve.
        </P>
        <P>
          <Strong>Start from scratch (secondary).</Strong> Skip the modal and
          create an empty project. The agent guides you through three
          discovery phases (goals, users, stories) one question per turn,
          extracts items from the conversation, and only then opens up the
          downstream tabs. Useful for evaluating prompts or non-skill AI
          features.
        </P>

        <H2>What it's not</H2>
        <UL>
          <LI>
            Not a runtime monitor. North Star is an authoring + iteration
            tool. For prod monitoring, wire Braintrust or Langfuse directly
            into your app and consume North Star's dataset as a seed.
          </LI>
          <LI>
            Not for deterministic pass/fail evals. If "good" is measured by
            tests that compile or queries that return the right rows, an
            LLM-as-judge charter is overkill.
          </LI>
          <LI>
            Not (yet) a fit for tool-using skills that produce file
            artifacts — the eval task() runs bare Claude, so multi-step tool
            calls don't materialise. See{" "}
            <A to="/docs/reference#use-cases">use-case fit</A> for details.
          </LI>
        </UL>

        <P>
          Source: <Code>github.com/anthropics/north-star</Code>. AI-coding
          conventions live in <Code>CLAUDE.md</Code> at the repo root.
        </P>
      </Prose>
    </DocsLayout>
  );
}
