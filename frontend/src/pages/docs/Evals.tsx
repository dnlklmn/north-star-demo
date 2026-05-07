import DocsLayout from "../../components/docs/DocsLayout";
import CodeBlock from "../../components/docs/CodeBlock";
import Callout from "../../components/docs/Callout";
import { Table, THead, TBody, TR, TH, TD } from "../../components/docs/Table";
import {
  Prose,
  H1,
  H2,
  H3,
  Lede,
  P,
  OL,
  UL,
  LI,
  Code,
  Strong,
  HR,
} from "../../components/docs/Prose";

const CLI = `# from the backend venv, after seeding a session:
python evals/run_eval.py --session-id <uuid> --project my-skill-eval`;

const ITERATE = `# inspect what's there
python -m backend.app.online_scorers list

# pull the prompt body
python -m backend.app.online_scorers show charter_quality

# dry-run against a real Braintrust trace's I/O before pushing
echo '{"input": "...", "output": "..."}' | \\
    python -m backend.app.online_scorers test charter_quality`;

const PUBLISH = `python -m backend.app.online_scorers publish <session_id>

# or only a subset by name:
python -m backend.app.online_scorers publish <session_id> alignment_positive_vs_offtarget_separation,coverage_wellformed_complete_sections`;

export default function Evals() {
  return (
    <DocsLayout>
      <Prose>
        <H1>Evals & monitoring</H1>
        <Lede>
          The eval harness, the CLI, and how the same machinery powers
          production monitoring of North Star itself via Braintrust online
          scorers.
        </Lede>

        <H2 id="harness">Eval harness</H2>
        <P>
          <Code>evals/run_eval.py</Code> is the standalone CLI. The
          backend's <Code>/run-eval</Code> endpoint invokes the same shared
          module (<Code>backend/app/eval_runner.py</Code>), so CLI and UI
          runs are guaranteed identical.
        </P>
        <CodeBlock language="bash">{CLI}</CodeBlock>
        <P>
          See <Code>evals/README.md</Code> for the full CLI reference.
        </P>

        <H3>What a run does, step by step</H3>
        <OL>
          <LI>
            Compiles scorer source code into callable Python (injects a{" "}
            <Code>call_judge</Code> helper).
          </LI>
          <LI>
            Filters the dataset (<Code>review_status=approved</Code>; skips{" "}
            <Code>should_trigger=false</Code> rows unless you opt in).
          </LI>
          <LI>
            For each row, calls Claude with SKILL.md as system prompt via{" "}
            <Code>braintrust.wrap_anthropic</Code>.
          </LI>
          <LI>
            Runs each scorer against{" "}
            <Code>(output, input, expected)</Code>. Captures judge
            reasoning into scorer metadata.
          </LI>
          <LI>
            Streams results into Braintrust + the <Code>per_row</Code>{" "}
            JSONB column on <Code>eval_runs</Code>.
          </LI>
          <LI>
            Persists status, scorer averages, charter snapshot, and skill
            version id alongside the run.
          </LI>
        </OL>

        <Callout tone="tip" title="Why snapshots?">
          Each run captures a full <Code>charter_snapshot</Code> +{" "}
          <Code>skill_version_id</Code> at queue time. So when you look at
          a 3-week-old run, the "View charter" link shows you the exact
          spec used — not whatever's live now.
        </Callout>

        <HR />

        <H2 id="prod-monitoring">Production monitoring</H2>
        <P>
          North Star uses Braintrust to monitor itself in production — same
          harness as offline evals, separate project. When{" "}
          <Code>BRAINTRUST_PROD_API_KEY</Code> is set, every Anthropic call
          goes through <Code>braintrust.wrap_anthropic</Code> and lands in
          the <Code>north-star-prod</Code> project as a trace span with
          metadata: <Code>session_id</Code>, <Code>phase</Code>,{" "}
          <Code>turn_type</Code>, <Code>turn_number</Code>,{" "}
          <Code>model_name</Code>.
        </P>

        <H3>One-time setup in the Braintrust UI</H3>
        <OL>
          <LI>
            <Strong>Create the project.</Strong> Generate a project-scoped
            API key → set as <Code>BRAINTRUST_PROD_API_KEY</Code> in your
            prod env.
          </LI>
          <LI>
            <Strong>Configure online scorers.</Strong> For each prompt in{" "}
            <Code>backend/app/scorers/*.md</Code>: create a scorer, paste
            the body from <Code>online_scorers show &lt;name&gt;</Code>,
            apply the trigger filter from{" "}
            <Code>online_scorers list</Code>, set the model, apply the
            sample rate from frontmatter.
          </LI>
          <LI>
            <Strong>Build dashboards.</Strong> Charter overall + per
            dimension; cost per session; latency per phase; error rate per
            phase; funnel of how many sessions reach each phase.
          </LI>
          <LI>
            <Strong>Alerts.</Strong> Defer thresholds until you have a week
            of baseline. Recommended starting alerts: charter score &lt; 70%
            in 24h, p95 latency &gt; 30s in 1h, error rate &gt; 5% in 1h.
          </LI>
        </OL>

        <H3 id="online-scorers">Online scorers</H3>
        <P>
          The four scorers shipping with North Star:
        </P>
        <Table>
          <THead>
            <TR>
              <TH>Scorer</TH>
              <TH>Default model</TH>
              <TH>Filter</TH>
              <TH>Sample</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>
                <Code>charter_quality</Code>
              </TD>
              <TD>Sonnet</TD>
              <TD>
                <Code>turn_type = "generate_draft"</Code>
              </TD>
              <TD>every trace</TD>
            </TR>
            <TR>
              <TD>
                <Code>goal_extraction_quality</Code>
              </TD>
              <TD>Haiku</TD>
              <TD>
                <Code>turn_type = "discovery"</Code> AND{" "}
                <Code>phase = "goals"</Code>
              </TD>
              <TD>every trace</TD>
            </TR>
            <TR>
              <TD>
                <Code>conversation_quality</Code>
              </TD>
              <TD>Haiku</TD>
              <TD>
                <Code>turn_type = "discovery"</Code> AND{" "}
                <Code>phase IN ("goals","users","stories")</Code>
              </TD>
              <TD>1 in 5</TD>
            </TR>
            <TR>
              <TD>
                <Code>skill_seed_quality</Code>
              </TD>
              <TD>Sonnet</TD>
              <TD>
                <Code>turn_type = "skill_seed"</Code>
              </TD>
              <TD>every trace</TD>
            </TR>
          </TBody>
        </Table>

        <H3>Iterating on a scorer</H3>
        <CodeBlock language="bash">{ITERATE}</CodeBlock>
        <P>
          The prompts live in code so changes go through normal review.
          The Braintrust UI references these prompts manually — automated
          push is a future hook once the Braintrust online-scorer API
          stabilizes.
        </P>

        <H3>Publishing a project's generated scorers</H3>
        <P>
          When you run <Code>/generate-scorers</Code> on a North Star
          project, the LLM emits Python scorers stored on{" "}
          <Code>state.scorers</Code>. Each one is also written as both a{" "}
          <Code>.py</Code> (for offline evals) and a <Code>.md</Code> (for
          Braintrust online scorers) under{" "}
          <Code>backend/app/scorers/generated/&lt;scope&gt;/</Code>. The{" "}
          <Code>.md</Code> form is what you paste into the Braintrust UI.
        </P>
        <P>
          For projects generated <em>before</em> this bridge existed — or
          to re-emit after editing the generation prompt — backfill with:
        </P>
        <CodeBlock language="bash">{PUBLISH}</CodeBlock>
        <P>
          The CLI prints the trace filter to use when attaching each
          scorer in the Braintrust UI (for prompt-eval projects this is{" "}
          <Code>metadata.turn_type = "&lt;prompt_target&gt;"</Code>).
        </P>

        <HR />

        <H2 id="future">Future hooks</H2>
        <P>Discussed but not built. Listed roughly by value / effort:</P>
        <UL>
          <LI>
            <Strong>Claude Agent SDK integration.</Strong> Today the eval's{" "}
            <Code>task()</Code> calls the bare Anthropic Messages API with
            SKILL.md as a system prompt. This tests instruction-following
            but bypasses tool calls and routing. Wiring the Agent SDK
            would let the eval load the skill by description, allow tool
            calls, and capture real artifacts. Estimated scope: ~1 week.
            Required for tool-using skills to be properly evaluated.
          </LI>
          <LI>
            <Strong>Two-way connectors.</Strong> Today connectors export
            datasets + scorers to Braintrust / skill-creator. Two-way
            means production telemetry (thumbs, edits, escalations) feeds
            back into the charter and dataset.
          </LI>
          <LI>
            <Strong>Runtime safety dimension.</Strong> Today Safety scores
            output-level violations. Runtime safety (did the skill call a
            disallowed domain, did it write outside an allowed path)
            requires the Agent SDK integration above.
          </LI>
        </UL>
      </Prose>
    </DocsLayout>
  );
}
