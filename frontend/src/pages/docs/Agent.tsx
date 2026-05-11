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
  UL,
  LI,
  Code,
  Strong,
  A,
  HR,
} from "../../components/docs/Prose";

const LAYERS = `prompt.py          All prompts. One function per prompt. Edit here to change
                   agent behavior — no other file needs to change.

tools.py           LLM call wrappers. Each call_X function:
                   - builds the prompt via prompt.build_X
                   - calls Claude (with per-request API key support)
                   - parses the response into Pydantic models
                   - returns (structured_data, [call_metadata])

eval_runner.py     Shared Braintrust eval logic — used by the UI's
                   /run-eval endpoint and by the CLI (evals/run_eval.py).

agent.py           Control flow. State transitions, orchestration, turn
                   logging. No prompts, no direct LLM calls.

main.py            FastAPI endpoints. Translates HTTP → agent turns or
                   direct tool calls. Handles per-request API keys via
                   middleware.

models.py          Pydantic models — one source of truth for frontend +
                   backend shapes (via Pydantic → TypeScript mirroring
                   in types.ts).

db.py              PostgreSQL via asyncpg. Idempotent schema migrations
                   in init_db.`;

const EXTRACTION = `\`\`\`extraction
{ "type": "goal", "value": "Reduce time-to-first-charter under 5 minutes" }
\`\`\``;

export default function Agent() {
  return (
    <DocsLayout>
      <Prose>
        <H1>Agent internals</H1>
        <Lede>
          How prompts, LLM calls, and control flow are split — and why. The
          full prompt catalog is at the bottom.
        </Lede>

        <H2 id="layering">The layering decision</H2>
        <P>
          The key choice in the backend:{" "}
          <Strong>
            prompts, LLM calls, and control flow live in separate files.
          </Strong>{" "}
          Prompts change weekly; control flow rarely does. Mixing them meant
          every prompt tweak risked breaking orchestration.
        </P>
        <CodeBlock>{LAYERS}</CodeBlock>
        <P>
          The cost of this is one extra file to grep when chasing a single
          flow. The benefit is that prompt edits don't touch agent code, and
          a new tool can be added by writing one prompt + one wrapper.
        </P>

        <H2 id="state-machine">Phase state machine</H2>
        <P>
          Sessions advance through five phases via{" "}
          <Code>POST /sessions/&#123;id&#125;/advance-phase</Code>. The
          current phase is stored on the session and gates which UI tabs
          are reachable.
        </P>
        <Table>
          <THead>
            <TR>
              <TH>Phase</TH>
              <TH>Tools the agent uses</TH>
              <TH>Exit condition</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>
                <Code>goals</Code>
              </TD>
              <TD>
                <Code>call_discovery</Code> · extracts <Code>goal</Code>{" "}
                blocks
              </TD>
              <TD>≥1 non-empty goal + user proceeds</TD>
            </TR>
            <TR>
              <TD>
                <Code>users</Code>
              </TD>
              <TD>
                <Code>call_discovery</Code> · extracts <Code>user</Code>{" "}
                blocks
              </TD>
              <TD>≥1 user role + user proceeds</TD>
            </TR>
            <TR>
              <TD>
                <Code>stories</Code>
              </TD>
              <TD>
                <Code>call_discovery</Code> · extracts <Code>story</Code>{" "}
                blocks
              </TD>
              <TD>≥1 story + user proceeds</TD>
            </TR>
            <TR>
              <TD>
                <Code>charter</Code>
              </TD>
              <TD>
                <Code>call_generate_draft</Code> ·{" "}
                <Code>call_validate_charter</Code> ·{" "}
                <Code>call_generate_suggestions</Code>
              </TD>
              <TD>charter passes validation + user finalizes</TD>
            </TR>
            <TR>
              <TD>
                <Code>dataset</Code>
              </TD>
              <TD>
                <Code>call_synthesize_examples</Code> ·{" "}
                <Code>call_review_examples</Code> ·{" "}
                <Code>call_gap_analysis</Code> ·{" "}
                <Code>call_revise_examples</Code>
              </TD>
              <TD>terminal (eval runs from here)</TD>
            </TR>
          </TBody>
        </Table>
        <P>
          Skill-first projects fast-forward through goals/users/stories via
          <Code>call_skill_seed</Code>, which extracts all three discovery
          types in one shot.
        </P>

        <H2 id="extraction">Extraction blocks</H2>
        <P>
          Discovery turns use a custom protocol instead of tool calls. The
          LLM emits fenced code blocks tagged <Code>extraction</Code>:
        </P>
        <CodeBlock>{EXTRACTION}</CodeBlock>
        <P>
          The agent strips these from the response before showing it to the
          user, validates them against a Pydantic schema, deduplicates
          (first-40-char case-insensitive match), and merges into{" "}
          <Code>SessionState</Code>. The user sees only the natural-language
          reply — the structured data updates the relevant panel out-of-band.
        </P>
        <P>
          <Strong>Why blocks instead of tool calls?</Strong> The same response
          carries the assistant's reply to the user. With tool calls we'd
          need a second round-trip after the tool result. Blocks let the
          agent extract and respond in one turn.
        </P>

        <H2 id="optimistic">Optimistic UI + debounced reevaluation</H2>
        <P>
          Edits — to a goal, a story, a charter dimension — apply locally
          first. The agent catches up asynchronously.
        </P>
        <P>
          Charter edits start a 3-second debounce timer. When it fires, the
          agent runs <Code>call_validate_charter</Code> in the background
          and surfaces fresh weak/fail markers. The user doesn't wait for
          the LLM between keystrokes, but they always converge to a
          server-validated state.
        </P>

        <H2 id="turn-logging">Turn logging</H2>
        <P>
          Every LLM interaction is persisted to the <Code>turns</Code> table:
        </P>
        <UL>
          <LI>Full input (prompt + variables)</LI>
          <LI>Full output (assistant message + parsed payload)</LI>
          <LI>
            Metadata: <Code>session_id</Code>, <Code>phase</Code>,{" "}
            <Code>turn_type</Code>, <Code>turn_number</Code>,{" "}
            <Code>model_name</Code>, latency, token counts
          </LI>
        </UL>
        <P>This means:</P>
        <UL>
          <LI>You can replay any session deterministically.</LI>
          <LI>
            Online scorers (see{" "}
            <A to="/docs/evals#online-scorers">Evals → Online scorers</A>)
            can grade specific turn types as they happen.
          </LI>
          <LI>
            <Code>POST /judge/run</Code> can grade a session post-hoc and
            store results in the <Code>judgements</Code> table.
          </LI>
        </UL>

        <H2 id="metadata">Trace metadata</H2>
        <P>
          When <Code>BRAINTRUST_PROD_API_KEY</Code> is set, every Anthropic
          call is wrapped with <Code>braintrust.wrap_anthropic</Code> and
          tagged with metadata so production dashboards and online scorers
          can filter by phase or turn type.
        </P>
        <Callout tone="info" title="Code seams for tracing">
          <UL>
            <LI>
              <Code>backend/app/tools.py</Code> —{" "}
              <Code>_ensure_braintrust_inited</Code>, <Code>_maybe_wrap</Code>
              , <Code>set_trace_meta</Code>, <Code>trace_call</Code>,{" "}
              <Code>@traced</Code> decorator. Every <Code>call_*</Code> tool
              is decorated.
            </LI>
            <LI>
              <Code>backend/app/agent.py</Code> — sets <Code>phase</Code> +{" "}
              <Code>session_id</Code> + <Code>turn_number</Code> at each
              handler entry.
            </LI>
            <LI>
              <Code>backend/app/main.py</Code> — middleware sets coarse{" "}
              <Code>phase</Code> + <Code>session_id</Code> for
              direct-from-handler tool calls.
            </LI>
          </UL>
        </Callout>

        <HR />

        <H2 id="catalog">Prompt catalog</H2>
        <P>
          All prompts live in <Code>backend/app/prompt.py</Code>. One
          function per prompt. To change agent behavior, edit there — no
          other file should need to change.
        </P>

        <H3>Skill</H3>
        <UL>
          <LI>
            <Code>build_skill_seed_prompt</Code> — one-shot extraction from
            SKILL.md
          </LI>
        </UL>

        <H3>Goals / Stories (discovery + helpers)</H3>
        <UL>
          <LI>
            <Code>build_discovery_turn_prompt</Code> — routes by phase
            (goals / users / stories). Used in scratch mode.
          </LI>
          <LI>
            <Code>build_suggest_goals_prompt</Code>
          </LI>
          <LI>
            <Code>build_evaluate_goals_prompt</Code>
          </LI>
          <LI>
            <Code>build_suggest_stories_prompt</Code>
          </LI>
        </UL>

        <H3>Charter</H3>
        <UL>
          <LI>
            <Code>build_generate_draft_prompt</Code> — generates the charter
            (branches on skill mode)
          </LI>
          <LI>
            <Code>build_validate_charter_prompt</Code> — pass / weak / fail
            per dimension
          </LI>
          <LI>
            <Code>build_generate_suggestions_prompt</Code> — per-tab
            suggestions with dedup rules
          </LI>
          <LI>
            <Code>build_conversational_turn_prompt</Code> — Polaris chat
            refinement
          </LI>
        </UL>

        <H3>Dataset</H3>
        <UL>
          <LI>
            <Code>build_synthesize_examples_prompt</Code> — generate rows
            (branches on triggered mode + safety)
          </LI>
          <LI>
            <Code>build_review_examples_prompt</Code> — judge verdicts
            (splits into trigger + execution verdicts)
          </LI>
          <LI>
            <Code>build_gap_analysis_prompt</Code> — find coverage holes
          </LI>
          <LI>
            <Code>build_revise_examples_prompt</Code> — fix flagged rows
          </LI>
          <LI>
            <Code>build_dataset_chat_prompt</Code> — conversational curation
          </LI>
        </UL>

        <H3>Scorers</H3>
        <UL>
          <LI>
            <Code>build_generate_scorers_prompt</Code> — emit Python
            LLM-as-judge functions
          </LI>
        </UL>

        <H3>Improve</H3>
        <UL>
          <LI>
            <Code>build_suggest_improvements_prompt</Code> — analyze eval
            failures, propose SKILL.md edits
          </LI>
        </UL>

        <H3>Schema helpers</H3>
        <UL>
          <LI>
            <Code>build_detect_schema_prompt</Code>
          </LI>
          <LI>
            <Code>build_infer_schema_prompt</Code>
          </LI>
          <LI>
            <Code>build_import_url_prompt</Code>
          </LI>
        </UL>
      </Prose>
    </DocsLayout>
  );
}
