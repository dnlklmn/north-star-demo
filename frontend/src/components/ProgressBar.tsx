import { useState } from 'react'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import type { Screen, Phase } from '../types'

interface Props {
  currentScreen: Screen
  phase: Phase
  onNavigate: (screen: Screen) => void
  goalCount?: number
  userCount?: number
  storyCount?: number
}

const STEPS: { screen: Screen; label: string; description: string }[] = [
  { screen: 'goals', label: 'Goals', description: 'Define the business goals your AI feature should achieve.' },
  { screen: 'users', label: 'Users', description: 'Identify the user types who will interact with this feature.' },
  { screen: 'stories', label: 'Stories', description: 'Describe what each user type needs to accomplish and why.' },
  { screen: 'charter', label: 'Charter', description: 'Review and refine the evaluation criteria, quality rubric, and staleness triggers.' },
  { screen: 'dataset', label: 'Dataset', description: 'Build, review, and export your evaluation dataset.' },
]

const ORDER: Screen[] = ['goals', 'users', 'stories', 'charter', 'dataset']

function getStepState(step: Screen, phase: Phase): 'upcoming' | 'active' | 'complete' {
  const phaseIndex = ORDER.indexOf(phase)
  const stepIndex = ORDER.indexOf(step)

  if (stepIndex < phaseIndex) return 'complete'
  if (stepIndex === phaseIndex) return 'active'
  return 'upcoming'
}

export default function ProgressBar({ currentScreen, phase, onNavigate, goalCount, userCount, storyCount }: Props) {
  const [showDescription, setShowDescription] = useState(true)
  const currentStep = STEPS.find(s => s.screen === currentScreen)

  return (
    <div className="border-b border-border bg-background">
      <div className="flex items-center gap-2 px-6 py-3">
        {STEPS.map((step, i) => {
          const state = getStepState(step.screen, phase)
          const isSelected = currentScreen === step.screen
          const canClick = state === 'complete' || state === 'active'

          // Badge counts
          const badge = step.screen === 'goals' && goalCount
            ? goalCount
            : step.screen === 'users' && userCount
              ? userCount
              : step.screen === 'stories' && storyCount
                ? storyCount
                : null

          return (
            <div key={step.screen} className="flex items-center gap-2">
              {i > 0 && (
                <div className={`w-8 h-px ${state === 'upcoming' ? 'bg-border' : 'bg-accent'}`} />
              )}
              <button
                onClick={() => canClick && onNavigate(step.screen)}
                disabled={!canClick}
                className={`
                  flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors
                  ${isSelected
                    ? 'bg-accent text-white'
                    : state === 'complete'
                      ? 'bg-accent/10 text-accent hover:bg-accent/20 cursor-pointer'
                      : state === 'active'
                        ? 'bg-surface text-foreground hover:bg-surface-raised cursor-pointer'
                        : 'bg-surface text-muted-foreground cursor-not-allowed'
                  }
                `}
              >
                {state === 'complete' && (
                  <Check className="w-3.5 h-3.5" />
                )}
                {state === 'active' && !isSelected && (
                  <div className="w-2 h-2 rounded-full bg-accent" />
                )}
                {step.label}
                {badge !== null && (
                  <span className={`
                    text-xs px-1.5 py-0.5 rounded-full min-w-[1.25rem] text-center
                    ${isSelected ? 'bg-white/20' : 'bg-accent/10 text-accent'}
                  `}>
                    {badge}
                  </span>
                )}
              </button>
            </div>
          )
        })}

        {/* Toggle description */}
        <button
          onClick={() => setShowDescription(prev => !prev)}
          className="ml-auto p-1 text-muted-foreground hover:text-foreground transition-colors"
          title={showDescription ? 'Hide description' : 'Show description'}
        >
          {showDescription ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Collapsible description */}
      {showDescription && currentStep && (
        <div className="px-6 pb-3 -mt-1">
          <p className="text-xs text-muted-foreground">{currentStep.description}</p>
        </div>
      )}
    </div>
  )
}
