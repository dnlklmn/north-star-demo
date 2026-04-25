import { useEffect, useState } from 'react'
import { Eye, FileText, Github, History, Loader2, RotateCcw } from 'lucide-react'
import type { SkillVersion } from '../types'
import {
  createSkillVersion,
  fetchSkillFromUrl,
  listSkillVersions,
  restoreSkillVersion,
  seedFromSkill,
  setSessionMode,
} from '../api'
import DiffModal from './DiffModal'
import PanelLayout from './PanelLayout'
import Button from './ui/Button'
import { CmdReturnIcon } from './ui/Icons'
import { parseSkillFrontmatter } from '../utils/skillFrontmatter'

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
  /** Called when the user clicks "Go to business goals" or presses Cmd+Enter. */
  onNext?: () => void
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
  onNext,
}: Props) {
  const [draft, setDraft] = useState(skillBody)
  const [nameDraft, setNameDraft] = useState(skillName ?? '')
  const [descriptionDraft, setDescriptionDraft] = useState(skillDescription ?? '')
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [notes, setNotes] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Source-mode tabs — only shown before first Analyze. After there's a
  // persisted version, the manual textarea is the only sensible view.
  const [sourceMode, setSourceMode] = useState<'github' | 'manual'>('manual')
  const [githubUrl, setGithubUrl] = useState('')
  const [githubSource, setGithubSource] = useState<{ owner: string; repo: string; ref: string; path: string } | null>(null)
  const [fetching, setFetching] = useState(false)
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

  // Cmd+Enter → next phase (Analyze / Save / Go to business goals)
  useEffect(() => {
    if (!onNext) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (canAnalyze && !working) {
          handleAnalyze();
        } else if (canSave && !working) {
          handleSave();
        } else {
          onNext();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canAnalyze, canSave, working, onNext]);

  const handleFetchFromGithub = async () => {
    const url = githubUrl.trim()
    if (!url || fetching) return
    setFetching(true)
    setError(null)
    try {
      const result = await fetchSkillFromUrl(url)
      // Populate the fields in-place on the GitHub tab — the user can review
      // and tweak them without switching to "Enter manually".
      setDraft(result.body)
      if (result.name) setNameDraft(result.name)
      if (result.description) setDescriptionDraft(result.description)
      setGithubSource(result.source)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch SKILL.md from URL')
    } finally {
      setFetching(false)
    }
  }

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

  const handleRerunAnalysis = async () => {
    setWorking(true)
    setError(null)
    try {
      const parsed = parseSkillFrontmatter(draft)
      const finalName = nameDraft.trim() || parsed.name
      const finalDescription = descriptionDraft.trim() || parsed.description
      const finalBody = parsed.body
      await seedFromSkill(sessionId, {
        skill_body: finalBody,
        skill_name: finalName || undefined,
        skill_description: finalDescription || undefined,
      })
      onSkillBodyChange(finalBody)
      await refreshVersions()
      onSeeded?.()
    } catch (err) {
      console.error('Rerun failed', err)
      setError(err instanceof Error ? err.message : 'Failed to re-run analysis')
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

  // Fields block — name, description, body. Shared between the Manual tab
  // and the post-fetch state of the GitHub tab, and always visible once a
  // version is persisted.
  const fieldsBlock = (
    <>
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
    </>
  )

  // Floating footer — matches the pattern on Goals / Stories / Charter.
  // Analyze before first seed, Save as v{n} after edits. "Go to business
  // goals" shows after seeding so the user can jump to the next phase.
  const footer = canAnalyze ? (
    <Button
      size="big"
      variant="primary"
      onClick={handleAnalyze}
      disabled={working}
    >
      {working ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
      Analyze
    </Button>
  ) : canSave ? (
    <div className="flex items-center gap-2">
      <Button
        size="small"
        variant="neutral"
        onClick={() =>
          setDiffVs({
            title: `Preview v${nextVersion}`,
            oldLabel: `v${activeVersion?.version ?? 0}`,
            newLabel: `v${nextVersion} (draft)`,
            oldText: skillBody,
            newText: draft,
          })
        }
      >
        <Eye className="w-3.5 h-3.5" />
        Preview diff
      </Button>
      <Button
        size="big"
        variant="primary"
        onClick={handleSave}
        disabled={working}
      >
        {working ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        Save as v{nextVersion}
      </Button>
    </div>
  ) : onNext ? (
    <div className="flex items-center gap-2">
      <Button
        size="big"
        variant="neutral"
        onClick={handleRerunAnalysis}
        disabled={working}
        shortcut={<CmdReturnIcon />}
      >
        {working ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        Rerun analysis
      </Button>
      <Button
        size="big"
        variant="primary"
        onClick={onNext}
        shortcut={<CmdReturnIcon />}
      >
        Go to Business Goals
      </Button>
    </div>
  ) : undefined

  // Show the fields in: (a) existing-version edits, (b) the Manual tab,
  // (c) the GitHub tab AFTER a successful fetch. This keeps the GitHub tab
  // minimal until the URL has been resolved.
  const showFields = hasVersions || sourceMode === 'manual' || (sourceMode === 'github' && !!githubSource)

  return (
    <PanelLayout
      title="Skill"
      subtitle={
        hasVersions
          ? activeVersion
            ? `Active v${activeVersion.version}. Edit to create a new version.`
            : undefined
          : 'Paste a SKILL.md or a GitHub link, then click Analyze.'
      }
      footer={footer}
    >
      <div className="max-w-3xl space-y-6">
        {/* Source tabs only before the first analyze. */}
        {!hasVersions && (
          <section>
            <div className="flex items-stretch border-b border-border mb-3">
              <button
                onClick={() => setSourceMode('github')}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                  sourceMode === 'github'
                    ? 'text-foreground border-b-2 border-accent -mb-px'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Github className="w-3.5 h-3.5" />
                From GitHub
              </button>
              <button
                onClick={() => setSourceMode('manual')}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                  sourceMode === 'manual'
                    ? 'text-foreground border-b-2 border-accent -mb-px'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                Enter manually
              </button>
            </div>

            {sourceMode === 'github' && (
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  GitHub URL
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={githubUrl}
                    onChange={(e) => setGithubUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); handleFetchFromGithub() }
                    }}
                    placeholder="https://github.com/owner/repo/blob/main/skills/foo/SKILL.md"
                    disabled={fetching}
                    className="flex-1 px-3 py-2 border border-border bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                  <button
                    onClick={handleFetchFromGithub}
                    disabled={fetching || !githubUrl.trim()}
                    className="inline-flex items-center gap-1.5 text-xs px-3 py-2 font-medium bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {fetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Github className="w-3.5 h-3.5" />}
                    Fetch
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Paste a link to a SKILL.md file on GitHub. Public repos work without a token;
                  add one in Settings to raise the rate limit or access private repos.
                </p>
                {githubSource && (
                  <p className="text-[10px] text-success">
                    Fetched from {githubSource.owner}/{githubSource.repo}@{githubSource.ref} — {githubSource.path}
                  </p>
                )}
                {error && <p className="text-xs text-danger">{error}</p>}
              </div>
            )}
          </section>
        )}

        {showFields && fieldsBlock}

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
    </PanelLayout>
  )
}
