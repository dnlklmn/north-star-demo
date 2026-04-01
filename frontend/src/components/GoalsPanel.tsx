import { useRef, useEffect } from 'react'
import { X, Sparkles, ArrowRight, Loader2 } from 'lucide-react'

interface Props {
  goals: string[]
  onGoalsChange: (goals: string[]) => void
  goalSuggestions: string[]
  onAcceptGoalSuggestion: (suggestion: string) => void
  onDismissGoalSuggestion: (suggestion: string) => void
  suggestionsLoading: boolean
  onDefineUsers: () => void
}

export default function GoalsPanel({
  goals,
  onGoalsChange,
  goalSuggestions,
  onAcceptGoalSuggestion,
  onDismissGoalSuggestion,
  suggestionsLoading,
  onDefineUsers,
}: Props) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const focusIndexRef = useRef<number | null>(null)

  // Focus the right input after goals array changes
  useEffect(() => {
    if (focusIndexRef.current !== null) {
      const idx = focusIndexRef.current
      focusIndexRef.current = null
      // Small delay to ensure DOM is updated
      requestAnimationFrame(() => {
        inputRefs.current[idx]?.focus()
      })
    }
  }, [goals.length])

  const nonEmptyGoals = goals.filter(g => g.trim())
  const isReady = nonEmptyGoals.length >= 2

  const updateGoal = (index: number, value: string) => {
    const updated = [...goals]
    updated[index] = value
    onGoalsChange(updated)
  }

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const currentValue = goals[index].trim()
      if (!currentValue) return // Don't create new if current is empty

      // If this is the last input, add a new empty one
      if (index === goals.length - 1) {
        focusIndexRef.current = index + 1
        onGoalsChange([...goals, ''])
      } else {
        // Focus next existing input
        inputRefs.current[index + 1]?.focus()
      }
    }

    if (e.key === 'Backspace' && goals[index] === '' && goals.length > 1) {
      e.preventDefault()
      const updated = goals.filter((_, i) => i !== index)
      focusIndexRef.current = Math.max(0, index - 1)
      onGoalsChange(updated)
    }
  }

  const removeGoal = (index: number) => {
    if (goals.length <= 1) {
      onGoalsChange([''])
      return
    }
    const updated = goals.filter((_, i) => i !== index)
    onGoalsChange(updated)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 h-12 border-b border-border bg-surface-raised flex items-center">
        <h2 className="text-sm font-semibold text-foreground">Business Goals</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-lg mx-auto space-y-6">
          <div>
            <p className="text-sm text-muted-foreground mb-4">
              What are you trying to achieve with this AI feature? Add each goal separately.
            </p>

            {/* Goal inputs */}
            <div className="space-y-2">
              {goals.map((goal, i) => (
                <div key={i} className="flex items-center gap-2 group">
                  <span className="text-xs text-muted-foreground w-5 text-right flex-shrink-0">
                    {i + 1}.
                  </span>
                  <input
                    ref={el => { inputRefs.current[i] = el }}
                    type="text"
                    value={goal}
                    onChange={e => updateGoal(i, e.target.value)}
                    onKeyDown={e => handleKeyDown(i, e)}
                    placeholder={i === 0 ? 'e.g. Reduce time-to-hire by surfacing best candidates first' : 'Add another goal...'}
                    className="flex-1 px-3 py-2 border border-border rounded-lg text-sm bg-surface-raised text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                  {goals.length > 1 && goal.trim() && (
                    <button
                      onClick={() => removeGoal(i)}
                      className="text-muted-foreground hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity p-1"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <p className="text-xs text-muted-foreground mt-2 pl-7">
              Press Enter to add another goal
            </p>
          </div>

          {/* AI suggestions */}
          {(goalSuggestions.length > 0 || suggestionsLoading) && (
            <div className="pl-7">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles className="w-3.5 h-3.5 text-accent" />
                <span className="text-xs font-medium text-muted-foreground">Suggested goals</span>
                {suggestionsLoading && <Loader2 className="w-3 h-3 text-muted-foreground animate-spin" />}
              </div>
              <div className="space-y-1.5">
                {goalSuggestions.map((suggestion, i) => (
                  <div key={i} className="flex items-start gap-2 py-1.5 px-2.5 bg-accent/5 border border-accent/20 rounded-lg">
                    <span className="flex-1 text-sm text-foreground">{suggestion}</span>
                    <div className="flex gap-1 flex-shrink-0">
                      <button
                        onClick={() => onAcceptGoalSuggestion(suggestion)}
                        className="text-xs px-2 py-0.5 bg-accent/20 text-accent rounded hover:bg-accent/30 font-medium"
                      >
                        Add
                      </button>
                      <button
                        onClick={() => onDismissGoalSuggestion(suggestion)}
                        className="text-xs px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                      >
                        dismiss
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Define users button */}
          <div className="pt-4 pl-7">
            <button
              onClick={onDefineUsers}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${
                isReady
                  ? 'bg-accent text-accent-foreground hover:opacity-90'
                  : 'bg-muted text-muted-foreground cursor-default'
              }`}
            >
              Define users
              <ArrowRight className="w-4 h-4" />
            </button>
            {!isReady && (
              <p className="text-xs text-muted-foreground mt-1.5">
                Add at least 2 business goals to continue
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
