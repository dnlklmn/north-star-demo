import { useRef, useEffect, useState } from 'react'
import { X, ArrowLeft, ArrowRight } from 'lucide-react'
import type { StoryGroup, SuggestedStory } from '../types'
import PanelLayout from './PanelLayout'
import Section from './Section'
import SuggestionBox, { SuggestionCard } from './SuggestionBox'

interface Props {
  storyGroups: StoryGroup[]
  onStoryGroupsChange: (groups: StoryGroup[]) => void
  onStoryCommit: () => void
  suggestedStories: SuggestedStory[]
  onAcceptStory: (story: SuggestedStory) => void
  onDismissStory: (story: SuggestedStory) => void
  storySuggestionsLoading: boolean
  onBackToGoals: () => void
  onGenerate: () => void
  canGenerate: boolean
  loading: boolean
  hasCharter: boolean
}

export default function UsersPanel({
  storyGroups,
  onStoryGroupsChange,
  onStoryCommit,
  suggestedStories,
  onAcceptStory,
  onDismissStory,
  storySuggestionsLoading,
  onBackToGoals,
  onGenerate,
  canGenerate,
  loading,
  hasCharter,
}: Props) {
  const roleInputRefs = useRef<(HTMLInputElement | null)[]>([])
  const storyWhatRefs = useRef<Map<string, HTMLInputElement | null>>(new Map())
  const storyWhyRefs = useRef<Map<string, HTMLInputElement | null>>(new Map())
  const focusRef = useRef<{ type: 'role' | 'what' | 'why'; groupIndex: number; storyIndex?: number } | null>(null)
  // Track which roles have been committed (Enter pressed) — only committed roles become Sections
  const [committedRoles, setCommittedRoles] = useState<Set<number>>(new Set())

  // Auto-commit roles that have content from outside (e.g. accepted suggestions)
  useEffect(() => {
    setCommittedRoles(prev => {
      let changed = false
      const next = new Set(prev)
      storyGroups.forEach((g, i) => {
        // A role with text AND at least one story with text was created externally — auto-commit it
        if (g.role.trim() && g.stories.some(s => s.what.trim()) && !next.has(i)) {
          next.add(i)
          changed = true
        }
      })
      return changed ? next : prev
    })
  }, [storyGroups])

  useEffect(() => {
    if (focusRef.current) {
      const { type, groupIndex, storyIndex } = focusRef.current
      focusRef.current = null
      requestAnimationFrame(() => {
        if (type === 'role') roleInputRefs.current[groupIndex]?.focus()
        else if (type === 'what' && storyIndex !== undefined) storyWhatRefs.current.get(`${groupIndex}-${storyIndex}`)?.focus()
        else if (type === 'why' && storyIndex !== undefined) storyWhyRefs.current.get(`${groupIndex}-${storyIndex}`)?.focus()
      })
    }
  })

  const hasStories = storyGroups.some(g => g.role.trim() && g.stories.some(s => s.what.trim()))

  const updateRole = (gi: number, role: string) => {
    const updated = [...storyGroups]
    updated[gi] = { ...updated[gi], role }
    onStoryGroupsChange(updated)
  }

  const removeRole = (gi: number) => {
    // Rebuild committed set with shifted indices
    setCommittedRoles(prev => {
      const next = new Set<number>()
      for (const idx of prev) {
        if (idx < gi) next.add(idx)
        else if (idx > gi) next.add(idx - 1)
      }
      return next
    })
    if (storyGroups.length <= 1) {
      onStoryGroupsChange([{ role: '', stories: [{ what: '', why: '' }] }])
      return
    }
    onStoryGroupsChange(storyGroups.filter((_, i) => i !== gi))
  }

  const updateStory = (gi: number, si: number, field: 'what' | 'why', value: string) => {
    const updated = [...storyGroups]
    const stories = [...updated[gi].stories]
    stories[si] = { ...stories[si], [field]: value }
    updated[gi] = { ...updated[gi], stories }
    onStoryGroupsChange(updated)
  }

  const removeStory = (gi: number, si: number) => {
    const updated = [...storyGroups]
    const stories = updated[gi].stories.filter((_, i) => i !== si)
    if (stories.length === 0) stories.push({ what: '', why: '' })
    updated[gi] = { ...updated[gi], stories }
    onStoryGroupsChange(updated)
  }

  const handleRoleKeyDown = (gi: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!storyGroups[gi].role.trim()) return
      setCommittedRoles(prev => new Set(prev).add(gi))
      focusRef.current = { type: 'what', groupIndex: gi, storyIndex: 0 }
      if (storyGroups[gi].stories.length === 0) {
        const updated = [...storyGroups]
        updated[gi] = { ...updated[gi], stories: [{ what: '', why: '' }] }
        onStoryGroupsChange(updated)
      } else {
        onStoryGroupsChange([...storyGroups])
      }
    }
  }

  const handleWhatKeyDown = (gi: number, si: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!storyGroups[gi].stories[si].what.trim()) return
      const updated = [...storyGroups]
      const stories = [...updated[gi].stories]
      if (si === stories.length - 1) {
        stories.push({ what: '', why: '' })
        updated[gi] = { ...updated[gi], stories }
        focusRef.current = { type: 'what', groupIndex: gi, storyIndex: si + 1 }
        onStoryGroupsChange(updated)
      } else {
        focusRef.current = { type: 'what', groupIndex: gi, storyIndex: si + 1 }
        onStoryGroupsChange([...storyGroups])
      }
      onStoryCommit()
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      focusRef.current = { type: 'why', groupIndex: gi, storyIndex: si }
      onStoryGroupsChange([...storyGroups])
    }
    if (e.key === 'Backspace' && storyGroups[gi].stories[si].what === '') {
      e.preventDefault()
      if (storyGroups[gi].stories.length > 1) {
        removeStory(gi, si)
        focusRef.current = { type: 'what', groupIndex: gi, storyIndex: Math.max(0, si - 1) }
      }
    }
  }

  const handleWhyKeyDown = (gi: number, si: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const updated = [...storyGroups]
      const stories = [...updated[gi].stories]
      if (si === stories.length - 1) {
        stories.push({ what: '', why: '' })
        updated[gi] = { ...updated[gi], stories }
        focusRef.current = { type: 'what', groupIndex: gi, storyIndex: si + 1 }
        onStoryGroupsChange(updated)
      } else {
        focusRef.current = { type: 'what', groupIndex: gi, storyIndex: si + 1 }
        onStoryGroupsChange([...storyGroups])
      }
      onStoryCommit()
    }
  }

  // Group suggestions by role
  const suggestedRoles = [...new Set(suggestedStories.map(s => s.who))]
  const storiesByRole = suggestedRoles.map(role => ({
    role,
    stories: suggestedStories.filter(s => s.who === role),
  }))

  return (
    <PanelLayout
      title="User Stories"
      headerLeft={
        <>
          <button onClick={onBackToGoals} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Goals
          </button>
          <span className="text-border">|</span>
        </>
      }
      headerRight={
        <button
          onClick={onGenerate}
          disabled={!canGenerate || loading}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
            canGenerate && !loading ? 'bg-accent text-accent-foreground hover:opacity-90' : 'text-muted-foreground/40 cursor-not-allowed'
          }`}
        >
          {loading ? 'Generating...' : hasCharter ? 'Regenerate charter' : 'Generate charter'}
          {!loading && <ArrowRight className="w-3.5 h-3.5" />}
        </button>
      }
      right={
        <SuggestionBox
          onRefresh={hasStories ? onStoryCommit : undefined}
          loading={storySuggestionsLoading}
          emptyText={hasStories ? 'Press Enter after a story to get suggestions' : 'Add a user story and press Enter to get suggestions'}
        >
          {suggestedStories.length > 0
            ? storiesByRole.map(({ role, stories }) => (
                <div key={role}>
                  <p className="text-xs font-semibold text-foreground mb-1.5 mt-2 first:mt-0">{role}</p>
                  {stories.map((story, i) => (
                    <SuggestionCard
                      key={i}
                      onAccept={() => onAcceptStory(story)}
                      onDismiss={() => onDismissStory(story)}
                    >
                      {story.what}
                      {story.why && <span className="text-muted-foreground"> — {story.why}</span>}
                    </SuggestionCard>
                  ))}
                </div>
              ))
            : null}
        </SuggestionBox>
      }
    >
      <p className="text-sm text-muted-foreground mb-4">
        Who will use this AI feature, and what do they need?
      </p>

      <div className="space-y-3">
        {storyGroups.map((group, gi) => (
          <div key={gi}>
            {committedRoles.has(gi) && group.role.trim() ? (
              <Section
                title={group.role}
                subtitle={`${group.stories.filter(s => s.what.trim()).length} stories`}
                onRemove={() => removeRole(gi)}
                onTitleChange={role => updateRole(gi, role)}
              >
                <div className="space-y-1.5">
                  {group.stories.map((story, si) => (
                    <div key={si} className="flex items-center gap-2 group/story">
                      <div className="flex-1 flex items-center gap-2">
                        <input
                          ref={el => { storyWhatRefs.current.set(`${gi}-${si}`, el) }}
                          type="text"
                          value={story.what}
                          onChange={e => updateStory(gi, si, 'what', e.target.value)}
                          onKeyDown={e => handleWhatKeyDown(gi, si, e)}
                          placeholder="I want to..."
                          className="flex-1 px-3 py-1.5 border border-border rounded-lg text-sm bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                        />
                        <input
                          ref={el => { storyWhyRefs.current.set(`${gi}-${si}`, el) }}
                          type="text"
                          value={story.why}
                          onChange={e => updateStory(gi, si, 'why', e.target.value)}
                          onKeyDown={e => handleWhyKeyDown(gi, si, e)}
                          placeholder="in order to... (optional)"
                          className="flex-1 px-3 py-1.5 border border-border rounded-lg text-sm bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                        />
                      </div>
                      <button
                        onClick={() => removeStory(gi, si)}
                        className="text-muted-foreground hover:text-danger opacity-0 group-hover/story:opacity-100 transition-opacity p-0.5"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Enter to add story · Tab to "in order to"
                  </p>
                </div>
              </Section>
            ) : (
              /* Empty role — just show the role input */
              <input
                ref={el => { roleInputRefs.current[gi] = el }}
                type="text"
                value={group.role}
                onChange={e => updateRole(gi, e.target.value)}
                onKeyDown={e => handleRoleKeyDown(gi, e)}
                placeholder="User role (e.g. recruiter, hiring manager...)"
                className="w-full px-3 py-2 border border-border rounded-lg text-sm font-semibold bg-surface-raised text-foreground placeholder:text-muted-foreground placeholder:font-normal focus:outline-none focus:ring-1 focus:ring-accent"
              />
            )}
          </div>
        ))}

        {storyGroups.length > 0 && storyGroups.every((_, i) => committedRoles.has(i)) && (
          <button
            onClick={() => {
              focusRef.current = { type: 'role', groupIndex: storyGroups.length }
              onStoryGroupsChange([...storyGroups, { role: '', stories: [{ what: '', why: '' }] }])
            }}
            className="w-full py-2.5 border border-dashed border-border rounded-lg text-xs text-muted-foreground hover:border-foreground/20 hover:text-foreground/60 transition-colors"
          >
            + Add another user role
          </button>
        )}
      </div>
    </PanelLayout>
  )
}
