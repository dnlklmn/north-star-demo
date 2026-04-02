import { useRef, useEffect, useState } from 'react'
import { X, ArrowRight, GripVertical, AlertTriangle } from 'lucide-react'
import PanelLayout from './PanelLayout'
import SuggestionBox, { SuggestionCard } from './SuggestionBox'

interface GoalFeedbackItem {
  goal: string
  issue: string | null
  suggestion: string | null
}

interface Props {
  goals: string[]
  onGoalsChange: (goals: string[]) => void
  onGoalCommit: () => void
  goalSuggestions: string[]
  onAcceptGoalSuggestion: (suggestion: string) => void
  onDismissGoalSuggestion: (suggestion: string) => void
  suggestionsLoading: boolean
  goalFeedback: GoalFeedbackItem[]
  goalFeedbackLoading: boolean
  onDefineUsers: () => void
  hasCharter: boolean
}

export default function GoalsPanel({
  goals,
  onGoalsChange,
  onGoalCommit,
  goalSuggestions,
  onAcceptGoalSuggestion,
  onDismissGoalSuggestion,
  suggestionsLoading,
  goalFeedback,
  goalFeedbackLoading,
  onDefineUsers,
  hasCharter,
}: Props) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const focusIndexRef = useRef<number | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  useEffect(() => {
    if (focusIndexRef.current !== null) {
      const idx = focusIndexRef.current
      focusIndexRef.current = null
      requestAnimationFrame(() => {
        inputRefs.current[idx]?.focus()
      })
    }
  }, [goals.length])

  const nonEmptyGoals = goals.filter(g => g.trim())
  const isReady = nonEmptyGoals.length >= 2

  // Match feedback to goals by text
  const getFeedback = (goal: string): GoalFeedbackItem | undefined => {
    if (!goal.trim()) return undefined
    return goalFeedback.find(f => f.goal === goal.trim() && f.issue)
  }

  const updateGoal = (index: number, value: string) => {
    const updated = [...goals]
    updated[index] = value
    onGoalsChange(updated)
  }

  const applyFeedbackSuggestion = (index: number, suggestion: string) => {
    const updated = [...goals]
    updated[index] = suggestion
    onGoalsChange(updated)
  }

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!goals[index].trim()) return
      if (index === goals.length - 1) {
        focusIndexRef.current = index + 1
        onGoalsChange([...goals, ''])
      } else {
        inputRefs.current[index + 1]?.focus()
      }
      onGoalCommit()
    }
    if (e.key === 'Backspace' && goals[index] === '' && goals.length > 1) {
      e.preventDefault()
      focusIndexRef.current = Math.max(0, index - 1)
      onGoalsChange(goals.filter((_, i) => i !== index))
    }
  }

  const removeGoal = (index: number) => {
    if (goals.length <= 1) { onGoalsChange(['']); return }
    onGoalsChange(goals.filter((_, i) => i !== index))
  }

  const handleDragStart = (index: number) => setDragIndex(index)
  const handleDragOver = (index: number, e: React.DragEvent) => { e.preventDefault(); setDragOverIndex(index) }
  const handleDrop = (index: number) => {
    if (dragIndex === null || dragIndex === index) { setDragIndex(null); setDragOverIndex(null); return }
    const updated = [...goals]
    const [moved] = updated.splice(dragIndex, 1)
    updated.splice(index, 0, moved)
    onGoalsChange(updated)
    setDragIndex(null)
    setDragOverIndex(null)
  }
  const handleDragEnd = () => { setDragIndex(null); setDragOverIndex(null) }

  return (
    <PanelLayout
      title="Business Goals"
      headerRight={
        <button
          onClick={onDefineUsers}
          disabled={!isReady}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
            isReady ? 'bg-accent text-accent-foreground hover:opacity-90' : 'text-muted-foreground/40 cursor-not-allowed'
          }`}
        >
          {hasCharter ? 'Update users' : 'Define users'}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      }
      right={
        <SuggestionBox
          onRefresh={nonEmptyGoals.length > 0 ? onGoalCommit : undefined}
          loading={suggestionsLoading}
          emptyText="Start adding goals to generate suggestions"
        >
          {goalSuggestions.length > 0
            ? goalSuggestions.map((suggestion, i) => (
                <SuggestionCard
                  key={i}
                  onAccept={() => onAcceptGoalSuggestion(suggestion)}
                  onDismiss={() => onDismissGoalSuggestion(suggestion)}
                >
                  {suggestion}
                </SuggestionCard>
              ))
            : null}
        </SuggestionBox>
      }
    >
      <p className="text-sm text-muted-foreground mb-4">
        What are you trying to achieve with this AI feature? Add each goal separately.
      </p>

      <div className="space-y-2">
        {goals.map((goal, i) => {
          const feedback = getFeedback(goal)
          return (
            <div key={i}>
              <div
                className={`flex items-center gap-1.5 group ${dragOverIndex === i && dragIndex !== i ? 'border-t-2 border-accent' : ''}`}
                draggable={!!goal.trim()}
                onDragStart={() => handleDragStart(i)}
                onDragOver={e => handleDragOver(i, e)}
                onDrop={() => handleDrop(i)}
                onDragEnd={handleDragEnd}
              >
                <GripVertical className={`w-3.5 h-3.5 text-muted-foreground/30 flex-shrink-0 ${goal.trim() ? 'cursor-grab group-hover:text-muted-foreground' : ''} ${dragIndex === i ? 'opacity-30' : ''}`} />
                <span className="text-xs text-muted-foreground w-4 text-right flex-shrink-0">{i + 1}.</span>
                <input
                  ref={el => { inputRefs.current[i] = el }}
                  type="text"
                  value={goal}
                  onChange={e => updateGoal(i, e.target.value)}
                  onKeyDown={e => handleKeyDown(i, e)}
                  placeholder={i === 0 ? 'e.g. Reduce time-to-hire by surfacing best candidates first' : 'Add another goal...'}
                  className={`flex-1 px-3 py-2 border rounded-lg text-sm bg-surface-raised text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent ${
                    feedback ? 'border-warning' : 'border-border'
                  } ${dragIndex === i ? 'opacity-30' : ''}`}
                />
                {feedback && (
                  <AlertTriangle className="w-3.5 h-3.5 text-warning flex-shrink-0" />
                )}
                {goals.length > 1 && goal.trim() && !feedback && (
                  <button
                    onClick={() => removeGoal(i)}
                    className="text-muted-foreground hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity p-1"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {feedback && (
                <div className="ml-9 mt-1 mb-1 flex items-start gap-2">
                  <p className="text-xs text-warning flex-1">
                    {feedback.issue}
                    {feedback.suggestion && (
                      <>
                        {' — '}
                        <button
                          onClick={() => applyFeedbackSuggestion(i, feedback.suggestion!)}
                          className="text-accent hover:underline font-medium"
                        >
                          Use: "{feedback.suggestion}"
                        </button>
                      </>
                    )}
                  </p>
                  <button
                    onClick={() => removeGoal(i)}
                    className="text-muted-foreground hover:text-danger p-0.5 flex-shrink-0"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground mt-2 pl-9">Press Enter to add another goal</p>
    </PanelLayout>
  )
}
