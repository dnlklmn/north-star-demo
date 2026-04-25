import { useState, useCallback, useRef, useEffect } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight as ArrowRightLucide, Loader2, Sparkles as SparklesIcon } from "lucide-react";
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
  TaskDefinition,
} from "../types";
import {
  createSession,
  getSession,
  sendMessage,
  patchCharter,
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
import { uniqueProjectName } from "../utils/skillFrontmatter";
import IconButton from "../components/ui/IconButton";
import GoalsPanel from "../components/GoalsPanel";
import UsersPanel from "../components/UsersPanel";
import CharterPanel from "../components/CharterPanel";
import ScorersPanel from "../components/ScorersPanel";
import EvaluatePanel from "../components/EvaluatePanel";
import ImprovePanel from "../components/ImprovePanel";
import SkillPanel from "../components/SkillPanel";
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
  const [searchParams] = useSearchParams();
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
  // Charter-edit → downstream stale. Flip true when the charter changes after
  // hydration; flip false after a successful (re)generation of that artifact.
  // Client-side only — survives tab switches within the session but not a
  // reload. Triggered-mode sessions also have skill-version lineage as a
  // separate mechanism; these flags cover standard mode too.
  const [datasetStale, setDatasetStale] = useState(false);
  const [scorersStale, setScorersStale] = useState(false);

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

         // Check for ?tab= query param (e.g. ?tab=goals from Home modal)
         const tabParam = searchParams.get("tab");
         const validTabs: ActiveTab[] = ["skill", "goals", "users", "charter", "dataset", "scorers", "evaluate", "improve"];
         const tabFromUrl = validTabs.includes(tabParam as ActiveTab) ? tabParam as ActiveTab : null;

         // Try to load dataset. For skill-mode sessions that haven't built a
         // charter yet, land on the Skill tab so the user sees what they just
         // pasted — not the empty goals screen. Brand-new triggered sessions
         // (no skill body yet) also land on Skill so the paste form is the
         // first thing the user sees.
         try {
           const ds = await getDataset(urlSessionId);
           setDataset(ds);
           if (tabFromUrl) {
             setActiveTab(tabFromUrl);
           } else if (ds.examples?.length > 0) {
             setActiveTab("dataset");
           } else if (hasCharter) {
             setActiveTab("charter");
           } else if (hasSkillBody || isTriggered) {
             setActiveTab("skill");
           }
         } catch {
           // No dataset yet
           if (tabFromUrl) {
             setActiveTab(tabFromUrl);
           } else if (hasCharter) {
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
    async (field: keyof TaskDefinition, value: string) => {
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

  // Mark downstream artifacts stale whenever the charter changes after the
  // initial hydration. Only stamp stale for artifacts that actually exist —
  // there's no "regenerate" affordance for something that was never generated.
  const charterChangeInitRef = useRef(true);
  useEffect(() => {
    if (charterChangeInitRef.current) {
      charterChangeInitRef.current = false;
      return;
    }
    if (dataset) setDatasetStale(true);
    if (scorers.length > 0) setScorersStale(true);
  }, [state.charter]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // --- Phase transition: charter -> dataset/scorers ---

  // Shortcuts triggered from the Charter page footer: run any prerequisites
  // (charter generation) if missing, then kick off the downstream work —
  // dataset, scorers, or both in parallel — and navigate to the relevant
  // tab so the user sees the output.
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
    // "Go to" short-circuit: artifact exists and isn't marked stale, so just
    // navigate — no point regenerating over a fresh dataset.
    if (dataset && !datasetStale) {
      setActiveTab("dataset");
      return;
    }
    // Regenerating an existing dataset is destructive — confirm so the user
    // doesn't lose their reviewed examples by an accidental click.
    if (dataset && datasetStale) {
      const ok = window.confirm(
        "Regenerate the dataset?\n\nThis replaces the current examples — your review status, edits, and labels will be lost.",
      );
      if (!ok) return;
    }
    // Switch tabs first so the user immediately sees the spinner instead of
    // staring at the charter page wondering whether anything happened.
    setActiveTab("dataset");
    setGeneratingDataset(true);
    try {
      await runGenerateDataset();
      setDatasetStale(false);
    } finally {
      setGeneratingDataset(false);
    }
  }, [dataset, datasetStale, runGenerateDataset]);

  const handleShortcutScorers = useCallback(async () => {
    if (scorers.length > 0 && !scorersStale) {
      setActiveTab("scorers");
      return;
    }
    if (scorers.length > 0 && scorersStale) {
      const ok = window.confirm(
        "Regenerate scorers?\n\nThis replaces the current scorer code — any manual edits will be lost.",
      );
      if (!ok) return;
    }
    setActiveTab("scorers");
    setGeneratingScorersShortcut(true);
    try {
      await runGenerateScorers();
      setScorersStale(false);
    } finally {
      setGeneratingScorersShortcut(false);
    }
  }, [scorers.length, scorersStale, runGenerateScorers]);

  const handleShortcutBoth = useCallback(async () => {
    const datasetFresh = !!dataset && !datasetStale;
    const scorersFresh = scorers.length > 0 && !scorersStale;
    // Confirm only the side(s) that are being regenerated. If both fresh we
    // wouldn't be here in the first place; if both missing, no confirm.
    const datasetWillRegen = !!dataset && datasetStale;
    const scorersWillRegen = scorers.length > 0 && scorersStale;
    if (datasetWillRegen || scorersWillRegen) {
      const parts: string[] = [];
      if (datasetWillRegen) parts.push("dataset (review status + edits will be lost)");
      if (scorersWillRegen) parts.push("scorers (manual code edits will be lost)");
      const ok = window.confirm(
        `Regenerate ${parts.join(" and ")}?`,
      );
      if (!ok) return;
    }
    // Land on the dataset tab right away so the spinner shows there while
    // both jobs run in the background. Once both finish we move on to the
    // evaluate tab, which is the natural next step after generation.
    setActiveTab("dataset");
    setGeneratingBoth(true);
    try {
      // Ensure charter once, then fan out. Skip the ones that are already
      // fresh so users don't regenerate downstream work unnecessarily.
      await ensureCharter();
      const jobs: Promise<void>[] = [];
      if (!datasetFresh) jobs.push(runGenerateDataset().then(() => { setDatasetStale(false); }));
      if (!scorersFresh) jobs.push(runGenerateScorers().then(() => { setScorersStale(false); }));
      await Promise.all(jobs);
      setActiveTab("evaluate");
    } catch (err) {
      console.error("Shortcut: generate both failed", err);
    } finally {
      setGeneratingBoth(false);
    }
  }, [ensureCharter, runGenerateDataset, runGenerateScorers, dataset, datasetStale, scorers.length, scorersStale]);

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
      setDatasetStale(false);
    } catch (err) {
      console.error("Failed to generate dataset:", err);
    } finally {
      setLoading(false);
    }
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
        setDatasetStale(false);
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

  // Goals → User Stories. Same tri-state pattern as the other transitions:
  //   * no stories yet         → "Generate user stories" (primary)
  //   * stories exist, goals changed → "Regenerate user stories" (primary)
  //   * stories exist, no changes    → "Go to user stories" (neutral)
  // Stories can be agent-extracted from goals, user-authored, or both — but
  // the CTA unifies on "Generate" for consistency with downstream steps.
  const hasAnyStories = storyGroups.some(
    (g) => g.role.trim() && g.stories.some((s) => s.what.trim()),
  );
  const goalsNextLabel = !hasAnyStories
    ? "Generate user stories"
    : goalsDirty
      ? "Regenerate user stories"
      : "Go to user stories";
  const goalsNextDisabled = nonEmptyGoals.length < 2;
  // Only "Generate" (no stories yet) gets primary. Regenerate + Go to stay
  // neutral — re-running is safe + reversible, so we don't visually push it.
  const goalsNextVariant: "primary" | "neutral" =
    !goalsNextDisabled && !hasAnyStories ? "primary" : "neutral";

  // User Stories → Charter. Three CTA states:
  //   * no charter yet           → "Generate charter" (primary)
  //   * charter exists, dirty    → "Regenerate charter" (primary)
  //   * charter exists, unchanged → "Go to charter" (neutral)
  // "Dirty" here means goals OR stories have changed since the charter was
  // last (re)generated, i.e. the previous steps are ahead of the charter.
  const upstreamDirty = storiesDirty || goalsDirty;
  const storiesNextLabel = !hasCharter
    ? "Generate charter"
    : upstreamDirty
      ? "Regenerate charter"
      : "Go to charter";
  const storiesHasContent = storyGroups.some(
    (g) => g.role.trim() && g.stories.some((s) => s.what.trim()),
  );
  const storiesNextDisabled = !storiesHasContent || loading;
  // Same rule as Goals → Stories: primary only on first-time Generate;
  // Regenerate + Go to are neutral.
  const storiesNextVariant: "primary" | "neutral" =
    !storiesNextDisabled && !hasCharter ? "primary" : "neutral";

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
                      const candidate = uniqueProjectName(desiredBase, taken);
                      if (candidate && candidate !== currentName) {
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
              onNext={() => setActiveTab("goals")}
            />
          )}

          {activeTab === "goals" && (
            <>
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
              rightBottom={showAssistant ? undefined : aiAssistButton}
              rightBottomExpanded={showAssistant ? polarisPanel : undefined}
            />
            </>
          )}

          {activeTab === "users" && (
            <>
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
              onNext={() => {
                setStoriesDirty(false);
                // "Go to charter" skips regeneration when nothing upstream
                // changed. Otherwise generate/regenerate then navigate — the
                // submit handler already switches tabs on success.
                if (hasCharter && !upstreamDirty) {
                  setActiveTab("charter");
                  return;
                }
                if (hasCharter && upstreamDirty) {
                  // Confirm before overwriting an existing charter — user
                  // edits to criteria, alignment entries, etc. will be lost.
                  const ok = window.confirm(
                    "Regenerate the charter?\n\nThis replaces the current criteria, alignment entries, and rot signals with a fresh draft built from your goals and stories.",
                  );
                  if (!ok) return;
                }
                handleSubmitIntake();
              }}
              nextLabel={storiesNextLabel}
              nextVariant={storiesNextVariant}
              nextDisabled={storiesNextDisabled}
              loading={loading}
              rightBottom={showAssistant ? undefined : aiAssistButton}
              rightBottomExpanded={showAssistant ? polarisPanel : undefined}
            />
            </>
          )}

          {activeTab === "charter" && (
            <>
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
              rightBottom={showAssistant ? undefined : aiAssistButton}
              rightBottomExpanded={showAssistant ? polarisPanel : undefined}
              onGenerateDataset={handleShortcutDataset}
              onGenerateScorers={handleShortcutScorers}
              onGenerateBoth={handleShortcutBoth}
              generatingDataset={generatingDataset}
              generatingScorers={generatingScorersShortcut}
              generatingBoth={generatingBoth}
              datasetState={
                !dataset ? "missing" : datasetStale ? "stale" : "fresh"
              }
              scorersState={
                scorers.length === 0 ? "missing" : scorersStale ? "stale" : "fresh"
              }
            />
            </>
          )}

          {activeTab === "dataset" && (
            <div className="flex-1 min-h-0 flex flex-col relative">
              {dataset && (dataset.examples?.length || 0) > 0 ? (
                <>
                  <ExampleReview
                    examples={dataset.examples || []}
                    charter={state.charter}
                    loading={loading}
                    onUpdateExample={handleUpdateExample}
                    onDeleteExample={handleDeleteExample}
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
                  {/* Once every example has been reviewed, surface the tri-state
                      scorers CTA — Generate / Regenerate / Go to — mirroring the
                      footer pattern on Goals / Stories / Charter. Hidden while
                      the user is still reviewing so it doesn't distract. */}
                  {(() => {
                    const allReviewed = (dataset?.examples || []).length > 0 &&
                      !(dataset?.examples || []).some((e) => e.review_status === 'pending');
                    if (!allReviewed) return null;
                    const scorersStateLocal: "missing" | "stale" | "fresh" =
                      scorers.length === 0 ? "missing" : scorersStale ? "stale" : "fresh";
                    const label = scorersStateLocal === "missing"
                      ? "Generate scorers"
                      : scorersStateLocal === "stale"
                        ? "Regenerate scorers"
                        : "Go to scorers";
                    const isGoTo = scorersStateLocal === "fresh";
                    // Primary only when actually generating for the first
                    // time. Regenerate + Go to stay neutral so the page
                    // doesn't insistently push a re-run.
                    const isPrimary = scorersStateLocal === "missing";
                    return (
                      <div className="absolute bottom-8 right-8 pointer-events-auto">
                        <Button
                          size="big"
                          variant={isPrimary ? "primary" : "neutral"}
                          onClick={() => void handleShortcutScorers()}
                          disabled={!!(generatingScorersShortcut || loading)}
                        >
                          {generatingScorersShortcut ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : isGoTo ? (
                            <ArrowRightLucide className="w-4 h-4" />
                          ) : (
                            <SparklesIcon className="w-4 h-4" />
                          )}
                          {label}
                        </Button>
                      </div>
                    );
                  })()}
                </>
              ) : (
                // Empty state for when the user lands on Dataset directly
                // (no charter-page shortcut involved). Generation is the only
                // path — no "import or generate?" decision — so the button
                // just kicks off synthesis. Shortcuts from the charter page
                // have already started generation by the time we land here.
                <div className="flex-1 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-6 max-w-md text-center">
                    <div>
                      <h2 className="text-xl font-semibold text-fg-contrast mb-1">
                        Build your dataset
                      </h2>
                      <p className="text-sm text-fg-dim">
                        Generate evaluation examples from your charter criteria.
                      </p>
                    </div>
                    {(() => {
                      // Spinner during any path that's currently generating
                      // dataset content — direct click, charter shortcut, or
                      // the combined "both" action. Without this the user
                      // lands here from a charter shortcut and sees a static
                      // button while work is happening.
                      const generating = loading || generatingDataset || generatingBoth;
                      return (
                        <button
                          onClick={handleGenerateDataset}
                          disabled={generating || !hasCharter}
                          className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-accent text-accent-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
                        >
                          {generating ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Generating...
                            </>
                          ) : (
                            <>
                              <AIIcon width={16} height={16} />
                              Generate dataset
                            </>
                          )}
                        </button>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "scorers" && (
            <>
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
                externalGenerating={generatingScorersShortcut || generatingBoth}
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
                setScorersStale(false);
                const s = await getSession(urlSessionId);
                setState(s.state as SessionState);
              }}
              onOpenSettings={() => setShowSettings(true)}
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
