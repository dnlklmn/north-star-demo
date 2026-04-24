import { useRef, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, Loader2, Sparkles } from "lucide-react";
import { ReturnKeyIcon, CmdReturnIcon } from "./ui/Icons";
import type { StoryGroup, SuggestedStory } from "../types";
import PanelLayout from "./PanelLayout";
import SuggestionBox, { SuggestionCard } from "./SuggestionBox";
import Button from "./ui/Button";
import IconButton from "./ui/IconButton";
import Input from "./ui/Input";
import { CloseIcon, DragHandleIcon, PencilIcon, PlusIcon } from "./ui/Icons";

interface Props {
  storyGroups: StoryGroup[];
  onStoryGroupsChange: (groups: StoryGroup[]) => void;
  onStoryCommit: () => void;
  suggestedStories: SuggestedStory[];
  onAcceptStory: (story: SuggestedStory) => void;
  onDismissStory: (story: SuggestedStory) => void;
  storySuggestionsLoading: boolean;
  onBackToGoals: () => void;
  onNext: () => void;
  nextLabel: string;
  nextVariant: "primary" | "neutral";
  nextDisabled: boolean;
  loading: boolean;
  hasCharter: boolean;
  /** Rendered in the right sidebar bottom slot (e.g. AI Assist) */
  rightBottom?: ReactNode;
  /** When set, expands bottom section to fill and caps Suggestions height. */
  rightBottomExpanded?: ReactNode;

  // Shortcuts — skip directly to dataset / scorers / both. Each ensures
  // the charter exists first (regenerates if needed). Async so the panel
  // can show a spinner while the downstream work runs in the background.
  onGenerateDataset?: () => Promise<void>;
  onGenerateScorers?: () => Promise<void>;
  onGenerateBoth?: () => Promise<void>;
  generatingDataset?: boolean;
  generatingScorers?: boolean;
  generatingBoth?: boolean;
}

export default function UsersPanel({
  storyGroups,
  onStoryGroupsChange,
  onStoryCommit,
  suggestedStories,
  onAcceptStory,
  onDismissStory,
  storySuggestionsLoading,
  onBackToGoals,
  onNext,
  nextLabel,
  nextVariant,
  nextDisabled,
  loading,
  hasCharter,
  rightBottom,
  rightBottomExpanded,
  onGenerateDataset,
  onGenerateScorers,
  onGenerateBoth,
  generatingDataset,
  generatingScorers,
  generatingBoth,
}: Props) {
  // Track which roles have been committed (Enter pressed)
  const [committedRoles, setCommittedRoles] = useState<Set<number>>(new Set());

  // Active tab index — tracks which committed role is shown
  const [activeRoleIndex, setActiveRoleIndex] = useState<number>(0);

  // Whether we're showing the "add new role" input instead of a role's stories
  const [addingRole, setAddingRole] = useState(false);

  // Horizontal scroll state for the role tab bar
  const tabScrollRef = useRef<HTMLDivElement | null>(null);
  const tabButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = () => {
    const el = tabScrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };

  useEffect(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener("scroll", updateScrollState, { passive: true });
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateScrollState);
      ro.disconnect();
    };
  }, []);

  // Keep the active tab fully in view when it changes
  useEffect(() => {
    const btn = tabButtonRefs.current.get(activeRoleIndex);
    btn?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
    // Re-check scroll arrows once the smooth scroll settles
    const t = window.setTimeout(updateScrollState, 400);
    return () => window.clearTimeout(t);
  }, [activeRoleIndex, addingRole]);

  // Refresh scroll-arrow visibility when the tab set itself changes
  useEffect(() => {
    updateScrollState();
  }, [committedRoles.size, storyGroups.length]);

  const scrollTabs = (direction: "left" | "right") => {
    const el = tabScrollRef.current;
    if (!el) return;
    const delta = Math.max(120, Math.floor(el.clientWidth * 0.6));
    el.scrollBy({ left: direction === "left" ? -delta : delta, behavior: "smooth" });
  };

  // Drag state for within-group story reorder
  const [storyDragState, setStoryDragState] = useState<{
    groupIndex: number;
    dragIndex: number;
    dragOverIndex: number | null;
  } | null>(null);

  const handleStoryDragStart = (gi: number, si: number) => {
    setStoryDragState({ groupIndex: gi, dragIndex: si, dragOverIndex: null });
  };
  const handleStoryDragOver = (gi: number, si: number, e: React.DragEvent) => {
    e.preventDefault();
    if (storyDragState && storyDragState.groupIndex === gi) {
      setStoryDragState({ ...storyDragState, dragOverIndex: si });
    }
  };
  const handleStoryDrop = (gi: number, si: number) => {
    if (!storyDragState || storyDragState.groupIndex !== gi || storyDragState.dragIndex === si) {
      setStoryDragState(null);
      return;
    }
    const updated = [...storyGroups];
    const stories = [...updated[gi].stories];
    const [moved] = stories.splice(storyDragState.dragIndex, 1);
    stories.splice(si, 0, moved);
    updated[gi] = { ...updated[gi], stories };
    onStoryGroupsChange(updated);
    setStoryDragState(null);
  };
  const handleStoryDragEnd = () => {
    setStoryDragState(null);
  };

  // Inline edit state for a committed role title (in-tab editing)
  const [editingRole, setEditingRole] = useState<{
    gi: number;
    value: string;
  } | null>(null);
  const editRoleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editingRole) return;
    requestAnimationFrame(() => {
      editRoleRef.current?.focus();
      editRoleRef.current?.select();
    });
  }, [editingRole?.gi]);

  const startEditRole = (gi: number) => {
    setEditingRole({ gi, value: storyGroups[gi].role });
  };

  const commitEditRole = () => {
    if (!editingRole || !editingRole.value.trim()) return;
    updateRole(editingRole.gi, editingRole.value.trim());
    setEditingRole(null);
  };

  // Inline edit state for a committed story
  const [editingStory, setEditingStory] = useState<{
    gi: number;
    si: number;
    what: string;
    why: string;
    focusField: "what" | "why";
  } | null>(null);
  const editWhatRef = useRef<HTMLInputElement | null>(null);
  const editWhyRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editingStory) return;
    requestAnimationFrame(() => {
      if (editingStory.focusField === "why") editWhyRef.current?.focus();
      else editWhatRef.current?.focus();
    });
  }, [editingStory?.gi, editingStory?.si, editingStory?.focusField]);

  const startEditStory = (gi: number, si: number, field: "what" | "why") => {
    const s = storyGroups[gi]?.stories[si];
    if (!s) return;
    setEditingStory({ gi, si, what: s.what, why: s.why, focusField: field });
  };

  const cancelEditStory = () => setEditingStory(null);

  const commitEditStory = () => {
    if (!editingStory) return;
    if (!editingStory.what.trim()) return;
    const { gi, si } = editingStory;
    const updated = [...storyGroups];
    const stories = [...updated[gi].stories];
    stories[si] = {
      what: editingStory.what.trim(),
      why: editingStory.why.trim(),
    };
    updated[gi] = { ...updated[gi], stories };
    onStoryGroupsChange(updated);
    setEditingStory(null);
  };

  // Local draft state for each role's compose row
  const [composeDraft, setComposeDraft] = useState<
    Record<number, { what: string; why: string }>
  >({});
  const getDraft = (gi: number) => composeDraft[gi] ?? { what: "", why: "" };
  const updateDraft = (gi: number, field: "what" | "why", value: string) => {
    setComposeDraft((prev) => ({
      ...prev,
      [gi]: { ...getDraft(gi), [field]: value },
    }));
  };
  const submitDraft = (gi: number) => {
    const draft = getDraft(gi);
    if (!draft.what.trim()) return;
    const updated = [...storyGroups];
    const stories = [
      ...updated[gi].stories.filter((s) => s.what.trim()),
      { what: draft.what.trim(), why: draft.why.trim() },
    ];
    updated[gi] = { ...updated[gi], stories };
    onStoryGroupsChange(updated);
    setComposeDraft((prev) => ({ ...prev, [gi]: { what: "", why: "" } }));
    onStoryCommit();
  };

  // Role input ref for the "add new role" flow
  const newRoleInputRef = useRef<HTMLInputElement | null>(null);
  const [newRoleName, setNewRoleName] = useState("");

  useEffect(() => {
    if (addingRole) {
      requestAnimationFrame(() => newRoleInputRef.current?.focus());
    }
  }, [addingRole]);

  // Auto-commit roles that have content from outside (e.g. accepted suggestions)
  useEffect(() => {
    setCommittedRoles((prev) => {
      let changed = false;
      const next = new Set(prev);
      storyGroups.forEach((g, i) => {
        if (
          g.role.trim() &&
          g.stories.some((s) => s.what.trim()) &&
          !next.has(i)
        ) {
          next.add(i);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [storyGroups]);

  // If the first group has no committed role yet and has a role name, show the role input
  // Otherwise keep active index in bounds
  useEffect(() => {
    const committedIndices = Array.from(committedRoles).sort((a, b) => a - b);
    if (committedIndices.length > 0 && !committedRoles.has(activeRoleIndex)) {
      setActiveRoleIndex(committedIndices[0]);
    }
  }, [committedRoles, activeRoleIndex]);

  const hasStories = storyGroups.some(
    (g) => g.role.trim() && g.stories.some((s) => s.what.trim()),
  );

  const updateRole = (gi: number, role: string) => {
    const updated = [...storyGroups];
    updated[gi] = { ...updated[gi], role };
    onStoryGroupsChange(updated);
  };

  const removeRole = (gi: number) => {
    // Rebuild committed set with shifted indices
    setCommittedRoles((prev) => {
      const next = new Set<number>();
      for (const idx of prev) {
        if (idx < gi) next.add(idx);
        else if (idx > gi) next.add(idx - 1);
      }
      return next;
    });

    if (storyGroups.length <= 1) {
      onStoryGroupsChange([{ role: "", stories: [{ what: "", why: "" }] }]);
      setActiveRoleIndex(0);
      setAddingRole(true);
      return;
    }

    const newGroups = storyGroups.filter((_, i) => i !== gi);
    onStoryGroupsChange(newGroups);

    // Pick the nearest remaining committed role
    const newCommitted = new Set<number>();
    for (const idx of committedRoles) {
      if (idx < gi) newCommitted.add(idx);
      else if (idx > gi) newCommitted.add(idx - 1);
    }
    const remaining = Array.from(newCommitted).sort((a, b) => a - b);
    if (remaining.length > 0) {
      const newActive = remaining.find((i) => i >= gi) ?? remaining[remaining.length - 1];
      setActiveRoleIndex(newActive);
    } else {
      setActiveRoleIndex(0);
      setAddingRole(true);
    }
  };

  const removeStory = (gi: number, si: number) => {
    const updated = [...storyGroups];
    const stories = updated[gi].stories.filter((_, i) => i !== si);
    if (stories.length === 0) stories.push({ what: "", why: "" });
    updated[gi] = { ...updated[gi], stories };
    onStoryGroupsChange(updated);
  };

  const handleNewRoleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!newRoleName.trim()) return;
      commitNewRole();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setAddingRole(false);
      setNewRoleName("");
    }
  };

  const commitNewRole = () => {
    if (!newRoleName.trim()) return;

    // Check if there's an uncommitted empty group we can reuse
    const emptyIndex = storyGroups.findIndex(
      (g, i) => !committedRoles.has(i) && !g.role.trim(),
    );

    let targetIndex: number;
    if (emptyIndex >= 0) {
      // Reuse the empty slot
      const updated = [...storyGroups];
      updated[emptyIndex] = { role: newRoleName.trim(), stories: [{ what: "", why: "" }] };
      onStoryGroupsChange(updated);
      targetIndex = emptyIndex;
    } else {
      // Add a new group
      targetIndex = storyGroups.length;
      onStoryGroupsChange([
        ...storyGroups,
        { role: newRoleName.trim(), stories: [{ what: "", why: "" }] },
      ]);
    }

    setCommittedRoles((prev) => new Set(prev).add(targetIndex));
    setActiveRoleIndex(targetIndex);
    setAddingRole(false);
    setNewRoleName("");
  };

  // Build the list of committed role indices for the tab bar
  const committedIndices = storyGroups
    .map((g, i) => ({ index: i, role: g.role }))
    .filter((r) => committedRoles.has(r.index) && r.role.trim());

  // If there are no committed roles at all, show the initial role input
  const showInitialRoleInput = committedIndices.length === 0 && !addingRole;

  // The initial (first-time) role input for when there are no roles yet
  const initialRoleInputRef = useRef<HTMLInputElement | null>(null);
  const [initialRoleName, setInitialRoleName] = useState(
    storyGroups[0]?.role ?? "",
  );

  // Keep initialRoleName in sync if storyGroups changes externally
  useEffect(() => {
    if (showInitialRoleInput && storyGroups[0]) {
      setInitialRoleName(storyGroups[0].role);
    }
  }, [showInitialRoleInput, storyGroups]);

  const handleInitialRoleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!initialRoleName.trim()) return;
      const updated = [...storyGroups];
      updated[0] = { ...updated[0], role: initialRoleName.trim() };
      onStoryGroupsChange(updated);
      setCommittedRoles((prev) => new Set(prev).add(0));
      setActiveRoleIndex(0);
    }
  };

  return (
    <PanelLayout
      title="User Stories"
      subtitle="Define your users and what they do"
      rightBottom={rightBottom}
      rightBottomExpanded={rightBottomExpanded}
      right={
        <SuggestionBox
          onRefresh={hasStories ? onStoryCommit : undefined}
          loading={storySuggestionsLoading}
          emptyText={
            hasStories
              ? "Press Enter after a story to get suggestions"
              : "Enter a business goal to see suggestions."
          }
        >
          {suggestedStories.length > 0
            ? suggestedStories.map((story, i) => (
                <SuggestionCard
                  key={i}
                  onAccept={() => onAcceptStory(story)}
                  onDismiss={() => onDismissStory(story)}
                >
                  <div className="flex flex-col gap-2">
                    <span className="self-start bg-gray-150 text-fg-contrast text-base leading-[1.5] px-1">
                      {story.who}
                    </span>
                    <div>
                      <p className="text-base text-fg-contrast leading-[1.5]">
                        {story.what}
                      </p>
                      {story.why && (
                        <p className="text-base text-fg-dim leading-[1.5]">
                          {story.why}
                        </p>
                      )}
                    </div>
                  </div>
                </SuggestionCard>
              ))
            : null}
        </SuggestionBox>
      }
      footer={
        (onGenerateDataset || onGenerateScorers || onGenerateBoth) && storyGroups.some(g => g.stories.some(s => s.what.trim())) ? (
          // Replaces the old single "Review charter" button. Three actions
          // covering the common paths out of the User Stories screen.
          <div className="flex flex-wrap gap-2 justify-end">
            {onGenerateDataset && (
              <Button
                size="big"
                variant="neutral"
                onClick={() => void onGenerateDataset()}
                disabled={!!(generatingDataset || generatingBoth || generatingScorers)}
              >
                {generatingDataset ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                Generate dataset
              </Button>
            )}
            {onGenerateScorers && (
              <Button
                size="big"
                variant="neutral"
                onClick={() => void onGenerateScorers()}
                disabled={!!(generatingScorers || generatingBoth || generatingDataset)}
              >
                {generatingScorers ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                Generate scorers
              </Button>
            )}
            {onGenerateBoth && (
              <Button
                size="big"
                variant="primary"
                onClick={() => void onGenerateBoth()}
                disabled={!!(generatingBoth || generatingDataset || generatingScorers)}
              >
                {generatingBoth ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                Generate dataset and scorers
              </Button>
            )}
          </div>
        ) : (
          // Fallback when shortcut handlers aren't wired in (scratch mode, etc).
          <Button
            size="big"
            variant={nextVariant}
            shortcut={<CmdReturnIcon />}
            onClick={onNext}
            disabled={nextDisabled}
          >
            {loading ? "Generating..." : nextLabel}
          </Button>
        )
      }
    >
      {/* Initial role input — only when no roles committed yet */}
      {showInitialRoleInput && (
        <div>
          <Input
            ref={initialRoleInputRef}
            type="text"
            value={initialRoleName}
            onChange={(e) => {
              setInitialRoleName(e.target.value);
              // Also update the storyGroup so external state stays in sync
              const updated = [...storyGroups];
              updated[0] = { ...updated[0], role: e.target.value };
              onStoryGroupsChange(updated);
            }}
            onKeyDown={handleInitialRoleKeyDown}
            placeholder="User role (e.g. recruiter, hiring manager...)"
          />
        </div>
      )}

      {/* Tab bar + content — only when at least one role is committed */}
      {committedIndices.length > 0 && (
        <div className="flex flex-col gap-6">
          {/* Tab bar */}
          <div className="flex items-stretch border-b-2 border-border-hint">
            {canScrollLeft && (
              <button
                onClick={() => scrollTabs("left")}
                className="flex-shrink-0 flex items-center justify-center px-2 text-fg-dim hover:text-fg-contrast hover:bg-fill-neutral/30 transition-colors"
                title="Scroll tabs left"
                aria-label="Scroll tabs left"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            )}
            <div
              ref={tabScrollRef}
              className="flex-1 min-w-0 overflow-x-auto flex items-stretch scrollbar-none"
              style={{ scrollbarWidth: "none" }}
            >
              {committedIndices.map(({ index, role }) => {
                const isActive = activeRoleIndex === index && !addingRole;
                const isEditingThis = editingRole?.gi === index;

                return (
                  <button
                    key={index}
                    ref={(el) => {
                      if (el) tabButtonRefs.current.set(index, el);
                      else tabButtonRefs.current.delete(index);
                    }}
                    onClick={() => {
                      if (!isEditingThis) {
                        setActiveRoleIndex(index);
                        setAddingRole(false);
                      }
                    }}
                    className={`group flex-shrink-0 flex items-center gap-2 py-3 px-4 text-base font-medium whitespace-nowrap transition-colors ${
                      isActive
                        ? "bg-fill-neutral text-fg-contrast"
                        : "text-fg-dim hover:text-fg-contrast"
                    }`}
                  >
                    {isEditingThis ? (
                      <input
                        ref={editRoleRef}
                        value={editingRole.value}
                        onChange={(e) =>
                          setEditingRole({ ...editingRole, value: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEditRole();
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingRole(null);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="bg-transparent text-base font-medium text-fg-contrast focus:outline-none caret-purple-700 min-w-0"
                        style={{ width: `${Math.max(4, editingRole.value.length + 1)}ch` }}
                      />
                    ) : (
                      <>
                        {role}
                        <span
                          className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <IconButton
                            tone="dim"
                            onClick={() => startEditRole(index)}
                            title="Edit role"
                          >
                            <PencilIcon />
                          </IconButton>
                          <IconButton
                            tone="dim"
                            onClick={() => removeRole(index)}
                            title="Remove role"
                          >
                            <CloseIcon />
                          </IconButton>
                        </span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
            {canScrollRight && (
              <button
                onClick={() => scrollTabs("right")}
                className="flex-shrink-0 flex items-center justify-center px-2 text-fg-dim hover:text-fg-contrast hover:bg-fill-neutral/30 transition-colors"
                title="Scroll tabs right"
                aria-label="Scroll tabs right"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
            {/* Add user tab button — always visible, pinned right */}
            <button
              onClick={() => {
                setAddingRole(true);
                setNewRoleName("");
              }}
              className={`flex-shrink-0 flex items-center gap-1 py-3 px-4 text-base font-medium whitespace-nowrap transition-colors ${
                addingRole
                  ? "bg-fill-neutral text-fg-contrast"
                  : "text-fg-dim hover:text-fg-contrast"
              }`}
            >
              <PlusIcon />
              Add user
            </button>
          </div>

          {/* Tab content */}
          {addingRole ? (
            <div>
              <Input
                ref={newRoleInputRef}
                type="text"
                value={newRoleName}
                onChange={(e) => setNewRoleName(e.target.value)}
                onKeyDown={handleNewRoleKeyDown}
                placeholder="User role (e.g. recruiter, hiring manager...)"
              />
            </div>
          ) : (
            committedRoles.has(activeRoleIndex) &&
            storyGroups[activeRoleIndex] && (
              <RoleContent
                gi={activeRoleIndex}
                group={storyGroups[activeRoleIndex]}
                draft={getDraft(activeRoleIndex)}
                updateDraft={updateDraft}
                submitDraft={submitDraft}
                editingStory={editingStory}
                setEditingStory={setEditingStory}
                startEditStory={startEditStory}
                cancelEditStory={cancelEditStory}
                commitEditStory={commitEditStory}
                editWhatRef={editWhatRef}
                editWhyRef={editWhyRef}
                removeStory={removeStory}
                storyDragState={storyDragState}
                handleStoryDragStart={handleStoryDragStart}
                handleStoryDragOver={handleStoryDragOver}
                handleStoryDrop={handleStoryDrop}
                handleStoryDragEnd={handleStoryDragEnd}
              />
            )
          )}
        </div>
      )}

    </PanelLayout>
  );
}

/* ── StoryRowWrapper: provides click-outside-to-cancel for story editing ── */

function StoryRowWrapper({
  isEditing,
  onClickOutside,
  children,
}: {
  isEditing: boolean;
  onClickOutside: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isEditing) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClickOutside();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isEditing, onClickOutside]);

  return <div ref={ref}>{children}</div>;
}

/* ── RoleContent: compose row + committed stories for a single role ── */

function RoleContent({
  gi,
  group,
  draft,
  updateDraft,
  submitDraft,
  editingStory,
  setEditingStory,
  startEditStory,
  cancelEditStory,
  commitEditStory,
  editWhatRef,
  editWhyRef,
  removeStory,
  storyDragState,
  handleStoryDragStart,
  handleStoryDragOver,
  handleStoryDrop,
  handleStoryDragEnd,
}: {
  gi: number;
  group: StoryGroup;
  draft: { what: string; why: string };
  updateDraft: (gi: number, field: "what" | "why", value: string) => void;
  submitDraft: (gi: number) => void;
  editingStory: {
    gi: number;
    si: number;
    what: string;
    why: string;
    focusField: "what" | "why";
  } | null;
  setEditingStory: React.Dispatch<
    React.SetStateAction<{
      gi: number;
      si: number;
      what: string;
      why: string;
      focusField: "what" | "why";
    } | null>
  >;
  startEditStory: (gi: number, si: number, field: "what" | "why") => void;
  cancelEditStory: () => void;
  commitEditStory: () => void;
  editWhatRef: React.MutableRefObject<HTMLInputElement | null>;
  editWhyRef: React.MutableRefObject<HTMLInputElement | null>;
  removeStory: (gi: number, si: number) => void;
  storyDragState: {
    groupIndex: number;
    dragIndex: number;
    dragOverIndex: number | null;
  } | null;
  handleStoryDragStart: (gi: number, si: number) => void;
  handleStoryDragOver: (gi: number, si: number, e: React.DragEvent) => void;
  handleStoryDrop: (gi: number, si: number) => void;
  handleStoryDragEnd: () => void;
}) {
  const committedStories = group.stories.filter((s) => s.what.trim());
  const draftChanged = draft.what.trim().length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Compose row */}
      <div className="flex items-stretch gap-4">
        <Input
          value={draft.what}
          onChange={(e) => updateDraft(gi, "what", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitDraft(gi);
            }
          }}
          placeholder={`As a ${group.role}, I'd like to...`}
        />
        <Input
          value={draft.why}
          onChange={(e) => updateDraft(gi, "why", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitDraft(gi);
            }
          }}
          placeholder="so that... (optional)"
        />
        <Button
          size="big"
          variant={draftChanged ? "primary" : "neutral"}
          shortcut={<ReturnKeyIcon />}
          onClick={() => submitDraft(gi)}
          disabled={!draftChanged}
        >
          Submit
        </Button>
      </div>

      {/* Committed stories */}
      {committedStories.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {committedStories.map((story, si) => {
            const isEditing =
              editingStory?.gi === gi && editingStory.si === si;
            const dragEnabled = committedStories.length > 1;
            const isStoryDragging =
              storyDragState?.groupIndex === gi &&
              storyDragState.dragIndex === si;
            const showStoryDropIndicator =
              storyDragState?.groupIndex === gi &&
              storyDragState.dragOverIndex === si &&
              storyDragState.dragIndex !== si;
            const changed = isEditing
              ? editingStory.what.trim() !== story.what.trim() ||
                editingStory.why.trim() !== story.why.trim()
              : false;

            const editKeyDown = (e: React.KeyboardEvent) => {
              if (e.key === "Enter") { e.preventDefault(); commitEditStory(); }
              if (e.key === "Escape") { e.preventDefault(); cancelEditStory(); }
            };

            return (
              <div key={si}>
                {showStoryDropIndicator && (
                  <div className="h-0.5 -my-px bg-purple-700 relative z-10" />
                )}
                <StoryRowWrapper
                  isEditing={isEditing}
                  onClickOutside={cancelEditStory}
                >
                  <div
                    draggable={!isEditing && dragEnabled}
                    onDragStart={() => handleStoryDragStart(gi, si)}
                    onDragOver={(e) => handleStoryDragOver(gi, si, e)}
                    onDrop={() => handleStoryDrop(gi, si)}
                    onDragEnd={handleStoryDragEnd}
                    className={`group flex items-center gap-4 px-4 py-4 ${
                      story.kind === "off_target"
                        ? "bg-warning/10 border-l-2 border-warning"
                        : "bg-fill-neutral"
                    } ${isStoryDragging ? "opacity-30" : ""}`}
                  >
                    {story.kind === "off_target" && !isEditing && (
                      <span
                        className="flex-shrink-0 text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 bg-warning/20 text-warning"
                        title="Off-target: the skill should NOT fire on this"
                      >
                        Off-target
                      </span>
                    )}
                    {isEditing ? (
                      <input
                        ref={editWhatRef}
                        value={editingStory.what}
                        onChange={(e) => setEditingStory({ ...editingStory, what: e.target.value })}
                        onKeyDown={editKeyDown}
                        placeholder="I want to..."
                        className="flex-1 min-w-0 bg-transparent text-base text-gray-900 leading-[1.5] placeholder:text-gray-550 focus:outline-none caret-purple-700"
                      />
                    ) : (
                      <p
                        onClick={() => startEditStory(gi, si, "what")}
                        className="flex-1 text-base text-gray-900 leading-[1.5] min-w-0 cursor-pointer"
                      >
                        {story.what}
                      </p>
                    )}
                    {isEditing ? (
                      <input
                        ref={editWhyRef}
                        value={editingStory.why}
                        onChange={(e) => setEditingStory({ ...editingStory, why: e.target.value })}
                        onKeyDown={editKeyDown}
                        placeholder="so that... (optional)"
                        className="flex-1 min-w-0 bg-transparent text-base text-gray-550 leading-[1.5] placeholder:text-gray-550 focus:outline-none caret-purple-700"
                      />
                    ) : (
                      <p
                        onClick={() => startEditStory(gi, si, "why")}
                        className="flex-1 text-base text-gray-550 leading-[1.5] min-w-0 cursor-pointer"
                      >
                        {story.why}
                      </p>
                    )}
                    {isEditing ? (
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Button size="small" variant="neutral" onClick={cancelEditStory}>
                          Cancel
                        </Button>
                        <Button
                          size="small"
                          variant={changed && editingStory.what.trim() ? "primary" : "neutral"}
                          shortcut={<ReturnKeyIcon />}
                          onClick={commitEditStory}
                          disabled={!editingStory.what.trim() || !changed}
                        >
                          Submit
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <IconButton
                          tone="dim"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeStory(gi, si);
                          }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <CloseIcon />
                        </IconButton>
                        <div
                          className={`w-10 h-10 flex items-center justify-center flex-shrink-0 transition-colors ${
                            dragEnabled
                              ? "text-fg-dim hover:text-fg-contrast cursor-grab"
                              : "text-fg-dim/30 cursor-default"
                          }`}
                        >
                          <DragHandleIcon />
                        </div>
                      </div>
                    )}
                  </div>
                </StoryRowWrapper>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
