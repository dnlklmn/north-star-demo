import type { AgentStatus } from '../types'

const STAGES = [
  { key: 'intake', label: 'Intake' },
  { key: 'drafting', label: 'Drafting' },
  { key: 'refining', label: 'Refining' },
  { key: 'review', label: 'Review' },
] as const

function getStageIndex(status: AgentStatus): number {
  switch (status) {
    case 'drafting':
    case 'validating':
      return 1
    case 'questioning':
    case 'soft_ok':
      return 2
    case 'review':
      return 3
    default:
      return 0
  }
}

export default function ProgressBar({ status }: { status: AgentStatus }) {
  const currentIndex = getStageIndex(status)

  return (
    <div className="flex items-center gap-1">
      {STAGES.map((stage, i) => (
        <div key={stage.key} className="flex items-center gap-1">
          <div
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium transition-colors ${
              i < currentIndex
                ? 'bg-green-100 text-green-700'
                : i === currentIndex
                  ? 'bg-blue-100 text-blue-700'
                  : 'text-gray-400'
            }`}
          >
            {i < currentIndex && (
              <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            )}
            {stage.label}
          </div>
          {i < STAGES.length - 1 && (
            <span className="text-gray-300 text-xs">/</span>
          )}
        </div>
      ))}
    </div>
  )
}
