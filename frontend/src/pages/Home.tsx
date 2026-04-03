import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import type { ProjectSummary } from '../types'
import { listSessions, createSession, deleteSession } from '../api'

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

function statusLabel(project: ProjectSummary): { text: string; color: string } {
  if (project.has_dataset) return { text: 'Dataset', color: 'text-success' }
  if (project.has_charter) return { text: 'Charter', color: 'text-accent' }
  return { text: 'Draft', color: 'text-muted-foreground' }
}

export default function Home() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const fetchProjects = useCallback(async () => {
    try {
      const res = await listSessions()
      setProjects(res.sessions)
    } catch (err) {
      console.error('Failed to load projects:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  const handleNewProject = async () => {
    setCreating(true)
    try {
      const res = await createSession({ name: 'Untitled project' })
      navigate(`/project/${res.session_id}`)
    } catch (err) {
      console.error('Failed to create project:', err)
      setCreating(false)
    }
  }

  const handleDelete = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation()
    if (!confirm('Delete this project? This cannot be undone.')) return
    try {
      await deleteSession(projectId)
      setProjects(prev => prev.filter(p => p.id !== projectId))
    } catch (err) {
      console.error('Failed to delete project:', err)
    }
  }

  return (
    <div className="h-full bg-background flex flex-col">
      {/* Header */}
      <div className="h-11 border-b border-border bg-surface-raised flex items-center justify-between px-4 flex-shrink-0">
        <h1 className="text-sm font-semibold text-foreground">North Star</h1>
        <button
          onClick={handleNewProject}
          disabled={creating}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50 transition-all"
        >
          {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          New project
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto px-4 py-8">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <h2 className="text-lg font-semibold text-foreground mb-2">No projects yet</h2>
              <p className="text-sm text-muted-foreground mb-6 max-w-sm">
                Create a project to start defining what good AI output looks like for your feature.
              </p>
              <button
                onClick={handleNewProject}
                disabled={creating}
                className="flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50 transition-all"
              >
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                New project
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {projects.map(project => {
                const status = statusLabel(project)
                return (
                  <button
                    key={project.id}
                    onClick={() => navigate(`/project/${project.id}`)}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-border bg-surface-raised hover:border-foreground/20 hover:bg-muted/30 transition-all text-left group"
                  >
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium text-foreground truncate">{project.name}</h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        <span className={status.color}>{status.text}</span>
                        {' \u00b7 '}
                        {relativeTime(project.updated_at)}
                      </p>
                    </div>
                    <button
                      onClick={e => handleDelete(e, project.id)}
                      className="text-muted-foreground hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity p-1.5"
                      title="Delete project"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
