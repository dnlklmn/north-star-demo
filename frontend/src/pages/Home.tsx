import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2, Loader2, ChevronDown, BookOpen } from "lucide-react";
import type { ProjectSummary } from "../types";
import {
  createPromptEvalSession,
  createSession,
  deleteSession,
  listSessions,
  setSessionMode,
  seedFromSkill,
  fetchSkillFromUrl,
  updateSessionName,
} from "../api";
import {
  parseSkillFrontmatter,
  uniqueProjectName,
} from "../utils/skillFrontmatter";
import Button from "../components/ui/Button";
import IconButton from "../components/ui/IconButton";
import NewSkillEvalModal from "../components/NewSkillEvalModal";
import NewPromptEvalModal from "../components/NewPromptEvalModal";
import SettingsPanel from "../components/SettingsPanel";
import { GearIcon, StarIcon } from "../components/ui/Icons";
import {
  evictSession,
  getCachedSessionsList,
  patchCachedSessionName,
  setCachedSessionsList,
} from "../utils/projectCache";

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function statusBadge(project: ProjectSummary): string | null {
  if (project.has_dataset) return null;
  if (project.has_charter) return null;
  return "Draft";
}

export default function Home() {
  const navigate = useNavigate();
  // Seed from in-memory cache so a return-trip to Home renders instantly.
  // The fresh listSessions() call still fires in the background and swaps
  // the result in once it lands.
  const cachedList = getCachedSessionsList();
  const [projects, setProjects] = useState<ProjectSummary[]>(cachedList ?? []);
  const [loading, setLoading] = useState(cachedList === null);
  const [creating, setCreating] = useState(false);
  const [isNewSkillModalOpen, setIsNewSkillModalOpen] = useState(false);
  const [isNewPromptModalOpen, setIsNewPromptModalOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Open Settings on demand from outside (LLMBillingBanner's "Change key"
  // button dispatches northstar:open-settings).
  useEffect(() => {
    const handler = () => setShowSettings(true);
    window.addEventListener("northstar:open-settings", handler);
    return () => window.removeEventListener("northstar:open-settings", handler);
  }, []);

  // Close the new-eval dropdown on outside click or Escape.
  useEffect(() => {
    if (!isMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsMenuOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [isMenuOpen]);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await listSessions();
      setProjects(res.sessions);
      setCachedSessionsList(res.sessions);
    } catch (err) {
      console.error("Failed to load projects:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // Open modal to collect skill input before creating session
  const openNewSkillModal = () => {
    setIsMenuOpen(false);
    setIsNewSkillModalOpen(true);
  };

  const openNewPromptModal = () => {
    setIsMenuOpen(false);
    setIsNewPromptModalOpen(true);
  };

  const handleNewProject = async () => {
    setCreating(true);
    try {
      const res = await createSession({ name: "Untitled project" });
      navigate(`/project/${res.session_id}?tab=goals`);
    } catch (err) {
      console.error("Failed to create project:", err);
      alert(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setCreating(false);
    }
  };

  const handleCreatePromptEval = async (target: string, sampleSize: number, body: string) => {
    setCreating(true);
    try {
      const res = await createPromptEvalSession({
        prompt_target: target,
        sample_size: sampleSize,
        prompt_body: body,
      });
      setIsNewPromptModalOpen(false);
      navigate(`/project/${res.session_id}?tab=skill`);
    } catch (err) {
      console.error("Failed to create prompt eval:", err);
      alert(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setCreating(false);
    }
  };

  // Handle "Analyze" click from modal
  const handleAnalyze = async (input: string) => {
    setCreating(true);
    try {
      let skillBody = input.trim();
      // Skill metadata pulled either from GitHub fetch response or, when the
      // user pastes raw markdown, from local frontmatter parsing. Without
      // this, seedFromSkill received `{ skill_body }` only and the name +
      // description fields stayed empty after Analyze.
      let skillName: string | undefined;
      let skillDescription: string | undefined;

      // Check if input is a GitHub URL for SKILL.md
      const isGithubUrl = skillBody.startsWith('http') &&
        (skillBody.includes('github.com') || skillBody.includes('raw.githubusercontent.com')) &&
        skillBody.toLowerCase().includes('skill.md');

      if (isGithubUrl) {
        const fetchRes = await fetchSkillFromUrl(skillBody);
        skillBody = fetchRes.body;
        skillName = fetchRes.name ?? undefined;
        skillDescription = fetchRes.description ?? undefined;
      } else {
        // Pasted markdown — parse frontmatter and strip it from the body so
        // the SkillPanel later sees the same shape as the manual flow.
        const parsed = parseSkillFrontmatter(skillBody);
        skillBody = parsed.body;
        skillName = parsed.name;
        skillDescription = parsed.description;
      }

      // Create triggered-mode session
      const sessionRes = await createSession({ name: "Untitled skill eval" });
      await setSessionMode(sessionRes.session_id, "triggered");

      // Seed with skill content + metadata so charter.task.skill_name and
      // skill_description get populated server-side.
      if (skillBody) {
        await seedFromSkill(sessionRes.session_id, {
          skill_body: skillBody,
          skill_name: skillName,
          skill_description: skillDescription,
        });

        // Auto-rename the project to the skill name, with a numeric suffix
        // (" 2", " 3", ...) when another project already owns the bare name.
        if (skillName) {
          try {
            const list = await listSessions();
            const taken = new Set(
              list.sessions
                .filter((p) => p.id !== sessionRes.session_id)
                .map((p) => p.name?.trim())
                .filter(Boolean) as string[],
            );
            const desired = uniqueProjectName(skillName, taken);
            if (desired) {
              await updateSessionName(sessionRes.session_id, desired);
              patchCachedSessionName(sessionRes.session_id, desired);
            }
          } catch (err) {
            console.error("Failed to auto-rename project:", err);
          }
        }
      }

      setIsNewSkillModalOpen(false);
      navigate(`/project/${sessionRes.session_id}?tab=goals`);
    } catch (err) {
      console.error("Failed to analyze skill:", err);
      alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (projectId: string) => {
    if (!confirm("Delete this project? This cannot be undone.")) return;
    try {
      await deleteSession(projectId);
      setProjects((prev) => {
        const next = prev.filter((p) => p.id !== projectId);
        setCachedSessionsList(next);
        return next;
      });
      // Drop the project's cached state + dataset so a fresh project that
      // happens to reuse the id (extremely unlikely, but still) doesn't
      // get the dead row's data.
      evictSession(projectId);
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  };

  return (
    <div className="h-full flex flex-col bg-bg-default text-fg-contrast">
      {/* Top bar */}
      <header className="h-16 flex items-center justify-between px-4 flex-shrink-0 border-b border-border-hint">
        <IconButton tone="contrast" aria-label="North Star">
          <StarIcon />
        </IconButton>
        <div className="flex items-center gap-3">
          <Button
            size="small"
            variant="neutral"
            onClick={() => navigate("/docs")}
          >
            <BookOpen className="w-4 h-4" />
            Docs
          </Button>
          <Button
            size="small"
            variant="neutral"
            onClick={() => setShowSettings(true)}
          >
            <GearIcon />
            Settings
          </Button>
          <div ref={menuRef} className="relative flex items-stretch">
            <Button
              size="small"
              variant="primary"
              onClick={handleNewProject}
              disabled={creating}
              className="rounded-r-none"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              New project
            </Button>
            <Button
              size="small"
              variant="primary"
              onClick={() => setIsMenuOpen((v) => !v)}
              disabled={creating}
              aria-label="More eval types"
              className="rounded-l-none border-l border-black/20 px-2"
            >
              <ChevronDown className="w-4 h-4" />
            </Button>
            {isMenuOpen && (
              <div className="absolute right-0 top-full mt-1 w-56 bg-surface-raised border border-border shadow-lg z-30">
                <button
                  type="button"
                  onClick={openNewSkillModal}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-fill-neutral/30 text-foreground"
                >
                  New skill eval
                </button>
                <button
                  type="button"
                  onClick={openNewPromptModal}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-fill-neutral/30 text-foreground"
                >
                  New prompt eval
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-6 pt-16">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-5 h-5 animate-spin text-fg-dim" />
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <h2 className="text-lg font-semibold text-fg-contrast mb-2">
                No projects yet
              </h2>
              <p className="text-sm text-fg-dim mb-6 max-w-sm">
                Start with your business goals — North Star can generate them from a skill or prompt if you have one.
              </p>
              <Button
                size="big"
                variant="primary"
                onClick={handleNewProject}
                disabled={creating}
              >
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                New project
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-border-hint">
              {projects.map((project) => {
                const badge = statusBadge(project);
                return (
                  <li
                    key={project.id}
                    onClick={() => navigate(`/project/${project.id}`)}
                    className="group flex items-center justify-between h-11 px-2 -mx-2 cursor-pointer hover:bg-fill-neutral/30"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className="w-3 h-3 bg-fill-primary flex-shrink-0"
                        aria-hidden
                      />
                      <span className="text-sm text-fg-contrast truncate">
                        {project.name}
                      </span>
                      {project.kind === "prompt" && (
                        <span className="font-mono text-xs text-fg-dim bg-fill-neutral px-1.5 py-0.5">
                          prompt
                        </span>
                      )}
                      {badge && (
                        <span className="font-mono text-xs text-fg-dim bg-fill-neutral px-1.5 py-0.5">
                          {badge}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <IconButton
                        tone="dim"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(project.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Delete project"
                      >
                        <Trash2 className="w-4 h-4" />
                      </IconButton>
                      <span className="text-sm text-fg-dim ml-2">
                        {relativeTime(project.updated_at)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>
      {/* New Skill Eval Modal */}
      <NewSkillEvalModal
        isOpen={isNewSkillModalOpen}
        isLoading={creating}
        onClose={() => setIsNewSkillModalOpen(false)}
        onAnalyze={handleAnalyze}
      />
      <NewPromptEvalModal
        isOpen={isNewPromptModalOpen}
        isLoading={creating}
        onClose={() => setIsNewPromptModalOpen(false)}
        onCreate={handleCreatePromptEval}
      />
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
