import { Plus, X, ArrowLeft } from 'lucide-react'
import type { StoryGroup, SuggestedStory } from '../types'

interface Props {
  storyGroups: StoryGroup[]
  onStoryGroupsChange: (groups: StoryGroup[]) => void
  suggestedStories?: SuggestedStory[]
  onAcceptStory?: (story: SuggestedStory) => void
  onDismissStory?: (story: SuggestedStory) => void
  onBackToGoals: () => void
  onGenerate: () => void
  canGenerate: boolean
  loading: boolean
}

export default function UsersPanel({
  storyGroups,
  onStoryGroupsChange,
  suggestedStories = [],
  onAcceptStory,
  onDismissStory,
  onBackToGoals,
  onGenerate,
  canGenerate,
  loading,
}: Props) {
  const addRole = () => {
    onStoryGroupsChange([...storyGroups, { role: '', stories: [{ what: '', why: '' }] }])
  }

  const updateRole = (groupIndex: number, role: string) => {
    const updated = [...storyGroups]
    updated[groupIndex] = { ...updated[groupIndex], role }
    onStoryGroupsChange(updated)
  }

  const removeRole = (groupIndex: number) => {
    onStoryGroupsChange(storyGroups.filter((_, i) => i !== groupIndex))
  }

  const addStory = (groupIndex: number) => {
    const updated = [...storyGroups]
    updated[groupIndex] = {
      ...updated[groupIndex],
      stories: [...updated[groupIndex].stories, { what: '', why: '' }],
    }
    onStoryGroupsChange(updated)
  }

  const updateStory = (groupIndex: number, storyIndex: number, field: 'what' | 'why', value: string) => {
    const updated = [...storyGroups]
    const stories = [...updated[groupIndex].stories]
    stories[storyIndex] = { ...stories[storyIndex], [field]: value }
    updated[groupIndex] = { ...updated[groupIndex], stories }
    onStoryGroupsChange(updated)
  }

  const removeStory = (groupIndex: number, storyIndex: number) => {
    const updated = [...storyGroups]
    const stories = updated[groupIndex].stories.filter((_, i) => i !== storyIndex)
    if (stories.length === 0) {
      onStoryGroupsChange(storyGroups.filter((_, i) => i !== groupIndex))
    } else {
      updated[groupIndex] = { ...updated[groupIndex], stories }
      onStoryGroupsChange(updated)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 h-12 border-b border-border bg-surface-raised flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">User Stories</h2>
        <button
          onClick={onBackToGoals}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <ArrowLeft className="w-3 h-3" />
          Goals
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-lg mx-auto space-y-5">
          <div>
            <p className="text-sm text-muted-foreground mb-4">
              Who will use this AI feature, and what do they need?
            </p>

            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-medium text-muted-foreground">
                User roles & stories
              </label>
              <button
                onClick={addRole}
                className="text-xs text-accent hover:opacity-80 font-medium flex items-center gap-0.5"
              >
                <Plus className="w-3 h-3" />
                Add role
              </button>
            </div>

            <div className="space-y-4">
              {storyGroups.map((group, gi) => (
                <div key={gi}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-muted-foreground flex-shrink-0">As a</span>
                    <input
                      type="text"
                      value={group.role}
                      onChange={e => updateRole(gi, e.target.value)}
                      placeholder="role..."
                      className="flex-1 text-sm font-semibold bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none border-b border-transparent focus:border-accent"
                    />
                    <button
                      onClick={() => removeRole(gi)}
                      className="text-muted-foreground hover:text-danger p-0.5"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>

                  <div className="space-y-2 pl-1">
                    {group.stories.map((story, si) => (
                      <div key={si} className="border border-border rounded-lg p-3 bg-surface-raised group">
                        <div className="flex items-start gap-2">
                          <div className="flex-1 space-y-2">
                            <div>
                              <label className="text-xs text-muted-foreground mb-0.5 block">I want to</label>
                              <input
                                type="text"
                                value={story.what}
                                onChange={e => updateStory(gi, si, 'what', e.target.value)}
                                placeholder="see a ranked list of candidates..."
                                className="w-full px-2 py-1.5 border border-border rounded text-sm bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-muted-foreground mb-0.5 block">In order to</label>
                              <input
                                type="text"
                                value={story.why}
                                onChange={e => updateStory(gi, si, 'why', e.target.value)}
                                placeholder="(optional) focus on the best fits first"
                                className="w-full px-2 py-1.5 border border-border rounded text-sm bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                              />
                            </div>
                          </div>
                          <button
                            onClick={() => removeStory(gi, si)}
                            className="mt-1 text-muted-foreground hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                    <button
                      onClick={() => addStory(gi)}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 pl-1"
                    >
                      <Plus className="w-3 h-3" />
                      add story
                    </button>
                  </div>
                </div>
              ))}

              {storyGroups.length === 0 && (
                <button
                  onClick={addRole}
                  className="w-full py-4 border border-dashed border-border rounded-lg text-xs text-muted-foreground hover:border-foreground/20 hover:text-foreground/60"
                >
                  Add a user role
                </button>
              )}

              {/* Suggested stories */}
              {suggestedStories.map((story, i) => (
                <div key={`sug-${i}`} className="border border-accent/30 rounded-lg p-3 bg-accent/5">
                  <div className="text-xs text-foreground mb-2">
                    As a <strong>{story.who}</strong>, I want to <strong>{story.what}</strong>
                    {story.why && <> in order to <strong>{story.why}</strong></>}
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => onAcceptStory?.(story)}
                      className="text-xs px-2 py-0.5 bg-accent/20 text-accent rounded hover:bg-accent/30 font-medium"
                    >
                      Add
                    </button>
                    <button
                      onClick={() => onDismissStory?.(story)}
                      className="text-xs px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                    >
                      dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Generate charter button */}
          <div className="pt-4">
            <button
              onClick={onGenerate}
              disabled={!canGenerate || loading}
              className="px-6 py-2.5 bg-accent text-accent-foreground rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {loading ? 'Generating...' : 'Generate charter'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
