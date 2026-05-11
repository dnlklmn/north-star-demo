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
  A,
} from "../../components/docs/Prose";

const BACKEND_SETUP = `cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e .
cp .env.example .env  # then edit
uvicorn app.main:app --port 8080 --reload`;

const FRONTEND_SETUP = `cd frontend
npm install --legacy-peer-deps
npm run dev`;

const DB_SETUP = `# PostgreSQL must be running locally
createdb northstar
# DATABASE_URL=postgresql://localhost:5432/northstar`;

const TYPECHECK = `cd frontend
npx tsc --noEmit`;

export default function GettingStarted() {
  return (
    <DocsLayout>
      <Prose>
        <H1>Getting started</H1>
        <Lede>
          Get the stack running locally, then walk through the three project
          types.
        </Lede>

        <H2 id="prereqs">Prerequisites</H2>
        <UL>
          <LI>Python 3.11+</LI>
          <LI>Node 20+</LI>
          <LI>PostgreSQL running locally</LI>
          <LI>
            An Anthropic API key — or an OpenRouter key (auto-detected by
            the <Code>sk-or-</Code> prefix). One of the two is required.
          </LI>
        </UL>

        <H2 id="setup">Setup</H2>

        <H3>1. Database</H3>
        <CodeBlock language="bash">{DB_SETUP}</CodeBlock>

        <H3>2. Backend</H3>
        <CodeBlock language="bash">{BACKEND_SETUP}</CodeBlock>
        <P>
          The first request to the API runs idempotent migrations from{" "}
          <Code>db.py:init_db</Code> — there's no separate migrate step.
        </P>

        <H3>3. Frontend</H3>
        <CodeBlock language="bash">{FRONTEND_SETUP}</CodeBlock>
        <P>
          Vite serves on <Code>:5173</Code> and proxies API calls to{" "}
          <Code>:8080</Code>. Open{" "}
          <Code>http://localhost:5173</Code> when both are running.
        </P>

        <H2 id="env">Environment variables</H2>
        <Table>
          <THead>
            <TR>
              <TH>Variable</TH>
              <TH>Required</TH>
              <TH>Purpose</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>
                <Code>DATABASE_URL</Code>
              </TD>
              <TD>yes</TD>
              <TD>
                <Code>postgresql://localhost:5432/northstar</Code>
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>ANTHROPIC_API_KEY</Code>
              </TD>
              <TD>one of</TD>
              <TD>Claude API key. Takes priority when both are set.</TD>
            </TR>
            <TR>
              <TD>
                <Code>OPENROUTER_API_KEY</Code>
              </TD>
              <TD>one of</TD>
              <TD>
                OpenRouter key — auto-detected by <Code>sk-or-</Code>{" "}
                prefix. Used only when <Code>ANTHROPIC_API_KEY</Code> is
                unset.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>BRAINTRUST_API_KEY</Code>
              </TD>
              <TD>for evals</TD>
              <TD>
                Can also be entered in the Evaluations tab and stored in
                localStorage.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>MODEL_NAME</Code>
              </TD>
              <TD>no</TD>
              <TD>
                Default <Code>claude-sonnet-4-20250514</Code>.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>EVAL_MODEL</Code>
              </TD>
              <TD>no</TD>
              <TD>
                Model used for the eval task function. Default{" "}
                <Code>claude-opus-4-7</Code>.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>JUDGE_MODEL</Code>
              </TD>
              <TD>no</TD>
              <TD>
                Model used for LLM-as-judge scorers. Default{" "}
                <Code>claude-sonnet-4-20250514</Code>.
              </TD>
            </TR>
          </TBody>
        </Table>
        <P>
          The full env-var list — including production-monitoring keys —
          lives in <A to="/docs/reference#env">Reference → Environment</A>.
        </P>
        <Callout tone="tip" title="Per-request keys">
          The frontend can send <Code>X-Anthropic-Key</Code> /{" "}
          <Code>X-Braintrust-Key</Code> headers pulled from localStorage. A
          user can paste their own key in Settings and run without any
          server-side credential.
        </Callout>

        <H2 id="first-skill">Your first skill eval</H2>
        <OL>
          <LI>
            From <Strong>Home</Strong>, click the dropdown next to{" "}
            <Strong>New project</Strong> → <Strong>New skill eval</Strong>.
          </LI>
          <LI>
            Paste a SKILL.md (or a GitHub URL pointing at one). Frontmatter
            is auto-parsed.
          </LI>
          <LI>
            Click <Strong>Analyze</Strong>. The backend runs{" "}
            <Code>call_skill_seed</Code> — one LLM call that extracts goals,
            user roles, positive + off-target stories, and a task
            description.
          </LI>
          <LI>
            You land on the <Strong>Goals</Strong> tab. Review what was
            extracted; jump to other tabs to edit.
          </LI>
          <LI>
            On <Strong>Charter</Strong>, click <Strong>Generate draft</Strong>
            . The agent fills in Coverage, Balance, Alignment, Rot, Safety
            (and validates).
          </LI>
          <LI>
            On <Strong>Dataset</Strong>, click{" "}
            <Strong>Synthesize examples</Strong>. The agent emits rows
            covering positive scenarios, off-target routing, and adversarial
            safety probes.
          </LI>
          <LI>
            On <Strong>Scorers</Strong>, click <Strong>Generate scorers</Strong>
            . You'll get one Python LLM-as-judge per alignment, coverage, and
            safety criterion.
          </LI>
          <LI>
            On <Strong>Evaluations</Strong>, paste a Braintrust key (if not
            in env) and click <Strong>Run eval</Strong>. The run queues, then
            polls every 2s until terminal.
          </LI>
          <LI>
            Read the failures in the right rail. Click{" "}
            <Strong>Suggest improvements</Strong>. Accept the edits you like.
          </LI>
          <LI>
            Save as v+1. <Strong>Run evaluations</Strong> button appears —
            click it to compare against the previous run.
          </LI>
        </OL>

        <H2 id="first-prompt">Your first prompt eval</H2>
        <P>
          Same flow as above, but the dropdown choice is{" "}
          <Strong>New prompt eval</Strong>. You paste a prompt body and a
          target name (e.g. <Code>generate_draft</Code>). The session
          inherits the same charter / dataset / scorers / eval pipeline,
          but the eval task function uses the prompt directly rather than a
          SKILL.md system prompt.
        </P>

        <H2 id="first-scratch">Your first scratch project</H2>
        <P>
          Click <Strong>New project</Strong> directly (no dropdown). The
          session has no skill body or prompt. You land on the{" "}
          <Strong>Goals</Strong> tab with the conversational agent
          (Polaris) ready to ask questions.
        </P>
        <UL>
          <LI>
            One question per turn. Goals first; then users; then stories.
          </LI>
          <LI>
            Click <Strong>Proceed</Strong> when the agent thinks the phase is
            sufficient — or override and advance manually via the phase
            controls.
          </LI>
          <LI>
            Once stories are filled, the rest of the tabs unlock and the
            flow rejoins the skill-first path.
          </LI>
        </UL>

        <H2 id="dev-tasks">Common dev tasks</H2>

        <H3>Type-check the frontend</H3>
        <CodeBlock language="bash">{TYPECHECK}</CodeBlock>

        <H3>Lint</H3>
        <CodeBlock language="bash">{`cd frontend && npm run lint`}</CodeBlock>
        <P>
          ESLint is a hard CI gate — see <Code>frontend/eslint.config.js</Code>
          .
        </P>

        <H3>Run a Braintrust eval from the CLI</H3>
        <CodeBlock language="bash">{`# from the backend venv, after seeding a session:
python evals/run_eval.py --session-id <uuid> --project my-skill-eval`}</CodeBlock>
        <P>
          The CLI and the UI's <Code>/run-eval</Code> endpoint share the same
          implementation in <Code>backend/app/eval_runner.py</Code> — runs
          are identical.
        </P>
      </Prose>
    </DocsLayout>
  );
}
