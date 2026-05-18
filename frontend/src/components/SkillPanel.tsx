import { useCallback, useEffect, useState } from 'react'
import { Eye, FileText, History, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import type { SkillReferenceSummary, SkillVersion } from '../types'
import {
  createSkillVersion,
  discardSkillVersion,
  fetchSkillFromUrl,
  listSkillReferences,
  listSkillVersions,
  promoteSkillVersion,
  regenerateSkillReference,
  restoreSkillVersion,
  seedFromSkill,
  setSessionMode,
  type SkillSuggestion,
} from '../api'
import DiffModal from './DiffModal'
import PanelLayout from './PanelLayout'
import SuggestionBox, { SuggestionCard } from './SuggestionBox'
import Button from './ui/Button'
import { CmdReturnIcon } from './ui/Icons'
import { parseSkillFrontmatter } from '../utils/skillFrontmatter'

interface Props {
  sessionId: string
  skillBody: string
  /** Currently unused in the trimmed UI — frontmatter parsing reads name +
   *  description directly from the textarea body on Analyze. Kept on the
   *  interface so the parent can still pass them without rewriting. */
  skillName?: string | null
  skillDescription?: string | null
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
  /** Called when the user clicks the post-seed primary CTA or presses Cmd+Enter. */
  onNext?: () => void
  /** Read-only when false: Analyze / Save / Promote / Discard / Start-from-
   *  scratch all hide. Body textarea becomes read-only. Defaults to true. */
  canEdit?: boolean
  /** Whether at least one non-empty business goal exists upstream. Drives the
   *  Suggestions panel empty state on the right rail. */
  hasGoals?: boolean
  /** Skill-content suggestions to render in the right rail. Each carries
   *  a short summary plus an optional location hint (where in SKILL.md it
   *  belongs) that renders as a small badge on the card. */
  skillSuggestions?: SkillSuggestion[]
  skillSuggestionsLoading?: boolean
  /** Refresh handler for the right-rail Suggestions panel. */
  onRefreshSkillSuggestions?: () => void
  /** Accept handler — appends the suggestion to the draft body. */
  onAcceptSkillSuggestion?: (suggestion: SkillSuggestion) => void
  /** Dismiss handler — drops the suggestion from the local list. */
  onDismissSkillSuggestion?: (suggestion: SkillSuggestion) => void
  /** "Generate from goals" / "Regenerate from goals" handler — fires the
   *  backend pass that produces a full SKILL.md draft from the session's
   *  goals and stories. Shown as a header-row button when provided.
   *  When omitted (e.g. parent has a fresh generation matching current
   *  goals), the button is hidden entirely. */
  onGenerateFromGoals?: () => void | Promise<void>
  /** Drives the disabled state on the title-row generate button. */
  generatingFromGoals?: boolean
  /** When true, label reads "Regenerate from goals" instead of "Generate
   *  from goals". Set by the parent when an earlier generation exists but
   *  the upstream goals/stories have changed since. */
  regenerateFromGoals?: boolean
  /** When false, the right-rail Suggestions box swaps its empty-state
   *  refresh icon for an explicit "Get suggestions" button so the user
   *  has a clear affordance to fetch on demand. */
  autoGenerateSuggestions?: boolean
  /** Whether the project already has a charter. Drives the primary CTA
   *  label between "Generate charter" and "Regenerate charter". */
  hasCharter?: boolean
  /** Fired the moment the user clicks the "Generate / Regenerate charter"
   *  button, before any backend work starts. The parent uses this to
   *  navigate to the Charter tab immediately so the spinner shows there
   *  while the seed + submit-intake passes run, instead of leaving the
   *  user staring at the Skill page for ~10s. */
  onBeforeAnalyze?: () => void
  /** Counterpart to `onBeforeAnalyze` — fires if the analyze call throws
   *  (e.g. a GitHub URL fetch fails or the seed pass errors out). The
   *  parent uses this to unflip whatever loading flag `onBeforeAnalyze`
   *  set, otherwise the user is stranded with a permanent "Generating
   *  charter…" overlay on the Charter tab. */
  onAnalyzeError?: () => void
  /** Seed for the version history list. The parent already has the full
   *  history in `state.skill_versions` (it ships with the session payload)
   *  so passing it down lets the panel paint synchronously instead of
   *  blocking on a separate `/skill-versions` fetch on every mount.
   *  When provided, the on-mount network refresh is skipped — mutations
   *  still refresh in-place. */
  initialVersions?: SkillVersion[]
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
  isPromptEval = false,
  promptSourcePath,
  promptBuilderName,
  onSkillBodyChange,
  activeVersionId,
  candidateVersionId,
  onCandidateChanged,
  onSeeded,
  onNext,
  canEdit = true,
  hasGoals = false,
  skillSuggestions = [],
  skillSuggestionsLoading = false,
  onRefreshSkillSuggestions,
  onAcceptSkillSuggestion,
  onDismissSkillSuggestion,
  onGenerateFromGoals,
  generatingFromGoals = false,
  regenerateFromGoals = false,
  autoGenerateSuggestions = true,
  hasCharter = false,
  onBeforeAnalyze,
  onAnalyzeError,
  initialVersions,
}: Props) {
  const [draft, setDraft] = useState(skillBody)
  // Seed history from the parent so the list renders synchronously — without
  // this we used to block on a /skill-versions fetch on every mount, which
  // showed a noticeable empty flash on every Skill-tab visit.
  const [versions, setVersions] = useState<SkillVersion[]>(
    () => initialVersions ?? [],
  )
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
  const [references, setReferences] = useState<SkillReferenceSummary[]>([])
  const [refreshRefsOnPromote, setRefreshRefsOnPromote] = useState(true)
  const [refViewing, setRefViewing] = useState<SkillReferenceSummary | null>(null)
  const [refBusy, setRefBusy] = useState<string | null>(null)

  // Sync draft with external changes (e.g. EvaluatePanel just saved a new
  // version, or Home just created a fresh blank session).
  useEffect(() => {
    setDraft(skillBody)
  }, [skillBody])

  const refreshVersions = useCallback(async () => {
    try {
      const v = await listSkillVersions(sessionId)
      setVersions(v)
    } catch {
      // non-fatal
    }
  }, [sessionId])

  const refreshReferences = useCallback(async () => {
    try {
      const refs = await listSkillReferences(sessionId)
      setReferences(refs)
    } catch {
      // Non-fatal: References section just renders empty + retry-on-next-mount.
      // A broken refs fetch shouldn't block the rest of the Skill panel.
    }
  }, [sessionId])

  // Load once on mount; refreshes happen after promote / regenerate. Tied
  // to sessionId so switching projects refetches.
  useEffect(() => {
    void refreshReferences()
  }, [refreshReferences])

  // Keep local state in sync with the parent — the session-state SSE feed
  // overwrites `state.skill_versions` after every mutation, so we mirror it
  // here. The catch is that `handleSave` does an optimistic local prepend
  // (a v+1 row) BEFORE the SSE round-trip lands, so a parent re-render that
  // happens for unrelated reasons in that window would otherwise clobber
  // the optimistic row back to the stale list. We only mirror when the seed
  // is at least as fresh as what we already have — if the local list has
  // strictly more rows or a higher top version, the seed is mid-flight and
  // we hold off until SSE catches up. No on-mount network fetch: the seed
  // already painted synchronously.
  useEffect(() => {
    if (!initialVersions) {
      void refreshVersions()
      return
    }
    setVersions((prev) => {
      if (prev.length > initialVersions.length) return prev
      const prevTop = prev[0]?.version ?? 0
      const seedTop = initialVersions[0]?.version ?? 0
      if (prevTop > seedTop) return prev
      return initialVersions
    })
  }, [initialVersions, refreshVersions])

  const activeVersion = versions[0]
  const hasVersions = versions.length > 0
  const hasChanges = draft !== skillBody
  const canAnalyze = !hasVersions && draft.trim().length > 0
  const canSave = hasVersions && hasChanges

  // Resolve the textarea contents into a SKILL.md body + name + description.
  // Handles three input shapes transparently:
  //   - GitHub URL → fetch + parse frontmatter
  //   - SKILL.md with frontmatter → strip + extract name/description
  //   - Free-form markdown → use as-is, name/description left empty
  const resolveDraft = async (): Promise<{
    body: string
    name?: string
    description?: string
  }> => {
    const trimmed = draft.trim()
    const isGithubUrl =
      trimmed.startsWith('http') &&
      (trimmed.includes('github.com') ||
        trimmed.includes('raw.githubusercontent.com'))
    if (isGithubUrl) {
      const fetched = await fetchSkillFromUrl(trimmed)
      return {
        body: fetched.body,
        name: fetched.name ?? undefined,
        description: fetched.description ?? undefined,
      }
    }
    const parsed = parseSkillFrontmatter(draft)
    return {
      body: parsed.body,
      name: parsed.name,
      description: parsed.description,
    }
  }

  const handleAnalyze = useCallback(async () => {
    if (!canAnalyze) return
    // Tell the parent we're starting *before* any await so it can navigate
    // to Charter and flip the loading state. The user sees the spinner
    // there immediately instead of waiting on the Skill page.
    onBeforeAnalyze?.()
    setWorking(true)
    setError(null)
    try {
      const { body, name, description } = await resolveDraft()
      await setSessionMode(sessionId, 'triggered')
      await seedFromSkill(sessionId, {
        skill_body: body,
        skill_name: name,
        skill_description: description,
      })
      onSkillBodyChange(body)
      // If the input was a GitHub URL, replace the textarea contents with the
      // fetched body so version history shows the actual SKILL.md and not the
      // URL the user pasted.
      if (body !== draft) setDraft(body)
      await refreshVersions()
      onSeeded?.()
    } catch (err) {
      console.error('Seed failed', err)
      setError(err instanceof Error ? err.message : 'Failed to analyze SKILL.md')
      // Notify parent so it can unflip whatever loading flag onBeforeAnalyze
      // set — without this, a failed analyze leaves the Charter tab stuck on
      // the "Generating charter…" overlay forever.
      onAnalyzeError?.()
    } finally {
      setWorking(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAnalyze, draft, sessionId, onSkillBodyChange, onSeeded, refreshVersions, onBeforeAnalyze, onAnalyzeError])

  const handleRerunAnalysis = async () => {
    setWorking(true)
    setError(null)
    try {
      const { body, name, description } = await resolveDraft()
      await seedFromSkill(sessionId, {
        skill_body: body,
        skill_name: name,
        skill_description: description,
      })
      onSkillBodyChange(body)
      if (body !== draft) setDraft(body)
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

  // Cmd+Enter → next action (Analyze / Save / Generate charter).
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

  // Fields block — single textarea. Name + description auto-detect from
  // frontmatter on Analyze; we don't ask for them up-front. No label —
  // the panel header already says "Skill" / "Prompt". While a "Generate
  // from goals" pass is in flight we overlay a centered spinner inside
  // the textarea so the user sees something is happening.
  const fieldsBlock = (
    <>
      <section>
        <div className="relative">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              hasVersions
                ? 'Edit freely. Save creates a new version.'
                : 'Paste GitHub link or start typing'
            }
            rows={24}
            className="w-full p-3 bg-background border border-border font-mono text-xs focus:outline-none focus:ring-1 focus:ring-accent focus:ring-inset"
            disabled={working || generatingFromGoals || !canEdit}
            readOnly={!canEdit}
          />
          {generatingFromGoals && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[1px]">
              <Loader2 className="w-6 h-6 text-fg-dim animate-spin" />
            </div>
          )}
        </div>
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
  // Primary CTA before first seed is the charter-generator (relabelled
  // from the old "Analyze" — same handler, but the user-facing name now
  // reflects the next phase). Save as v{n} shows when edits land on top
  // of an existing version. After seeding (no canAnalyze, no canSave)
  // the same charter CTA stays so the user can move to the charter step.
  // Viewers see no footer (no write actions); Cmd+Enter Next is also
  // disabled upstream because the navigation buttons drive panel switches.
  const charterCtaLabel = hasCharter
    ? "Regenerate charter"
    : "Generate charter"
  const footer = !canEdit ? null : canAnalyze ? (
    <Button
      size="big"
      variant="primary"
      onClick={handleAnalyze}
      disabled={working}
    >
      {working ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
      {charterCtaLabel}
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
      {hasVersions && (
        <Button
          size="big"
          variant="neutral"
          onClick={handleRerunAnalysis}
          disabled={working}
        >
          {working ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Regenerate goals and user stories
        </Button>
      )}
      <Button
        size="big"
        variant="primary"
        onClick={onNext}
        shortcut={<CmdReturnIcon />}
      >
        {charterCtaLabel}
      </Button>
    </div>
  ) : undefined

  // Single textarea is always shown — there's no longer a tab bar to gate it
  // behind. Kept as a const for consistency with the JSX below.
  const showFields = true

  // Header-row CTA: fire a backend pass that drafts a SKILL.md from the
  // session's goals + stories. Hidden for prompt-eval, viewer mode, no
  // goals, in-flight generation (the textarea overlay shows the spinner
  // instead), or when the parent has flagged the current draft as a fresh
  // generation matching the upstream signature (onGenerateFromGoals
  // omitted in that case). Label flips on regenerateFromGoals.
  const titleAction =
    canEdit &&
    !isPromptEval &&
    onGenerateFromGoals &&
    hasGoals &&
    !generatingFromGoals ? (
      <Button
        size="small"
        variant="neutral"
        onClick={onGenerateFromGoals}
        disabled={working}
      >
        {regenerateFromGoals ? "Regenerate from goals" : "Generate from goals"}
      </Button>
    ) : undefined

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
      titleAction={titleAction}
      footer={footer}
      right={
        canEdit && !isPromptEval ? (
          <SuggestionBox
            onRefresh={hasGoals ? onRefreshSkillSuggestions : undefined}
            loading={skillSuggestionsLoading}
            emptyText={
              hasGoals
                ? autoGenerateSuggestions
                  ? "Press refresh to generate suggestions."
                  : "Auto-generate is off — click below to fetch suggestions."
                : "Add goals to see suggestions."
            }
            showGetButton={hasGoals && !autoGenerateSuggestions}
            getButtonLabel="Get skill suggestions"
          >
            {skillSuggestions.length > 0
              ? skillSuggestions.map((suggestion, i) => (
                  <SuggestionCard
                    key={i}
                    onAccept={() =>
                      onAcceptSkillSuggestion?.(suggestion)
                    }
                    onDismiss={() =>
                      onDismissSkillSuggestion?.(suggestion)
                    }
                  >
                    <div className="flex flex-col gap-2">
                      {suggestion.where && (
                        <span className="self-start bg-fill-primary/10 text-fg-primary text-[11px] font-mono uppercase tracking-wide px-1.5 py-0.5">
                          {suggestion.where}
                        </span>
                      )}
                      <span>{suggestion.summary}</span>
                    </div>
                  </SuggestionCard>
                ))
              : null}
          </SuggestionBox>
        ) : undefined
      }
    >
      <div className="space-y-6">
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
                    await promoteSkillVersion(sessionId, v.id, {
                      refreshReferences: refreshRefsOnPromote,
                    })
                    const refreshed = await listSkillVersions(sessionId)
                    setVersions(refreshed)
                    onSkillBodyChange(v.body)
                    await onCandidateChanged?.()
                    // Pull the latest reference set so staleness banners and
                    // file bodies reflect what just got generated (or not,
                    // if the toggle was off).
                    void refreshReferences()
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
                          <label
                            className="flex items-center gap-1 text-[10px] text-muted-foreground select-none cursor-pointer"
                            title="Regenerate examples.md, off-target.md, and criteria.md against the newly active skill version. Skipped per file when source data hasn't moved."
                          >
                            <input
                              type="checkbox"
                              className="w-3 h-3"
                              checked={refreshRefsOnPromote}
                              onChange={(e) => setRefreshRefsOnPromote(e.target.checked)}
                            />
                            refresh refs
                          </label>
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

        {references.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3 mt-6">
              <FileText className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">Reference files</h3>
              <span
                className="text-xs text-muted-foreground"
                title="Bundled markdown files Claude reads on demand. Regenerated when you promote a candidate (or on the per-file button below)."
              >
                ({references.length} file{references.length === 1 ? '' : 's'})
              </span>
            </div>
            <ul className="space-y-1">
              {references.map((r) => {
                const versionLabel = r.generated_at_skill_version_number
                  ? `built from v${r.generated_at_skill_version_number}`
                  : 'not yet generated'
                const staleHint =
                  r.stale_reason === 'inputs'
                    ? 'Source data (dataset / stories / charter) has changed since this file was generated.'
                    : r.stale_reason === 'missing'
                      ? 'This file hasn’t been generated yet. Click regenerate to build it.'
                      : 'In sync with the current source data.'
                const isBusy = refBusy === r.kind
                const handleRegen = async () => {
                  setRefBusy(r.kind)
                  try {
                    await regenerateSkillReference(sessionId, r.kind)
                    await refreshReferences()
                  } catch (err) {
                    setError(
                      err instanceof Error
                        ? err.message
                        : `Failed to regenerate ${r.filename}`,
                    )
                  } finally {
                    setRefBusy(null)
                  }
                }
                return (
                  <li
                    key={r.kind}
                    className={`flex items-center gap-3 px-3 py-2 text-xs border ${
                      r.is_stale
                        ? 'bg-warning/5 border-warning'
                        : 'bg-muted/10 border-border'
                    }`}
                  >
                    <span className="font-mono text-foreground">{r.filename}</span>
                    {r.is_stale ? (
                      <span
                        className="font-mono text-[10px] uppercase px-1.5 py-0.5 bg-warning/15 text-warning"
                        title={staleHint}
                      >
                        stale ({r.stale_reason})
                      </span>
                    ) : (
                      <span
                        className="font-mono text-[10px] uppercase px-1.5 py-0.5 bg-success/15 text-success"
                        title={staleHint}
                      >
                        in sync
                      </span>
                    )}
                    <span className="text-muted-foreground truncate flex-1">
                      {versionLabel}
                    </span>
                    <div className="flex gap-1 flex-shrink-0">
                      {r.body && (
                        <button
                          onClick={() => setRefViewing(r)}
                          className="p-1 text-muted-foreground hover:text-foreground"
                          title="View file body"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {canEdit && (
                        <button
                          onClick={handleRegen}
                          disabled={isBusy}
                          className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
                          title={
                            r.stale_reason === 'missing'
                              ? `Generate ${r.filename}`
                              : `Regenerate ${r.filename} from current state`
                          }
                        >
                          {isBusy ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

      </div>

      {refViewing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6"
          onClick={() => setRefViewing(null)}
        >
          <div
            className="bg-surface border border-border max-w-3xl w-full max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-muted-foreground" />
                <span className="font-mono text-sm text-foreground">{refViewing.filename}</span>
                <span className="text-xs text-muted-foreground">
                  {refViewing.generated_at_skill_version_number
                    ? `from v${refViewing.generated_at_skill_version_number}`
                    : 'not yet generated'}
                </span>
              </div>
              <button
                onClick={() => setRefViewing(null)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs whitespace-pre-wrap font-mono text-foreground">
              {refViewing.body || '(empty)'}
            </pre>
          </div>
        </div>
      )}

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
