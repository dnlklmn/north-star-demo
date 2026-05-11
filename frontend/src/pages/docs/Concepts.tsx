import DocsLayout from "../../components/docs/DocsLayout";
import Callout from "../../components/docs/Callout";
import CodeBlock from "../../components/docs/CodeBlock";
import { Table, THead, TBody, TR, TH, TD } from "../../components/docs/Table";
import {
  Prose,
  H1,
  H2,
  H3,
  Lede,
  P,
  UL,
  LI,
  Code,
  Strong,
  A,
} from "../../components/docs/Prose";

export default function Concepts() {
  return (
    <DocsLayout>
      <Prose>
        <H1>Concepts</H1>
        <Lede>
          The mental model behind North Star. Read this before diving into
          the workspace tour.
        </Lede>

        <H2 id="eval-driven">Eval-driven development</H2>
        <P>
          The premise is simple: <Strong>you don't ship an AI feature until
          you can measure it</Strong>. Most teams skip this because writing a
          dataset feels lower-leverage than writing prompts. North Star
          inverts that — the charter is the artifact, the dataset is
          downstream of it, and the prompt or skill is what you iterate
          against the eval.
        </P>
        <P>
          This pays off when behavior diverges from intent. The first eval
          run almost always surprises you. Without a dataset and scorers, that
          surprise is invisible until a user files a ticket.
        </P>

        <H2 id="charter">The charter (Coverage / Balance / Alignment / Rot / Safety)</H2>
        <P>
          A charter is a quality specification. It answers five questions
          about a feature, in a form a downstream LLM can use to generate a
          dataset and scorers from.
        </P>
        <Table>
          <THead>
            <TR>
              <TH>Dimension</TH>
              <TH>Question it answers</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>
                <Strong>Coverage</Strong>
              </TD>
              <TD>
                What scenarios should the feature handle? In triggered mode
                this also includes <Code>negative_criteria</Code> — scenarios
                where the skill should explicitly NOT fire.
              </TD>
            </TR>
            <TR>
              <TD>
                <Strong>Balance</Strong>
              </TD>
              <TD>
                What's the desired distribution? Which scenarios get more
                weight; what's the positive-to-negative ratio for triggered
                features.
              </TD>
            </TR>
            <TR>
              <TD>
                <Strong>Alignment</Strong>
              </TD>
              <TD>
                Per feature area, what does good output look like vs bad?
                Stated as observable behavior, not intent.
              </TD>
            </TR>
            <TR>
              <TD>
                <Strong>Rot</Strong>
              </TD>
              <TD>
                Conditions under which the charter itself becomes stale —
                e.g. new user types, model upgrades, scope changes.
              </TD>
            </TR>
            <TR>
              <TD>
                <Strong>Safety</Strong>
              </TD>
              <TD>
                Output-level rules: prompt-injection resistance, credential
                containment, URL allow-list. Triggered mode only.
              </TD>
            </TR>
          </TBody>
        </Table>
        <Callout tone="info" title="Why these five?">
          <P>
            Coverage tells the dataset generator <em>what</em> to make.
            Alignment tells the scorer generator <em>how</em> to grade.
            Balance keeps the distribution honest. Rot is the trip-wire for
            knowing when to revisit the charter. Safety is the carve-out for
            output-level violations that can't be expressed as alignment
            criteria. Together they are sufficient — and minimal — for the
            downstream artefacts to be generatable.
          </P>
        </Callout>

        <H2 id="modes">Triggered vs scratch mode</H2>
        <P>
          North Star supports two project modes. The mode determines which
          prompts run, which dataset shapes get generated, and what the
          charter looks like.
        </P>
        <H3>Triggered mode</H3>
        <P>
          For Claude Code skills with a description-based router. The skill
          can either fire (good) or not fire (also good, when the user's
          message is off-topic). North Star captures both:
        </P>
        <UL>
          <LI>
            <Strong>Positive stories</Strong> — when the skill should fire.
          </LI>
          <LI>
            <Strong>Off-target stories</Strong> — when the skill should NOT
            fire. These become the negative-coverage criteria.
          </LI>
          <LI>
            Dataset rows carry <Code>should_trigger: true | false</Code>.
            Reviewers see two verdicts per row: routing correctness
            (did it fire when it should) and execution quality (was the output
            good once it did fire).
          </LI>
        </UL>
        <H3>Scratch mode</H3>
        <P>
          Skill-less. The agent guides you through three discovery phases —
          goals, then users, then stories — extracting items from the
          conversation. Use this for prompts, RAG features, or any AI feature
          that doesn't have a SKILL.md.
        </P>

        <H2 id="lineage">Skill versions and lineage</H2>
        <P>
          The Skill tab keeps an append-only history of SKILL.md versions
          (<Code>skill_versions[]</Code>). One is marked active. Every
          downstream artifact stamps which version it was generated against
          (<Code>generated_at_skill_version</Code>). When the active version
          advances — by save, by accepting Improve suggestions, or by
          restoring an older version — every downstream tab whose stamp
          doesn't match the active version shows a banner with{" "}
          <Strong>Update suggestions</Strong> and{" "}
          <Strong>Regenerate</Strong> buttons.
        </P>
        <P>
          This means you never have to wonder whether your dataset was built
          against the same SKILL.md that produced your last eval run. The
          lineage map answers it.
        </P>

        <H2 id="extraction">Discovery extraction blocks</H2>
        <P>
          In scratch mode the agent uses a custom extraction protocol instead
          of tool calls. The LLM emits fenced code blocks like:
        </P>
        <CodeBlock>{`\`\`\`extraction
{ "type": "goal", "value": "..." }
\`\`\``}</CodeBlock>
        <P>
          The agent parses these out of the response, deduplicates them
          (first-40-char case-insensitive match), and merges them into the
          state. Why blocks instead of tool calls? Because the same response
          carries the assistant's natural-language reply to the user, and
          we'd rather have one round-trip than two.
        </P>

        <H2 id="state-machine">The five-phase state machine</H2>
        <P>
          The agent advances through phases via{" "}
          <Code>POST /sessions/&#123;id&#125;/advance-phase</Code>:
        </P>
        <UL>
          <LI>
            <Code>goals</Code> — extract business goals
          </LI>
          <LI>
            <Code>users</Code> — extract user roles
          </LI>
          <LI>
            <Code>stories</Code> — extract user stories (positive +
            off-target)
          </LI>
          <LI>
            <Code>charter</Code> — generate, validate, refine
          </LI>
          <LI>
            <Code>dataset</Code> — synthesize, judge, gap-analyze, revise
          </LI>
        </UL>
        <P>
          Skill-first projects fast-forward: the seed call extracts all
          three discovery types in one shot, jumping the user straight to
          the Charter step.
        </P>

        <H2 id="optimistic">Optimistic UI + debounced reevaluation</H2>
        <P>
          Edits — to a goal, a story, a charter dimension — apply locally
          first. The agent catches up asynchronously. Charter edits start a
          3-second debounce timer; when it fires, the agent re-validates the
          charter in the background and surfaces fresh weak/fail markers.
          You don't wait for the LLM between keystrokes.
        </P>

        <H2 id="turn-log">Turn logging</H2>
        <P>
          Every LLM interaction is persisted to the <Code>turns</Code> table
          with full input, output, and metadata (phase, turn type, turn
          number, model, latency, token counts). This means:
        </P>
        <UL>
          <LI>You can replay any session deterministically.</LI>
          <LI>
            Online scorers (see{" "}
            <A to="/docs/evals">Evals & monitoring</A>) can grade specific
            turn types as they happen.
          </LI>
          <LI>
            <Code>POST /judge/run</Code> can score a session post-hoc and
            store results in the <Code>judgements</Code> table.
          </LI>
        </UL>
      </Prose>
    </DocsLayout>
  );
}
