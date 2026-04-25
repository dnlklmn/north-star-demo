import { useEffect, useRef, useState } from 'react'
import { RotateCcw, Sparkles } from 'lucide-react'

interface Props {
  /** Name of this artifact — shown verbatim ("business goals", "charter", etc). */
  artifact: string
  /** Active skill version number (latest). */
  activeVersion: number | null
  /** Skill version this artifact was generated against. Null = no lineage recorded. */
  sourceVersion: number | null
  /** "Update suggestions" — propose incremental edits using the existing
   *  suggestion flow for this tab. Hidden when not provided. */
  onUpdateSuggestions?: () => void
  /** "Regenerate" — full regeneration from the current SKILL.md. Destructive. */
  onRegenerate?: () => void
  /** Override button label for regenerate (e.g. "Re-seed from SKILL.md"). */
  regenerateLabel?: string
  /** Override button label for update suggestions. */
  updateSuggestionsLabel?: string
  /** When true → false (a suggestions fetch just finished), the banner
   *  auto-dismisses. This covers both the banner's own "Update suggestions"
   *  button and the SuggestionBox refresh button in the panel — both paths
   *  flip this flag, so we don't need a separate signal for each. */
  suggestionsLoading?: boolean
  /** Session ID for scoping persistent dismissal. When omitted, dismissal
   *  is in-memory only and resets on remount (i.e. leaving + returning to
   *  the tab). Recommended to pass this. */
  sessionId?: string | null
}

/**
 * Build the localStorage key for a dismissal. Includes the version pair so
 * a fresh stale mismatch (new SKILL.md vs same artifact) generates a new
 * key and shows the banner again.
 */
function dismissalStorageKey(
  sessionId: string | null | undefined,
  artifact: string,
  activeVersion: number | null,
  sourceVersion: number | null,
): string | null {
  if (!sessionId) return null
  return `northstar.banner_dismissed.${sessionId}.${artifact}.${activeVersion}:${sourceVersion}`
}

/**
 * Shows at the top of Goals/Users/Stories/Charter/Dataset/Scorers panels.
 *
 * Two visual states:
 *   - IN SYNC: muted, informational. "Built from SKILL.md v{N}".
 *   - STALE:   warning. Shows version mismatch + two action buttons.
 *
 * Null sourceVersion = artifact has no lineage recorded (pre-versioning
 * session, or just not tracked). Banner hides entirely — no informational
 * noise.
 */
export default function RegenerateBanner({
  artifact,
  activeVersion,
  sourceVersion,
  onUpdateSuggestions,
  onRegenerate,
  regenerateLabel = 'Regenerate',
  updateSuggestionsLabel = 'Update suggestions',
  suggestionsLoading,
  sessionId,
}: Props) {
  const storageKey = dismissalStorageKey(sessionId, artifact, activeVersion, sourceVersion)

  // Dismissal persists in localStorage keyed by session + artifact + version
  // pair. Advancing the version pair generates a fresh key, so a new stale
  // mismatch always shows the banner again even if the prior one was dismissed.
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (!storageKey) return false
    try {
      return localStorage.getItem(storageKey) === '1'
    } catch {
      return false
    }
  })

  // Re-read dismissal state whenever the storage key changes (tab switch,
  // version change, session change).
  useEffect(() => {
    if (!storageKey) {
      setDismissed(false)
      return
    }
    try {
      setDismissed(localStorage.getItem(storageKey) === '1')
    } catch {
      setDismissed(false)
    }
  }, [storageKey])

  const persistDismissal = () => {
    setDismissed(true)
    if (!storageKey) return
    try {
      localStorage.setItem(storageKey, '1')
    } catch {
      // localStorage unavailable (private mode, quota) — in-memory dismissal still works for this mount.
    }
  }

  // Auto-dismiss when a suggestions fetch completes (loading true → false).
  // Covers banner's "Update suggestions" button AND the in-panel refresh.
  const prevLoading = useRef<boolean>(!!suggestionsLoading)
  useEffect(() => {
    if (prevLoading.current && !suggestionsLoading) {
      persistDismissal()
    }
    prevLoading.current = !!suggestionsLoading
  }, [suggestionsLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!activeVersion || !sourceVersion) {
    return null
  }

  const isStale = activeVersion > sourceVersion

  if (!isStale) {
    // In sync — compact muted informational strip.
    return (
      <div className="mt-3 px-3 py-1.5 bg-muted/30 border-l-2 border-muted-foreground/30 text-[11px] text-muted-foreground">
        Built from <span className="font-mono text-foreground">SKILL.md v{sourceVersion}</span>{" "}
        (current)
      </div>
    )
  }

  if (dismissed) {
    return null
  }

  // Stale — warn + offer two paths forward.
  return (
    <div className="mt-3 px-3 py-2 bg-warning/10 border border-warning/30 flex items-center justify-between gap-3 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <RotateCcw className="w-3.5 h-3.5 text-warning flex-shrink-0" />
        <span className="text-foreground truncate">
          These {artifact} were built from{' '}
          <span className="font-mono">SKILL.md v{sourceVersion}</span>. Skill is at{' '}
          <span className="font-mono">v{activeVersion}</span> now.
        </span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {onUpdateSuggestions && (
          <button
            onClick={() => {
              persistDismissal()
              onUpdateSuggestions()
            }}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-foreground hover:bg-warning/20 whitespace-nowrap"
            title="Propose targeted edits based on the new SKILL.md — keeps existing content"
          >
            <Sparkles className="w-3 h-3" />
            {updateSuggestionsLabel}
          </button>
        )}
        {onRegenerate && (
          <button
            onClick={() => {
              persistDismissal()
              onRegenerate()
            }}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-warning/20 text-warning hover:bg-warning/30 whitespace-nowrap"
            title="Full regeneration — replaces current content"
          >
            <RotateCcw className="w-3 h-3" />
            {regenerateLabel}
          </button>
        )}
      </div>
    </div>
  )
}
