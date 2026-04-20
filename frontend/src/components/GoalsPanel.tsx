import { useRef, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ReturnKeyIcon, CmdReturnIcon } from "./ui/Icons";
import PanelLayout from "./PanelLayout";
import SuggestionBox, { SuggestionCard } from "./SuggestionBox";
import Button from "./ui/Button";
import IconButton from "./ui/IconButton";
import Input from "./ui/Input";
import { CloseIcon, CheckIcon, DragHandleIcon, AIIcon } from "./ui/Icons";

interface GoalFeedbackItem {
  goal: string;
  issue: string | null;
  suggestion: string | null;
}

interface Props {
  goals: string[];
  onGoalsChange: (goals: string[]) => void;
  onGoalCommit: () => void;
  goalSuggestions: string[];
  onAcceptGoalSuggestion: (suggestion: string) => void;
  onDismissGoalSuggestion: (suggestion: string) => void;
  suggestionsLoading: boolean;
  goalFeedback: GoalFeedbackItem[];
  goalFeedbackLoading: boolean;
  onNext: () => void;
  nextLabel: string;
  nextVariant: "primary" | "neutral";
  nextDisabled: boolean;
  hasCharter: boolean;
  /** Rendered in the right sidebar bottom slot (e.g. AI Assist) */
  rightBottom?: ReactNode;
  /** When set, expands bottom section to fill and caps Suggestions height. */
  rightBottomExpanded?: ReactNode;
}

export default function GoalsPanel({
  goals,
  onGoalsChange,
  onGoalCommit,
  goalSuggestions,
  onAcceptGoalSuggestion,
  onDismissGoalSuggestion,
  suggestionsLoading,
  goalFeedback,
  onNext,
  nextLabel,
  nextVariant,
  nextDisabled,
  hasCharter,
  rightBottom,
  rightBottomExpanded,
}: Props) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const focusIndexRef = useRef<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [dismissedFeedback, setDismissedFeedback] = useState<Set<string>>(
    new Set(),
  );
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingIndex !== null) {
      requestAnimationFrame(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      });
    }
  }, [editingIndex]);

  const startEdit = (i: number, current: string) => {
    setEditingIndex(i);
    setEditValue(current);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditValue("");
  };

  const commitEdit = () => {
    if (editingIndex === null) return;
    if (!editValue.trim()) return;
    const updated = [...goals];
    updated[editingIndex] = editValue.trim();
    onGoalsChange(updated);
    // Re-fetch feedback for the edited goal
    onGoalCommit();
    setEditingIndex(null);
    setEditValue("");
  };

  useEffect(() => {
    if (focusIndexRef.current !== null) {
      const idx = focusIndexRef.current;
      focusIndexRef.current = null;
      requestAnimationFrame(() => {
        inputRefs.current[idx]?.focus();
      });
    }
  }, [goals.length]);

  const nonEmptyGoals = goals.filter((g) => g.trim());
  const isReady = nonEmptyGoals.length >= 2;

  // Match feedback to goals by text
  const getFeedback = (goal: string): GoalFeedbackItem | undefined => {
    if (!goal.trim()) return undefined;
    if (dismissedFeedback.has(goal.trim())) return undefined;
    return goalFeedback.find((f) => f.goal === goal.trim() && f.issue);
  };

  const dismissFeedback = (goal: string) => {
    setDismissedFeedback((prev) => new Set(prev).add(goal.trim()));
  };

  const updateGoal = (index: number, value: string) => {
    const updated = [...goals];
    updated[index] = value;
    onGoalsChange(updated);
  };

  const applyFeedbackSuggestion = (index: number, suggestion: string) => {
    const updated = [...goals];
    updated[index] = suggestion;
    onGoalsChange(updated);
  };

  const handleKeyDown = (
    index: number,
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!goals[index].trim()) return;
      if (index === goals.length - 1) {
        focusIndexRef.current = index + 1;
        onGoalsChange([...goals, ""]);
      } else {
        inputRefs.current[index + 1]?.focus();
      }
      onGoalCommit();
    }
    if (e.key === "Backspace" && goals[index] === "" && goals.length > 1) {
      e.preventDefault();
      focusIndexRef.current = Math.max(0, index - 1);
      onGoalsChange(goals.filter((_, i) => i !== index));
    }
  };

  const removeGoal = (index: number) => {
    if (goals.length <= 1) {
      onGoalsChange([""]);
      return;
    }
    onGoalsChange(goals.filter((_, i) => i !== index));
  };

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
    const updated = [...goals];
    const [moved] = updated.splice(dragIndex, 1);
    updated.splice(index, 0, moved);
    onGoalsChange(updated);
    setDragIndex(null);
    setDragOverIndex(null);
  };
  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <PanelLayout
      title="Business Goals"
      subtitle="List and prioritize your business goals"
      rightBottom={rightBottom}
      rightBottomExpanded={rightBottomExpanded}
      right={
        <SuggestionBox
          onRefresh={nonEmptyGoals.length > 0 ? onGoalCommit : undefined}
          loading={suggestionsLoading}
          emptyText="Enter a business goal to see suggestions."
        >
          {goalSuggestions.length > 0
            ? goalSuggestions.map((suggestion, i) => (
                <SuggestionCard
                  key={i}
                  onAccept={() => onAcceptGoalSuggestion(suggestion)}
                  onDismiss={() => onDismissGoalSuggestion(suggestion)}
                >
                  {suggestion}
                </SuggestionCard>
              ))
            : null}
        </SuggestionBox>
      }
      footer={
        <Button
          size="big"
          variant={nextVariant}
          shortcut={<CmdReturnIcon />}
          onClick={onNext}
          disabled={nextDisabled}
        >
          {nextLabel}
        </Button>
      }
    >
      {/* Compose row */}
      <div className="flex items-stretch gap-2.5 mb-6">
        <Input
          ref={(el) => {
            inputRefs.current[goals.length - 1] = el;
          }}
          type="text"
          value={goals[goals.length - 1] ?? ""}
          onChange={(e) => updateGoal(goals.length - 1, e.target.value)}
          onKeyDown={(e) => handleKeyDown(goals.length - 1, e)}
          placeholder="What do you want to achieve?"
        />
        <Button
          size="big"
          variant={goals[goals.length - 1]?.trim() ? "primary" : "neutral"}
          shortcut={<ReturnKeyIcon />}
          onClick={() => {
            if (goals[goals.length - 1].trim()) {
              onGoalCommit();
              onGoalsChange([...goals, ""]);
            }
          }}
        >
          Submit
        </Button>
      </div>

      {/* Existing goal rows */}
      <div className="flex flex-col gap-0.5">
        {goals.slice(0, -1).map((goal, i) => {
          const feedback = getFeedback(goal);
          const showDropIndicator =
            dragIndex !== null && dragOverIndex === i && dragIndex !== i;
          const dragEnabled = nonEmptyGoals.length > 1 && !!goal.trim();

          const dropIndicator = showDropIndicator ? (
            <div className="h-0.5 -my-px bg-purple-700 relative z-10" />
          ) : null;

          // Edit mode — swap content in place, keep row height the same
          if (editingIndex === i) {
            const changed = editValue.trim() !== goal.trim();
            return (
              <div key={i}>
                {dropIndicator}
                <div
                  className="flex items-center gap-2 px-4 h-[72px] bg-fill-neutral"
                  onDragOver={(e) => handleDragOver(i, e)}
                  onDrop={() => handleDrop(i)}
                >
                  <input
                    ref={editInputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitEdit();
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    placeholder="What do you want to achieve?"
                    className="flex-1 min-w-0 bg-transparent text-base font-medium text-gray-900 placeholder:text-gray-550 focus:outline-none caret-purple-700"
                  />
                  <Button size="small" variant="neutral" onClick={cancelEdit}>
                    Cancel
                  </Button>
                  <Button
                    size="small"
                    variant={
                      changed && editValue.trim() ? "primary" : "neutral"
                    }
                    shortcut={<ReturnKeyIcon />}
                    onClick={commitEdit}
                    disabled={!editValue.trim() || !changed}
                  >
                    Submit
                  </Button>
                </div>
              </div>
            );
          }

          if (feedback) {
            return (
              <div key={i}>
                {dropIndicator}
                <div className="bg-fill-neutral">
                  {/* Goal row — amber border, no fill */}
                  <div
                    className="flex items-center justify-between gap-1 px-4 h-[72px] border border-[#533E1D] group"
                    draggable={dragEnabled}
                    onDragStart={() => handleDragStart(i)}
                    onDragOver={(e) => handleDragOver(i, e)}
                    onDrop={() => handleDrop(i)}
                    onDragEnd={handleDragEnd}
                  >
                    <span className="text-base font-medium text-gray-900 flex-1 min-w-0 truncate">
                      {goal}
                    </span>
                    <div
                      className={`w-10 h-10 flex items-center justify-center flex-shrink-0 transition-colors ${
                        dragEnabled
                          ? "text-fg-dim hover:text-fg-contrast cursor-grab"
                          : "text-fg-dim/30 cursor-default"
                      } ${dragIndex === i ? "opacity-30" : ""}`}
                    >
                      <DragHandleIcon />
                    </div>
                  </div>

                  {/* Amber warning banner */}
                  <div className="bg-[#533E1D] p-4 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <AIIcon />
                      <span className="text-base font-semibold text-gray-900">
                        {feedback.issue ??
                          "Too vague and incomplete. How about this:"}
                      </span>
                    </div>
                    {feedback.suggestion && (
                      <div className="flex items-start justify-between gap-6">
                        <p className="text-base text-gray-900 flex-1">
                          {feedback.suggestion}
                        </p>
                        <div className="flex items-center gap-2">
                          <IconButton
                            tone="contrast"
                            onClick={() => dismissFeedback(goal)}
                            title="Dismiss suggestion"
                          >
                            <CloseIcon />
                          </IconButton>
                          <IconButton
                            tone="contrast"
                            onClick={() => {
                              applyFeedbackSuggestion(i, feedback.suggestion!);
                              dismissFeedback(goal);
                            }}
                            title="Use suggestion"
                          >
                            <CheckIcon />
                          </IconButton>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div key={i}>
              {dropIndicator}
              <div
                onClick={() => startEdit(i, goal)}
                className="flex items-center justify-between gap-1 group px-4 h-[72px] bg-fill-neutral cursor-pointer"
                draggable={dragEnabled}
                onDragStart={() => handleDragStart(i)}
                onDragOver={(e) => handleDragOver(i, e)}
                onDrop={() => handleDrop(i)}
                onDragEnd={handleDragEnd}
              >
                <span className="text-base font-medium text-gray-900 flex-1 min-w-0 truncate">
                  {goal}
                </span>
                <IconButton
                  tone="dim"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeGoal(i);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove"
                >
                  <CloseIcon />
                </IconButton>
                <div
                  onClick={(e) => e.stopPropagation()}
                  className={`w-10 h-10 flex items-center justify-center flex-shrink-0 transition-colors ${
                    dragEnabled
                      ? "text-fg-dim hover:text-fg-contrast cursor-grab"
                      : "text-fg-dim/30 cursor-default"
                  } ${dragIndex === i ? "opacity-30" : ""}`}
                >
                  <DragHandleIcon />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </PanelLayout>
  );
}
