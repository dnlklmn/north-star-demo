import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import Button from './ui/Button'
import { AIIcon } from './ui/Icons'
import {
  createPromptEvalSession,
  fetchSkillFromUrl,
  listPromptTargets,
  seedFromSkill,
  setSessionMode,
  type PromptTargetInfo,
} from '../api'
import { parseSkillFrontmatter } from '../utils/skillFrontmatter'

interface Props {
  sessionId: string
  onSeeded: () => void | Promise<void>
  onPromptCreated: (newSessionId: string) => void
}

type Mode = 'collapsed' | 'skill' | 'prompt'

/**
 * Inline banner offered on the Goals page that lets users seed the current
 * session from a SKILL.md or spin up a new prompt-eval session — instead of
 * walking through the discovery conversation. Replicates the contents of
 * NewSkillEvalModal / NewPromptEvalModal but expands inline rather than
 * opening a modal.
 */
export default function AddSourceBanner({
  sessionId,
  onSeeded,
  onPromptCreated,
}: Props) {
  const [mode, setMode] = useState<Mode>('collapsed')

  // Skill state
  const [skillInput, setSkillInput] = useState('')

  // Prompt state
  const [promptTargets, setPromptTargets] = useState<PromptTargetInfo[]>([])
  const [promptTargetId, setPromptTargetId] = useState<string>('')
  const [promptBody, setPromptBody] = useState<string>('')
  const [sampleSize, setSampleSize] = useState<number>(30)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Shared
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Lazy-fetch prompt targets when the user enters prompt mode for the first
  // time. We only fetch once per mount; subsequent toggles reuse the list.
  useEffect(() => {
    if (mode !== 'prompt') return
    if (promptTargets.length > 0) return
    setLoadError(null)
    listPromptTargets()
      .then((list) => {
        setPromptTargets(list)
        const preferred = list.find((t) => t.target === 'skill_seed') ?? list[0]
        if (preferred) {
          setPromptTargetId(preferred.target)
          if (preferred.prompt_text) setPromptBody(preferred.prompt_text)
        }
      })
      .catch((err) =>
        setLoadError(err instanceof Error ? err.message : 'Failed to load'),
      )
  }, [mode, promptTargets.length])

  // When the user picks a different target, reset the body to that target's
  // rendered prompt so they don't accidentally seed prompt A's body into
  // prompt B's eval.
  const currentTarget = promptTargets.find((t) => t.target === promptTargetId)
  useEffect(() => {
    if (currentTarget?.prompt_text) setPromptBody(currentTarget.prompt_text)
  }, [promptTargetId, currentTarget?.prompt_text])

  const handleAnalyze = async () => {
    const trimmed = skillInput.trim()
    if (!trimmed) return
    setWorking(true)
    setError(null)
    try {
      let skillBody = trimmed
      let skillName: string | undefined
      let skillDescription: string | undefined

      const isGithubUrl =
        skillBody.startsWith('http') &&
        (skillBody.includes('github.com') ||
          skillBody.includes('raw.githubusercontent.com')) &&
        skillBody.toLowerCase().includes('skill.md')

      if (isGithubUrl) {
        const fetchRes = await fetchSkillFromUrl(skillBody)
        skillBody = fetchRes.body
        skillName = fetchRes.name ?? undefined
        skillDescription = fetchRes.description ?? undefined
      } else {
        const parsed = parseSkillFrontmatter(skillBody)
        skillBody = parsed.body
        skillName = parsed.name
        skillDescription = parsed.description
      }

      await setSessionMode(sessionId, 'triggered')
      await seedFromSkill(sessionId, {
        skill_body: skillBody,
        skill_name: skillName,
        skill_description: skillDescription,
      })
      await onSeeded()
      setMode('collapsed')
      setSkillInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to analyze skill')
    } finally {
      setWorking(false)
    }
  }

  const handleCreatePrompt = async () => {
    if (!currentTarget || !promptBody.trim()) return
    setWorking(true)
    setError(null)
    try {
      const res = await createPromptEvalSession({
        prompt_target: currentTarget.target,
        sample_size: sampleSize,
        prompt_body: promptBody,
      })
      onPromptCreated(res.session_id)
      setMode('collapsed')
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to create prompt eval',
      )
    } finally {
      setWorking(false)
    }
  }

  // Cmd/Ctrl+Enter submits the active form when expanded. Scoped to the
  // expanded form's inputs (not window) so it doesn't fight with GoalsPanel's
  // own Cmd+Enter "Next" shortcut while the banner is collapsed or the user
  // is typing a goal.
  const handleFormKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (mode === 'skill') handleAnalyze()
      else if (mode === 'prompt') handleCreatePrompt()
    }
  }

  const canSubmitPrompt =
    !!currentTarget && promptBody.trim().length > 0 && !working
  const canSubmitSkill = skillInput.trim().length > 0 && !working

  return (
    <div className="bg-fill-neutral border border-border">
      {/* Header row — compact, single line on wide screens. */}
      <div className="flex items-center gap-3 px-3 py-2">
        <AIIcon className="text-fg-primary flex-shrink-0" />
        <p className="text-sm text-foreground flex-1 min-w-0">
          <span className="font-medium">
            Do you already have a prompt or a skill?
          </span>{' '}
          <span className="text-muted-foreground">
            North Star can generate goals and user stories from it that you can
            then review.
          </span>
        </p>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            size="small"
            variant="neutral"
            onClick={() => {
              setError(null)
              setMode((m) => (m === 'skill' ? 'collapsed' : 'skill'))
            }}
            disabled={working}
          >
            Add skill
          </Button>
          <Button
            size="small"
            variant="neutral"
            onClick={() => {
              setError(null)
              setMode((m) => (m === 'prompt' ? 'collapsed' : 'prompt'))
            }}
            disabled={working}
          >
            Add prompt
          </Button>
        </div>
      </div>

      {/* Skill paste form — inline expansion. */}
      {mode === 'skill' && (
        <div
          className="px-3 pb-3 pt-1 border-t border-border flex flex-col"
          onKeyDown={handleFormKeyDown}
        >
          <textarea
            value={skillInput}
            onChange={(e) => setSkillInput(e.target.value)}
            placeholder="Paste a Github link or the SKILL.md (with or without frontmatter), or start writing your own skill."
            className="w-full h-48 p-3 text-sm bg-background border border-border focus:outline-none focus:ring-1 focus:ring-accent resize-y mb-3 text-foreground placeholder:text-muted-foreground"
            autoFocus
            disabled={working}
          />
          {error && <p className="text-xs text-danger mb-2">{error}</p>}
          <div className="flex items-center gap-2">
            <Button
              size="small"
              variant="primary"
              onClick={handleAnalyze}
              shortcut={<span className="text-xs">⌘↵</span>}
              disabled={!canSubmitSkill}
            >
              {working ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              Analyze
            </Button>
            <Button
              size="small"
              variant="neutral"
              onClick={() => {
                setMode('collapsed')
                setError(null)
              }}
              disabled={working}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Prompt eval form — inline expansion. */}
      {mode === 'prompt' && (
        <div
          className="px-3 pb-3 pt-2 border-t border-border flex flex-col"
          onKeyDown={(e) => {
            // Avoid hijacking Cmd+Enter inside <select> dropdowns.
            if ((e.target as HTMLElement).tagName === 'SELECT') return
            handleFormKeyDown(e)
          }}
        >
          <label className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
            Prompt under test
          </label>
          <select
            value={promptTargetId}
            onChange={(e) => setPromptTargetId(e.target.value)}
            className="w-full p-2 text-sm bg-background border border-border focus:outline-none focus:ring-1 focus:ring-accent text-foreground mb-2"
            disabled={!promptTargets.length || working}
          >
            {promptTargets.map((t) => (
              <option key={t.target} value={t.target}>
                {t.label}
              </option>
            ))}
          </select>
          {currentTarget && (
            <div className="text-xs text-muted-foreground mb-3 flex items-center gap-2 flex-wrap">
              {currentTarget.builder_name && (
                <code className="font-mono">{currentTarget.builder_name}</code>
              )}
              {currentTarget.source_path && (
                <span className="text-muted-foreground/70">
                  · {currentTarget.source_path}
                </span>
              )}
              {currentTarget.description && (
                <span className="text-muted-foreground/70 w-full mt-1">
                  {currentTarget.description}
                </span>
              )}
            </div>
          )}

          <label className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
            Prompt template
          </label>
          <textarea
            value={promptBody}
            onChange={(e) => setPromptBody(e.target.value)}
            placeholder={
              loadError ? `Error: ${loadError}` : 'Loading prompt template…'
            }
            className="w-full h-48 p-3 text-xs bg-background border border-border focus:outline-none focus:ring-1 focus:ring-accent resize-y mb-3 font-mono text-foreground placeholder:text-muted-foreground"
            disabled={!promptTargets.length || working}
          />

          <label className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
            Sample size
          </label>
          <input
            type="number"
            min={1}
            max={200}
            value={sampleSize}
            onChange={(e) =>
              setSampleSize(
                Math.max(1, Math.min(200, Number(e.target.value) || 1)),
              )
            }
            className="w-full p-2 text-sm bg-background border border-border focus:outline-none focus:ring-1 focus:ring-accent text-foreground mb-3"
            disabled={working}
          />

          {(error || loadError) && (
            <p className="text-xs text-danger mb-2">{error ?? loadError}</p>
          )}

          <div className="flex items-center gap-2">
            <Button
              size="small"
              variant="primary"
              onClick={handleCreatePrompt}
              shortcut={<span className="text-xs">⌘↵</span>}
              disabled={!canSubmitPrompt}
            >
              {working ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              Create
            </Button>
            <Button
              size="small"
              variant="neutral"
              onClick={() => {
                setMode('collapsed')
                setError(null)
              }}
              disabled={working}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
