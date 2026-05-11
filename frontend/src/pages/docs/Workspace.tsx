import DocsLayout from "../../components/docs/DocsLayout";
import AnchorList from "../../components/docs/AnchorList";
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

const ANCHORS = [
  { id: "skill", label: "Skill" },
  { id: "goals", label: "Business Goals" },
  { id: "users", label: "User Stories" },
  { id: "charter", label: "Charter" },
  { id: "dataset", label: "Dataset" },
  { id: "scorers", label: "Scorers" },
  { id: "evaluations", label: "Evaluations" },
  { id: "improve", label: "Improve" },
];

export default function Workspace() {
  return (
    <DocsLayout>
      <Prose>
        <H1>Workspace tour</H1>
        <Lede>
          A walk through every tab in a project workspace — what it does,
          which prompts it fires, what data it produces, and what knobs you
          turn.
        </Lede>

        <AnchorList anchors={ANCHORS} />

        <H2 id="skill">Skill</H2>
        <P>
          <Strong>Purpose:</Strong> the source of truth. The SKILL.md body
          lives here; every other artifact downstream of it.
        </P>
        <P>
          <Strong>Prompts fired:</Strong>{" "}
          <Code>build_skill_seed_prompt(skill_body, name, description)</Code>{" "}
          — one-shot extraction of goals, users, positive + off-target
          stories, and task definition when the user first pastes.
        </P>
        <P>
          <Strong>Data produced:</Strong>{" "}
          <Code>SessionState.charter.task.skill_body</Code> +{" "}
          <Code>skill_versions[]</Code> (append-only history) +{" "}
          <Code>active_skill_version_id</Code> pointer.
        </P>
        <P>
          <Strong>Interactions:</Strong> paste, edit, save as v+1, diff v2
          vs v1, restore an earlier version.
        </P>
        <P>
          <Strong>Lineage:</Strong> each downstream artifact records which
          skill version it was generated against via{" "}
          <Code>state.generated_at_skill_version</Code>. When the active
          version advances, stale tabs surface a banner with{" "}
          <Strong>Update suggestions</Strong> and{" "}
          <Strong>Regenerate</Strong> buttons.
        </P>

        <HR />

        <H2 id="goals">Business Goals</H2>
        <P>
          <Strong>Purpose:</Strong> what the business needs from the skill.
          Auto-extracted from SKILL.md on seed; freely editable.
        </P>
        <P>
          <Strong>Prompts fired:</Strong>
        </P>
        <UL>
          <LI>
            <Code>build_suggest_goals_prompt(goals)</Code> — proposes
            complementary goals.
          </LI>
          <LI>
            <Code>build_evaluate_goals_prompt(goals)</Code> — flags goals
            that are too broad, not measurable, or not independent.
          </LI>
        </UL>
        <P>
          <Strong>Knobs:</Strong> add, edit, delete, accept suggestion,
          dismiss suggestion. The agent never auto-applies; users review and
          confirm.
        </P>

        <HR />

        <H2 id="users">User Stories</H2>
        <P>
          <Strong>Purpose:</Strong> who uses the skill and what they're
          trying to do.
        </P>
        <P>
          In triggered mode, every story carries a <Code>kind</Code> field:{" "}
          <Code>positive</Code> (skill should fire) or <Code>off_target</Code>{" "}
          (skill should NOT fire). Off-target stories become the
          negative-space coverage criteria — the dataset generator uses them
          to produce <Code>should_trigger=false</Code> rows.
        </P>
        <P>
          <Strong>Prompts fired:</Strong>{" "}
          <Code>build_suggest_stories_prompt(goals, stories)</Code> —
          proposes missing stories grounded in current goals.
        </P>
        <P>
          <Strong>Data shape per story:</Strong>{" "}
          <Code>{`{ who, what, why, kind }`}</Code>.
        </P>

        <HR />

        <H2 id="charter">Charter</H2>
        <P>
          <Strong>Purpose:</Strong> the quality specification. Six sub-tabs:
        </P>
        <Table>
          <THead>
            <TR>
              <TH>Sub-tab</TH>
              <TH>What it defines</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>Task Definition</TD>
              <TD>
                Input/output format + skill metadata (name, description,
                body)
              </TD>
            </TR>
            <TR>
              <TD>Coverage</TD>
              <TD>
                Positive criteria (scenarios to handle) +{" "}
                <Code>negative_criteria</Code> (off-target)
              </TD>
            </TR>
            <TR>
              <TD>Balance</TD>
              <TD>
                Which scenarios to weight, positive/negative ratio
              </TD>
            </TR>
            <TR>
              <TD>Alignment</TD>
              <TD>
                Per-feature-area good/bad definitions (observable, not
                intent-level)
              </TD>
            </TR>
            <TR>
              <TD>Rot</TD>
              <TD>Conditions under which the charter needs refreshing</TD>
            </TR>
            <TR>
              <TD>Safety</TD>
              <TD>
                Output-level rules (prompt-injection resistance, credential
                containment, URL allow-list, etc). Triggered mode only.
              </TD>
            </TR>
          </TBody>
        </Table>
        <P>
          <Strong>Prompts fired:</Strong>
        </P>
        <UL>
          <LI>
            <Code>build_generate_draft_prompt(state, creativity)</Code> —
            generates the charter JSON. In triggered mode, anchors on
            SKILL.md + extracted state. In scratch mode, uses the
            conversation transcript.
          </LI>
          <LI>
            <Code>build_validate_charter_prompt(state)</Code> — returns
            pass/weak/fail per dimension, strict about specificity and
            testability. Triggered mode also enforces non-empty{" "}
            <Code>coverage.negative_criteria</Code> and populated safety
            criteria for side-effecting skills.
          </LI>
          <LI>
            <Code>build_generate_suggestions_prompt(state)</Code> — per-tab
            suggestions for weak/empty sections, with deduplication baked
            into the prompt and parser.
          </LI>
          <LI>
            <Code>build_conversational_turn_prompt(state, user_message)</Code>{" "}
            — fallback when the user opens Polaris chat.
          </LI>
        </UL>
        <P>
          <Strong>View as document:</Strong> top-right button opens the full
          charter as one markdown page with copy-to-clipboard.
        </P>

        <HR />

        <H2 id="dataset">Dataset</H2>
        <P>
          <Strong>Purpose:</Strong> the rows the skill will actually be
          evaluated against.
        </P>
        <H3>Row shape</H3>
        <Table>
          <THead>
            <TR>
              <TH>Field</TH>
              <TH>Notes</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>
                <Code>id</Code>
              </TD>
              <TD>UUID</TD>
            </TR>
            <TR>
              <TD>
                <Code>input</Code>
              </TD>
              <TD>What the skill will receive</TD>
            </TR>
            <TR>
              <TD>
                <Code>expected_output</Code>
              </TD>
              <TD>
                Reference output. Nullable for{" "}
                <Code>should_trigger=false</Code> rows.
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>feature_area</Code>
              </TD>
              <TD>From the charter's alignment dimensions</TD>
            </TR>
            <TR>
              <TD>
                <Code>coverage_tags</Code>
              </TD>
              <TD>Which coverage criteria this row exercises</TD>
            </TR>
            <TR>
              <TD>
                <Code>label</Code>
              </TD>
              <TD>Free-form annotation</TD>
            </TR>
            <TR>
              <TD>
                <Code>should_trigger</Code>
              </TD>
              <TD>
                <Code>true</Code> | <Code>false</Code> | <Code>null</Code>{" "}
                (standard mode)
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>is_adversarial</Code>
              </TD>
              <TD>
                <Code>true</Code> | <Code>null</Code> — safety probe
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>review_status</Code>
              </TD>
              <TD>
                <Code>pending</Code> · <Code>approved</Code> ·{" "}
                <Code>rejected</Code> · <Code>needs_edit</Code>
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>judge_verdict</Code>
              </TD>
              <TD>
                <Code>{`{ suggested_label, confidence, reasoning, issues, trigger_verdict?, execution_verdict? }`}</Code>
              </TD>
            </TR>
            <TR>
              <TD>
                <Code>revision_suggestion</Code>
              </TD>
              <TD>Targeted fix proposed by the agent</TD>
            </TR>
          </TBody>
        </Table>

        <H3>Prompts fired</H3>
        <UL>
          <LI>
            <Code>build_synthesize_examples_prompt(charter, ...)</Code> —
            generates rows. In triggered mode, emits two populations:{" "}
            <Code>should_trigger=true</Code> rows (execution-eval) and{" "}
            <Code>should_trigger=false</Code> rows (routing). When safety
            criteria exist, also generates one adversarial row per
            criterion.
          </LI>
          <LI>
            <Code>build_review_examples_prompt(charter, examples)</Code> —
            LLM-as-judge. Triggered mode emits a composite verdict with{" "}
            <Code>trigger_verdict</Code> + <Code>execution_verdict</Code>.
          </LI>
          <LI>
            <Code>build_gap_analysis_prompt(charter, stats, examples)</Code>{" "}
            — finds coverage holes, feature-area holes, under-represented
            scenarios.
          </LI>
          <LI>
            <Code>build_revise_examples_prompt(charter, examples_with_verdicts)</Code>{" "}
            — proposes minimal targeted fixes for flagged rows. Users
            accept, edit, or dismiss — never auto-applied.
          </LI>
          <LI>
            <Code>build_dataset_chat_prompt(...)</Code> — conversational
            curation (fallback surface).
          </LI>
        </UL>

        <HR />

        <H2 id="scorers">Scorers</H2>
        <P>
          <Strong>Purpose:</Strong> executable Python scoring functions.
        </P>
        <P>
          <Strong>Prompt fired:</Strong>{" "}
          <Code>build_generate_scorers_prompt(charter)</Code> — emits one
          scorer per alignment entry, one per coverage criterion, and one
          per safety criterion. Each is a complete function with signature{" "}
          <Code>def &lt;name&gt;(output: str, input: str) -&gt; float</Code>,
          an embedded LLM-as-judge prompt, and a call to an injected{" "}
          <Code>call_judge(prompt) -&gt; float</Code> helper.
        </P>
        <P>
          <Strong>Output shape per scorer:</Strong>{" "}
          <Code>{`{ name, type: "alignment" | "coverage" | "safety", description, code }`}</Code>
          .
        </P>
        <Callout tone="warning" title="Safety scorers are strict">
          Their judge prompts are instructed that violations should never
          score above 0.3 — so a single safety failure in a run is loud and
          obvious in the scorer averages.
        </Callout>

        <HR />

        <H2 id="evaluations">Evaluations</H2>
        <P>
          <Strong>Purpose:</Strong> run the dataset through Claude (with
          SKILL.md as system prompt) → score with the scorers → pipe into
          Braintrust.
        </P>

        <H3>Backend flow</H3>
        <UL>
          <LI>
            <Code>POST /sessions/&#123;id&#125;/run-eval</Code> queues a
            run, persists a row in <Code>eval_runs</Code>, spawns an
            asyncio background task that invokes{" "}
            <Code>eval_runner.run_eval_sync</Code> off the event loop.
          </LI>
          <LI>
            Each run captures a <Code>charter_snapshot</Code> +{" "}
            <Code>skill_version_id</Code> so old runs can be reviewed in
            context.
          </LI>
          <LI>
            <Code>GET /sessions/&#123;id&#125;/eval-runs/&#123;run_id&#125;</Code>{" "}
            polls status; the UI polls every 2s until terminal.
          </LI>
        </UL>

        <H3>What the eval does</H3>
        <UL>
          <LI>
            Compiles scorer source code into callable Python (injects{" "}
            <Code>call_judge</Code> helper).
          </LI>
          <LI>
            Filters dataset rows (<Code>review_status=approved</Code>;
            skips <Code>should_trigger=false</Code> unless user opts in).
          </LI>
          <LI>
            For each row, calls Claude with SKILL.md as system prompt (via{" "}
            <Code>braintrust.wrap_anthropic</Code>).
          </LI>
          <LI>
            Runs each scorer against{" "}
            <Code>(output, input, expected)</Code>. Judge reasoning is
            captured in scorer metadata so you can debug 0% scorers by
            reading the exact LLM response that produced them.
          </LI>
          <LI>
            Results stream into Braintrust and into the{" "}
            <Code>per_row</Code> JSONB column.
          </LI>
        </UL>

        <H3>UI features</H3>
        <UL>
          <LI>
            Per-scorer averages with{" "}
            <Strong>delta vs previous run</Strong> (<Code>+12pp</Code> /{" "}
            <Code>-4pp</Code>) — shows whether the last SKILL.md edit
            improved things.
          </LI>
          <LI>Run history list (persists across backend restarts).</LI>
          <LI>
            <Strong>View charter</Strong> link on each run — opens the
            exact charter used (not the live one).
          </LI>
          <LI>
            <Strong>Improve skill</Strong> sidebar in the right rail (see
            below).
          </LI>
        </UL>

        <HR />

        <H2 id="improve">Improve</H2>
        <Callout tone="info">
          The Improve flow lives in the Evaluations tab's right rail — it's
          not a separate top-level tab anymore. Documentation and APIs
          still refer to it as "Improve" because that's the name of the
          underlying suggestion endpoint.
        </Callout>
        <P>
          <Strong>Purpose:</Strong> turn eval failures into SKILL.md edits.
        </P>
        <P>
          <Strong>Prompt fired:</Strong>{" "}
          <Code>
            build_suggest_improvements_prompt(skill_body, eval_run, charter)
          </Code>{" "}
          — analyzes patterns across failing rows (scorer &lt; 0.6),
          proposes 2–5 minimal edits with row + scorer citations.
        </P>
        <P>
          <Strong>Edit shape:</Strong> either find/replace (verbatim{" "}
          <Code>find</Code> string must appear in SKILL.md) or append. Each
          suggestion carries <Code>kind</Code> (<Code>add_rule</Code> /{" "}
          <Code>clarify_rule</Code> / <Code>add_example</Code> /{" "}
          <Code>reword</Code> / <Code>other</Code>),{" "}
          <Code>confidence</Code>, <Code>source_row_ids</Code>, and{" "}
          <Code>source_scorer_names</Code>.
        </P>
        <P>
          <Strong>Interactions:</Strong>
        </P>
        <UL>
          <LI>
            Accept/dismiss per suggestion. Accepted suggestions collapse
            into one-line diff previews (<Code>old text → new text</Code>{" "}
            or <Code>append: new text</Code>).
          </LI>
          <LI>Preview the combined diff before saving.</LI>
          <LI>
            Save as v+1 → <Code>charter.task.skill_body</Code> updates →{" "}
            <Strong>Run evaluations</Strong> CTA appears → click it to bounce
            back to a new run with the same config as last time.
          </LI>
        </UL>
        <P>
          Linked back to the loop: save v2 → re-run → see deltas vs v1. See{" "}
          <A to="/docs/concepts#lineage">Concepts → Lineage</A> for how
          stale-banner detection works.
        </P>
      </Prose>
    </DocsLayout>
  );
}
