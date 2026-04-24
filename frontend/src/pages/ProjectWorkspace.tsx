import { useState, useCallback, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Upload, Loader2 } from "lucide-react";
import {
  GearIcon,
  ChatBubbleIcon,
  CloseIcon,
  AIIcon,
  StarIcon,
  GoalsIcon,
  UsersIcon,
  CharterIcon,
  DatasetIcon,
  ScorerIcon,
} from "../components/ui/Icons";
import type {
  Message,
  SessionState,
  AgentStatus,
  StoryGroup,
  Suggestion,
  SuggestedStory,
  Dataset,
  Example,
  GapAnalysis,
  ScorerDef,
  AlignmentEntry,
} from "../types";
import {
  createSession,
  getSession,
  sendMessage,
  patchCharter,
  finalizeCharter,
  validateCharter,
  suggestForCharter,
  suggestGoals,
  evaluateGoals,
  suggestStories,
  createDataset,
  getDataset,
  synthesizeExamples,
  updateExample as apiUpdateExample,
  deleteExample as apiDeleteExample,
  autoReviewExamples,
  getGapAnalysis,
  exportDataset,
  datasetChat,
  updateSessionName,
  updateSessionInput,
  saveScorers,
  generateScorers,
  suggestRevisions,
  getActivity,
  listSessions,
} from "../api";
import Button from "../components/ui/Button";
import IconButton from "../components/ui/IconButton";
import GoalsPanel from "../components/GoalsPanel";
import UsersPanel from "../components/UsersPanel";
import CharterPanel from "../components/CharterPanel";
import ScorersPanel from "../components/ScorersPanel";
import EvaluatePanel from "../components/EvaluatePanel";
import ImprovePanel from "../components/ImprovePanel";
import SkillPanel from "../components/SkillPanel";
import RegenerateBanner from "../components/RegenerateBanner";
import ConversationPanel from "../components/ConversationPanel";
import ExampleReview from "../components/ExampleReview";
import CoverageMap from "../components/CoverageMap";
import SettingsPanel from "../components/SettingsPanel";

type ActiveTab =
  | "skill"
  | "goals"
  | "users"
  | "charter"
  | "dataset"
  | "scorers"
  | "evaluate"
  | "improve";

const EMPTY_STATE: SessionState = {
  session_id: "",
  input: { business_goals: null, user_stories: null, conversation_history: [] },
  charter: {
    task: {
      input_description: "",
      output_description: "",
      sample_input: null,
      sample_output: null,
    },
    coverage: { criteria: [], status: "pending" },
    balance: { criteria: [], status: "pending" },
    alignment: [],
    rot: { criteria: [], status: "pending" },
  },
  validation: {
    coverage: "untested",
    balance: "untested",
    alignment: [],
    rot: "untested",
    overall: "untested",
  },
  rounds_of_questions: 0,
  agent_status: "drafting",
};

const ACTIVITY_LABELS: Record<string, string> = {
  discovery: "Thinking about your input",
  generate: "Generating charter draft",
  validate: "Validating criteria",
  suggest: "Generating suggestions",
  synthesize: "Synthesizing examples",
  review: "Auto-reviewing examples",
  gap_analysis: "Analyzing coverage gaps",
  enrich: "Enriching examples",
  detect_schema: "Detecting schema",
  import_from_url: "Importing from URL",
  infer_schema: "Inferring schema",
  generate_scorers: "Generating scorers",
  suggest_revisions: "Suggesting revisions",
};

function activityLabel(turnType: string): string | null {
  // chat/dataset_chat are already surfaced as assistant messages — skip as hints
  if (turnType === "chat" || turnType === "dataset_chat") return null;
  return ACTIVITY_LABELS[turnType] || null;
}

function formatStoryGroups(groups: StoryGroup[]): string {
  return groups
    .filter((g) => g.role.trim())
    .flatMap((g) =>
      g.stories
        .filter((s) => s.what.trim())
        .map((s) => {
          let line = `As a ${g.role.trim()}, I want to ${s.what.trim()}`;
          if (s.why.trim()) line += ` so that ${s.why.trim()}`;
          return line;
        }),
    )
    .join("\n");
}

export default function ProjectWorkspace() {
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  // --- Navigation ---
  const [activeTab, setActiveTab] = useState<ActiveTab>("goals");
  const [showAssistant, setShowAssistant] = useState(false);

  // --- Project metadata ---
  const [projectName, setProjectName] = useState("Untitled project");
  const [editingName, setEditingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // --- Shared state ---
  const [sessionId, setSessionId] = useState<string | null>(
    urlSessionId || null,
  );
  const [state, setState] = useState<SessionState>(EMPTY_STATE);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hydrating, setHydrating] = useState(!!urlSessionId);

  // --- Goals state ---
  const [goals, setGoals] = useState<string[]>([""]);
  const [goalSuggestions, setGoalSuggestions] = useState<string[]>([]);
  const [goalSuggestionsLoading, setGoalSuggestionsLoading] = useState(false);
  const [goalFeedback, setGoalFeedback] = useState<
    Array<{ goal: string; issue: string | null; suggestion: string | null }>
  >([]);
  const [goalFeedbackLoading, setGoalFeedbackLoading] = useState(false);

  // --- Story suggestion state ---
  const [storySuggestionsLoading, setStorySuggestionsLoading] = useState(false);

  // --- Charter phase state ---
  const [activeCriteria, setActiveCriteria] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestedStories, setSuggestedStories] = useState<SuggestedStory[]>(
    [],
  );
  const [storyGroups, setStoryGroups] = useState<StoryGroup[]>([
    { role: "", stories: [{ what: "", why: "" }] },
  ]);

  // --- Input change tracking for regenerate button ---
  const [, setSavedInput] = useState<{ goals: string; stories: string } | null>(
    null,
  );

  // --- Dirty tracking: has a section changed since the next section was last touched? ---
  const [goalsDirty, setGoalsDirty] = useState(false);
  const [storiesDirty, setStoriesDirty] = useState(false);
  const [charterDirty, setCharterDirty] = useState(false);

  // --- Dataset phase state ---
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [actionSuggestions, setActionSuggestions] = useState<
    Array<{ action: string; label: string; reason: string }>
  >([]);

  // --- Scorers state (lifted up for persistence across tab switches) ---
  const [scorers, setScorers] = useState<ScorerDef[]>([]);

  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [gapAnalysis, setGapAnalysis] = useState<GapAnalysis | null>(null);
  const [showCoverageMap, setShowCoverageMap] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // --- Polaris activity feed (polled while drawer open) ---
  const activityCursorRef = useRef<string | null>(null);
  const seenActivityIdsRef = useRef<Set<string>>(new Set());

  // --- Hydration: load existing session from DB ---
  useEffect(() => {
    if (!urlSessionId) {
      setHydrating(false);
      return;
    }

    const hydrate = async () => {
      try {
        const session = await getSession(urlSessionId);
        const s = session.state as SessionState;
        setSessionId(urlSessionId);
        setState(s);
        setMessages(
          session.conversation?.map((m: { role: string; content: string }) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })) || [],
        );

        // Restore structured goals/stories if available
        if (s.input.goals && s.input.goals.length > 0) {
          setGoals([...s.input.goals, ""]);
        } else if (s.input.business_goals) {
          setGoals([
            ...s.input.business_goals.split("\n").filter((g) => g.trim()),
            "",
          ]);
        }

        if (s.input.story_groups && s.input.story_groups.length > 0) {
          setStoryGroups(s.input.story_groups as StoryGroup[]);
        }

        // Restore project name
        if ((session as { name?: string }).name)
          setProjectName((session as { name?: string }).name!);

        // Restore scorers
        if (s.scorers && s.scorers.length > 0) {
          setScorers(s.scorers);
        }

        // Determine active tab
        const hasCharter = !!(
          s.charter.coverage.criteria.length || s.charter.alignment.length
        );
        const hasSkillBody = !!s.charter.task.skill_body;
        const isTriggered = s.eval_mode === "triggered";

        // Try to load dataset. For skill-mode sessions that haven't built a
        // charter yet, land on the Skill tab so the user sees what they just
        // pasted — not the empty goals screen. Brand-new triggered sessions
        // (no skill body yet) also land on Skill so the paste form is the
        // first thing the user sees.
        try {
          const ds = await getDataset(urlSessionId);
          setDataset(ds);
          if (ds.examples?.length > 0) {
            setActiveTab("dataset");
          } else if (hasCharter) {
            setActiveTab("charter");
          } else if (hasSkillBody || isTriggered) {
            setActiveTab("skill");
          }
        } catch {
          // No dataset yet
          if (hasCharter) {
            setActiveTab("charter");
          } else if (hasSkillBody || isTriggered) {
            setActiveTab("skill");
          } else if (s.input.story_groups && s.input.story_groups.length > 0) {
            setActiveTab("users");
          }
        }

        if (s.input.business_goals || s.input.user_stories) {
          setSavedInput({
            goals: s.input.business_goals || "",
            stories: s.input.user_stories || "",
          });
        }
      } catch (err) {
        console.error("Failed to load project:", err);
        navigate("/", { replace: true });
      } finally {
        setHydrating(false);
      }
    };
    hydrate();
  }, [urlSessionId, navigate]);

  const status: AgentStatus = state.agent_status;
  const hasCharter = !!(
    state.charter.coverage.criteria.length || state.charter.alignment.length
  );
  const nonEmptyGoals = goals.filter((g) => g.trim());
  const totalStoryCount = storyGroups.reduce(
    (sum, g) =>
      sum + (g.role.trim() ? g.stories.filter((s) => s.what.trim()).length : 0),
    0,
  );

  // Tab availability. In triggered mode, no tab downstream of Skill opens
  // until the user has pasted + seeded a SKILL.md. This makes the empty
  // Skill tab the only interactive surface on a brand-new skill session —
  // mirroring the old standalone "new skill eval" page while keeping the
  // user in the project workspace throughout.
  const isTriggered = state.eval_mode === "triggered";
  const skillReady = !!state.charter.task.skill_body || !isTriggered;
  const usersAvailable = skillReady && nonEmptyGoals.length >= 2;
  const charterAvailable = skillReady && (hasCharter || loading);
  const datasetAvailable = skillReady && hasCharter;
  const scorersAvailable = skillReady && hasCharter;
  const evaluateAvailable = skillReady && !!dataset;

  // When the user clicks "Run evaluations" on the Improve tab, we switch to
  // the Evaluations tab AND kick off a run immediately using the previous
  // run's config. EvaluatePanel consumes this signal + calls the reset cb.
  const [evalAutoRun, setEvalAutoRun] = useState(false);
  // Inverse direction: "Improve skill" on Evaluations switches to Improve AND
  // fires Analyze on the latest completed run.
  const [improveAutoAnalyze, setImproveAutoAnalyze] = useState(false);
  // Generation shortcuts on the Users tab. Independent spinners so the
  // "both" button reflects its own parallel run, not a false positive from
  // clicking the single-action ones while that's in flight.
  const [generatingDataset, setGeneratingDataset] = useState(false);
  const [generatingScorersShortcut, setGeneratingScorersShortcut] = useState(false);
  const [generatingBoth, setGeneratingBoth] = useState(false);

  // Skill-version lineage for "Regenerate" banners on downstream tabs.
  const skillVersions = state.skill_versions || [];
  const activeSkillVersionId = state.active_skill_version_id || null;
  const activeSkillVersion = skillVersions.find(v => v.id === activeSkillVersionId) || skillVersions[skillVersions.length - 1] || null;
  const lineageFor = (artifact: string): number | null => {
    const sourceId = state.generated_at_skill_version?.[artifact];
    if (!sourceId) return null;
    const v = skillVersions.find(x => x.id === sourceId);
    return v?.version ?? null;
  };
  const activeSkillVersionNum = activeSkillVersion?.version ?? null;

  // --- Project name ---
  const startEditingName = () => {
    setEditingName(true);
    requestAnimationFrame(() => nameInputRef.current?.select());
  };

  const saveName = async () => {
    setEditingName(false);
    if (sessionId && projectName.trim()) {
      updateSessionName(sessionId, projectName.trim()).catch((err) => {
        console.error("Failed to save project name:", err);
      });
    }
  };

  // --- Auto-save goals/stories to DB ---
  const saveInputDebounceRef = useRef<number | null>(null);

  const scheduleSaveInput = useCallback(() => {
    if (!sessionId) return;
    if (saveInputDebounceRef.current) {
      window.clearTimeout(saveInputDebounceRef.current);
    }
    saveInputDebounceRef.current = window.setTimeout(() => {
      saveInputDebounceRef.current = null;
      const nonEmpty = goals.filter((g) => g.trim());
      const groups = storyGroups.filter((g) => g.role.trim());
      if (nonEmpty.length > 0 || groups.length > 0) {
        updateSessionInput(sessionId!, {
          goals: nonEmpty,
          story_groups: groups,
        }).catch((err) => {
          console.error("Failed to auto-save input:", err);
        });
      }
    }, 2000);
  }, [sessionId, goals, storyGroups]);

  useEffect(() => {
    return () => {
      if (saveInputDebounceRef.current) {
        window.clearTimeout(saveInputDebounceRef.current);
      }
    };
  }, []);

  // Reset activity cursor when switching sessions
  useEffect(() => {
    activityCursorRef.current = null;
    seenActivityIdsRef.current = new Set();
  }, [sessionId]);

  // --- Polaris activity polling ---
  useEffect(() => {
    if (!showAssistant || !sessionId) return;

    // Seed cursor to "now" so we only surface activity that occurs while the
    // drawer is open — prior turns already live in replayable history.
    if (activityCursorRef.current === null) {
      activityCursorRef.current = new Date().toISOString();
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await getActivity(
          sessionId,
          activityCursorRef.current ?? undefined,
        );
        if (cancelled || res.activity.length === 0) return;

        const newHints: Message[] = [];
        for (const event of res.activity) {
          if (seenActivityIdsRef.current.has(event.id)) continue;
          seenActivityIdsRef.current.add(event.id);
          activityCursorRef.current = event.created_at;
          const label = activityLabel(event.turn_type);
          if (!label) continue;
          newHints.push({
            role: "assistant",
            kind: "hint",
            content: label,
            detail: event.detail ?? null,
            id: event.id,
          });
        }
        if (newHints.length > 0) {
          setMessages((prev) => [...prev, ...newHints]);
        }
      } catch (err) {
        console.error("Activity poll failed:", err);
      }
    };

    poll();
    const interval = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [showAssistant, sessionId]);

  // --- Goals handlers ---

  const handleGoalsChange = useCallback((newGoals: string[]) => {
    setGoals(newGoals);
    setGoalsDirty(true);
  }, []);

  // Auto-save when goals or stories change
  useEffect(() => {
    if (!hydrating && sessionId) {
      scheduleSaveInput();
    }
  }, [goals, storyGroups, hydrating, sessionId, scheduleSaveInput]);

  const fetchGoalSuggestions = useCallback(async (currentGoals: string[]) => {
    const nonEmpty = currentGoals.filter((g) => g.trim());
    if (nonEmpty.length === 0) return;

    setGoalSuggestionsLoading(true);
    try {
      const res = await suggestGoals(nonEmpty);
      setGoalSuggestions(res.suggestions);
    } catch (err) {
      console.error("Failed to get goal suggestions:", err);
    } finally {
      setGoalSuggestionsLoading(false);
    }
  }, []);

  const fetchGoalFeedback = useCallback(async (currentGoals: string[]) => {
    const nonEmpty = currentGoals.filter((g) => g.trim());
    if (nonEmpty.length < 1) return;

    setGoalFeedbackLoading(true);
    try {
      const res = await evaluateGoals(nonEmpty);
      setGoalFeedback(res.feedback);
    } catch (err) {
      console.error("Failed to evaluate goals:", err);
    } finally {
      setGoalFeedbackLoading(false);
    }
  }, []);

  // Called by GoalsPanel when user presses Enter on a non-empty goal
  const handleGoalCommit = useCallback(() => {
    fetchGoalSuggestions(goals);
    fetchGoalFeedback(goals);
  }, [goals, fetchGoalSuggestions, fetchGoalFeedback]);

  // Debounced re-fetch after accepting a suggestion
  const suggestionDebounceRef = useRef<number | null>(null);

  const handleAcceptGoalSuggestion = useCallback(
    (suggestion: string) => {
      setGoals((prev) => {
        const lastIsEmpty =
          prev.length > 0 && prev[prev.length - 1].trim() === "";
        const newGoals = lastIsEmpty
          ? [...prev.slice(0, -1), suggestion, ""]
          : [...prev, suggestion, ""];

        if (suggestionDebounceRef.current) {
          window.clearTimeout(suggestionDebounceRef.current);
        }
        suggestionDebounceRef.current = window.setTimeout(() => {
          suggestionDebounceRef.current = null;
          const nonEmpty = newGoals.filter((g) => g.trim());
          if (nonEmpty.length > 0) {
            fetchGoalSuggestions(newGoals);
          }
        }, 3000);

        return newGoals;
      });
      setGoalSuggestions((prev) => prev.filter((s) => s !== suggestion));
    },
    [fetchGoalSuggestions],
  );

  const handleDismissGoalSuggestion = useCallback((suggestion: string) => {
    setGoalSuggestions((prev) => prev.filter((s) => s !== suggestion));
  }, []);

  useEffect(() => {
    return () => {
      if (suggestionDebounceRef.current) {
        window.clearTimeout(suggestionDebounceRef.current);
      }
    };
  }, []);

  // --- Story suggestion handlers ---

  const fetchStorySuggestions = useCallback(
    async (currentGoals: string[], currentGroups: StoryGroup[]) => {
      const nonEmpty = currentGoals.filter((g) => g.trim());
      if (nonEmpty.length === 0) return;

      const existingStories = currentGroups
        .filter((g) => g.role.trim())
        .flatMap((g) =>
          g.stories
            .filter((s) => s.what.trim())
            .map((s) => ({ who: g.role, what: s.what, why: s.why })),
        );

      setStorySuggestionsLoading(true);
      try {
        const res = await suggestStories(nonEmpty, existingStories);
        setSuggestedStories(
          res.suggestions.map((s) => ({
            who: s.who,
            what: s.what,
            why: s.why || "",
          })),
        );
      } catch (err) {
        console.error("Failed to get story suggestions:", err);
      } finally {
        setStorySuggestionsLoading(false);
      }
    },
    [],
  );

  const handleStoryCommit = useCallback(() => {
    fetchStorySuggestions(goals, storyGroups);
  }, [goals, storyGroups, fetchStorySuggestions]);

  const storySuggestionDebounceRef = useRef<number | null>(null);

  const handleAcceptStory = useCallback(
    (story: SuggestedStory) => {
      setStoryGroups((prev) => {
        const existing = prev.findIndex(
          (g) => g.role.toLowerCase() === story.who.toLowerCase(),
        );
        let updated: StoryGroup[];
        if (existing >= 0) {
          updated = [...prev];
          updated[existing] = {
            ...updated[existing],
            stories: [
              ...updated[existing].stories,
              { what: story.what, why: story.why },
            ],
          };
        } else {
          updated = [
            ...prev,
            {
              role: story.who,
              stories: [{ what: story.what, why: story.why }],
            },
          ];
        }

        if (storySuggestionDebounceRef.current) {
          window.clearTimeout(storySuggestionDebounceRef.current);
        }
        storySuggestionDebounceRef.current = window.setTimeout(() => {
          storySuggestionDebounceRef.current = null;
          fetchStorySuggestions(goals, updated);
        }, 3000);

        return updated;
      });
      setSuggestedStories((prev) => prev.filter((s) => s !== story));
    },
    [goals, fetchStorySuggestions],
  );

  const handleDismissStory = useCallback((story: SuggestedStory) => {
    setSuggestedStories((prev) => prev.filter((s) => s !== story));
  }, []);

  // When navigating to User Stories, kick off a suggestion round
  // based on the goals we already have (first visit only).
  const storyAutoSuggestedRef = useRef(false);
  useEffect(() => {
    if (activeTab !== "users") return;
    if (storyAutoSuggestedRef.current) return;
    if (storySuggestionsLoading) return;
    if (suggestedStories.length > 0) return;
    const nonEmpty = goals.filter((g) => g.trim());
    if (nonEmpty.length === 0) return;
    storyAutoSuggestedRef.current = true;
    fetchStorySuggestions(goals, storyGroups);
  }, [
    activeTab,
    goals,
    storyGroups,
    suggestedStories.length,
    storySuggestionsLoading,
    fetchStorySuggestions,
  ]);

  useEffect(() => {
    return () => {
      if (storySuggestionDebounceRef.current) {
        window.clearTimeout(storySuggestionDebounceRef.current);
      }
    };
  }, []);

  // --- Charter phase handlers ---

  const handleSubmitIntake = useCallback(async () => {
    const goalsText = nonEmptyGoals.join("\n");
    const storiesText = formatStoryGroups(storyGroups);
    if (!goalsText && !storiesText) return;

    setActiveTab("charter");
    setLoading(true);

    try {
      if (!sessionId) {
        const res = await createSession({
          business_goals: goalsText || undefined,
          user_stories: storiesText || undefined,
          goals: nonEmptyGoals,
          story_groups: storyGroups.filter((g) => g.role.trim()),
        });
        setSessionId(res.session_id);
        navigate(`/project/${res.session_id}`, { replace: true });
        if (res.message) {
          setMessages([{ role: "assistant", content: res.message }]);
        }
        const session = await getSession(res.session_id);
        setState(session.state as SessionState);
        setSuggestions(res.suggestions || []);
        setSuggestedStories(res.suggested_stories || []);
        setSavedInput({ goals: goalsText, stories: storiesText });
      } else {
        const updateMsg = `I've updated my input.\n\nBusiness goals:\n${goalsText}\n\nUser stories:\n${storiesText}\n\nPlease regenerate the document with this updated input.`;
        const res = await sendMessage(sessionId, updateMsg, {
          regenerate: true,
        });
        setMessages((prev) => [
          ...prev,
          { role: "user", content: "(Updated input)" },
          { role: "assistant", content: res.message },
        ]);
        setState(res.state);
        setSuggestions(res.suggestions || []);
        setSuggestedStories(res.suggested_stories || []);
        setSavedInput({ goals: goalsText, stories: storiesText });
      }
    } catch (err) {
      console.error("Failed:", err);
    } finally {
      setLoading(false);
    }
  }, [nonEmptyGoals, storyGroups, sessionId, navigate]);

  // Execute an action from the agent
  const executeAgentAction = useCallback(
    async (action: { action: string; count?: number; example_id?: string }) => {
      if (!dataset) return;

      switch (action.action) {
        case "generate":
          try {
            const res = await synthesizeExamples(
              dataset.id,
              action.count ? { count_per_scenario: action.count } : undefined,
            );
            const fullDs = await getDataset(dataset.session_id);
            setDataset(fullDs);
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: `Generated ${res.generated} examples.`,
              },
            ]);
          } catch (err) {
            console.error("Failed to generate:", err);
          }
          break;
        case "show_coverage":
          try {
            const gaps = await getGapAnalysis(dataset.id);
            setGapAnalysis(gaps);
            setShowCoverageMap(true);
          } catch (err) {
            console.error("Failed to get coverage:", err);
          }
          break;
        case "auto_review":
          try {
            const res = await autoReviewExamples(dataset.id);
            const fullDs = await getDataset(dataset.session_id);
            setDataset(fullDs);
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: `Reviewed ${res.reviewed} examples.`,
              },
            ]);
          } catch (err) {
            console.error("Failed to auto-review:", err);
          }
          break;
        case "export":
          try {
            const data = await exportDataset(dataset.id);
            const blob = new Blob([JSON.stringify(data, null, 2)], {
              type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `dataset-v${dataset.version}.json`;
            a.click();
            URL.revokeObjectURL(url);
          } catch (err) {
            console.error("Failed to export:", err);
          }
          break;
        case "approve":
          if (action.example_id) {
            try {
              await apiUpdateExample(dataset.id, action.example_id, {
                review_status: "approved",
              });
              const fullDs = await getDataset(dataset.session_id);
              setDataset(fullDs);
            } catch (err) {
              console.error("Failed to approve:", err);
            }
          }
          break;
        case "reject":
          if (action.example_id) {
            try {
              await apiUpdateExample(dataset.id, action.example_id, {
                review_status: "rejected",
              });
              const fullDs = await getDataset(dataset.session_id);
              setDataset(fullDs);
            } catch (err) {
              console.error("Failed to reject:", err);
            }
          }
          break;
      }
    },
    [dataset],
  );

  const handleSend = useCallback(
    async (message: string) => {
      if (!sessionId) return;
      setMessages((prev) => [...prev, { role: "user", content: message }]);
      setLoading(true);
      try {
        if (dataset) {
          const res = await datasetChat(dataset.id, message);
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: res.message },
          ]);
          setState(res.state);
          setActionSuggestions(res.action_suggestions || []);
          if (res.actions && res.actions.length > 0) {
            for (const action of res.actions) {
              await executeAgentAction(action);
            }
            const fullDs = await getDataset(dataset.session_id);
            setDataset(fullDs);
          }
        } else {
          const res = await sendMessage(sessionId, message);
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: res.message },
          ]);
          setState(res.state);
          setActiveCriteria([]);
          setSuggestions(res.suggestions || []);
          setSuggestedStories(res.suggested_stories || []);
        }
      } catch (err) {
        console.error("Failed to send message:", err);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Something went wrong. Please try again.",
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [sessionId, dataset, executeAgentAction],
  );

  const handleEditCriterion = useCallback(
    async (dimension: string, index: number, value: string) => {
      if (!sessionId) return;
      const charter = { ...state.charter };
      const dim = dimension as "coverage" | "balance" | "rot" | "safety";
      const existing = charter[dim] ?? { criteria: [], status: "pending" as const };
      const criteria = [...existing.criteria];
      criteria[index] = value;
      charter[dim] = { ...existing, criteria };

      try {
        const res = await patchCharter(sessionId, {
          [dimension]: charter[dim],
        });
        setState((prev) => ({ ...prev, ...res.state }));
      } catch (err) {
        console.error("Failed to save edit:", err);
      }
    },
    [sessionId, state.charter],
  );

  const handleAddCriterion = useCallback(
    async (dimension: string, value: string) => {
      if (!sessionId) return;
      const dim = dimension as "coverage" | "balance" | "rot" | "safety";
      const currentCharter = charterRef.current;
      const existing = currentCharter[dim] ?? { criteria: [], status: "pending" as const };
      const newCriteria = [...existing.criteria, value];
      const newDim = { ...existing, criteria: newCriteria };
      charterRef.current = { ...charterRef.current, [dim]: newDim };
      setState((prev) => ({
        ...prev,
        charter: { ...prev.charter, [dim]: newDim },
      }));
      patchCharter(sessionId, { [dim]: newDim }).catch((err) => {
        console.error("Failed to add criterion:", err);
      });
    },
    [sessionId],
  );

  const handleEditAlignment = useCallback(
    async (index: number, field: "good" | "bad", value: string) => {
      if (!sessionId) return;
      const alignment = [...state.charter.alignment];
      alignment[index] = { ...alignment[index], [field]: value };

      try {
        const res = await patchCharter(sessionId, { alignment });
        setState((prev) => ({ ...prev, ...res.state }));
      } catch (err) {
        console.error("Failed to save alignment edit:", err);
      }
    },
    [sessionId, state.charter.alignment],
  );

  const handleDeleteCriterion = useCallback(
    async (dimension: string, index: number) => {
      if (!sessionId) return;
      const dim = dimension as "coverage" | "balance" | "rot" | "safety";
      const currentCharter = charterRef.current;
      const existing = currentCharter[dim] ?? { criteria: [], status: "pending" as const };
      const newCriteria = existing.criteria.filter(
        (_: string, i: number) => i !== index,
      );
      const newDim = { ...existing, criteria: newCriteria };
      setState((prev) => ({
        ...prev,
        charter: { ...prev.charter, [dim]: newDim },
      }));
      patchCharter(sessionId, { [dim]: newDim }).catch((err) => {
        console.error("Failed to delete criterion:", err);
      });
    },
    [sessionId],
  );

  const handleAddAlignment = useCallback(
    async (featureArea: string, good: string, bad: string) => {
      if (!sessionId) return;
      const currentCharter = charterRef.current;
      const newAlignment = [
        ...currentCharter.alignment,
        { feature_area: featureArea, good, bad, status: "pending" as const },
      ];
      setState((prev) => ({
        ...prev,
        charter: { ...prev.charter, alignment: newAlignment },
      }));
      patchCharter(sessionId, { alignment: newAlignment }).catch((err) => {
        console.error("Failed to add alignment:", err);
      });
    },
    [sessionId],
  );

  const handleDeleteAlignment = useCallback(
    async (index: number) => {
      if (!sessionId) return;
      const alignment = state.charter.alignment.filter((_, i) => i !== index);
      setState((prev) => ({
        ...prev,
        charter: { ...prev.charter, alignment },
      }));
      patchCharter(sessionId, { alignment }).catch((err) => {
        console.error("Failed to delete alignment:", err);
      });
    },
    [sessionId, state.charter.alignment],
  );

  const handleReorderCriteria = useCallback(
    async (dimension: string, criteria: string[]) => {
      if (!sessionId) return;
      const dim = dimension as "coverage" | "balance" | "rot" | "safety";
      const existing = charterRef.current[dim] ?? { criteria: [], status: "pending" as const };
      const newDim = { ...existing, criteria };
      setState((prev) => ({
        ...prev,
        charter: { ...prev.charter, [dim]: newDim },
      }));
      patchCharter(sessionId, { [dim]: newDim }).catch((err) =>
        console.error("Failed to reorder:", err),
      );
    },
    [sessionId],
  );

  const handleReorderAlignment = useCallback(
    async (alignment: AlignmentEntry[]) => {
      if (!sessionId) return;
      setState((prev) => ({
        ...prev,
        charter: { ...prev.charter, alignment },
      }));
      patchCharter(sessionId, { alignment }).catch((err) =>
        console.error("Failed to reorder:", err),
      );
    },
    [sessionId],
  );

  const handleEditTask = useCallback(
    async (
      field:
        | "input_description"
        | "output_description"
        | "sample_input"
        | "sample_output",
      value: string,
    ) => {
      if (!sessionId) return;
      const task = { ...state.charter.task, [field]: value };

      try {
        const res = await patchCharter(sessionId, { task });
        setState((prev) => ({ ...prev, ...res.state }));
      } catch (err) {
        console.error("Failed to save task edit:", err);
      }
    },
    [sessionId, state.charter.task],
  );

  const handleValidate = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const res = await validateCharter(sessionId);
      setState((prev) => ({ ...prev, validation: res.validation }));
    } catch (err) {
      console.error("Failed to validate:", err);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Mark charter dirty when it changes (after initial hydration)
  const charterInitRef = useRef(true)
  useEffect(() => {
    if (charterInitRef.current) {
      charterInitRef.current = false
      return
    }
    if (hasCharter) setCharterDirty(true)
  }, [state.charter]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Charter suggestion state ---
  const [charterSuggestionsLoading, setCharterSuggestionsLoading] =
    useState(false);
  const charterSuggestionDebounceRef = useRef<number | null>(null);

  const handleSuggest = useCallback(async () => {
    if (!sessionId) return;
    setCharterSuggestionsLoading(true);
    try {
      const res = await suggestForCharter(sessionId);
      // Replace (not append) — reload should feel like "give me fresh
      // suggestions", not pile more on top. Dedup within the same section
      // by the first 40 chars of the text (case-insensitive) so the LLM
      // trying to rephrase the same idea three times doesn't fill the panel.
      const seen = new Set<string>();
      const dedupedSuggestions = res.suggestions.filter((s) => {
        const key = `${s.section}|${s.text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const seenStories = new Set<string>();
      const dedupedStories = res.suggested_stories.filter((s) => {
        const key = `${(s.who || '').toLowerCase()}|${(s.what || '').toLowerCase().trim().slice(0, 40)}`;
        if (seenStories.has(key)) return false;
        seenStories.add(key);
        return true;
      });
      setSuggestions(dedupedSuggestions);
      setSuggestedStories(dedupedStories);
    } catch (err) {
      console.error("Failed to get suggestions:", err);
    } finally {
      setCharterSuggestionsLoading(false);
    }
  }, [sessionId]);

  const scheduleCharterSuggestionRegen = useCallback(() => {
    if (charterSuggestionDebounceRef.current) {
      window.clearTimeout(charterSuggestionDebounceRef.current);
    }
    charterSuggestionDebounceRef.current = window.setTimeout(() => {
      charterSuggestionDebounceRef.current = null;
      handleSuggest();
    }, 3000);
  }, [handleSuggest]);

  useEffect(() => {
    return () => {
      if (charterSuggestionDebounceRef.current) {
        window.clearTimeout(charterSuggestionDebounceRef.current);
      }
    };
  }, []);

  const charterRef = useRef(state.charter);
  useEffect(() => {
    charterRef.current = state.charter;
  }, [state.charter]);

  const handleAcceptSuggestion = useCallback(
    async (suggestion: Suggestion) => {
      if (!sessionId) return;

      const currentCharter = charterRef.current;

      if (
        suggestion.section === "alignment" &&
        suggestion.good &&
        suggestion.bad
      ) {
        const newEntry = {
          feature_area: suggestion.text,
          good: suggestion.good,
          bad: suggestion.bad,
          status: "pending" as const,
        };
        const newAlignment = [...currentCharter.alignment, newEntry];
        charterRef.current = { ...charterRef.current, alignment: newAlignment };
        setState((prev) => ({
          ...prev,
          charter: { ...prev.charter, alignment: newAlignment },
        }));
        patchCharter(sessionId, { alignment: newAlignment }).catch((err) => {
          console.error("Failed to accept suggestion:", err);
        });
      } else {
        const dim = suggestion.section as "coverage" | "balance" | "rot";
        const newCriteria = [...currentCharter[dim].criteria, suggestion.text];
        const newDim = { ...currentCharter[dim], criteria: newCriteria };
        charterRef.current = { ...charterRef.current, [dim]: newDim };
        setState((prev) => ({
          ...prev,
          charter: { ...prev.charter, [dim]: newDim },
        }));
        patchCharter(sessionId, { [dim]: newDim }).catch((err) => {
          console.error("Failed to accept suggestion:", err);
        });
      }

      setSuggestions((prev) => prev.filter((s) => s !== suggestion));
      scheduleCharterSuggestionRegen();
    },
    [sessionId, scheduleCharterSuggestionRegen],
  );

  const handleDismissSuggestion = useCallback(
    (suggestion: Suggestion) => {
      setSuggestions((prev) => prev.filter((s) => s !== suggestion));
      scheduleCharterSuggestionRegen();
    },
    [scheduleCharterSuggestionRegen],
  );

  // --- Phase transition: charter -> dataset ---

  const handleStartDataset = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      await finalizeCharter(sessionId);
      setActiveTab("dataset");
    } catch (err) {
      console.error("Failed to finalize charter:", err);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // "Skip ahead" shortcuts from the User Stories screen — run charter
  // generation first if it doesn't exist yet, then fire whichever downstream
  // action the user picked. Dataset and scorers are independent so the
  // "both" variant runs them in parallel via Promise.all.
  const ensureCharter = useCallback(async () => {
    if (hasCharter) return;
    await handleSubmitIntake();
  }, [hasCharter, handleSubmitIntake]);

  const runGenerateDataset = useCallback(async () => {
    if (!sessionId) return;
    await ensureCharter();
    // Use the existing handleGenerateDataset below (defined later in file).
    // We can't forward-reference a useCallback so inline the work:
    try {
      let ds = dataset;
      if (!ds) {
        await createDataset(sessionId);
        ds = await getDataset(sessionId);
        setDataset(ds);
      }
      await synthesizeExamples(ds.id);
      const fresh = await getDataset(sessionId);
      setDataset(fresh);
    } catch (err) {
      console.error("Shortcut: generate dataset failed", err);
      throw err;
    }
  }, [sessionId, dataset, ensureCharter]);

  const runGenerateScorers = useCallback(async () => {
    if (!sessionId) return;
    await ensureCharter();
    try {
      const res = await generateScorers(sessionId);
      setScorers(res.scorers);
      const s = await getSession(sessionId);
      setState(s.state as SessionState);
    } catch (err) {
      console.error("Shortcut: generate scorers failed", err);
      throw err;
    }
  }, [sessionId, ensureCharter]);

  const handleShortcutDataset = useCallback(async () => {
    setGeneratingDataset(true);
    try {
      await runGenerateDataset();
      setActiveTab("dataset");
    } finally {
      setGeneratingDataset(false);
    }
  }, [runGenerateDataset]);

  const handleShortcutScorers = useCallback(async () => {
    setGeneratingScorersShortcut(true);
    try {
      await runGenerateScorers();
      setActiveTab("scorers");
    } finally {
      setGeneratingScorersShortcut(false);
    }
  }, [runGenerateScorers]);

  const handleShortcutBoth = useCallback(async () => {
    setGeneratingBoth(true);
    try {
      // Ensure charter once, then fan out.
      await ensureCharter();
      await Promise.all([runGenerateDataset(), runGenerateScorers()]);
      setActiveTab("evaluate");
    } catch (err) {
      console.error("Shortcut: generate both failed", err);
    } finally {
      setGeneratingBoth(false);
    }
  }, [ensureCharter, runGenerateDataset, runGenerateScorers]);

  const handleGenerateDataset = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      if (!dataset) {
        await createDataset(sessionId);
      }
      const ds = await getDataset(sessionId);
      await synthesizeExamples(ds.id);
      const fullDs = await getDataset(sessionId);
      setDataset(fullDs);
    } catch (err) {
      console.error("Failed to generate dataset:", err);
    } finally {
      setLoading(false);
    }
  }, [sessionId, dataset]);

  const handleImportDataset = useCallback(async () => {
    if (!sessionId) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.csv";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      setLoading(true);
      try {
        if (!dataset) {
          await createDataset(sessionId);
        }
        const ds = await getDataset(sessionId);

        const text = await file.text();
        let examples: Array<{
          input: string;
          expected_output: string;
          feature_area?: string;
          label?: string;
        }>;

        if (file.name.endsWith(".csv")) {
          const lines = text.split("\n").filter((l) => l.trim());
          const headers = lines[0]
            .split(",")
            .map((h) => h.trim().toLowerCase());
          examples = lines.slice(1).map((line) => {
            const values = line.split(",");
            const obj: Record<string, string> = {};
            headers.forEach((h, i) => {
              obj[h] = values[i]?.trim() || "";
            });
            return {
              input: obj.input || obj.question || obj.scenario || "",
              expected_output:
                obj.expected_output || obj.output || obj.answer || "",
              feature_area: obj.feature_area || "unassigned",
              label: obj.label,
            };
          });
        } else {
          const parsed = JSON.parse(text);
          examples = Array.isArray(parsed) ? parsed : parsed.examples || [];
        }

        const { importExamples } = await import("../api");
        await importExamples(ds.id, examples);
        const fullDs = await getDataset(sessionId);
        setDataset(fullDs);
      } catch (err) {
        console.error("Failed to import:", err);
      } finally {
        setLoading(false);
      }
    };
    input.click();
  }, [sessionId, dataset]);

  // --- Dataset phase handlers ---

  const handleSynthesize = useCallback(
    async (count?: number) => {
      if (!dataset) return;
      setLoading(true);
      try {
        await synthesizeExamples(
          dataset.id,
          count ? { count_per_scenario: count } : undefined,
        );
        const fullDs = await getDataset(dataset.session_id);
        setDataset(fullDs);
      } catch (err) {
        console.error("Failed to synthesize:", err);
      } finally {
        setLoading(false);
      }
    },
    [dataset],
  );

  const handleUpdateExample = useCallback(
    async (exampleId: string, fields: Partial<Example>) => {
      if (!dataset) return;
      try {
        await apiUpdateExample(dataset.id, exampleId, fields);
        const fullDs = await getDataset(dataset.session_id);
        setDataset(fullDs);
      } catch (err) {
        console.error("Failed to update example:", err);
      }
    },
    [dataset],
  );

  const handleDeleteExample = useCallback(
    async (exampleId: string) => {
      if (!dataset) return;
      try {
        await apiDeleteExample(dataset.id, exampleId);
        const fullDs = await getDataset(dataset.session_id);
        setDataset(fullDs);
      } catch (err) {
        console.error("Failed to delete example:", err);
      }
    },
    [dataset],
  );

  const handleAutoReview = useCallback(async () => {
    if (!dataset) return;
    setLoading(true);
    try {
      await autoReviewExamples(dataset.id);
      const fullDs = await getDataset(dataset.session_id);
      setDataset(fullDs);
    } catch (err) {
      console.error("Failed to auto-review:", err);
    } finally {
      setLoading(false);
    }
  }, [dataset]);

  const handleSuggestRevision = useCallback(
    async (exampleId: string) => {
      if (!dataset) return;
      setRevisionsLoading(true);
      try {
        await suggestRevisions(dataset.id, [exampleId]);
        const fullDs = await getDataset(dataset.session_id);
        setDataset(fullDs);
      } catch (err) {
        console.error("Failed to suggest revision:", err);
      } finally {
        setRevisionsLoading(false);
      }
    },
    [dataset],
  );

  const handleBulkSuggestRevisions = useCallback(async () => {
    if (!dataset) return;
    setRevisionsLoading(true);
    try {
      await suggestRevisions(dataset.id);
      const fullDs = await getDataset(dataset.session_id);
      setDataset(fullDs);
    } catch (err) {
      console.error("Failed to suggest revisions:", err);
    } finally {
      setRevisionsLoading(false);
    }
  }, [dataset]);

  const handleAcceptRevision = useCallback(
    async (exampleId: string) => {
      if (!dataset) return;
      const example = dataset.examples?.find((e) => e.id === exampleId);
      if (!example?.revision_suggestion) return;
      try {
        await apiUpdateExample(dataset.id, exampleId, {
          input: example.revision_suggestion.input,
          expected_output: example.revision_suggestion.expected_output,
          revision_suggestion: null,
          review_status: "approved",
        } as Partial<Example>);
        const fullDs = await getDataset(dataset.session_id);
        setDataset(fullDs);
      } catch (err) {
        console.error("Failed to accept revision:", err);
      }
    },
    [dataset],
  );

  const handleDismissRevision = useCallback(
    async (exampleId: string) => {
      if (!dataset) return;
      try {
        await apiUpdateExample(dataset.id, exampleId, {
          revision_suggestion: null,
        } as Partial<Example>);
        const fullDs = await getDataset(dataset.session_id);
        setDataset(fullDs);
      } catch (err) {
        console.error("Failed to dismiss revision:", err);
      }
    },
    [dataset],
  );

  const handleShowCoverageMap = useCallback(async () => {
    if (!dataset) return;
    setLoading(true);
    try {
      const gaps = await getGapAnalysis(dataset.id);
      setGapAnalysis(gaps);
      setShowCoverageMap(true);
    } catch (err) {
      console.error("Failed to get gaps:", err);
    } finally {
      setLoading(false);
    }
  }, [dataset]);

  const handleExport = useCallback(async () => {
    if (!dataset) return;
    try {
      const data = await exportDataset(dataset.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `dataset-v${dataset.version}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to export:", err);
    }
  }, [dataset]);

  const handleImport = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.csv";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file || !dataset) return;

      setLoading(true);
      try {
        const text = await file.text();
        let examples: Array<{
          input: string;
          expected_output: string;
          feature_area?: string;
          label?: string;
        }>;

        if (file.name.endsWith(".csv")) {
          const lines = text.split("\n").filter((l) => l.trim());
          const headers = lines[0]
            .split(",")
            .map((h) => h.trim().toLowerCase());
          examples = lines.slice(1).map((line) => {
            const values = line.split(",");
            const obj: Record<string, string> = {};
            headers.forEach((h, i) => {
              obj[h] = values[i]?.trim() || "";
            });
            return {
              input: obj.input || obj.question || obj.scenario || "",
              expected_output:
                obj.expected_output || obj.output || obj.answer || "",
              feature_area: obj.feature_area || "unassigned",
              label: obj.label,
            };
          });
        } else {
          const parsed = JSON.parse(text);
          examples = Array.isArray(parsed) ? parsed : parsed.examples || [];
        }

        const { importExamples } = await import("../api");
        await importExamples(dataset.id, examples);
        const fullDs = await getDataset(dataset.session_id);
        setDataset(fullDs);
      } catch (err) {
        console.error("Failed to import:", err);
      } finally {
        setLoading(false);
      }
    };
    input.click();
  }, [dataset]);

  // --- Render ---

  if (hydrating) {
    return (
      <div className="h-full flex items-center justify-center bg-bg-default">
        <Loader2 className="w-5 h-5 animate-spin text-fg-dim" />
      </div>
    );
  }

  const aiAssistButton = (
    <button
      onClick={() => setShowAssistant(!showAssistant)}
      className="flex items-center gap-1.5 px-6 py-6 w-full text-left hover:bg-fill-neutral/30 transition-colors"
    >
      <ChatBubbleIcon />
      <span className="text-base font-semibold text-fg-contrast">Polaris</span>
    </button>
  );

  const polarisPanel = (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-6 py-6 border-b border-border-hint flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <ChatBubbleIcon />
          <span className="text-base font-semibold text-fg-contrast">
            Polaris
          </span>
        </div>
        <IconButton tone="dim" onClick={() => setShowAssistant(false)}>
          <CloseIcon />
        </IconButton>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <ConversationPanel
          messages={messages}
          status={status}
          validation={state.validation}
          loading={loading}
          onSend={handleSend}
          onProceed={() => {}}
          onKeepRefining={() => {}}
          actionSuggestions={actionSuggestions}
          onActionSuggestion={(action) => {
            executeAgentAction({ action });
          }}
        />
      </div>
    </div>
  );

  // --- Next-button state per panel ---

  // Goals → User Stories
  const hasAnyStories = storyGroups.some(
    (g) => g.role.trim() && g.stories.some((s) => s.what.trim()),
  );
  const goalsNextLabel = !hasAnyStories
    ? "Define user stories"
    : goalsDirty
      ? "Update user stories"
      : "User stories";
  const goalsNextDisabled = nonEmptyGoals.length < 2;
  const goalsNextVariant: "primary" | "neutral" = goalsNextDisabled
    ? "neutral"
    : goalsDirty || !hasAnyStories
      ? "primary"
      : "neutral";

  // User Stories → Charter
  const storiesNextLabel = !hasCharter
    ? "Generate charter"
    : storiesDirty
      ? "Update charter"
      : "Charter";
  const storiesHasContent = storyGroups.some(
    (g) => g.role.trim() && g.stories.some((s) => s.what.trim()),
  );
  const storiesNextDisabled = !storiesHasContent || loading;
  const storiesNextVariant: "primary" | "neutral" = storiesNextDisabled
    ? "neutral"
    : storiesDirty || !hasCharter
      ? "primary"
      : "neutral";

  // Charter → Dataset
  const charterNextLabel = !dataset
    ? "Generate dataset"
    : charterDirty
      ? "Update dataset"
      : "Dataset";
  const charterNextDisabled = !hasCharter || loading;
  const charterNextVariant: "primary" | "neutral" = charterNextDisabled
    ? "neutral"
    : charterDirty || !dataset
      ? "primary"
      : "neutral";

  return (
    <div className="h-full flex flex-col bg-bg-default text-fg-contrast">
      {/* Top bar */}
      <header className="h-16 flex items-center justify-between px-4 flex-shrink-0 border-b border-border-hint">
        <IconButton
          tone="contrast"
          onClick={() => navigate("/")}
          title="All projects"
        >
          <StarIcon />
        </IconButton>
        <div className="flex items-center gap-3">
          <Button
            size="small"
            variant="neutral"
            onClick={() => setShowSettings(true)}
          >
            <GearIcon />
            Settings
          </Button>
        </div>
      </header>

      {/* Body: sidebar + main */}
      <div className="flex-1 flex min-h-0 gap-6">
        {/* Left sidebar */}
        <nav className="w-56 flex-shrink-0 px-4 py-6 overflow-y-auto border-r border-border-hint">
          {/* Project header */}
          <div className="flex items-center gap-2 mb-6 px-2">
            {editingName ? (
              <input
                ref={nameInputRef}
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName();
                }}
                className="text-sm font-medium text-fg-contrast bg-transparent border-b border-border-primary outline-none min-w-0 flex-1"
              />
            ) : (
              <button
                onClick={startEditingName}
                className="text-sm font-medium text-fg-contrast hover:text-fg-primary truncate min-w-0 text-left transition-colors"
                title="Click to rename"
              >
                {projectName}
              </button>
            )}
            {!hasCharter && (
              <span className="font-mono text-xs text-fg-dim bg-fill-neutral px-1.5 py-0.5 flex-shrink-0">
                Draft
              </span>
            )}
          </div>

          {/* Nav groups */}
          {(state.eval_mode === "triggered" || state.charter.task.skill_body) && (
            <SidebarGroup label="SKILL">
              <SidebarItem
                label="Skill"
                icon={<GoalsIcon width={24} height={24} />}
                active={activeTab === "skill"}
                onClick={() => setActiveTab("skill")}
              />
            </SidebarGroup>
          )}

          <SidebarGroup label="INPUT">
            <SidebarItem
              label="Business Goals"
              icon={<GoalsIcon width={24} height={24} />}
              active={activeTab === "goals"}
              onClick={() => setActiveTab("goals")}
              disabled={!skillReady}
              badge={
                nonEmptyGoals.length > 0 ? `${nonEmptyGoals.length}` : undefined
              }
            />
            <SidebarItem
              label="User Stories"
              icon={<UsersIcon width={24} height={24} />}
              active={activeTab === "users"}
              onClick={() => setActiveTab("users")}
              disabled={!usersAvailable}
              badge={totalStoryCount > 0 ? `${totalStoryCount}` : undefined}
            />
          </SidebarGroup>

          <SidebarGroup label="GENERATE">
            <SidebarItem
              label="Charter"
              icon={<CharterIcon width={24} height={24} />}
              active={activeTab === "charter"}
              onClick={() => setActiveTab("charter")}
              disabled={!charterAvailable}
            />
            <SidebarItem
              label="Dataset"
              icon={<DatasetIcon width={24} height={24} />}
              active={activeTab === "dataset"}
              onClick={() => setActiveTab("dataset")}
              disabled={!datasetAvailable}
            />
            <SidebarItem
              label="Scorers"
              icon={<ScorerIcon width={24} height={24} />}
              active={activeTab === "scorers"}
              onClick={() => setActiveTab("scorers")}
              disabled={!scorersAvailable}
            />
          </SidebarGroup>

          <SidebarGroup label="OUTPUT">
            <SidebarItem
              label="Evaluations"
              icon={<StarIcon width={24} height={24} />}
              active={activeTab === "evaluate"}
              onClick={() => setActiveTab("evaluate")}
              disabled={!evaluateAvailable}
            />
            <SidebarItem
              label="Improve"
              icon={<StarIcon width={24} height={24} />}
              active={activeTab === "improve"}
              onClick={() => setActiveTab("improve")}
              disabled={!evaluateAvailable || !state.charter.task.skill_body}
            />
          </SidebarGroup>
        </nav>

        {/* Main column */}
        <div className="flex-1 min-w-0 flex flex-col">
          {(() => {
            // Compute skill-version lineage for the regenerate banners below.
            // Rendered as IIFE so we don't leak a const into the sibling JSX.
            return null;
          })()}
          {activeTab === "skill" && urlSessionId && (
            <SkillPanel
              sessionId={urlSessionId}
              skillBody={state.charter.task.skill_body || ""}
              skillName={state.charter.task.skill_name ?? null}
              skillDescription={state.charter.task.skill_description ?? null}
              onSkillBodyChange={(body) => {
                setState((prev) => ({
                  ...prev,
                  charter: {
                    ...prev.charter,
                    task: { ...prev.charter.task, skill_body: body },
                  },
                }));
              }}
              onSeeded={async () => {
                // Re-hydrate session state so extracted goals/users/stories
                // show up and downstream tabs unlock. Rename the project to
                // the skill name if it's still the default. Then jump to
                // Goals so the user's next action is reviewing extractions.
                if (!urlSessionId) return;
                try {
                  const session = await getSession(urlSessionId);
                  setState(session.state as SessionState);
                  if (session.state.input?.goals) {
                    setGoals([...session.state.input.goals, ""]);
                  }
                  if (session.state.input?.story_groups) {
                    setStoryGroups(session.state.input.story_groups as StoryGroup[]);
                  }

                  // Rename: take skill name (if any), dedupe against other
                  // projects with a " N" suffix, only touch generic defaults
                  // so we don't clobber a name the user typed themselves.
                  const desiredBase =
                    session.state.charter?.task?.skill_name?.trim();
                  const currentName = (session as { name?: string }).name?.trim();
                  const isDefault =
                    !currentName ||
                    currentName === "Untitled skill eval" ||
                    currentName === "Untitled project" ||
                    currentName === "Skill eval";
                  if (desiredBase && isDefault) {
                    try {
                      const list = await listSessions();
                      const taken = new Set(
                        list.sessions
                          .filter((p) => p.id !== urlSessionId)
                          .map((p) => p.name?.trim())
                          .filter(Boolean) as string[],
                      );
                      let candidate = desiredBase;
                      let n = 2;
                      while (taken.has(candidate)) {
                        candidate = `${desiredBase} ${n++}`;
                      }
                      if (candidate !== currentName) {
                        await updateSessionName(urlSessionId, candidate);
                        setProjectName(candidate);
                      }
                    } catch (err) {
                      console.error("Failed to rename project:", err);
                    }
                  }

                  setActiveTab("goals");
                } catch (err) {
                  console.error("Failed to refresh after seed:", err);
                }
              }}
              onStartFromScratch={() => {
                // SkillPanel has already flipped the session to standard mode.
                // Reflect locally + jump to Goals so the old flow takes over.
                setState((prev) => ({ ...prev, eval_mode: "standard" }));
                setActiveTab("goals");
              }}
            />
          )}

          {activeTab === "goals" && (
            <>
              <RegenerateBanner
                artifact="business goals"
                activeVersion={activeSkillVersionNum}
                sourceVersion={lineageFor("goals")}
                onUpdateSuggestions={() => fetchGoalSuggestions(goals)}
              />
          <GoalsPanel
              goals={goals}
              onGoalsChange={handleGoalsChange}
              onGoalCommit={handleGoalCommit}
              goalSuggestions={goalSuggestions}
              onAcceptGoalSuggestion={handleAcceptGoalSuggestion}
              onDismissGoalSuggestion={handleDismissGoalSuggestion}
              suggestionsLoading={goalSuggestionsLoading}
              goalFeedback={goalFeedback}
              goalFeedbackLoading={goalFeedbackLoading}
              onNext={() => {
                setGoalsDirty(false);
                setActiveTab("users");
              }}
              nextLabel={goalsNextLabel}
              nextVariant={goalsNextVariant}
              nextDisabled={goalsNextDisabled}
              hasCharter={hasCharter}
              rightBottom={showAssistant ? undefined : aiAssistButton}
              rightBottomExpanded={showAssistant ? polarisPanel : undefined}
            />
            </>
          )}

          {activeTab === "users" && (
            <>
              <RegenerateBanner
                artifact="user stories"
                activeVersion={activeSkillVersionNum}
                sourceVersion={lineageFor("stories")}
                onUpdateSuggestions={() => fetchStorySuggestions(goals, storyGroups)}
              />
            <UsersPanel
              storyGroups={storyGroups}
              onStoryGroupsChange={(groups) => {
                setStoryGroups(groups);
                setStoriesDirty(true);
              }}
              onStoryCommit={handleStoryCommit}
              suggestedStories={suggestedStories}
              onAcceptStory={handleAcceptStory}
              onDismissStory={handleDismissStory}
              storySuggestionsLoading={storySuggestionsLoading}
              onBackToGoals={() => setActiveTab("goals")}
              onNext={() => {
                setStoriesDirty(false);
                handleSubmitIntake();
              }}
              nextLabel={storiesNextLabel}
              nextVariant={storiesNextVariant}
              nextDisabled={storiesNextDisabled}
              loading={loading}
              hasCharter={hasCharter}
              rightBottom={showAssistant ? undefined : aiAssistButton}
              rightBottomExpanded={showAssistant ? polarisPanel : undefined}
              onGenerateDataset={handleShortcutDataset}
              onGenerateScorers={handleShortcutScorers}
              onGenerateBoth={handleShortcutBoth}
              generatingDataset={generatingDataset}
              generatingScorers={generatingScorersShortcut}
              generatingBoth={generatingBoth}
            />
            </>
          )}

          {activeTab === "charter" && (
            <>
              <RegenerateBanner
                artifact="charter"
                activeVersion={activeSkillVersionNum}
                sourceVersion={lineageFor("charter")}
                onUpdateSuggestions={handleSuggest}
                onRegenerate={handleSubmitIntake}
              />
              <CharterPanel
              charter={state.charter}
              validation={state.validation}
              activeCriteria={activeCriteria}
              onEditCriterion={handleEditCriterion}
              onAddCriterion={handleAddCriterion}
              onDeleteCriterion={handleDeleteCriterion}
              onEditAlignment={handleEditAlignment}
              onAddAlignment={handleAddAlignment}
              onDeleteAlignment={handleDeleteAlignment}
              onReorderCriteria={handleReorderCriteria}
              onReorderAlignment={handleReorderAlignment}
              onEditTask={handleEditTask}
              suggestions={suggestions}
              onAcceptSuggestion={handleAcceptSuggestion}
              onDismissSuggestion={handleDismissSuggestion}
              onRegenSuggestions={handleSuggest}
              onCriteriaChanged={scheduleCharterSuggestionRegen}
              suggestionsLoading={charterSuggestionsLoading}
              loading={loading}
              onBackToGoals={() => setActiveTab("goals")}
              onNext={() => {
                setCharterDirty(false);
                handleStartDataset();
              }}
              nextLabel={charterNextLabel}
              nextVariant={charterNextVariant}
              nextDisabled={charterNextDisabled}
              rightBottom={showAssistant ? undefined : aiAssistButton}
              rightBottomExpanded={showAssistant ? polarisPanel : undefined}
            />
            </>
          )}

          {activeTab === "dataset" && (
            <div className="flex-1 min-h-0 flex flex-col">
              <RegenerateBanner
                artifact="dataset"
                activeVersion={activeSkillVersionNum}
                sourceVersion={lineageFor("dataset")}
                onUpdateSuggestions={() => { handleShowCoverageMap(); }}
                updateSuggestionsLabel="Check gaps"
                onRegenerate={() => { handleSynthesize(); }}
                regenerateLabel="Generate more"
              />
              {dataset && (dataset.examples?.length || 0) > 0 ? (
                <ExampleReview
                  examples={dataset.examples || []}
                  charter={state.charter}
                  loading={loading}
                  onUpdateExample={handleUpdateExample}
                  onDeleteExample={handleDeleteExample}
                  onImport={handleImport}
                  onSynthesize={handleSynthesize}
                  onAutoReview={handleAutoReview}
                  onExport={handleExport}
                  onShowCoverageMap={handleShowCoverageMap}
                  onNavigateToScorers={() => setActiveTab("scorers")}
                  onHeaderClick={() => {}}
                  isFocused={true}
                  onSuggestRevision={handleSuggestRevision}
                  onSuggestRevisions={handleBulkSuggestRevisions}
                  onAcceptRevision={handleAcceptRevision}
                  onDismissRevision={handleDismissRevision}
                  revisionsLoading={revisionsLoading}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-6 max-w-md text-center">
                    <div>
                      <h2 className="text-xl font-semibold text-fg-contrast mb-1">
                        Build your dataset
                      </h2>
                      <p className="text-sm text-fg-dim">
                        Create evaluation examples from your charter criteria,
                        or import an existing dataset.
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <button
                        onClick={handleGenerateDataset}
                        disabled={loading}
                        className="flex flex-col items-center gap-2 px-6 py-5 border border-border-hint hover:border-border-primary hover:bg-fill-neutral/30 transition-colors group disabled:opacity-50"
                      >
                        <AIIcon
                          width={24}
                          height={24}
                          className="text-fg-dim group-hover:text-fg-primary transition-colors"
                        />
                        <span className="text-sm font-medium text-fg-contrast">
                          {loading ? "Generating..." : "Generate"}
                        </span>
                        <span className="text-xs text-fg-dim">
                          Create examples from charter
                        </span>
                      </button>
                      <span className="text-xs text-fg-dim">or</span>
                      <button
                        onClick={handleImportDataset}
                        disabled={loading}
                        className="flex flex-col items-center gap-2 px-6 py-5 border border-border-hint hover:border-border-primary hover:bg-fill-neutral/30 transition-colors group disabled:opacity-50"
                      >
                        <Upload className="w-6 h-6 text-fg-dim group-hover:text-fg-primary transition-colors" />
                        <span className="text-sm font-medium text-fg-contrast">
                          Import
                        </span>
                        <span className="text-xs text-fg-dim">
                          Upload JSON or CSV file
                        </span>
                      </button>
                    </div>
                    <button
                      onClick={() => setActiveTab("scorers")}
                      className="text-xs text-fg-dim hover:text-fg-primary transition-colors"
                    >
                      Skip dataset, go straight to scorers →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "scorers" && (
            <>
              <RegenerateBanner
                artifact="scorers"
                activeVersion={activeSkillVersionNum}
                sourceVersion={lineageFor("scorers")}
                onRegenerate={async () => {
                  if (!sessionId) return;
                  try {
                    const res = await generateScorers(sessionId);
                    setScorers(res.scorers);
                    // Refresh state so lineage stamp propagates to banner.
                    const s = await getSession(sessionId);
                    setState(s.state as SessionState);
                  } catch (err) {
                    console.error("Failed to regenerate scorers:", err);
                  }
                }}
              />
              <ScorersPanel
                charter={state.charter}
                hasDataset={!!dataset}
                sessionId={sessionId || ""}
                scorers={scorers}
                onScorersChange={(newScorers) => {
                  setScorers(newScorers);
                  if (sessionId) {
                    saveScorers(sessionId, newScorers).catch((err) =>
                      console.error("Failed to save scorers:", err),
                    );
                  }
                }}
                onNavigateToEvaluate={() => setActiveTab("evaluate")}
              />
            </>
          )}

          {activeTab === "evaluate" && urlSessionId && (
            <EvaluatePanel
              sessionId={urlSessionId}
              dataset={dataset}
              scorerCount={scorers.length}
              hasSkillBody={!!state.charter.task.skill_body}
              onExport={handleExport}
              onRequestImprove={() => {
                setImproveAutoAnalyze(true);
                setActiveTab("improve");
              }}
              autoRun={evalAutoRun}
              onAutoRunConsumed={() => setEvalAutoRun(false)}
              onGoToSkill={() => setActiveTab("skill")}
              onGoToDataset={() => setActiveTab("dataset")}
              onGoToScorers={() => setActiveTab("scorers")}
              onGenerateScorersInline={async () => {
                if (!urlSessionId) return;
                const res = await generateScorers(urlSessionId);
                setScorers(res.scorers);
                const s = await getSession(urlSessionId);
                setState(s.state as SessionState);
              }}
            />
          )}

          {activeTab === "improve" && urlSessionId && state.charter.task.skill_body && (
            <ImprovePanel
              sessionId={urlSessionId}
              skillBody={state.charter.task.skill_body}
              onSkillBodyChange={(body) =>
                setState((prev) => ({
                  ...prev,
                  charter: {
                    ...prev.charter,
                    task: { ...prev.charter.task, skill_body: body },
                  },
                }))
              }
              onRequestEvaluate={() => {
                setEvalAutoRun(true);
                setActiveTab("evaluate");
              }}
              autoAnalyze={improveAutoAnalyze}
              onAutoAnalyzeConsumed={() => setImproveAutoAnalyze(false)}
            />
          )}
        </div>

      </div>

      {/* Coverage map overlay */}
      {showCoverageMap && gapAnalysis && (
        <CoverageMap
          gaps={gapAnalysis}
          onClose={() => setShowCoverageMap(false)}
        />
      )}

      {/* Settings overlay */}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function SidebarGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="text-[10px] font-medium uppercase tracking-wider text-fg-dim px-2 mb-1">
        {label}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function SidebarItem({
  label,
  active,
  onClick,
  disabled,
  badge,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  badge?: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex gap-2 items-center justify-between px-2 h-8 text-sm text-left transition-colors ${
        active
          ? "bg-fill-neutral text-fg-contrast"
          : disabled
            ? "text-fg-dim/50 cursor-not-allowed"
            : "text-fg-contrast hover:bg-fill-neutral/50"
      }`}
    >
      {icon ?? <StarIcon />}
      <span className="truncate w-full">{label}</span>
      {badge && (
        <span className="font-mono text-[10px] text-fg-dim bg-fill-neutral px-1.5 py-0.5 ml-2">
          {badge}
        </span>
      )}
    </button>
  );
}
