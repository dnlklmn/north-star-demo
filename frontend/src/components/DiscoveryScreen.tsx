import { useState } from 'react'
import { Plus, Pencil, Trash2, MessageSquare, ArrowRight } from 'lucide-react'
type Phase = 'goals' | 'users' | 'stories' | 'charter' | 'dataset'
type ExtractedStory = { who: string; what: string; why: string }

interface Props {
  phase: Phase
  goals: string[]
  users: string[]
  stories: ExtractedStory[]
  onEditGoal: (index: number, value: string) => void
  onAddGoal: (value: string) => void
  onDeleteGoal: (index: number) => void
  onEditUser: (index: number, value: string) => void
  onAddUser: (value: string) => void
  onDeleteUser: (index: number) => void
  onEditStory: (index: number, story: ExtractedStory) => void
  onAddStory: (story: ExtractedStory) => void
  onDeleteStory: (index: number) => void
  onItemClick: (type: 'goal' | 'user' | 'story', index: number) => void
  onAdvancePhase: () => void
  advancing?: boolean
}

const PHASE_ORDER = ['goals', 'users', 'stories', 'charter', 'dataset']

function isPastPhase(section: string, currentPhase: string): boolean {
  return PHASE_ORDER.indexOf(section) < PHASE_ORDER.indexOf(currentPhase)
}

function isFuturePhase(section: string, currentPhase: string): boolean {
  return PHASE_ORDER.indexOf(section) > PHASE_ORDER.indexOf(currentPhase)
}

export default function DiscoveryScreen({
  phase,
  goals,
  users,
  stories,
  onEditGoal,
  onAddGoal,
  onDeleteGoal,
  onEditUser,
  onAddUser,
  onDeleteUser,
  onEditStory,
  onAddStory,
  onDeleteStory,
  onItemClick,
  onAdvancePhase,
  advancing,
}: Props) {
  const [editingGoal, setEditingGoal] = useState<number | null>(null)
  const [editingUser, setEditingUser] = useState<number | null>(null)
  const [editingStory, setEditingStory] = useState<number | null>(null)
  const [newGoal, setNewGoal] = useState('')
  const [newUser, setNewUser] = useState('')
  const [showAddGoal, setShowAddGoal] = useState(false)
  const [showAddUser, setShowAddUser] = useState(false)
  const [showAddStory, setShowAddStory] = useState(false)
  const [newStory, setNewStory] = useState<ExtractedStory>({ who: '', what: '', why: '' })

  const isEmpty = goals.length === 0 && users.length === 0 && stories.length === 0

  return (
    <div className="h-full overflow-y-auto p-6">
      {isEmpty && phase === 'goals' ? (
        <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
          <MessageSquare className="w-12 h-12 mb-4 opacity-40" />
          <p className="text-lg font-medium mb-2">Start talking to the agent</p>
          <p className="text-sm max-w-md">
            The agent will help you define your business goals.
            As you talk, they'll appear here — or add them directly.
          </p>
        </div>
      ) : (
        <div className="space-y-8 max-w-2xl">
          {/* --- Business Goals --- */}
          <section className={isPastPhase('goals', phase) ? 'opacity-60' : isFuturePhase('goals', phase) ? 'opacity-40' : ''}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Business Goals
                {isPastPhase('goals', phase) && goals.length > 0 && (
                  <span className="ml-2 text-xs font-normal normal-case text-accent">done</span>
                )}
              </h2>
              <button
                onClick={() => setShowAddGoal(true)}
                className="flex items-center gap-1 text-xs text-accent hover:text-accent/80"
              >
                <Plus className="w-3 h-3" />
                Add
              </button>
            </div>

            <div className="space-y-2">
              {goals.map((goal, i) => (
                <div
                  key={i}
                  className="group flex items-start gap-2 p-3 rounded-lg bg-surface hover:bg-surface-raised transition-colors"
                >
                  {editingGoal === i ? (
                    <input
                      autoFocus
                      className="flex-1 bg-transparent text-sm text-foreground outline-none border-b border-accent"
                      defaultValue={goal}
                      onBlur={e => {
                        onEditGoal(i, e.target.value)
                        setEditingGoal(null)
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          onEditGoal(i, (e.target as HTMLInputElement).value)
                          setEditingGoal(null)
                        }
                        if (e.key === 'Escape') setEditingGoal(null)
                      }}
                    />
                  ) : (
                    <>
                      <button
                        onClick={() => onItemClick('goal', i)}
                        className="flex-1 text-sm text-foreground text-left"
                        title="Click to discuss in chat"
                      >
                        {goal}
                      </button>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => setEditingGoal(i)}
                          className="p-1 text-muted-foreground hover:text-foreground"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => onDeleteGoal(i)}
                          className="p-1 text-muted-foreground hover:text-danger"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}

              {showAddGoal && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-surface border border-accent/30">
                  <input
                    autoFocus
                    className="flex-1 bg-transparent text-sm text-foreground outline-none"
                    placeholder="Type a business goal..."
                    value={newGoal}
                    onChange={e => setNewGoal(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newGoal.trim()) {
                        onAddGoal(newGoal.trim())
                        setNewGoal('')
                        setShowAddGoal(false)
                      }
                      if (e.key === 'Escape') {
                        setNewGoal('')
                        setShowAddGoal(false)
                      }
                    }}
                    onBlur={() => {
                      if (newGoal.trim()) onAddGoal(newGoal.trim())
                      setNewGoal('')
                      setShowAddGoal(false)
                    }}
                  />
                </div>
              )}
            </div>

            {phase === 'goals' && goals.length > 0 && (
              <button
                onClick={onAdvancePhase}
                disabled={advancing}
                className="mt-4 flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {advancing ? 'Moving on...' : 'Move to users'}
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </section>

          {/* --- Users --- */}
          <section className={isPastPhase('users', phase) ? 'opacity-60' : isFuturePhase('users', phase) ? 'opacity-40' : ''}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Users
                {isPastPhase('users', phase) && users.length > 0 && (
                  <span className="ml-2 text-xs font-normal normal-case text-accent">done</span>
                )}
                {isFuturePhase('users', phase) && users.length === 0 && (
                  <span className="ml-2 text-xs font-normal normal-case">coming up next</span>
                )}
              </h2>
              {!isFuturePhase('users', phase) && (
                <button
                  onClick={() => setShowAddUser(true)}
                  className="flex items-center gap-1 text-xs text-accent hover:text-accent/80"
                >
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              )}
            </div>

            <div className="space-y-2">
              {users.map((user, i) => (
                <div
                  key={i}
                  className="group flex items-start gap-2 p-3 rounded-lg bg-surface hover:bg-surface-raised transition-colors"
                >
                  {editingUser === i ? (
                    <input
                      autoFocus
                      className="flex-1 bg-transparent text-sm text-foreground outline-none border-b border-accent"
                      defaultValue={user}
                      onBlur={e => {
                        onEditUser(i, e.target.value)
                        setEditingUser(null)
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          onEditUser(i, (e.target as HTMLInputElement).value)
                          setEditingUser(null)
                        }
                        if (e.key === 'Escape') setEditingUser(null)
                      }}
                    />
                  ) : (
                    <>
                      <button
                        onClick={() => onItemClick('user', i)}
                        className="flex-1 text-sm text-foreground text-left"
                        title="Click to discuss in chat"
                      >
                        {user}
                      </button>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => setEditingUser(i)}
                          className="p-1 text-muted-foreground hover:text-foreground"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => onDeleteUser(i)}
                          className="p-1 text-muted-foreground hover:text-danger"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}

              {showAddUser && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-surface border border-accent/30">
                  <input
                    autoFocus
                    className="flex-1 bg-transparent text-sm text-foreground outline-none"
                    placeholder="Type a user type (e.g. recruiter, hiring manager)..."
                    value={newUser}
                    onChange={e => setNewUser(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newUser.trim()) {
                        onAddUser(newUser.trim())
                        setNewUser('')
                        setShowAddUser(false)
                      }
                      if (e.key === 'Escape') {
                        setNewUser('')
                        setShowAddUser(false)
                      }
                    }}
                    onBlur={() => {
                      if (newUser.trim()) onAddUser(newUser.trim())
                      setNewUser('')
                      setShowAddUser(false)
                    }}
                  />
                </div>
              )}
            </div>

            {phase === 'users' && users.length > 0 && (
              <button
                onClick={onAdvancePhase}
                disabled={advancing}
                className="mt-4 flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {advancing ? 'Moving on...' : 'Move to user stories'}
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </section>

          {/* --- User Stories (grouped by user type) --- */}
          <section className={isFuturePhase('stories', phase) ? 'opacity-40' : ''}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                User Stories
                {isFuturePhase('stories', phase) && stories.length === 0 && (
                  <span className="ml-2 text-xs font-normal normal-case">coming up next</span>
                )}
              </h2>
              {phase === 'stories' && (
                <button
                  onClick={() => setShowAddStory(true)}
                  className="flex items-center gap-1 text-xs text-accent hover:text-accent/80"
                >
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              )}
            </div>

            <div className="space-y-4">
              {/* Group stories by user type */}
              {(() => {
                // Build groups: one per user, plus "Other" for unmatched
                const userGroups = users.length > 0
                  ? users.map(user => ({
                      user,
                      stories: stories
                        .map((s, i) => ({ story: s, index: i }))
                        .filter(({ story }) => story.who.toLowerCase() === user.toLowerCase()),
                    }))
                  : []

                // Stories that don't match any defined user
                const matchedIndices = new Set(userGroups.flatMap(g => g.stories.map(s => s.index)))
                const ungrouped = stories
                  .map((s, i) => ({ story: s, index: i }))
                  .filter(({ index }) => !matchedIndices.has(index))

                // If no users defined, show all stories flat
                if (users.length === 0) {
                  return stories.map((story, i) => (
                    <StoryItem
                      key={i}
                      story={story}
                      index={i}
                      editing={editingStory === i}
                      onStartEdit={() => setEditingStory(i)}
                      onCancelEdit={() => setEditingStory(null)}
                      onSaveEdit={(updated) => { onEditStory(i, updated); setEditingStory(null) }}
                      onDelete={() => onDeleteStory(i)}
                      onClick={() => onItemClick('story', i)}
                    />
                  ))
                }

                return (
                  <>
                    {userGroups.map(group => (
                      <div key={group.user}>
                        <h3 className="text-xs font-medium text-muted-foreground mb-2 pl-1">
                          {group.user}
                          <span className="ml-1.5 text-muted-foreground/60">{group.stories.length}</span>
                        </h3>
                        <div className="space-y-1.5 ml-2 border-l-2 border-border pl-3">
                          {group.stories.length === 0 && (
                            <p className="text-xs text-muted-foreground/60 italic py-1">No stories yet</p>
                          )}
                          {group.stories.map(({ story, index }) => (
                            <StoryItem
                              key={index}
                              story={story}
                              index={index}
                              editing={editingStory === index}
                              onStartEdit={() => setEditingStory(index)}
                              onCancelEdit={() => setEditingStory(null)}
                              onSaveEdit={(updated) => { onEditStory(index, updated); setEditingStory(null) }}
                              onDelete={() => onDeleteStory(index)}
                              onClick={() => onItemClick('story', index)}
                              hideWho
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                    {ungrouped.length > 0 && (
                      <div>
                        <h3 className="text-xs font-medium text-muted-foreground mb-2 pl-1">Other</h3>
                        <div className="space-y-1.5 ml-2 border-l-2 border-border pl-3">
                          {ungrouped.map(({ story, index }) => (
                            <StoryItem
                              key={index}
                              story={story}
                              index={index}
                              editing={editingStory === index}
                              onStartEdit={() => setEditingStory(index)}
                              onCancelEdit={() => setEditingStory(null)}
                              onSaveEdit={(updated) => { onEditStory(index, updated); setEditingStory(null) }}
                              onDelete={() => onDeleteStory(index)}
                              onClick={() => onItemClick('story', index)}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )
              })()}

              {showAddStory && (
                <div className="p-3 rounded-lg bg-surface border border-accent/30 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-8">As a</span>
                    <input
                      autoFocus
                      className="flex-1 bg-transparent text-sm outline-none border-b border-border focus:border-accent"
                      placeholder="user type"
                      value={newStory.who}
                      onChange={e => setNewStory({ ...newStory, who: e.target.value })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-8">I want</span>
                    <input
                      className="flex-1 bg-transparent text-sm outline-none border-b border-border focus:border-accent"
                      placeholder="what they want to do"
                      value={newStory.what}
                      onChange={e => setNewStory({ ...newStory, what: e.target.value })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-8">So that</span>
                    <input
                      className="flex-1 bg-transparent text-sm outline-none border-b border-border focus:border-accent"
                      placeholder="why it matters"
                      value={newStory.why}
                      onChange={e => setNewStory({ ...newStory, why: e.target.value })}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && newStory.who.trim() && newStory.what.trim()) {
                          onAddStory({ ...newStory })
                          setNewStory({ who: '', what: '', why: '' })
                          setShowAddStory(false)
                        }
                        if (e.key === 'Escape') {
                          setNewStory({ who: '', what: '', why: '' })
                          setShowAddStory(false)
                        }
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            {phase === 'stories' && stories.length > 0 && (
              <button
                onClick={onAdvancePhase}
                disabled={advancing}
                className="mt-4 flex items-center gap-2 px-4 py-2 rounded-lg bg-success text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {advancing ? 'Generating...' : 'Generate charter'}
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

// --- StoryItem sub-component ---
function StoryItem({
  story,
  index: _index,
  editing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onClick,
  hideWho,
}: {
  story: ExtractedStory
  index: number
  editing: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: (updated: ExtractedStory) => void
  onDelete: () => void
  onClick: () => void
  hideWho?: boolean
}) {
  if (editing) {
    return (
      <div className="p-3 rounded-lg bg-surface space-y-2">
        {!hideWho && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-8">As a</span>
            <input
              autoFocus
              className="flex-1 bg-transparent text-sm outline-none border-b border-accent"
              defaultValue={story.who}
              onKeyDown={e => { if (e.key === 'Escape') onCancelEdit() }}
              data-field="who"
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-8">I want</span>
          <input
            autoFocus={!!hideWho}
            className="flex-1 bg-transparent text-sm outline-none border-b border-accent"
            defaultValue={story.what}
            data-field="what"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-8">So that</span>
          <input
            className="flex-1 bg-transparent text-sm outline-none border-b border-accent"
            defaultValue={story.why}
            data-field="why"
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const container = (e.target as HTMLElement).closest('.space-y-2')
                if (container) {
                  const whoInput = container.querySelector('[data-field="who"]') as HTMLInputElement | null
                  const whatInput = container.querySelector('[data-field="what"]') as HTMLInputElement
                  const whyInput = container.querySelector('[data-field="why"]') as HTMLInputElement
                  onSaveEdit({
                    who: whoInput?.value || story.who,
                    what: whatInput.value,
                    why: whyInput.value,
                  })
                }
              }
              if (e.key === 'Escape') onCancelEdit()
            }}
            onBlur={e => {
              const container = (e.target as HTMLElement).closest('.space-y-2')
              if (container) {
                const whoInput = container.querySelector('[data-field="who"]') as HTMLInputElement | null
                const whatInput = container.querySelector('[data-field="what"]') as HTMLInputElement
                const whyInput = container.querySelector('[data-field="why"]') as HTMLInputElement
                onSaveEdit({
                  who: whoInput?.value || story.who,
                  what: whatInput.value,
                  why: whyInput.value,
                })
              }
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="group flex items-start gap-2 p-3 rounded-lg bg-surface hover:bg-surface-raised transition-colors">
      <button
        onClick={onClick}
        className="flex-1 text-left"
        title="Click to discuss in chat"
      >
        <p className="text-sm text-foreground">
          {!hideWho && (
            <>
              <span className="text-muted-foreground">As a </span>
              <span className="font-medium">{story.who}</span>
              <span className="text-muted-foreground">, I want to </span>
            </>
          )}
          {hideWho && <span className="text-muted-foreground">I want to </span>}
          {story.what}
          {story.why && (
            <>
              <span className="text-muted-foreground">, so that </span>
              {story.why}
            </>
          )}
        </p>
      </button>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onStartEdit}
          className="p-1 text-muted-foreground hover:text-foreground"
        >
          <Pencil className="w-3 h-3" />
        </button>
        <button
          onClick={onDelete}
          className="p-1 text-muted-foreground hover:text-danger"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}
