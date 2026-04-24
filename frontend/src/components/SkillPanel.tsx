import { useEffect, useState } from 'react'
import { Eye, FileText, History, Loader2, RotateCcw, Save, Zap } from 'lucide-react'
import type { SkillVersion } from '../types'
import {
  createSkillVersion,
  listSkillVersions,
  restoreSkillVersion,
  seedFromSkill,
  setSessionMode,
} from '../api'
import DiffModal from './DiffModal'

interface Props {
  sessionId: string
  skillBody: string
  skillName: string | null
  skillDescription: string | null
  onSkillBodyChange: (body: string) => void
  /** Called after a successful skill-seed (first Analyze). Parent refreshes
   *  session state to pick up extracted goals/users/stories and unlocks
   *  downstream tabs. */
  onSeeded?: () => void
  /** Called when the user clicks "Start from scratch" — parent has already
   *  flipped the session to standard mode via api. */
  onStartFromScratch?: () => void
}

/** Parse YAML-ish frontmatter from a pasted SKILL.md. Body has it stripped. */
function parseSkillFrontmatter(raw: string): {
  name?: string
  description?: string
  body: string
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!match) return { body: raw }
  const front = match[1]
  const body = match[2]
  const lines = front.split(/\r?\n/)
  const pick = (key: string) => {
    const line = lines.find((l) => l.trim().toLowerCase().startsWith(`${key}:`))
    if (!line) return undefined
    const value = line.split(':').slice(1).join(':').trim()
    return value.replace(/^["']|["']$/g, '')
  }
  return { name: pick('name'), description: pick('description'), body }
}

/**
 * First tab in every triggered-mode session.
 *
 * One layout, always. The UI is identical whether you're pasting a brand-new
 * SKILL.md or coming back to edit an existing one — a single body textarea +
 * name/description fields + version history. The primary action adapts:
 *
 *   - No versions yet:      "Analyze"     → seeds goals/users/stories + v1.
 *   - Has versions, edited: "Save as v+1" → creates a new version (no seed).
 *   - Has versions, clean:  button hidden.
 *
 * The "Start from scratch" escape hatch only shows when no versions exist yet.
 */
export default function SkillPanel({
  sessionId,
  skillBody,
  skillName,
  skillDescription,
  onSkillBodyChange,
  onSeeded,
  onStartFromScratch,
}: Props) {
  const [draft, setDraft] = useState(skillBody)
  const [nameDraft, setNameDraft] = useState(skillName ?? '')
  const [descriptionDraft, setDescriptionDraft] = useState(skillDescription ?? '')
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [notes, setNotes] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [diffVs, setDiffVs] = useState<{
    title: string
    subtitle?: string
    oldLabel: string
    newLabel: string
    oldText: string
    newText: string
  } | null>(null)

  // Sync drafts with external changes (e.g. ImprovePanel just saved a new
  // version, or Home just created a fresh blank session).
  useEffect(() => {
    setDraft(skillBody)
  }, [skillBody])
  useEffect(() => {
    setNameDraft(skillName ?? '')
  }, [skillName])
  useEffect(() => {
    setDescriptionDraft(skillDescription ?? '')
  }, [skillDescription])

  const refreshVersions = async () => {
    try {
      const v = await listSkillVersions(sessionId)
      setVersions(v)
    } catch {
      // non-fatal
    }
  }

  useEffect(() => {
    refreshVersions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const activeVersion = versions[0]
  const hasVersions = versions.length > 0
  const hasChanges = draft !== skillBody
  const canAnalyze = !hasVersions && draft.trim().length > 0
  const canSave = hasVersions && hasChanges

  const handleAnalyze = async () => {
    if (!canAnalyze) return
    setWorking(true)
    setError(null)
    try {
      const parsed = parseSkillFrontmatter(draft)
      const finalName = nameDraft.trim() || parsed.name
      const finalDescription = descriptionDraft.trim() || parsed.description
      const finalBody = parsed.body
      await setSessionMode(sessionId, 'triggered')
      await seedFromSkill(sessionId, {
        skill_body: finalBody,
        skill_name: finalName || undefined,
        skill_description: finalDescription || undefined,
      })
      onSkillBodyChange(finalBody)
      await refreshVersions()
      onSeeded?.()
    } catch (err) {
      console.error('Seed failed', err)
      setError(err instanceof Error ? err.message : 'Failed to analyze SKILL.md')
    } finally {
      setWorking(false)
    }
  }

  const handleSave = async () => {
    if (!canSave) return
    setWorking(true)
    setError(null)
    try {
      const newVersion = await createSkillVersion(sessionId, {
        body: draft,
        notes: notes.trim() || undefined,
        created_from: 'manual',
      })
      onSkillBodyChange(draft)
      setVersions((prev) => [newVersion, ...prev])
      setNotes('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save new version')
    } finally {
      setWorking(false)
    }
  }

  const handleStartFromScratch = async () => {
    try {
      await setSessionMode(sessionId, 'standard')
      onStartFromScratch?.()
    } catch (err) {
      console.error('Failed to switch to scratch mode:', err)
    }
  }

  const handleRestore = async (v: SkillVersion) => {
    if (!confirm(`Restore v${v.version} as active? Your current body stays in history.`)) return
    try {
      await restoreSkillVersion(sessionId, v.id)
      onSkillBodyChange(v.body)
      setDraft(v.body)
      refreshVersions()
    } catch (err) {
      console.error('Restore failed', err)
    }
  }

  const whenLabel = (iso: string | null | undefined): string =>
    iso ? new Date(iso).toLocaleString() : ''

  const nextVersion = (activeVersion?.version ?? 0) + 1

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 h-12 border-b border-border bg-surface-raised flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Skill</h2>
          {activeVersion && (
            <span className="text-[11px] font-mono text-muted-foreground">
              · active v{activeVersion.version}
            </span>
          )}
          {!hasVersions && (
            <span className="text-[11px] font-mono text-muted-foreground">
              · not analyzed yet
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasChanges && hasVersions && (
            <button
              onClick={() =>
                setDiffVs({
                  title: `Preview v${nextVersion}`,
                  oldLabel: `v${activeVersion?.version ?? 0}`,
                  newLabel: `v${nextVersion} (draft)`,
                  oldText: skillBody,
                  newText: draft,
                })
              }
              className="text-xs px-2 py-1 text-muted-foreground hover:text-foreground"
            >
              <Eye className="w-3.5 h-3.5 inline" /> Preview diff
            </button>
          )}
          {canAnalyze && (
            <button
              onClick={handleAnalyze}
              disabled={working}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1 font-medium bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              {working ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Analyze
            </button>
          )}
          {canSave && (
            <button
              onClick={handleSave}
              disabled={working}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1 font-medium bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              {working ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save as v{nextVersion}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl space-y-6">
          {!hasVersions && (
            <div className="px-3 py-2 bg-accent/5 border-l-2 border-accent text-xs text-foreground">
              Paste a SKILL.md below and click <strong>Analyze</strong>. The agent
              extracts goals, user roles, positive stories, and off-target stories —
              you'll review them next.
            </div>
          )}

          <section className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                Skill name
              </label>
              <input
                type="text"
                placeholder="auto-detected from frontmatter"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                className="w-full px-3 py-2 border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                disabled={working}
              />
            </div>
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                Description
              </label>
              <input
                type="text"
                placeholder="the routing signal — auto-detected from frontmatter"
                value={descriptionDraft}
                onChange={(e) => setDescriptionDraft(e.target.value)}
                className="w-full px-3 py-2 border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                disabled={working}
              />
            </div>
          </section>

          <section>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
              SKILL.md body (with or without frontmatter)
            </label>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                hasVersions
                  ? 'Edit freely. Save creates a new version.'
                  : '---\nname: my-skill\ndescription: ...\n---\n\n# Instructions\n...'
              }
              rows={24}
              className="w-full p-3 bg-background border border-border font-mono text-xs focus:outline-none focus:ring-1 focus:ring-accent"
              disabled={working}
            />
            {hasVersions && hasChanges && (
              <div className="mt-2">
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional note about this version..."
                  className="w-full text-xs bg-background border border-border px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            )}
            {error && <p className="text-xs text-danger mt-2">{error}</p>}
          </section>

          {hasVersions && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <History className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold text-foreground">Version history</h3>
                <span className="text-xs text-muted-foreground">
                  ({versions.length} version{versions.length === 1 ? '' : 's'})
                </span>
              </div>
              <ul className="space-y-1">
                {versions.map((v, i) => {
                  const prev = versions[i + 1]
                  const isActive = v.id === activeVersion?.id
                  return (
                    <li
                      key={v.id}
                      className={`flex items-center gap-3 px-3 py-2 text-xs border border-border ${
                        isActive ? 'bg-accent/5 border-accent' : 'bg-muted/10'
                      }`}
                    >
                      <span className="font-mono text-foreground">v{v.version}</span>
                      {isActive && (
                        <span className="font-mono text-[10px] uppercase px-1.5 py-0.5 bg-accent/20 text-accent">
                          active
                        </span>
                      )}
                      <span className="font-mono text-[10px] text-muted-foreground uppercase">
                        {v.created_from}
                      </span>
                      <span className="text-muted-foreground truncate flex-1">
                        {v.notes || '—'}
                      </span>
                      <span className="text-muted-foreground flex-shrink-0">
                        {whenLabel(v.created_at)}
                      </span>
                      <div className="flex gap-1 flex-shrink-0">
                        {prev && (
                          <button
                            onClick={() =>
                              setDiffVs({
                                title: `v${prev.version} → v${v.version}`,
                                subtitle: v.notes || undefined,
                                oldLabel: `v${prev.version}`,
                                newLabel: `v${v.version}`,
                                oldText: prev.body,
                                newText: v.body,
                              })
                            }
                            className="p-1 text-muted-foreground hover:text-foreground"
                            title={`Diff vs v${prev.version}`}
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {!isActive && (
                          <button
                            onClick={() => handleRestore(v)}
                            className="p-1 text-muted-foreground hover:text-foreground"
                            title="Restore as active"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {!hasVersions && onStartFromScratch && (
            <div className="pt-6 border-t border-border flex items-center justify-center">
              <button
                type="button"
                onClick={handleStartFromScratch}
                disabled={working}
                className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline disabled:opacity-50"
              >
                Start from scratch →
              </button>
            </div>
          )}
        </div>
      </div>

      {diffVs && (
        <DiffModal
          title={diffVs.title}
          subtitle={diffVs.subtitle}
          oldLabel={diffVs.oldLabel}
          newLabel={diffVs.newLabel}
          oldText={diffVs.oldText}
          newText={diffVs.newText}
          onClose={() => setDiffVs(null)}
        />
      )}
    </div>
  )
}
