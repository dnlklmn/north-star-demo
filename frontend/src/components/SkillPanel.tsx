import { useCallback, useEffect, useState } from 'react'
import { Eye, FileText, Github, History, Loader2, RotateCcw } from 'lucide-react'
import type { SkillVersion } from '../types'
import {
  createSkillVersion,
  discardSkillVersion,
  fetchSkillFromUrl,
  listSkillVersions,
  promoteSkillVersion,
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
  /** When the parent session has kind='prompt' the body describes a North Star
   *  internal prompt (e.g. build_generate_draft_prompt), not a user-authored
   *  skill. Editing changes the seed/charter signal but does NOT change what
   *  runs at eval time — the eval runner replays the prompt builder by
   *  prompt_target. The panel surfaces this with a banner so the user
   *  doesn't think they're editing the prompt under test. */
  isPromptEval?: boolean
  /** Repo-relative "path:line" of the prompt builder under test, e.g.
   *  "backend/app/prompt.py:337". Shown in the prompt-eval banner so the
   *  user can find the source instantly. */
  promptSourcePath?: string | null
  /** Internal name of the prompt builder, e.g. "build_generate_draft_prompt". */
  promptBuilderName?: string | null
  onSkillBodyChange: (body: string) => void
  /** Pointer to the active version (gets the "active" badge in history). */
  activeVersionId?: string | null
  /** Pointer to the candidate version (suggestion-derived, awaiting promote
   *  or discard). When set, history shows a "candidate" badge + inline
   *  Promote/Discard buttons on the matching row. */
  candidateVersionId?: string | null
  /** Called after Promote/Discard so the parent can refresh session state. */
  onCandidateChanged?: () => Promise<void> | void
  /** Called after a successful skill-seed (first Analyze). Parent refreshes
   *  session state to pick up extracted goals/users/stories and unlocks
   *  downstream tabs. */
  onSeeded?: () => void
  /** Called when the user clicks "Start from scratch" — parent has already
   *  flipped the session to standard mode via api. */
  onStartFromScratch?: () => void
  /** Called when the user clicks "Go to business goals" or presses Cmd+Enter. */
  onNext?: () => void
  /** Read-only when false: Analyze / Save / Promote / Discard / Start-from-
   *  scratch all hide. Body textarea becomes read-only. Defaults to true. */
  canEdit?: boolean
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
  isPromptEval = false,
  promptSourcePath,
  promptBuilderName,
  onSkillBodyChange,
  activeVersionId,
  candidateVersionId,
  onCandidateChanged,
  onSeeded,
  onStartFromScratch,
  onNext,
  canEdit = true,
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

  // Sync drafts with external changes (e.g. EvaluatePanel just saved a new
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

  const refreshVersions = useCallback(async () => {
    try {
      const v = await listSkillVersions(sessionId)
      setVersions(v)
    } catch {
      // non-fatal
    }
  }, [sessionId])

  useEffect(() => {
    refreshVersions()
  }, [refreshVersions])

  const activeVersion = versions[0]
  const hasVersions = versions.length > 0
  const hasChanges = draft !== skillBody
  const canAnalyze = !hasVersions && draft.trim().length > 0
  const canSave = hasVersions && hasChanges

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

  const handleAnalyze = useCallback(async () => {
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
  }, [canAnalyze, draft, nameDraft, descriptionDraft, sessionId, onSkillBodyChange, onSeeded, refreshVersions])

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

  const handleSave = useCallback(async () => {
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
  }, [canSave, draft, notes, sessionId, onSkillBodyChange])

  // Cmd+Enter → next phase (Analyze / Save / Go to business goals).
  // Declared after the handlers so they're in scope as effect deps.
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
  }, [canAnalyze, canSave, working, onNext, handleAnalyze, handleSave]);

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
      {!isPromptEval && (
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
              className="w-full px-3 py-2 border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
              disabled={working || !canEdit}
              readOnly={!canEdit}
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
              className="w-full px-3 py-2 border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
              disabled={working || !canEdit}
              readOnly={!canEdit}
            />
          </div>
        </section>
      )}

      <section>
        <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
          {isPromptEval ? "Prompt template" : "SKILL.md body (with or without frontmatter)"}
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
          disabled={working || !canEdit}
          readOnly={!canEdit}
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
  // Viewers see no footer (no write actions); Cmd+Enter Next is also disabled
  // upstream because the navigation buttons drive panel switches.
  const footer = !canEdit ? null : canAnalyze ? (
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
  // (c) the GitHub tab AFTER a successful fetch, (d) viewers (canEdit=false)
  // before any version exists — the source-mode tabs are hidden for them so
  // they'd see an empty panel otherwise.
  const showFields =
    hasVersions ||
    sourceMode === 'manual' ||
    (sourceMode === 'github' && !!githubSource) ||
    !canEdit

  return (
    <PanelLayout
      title={isPromptEval ? "Prompt" : "Skill"}
      subtitle={
        isPromptEval
          ? "The actual prompt being evaluated, rendered with placeholders for the variable parts."
          : hasVersions
            ? activeVersion
              ? `Active v${activeVersion.version}. Edit to create a new version.`
              : undefined
            : 'Paste a SKILL.md or a GitHub link, then click Analyze.'
      }
      footer={footer}
    >
      <div className="max-w-3xl space-y-6">
        {isPromptEval && (promptSourcePath || promptBuilderName) && (
          <div className="text-xs text-muted-foreground bg-fill-neutral/30 border border-border p-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-baseline">
            {promptBuilderName && (
              <>
                <span className="text-foreground/80 font-medium">Builder</span>
                <code className="font-mono break-all">{promptBuilderName}</code>
              </>
            )}
            {promptSourcePath && (
              <>
                <span className="text-foreground/80 font-medium">Source</span>
                <code className="font-mono break-all">{promptSourcePath}</code>
              </>
            )}
            <span className="text-foreground/80 font-medium">To re-run</span>
            <span>
              Edit the file in your North Star checkout, restart the backend,
              then click <em>Run evaluation</em> on the Evaluations tab. The
              eval task replays this prompt against every approved row.
            </span>
          </div>
        )}
        {/* Source tabs only before the first analyze. Hidden for viewers —
            they have no write actions, so seeding from GitHub or pasting a
            new SKILL.md isn't actionable. */}
        {!isPromptEval && !hasVersions && canEdit && (
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
                const isCandidate = candidateVersionId === v.id
                // Prefer the explicit `activeVersionId` prop when provided
                // (lets the parent express "active" independently of the
                // newest version, which matters once candidates exist —
                // the candidate is newest but NOT active). Fallback to
                // "newest" for legacy sessions whose state predates the
                // pointer, but exclude the candidate from that fallback
                // so it never gets the active badge by accident.
                const isActive = activeVersionId
                  ? v.id === activeVersionId
                  : !isCandidate && v.id === activeVersion?.id
                const handlePromote = async () => {
                  try {
                    await promoteSkillVersion(sessionId, v.id)
                    const refreshed = await listSkillVersions(sessionId)
                    setVersions(refreshed)
                    onSkillBodyChange(v.body)
                    await onCandidateChanged?.()
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to promote candidate')
                  }
                }
                const handleDiscard = async () => {
                  try {
                    await discardSkillVersion(sessionId, v.id)
                    const refreshed = await listSkillVersions(sessionId)
                    setVersions(refreshed)
                    // Body reverts to the active version's body server-side.
                    const active = refreshed.find((x) => x.id === activeVersionId)
                    if (active) onSkillBodyChange(active.body)
                    await onCandidateChanged?.()
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to discard candidate')
                  }
                }
                return (
                  <li
                    key={v.id}
                    className={`flex items-center gap-3 px-3 py-2 text-xs border ${
                      isCandidate
                        ? 'bg-warning/5 border-warning'
                        : isActive
                          ? 'bg-accent/5 border-accent'
                          : 'bg-muted/10 border-border'
                    }`}
                  >
                    <span className="font-mono text-foreground">v{v.version}</span>
                    {isActive && (
                      <span className="font-mono text-[10px] uppercase px-1.5 py-0.5 bg-accent/20 text-accent">
                        active
                      </span>
                    )}
                    {isCandidate && (
                      <span
                        className="font-mono text-[10px] uppercase px-1.5 py-0.5 bg-warning/15 text-warning"
                        title="Candidate version awaiting promote/discard. Run an eval against this body, then commit or revert."
                      >
                        candidate
                      </span>
                    )}
                    <span
                      className={`font-mono text-[10px] uppercase px-1.5 py-0.5 ${
                        v.created_from === 'restore'
                          ? 'bg-warning/15 text-warning'
                          : v.created_from === 'suggestion'
                            ? 'bg-accent/15 text-accent'
                            : v.created_from === 'seed'
                              ? 'bg-success/15 text-success'
                              : 'bg-muted/30 text-muted-foreground'
                      }`}
                      title={
                        v.created_from === 'restore'
                          ? 'Created by restoring an earlier version'
                          : v.created_from === 'suggestion'
                            ? 'Created by accepting an improvement suggestion'
                            : v.created_from === 'seed'
                              ? 'The original SKILL.md the project started from'
                              : 'Manually edited'
                      }
                    >
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
                      {isCandidate && canEdit && (
                        <>
                          <button
                            onClick={handleDiscard}
                            className="px-2 py-0.5 text-[10px] font-medium border border-border bg-surface hover:bg-muted/30"
                            title="Discard candidate — revert SKILL.md to the active version. The candidate stays in history."
                          >
                            Discard
                          </button>
                          <button
                            onClick={handlePromote}
                            className="px-2 py-0.5 text-[10px] font-medium bg-accent text-accent-foreground hover:opacity-90"
                            title="Promote this candidate to the active version."
                          >
                            Promote
                          </button>
                        </>
                      )}
                      {!isActive && !isCandidate && canEdit && (
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

        {!hasVersions && onStartFromScratch && canEdit && (
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
