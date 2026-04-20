import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2, Loader2 } from "lucide-react";
import type { ProjectSummary } from "../types";
import { listSessions, createSession, deleteSession } from "../api";
import Button from "../components/ui/Button";
import IconButton from "../components/ui/IconButton";
import { GearIcon, StarIcon } from "../components/ui/Icons";

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
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await listSessions();
      setProjects(res.sessions);
    } catch (err) {
      console.error("Failed to load projects:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleNewProject = async () => {
    setCreating(true);
    try {
      const res = await createSession({ name: "Untitled project" });
      navigate(`/project/${res.session_id}`);
    } catch (err) {
      console.error("Failed to create project:", err);
      setCreating(false);
    }
  };

  const handleDelete = async (projectId: string) => {
    if (!confirm("Delete this project? This cannot be undone.")) return;
    try {
      await deleteSession(projectId);
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
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
          <Button size="small" variant="neutral">
            <GearIcon />
            Settings
          </Button>
          <Button
            size="small"
            variant="primary"
            onClick={handleNewProject}
            disabled={creating}
          >
            {creating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            New project
          </Button>
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
                Create a project to start defining what good AI output looks
                like for your feature.
              </p>
              <Button
                size="big"
                variant="primary"
                onClick={handleNewProject}
                disabled={creating}
              >
                {creating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
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
    </div>
  );
}
