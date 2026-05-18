import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowRight as ArrowRightLucide,
  Loader2,
  Sparkles as SparklesIcon,
} from "lucide-react";
import {
  GearIcon,
  AIIcon,
  StarIcon,
  GoalsIcon,
  SkillIcon,
  CharterIcon,
  DatasetIcon,
  ScorerIcon,
} from "../components/ui/Icons";
import type {
  Message,
  SessionState,
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
  suggestSkill,
  generateSkillFromGoals,
  createDataset,
  getDataset,
  synthesizeExamples,
  updateExample as apiUpdateExample,
  deleteExample as apiDeleteExample,
  autoReviewExamples,
  refreshDatasetFromTurns,
  retagExamplesAgainstCharter,
  getGapAnalysis,
  exportDataset,
  datasetChat,
  updateSessionName,
  updateSessionInput,
  saveScorers,
  generateScorers,
  suggestRevisions,
  listSessions,
  type SkillSuggestion,
} from "../api";
import Button from "../components/ui/Button";
import { uniqueProjectName } from "../utils/skillFrontmatter";
import { getAutoGenerateSuggestions } from "../utils/uiPrefs";
import {
  getCachedDataset,
  getCachedSession,
  patchCachedSessionName,
  patchCachedSessionState,
  setCachedDataset,
  setCachedSession,
} from "../utils/projectCache";
import IconButton from "../components/ui/IconButton";
import GoalsPanel from "../components/GoalsPanel";
import AddSourceBanner from "../components/AddSourceBanner";
import UsersPanel from "../components/UsersPanel";
import CharterPanel from "../components/CharterPanel";
import ScorersPanel from "../components/ScorersPanel";
import EvaluatePanel from "../components/EvaluatePanel";
import SkillPanel from "../components/SkillPanel";
import ExampleReview from "../components/ExampleReview";
import CoverageMap from "../components/CoverageMap";
import { computeCoverageScore } from "../components/coverage";
import GenerateModal from "../components/examples/GenerateModal";
import SettingsPanel from "../components/SettingsPanel";
import ShareModal from "../components/ShareModal";
import { useProjectEvents, type SynthProgressEvent } from "../hooks/useProjectEvents";
import { useShareToken } from "../hooks/useShareToken";
import {
  useRegisterPolarisContext,
  useRegisterPolarisNav,
  usePolaris,
} from "../polaris/usePolaris";
import PolarisAgentButton from "../polaris/PolarisAgentButton";
import { notePolarisActivity } from "../polaris/activity";

type ActiveTab =
  | "skill"
  | "goals"
  | "users"
  | "charter"
  | "dataset"
  | "scorers"
  | "evaluate";

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

// (ACTIVITY_LABELS / activityLabel removed with the rail's ConversationPanel.
//  Polaris emits its own inline activity markers in the chat transcript.)

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
  // Latched dataset filter: when the Evaluations panel sends the user to
  // the Dataset tab via the unmapped-rows banner, we stash the filter
  // here. ExampleReview reads it on mount and calls a clear callback so
  // the same filter doesn't keep snapping back the next time the user
  // navigates to Dataset normally.
  const [pendingDatasetFilter, setPendingDatasetFilter] = useState<string | null>(null);

  // --- Polaris transcript hydration ---
  // Read from the global Polaris provider so the rail chat stays in sync
  // with whatever conversation lives in `session.conversation`. The rail is
  // mounted by this page, but the transcript itself outlives any single
  // tab — that's the whole point of "one agent, one conversation."
  const { hydrateMessages: hydratePolarisMessages } = usePolaris();

  // --- Project metadata ---
  const [projectName, setProjectName] = useState("Untitled project");
  const [editingName, setEditingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // --- Shared state ---
  const [sessionId, setSessionId] = useState<string | null>(
    urlSessionId || null,
  );
  const [state, setState] = useState<SessionState>(EMPTY_STATE);
  // Legacy discovery-flow message log. Polaris (rail chat) owns its own
  // transcript via the PolarisProvider — these writes feed the dead
  // ConversationPanel that used to live in the rail. The underscore
  // tells eslint we know it's unused; full removal happens when the
  // discovery state machine is collapsed into Polaris tools.
  const [_messages, setMessages] = useState<Message[]>([]);
  void _messages;
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

  // --- Auto-generate-suggestions UI preference ---
  // Whether goal/story/skill suggestion fetches fire automatically as the
  // user types. Toggled in Settings → App. The SettingsPanel dispatches a
  // window event when it flips so we can react without a parent rerender.
  const [autoGenerateSuggestions, setAutoGenerateSuggestionsLocal] = useState(
    () => getAutoGenerateSuggestions(),
  );
  useEffect(() => {
    const handler = () =>
      setAutoGenerateSuggestionsLocal(getAutoGenerateSuggestions());
    window.addEventListener(
      "ns:auto-generate-suggestions-changed",
      handler,
    );
    return () =>
      window.removeEventListener(
        "ns:auto-generate-suggestions-changed",
        handler,
      );
  }, []);

  // --- Skill suggestion state (right rail on Skill tab) ---
  const [skillSuggestions, setSkillSuggestions] = useState<SkillSuggestion[]>(
    [],
  );
  const [skillSuggestionsLoading, setSkillSuggestionsLoading] = useState(false);
  // Dismissed suggestions are tracked by their summary text so a manual
  // refresh after a dismiss doesn't bring the same idea right back.
  const [dismissedSkillSuggestions, setDismissedSkillSuggestions] = useState<
    Set<string>
  >(new Set());

  // --- Goals "Add skill / Add prompt" banner ---
  // Always visible until the session has a skill body or is a prompt-eval
  // (the banner offer becomes moot once a skill/prompt is in place).

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
  // Setters are still wired so future "stale upstream" UX can read these
  // again; the read-side consumer (the regenerate-charter confirm prompt)
  // moved off the Goal page. Underscore prefix silences no-unused-vars.
  const [, setGoalsDirty] = useState(false);
  const [, setStoriesDirty] = useState(false);
  // Charter-edit → downstream stale. Flip true when the charter changes after
  // hydration; flip false after a successful (re)generation of that artifact.
  // Client-side only — survives tab switches within the session but not a
  // reload. Triggered-mode sessions also have skill-version lineage as a
  // separate mechanism; these flags cover standard mode too.
  const [datasetStale, setDatasetStale] = useState(false);
  const [scorersStale, setScorersStale] = useState(false);

  // --- Dataset phase state ---
  const [dataset, setDataset] = useState<Dataset | null>(null);
  // Legacy dataset-chat action suggestions. Polaris surfaces proposals
  // inline in the rail chat now; this state is still written by the old
  // datasetChat path until that's collapsed into Polaris tools.
  const [_actionSuggestions, setActionSuggestions] = useState<
    Array<{ action: string; label: string; reason: string }>
  >([]);
  void _actionSuggestions;

  // --- Scorers state (lifted up for persistence across tab switches) ---
  const [scorers, setScorers] = useState<ScorerDef[]>([]);

  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [retagLoading, setRetagLoading] = useState(false);
  const [gapAnalysis, setGapAnalysis] = useState<GapAnalysis | null>(null);
  const [showCoverageMap, setShowCoverageMap] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);

  // --- Sharing / access role ---
  // role flips from 'owner' (no token) → 'editor'/'viewer' once a session
  // fetch resolves the X-Share-Token header on the server.
  const { role } = useShareToken(sessionId);
  const canEdit = role !== "viewer";

  // Inline banner for 403 (write attempt by viewer). The modal-style toast
  // pattern would be over-engineering — a thin top-of-content message that
  // auto-clears after a few seconds is plenty.
  const [shareForbiddenMsg, setShareForbiddenMsg] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ message: string }>).detail;
      setShareForbiddenMsg(detail?.message || "You have read-only access to this project.");
      window.setTimeout(() => setShareForbiddenMsg(null), 5000);
    };
    window.addEventListener("northstar:share-forbidden", handler);
    return () => window.removeEventListener("northstar:share-forbidden", handler);
  }, []);

  // Open Settings on demand from outside the workspace (e.g. the global
  // LLMBillingBanner's "Change key" button — it lives in App.tsx and can't
  // reach our showSettings state directly).
  useEffect(() => {
    const handler = () => setShowSettings(true);
    window.addEventListener("northstar:open-settings", handler);
    return () => window.removeEventListener("northstar:open-settings", handler);
  }, []);

  // --- Polaris bus wiring ---
  // Tell the global Polaris provider about our current view so chat messages
  // are sent with up-to-date routing info (session_id, dataset_id, phase).
  // Pages own this — the provider doesn't try to derive it from the URL
  // because the same URL maps to multiple tabs.
  useRegisterPolarisContext({
    session_id: sessionId || undefined,
    dataset_id: dataset?.id || undefined,
    phase: activeTab as string | undefined,
  });
  // Register handlers for nav targets that this page owns. The provider
  // dispatches `home` / `project` itself (it owns react-router); everything
  // else delegates to whichever page is mounted.
  // Suppress the next activity-emission on tab change when Polaris itself
  // is the one switching tabs — the agent's tool_summary already shows the
  // nav, so doubling up would be noisy.
  const suppressNextTabActivityRef = useRef(false);
  useRegisterPolarisNav("phase", (props) => {
    const phase = props.phase as string | undefined;
    if (!phase) return;
    // The agent's nav_phase enum is kept in sync with ActiveTab in
    // polaris_tools.py; cast is safe so long as that stays true.
    suppressNextTabActivityRef.current = true;
    setActiveTab(phase as ActiveTab);
  });
  // Same suppression rule for example focus.
  const suppressNextExampleActivityRef = useRef(false);

  // Emit "opened X tab" into the Polaris transcript when the user (or any
  // non-Polaris code path) changes tabs. First render is silent — the
  // initial activeTab isn't a user action.
  const tabActivityFirstRenderRef = useRef(true);
  useEffect(() => {
    if (tabActivityFirstRenderRef.current) {
      tabActivityFirstRenderRef.current = false;
      return;
    }
    if (suppressNextTabActivityRef.current) {
      suppressNextTabActivityRef.current = false;
      return;
    }
    notePolarisActivity(`opened ${activeTab} tab`);
  }, [activeTab]);
  useRegisterPolarisNav("coverage_map", () => setShowCoverageMap(true));
  useRegisterPolarisNav("settings", () => setShowSettings(true));
  useRegisterPolarisNav("share", () => setShowShareModal(true));
  useRegisterPolarisNav("example", (props) => {
    const id = props.example_id as string | undefined;
    if (!id) return;
    suppressNextTabActivityRef.current = true;
    suppressNextExampleActivityRef.current = true;
    setActiveTab("dataset");
    // ExampleReview owns the row-selection state. Broadcast so it can
    // focus the row without lifting that state up to the page.
    window.dispatchEvent(
      new CustomEvent("polaris:select-example", { detail: { id } }),
    );
  });
  // Polaris run_eval (confirmed) routes here. Switch to the Evaluate tab,
  // then fire the start-run event the panel listens for. The tiny delay
  // gives EvaluatePanel a chance to mount its listener before the event
  // lands — a queue would be cleaner, but for one-shot intents this is
  // enough.
  useRegisterPolarisNav("eval_run_start", () => {
    setActiveTab("evaluate");
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("polaris:start-eval"));
    }, 120);
  });
  // Same pattern for scorer-draft.
  useRegisterPolarisNav("scorers_generate", () => {
    setActiveTab("scorers");
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("polaris:generate-scorers"));
    }, 120);
  });
  // Analyze the active (or named) eval run from chat — same as clicking the
  // "Analyze" button on the Evaluate tab.
  useRegisterPolarisNav("eval_run_analyze", (props) => {
    suppressNextTabActivityRef.current = true;
    setActiveTab("evaluate");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("polaris:analyze-run", {
          detail: { run_id: props.run_id as string | undefined },
        }),
      );
    }, 120);
  });
  // Cancel an in-flight eval run from chat.
  useRegisterPolarisNav("eval_run_cancel", (props) => {
    suppressNextTabActivityRef.current = true;
    setActiveTab("evaluate");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("polaris:cancel-run", {
          detail: { run_id: props.run_id as string | undefined },
        }),
      );
    }, 120);
  });
  // Promote / discard the candidate skill version from chat.
  useRegisterPolarisNav("skill_version_promote", (props) => {
    suppressNextTabActivityRef.current = true;
    setActiveTab("evaluate");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("polaris:promote-skill-version", {
          detail: { version_id: props.version_id as string | undefined },
        }),
      );
    }, 120);
  });
  useRegisterPolarisNav("skill_version_discard", (props) => {
    suppressNextTabActivityRef.current = true;
    setActiveTab("evaluate");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("polaris:discard-skill-version", {
          detail: { version_id: props.version_id as string | undefined },
        }),
      );
    }, 120);
  });
  useRegisterPolarisNav("dataset_filter", (props) => {
    setActiveTab("dataset");
    // Same event pattern as `example`: ExampleReview owns the filter state,
    // we forward what the agent picked so the table re-renders.
    window.dispatchEvent(
      new CustomEvent("polaris:set-filter", {
        detail: {
          feature_area: props.feature_area as string | undefined,
          label: props.label as string | undefined,
          review_status: props.review_status as string | undefined,
        },
      }),
    );
  });

  // Coverage map status comes from the gap analysis. Compute once per
  // gapAnalysis change so the dataset toolbar dot stays in sync.
  const coverageScore = computeCoverageScore(gapAnalysis);

  // Coverage-driven generate modal. The dataset toolbar still has its own
  // local Generate flow inside ExampleReview; this one is reserved for
  // requests originating from the CoverageMap (single cell + bulk fix).
  type CoverageGenerateRequest =
    | {
        kind: "cell";
        criterion: string;
        featureArea: string;
        currentCount: number;
      }
    | { kind: "fill"; emptyCells: Array<{ criterion: string; featureArea: string }> };
  const [coverageGenerateRequest, setCoverageGenerateRequest] =
    useState<CoverageGenerateRequest | null>(null);

  // --- Polaris activity feed (polled while drawer open) ---
  const activityCursorRef = useRef<string | null>(null);
  const seenActivityIdsRef = useRef<Set<string>>(new Set());

  // --- Hydration: cache-first, background refresh ---
  //
  // Render order on mount:
  //   1. If a cached SessionRecord (and optionally Dataset) exists for
  //      this id, apply them synchronously and clear `hydrating` so the
  //      page draws instantly.
  //   2. Always issue a parallel `getSession` + `getDataset` refresh in
  //      the background. When each lands, write to the cache and re-apply
  //      so any server-side change since the last visit shows up.
  //
  // `tabSetRef` makes the tab-determination logic (which is sticky to
  // first apply only) safe to re-run on background refreshes — the user's
  // current tab won't get stomped when fresh data lands seconds later.
  const tabSetRef = useRef(false);
  useEffect(() => {
    if (!urlSessionId) {
      setHydrating(false);
      return;
    }
    tabSetRef.current = false;
    let cancelled = false;

    type SessionRecord = Awaited<ReturnType<typeof getSession>>;

    const applySession = (session: SessionRecord) => {
      if (cancelled) return;
      const s = session.state as SessionState;
      setSessionId(urlSessionId);
      setState(s);
      const hydrated =
        session.conversation?.map((m: { role: string; content: string }) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })) || [];
      setMessages(hydrated);
      // Polaris owns its own transcript (rail chat). Hydrate it from the
      // same conversation so the user sees one continuous thread no matter
      // which surface they used to chat.
      hydratePolarisMessages(hydrated);

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
      if ((session as { name?: string }).name) {
        setProjectName((session as { name?: string }).name!);
      }
      if (s.scorers && s.scorers.length > 0) {
        setScorers(s.scorers);
      }
      if (s.input.business_goals || s.input.user_stories) {
        setSavedInput({
          goals: s.input.business_goals || "",
          stories: s.input.user_stories || "",
        });
      }
    };

    const applyDataset = (ds: Dataset | null) => {
      if (cancelled) return;
      if (ds) setDataset(ds);
    };

    const decideInitialTab = (
      session: SessionRecord,
      ds: Dataset | null,
    ) => {
      if (cancelled || tabSetRef.current) return;
      tabSetRef.current = true;
      const s = session.state as SessionState;
      const hasCharter = !!(
        s.charter.coverage.criteria.length || s.charter.alignment.length
      );
      const hasSkillBody = !!s.charter.task.skill_body;
      const isTriggered = s.eval_mode === "triggered";
      const isPromptEval = s.kind === "prompt";
      // ?tab= overrides every other rule. Read fresh from window.location
      // so this only fires on real session changes, not tab toggles.
      const tabParam = new URLSearchParams(window.location.search).get("tab");
      const validTabs: ActiveTab[] = [
        "skill", "goals", "users", "charter", "dataset", "scorers", "evaluate",
      ];
      const tabFromUrl = validTabs.includes(tabParam as ActiveTab)
        ? (tabParam as ActiveTab)
        : null;
      if (tabFromUrl) {
        setActiveTab(tabFromUrl);
        return;
      }
      if (isPromptEval) {
        setActiveTab("skill");
        return;
      }
      if (ds && (ds.examples?.length || 0) > 0) {
        setActiveTab("dataset");
        return;
      }
      if (hasCharter) {
        setActiveTab("charter");
        return;
      }
      if (hasSkillBody || isTriggered) {
        setActiveTab("goals");
        return;
      }
      if (s.input.story_groups && s.input.story_groups.length > 0) {
        setActiveTab("goals");
      }
    };

    // (1) Cache-first paint.
    const cachedSession = getCachedSession(urlSessionId);
    const cachedDataset = getCachedDataset(urlSessionId);
    if (cachedSession) {
      applySession(cachedSession as SessionRecord);
      if (cachedDataset) applyDataset(cachedDataset);
      decideInitialTab(cachedSession as SessionRecord, cachedDataset);
      setHydrating(false);
    }

    // (2) Background refresh — fire session + dataset in parallel, but
    // unblock the page as soon as the session lands. Dataset is optional
    // for an empty project (404) and shouldn't gate the first paint —
    // the user was watching a spinner for the full dataset round-trip on
    // every cache miss, including freshly-created sessions where the
    // 404 was guaranteed. Tab decision still needs both inputs to pick
    // the right starting tab, so it runs on the dataset settle path.
    const sessionPromise = getSession(urlSessionId);
    const datasetPromise = getDataset(urlSessionId);

    let sessionDoneValue: SessionRecord | null = null;
    let sessionDone = false;
    let datasetSettled = false;
    let datasetValue: Dataset | null = null;

    const maybeDecideTab = () => {
      if (cancelled || !sessionDone || !datasetSettled || !sessionDoneValue) return;
      decideInitialTab(sessionDoneValue, datasetValue);
    };

    sessionPromise
      .then((session) => {
        if (cancelled) return;
        sessionDoneValue = session as SessionRecord;
        sessionDone = true;
        applySession(session as SessionRecord);
        setCachedSession(urlSessionId, session as SessionRecord);
        // Render now — don't wait for dataset. For projects that already
        // have one, the dataset section will pop in when its fetch lands;
        // for empty projects, this saves a full RTT of staring at a spinner.
        setHydrating(false);
        maybeDecideTab();
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load project:", err);
        if (!cachedSession) navigate("/", { replace: true });
        // No session means no usable page — leave hydrating in the state
        // it was, the navigate above takes the user home.
      });

    datasetPromise
      .then(async (dataset) => {
        if (cancelled) return;
        datasetValue = dataset;
        // Prompt-eval auto-refresh: pull any new turns landed since the
        // last visit. Failure is non-fatal — we just show what we have.
        // Needs the session (for kind), so wait for it.
        try {
          const session = await sessionPromise;
          if (cancelled) return;
          const isPromptEval =
            (session.state as SessionState).kind === "prompt";
          if (isPromptEval && datasetValue) {
            try {
              const result = await refreshDatasetFromTurns(datasetValue.id);
              if (result.added > 0 && !cancelled) {
                datasetValue = await getDataset(urlSessionId);
              }
            } catch (err) {
              console.warn("auto-refresh from turns failed:", err);
            }
          }
        } catch {
          // Session promise already failed — just apply whatever dataset we have.
        }
        if (cancelled) return;
        applyDataset(datasetValue);
        if (datasetValue) setCachedDataset(urlSessionId, datasetValue);
      })
      .catch(() => {
        // 404 / network error — empty project most likely. Non-fatal.
      })
      .finally(() => {
        if (cancelled) return;
        datasetSettled = true;
        maybeDecideTab();
      });

    return () => {
      cancelled = true;
    };
  }, [urlSessionId, navigate, hydratePolarisMessages]);

  // --- Live updates: re-fetch session + dataset on SSE state_changed ---
  // The hook subscribes to /sessions/:id/events and calls this on every push.
  // We refetch session state (cheap, single request) and the dataset (only
  // if one already exists locally — avoids 404 spam on fresh projects).
  const handleLiveStateChange = useCallback(async () => {
    if (!sessionId) return;
    try {
      const session = await getSession(sessionId);
      setState(session.state as SessionState);
      // Keep the in-memory cache in sync so a return-trip to this project
      // (after navigating away and back) renders fresh data instantly.
      setCachedSession(sessionId, session);
    } catch (err) {
      console.warn("Live refetch (session) failed:", err);
    }
    try {
      const ds = await getDataset(sessionId);
      setDataset(ds);
      setCachedDataset(sessionId, ds);
    } catch {
      // No dataset yet, or fetch failed — non-fatal.
    }
  }, [sessionId]);
  // Live dataset-synth progress, driven by the backend's per-cell
  // `synth_progress` SSE event. Cleared back to null on the "done" phase
  // so the dataset overlay knows when to drop the live count and hide.
  const [synthProgress, setSynthProgress] = useState<{
    generated: number;
    total: number;
  } | null>(null);
  const handleSynthProgress = useCallback((event: SynthProgressEvent) => {
    if (event.phase === "done") {
      setSynthProgress(null);
      return;
    }
    setSynthProgress({ generated: event.generated, total: event.total });
  }, []);
  useProjectEvents(sessionId, handleLiveStateChange, handleSynthProgress);

  // Mirror React state → in-memory cache. Every setState((prev) => …) call
  // (charter edits, scorer toggles, skill body updates, etc.) trips this
  // effect, so the cached SessionRecord stays in lock-step without each
  // handler having to remember to update the cache. Same for dataset.
  useEffect(() => {
    if (!sessionId) return;
    if (state === EMPTY_STATE) return;
    patchCachedSessionState(sessionId, state);
  }, [sessionId, state]);
  useEffect(() => {
    if (!sessionId || !dataset) return;
    setCachedDataset(sessionId, dataset);
  }, [sessionId, dataset]);

  // Polaris write tools mutate session/dataset state directly via the DB
  // helpers, which broadcast over SSE — so the SSE listener above usually
  // catches it. The custom event is a backup for screens that don't have an
  // SSE subscription open (e.g. brief flicker between drawer open and SSE
  // reconnect).
  useEffect(() => {
    const handler = () => {
      handleLiveStateChange();
    };
    window.addEventListener("polaris:state-changed", handler);
    return () => window.removeEventListener("polaris:state-changed", handler);
  }, [handleLiveStateChange]);

  // `status` was passed to the legacy ConversationPanel — Polaris owns its
  // own loading/error state. Kept commented as a breadcrumb if a future
  // status surface needs it.
  // const status: AgentStatus = state.agent_status;
  const hasCharter = !!(
    state.charter.coverage.criteria.length || state.charter.alignment.length
  );
  const nonEmptyGoals = goals.filter((g) => g.trim());
  const totalStoryCount = storyGroups.reduce(
    (sum, g) =>
      sum + (g.role.trim() ? g.stories.filter((s) => s.what.trim()).length : 0),
    0,
  );

  // Tab availability. Goals is the entry point and always open; everything
  // downstream gates on its own data. Triggered- and prompt-eval projects
  // surface a Skill/Prompt nav item but no longer block the rest of the flow
  // — users can type goals manually or seed them via the Goals page banner.
  //
  // Prompt-eval projects share the full skill-eval flow: synthetic SKILL.md
  // describes the prompt under test, gets seeded through call_skill_seed
  // into goals/users/stories, then the user reviews the charter + generates
  // scorers exactly like a regular skill eval. The only divergence happens
  // at run time, where the eval task replays the prompt builder instead
  // of running skill_body as a system prompt.
  const isPromptEval = state.kind === "prompt";
  // Goals tab is always reachable — it's where users enter their goals.
  const usersAvailable = true;
  const charterAvailable = hasCharter || loading;
  // A skill body (or a prompt-eval, which has a synthetic skill_body) is the
  // gate for everything downstream of the charter. Without one, you can't
  // run a meaningful eval — there's nothing to evaluate against — so the
  // dataset/scorers/evaluate tabs stay locked. Prompt-eval projects always
  // have a synthetic body, so they're allowed through.
  const hasSkillBody = !!state.charter.task.skill_body;
  const skillReady = hasSkillBody || isPromptEval;
  // Memoize so the empty-array fallback doesn't churn SkillPanel's
  // initialVersions identity on every parent render — that would refire
  // its mirror effect and could clobber an optimistic local prepend.
  const skillVersionsSeed = useMemo(
    () => state.skill_versions ?? [],
    [state.skill_versions],
  );
  const datasetAvailable = skillReady && (isPromptEval ? !!dataset : hasCharter);
  const scorersAvailable = skillReady && hasCharter;
  const evaluateAvailable = skillReady && !!dataset;

  const [evalAutoRun, setEvalAutoRun] = useState(false);
  // Generation shortcuts on the Users tab. Independent spinners so the
  // "both" button reflects its own parallel run, not a false positive from
  // clicking the single-action ones while that's in flight.
  const [generatingDataset, setGeneratingDataset] = useState(false);
  // Unified scorer-generation state — lifted out of ScorersPanel so the
  // spinner + error survive tab switches and Polaris-triggered draftings
  // don't race the panel's mount.
  const [scorersGenerating, setScorersGenerating] = useState(false);
  const [scorersError, setScorersError] = useState<string | null>(null);
  // Legacy name kept because charter-shortcut handlers below reference it;
  // it now mirrors the unified flag exactly.
  const generatingScorersShortcut = scorersGenerating;
  const setGeneratingScorersShortcut = setScorersGenerating;
  const [generatingBoth, setGeneratingBoth] = useState(false);

  // Watchdog: while a generation is in flight, poll the session + dataset
  // every 5s. Belt-and-braces against the SSE event AND the long-lived
  // synth POST both getting lost (proxy timeout, throttled tab, etc.) —
  // without this, the user has to refresh the page to see rows that have
  // already landed in the DB. Lives down here (not next to useProjectEvents)
  // because the generating* flags are declared further down — referencing
  // them earlier hits a temporal-dead-zone ReferenceError on first render.
  useEffect(() => {
    if (!sessionId) return;
    const generating =
      generatingDataset || generatingScorersShortcut || generatingBoth;
    if (!generating) return;
    const tick = window.setInterval(() => {
      handleLiveStateChange();
    }, 5000);
    return () => window.clearInterval(tick);
  }, [
    sessionId,
    generatingDataset,
    generatingScorersShortcut,
    generatingBoth,
    handleLiveStateChange,
  ]);

  // --- Project name ---
  const startEditingName = () => {
    setEditingName(true);
    requestAnimationFrame(() => nameInputRef.current?.select());
  };

  const saveName = async () => {
    setEditingName(false);
    if (sessionId && projectName.trim()) {
      const trimmed = projectName.trim();
      // Patch the cache before the network round-trip so a Home navigation
      // before the response lands shows the new name immediately.
      patchCachedSessionName(sessionId, trimmed);
      updateSessionName(sessionId, trimmed).catch((err) => {
        console.error("Failed to save project name:", err);
      });
      notePolarisActivity(`renamed project to "${trimmed}"`);
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

  // (Activity polling for the rail's old ConversationPanel was removed when
  // Polaris moved into the header. Inline activity markers from Polaris
  // itself cover the same "what just happened" surface in the chat
  // transcript.)

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

  // Debounced auto-fetch of goal suggestions as the user types. First-fire
  // happens as soon as any goal has at least one non-whitespace character;
  // subsequent edits re-fire on a 1.5s idle. Keeps the right rail responsive
  // without spamming the backend every keystroke.
  const goalsTypingDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (hydrating) return;
    if (!autoGenerateSuggestions) return;
    const nonEmpty = goals.filter((g) => g.trim());
    if (nonEmpty.length === 0) return;
    if (goalsTypingDebounceRef.current) {
      window.clearTimeout(goalsTypingDebounceRef.current);
    }
    goalsTypingDebounceRef.current = window.setTimeout(() => {
      goalsTypingDebounceRef.current = null;
      fetchGoalSuggestions(goals);
    }, 1500);
    return () => {
      if (goalsTypingDebounceRef.current) {
        window.clearTimeout(goalsTypingDebounceRef.current);
        goalsTypingDebounceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goals, hydrating, autoGenerateSuggestions]);

  const fetchGoalSuggestions = useCallback(async (currentGoals: string[]) => {
    const nonEmpty = currentGoals.filter((g) => g.trim());
    if (nonEmpty.length === 0) return;

    setGoalSuggestionsLoading(true);
    try {
      const res = await suggestGoals(nonEmpty, urlSessionId ?? null);
      setGoalSuggestions(res.suggestions);
    } catch (err) {
      console.error("Failed to get goal suggestions:", err);
    } finally {
      setGoalSuggestionsLoading(false);
    }
  }, [urlSessionId]);

  // --- Skill suggestion fetcher ---
  const fetchSkillSuggestions = useCallback(async () => {
    const nonEmptyGoalsList = goals.filter((g) => g.trim());
    if (nonEmptyGoalsList.length === 0) {
      setSkillSuggestions([]);
      return;
    }
    const storiesPayload = storyGroups
      .filter((g) => g.role.trim())
      .flatMap((g) =>
        g.stories
          .filter((s) => s.what.trim())
          .map((s) => ({ who: g.role, what: s.what, why: s.why ?? "" })),
      );
    setSkillSuggestionsLoading(true);
    try {
      const res = await suggestSkill(
        nonEmptyGoalsList,
        storiesPayload,
        state.charter.task.skill_body || null,
        urlSessionId ?? null,
      );
      setSkillSuggestions(
        res.suggestions.filter(
          (s) => !dismissedSkillSuggestions.has(s.summary),
        ),
      );
    } catch (err) {
      console.error("Failed to fetch skill suggestions:", err);
    } finally {
      setSkillSuggestionsLoading(false);
    }
  }, [
    goals,
    storyGroups,
    state.charter.task.skill_body,
    urlSessionId,
    dismissedSkillSuggestions,
  ]);

  // Auto-fetch skill suggestions on a 1.5s idle debounce when the user is on
  // the Skill tab and at least one goal exists. Re-runs when goals or stories
  // change so the right rail stays in sync with the upstream context.
  const skillSuggestionsDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (hydrating) return;
    if (activeTab !== "skill") return;
    if (isPromptEval) return;
    if (!autoGenerateSuggestions) return;
    const nonEmptyGoalsList = goals.filter((g) => g.trim());
    if (nonEmptyGoalsList.length === 0) {
      setSkillSuggestions([]);
      return;
    }
    if (skillSuggestionsDebounceRef.current) {
      window.clearTimeout(skillSuggestionsDebounceRef.current);
    }
    skillSuggestionsDebounceRef.current = window.setTimeout(() => {
      skillSuggestionsDebounceRef.current = null;
      fetchSkillSuggestions();
    }, 1500);
    return () => {
      if (skillSuggestionsDebounceRef.current) {
        window.clearTimeout(skillSuggestionsDebounceRef.current);
        skillSuggestionsDebounceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTab,
    goals,
    storyGroups,
    hydrating,
    isPromptEval,
    autoGenerateSuggestions,
  ]);

  const handleAcceptSkillSuggestion = useCallback(
    (suggestion: SkillSuggestion) => {
      // Append the suggestion to the existing skill body as a new bullet,
      // prefixing the where-hint as a comment so the user can move it to
      // the right section if needed. Drops it from the local list once
      // accepted (and remembers it so a refresh doesn't re-suggest).
      const current = state.charter.task.skill_body || "";
      const sep = current.endsWith("\n") || current === "" ? "" : "\n";
      const wherePrefix = suggestion.where ? `<!-- ${suggestion.where} -->\n` : "";
      const next = `${current}${sep}\n${wherePrefix}- ${suggestion.summary}\n`;
      setState((prev) => ({
        ...prev,
        charter: {
          ...prev.charter,
          task: { ...prev.charter.task, skill_body: next },
        },
      }));
      setSkillSuggestions((prev) =>
        prev.filter((s) => s.summary !== suggestion.summary),
      );
      setDismissedSkillSuggestions((prev) =>
        new Set(prev).add(suggestion.summary),
      );
    },
    [state.charter.task.skill_body],
  );

  const handleDismissSkillSuggestion = useCallback(
    (suggestion: SkillSuggestion) => {
      setSkillSuggestions((prev) =>
        prev.filter((s) => s.summary !== suggestion.summary),
      );
      setDismissedSkillSuggestions((prev) =>
        new Set(prev).add(suggestion.summary),
      );
    },
    [],
  );

  // --- Generate full SKILL.md from goals + stories ---
  const [generatingSkillFromGoals, setGeneratingSkillFromGoals] =
    useState(false);
  // Snapshot of the goals + stories that produced the current skill body.
  // Drives the Generate / Regenerate button visibility on the Skill page:
  //   - null         → never generated → show "Generate from goals"
  //   - matches now  → fresh           → hide button
  //   - differs      → upstream changed → show "Regenerate from goals"
  const [generatedSkillSig, setGeneratedSkillSig] = useState<string | null>(
    null,
  );
  const currentGoalsSig = useMemo(
    () =>
      JSON.stringify({
        goals: goals.map((g) => g.trim()).filter(Boolean),
        story_groups: storyGroups
          .filter((g) => g.role.trim())
          .map((g) => ({
            role: g.role.trim(),
            stories: g.stories
              .filter((s) => s.what.trim())
              .map((s) => ({
                what: s.what.trim(),
                why: (s.why || "").trim(),
              })),
          })),
      }),
    [goals, storyGroups],
  );
  const skillFromGoalsFresh =
    generatedSkillSig !== null && generatedSkillSig === currentGoalsSig;
  const skillFromGoalsStale =
    generatedSkillSig !== null && generatedSkillSig !== currentGoalsSig;
  const handleGenerateSkillFromGoals = useCallback(async () => {
    if (!urlSessionId) return;
    if (state.charter.task.skill_body?.trim()) {
      const ok = window.confirm(
        "Replace the current skill body?\n\nThis overwrites the textarea with a fresh draft generated from your goals and user stories. Save the current body as a version first if you want to keep it.",
      );
      if (!ok) return;
    }
    // Capture the sig at request time so a stale sig from a future race
    // doesn't accidentally hide the button if goals change during the call.
    const sigAtRequest = currentGoalsSig;
    setGeneratingSkillFromGoals(true);
    try {
      const res = await generateSkillFromGoals(urlSessionId);
      // Backend strips frontmatter and persists body + name + description
      // on the session, then returns all three. Mirror them locally so the
      // Skill page renders immediately (the SSE refetch that follows the
      // _save_state call will overwrite anyway, but doing it here avoids a
      // visible flicker).
      setState((prev) => ({
        ...prev,
        charter: {
          ...prev.charter,
          task: {
            ...prev.charter.task,
            skill_body: res.body,
            skill_name: res.name ?? prev.charter.task.skill_name ?? null,
            skill_description:
              res.description ?? prev.charter.task.skill_description ?? null,
          },
        },
      }));
      setGeneratedSkillSig(sigAtRequest);

      // Rename the project to the skill name when the current name is still
      // a generic default. Dedupe against other projects with a " 2",
      // " 3"... suffix so two projects with the same skill don't collide.
      const desiredBase = res.name?.trim();
      if (desiredBase) {
        const currentName = projectName.trim();
        const isDefault =
          !currentName ||
          currentName === "Untitled project" ||
          currentName === "Untitled skill eval" ||
          currentName === "Skill eval";
        if (isDefault) {
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
              patchCachedSessionName(urlSessionId, candidate);
            }
          } catch (err) {
            console.error("Failed to rename project after generate:", err);
          }
        }
      }
    } catch (err) {
      console.error("Failed to generate skill from goals:", err);
      alert(
        `Could not generate skill — ${err instanceof Error ? err.message : "unknown error"}`,
      );
    } finally {
      setGeneratingSkillFromGoals(false);
    }
  }, [
    urlSessionId,
    state.charter.task.skill_body,
    currentGoalsSig,
    projectName,
  ]);

  const fetchGoalFeedback = useCallback(
    async (currentGoals: string[]) => {
      // Only critique goals the user typed. Goals the agent extracted (or
      // previously suggested and the user accepted as-is) shouldn't get
      // "here's a better phrasing" chips — feels schizophrenic to propose
      // text and then immediately critique it. We compare against
      // `extracted_goals` using the same first-40-char case-insensitive
      // match the backend's dedupe uses, so an agent-extracted goal the
      // user lightly edited (text differs) is still eligible for critique.
      const nonEmpty = currentGoals.filter((g) => g.trim());
      if (nonEmpty.length < 1) return;
      const extracted = (state.extracted_goals || []).map((g) =>
        g.trim().toLowerCase().slice(0, 40),
      );
      const isAgentExtracted = (g: string) =>
        extracted.includes(g.trim().toLowerCase().slice(0, 40));
      const userAdded = nonEmpty.filter((g) => !isAgentExtracted(g));
      if (userAdded.length < 1) {
        setGoalFeedback([]);
        return;
      }

      setGoalFeedbackLoading(true);
      try {
        const res = await evaluateGoals(userAdded, urlSessionId ?? null);
        setGoalFeedback(res.feedback);
      } catch (err) {
        console.error("Failed to evaluate goals:", err);
      } finally {
        setGoalFeedbackLoading(false);
      }
    },
    [state.extracted_goals, urlSessionId],
  );

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
        const res = await suggestStories(nonEmpty, existingStories, urlSessionId ?? null);
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
    [urlSessionId],
  );

  const handleStoryCommit = useCallback(() => {
    fetchStorySuggestions(goals, storyGroups);
  }, [goals, storyGroups, fetchStorySuggestions]);

  // "Generate from business goals" — explicit user request to seed user
  // stories from the current goals. Fetches suggestions AND auto-accepts
  // the first few into storyGroups so the page actually populates with
  // stories instead of leaving the work in the right rail.
  const handleGenerateStoriesFromGoals = useCallback(async () => {
    const nonEmpty = goals.filter((g) => g.trim());
    if (nonEmpty.length === 0) return;
    const existingStories = storyGroups
      .filter((g) => g.role.trim())
      .flatMap((g) =>
        g.stories
          .filter((s) => s.what.trim())
          .map((s) => ({ who: g.role, what: s.what, why: s.why })),
      );

    setStorySuggestionsLoading(true);
    try {
      const res = await suggestStories(
        nonEmpty,
        existingStories,
        urlSessionId ?? null,
      );
      const fresh = res.suggestions.map((s) => ({
        who: s.who,
        what: s.what,
        why: s.why || "",
      }));

      // Auto-insert the first three suggestions directly into storyGroups,
      // grouped by role. The remainder stays in the right-rail SuggestionBox
      // so the user can still pick from them.
      const TO_INSERT = 3;
      const toInsert = fresh.slice(0, TO_INSERT);
      const remainder = fresh.slice(TO_INSERT);

      setStoryGroups((prev) => {
        let next = prev;
        for (const story of toInsert) {
          const existingIdx = next.findIndex(
            (g) => g.role.toLowerCase() === story.who.toLowerCase(),
          );
          if (existingIdx >= 0) {
            next = [...next];
            next[existingIdx] = {
              ...next[existingIdx],
              stories: [
                ...next[existingIdx].stories,
                { what: story.what, why: story.why },
              ],
            };
          } else {
            next = [
              ...next,
              {
                role: story.who,
                stories: [{ what: story.what, why: story.why }],
              },
            ];
          }
        }
        return next;
      });
      setSuggestedStories(remainder);
    } catch (err) {
      console.error("Failed to generate stories from goals:", err);
    } finally {
      setStorySuggestionsLoading(false);
    }
  }, [goals, storyGroups, urlSessionId]);

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

  // First-visit auto-fetch of story suggestions from the existing goals.
  // Fires on the combined Goal tab (where the User Stories section lives)
  // as well as the legacy standalone "users" tab. Once the user has at
  // least one goal committed, we get a suggestion batch ready in the rail.
  const storyAutoSuggestedRef = useRef(false);
  useEffect(() => {
    if (activeTab !== "users" && activeTab !== "goals") return;
    if (!autoGenerateSuggestions) return;
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
    autoGenerateSuggestions,
  ]);

  useEffect(() => {
    return () => {
      if (storySuggestionDebounceRef.current) {
        window.clearTimeout(storySuggestionDebounceRef.current);
      }
    };
  }, []);

  // --- Skill / prompt seed completion ---
  // Re-hydrates session state, refreshes local goals/story_groups, and renames
  // the project from the freshly-extracted skill_name when the current name is
  // still a generic default. Used by both the SkillPanel (Analyze) and the
  // Goals-page AddSourceBanner (Add skill).
  const handleSessionSeeded = useCallback(async () => {
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
      // If the user had a fresh generation tracked, Analyze just re-extracted
      // goals/stories from the same skill body — refresh the signature to the
      // new shape so the Skill page doesn't immediately show "Regenerate
      // from goals" for what was, semantically, no upstream change.
      setGeneratedSkillSig((prev) => {
        if (prev === null) return prev;
        const goalsList = (session.state.input?.goals ?? [])
          .map((g) => g.trim())
          .filter(Boolean);
        const storyGroupsList = (
          (session.state.input?.story_groups ?? []) as StoryGroup[]
        )
          .filter((g) => g.role.trim())
          .map((g) => ({
            role: g.role.trim(),
            stories: g.stories
              .filter((s) => s.what.trim())
              .map((s) => ({
                what: s.what.trim(),
                why: (s.why || "").trim(),
              })),
          }));
        return JSON.stringify({
          goals: goalsList,
          story_groups: storyGroupsList,
        });
      });

      const desiredBase = session.state.charter?.task?.skill_name?.trim();
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
    } catch (err) {
      console.error("Failed to refresh after seed:", err);
    }
  }, [urlSessionId]);

  // --- Charter phase handlers ---

  const handleSubmitIntake = useCallback(async () => {
    const goalsText = nonEmptyGoals.join("\n");
    const storiesText = formatStoryGroups(storyGroups);
    if (!goalsText && !storiesText) return;

    notePolarisActivity("generating charter");
    suppressNextTabActivityRef.current = true;
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

  // Legacy chat handler — the rail no longer uses it (Polaris handles its
  // own send). Kept because the discovery state machine still emits
  // sendMessage / datasetChat calls from other code paths; will be
  // removed when those are collapsed into Polaris tools.
  const _handleSend = useCallback(
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
  void _handleSend;

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

  // Auto-fetch gap analysis whenever the dataset's example count changes.
  // The map is the user's "is my data hitting every cell" view, so it has
  // to stay in sync with the dataset — without making them open the modal
  // first. Skip while the dataset is empty.
  const datasetExampleCount = dataset?.examples?.length ?? 0;
  useEffect(() => {
    if (!dataset || datasetExampleCount === 0) {
      setGapAnalysis(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const gaps = await getGapAnalysis(dataset.id);
        if (!cancelled) setGapAnalysis(gaps);
      } catch (err) {
        console.error("Failed to fetch gap analysis:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataset?.id, datasetExampleCount]); // eslint-disable-line react-hooks/exhaustive-deps

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
    let ds = dataset;
    if (!ds) {
      await createDataset(sessionId);
      ds = await getDataset(sessionId);
      setDataset(ds);
    }
    let synthError: unknown = null;
    try {
      await synthesizeExamples(ds.id);
    } catch (err) {
      // Synth POST may fail with a network/timeout/proxy error even
      // when the backend has actually persisted rows. Capture the
      // error so we still rethrow downstream (the shortcut handler
      // wants it for telemetry), but DON'T skip the refetch — the
      // dataset on disk is the source of truth.
      synthError = err;
      console.error("Shortcut: generate dataset failed", err);
    }
    try {
      const fresh = await getDataset(sessionId);
      setDataset(fresh);
    } catch (refreshErr) {
      console.warn("Failed to refetch dataset after synth:", refreshErr);
    }
    if (synthError) throw synthError;
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

  // Unified entry-point for kicking off scorer generation from any surface
  // (panel button, charter-shortcut, Polaris). Owns the busy/error state so
  // the user sees consistent feedback regardless of where they triggered
  // it. `skipConfirm` is set by Polaris (it already showed its own confirm
  // chip) and by the charter shortcut (it has its own confirm dialog
  // upstream).
  const handleGenerateScorers = useCallback(
    async (opts?: { skipConfirm?: boolean }) => {
      if (!sessionId) {
        const msg = "no session loaded yet — open a project first";
        console.warn("[scorers] generate skipped:", msg);
        setScorersError(msg);
        notePolarisActivity(`scorer draft failed: ${msg}`);
        return;
      }
      // Guard against multiple concurrent runs (double-click, double-event).
      if (scorersGenerating) {
        console.warn("[scorers] generate already in flight");
        return;
      }
      if (
        scorers.length > 0 &&
        !opts?.skipConfirm &&
        !window.confirm(
          "Regenerate scorers?\n\nThis replaces the current scorer code — any manual edits will be lost.",
        )
      ) {
        return;
      }
      // Don't pre-empt on the frontend — the panel's "Generate scorers"
      // button is already gated on the charter having at least one
      // criterion (any of coverage/balance/alignment/rot). The parent's
      // hasCharter check was stricter than the button's hasCriteria, so
      // a project with only balance/rot criteria would see the button
      // enabled but the click would bail silently. Let the backend
      // return a 400 if it can't draft, and we'll show that error.
      console.log("[scorers] handleGenerateScorers start", {
        sessionId,
        scorerCount: scorers.length,
        skipConfirm: !!opts?.skipConfirm,
        hasCharter,
      });
      notePolarisActivity(
        scorers.length ? "regenerating scorers" : "drafting scorers",
      );
      setScorersError(null);
      setScorersGenerating(true);
      try {
        await runGenerateScorers();
        setScorersStale(false);
        console.log("[scorers] handleGenerateScorers complete");
        notePolarisActivity("scorer draft complete");
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to generate scorers";
        console.error("[scorers] handleGenerateScorers failed:", err);
        setScorersError(msg);
        notePolarisActivity(`scorer draft failed: ${msg}`);
      } finally {
        setScorersGenerating(false);
      }
    },
    [sessionId, scorers.length, scorersGenerating, hasCharter, runGenerateScorers],
  );

  // Parent listens for Polaris-triggered draft requests via a stable
  // listener (bound once at mount). The ref pattern keeps the latest
  // handler in scope without re-binding the event listener on every
  // scorers.length / hasCharter change — that re-bind churn was creating
  // a small window where the polaris:generate-scorers event could land
  // between teardown and re-setup and be silently dropped.
  const handleGenerateScorersRef = useRef(handleGenerateScorers);
  useEffect(() => {
    handleGenerateScorersRef.current = handleGenerateScorers;
  });
  useEffect(() => {
    const handler = () => {
      void handleGenerateScorersRef.current({ skipConfirm: true });
    };
    window.addEventListener("polaris:generate-scorers", handler);
    return () =>
      window.removeEventListener("polaris:generate-scorers", handler);
  }, []);

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
    notePolarisActivity(dataset ? "regenerating dataset" : "generating dataset");
    suppressNextTabActivityRef.current = true;
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
    suppressNextTabActivityRef.current = true;
    setActiveTab("scorers");
    // Routes through the unified handler so the generating + error state
    // lives in one place and survives tab switches. `skipConfirm` because
    // the charter shortcut already handled its own confirm dialog.
    await handleGenerateScorers({ skipConfirm: true });
  }, [scorers.length, scorersStale, handleGenerateScorers]);

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
    // Per-artifact flags drive the sidebar spinners so each one stops
    // independently — without these, the scorers spinner kept spinning
    // until the dataset finished even when scorers were done well first.
    if (!datasetFresh) setGeneratingDataset(true);
    if (!scorersFresh) setGeneratingScorersShortcut(true);
    try {
      // Ensure charter once, then fan out. Skip the ones that are already
      // fresh so users don't regenerate downstream work unnecessarily.
      await ensureCharter();
      const jobs: Promise<void>[] = [];
      if (!datasetFresh) {
        jobs.push(
          runGenerateDataset()
            .then(() => {
              setDatasetStale(false);
            })
            .finally(() => {
              setGeneratingDataset(false);
            }),
        );
      }
      if (!scorersFresh) {
        jobs.push(
          runGenerateScorers()
            .then(() => {
              setScorersStale(false);
            })
            .finally(() => {
              setGeneratingScorersShortcut(false);
            }),
        );
      }
      await Promise.all(jobs);
      setActiveTab("evaluate");
    } catch (err) {
      console.error("Shortcut: generate both failed", err);
    } finally {
      // Belt-and-braces: clear the umbrella flag and any per-artifact
      // flags that the inner finallys missed (e.g. ensureCharter threw
      // before the jobs array got a chance to wire them).
      setGeneratingBoth(false);
      setGeneratingDataset(false);
      setGeneratingScorersShortcut(false);
    }
  }, [ensureCharter, runGenerateDataset, runGenerateScorers, dataset, datasetStale, scorers.length, scorersStale, setGeneratingScorersShortcut]);

  const handleGenerateDataset = useCallback(async () => {
    if (!sessionId) return;
    // Drive both the global `loading` flag (for inline button states like
    // disabling "Auto-review") and the dataset-specific `generatingDataset`
    // flag (for the full-area overlay in ExampleReview that blocks per-row
    // actions while rows are being regenerated).
    setLoading(true);
    setGeneratingDataset(true);
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
      setGeneratingDataset(false);
    }
  }, [sessionId, dataset]);

  // --- Dataset phase handlers ---

  const handleSynthesize = useCallback(
    async (count?: number) => {
      if (!dataset) return;
      notePolarisActivity(
        `started synthesizing examples${count ? ` (${count}/scenario)` : ""}`,
      );
      setLoading(true);
      setGeneratingDataset(true);
      try {
        await synthesizeExamples(
          dataset.id,
          count ? { count_per_scenario: count } : undefined,
        );
        const fullDs = await getDataset(dataset.session_id);
        setDataset(fullDs);
        setDatasetStale(false);
        notePolarisActivity("synthesis complete");
      } catch (err) {
        console.error("Failed to synthesize:", err);
      } finally {
        setLoading(false);
        setGeneratingDataset(false);
      }
    },
    [dataset],
  );

  const handleUpdateExample = useCallback(
    async (exampleId: string, fields: Partial<Example>) => {
      if (!dataset) return;
      // Snapshot the pre-update example so we can roll back on failure.
      // Optimistic update first — the UI reflects the change instantly even
      // if the PATCH is slow or the backend is unresponsive. The SSE event
      // (or the awaited response below) overwrites it with the canonical
      // server version when the round trip completes.
      const prev = dataset.examples?.find((e) => e.id === exampleId);
      setDataset((current) => {
        if (!current) return current;
        return {
          ...current,
          examples: current.examples.map((e) =>
            e.id === exampleId ? { ...e, ...fields } : e,
          ),
        };
      });
      try {
        const updated = await apiUpdateExample(dataset.id, exampleId, fields);
        setDataset((current) => {
          if (!current) return current;
          return {
            ...current,
            examples: current.examples.map((e) =>
              e.id === exampleId ? updated : e,
            ),
          };
        });
        // Narrate the change into the Polaris transcript so the agent's
        // user can see what the click did. Most update flows are a single
        // field — describe that specifically; otherwise fall back to a
        // generic "edited" line.
        const short = exampleId.slice(0, 8);
        if (fields.review_status === 'approved') {
          notePolarisActivity(`approved example ${short}…`);
        } else if (fields.review_status === 'rejected') {
          notePolarisActivity(`rejected example ${short}…`);
        } else if (fields.label) {
          notePolarisActivity(`relabeled example ${short}… as ${fields.label}`);
        } else if (fields.input !== undefined || fields.expected_output !== undefined) {
          notePolarisActivity(`edited example ${short}…`);
        } else {
          notePolarisActivity(`updated example ${short}…`);
        }
      } catch (err) {
        console.error("Failed to update example:", err);
        // Roll back to the pre-update row so the UI doesn't lie about a
        // change that never landed. Surface the error so the user knows
        // why their click did nothing.
        if (prev) {
          setDataset((current) => {
            if (!current) return current;
            return {
              ...current,
              examples: current.examples.map((e) =>
                e.id === exampleId ? prev : e,
              ),
            };
          });
        }
        alert(
          `Couldn't save the change — ${err instanceof Error ? err.message : "unknown error"}. The backend may be unresponsive.`,
        );
      }
    },
    [dataset],
  );

  const handleDeleteExample = useCallback(
    async (exampleId: string) => {
      if (!dataset) return;
      // Optimistic remove — same pattern as handleUpdateExample. SSE
      // refresh + the awaited DELETE response are both belt-and-braces.
      const prevExamples = dataset.examples;
      setDataset((current) => {
        if (!current) return current;
        return {
          ...current,
          examples: current.examples.filter((e) => e.id !== exampleId),
        };
      });
      try {
        await apiDeleteExample(dataset.id, exampleId);
        notePolarisActivity(`deleted example ${exampleId.slice(0, 8)}…`);
      } catch (err) {
        console.error("Failed to delete example:", err);
        // Roll back so the row reappears.
        setDataset((current) =>
          current ? { ...current, examples: prevExamples } : current,
        );
        alert(
          `Couldn't delete the row — ${err instanceof Error ? err.message : "unknown error"}. The backend may be unresponsive.`,
        );
      }
    },
    [dataset],
  );

  const handleAutoReview = useCallback(async () => {
    if (!dataset) return;
    notePolarisActivity("started auto-review");
    setLoading(true);
    try {
      await autoReviewExamples(dataset.id);
      const fullDs = await getDataset(dataset.session_id);
      setDataset(fullDs);
      notePolarisActivity("auto-review complete");
    } catch (err) {
      console.error("Failed to auto-review:", err);
    } finally {
      setLoading(false);
    }
  }, [dataset]);

  const handleRetagAgainstCharter = useCallback(async () => {
    if (!dataset) return;
    setRetagLoading(true);
    try {
      await retagExamplesAgainstCharter(dataset.id);
      const fullDs = await getDataset(dataset.session_id);
      setDataset(fullDs);
    } catch (err) {
      console.error("Failed to retag against charter:", err);
      alert(`Retag failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setRetagLoading(false);
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
    // Refresh in case it's stale, but open the modal immediately — the
    // useEffect above keeps it warm so most opens are zero-latency.
    setShowCoverageMap(true);
    try {
      const gaps = await getGapAnalysis(dataset.id);
      setGapAnalysis(gaps);
    } catch (err) {
      console.error("Failed to get gaps:", err);
    }
  }, [dataset]);

  // CoverageMap "+" on a single cell — stage a generate request so the
  // GenerateModal can show with the right context. Actual synth happens
  // when the user confirms a count in the modal.
  const handleRequestCellGenerate = useCallback(
    (criterion: string, featureArea: string) => {
      const matrix = gapAnalysis?.coverage_matrix || {};
      const currentCount = matrix[criterion]?.[featureArea] ?? 0;
      setCoverageGenerateRequest({
        kind: "cell",
        criterion,
        featureArea,
        currentCount,
      });
    },
    [gapAnalysis],
  );

  // CoverageMap "Fix coverage" — same pattern as cell, but with all empty
  // cells gathered up. Lets the modal explain the bulk action before the
  // user commits.
  const handleRequestFillGaps = useCallback(() => {
    if (!gapAnalysis) return;
    const matrix = gapAnalysis.coverage_matrix || {};
    const criteria = Object.keys(matrix);
    const featureAreas = criteria.length > 0 ? Object.keys(matrix[criteria[0]] || {}) : [];
    const emptyCells: Array<{ criterion: string; featureArea: string }> = [];
    for (const c of criteria) {
      for (const fa of featureAreas) {
        if ((matrix[c]?.[fa] ?? 0) === 0) emptyCells.push({ criterion: c, featureArea: fa });
      }
    }
    if (emptyCells.length === 0) return;
    setCoverageGenerateRequest({ kind: "fill", emptyCells });
  }, [gapAnalysis]);

  // Modal confirm — branches by request kind. Per-cell scopes to exactly
  // one intersection; fill scopes to the union of missing criteria + areas
  // (best-effort: may over-generate if gaps are scattered).
  const handleConfirmCoverageGenerate = useCallback(
    async (count: number) => {
      if (!dataset || !coverageGenerateRequest) return;
      const req = coverageGenerateRequest;
      setCoverageGenerateRequest(null);
      setLoading(true);
      try {
        if (req.kind === "cell") {
          await synthesizeExamples(dataset.id, {
            feature_areas: [req.featureArea],
            coverage_criteria: [req.criterion],
            count_per_scenario: count,
          });
        } else {
          const missingCriteria = Array.from(new Set(req.emptyCells.map(c => c.criterion)));
          const missingAreas = Array.from(new Set(req.emptyCells.map(c => c.featureArea)));
          await synthesizeExamples(dataset.id, {
            feature_areas: missingAreas,
            coverage_criteria: missingCriteria,
            count_per_scenario: count,
          });
        }
        const fullDs = await getDataset(dataset.session_id);
        setDataset(fullDs);
      } catch (err) {
        console.error("Failed to generate from coverage map:", err);
      } finally {
        setLoading(false);
      }
    },
    [dataset, coverageGenerateRequest],
  );

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

  // Polaris lives in the header (PolarisAgentButton) — the right rail no
  // longer hosts it. The rail itself stays for other panels (radar, etc.)
  // but its bottom slot is empty now.

  // --- Next-button state per panel ---

  // Goals → User Stories. Two button shapes depending on whether stories
  // already exist:
  //   * no stories yet → primary "Generate user stories" + neutral "Add user
  //     stories" (Add navigates without auto-suggesting).
  //   * stories exist  → primary "Go to user stories" + neutral "Regenerate
  //     user stories". Goal-edit dirtiness is irrelevant; the user can pick
  //     Regenerate explicitly when they want a fresh draft.
  // Combined Goal page → next phase is now Skill (not Charter). Charter
  // generation lives on the Skill page. Goals only count once committed
  // (Enter / Submit) — typing into the trailing draft input does NOT flip
  // the button to primary.
  const committedGoalsCount = goals.slice(0, -1).filter((g) => g.trim()).length;
  // Without a skill body the next-phase action is "Generate" — same target
  // tab, but the verb signals there's still a missing artifact upstream of
  // the charter. Once a skill exists we drop back to "Go to" navigation.
  const goalNextLabel = isPromptEval
    ? skillReady
      ? "Go to prompt"
      : "Generate prompt"
    : skillReady
      ? "Go to skill"
      : "Generate skill";
  const goalNextDisabled = committedGoalsCount < 1 || loading;
  const goalNextVariant: "primary" | "neutral" =
    !goalNextDisabled ? "primary" : "neutral";

  return (
    <div className="h-full flex flex-col bg-bg-default text-fg-contrast">
      {/* Top bar */}
      <header className="h-16 flex items-center justify-between px-4 flex-shrink-0 border-b border-border-hint">
        <div className="flex items-center gap-4 min-w-0">
          <IconButton
            tone="contrast"
            onClick={() => navigate("/")}
            title="All projects"
          >
            <StarIcon />
          </IconButton>
          {/* Inline project title — editable in place. Lives here so users
              can rename without scrolling the sidebar, and stays visible on
              every tab. */}
          <div className="flex items-center gap-2 min-w-0">
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
                className="text-sm font-medium text-fg-contrast bg-transparent border-b border-border-primary outline-none min-w-0"
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
            {isPromptEval && (
              <span className="font-mono text-xs text-fg-dim bg-fill-neutral px-1.5 py-0.5 flex-shrink-0">
                prompt
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <PolarisAgentButton />
          {role === "owner" && sessionId && (
            <Button
              size="small"
              variant="neutral"
              onClick={() => setShowShareModal(true)}
            >
              Share
            </Button>
          )}
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

      {/* Role banner — viewers see a read-only notice, editors see a heads-up
          that they're acting via a shared link (so a stray click that doesn't
          land doesn't feel mysterious). */}
      {role === "viewer" && (
        <div className="px-4 py-2 text-xs bg-fill-neutral border-b border-border-hint text-fg-dim">
          You're viewing this project. Editing is disabled.
        </div>
      )}
      {role === "editor" && (
        <div className="px-4 py-2 text-xs bg-fill-neutral border-b border-border-hint text-fg-dim">
          You have edit access via a shared link.
        </div>
      )}
      {shareForbiddenMsg && (
        <div className="px-4 py-2 text-xs bg-danger/10 border-b border-danger/30 text-danger">
          {shareForbiddenMsg}
        </div>
      )}

      {/* Body: sidebar + main */}
      <div className="flex-1 flex min-h-0 gap-6">
        {/* Left sidebar */}
        <nav className="w-56 flex-shrink-0 px-4 py-6 overflow-y-auto border-r border-border-hint">
          {/* Nav groups — entry order: Goal → Skill/Prompt → Charter. */}
          <SidebarGroup hideTopDivider>
            <SidebarItem
              label="Goal"
              icon={<GoalsIcon width={24} height={24} />}
              active={activeTab === "goals" || activeTab === "users"}
              onClick={() => setActiveTab("goals")}
              disabled={!usersAvailable}
              disabledReason="Goal is the entry tab — it should always be available."
              badge={
                totalStoryCount > 0
                  ? `${nonEmptyGoals.length}/${totalStoryCount}`
                  : nonEmptyGoals.length > 0
                    ? `${nonEmptyGoals.length}`
                    : undefined
              }
            />
            <SidebarItem
              label={isPromptEval ? "Prompt" : "Skill"}
              icon={<SkillIcon width={24} height={24} />}
              active={activeTab === "skill"}
              onClick={() => setActiveTab("skill")}
            />
            <SidebarItem
              label="Charter"
              icon={<CharterIcon width={24} height={24} />}
              active={activeTab === "charter"}
              onClick={() => setActiveTab("charter")}
              disabled={!charterAvailable}
              loading={loading && !hasCharter}
              disabledReason="Charter generates after you submit your goals and user stories."
            />
          </SidebarGroup>

          <SidebarGroup>
            <SidebarItem
              label="Dataset"
              icon={<DatasetIcon width={24} height={24} />}
              active={activeTab === "dataset"}
              onClick={() => setActiveTab("dataset")}
              disabled={!datasetAvailable}
              loading={generatingDataset}
              disabledReason={
                !skillReady
                  ? `Add a ${isPromptEval ? "prompt" : "skill"} first — the dataset evaluates against it.`
                  : !hasCharter
                    ? "Generate the charter first; the dataset is built from its criteria."
                    : undefined
              }
            />
            <SidebarItem
              label="Scorers"
              icon={<ScorerIcon width={24} height={24} />}
              active={activeTab === "scorers"}
              onClick={() => setActiveTab("scorers")}
              disabled={!scorersAvailable}
              loading={generatingScorersShortcut}
              disabledReason={
                !skillReady
                  ? `Add a ${isPromptEval ? "prompt" : "skill"} first — scorers grade its output.`
                  : !hasCharter
                    ? "Generate the charter first; scorers map to its criteria."
                    : undefined
              }
            />
          </SidebarGroup>

          <SidebarGroup>
            <SidebarItem
              label="Evaluations"
              icon={<StarIcon width={24} height={24} />}
              active={activeTab === "evaluate"}
              onClick={() => setActiveTab("evaluate")}
              disabled={!evaluateAvailable}
              disabledReason={
                !skillReady
                  ? `Add a ${isPromptEval ? "prompt" : "skill"} to run evaluations against.`
                  : !dataset
                    ? "Generate the dataset first."
                    : undefined
              }
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
              isPromptEval={isPromptEval}
              promptSourcePath={state.prompt_source_path ?? null}
              promptBuilderName={state.prompt_builder_name ?? null}
              onSkillBodyChange={(body) => {
                setState((prev) => ({
                  ...prev,
                  charter: {
                    ...prev.charter,
                    task: { ...prev.charter.task, skill_body: body },
                  },
                }));
              }}
              activeVersionId={state.active_skill_version_id ?? null}
              candidateVersionId={state.candidate_skill_version_id ?? null}
              initialVersions={skillVersionsSeed}
              onCandidateChanged={async () => {
                if (!urlSessionId) return;
                const s = await getSession(urlSessionId);
                setState(s.state as SessionState);
              }}
              onBeforeAnalyze={() => {
                // Snap the user to the Charter tab the moment they click
                // "Generate charter" so the spinner shows up there
                // instead of the Skill page sitting silent during the
                // ~10s seed call. Flip loading too so the overlay
                // renders without waiting for handleSubmitIntake.
                setActiveTab("charter");
                setLoading(true);
              }}
              onAnalyzeError={() => {
                // Counterpart to onBeforeAnalyze — if the seed call throws
                // (bad URL, network blip, LLM rejection) we have to clear
                // the loading flag we just set, otherwise the Charter tab
                // sits stuck behind a permanent "Generating charter…"
                // overlay with no way to recover.
                setLoading(false);
              }}
              onSeeded={async () => {
                // Re-hydrate session state so the freshly-extracted
                // goals/users/stories land in local state, then push
                // straight into charter generation. The "Generate
                // charter" CTA on the Skill page should land the user
                // on a fresh charter, not bounce them through Goals.
                await handleSessionSeeded();
                handleSubmitIntake();
              }}
              onNext={() => {
                // Post-seed primary CTA — user clicks "Generate charter"
                // / "Regenerate charter" again. Confirms before
                // overwriting an existing charter, then jumps to
                // Charter immediately (so the spinner is visible there)
                // and re-runs the intake pass.
                if (hasCharter) {
                  const ok = window.confirm(
                    "Regenerate the charter?\n\nThis replaces the current criteria, alignment entries, and rot signals with a fresh draft built from your goals and stories.",
                  );
                  if (!ok) return;
                }
                setActiveTab("charter");
                setLoading(true);
                handleSubmitIntake();
              }}
              canEdit={canEdit}
              hasCharter={hasCharter}
              hasGoals={nonEmptyGoals.length > 0}
              skillSuggestions={skillSuggestions}
              skillSuggestionsLoading={skillSuggestionsLoading}
              onRefreshSkillSuggestions={fetchSkillSuggestions}
              onAcceptSkillSuggestion={handleAcceptSkillSuggestion}
              onDismissSkillSuggestion={handleDismissSkillSuggestion}
              onGenerateFromGoals={
                skillFromGoalsFresh ? undefined : handleGenerateSkillFromGoals
              }
              generatingFromGoals={generatingSkillFromGoals}
              regenerateFromGoals={skillFromGoalsStale}
              autoGenerateSuggestions={autoGenerateSuggestions}
            />
          )}

          {(activeTab === "goals" || activeTab === "users") && (
            <UsersPanel
              embedded
              autoGenerateSuggestions={autoGenerateSuggestions}
              hasGoals={nonEmptyGoals.length > 0}
              onGenerateFromGoals={handleGenerateStoriesFromGoals}
              goalSuggestions={goalSuggestions}
              goalSuggestionsLoading={goalSuggestionsLoading}
              onAcceptGoalSuggestion={handleAcceptGoalSuggestion}
              onDismissGoalSuggestion={handleDismissGoalSuggestion}
              onRefreshGoalSuggestions={handleGoalCommit}
              topBanner={
                canEdit &&
                urlSessionId &&
                !state.charter.task.skill_body &&
                !isPromptEval ? (
                  <AddSourceBanner
                    sessionId={urlSessionId}
                    onSeeded={handleSessionSeeded}
                    onPromptCreated={(newSessionId) => {
                      navigate(`/project/${newSessionId}?tab=goals`);
                    }}
                  />
                ) : undefined
              }
              preBody={
                <>
                  <GoalsPanel
                    embedded
                    goals={goals}
                    onGoalsChange={handleGoalsChange}
                    onGoalCommit={handleGoalCommit}
                    goalSuggestions={goalSuggestions}
                    onAcceptGoalSuggestion={handleAcceptGoalSuggestion}
                    onDismissGoalSuggestion={handleDismissGoalSuggestion}
                    suggestionsLoading={goalSuggestionsLoading}
                    goalFeedback={goalFeedback}
                    goalFeedbackLoading={goalFeedbackLoading}
                    // Embedded → footer/right not rendered, but the prop is
                    // required. Wire to the combined-page primary so the
                    // values stay coherent with what the parent shows.
                    onNext={() => {
                      if (!skillReady && !isPromptEval) {
                        void handleGenerateSkillFromGoals();
                      }
                      setActiveTab("skill");
                    }}
                    nextLabel={goalNextLabel}
                    nextVariant={goalNextVariant}
                    nextDisabled={goalNextDisabled}
                    canEdit={canEdit}
                  />
                </>
              }
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
                // Primary CTA on the combined Goal page. Always navigates to
                // the Skill tab. When no skill exists yet (and we're not a
                // prompt-eval, which has a synthetic body), also kick off the
                // backend pass that drafts a SKILL.md from goals + stories so
                // the Skill page fills in once generation completes.
                setGoalsDirty(false);
                setStoriesDirty(false);
                if (!skillReady && !isPromptEval) {
                  void handleGenerateSkillFromGoals();
                }
                setActiveTab("skill");
              }}
              nextLabel={goalNextLabel}
              nextVariant={goalNextVariant}
              nextDisabled={goalNextDisabled}
              loading={loading}
              // Polaris moved to the header — no chat in the rail bottom.
              canEdit={canEdit}
            />
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
              // Polaris moved to the header — no chat in the rail bottom.
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
              canEdit={canEdit}
              skillReady={skillReady}
              isPromptEval={isPromptEval}
              onGenerateSkill={() => {
                // Mirror the Goal-page CTA: navigate to Skill and, when
                // there's no skill yet, kick off generation in flight so the
                // textarea fills in once the LLM call completes.
                if (!skillReady && !isPromptEval) {
                  void handleGenerateSkillFromGoals();
                }
                setActiveTab("skill");
              }}
              hasCharter={hasCharter}
              onGenerateCharter={() => {
                // User landed on an empty Charter page directly (e.g. via
                // sidebar after the skill was generated) — let them kick
                // off the intake pass right here. Same handler as the
                // Skill page CTA; loading is already reflected by the
                // panel's own overlay.
                setLoading(true);
                handleSubmitIntake();
              }}
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
                    generating={generatingDataset || generatingBoth}
                    generatingProgress={synthProgress}
                    generatingTotal={(() => {
                      // Best-effort upper bound on rows we're about to land
                      // — coverage criteria × alignment areas × default
                      // count-per-scenario. Synthesize falls back to a single
                      // grid call when off-target/safety rows exist; either
                      // way this is a reasonable "expected" hint.
                      const cov =
                        state.charter.coverage?.criteria?.length || 0;
                      const align = state.charter.alignment?.length || 0;
                      const cells = Math.max(cov * align, 1);
                      return cells * 2;
                    })()}
                    onUpdateExample={handleUpdateExample}
                    onDeleteExample={handleDeleteExample}
                    onSynthesize={handleSynthesize}
                    onAutoReview={handleAutoReview}
                    onExport={handleExport}
                    onShowCoverageMap={handleShowCoverageMap}
                    onNavigateToScorers={() => setActiveTab("scorers")}
                    onHeaderClick={() => {}}
                    isFocused={true}
                    coverageScore={coverageScore}
                    onSuggestRevision={handleSuggestRevision}
                    onSuggestRevisions={handleBulkSuggestRevisions}
                    onAcceptRevision={handleAcceptRevision}
                    onDismissRevision={handleDismissRevision}
                    revisionsLoading={revisionsLoading}
                    onRetagAgainstCharter={isPromptEval && hasCharter ? handleRetagAgainstCharter : undefined}
                    retagLoading={retagLoading}
                    canEdit={canEdit}
                    initialFeatureAreaFilter={pendingDatasetFilter}
                    onInitialFilterApplied={() => setPendingDatasetFilter(null)}
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
                      // button while work is happening. Once examples land
                      // in `dataset` we leave this branch entirely, so the
                      // spinner can't outlive the generation it's reporting.
                      const generating = loading || generatingDataset || generatingBoth;
                      const cov = state.charter.coverage?.criteria?.length || 0;
                      const align = state.charter.alignment?.length || 0;
                      const expected = Math.max(cov * align, 1) * 2;
                      return (
                        <>
                        <button
                          onClick={handleGenerateDataset}
                          disabled={generating || !hasCharter}
                          className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-accent text-accent-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
                        >
                          {generating ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              {synthProgress
                                ? `Generated ${synthProgress.generated} of ${synthProgress.total} rows…`
                                : `Generating ~${expected} rows…`}
                            </>
                          ) : (
                            <>
                              <AIIcon width={16} height={16} />
                              Generate dataset
                            </>
                          )}
                        </button>
                        </>
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
                externalGenerating={scorersGenerating || generatingBoth}
                externalError={scorersError}
                onGenerate={() => handleGenerateScorers()}
                canEdit={canEdit}
              />
            </>
          )}

          {activeTab === "evaluate" && urlSessionId && (
            <EvaluatePanel
              sessionId={urlSessionId}
              dataset={dataset}
              scorerCount={scorers.length}
              hasSkillBody={!!state.charter.task.skill_body}
              isPromptEval={isPromptEval}
              skillBody={state.charter.task.skill_body || ""}
              onSkillBodyChange={(body) =>
                setState((prev) => ({
                  ...prev,
                  charter: {
                    ...prev.charter,
                    task: { ...prev.charter.task, skill_body: body },
                  },
                }))
              }
              onRunEval={async (overrides) => {
                if (!urlSessionId) return null
                // RunEvalRequest.project is required — bail rather than send
                // an empty string the backend would create a malformed run for.
                if (!overrides?.project) return null
                try {
                  const { runEval } = await import("../api")
                  const run = await runEval(urlSessionId, {
                    project: overrides.project,
                    experiment_name: overrides?.experiment_name,
                    limit: overrides?.limit,
                    include_triggering: overrides?.include_triggering,
                  })
                  return run
                } catch (err) {
                  console.error("Failed to start eval:", err)
                  return null
                }
              }}
              autoRun={evalAutoRun}
              onAutoRunConsumed={() => setEvalAutoRun(false)}
              onGoToSkill={() => setActiveTab("skill")}
              onGoToDataset={() => setActiveTab("dataset")}
              onGoToScorers={() => setActiveTab("scorers")}
              onGoToCharter={() => setActiveTab("charter")}
              onGoToUnmappedRows={() => {
                setPendingDatasetFilter("(unmapped)");
                setActiveTab("dataset");
              }}
              onGenerateScorersInline={async () => {
                if (!urlSessionId) return
                const res = await generateScorers(urlSessionId)
                setScorers(res.scorers)
                setScorersStale(false)
                const s = await getSession(urlSessionId)
                setState(s.state as SessionState)
              }}
              onOpenSettings={() => setShowSettings(true)}
              onRunTerminal={async () => {
                if (!urlSessionId) return
                try {
                  const fresh = await getDataset(urlSessionId)
                  setDataset(fresh)
                } catch (err) {
                  console.warn("dataset refetch after run-terminal failed:", err)
                }
              }}
              candidateVersionId={state.candidate_skill_version_id ?? null}
              activeVersionId={state.active_skill_version_id ?? null}
              onCandidateChanged={async () => {
                if (!urlSessionId) return
                const s = await getSession(urlSessionId)
                setState(s.state as SessionState)
              }}
              onSessionChanged={async () => {
                if (!urlSessionId) return
                const s = await getSession(urlSessionId)
                setState(s.state as SessionState)
              }}
            />
          )}

        </div>

      </div>

      {/* Coverage map overlay */}
      {showCoverageMap && gapAnalysis && (
        <CoverageMap
          gaps={gapAnalysis}
          onClose={() => setShowCoverageMap(false)}
          onRequestCellGenerate={handleRequestCellGenerate}
          onRequestFillGaps={handleRequestFillGaps}
        />
      )}

      {/* Coverage-driven generate modal — staged by the CoverageMap, runs
          synth scoped to the requested cell or set of empty cells. */}
      {coverageGenerateRequest && (
        <GenerateModal
          onConfirm={count => void handleConfirmCoverageGenerate(count)}
          onCancel={() => setCoverageGenerateRequest(null)}
          {...buildCoverageGenerateModalProps(coverageGenerateRequest)}
        />
      )}

      {/* Settings overlay */}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      {/* Share overlay — owner-only; rendered unconditionally so its open
          state can animate, gated on sessionId so the URL is stable. */}
      {sessionId && (
        <ShareModal
          sessionId={sessionId}
          open={showShareModal}
          onClose={() => setShowShareModal(false)}
        />
      )}
    </div>
  );
}

// Mirror of CoverageGenerateRequest in the component scope above. Kept
// here so the module-level helper can stay pure / testable without
// pulling component state.
type CoverageGenerateRequestExt =
  | {
      kind: "cell";
      criterion: string;
      featureArea: string;
      currentCount: number;
    }
  | { kind: "fill"; emptyCells: Array<{ criterion: string; featureArea: string }> };

function buildCoverageGenerateModalProps(req: CoverageGenerateRequestExt): {
  suggestedCount: number;
  suggestionReason: string;
  totalScenarios: number;
} {
  if (req.kind === "cell") {
    // Per-cell: 2 examples per scenario, one scenario (this intersection).
    const suggestedCount: number = 2;
    const isEmpty = req.currentCount === 0;
    const reason = isEmpty
      ? `${suggestedCount} more example${suggestedCount === 1 ? "" : "s"} will cover "${req.criterion}" × "${req.featureArea}".`
      : `Add ${suggestedCount} more example${suggestedCount === 1 ? "" : "s"} for variety in "${req.criterion}" × "${req.featureArea}". Currently has ${req.currentCount}.`;
    return {
      suggestedCount,
      suggestionReason: reason,
      totalScenarios: 1,
    };
  }
  // fill: scope is the union of missing criteria × missing areas, so the
  // synth backend ranges across that grid. The user's count input maps to
  // examples-per-scenario in that grid.
  const missingCriteria = new Set(req.emptyCells.map(c => c.criterion));
  const missingAreas = new Set(req.emptyCells.map(c => c.featureArea));
  const scenarios = missingCriteria.size * missingAreas.size;
  const suggestedCount = 2;
  const reason = `${req.emptyCells.length} intersection${req.emptyCells.length === 1 ? "" : "s"} are empty. Generating ${suggestedCount} per scenario across the ${missingCriteria.size} missing criteria × ${missingAreas.size} feature area${missingAreas.size === 1 ? "" : "s"} will fill the gaps (some intersections that already have examples may also receive new ones).`;
  return {
    suggestedCount,
    suggestionReason: reason,
    totalScenarios: scenarios,
  };
}

/**
 * SidebarGroup — visually a thin divider above the group's items.
 * The original "INPUT/GENERATE/OUTPUT" labels were noise in the new design;
 * the grouping is communicated by the divider lines instead.
 */
function SidebarGroup({
  label: _label,
  children,
  hideTopDivider,
}: {
  label?: string;
  children: React.ReactNode;
  hideTopDivider?: boolean;
}) {
  return (
    <>
      {!hideTopDivider && <div className="border-t border-border-hint mx-2 my-2" />}
      <div className="flex flex-col">{children}</div>
    </>
  );
}

function SidebarItem({
  label,
  active,
  onClick,
  disabled,
  badge,
  icon,
  loading,
  disabledReason,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  badge?: string;
  icon?: React.ReactNode;
  /** When true, render a spinner in the trailing slot (e.g. while the
   *  artifact behind this nav item is being generated). */
  loading?: boolean;
  /** When this item is disabled, surfaced as a hover tooltip explaining why. */
  disabledReason?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      className={`flex gap-2.5 items-center justify-between px-2 py-2 text-base text-left transition-colors ${
        active
          ? "bg-fill-primary/10 text-fg-primary font-bold [&_svg]:text-fg-primary"
          : disabled
            ? "text-fg-dim/50 cursor-not-allowed"
            : "text-fg-contrast hover:bg-fill-neutral/50 font-medium"
      }`}
    >
      {icon ?? <StarIcon />}
      <span className="truncate w-full">{label}</span>
      {loading && (
        <Loader2 className="w-4 h-4 text-fg-dim animate-spin flex-shrink-0" />
      )}
      {!loading && badge && (
        <span
          className={`font-mono text-[10px] px-1.5 py-0.5 ml-2 ${
            active ? "bg-fill-primary/20 text-fg-primary" : "bg-fill-neutral text-fg-dim"
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
