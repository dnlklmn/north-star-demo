import DocsLayout from "../../components/docs/DocsLayout";
import AnchorList from "../../components/docs/AnchorList";
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
  HR,
} from "../../components/docs/Prose";

const ANCHORS = [
  { id: "files", label: "File map" },
  { id: "api", label: "API endpoints" },
  { id: "db", label: "Database schema" },
  { id: "env", label: "Environment variables" },
  { id: "use-cases", label: "Use-case fit" },
];

export default function Reference() {
  return (
    <DocsLayout>
      <Prose>
        <H1>Reference</H1>
        <Lede>
          File map, API surface, database schema, environment variables,
          and an honest take on which use cases the project fits today.
        </Lede>

        <AnchorList anchors={ANCHORS} />

        <H2 id="files">File map</H2>
        <Table>
          <THead>
            <TR>
              <TH>Path</TH>
              <TH>Purpose</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>
                <Code>frontend/</Code>
              </TD>
              <TD>React 19 + TypeScript + Tailwind v4 + Vite</TD>
            </TR>
            <TR>
              <TD>
                <Code>backend/app/</Code>
              </TD>
              <TD>FastAPI + Anthropic SDK + asyncpg (PostgreSQL)</TD>
            </TR>
            <TR>
              <TD>
                <Code>backend/app/prompt.py</Code>
              </TD>
              <TD>All prompts. One function per prompt.</TD>
            </TR>
            <TR>
              <TD>
                <Code>backend/app/tools.py</Code>
              </TD>
              <TD>LLM call wrappers — prompt → Claude → Pydantic.</TD>
            </TR>
            <TR>
              <TD>
                <Code>backend/app/agent.py</Code>
              </TD>
              <TD>Control flow only. No prompts, no LLM calls.</TD>
            </TR>
            <TR>
              <TD>
                <Code>backend/app/main.py</Code>
              </TD>
              <TD>FastAPI endpoints + per-request key middleware.</TD>
            </TR>
            <TR>
              <TD>
                <Code>backend/app/models.py</Code>
              </TD>
              <TD>
                Pydantic models — single source of truth for FE + BE
                shapes (mirrored to <Code>frontend/src/types.ts</Code>).
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>backend/app/db.py</Code>
              </TD>
              <TD>
                asyncpg layer + idempotent migrations in{" "}
                <Code>init_db</Code>.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>backend/app/eval_runner.py</Code>
              </TD>
              <TD>
                Shared Braintrust eval logic — used by{" "}
                <Code>/run-eval</Code> and the CLI.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>backend/app/online_scorers.py</Code>
              </TD>
              <TD>CLI for production-monitoring scorers.</TD>
            </TR>
            <TR>
              <TD>
                <Code>backend/app/scorers/</Code>
              </TD>
              <TD>
                LLM-as-judge prompts versioned with code; each <Code>.md</Code>{" "}
                has YAML frontmatter declaring filter + sample rate.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>backend/app/sharing.py</Code>
              </TD>
              <TD>Project sharing via signed tokens.</TD>
            </TR>
            <TR>
              <TD>
                <Code>evals/</Code>
              </TD>
              <TD>Standalone eval CLI.</TD>
            </TR>
          </TBody>
        </Table>

        <HR />

        <H2 id="api">API endpoints</H2>

        <H3>Sessions</H3>
        <UL>
          <LI>
            <Code>POST /sessions</Code>
          </LI>
          <LI>
            <Code>GET /sessions</Code>
          </LI>
          <LI>
            <Code>GET/PATCH/DELETE /sessions/&#123;id&#125;</Code>
          </LI>
          <LI>
            <Code>PATCH /sessions/&#123;id&#125;/name</Code>
          </LI>
          <LI>
            <Code>PATCH /sessions/&#123;id&#125;/input</Code>
          </LI>
          <LI>
            <Code>PATCH /sessions/&#123;id&#125;/mode</Code>
          </LI>
        </UL>

        <H3>Skill</H3>
        <UL>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/skill-seed</Code>
          </LI>
          <LI>
            <Code>GET /sessions/&#123;id&#125;/skill-versions</Code>
          </LI>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/skill-versions</Code>
          </LI>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/skill-versions/restore</Code>
          </LI>
        </UL>

        <H3>Agent (scratch mode + Polaris chat)</H3>
        <UL>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/message</Code>
          </LI>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/advance-phase</Code>
          </LI>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/proceed</Code>
          </LI>
          <LI>
            <Code>PATCH /sessions/&#123;id&#125;/charter</Code>
          </LI>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/validate</Code>
          </LI>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/suggest</Code>
          </LI>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/finalize</Code>
          </LI>
        </UL>

        <H3>Dataset</H3>
        <UL>
          <LI>
            <Code>POST/GET /sessions/&#123;id&#125;/dataset</Code>
          </LI>
          <LI>
            <Code>POST /datasets/&#123;id&#125;/synthesize</Code>
          </LI>
          <LI>
            <Code>POST /datasets/&#123;id&#125;/import</Code>
          </LI>
          <LI>
            <Code>POST /datasets/&#123;id&#125;/review</Code>
          </LI>
          <LI>
            <Code>POST /datasets/&#123;id&#125;/suggest-revisions</Code>
          </LI>
          <LI>
            <Code>GET /datasets/&#123;id&#125;/gaps</Code>
          </LI>
          <LI>
            <Code>POST /datasets/&#123;id&#125;/enrich</Code>
          </LI>
          <LI>
            <Code>POST /datasets/&#123;id&#125;/chat</Code>
          </LI>
          <LI>
            <Code>GET /datasets/&#123;id&#125;/export</Code>
          </LI>
          <LI>
            <Code>GET /datasets/&#123;id&#125;/export/skill-creator</Code>
          </LI>
          <LI>
            <Code>POST /datasets/&#123;id&#125;/infer-schema</Code>
          </LI>
        </UL>

        <H3>Scorers</H3>
        <UL>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/generate-scorers</Code>
          </LI>
          <LI>
            <Code>PATCH /sessions/&#123;id&#125;/scorers</Code>
          </LI>
        </UL>

        <H3>Evaluations</H3>
        <UL>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/run-eval</Code>
          </LI>
          <LI>
            <Code>GET /sessions/&#123;id&#125;/eval-runs</Code>
          </LI>
          <LI>
            <Code>GET /sessions/&#123;id&#125;/eval-runs/&#123;run_id&#125;</Code>
          </LI>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/suggest-improvements</Code>
          </LI>
        </UL>

        <H3>Schema detection</H3>
        <UL>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/detect-schema</Code>
          </LI>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/import-from-url</Code>
          </LI>
        </UL>

        <HR />

        <H2 id="db">Database schema</H2>
        <P>
          PostgreSQL via asyncpg. Idempotent schema migrations live in{" "}
          <Code>db.py</Code>'s <Code>init_db</Code>.
        </P>
        <Table>
          <THead>
            <TR>
              <TH>Table</TH>
              <TH>Purpose</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>
                <Code>sessions</Code>
              </TD>
              <TD>
                Full session state as JSONB (charter, validation, input,
                conversation_history, skill_versions, lineage map)
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>charters</Code>
              </TD>
              <TD>Immutable charter snapshots created on finalize</TD>
            </TR>
            <TR>
              <TD>
                <Code>turns</Code>
              </TD>
              <TD>
                Every LLM interaction logged with full input/output/metadata
                for replay and judging
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>datasets</Code>
              </TD>
              <TD>Dataset metadata with charter snapshot + stats</TD>
            </TR>
            <TR>
              <TD>
                <Code>examples</Code>
              </TD>
              <TD>
                Dataset rows with verdict, revision suggestion,{" "}
                <Code>should_trigger</Code>, <Code>is_adversarial</Code>
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>settings</Code>
              </TD>
              <TD>
                Single-row settings (model, creativity, max_rounds)
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>eval_runs</Code>
              </TD>
              <TD>
                Persisted Braintrust runs — status, scorer averages, per-row
                results, <Code>skill_version_id</Code>,{" "}
                <Code>charter_snapshot</Code>
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>judgements</Code>
              </TD>
              <TD>
                Scores per turn when <Code>POST /judge/run</Code> is invoked
              </TD>
            </TR>
          </TBody>
        </Table>
        <P>Migrations added over time:</P>
        <UL>
          <LI>
            <Code>examples.revision_suggestion JSONB</Code>
          </LI>
          <LI>
            <Code>examples.should_trigger BOOLEAN</Code>
          </LI>
          <LI>
            <Code>examples.is_adversarial BOOLEAN</Code>
          </LI>
          <LI>
            <Code>examples.expected_output</Code> — DROP NOT NULL (required
            for <Code>should_trigger=false</Code> rows)
          </LI>
          <LI>
            <Code>eval_runs.charter_snapshot JSONB</Code>
          </LI>
        </UL>

        <HR />

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
              <TD>Claude API key (priority over OpenRouter)</TD>
            </TR>
            <TR>
              <TD>
                <Code>OPENROUTER_API_KEY</Code>
              </TD>
              <TD>one of</TD>
              <TD>
                OpenRouter key — auto-detected by <Code>sk-or-</Code>{" "}
                prefix.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>BRAINTRUST_API_KEY</Code>
              </TD>
              <TD>for UI evals</TD>
              <TD>Can also be entered in the Evaluations tab.</TD>
            </TR>
            <TR>
              <TD>
                <Code>BRAINTRUST_PROD_API_KEY</Code>
              </TD>
              <TD>for prod monitoring</TD>
              <TD>
                Project-scoped key for <Code>north-star-prod</Code>; every
                Anthropic call wrapped + traced when set. No-op when unset.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>BRAINTRUST_PROD_PROJECT</Code>
              </TD>
              <TD>no</TD>
              <TD>
                Default <Code>north-star-prod</Code>.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>CHARTER_QUALITY_MODEL</Code>
              </TD>
              <TD>no</TD>
              <TD>
                Online scorer model. Default{" "}
                <Code>claude-sonnet-4-5-20250929</Code>.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>GOAL_EXTRACTION_QUALITY_MODEL</Code>
              </TD>
              <TD>no</TD>
              <TD>
                Online scorer model. Default{" "}
                <Code>claude-haiku-4-5-20251001</Code>.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>CONVERSATION_QUALITY_MODEL</Code>
              </TD>
              <TD>no</TD>
              <TD>
                Online scorer model. Default{" "}
                <Code>claude-haiku-4-5-20251001</Code>.
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
                Eval task model. Default <Code>claude-opus-4-7</Code>.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>JUDGE_MODEL</Code>
              </TD>
              <TD>no</TD>
              <TD>
                LLM-as-judge model. Default{" "}
                <Code>claude-sonnet-4-20250514</Code>.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>MAX_QUESTION_ROUNDS</Code>
              </TD>
              <TD>no</TD>
              <TD>Scratch-mode refinement rounds. Default 3.</TD>
            </TR>
          </TBody>
        </Table>

        <HR />

        <H2 id="use-cases">Use-case fit</H2>

        <H3>Strong fit</H3>
        <UL>
          <LI>
            <Strong>Claude Code skills with text-centric output</Strong> —{" "}
            <Code>internal-comms</Code>, <Code>claude-api</Code>,{" "}
            <Code>skill-creator</Code>, <Code>doc-coauthoring</Code>. The
            full charter → dataset → eval → improve loop holds end-to-end.
          </LI>
          <LI>
            <Strong>Guardrail iteration.</Strong> When the biggest risk is
            wrong-prompt firing or adversarial mishandling, the negative
            coverage + safety + adversarial dataset rows give you direct
            measurement.
          </LI>
          <LI>
            <Strong>Skill description tuning.</Strong> Export{" "}
            <Code>should_trigger=false</Code> rows through{" "}
            <Code>/export/skill-creator</Code> for dedicated routing evals.
          </LI>
          <LI>
            <Strong>Small teams owning a skill end-to-end.</Strong> One
            person can iterate the loop in minutes.
          </LI>
        </UL>

        <H3>Less strong fit (today)</H3>
        <UL>
          <LI>
            <Strong>Tool-using skills</Strong> (<Code>docx</Code>,{" "}
            <Code>pdf</Code>, <Code>xlsx</Code>,{" "}
            <Code>slack-gif-creator</Code>, <Code>webapp-testing</Code>,
            anything producing file artifacts). The eval{" "}
            <Code>task()</Code> runs bare Claude, so tool-produced
            artifacts don't actually materialise. Wait for Agent SDK
            integration or scope evals to text output.
          </LI>
          <LI>
            <Strong>Very large datasets (1000+ rows).</Strong> Current UI
            renders all rows; per-row judge calls aren't batched
            aggressively. Fine for demo-sized iteration, not
            production-scale benchmarking.
          </LI>
          <LI>
            <Strong>Multi-agent flows</Strong> where routing happens across
            multiple skills. The harness only evaluates one skill at a time.
          </LI>
          <LI>
            <Strong>Continuous production monitoring.</Strong> This is an
            authoring + iteration tool. For prod monitoring, wire
            Braintrust or Langfuse directly into your app and consume
            North Star's dataset as a seed.
          </LI>
        </UL>

        <H3>Not a fit</H3>
        <UL>
          <LI>
            <Strong>Non-LLM evaluation.</Strong> If "good" is measured by
            deterministic passing tests (SQL correctness, etc.), an
            LLM-as-judge charter is overkill.
          </LI>
          <LI>
            <Strong>Compliance / regulatory evals</Strong> where scorer
            provenance must be traceable to a human. Our scorers are
            LLM-authored; a regulated environment would need human-written
            scorer code at minimum.
          </LI>
        </UL>
      </Prose>
    </DocsLayout>
  );
}
