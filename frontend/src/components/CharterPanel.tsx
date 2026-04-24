import { useState, useRef, useEffect } from "react";
import type { ReactNode } from "react";
import { ChevronDown, ChevronRight as ChevronRightIcon, FileText, Loader2 } from "lucide-react";
import CharterDocument from "./CharterDocument";
import type {
  Charter,
  Validation,
  DimensionStatus,
  AlignmentEntry,
  Suggestion,
  TaskDefinition,
} from "../types";
import RadarChart from "./RadarChart";
import PanelLayout from "./PanelLayout";
import SuggestionBox, { SuggestionCard } from "./SuggestionBox";
import ItemList, { HelpPopover } from "./ItemList";
import Button from "./ui/Button";
import Input from "./ui/Input";
import IconButton from "./ui/IconButton";
import {
  AIIcon,
  ReturnKeyIcon,
  CmdReturnIcon,
  CoverageIcon,
  HelpIcon,
  DragHandleIcon,
  CloseIcon,
  PlusIcon,
} from "./ui/Icons";

interface Props {
  charter: Charter;
  validation: Validation;
  activeCriteria: string[];
  onEditCriterion?: (dimension: string, index: number, value: string) => void;
  onAddCriterion?: (dimension: string, value: string) => void;
  onEditAlignment?: (
    index: number,
    field: "good" | "bad",
    value: string,
  ) => void;
  onDeleteCriterion?: (dimension: string, index: number) => void;
  onAddAlignment?: (featureArea: string, good: string, bad: string) => void;
  onDeleteAlignment?: (index: number) => void;
  onEditTask?: (field: keyof TaskDefinition, value: string) => void;
  onReorderCriteria?: (dimension: string, criteria: string[]) => void;
  onReorderAlignment?: (alignment: AlignmentEntry[]) => void;
  suggestions?: Suggestion[];
  onAcceptSuggestion?: (suggestion: Suggestion) => void;
  onDismissSuggestion?: (suggestion: Suggestion) => void;
  onRegenSuggestions?: () => void;
  onCriteriaChanged?: () => void;
  suggestionsLoading?: boolean;
  loading?: boolean;
  onBackToGoals?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextVariant?: "primary" | "neutral";
  nextDisabled?: boolean;
  /** Rendered in the right sidebar bottom slot (e.g. AI Assist) */
  rightBottom?: ReactNode;
  /** When set, expands bottom section to fill and caps Suggestions height. */
  rightBottomExpanded?: ReactNode;
}

type CharterTab = "task" | "coverage" | "balance" | "alignment" | "rot" | "safety";

export default function CharterPanel({
  charter,
  validation,
  activeCriteria,
  onEditCriterion,
  onAddCriterion,
  onEditAlignment,
  onDeleteCriterion,
  onAddAlignment,
  onDeleteAlignment,
  onEditTask,
  onReorderCriteria,
  onReorderAlignment,
  suggestions = [],
  onAcceptSuggestion,
  onDismissSuggestion,
  onRegenSuggestions,
  onCriteriaChanged,
  suggestionsLoading,
  loading,
  onBackToGoals,
  onNext,
  nextLabel,
  nextVariant = "neutral",
  nextDisabled = false,
  rightBottom,
  rightBottomExpanded,
}: Props) {
  // All sections live on one scrollable page as collapsibles. Default-open
  // for every section so the charter reads as a single document you can
  // skim + edit inline. Users can fold sections to focus.
  const [openSections, setOpenSections] = useState<Set<CharterTab>>(
    () => new Set(["task", "coverage", "balance", "alignment", "rot", "safety"]),
  );
  const toggleSection = (id: CharterTab) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const [showDocument, setShowDocument] = useState(false);

  const isEmpty =
    !charter.coverage.criteria.length &&
    !charter.balance.criteria.length &&
    !charter.alignment.length &&
    !charter.rot.criteria.length;

  const radarDimensions = buildRadarDimensions(charter, validation);
  const hasRadarData = radarDimensions.some((d) => d.value > 0);

  // Flat layout shows every suggestion — no per-tab filtering needed.
  const tabSuggestions = suggestions;

  // Compute tab readiness scores (0–1)
  const covScore = dimensionScore(charter.coverage.status, validation.coverage, charter.coverage.criteria.length).value;
  const balScore = dimensionScore(charter.balance.status, validation.balance, charter.balance.criteria.length).value;
  const rotScore = dimensionScore(charter.rot.status, validation.rot, charter.rot.criteria.length).value;
  // Safety is optional on older charters — guard everywhere.
  const safetyCriteria = charter.safety?.criteria ?? [];
  const safetyScore = safetyCriteria.length > 0 ? Math.min(1, safetyCriteria.length / 3) : 0;
  const isTriggered = !!charter.task.skill_body;

  // Alignment score
  const alignTotal = charter.alignment.length;
  const alignScore = alignTotal > 0
    ? validation.alignment.length > 0
      ? validation.alignment.filter((v) => v.status === "pass" || v.status === "good").length / alignTotal
      : Math.min(1, alignTotal / 4)
    : 0;

  // Task definition score
  const taskFilled = [charter.task.input_description, charter.task.output_description].filter(Boolean).length;
  const taskScore = taskFilled / 2;

  const tabs: { id: CharterTab; label: string; score: number }[] = [
    { id: "task", label: "Task Definition", score: taskScore },
    { id: "coverage", label: "Coverage", score: covScore },
    { id: "balance", label: "Balance", score: balScore },
    { id: "alignment", label: "Alignment", score: alignScore },
    { id: "rot", label: "Rot", score: rotScore },
    // Only surface Safety for triggered-mode sessions, where prompt-injection
    // + exfiltration + destructive-command risks are meaningful.
    ...(isTriggered || safetyCriteria.length > 0
      ? [{ id: "safety" as CharterTab, label: "Safety", score: safetyScore }]
      : []),
  ];

  if (isEmpty && suggestions.length === 0) {
    return (
      <PanelLayout
        title="Charter"
        subtitle="A formal rule set to keep your dataset in check"
        rightBottom={rightBottom}
        rightBottomExpanded={rightBottomExpanded}
      >
        <div className="flex items-center justify-center py-24">
          {loading ? (
            <div className="text-center">
              <Loader2 className="w-6 h-6 text-fg-dim animate-spin mx-auto mb-3" />
              <p className="text-sm text-fg-dim">Generating...</p>
            </div>
          ) : (
            <p className="text-sm text-fg-dim">
              No charter yet. Go back and generate one.
            </p>
          )}
        </div>
      </PanelLayout>
    );
  }

  return (
    <PanelLayout
      title="Charter"
      subtitle="A formal rule set to keep your dataset in check"
      rightTop={
        hasRadarData ? (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <CoverageIcon className="text-fg-dim" />
              <span className="text-base font-semibold text-fg-contrast">Coverage</span>
            </div>
            <div className="flex justify-center">
              <RadarChart dimensions={radarDimensions} size={200} />
            </div>
          </div>
        ) : undefined
      }
      right={
        <SuggestionBox
          onRefresh={onRegenSuggestions}
          loading={suggestionsLoading}
          emptyText="Charter suggestions will appear here."
        >
          {tabSuggestions.length > 0
            ? tabSuggestions.map((s, i) => (
                <SuggestionCard
                  key={i}
                  onAccept={() => onAcceptSuggestion?.(s)}
                  onDismiss={() => onDismissSuggestion?.(s)}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim bg-fill-neutral px-1.5 py-0.5">
                      {s.section}
                    </span>
                  </div>
                  {s.text}
                  {s.good && (
                    <span className="block text-xs text-fg-dim mt-0.5">
                      Good: {s.good} / Bad: {s.bad}
                    </span>
                  )}
                </SuggestionCard>
              ))
            : null}
        </SuggestionBox>
      }
      rightBottom={rightBottom}
      rightBottomExpanded={rightBottomExpanded}
      footer={
        onNext ? (
          <Button
            size="big"
            variant={nextVariant}
            shortcut={<CmdReturnIcon />}
            onClick={onNext}
            disabled={nextDisabled}
          >
            {loading ? "Generating…" : nextLabel}
          </Button>
        ) : undefined
      }
    >
      {/* Action bar — collapsible layout means no tab bar; just the doc button. */}
      <div className="flex items-center justify-between border-b-2 border-border-hint mb-4 pb-3">
        <div className="flex items-center gap-3 text-xs text-fg-dim">
          <button
            onClick={() => setOpenSections(new Set(tabs.map(t => t.id)))}
            className="hover:text-fg-contrast"
          >
            Expand all
          </button>
          <span>·</span>
          <button
            onClick={() => setOpenSections(new Set())}
            className="hover:text-fg-contrast"
          >
            Collapse all
          </button>
        </div>
        <button
          onClick={() => setShowDocument(true)}
          className="flex-shrink-0 flex items-center gap-1 py-1.5 px-3 text-xs text-fg-dim hover:text-fg-contrast border border-border-hint"
          title="View the full charter as one document"
        >
          <FileText className="w-4 h-4" />
          View as document
        </button>
      </div>

      {/* All sections rendered as a vertical stack of collapsibles. */}
      <SectionHeader
        label="Task Definition"
        score={taskScore}
        open={openSections.has("task")}
        onToggle={() => toggleSection("task")}
      />
      {openSections.has("task") && (
        <div className="mb-6">
          <SchemaSection task={charter.task} onEdit={onEditTask} />
        </div>
      )}

      <SectionHeader
        label="Coverage"
        score={covScore}
        open={openSections.has("coverage")}
        onToggle={() => toggleSection("coverage")}
      />
      {openSections.has("coverage") && (() => {
        const covPct = Math.round(covScore * 100);
        const negativeCriteria = charter.coverage.negative_criteria ?? [];
        return (
          <div className="flex flex-col gap-6 mb-6">
            <ItemList
              title="Coverage"
              helpTitle="Use cases and scenarios to cover"
              helpText="List the distinct scenarios, edge cases, and user intents your AI feature needs to handle. Good coverage ensures your evals aren't blind to entire categories of input."
              items={charter.coverage.criteria}
              onAdd={
                onAddCriterion ? (v) => onAddCriterion("coverage", v) : undefined
              }
              onEdit={
                onEditCriterion
                  ? (i, v) => onEditCriterion("coverage", i, v)
                  : undefined
              }
              onDelete={
                onDeleteCriterion
                  ? (i) => onDeleteCriterion("coverage", i)
                  : undefined
              }
              onReorder={
                onReorderCriteria
                  ? (criteria) => onReorderCriteria("coverage", criteria)
                  : undefined
              }
              addPlaceholder="Add coverage criterion..."
              statusText={covPct > 0 ? `${covPct}% ready` : undefined}
              statusColor={covPct > 0 ? scoreToColor(covScore) : undefined}
              onChanged={onCriteriaChanged}
              emptyText="No criteria yet"
            />
            {negativeCriteria.length > 0 && (
              <div className="border-t border-border-hint pt-4">
                <div className="mb-2">
                  <div className="text-sm font-semibold text-fg-contrast">Off-target (should NOT trigger)</div>
                  <div className="text-xs text-fg-dim mt-0.5">
                    Adjacent scenarios the skill/tool must stay out of. These define negative space.
                  </div>
                </div>
                <ul className="space-y-1">
                  {negativeCriteria.map((c, i) => (
                    <li key={i} className="text-sm text-fg-contrast bg-fill-neutral/40 px-3 py-2">
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })()}

      <SectionHeader
        label="Balance"
        score={balScore}
        open={openSections.has("balance")}
        onToggle={() => toggleSection("balance")}
      />
      {openSections.has("balance") && (() => {
        const balPct = Math.round(balScore * 100);
        return (
          <ItemList
            title="Balance"
            helpTitle="How to distribute across scenarios"
            helpText="Specify which scenarios deserve more weight in your dataset. Without balance criteria, your evals may over-represent easy cases and miss the hard ones."
            items={charter.balance.criteria}
            onAdd={
              onAddCriterion ? (v) => onAddCriterion("balance", v) : undefined
            }
            onEdit={
              onEditCriterion
                ? (i, v) => onEditCriterion("balance", i, v)
                : undefined
            }
            onDelete={
              onDeleteCriterion
                ? (i) => onDeleteCriterion("balance", i)
                : undefined
            }
            onReorder={
              onReorderCriteria
                ? (criteria) => onReorderCriteria("balance", criteria)
                : undefined
            }
            addPlaceholder="Add balance criterion..."
            statusText={balPct > 0 ? `${balPct}% ready` : undefined}
            statusColor={balPct > 0 ? scoreToColor(balScore) : undefined}
            onChanged={onCriteriaChanged}
            emptyText="No criteria yet"
          />
        );
      })()}

      <SectionHeader
        label="Alignment"
        score={alignScore}
        open={openSections.has("alignment")}
        onToggle={() => toggleSection("alignment")}
      />
      {openSections.has("alignment") && (
        <AlignmentSection
          entries={charter.alignment}
          validations={validation.alignment}
          activeCriteria={activeCriteria}
          onEdit={onEditAlignment}
          onAdd={onAddAlignment}
          onDelete={onDeleteAlignment}
          onReorder={onReorderAlignment}
          onCriteriaChanged={onCriteriaChanged}
        />
      )}

      <SectionHeader
        label="Rot"
        score={rotScore}
        open={openSections.has("rot")}
        onToggle={() => toggleSection("rot")}
      />
      {openSections.has("rot") && (() => {
        const rotPct = Math.round(rotScore * 100);
        return (
          <ItemList
            title="Rot"
            helpTitle="Signals the dataset needs refreshing"
            helpText="Define the conditions that would make your current dataset stale — new features, changed requirements, updated models. When these fire, it's time to regenerate."
            items={charter.rot.criteria}
            onAdd={
              onAddCriterion ? (v) => onAddCriterion("rot", v) : undefined
            }
            onEdit={
              onEditCriterion
                ? (i, v) => onEditCriterion("rot", i, v)
                : undefined
            }
            onDelete={
              onDeleteCriterion
                ? (i) => onDeleteCriterion("rot", i)
                : undefined
            }
            onReorder={
              onReorderCriteria
                ? (criteria) => onReorderCriteria("rot", criteria)
                : undefined
            }
            addPlaceholder="Add rot criterion..."
            statusText={rotPct > 0 ? `${rotPct}% ready` : undefined}
            statusColor={rotPct > 0 ? scoreToColor(rotScore) : undefined}
            onChanged={onCriteriaChanged}
            emptyText="No criteria yet"
          />
        );
      })()}

      {(isTriggered || safetyCriteria.length > 0) && (
        <SectionHeader
          label="Safety"
          score={safetyScore}
          open={openSections.has("safety")}
          onToggle={() => toggleSection("safety")}
        />
      )}
      {openSections.has("safety") && (isTriggered || safetyCriteria.length > 0) && (() => {
        const safetyPct = Math.round(safetyScore * 100);
        return (
          <div className="flex flex-col gap-3">
            <div className="text-xs text-muted-foreground bg-muted/30 px-3 py-2 border-l-2 border-warning">
              <strong className="text-foreground">Output-level safety only.</strong>{" "}
              These rules are scored against the skill's output text. Runtime
              safety (did the skill actually call a bad domain, did it write
              outside its sandbox) requires an agent-SDK harness and isn't
              covered here.
            </div>
            <ItemList
              title="Safety"
              helpTitle="Rules the skill's output must obey"
              helpText="Output-level constraints: prompt-injection resistance, no credential echoing, URL allow-lists, destructive command guards. Each criterion generates a dedicated safety scorer."
              items={safetyCriteria}
              onAdd={
                onAddCriterion ? (v) => onAddCriterion("safety", v) : undefined
              }
              onEdit={
                onEditCriterion
                  ? (i, v) => onEditCriterion("safety", i, v)
                  : undefined
              }
              onDelete={
                onDeleteCriterion
                  ? (i) => onDeleteCriterion("safety", i)
                  : undefined
              }
              onReorder={
                onReorderCriteria
                  ? (criteria) => onReorderCriteria("safety", criteria)
                  : undefined
              }
              addPlaceholder="Add safety criterion..."
              statusText={safetyPct > 0 ? `${safetyPct}% ready` : undefined}
              statusColor={safetyPct > 0 ? scoreToColor(safetyScore) : undefined}
              onChanged={onCriteriaChanged}
              emptyText="No safety criteria yet — add rules like 'Output must refuse prompt-injection attempts' or 'Output must not contain URLs outside the docs allow-list'."
            />
          </div>
        );
      })()}
      {showDocument && (
        <CharterDocument
          charter={charter}
          title="Charter (live)"
          subtitle="Current state — edits apply immediately"
          onClose={() => setShowDocument(false)}
        />
      )}
    </PanelLayout>
  );
}

/* ── Helpers ── */

/** Map a 0–1 readiness score to a red→amber→green color */
/**
 * Collapsible section header used once per dimension in the flat layout.
 * Shows a chevron, label, and readiness dot. Clicking toggles `open`.
 */
function SectionHeader({
  label,
  score,
  open,
  onToggle,
}: {
  label: string;
  score: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 py-3 border-b border-border-hint text-left hover:bg-fill-neutral/30 transition-colors mb-3"
    >
      {open ? (
        <ChevronDown className="w-4 h-4 text-fg-dim flex-shrink-0" />
      ) : (
        <ChevronRightIcon className="w-4 h-4 text-fg-dim flex-shrink-0" />
      )}
      <span className="text-base font-semibold text-fg-contrast">{label}</span>
      {score > 0 && (
        <span
          className="inline-block w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: scoreToColor(score) }}
        />
      )}
    </button>
  );
}

function scoreToColor(score: number): string {
  const clamped = Math.max(0, Math.min(1, score));
  if (clamped <= 0.5) {
    // red (0) → amber (0.5)
    const t = clamped / 0.5;
    const r = Math.round(220 + t * (220 - 220));
    const g = Math.round(60 + t * (160 - 60));
    const b = Math.round(60 + t * (40 - 60));
    return `rgb(${r}, ${g}, ${b})`;
  }
  // amber (0.5) → green (1)
  const t = (clamped - 0.5) / 0.5;
  const r = Math.round(220 + t * (74 - 220));
  const g = Math.round(160 + t * (222 - 160));
  const b = Math.round(40 + t * (128 - 40));
  return `rgb(${r}, ${g}, ${b})`;
}

function dimensionScore(
  _status: DimensionStatus | string,
  validationStatus: string,
  criteriaCount: number,
): {
  value: number;
  status: "pending" | "weak" | "good" | "pass" | "fail" | "untested";
} {
  if (criteriaCount === 0) return { value: 0, status: "pending" };
  const contentScore = Math.min(1, criteriaCount / 5);
  if (validationStatus !== "untested") {
    if (validationStatus === "good" || validationStatus === "pass")
      return {
        value: Math.max(contentScore, 1),
        status: validationStatus as "good" | "pass",
      };
    if (validationStatus === "weak")
      return { value: Math.max(contentScore, 0.6), status: "weak" };
    if (validationStatus === "fail")
      return { value: Math.max(contentScore * 0.5, 0.3), status: "fail" };
  }
  return { value: contentScore, status: "pending" };
}

function buildRadarDimensions(charter: Charter, validation: Validation) {
  const dims: Array<{
    label: string;
    value: number;
    status: "pending" | "weak" | "good" | "pass" | "fail" | "untested";
  }> = [];

  // Schema (top vertex)
  const taskFilled = [
    charter.task.input_description,
    charter.task.output_description,
  ].filter(Boolean).length;
  dims.push({
    label: "Schema",
    value: taskFilled / 2,
    status: taskFilled === 2 ? "good" : taskFilled > 0 ? "weak" : "pending",
  });

  // Coverage (top-right)
  const cov = dimensionScore(
    charter.coverage.status,
    validation.coverage,
    charter.coverage.criteria.length,
  );
  dims.push({ label: "Coverage", ...cov });

  // Balance (bottom-right)
  const bal = dimensionScore(
    charter.balance.status,
    validation.balance,
    charter.balance.criteria.length,
  );
  dims.push({ label: "Balance", ...bal });

  // Alignment (bottom-left)
  if (charter.alignment.length > 0) {
    const contentScore = Math.min(1, charter.alignment.length / 4);
    const passCount = validation.alignment.filter(
      (v) => v.status === "pass" || (v.status as string) === "good",
    ).length;
    const hasValidation = validation.alignment.length > 0;
    if (hasValidation) {
      const validationRatio = passCount / Math.max(1, charter.alignment.length);
      const value = Math.max(contentScore * 0.5, validationRatio);
      const status: "good" | "weak" | "pending" =
        passCount === charter.alignment.length ? "good" : "weak";
      dims.push({ label: "Alignment", value, status });
    } else {
      dims.push({ label: "Alignment", value: contentScore, status: "pending" });
    }
  } else {
    dims.push({ label: "Alignment", value: 0, status: "pending" });
  }

  // Rot (top-left)
  const rot = dimensionScore(
    charter.rot.status,
    validation.rot,
    charter.rot.criteria.length,
  );
  dims.push({ label: "Rot", ...rot });

  return dims;
}

function completionLabel(
  _status: DimensionStatus | string,
  validationStatus: string,
  criteriaCount: number,
): string {
  if (criteriaCount === 0) return "";
  if (validationStatus !== "untested") {
    if (validationStatus === "good" || validationStatus === "pass")
      return "complete";
    if (validationStatus === "weak") return "needs refinement";
    if (validationStatus === "fail") return "needs work";
  }
  return `${criteriaCount} item${criteriaCount !== 1 ? "s" : ""}`;
}

function badgeVariant(
  label: string,
): "success" | "warning" | "danger" | "muted" {
  if (label === "complete") return "success";
  if (label.includes("item")) return "muted";
  if (label === "needs refinement") return "warning";
  if (label === "needs work") return "danger";
  return "muted";
}

/* HelpPopover is now imported from ItemList.tsx */

/* ── SchemaSection ── */

function SchemaSection({
  task,
  onEdit,
}: {
  task: TaskDefinition;
  onEdit?: (field: keyof TaskDefinition, value: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-base font-medium text-fg-contrast">Schema</h3>
        <HelpPopover title="What your app receives and produces" text="Define the shape of your AI feature's input and output. This helps generate realistic test data that matches your actual use case." />
      </div>
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-sm font-medium text-fg-contrast mb-1.5 block">
            Input
          </label>
          <Input
            value={task.input_description}
            onChange={(e) => onEdit?.("input_description", e.target.value)}
            placeholder="Paste an example, a JSON schema, or just describe it"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-fg-contrast mb-1.5 block">
            Output
          </label>
          <Input
            value={task.output_description}
            onChange={(e) => onEdit?.("output_description", e.target.value)}
            placeholder="Paste an example, a JSON schema, or just describe it"
          />
        </div>
      </div>
    </div>
  );
}

/* DimensionSection and CriterionRow have been replaced by ItemList */

/* ── AlignmentSection ── */

function AlignmentSection({
  entries,
  validations,
  activeCriteria,
  onEdit,
  onAdd,
  onDelete,
  onReorder,
  onCriteriaChanged,
}: {
  entries: AlignmentEntry[];
  validations: {
    feature_area: string;
    status: string;
    weak_reason: string | null;
  }[];
  activeCriteria: string[];
  onEdit?: (index: number, field: "good" | "bad", value: string) => void;
  onAdd?: (featureArea: string, good: string, bad: string) => void;
  onDelete?: (index: number) => void;
  onReorder?: (entries: AlignmentEntry[]) => void;
  onCriteriaChanged?: () => void;
}) {
  const total = entries.length;
  const passCount = validations.filter(
    (v) => v.status === "pass" || v.status === "good",
  ).length;
  const score = total > 0
    ? validations.length > 0
      ? passCount / total
      : Math.min(1, total / 4)
    : 0;
  const pct = Math.round(score * 100);

  const [adding, setAdding] = useState(false);
  const [featureArea, setFeatureArea] = useState("");
  const [good, setGood] = useState("");
  const [bad, setBad] = useState("");
  const addRowRef = useRef<HTMLDivElement>(null);

  // Click-outside to dismiss add row
  useEffect(() => {
    if (!adding) return;
    const handler = (e: MouseEvent) => {
      if (addRowRef.current && !addRowRef.current.contains(e.target as Node)) {
        setAdding(false);
        setFeatureArea("");
        setGood("");
        setBad("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [adding]);

  const canSubmit = featureArea.trim() && good.trim() && bad.trim();

  const handleAddSubmit = () => {
    if (featureArea.trim() && good.trim() && bad.trim() && onAdd) {
      onAdd(featureArea.trim(), good.trim(), bad.trim());
      setFeatureArea("");
      setGood("");
      setBad("");
      setAdding(false);
      onCriteriaChanged?.();
    }
  };

  const dismissAdd = () => {
    setFeatureArea("");
    setGood("");
    setBad("");
    setAdding(false);
  };

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = (index: number) => setDragIndex(index);
  const handleDragOver = (index: number, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverIndex(index);
  };
  const handleDrop = (index: number) => {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    const updated = [...entries];
    const [moved] = updated.splice(dragIndex, 1);
    updated.splice(index, 0, moved);
    onReorder?.(updated);
    setDragIndex(null);
    setDragOverIndex(null);
  };
  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const dragEnabled = !!onReorder && entries.length > 1;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-medium text-fg-contrast">Alignment</h3>
          <HelpPopover title="Good vs bad output per feature" text="Define what good and bad output looks like for specific feature areas. These examples guide the AI to produce on-brand, on-spec responses." />
        </div>
        <div className="flex items-center gap-3">
          {pct > 0 && (
            <span
              className="text-base"
              style={{ color: scoreToColor(score) }}
            >
              {pct}% ready
            </span>
          )}
          {onAdd && (
            <Button size="small" variant="neutral" onClick={() => setAdding(true)} disabled={adding}>
              <PlusIcon />
              Add
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-0.5">
        {adding && (
          <div ref={addRowRef} className="flex flex-col gap-2.5 p-4 bg-fill-neutral">
            <div className="flex items-stretch gap-2.5">
              <Input
                autoFocus
                value={featureArea}
                onChange={(e) => setFeatureArea(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") dismissAdd();
                }}
                placeholder="Feature area..."
              />
              <Input
                value={good}
                onChange={(e) => setGood(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") dismissAdd();
                }}
                placeholder="Good example..."
              />
            </div>
            <div className="flex items-stretch gap-2.5">
              <Input
                value={bad}
                onChange={(e) => setBad(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddSubmit();
                  }
                  if (e.key === "Escape") dismissAdd();
                }}
                placeholder="Bad example..."
              />
              <Button
                size="big"
                variant={canSubmit ? "primary" : "neutral"}
                onClick={handleAddSubmit}
                disabled={!canSubmit}
                shortcut={<ReturnKeyIcon />}
              >
                Submit
              </Button>
            </div>
          </div>
        )}
        {entries.map((entry, i) => {
          const val = validations.find(
            (v) => v.feature_area === entry.feature_area,
          );
          const isActive = activeCriteria.includes(
            `alignment_${entry.feature_area}`,
          );
          const showDropIndicator =
            dragIndex !== null && dragOverIndex === i && dragIndex !== i;
          return (
            <div key={i}>
              {showDropIndicator && (
                <div className="h-0.5 -my-px bg-purple-700 relative z-10" />
              )}
              <AlignmentRow
                entry={entry}
                validation={val}
                active={isActive}
                onEdit={
                  onEdit ? (field, value) => onEdit(i, field, value) : undefined
                }
                onDelete={onDelete ? () => { onDelete(i); onCriteriaChanged?.(); } : undefined}
                draggable={dragEnabled}
                onDragStart={() => handleDragStart(i)}
                onDragOver={(e) => handleDragOver(i, e)}
                onDrop={() => handleDrop(i)}
                onDragEnd={handleDragEnd}
                isDragging={dragIndex === i}
              />
            </div>
          );
        })}
        {entries.length === 0 && !adding && (
          <p className="text-sm text-fg-dim italic py-4">
            No alignment entries yet
          </p>
        )}
      </div>
    </div>
  );
}

/* ── AlignmentRow ── */

function AlignmentRow({
  entry,
  validation,
  active,
  onEdit,
  onDelete,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging,
}: {
  entry: AlignmentEntry;
  validation?: { status: string; weak_reason: string | null };
  active: boolean;
  onEdit?: (field: "good" | "bad", value: string) => void;
  onDelete?: () => void;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
  isDragging?: boolean;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const status = validation?.status || "pending";

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`group py-4 px-4 bg-fill-neutral ${active ? "bg-purple-700/5" : ""} ${isDragging ? "opacity-30" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-base font-medium text-fg-contrast">
          {entry.feature_area}
        </span>
        <div className="flex items-center gap-2">
          {(status === "weak" || status === "fail") &&
            validation?.weak_reason && (
              <button
                onClick={() => setShowDetail(!showDetail)}
                className="text-xs text-amber-500 hover:opacity-80"
              >
                why?
              </button>
            )}
          {onDelete && (
            <IconButton
              tone="dim"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity"
              title="Remove"
            >
              <CloseIcon />
            </IconButton>
          )}
          <div
            className={`w-10 h-10 flex items-center justify-center flex-shrink-0 transition-colors ${
              draggable
                ? "text-fg-dim hover:text-fg-contrast cursor-grab"
                : "text-fg-dim"
            }`}
          >
            <DragHandleIcon />
          </div>
        </div>
      </div>
      {showDetail && validation?.weak_reason && (
        <div className="mt-2 p-2 bg-amber-500/10 text-xs text-amber-500">
          {validation.weak_reason}
        </div>
      )}
      <div className="mt-2 space-y-1">
        <EditableField
          label="Good"
          value={entry.good}
          color="text-green-500"
          onSave={(v) => onEdit?.("good", v)}
        />
        <EditableField
          label="Bad"
          value={entry.bad}
          color="text-red-500"
          onSave={(v) => onEdit?.("bad", v)}
        />
      </div>
    </div>
  );
}

/* ── EditableField ── */

function EditableField({
  label,
  value,
  color,
  onSave,
}: {
  label: string;
  value: string;
  color: string;
  onSave?: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const handleBlur = () => {
    setEditing(false);
    if (text !== value && onSave) onSave(text);
  };

  return (
    <div className="text-sm">
      <span className={`font-medium ${color}`}>{label}:</span>{" "}
      {editing ? (
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleBlur();
            }
            if (e.key === "Escape") {
              setText(value);
              setEditing(false);
            }
          }}
          autoFocus
          className="bg-transparent text-sm text-fg-contrast border-b border-purple-700 focus:outline-none caret-purple-700"
        />
      ) : (
        <span
          onClick={() => onSave && setEditing(true)}
          className={`text-fg-dim ${onSave ? "cursor-pointer hover:text-fg-contrast transition-colors" : ""}`}
        >
          {value}
        </span>
      )}
    </div>
  );
}
