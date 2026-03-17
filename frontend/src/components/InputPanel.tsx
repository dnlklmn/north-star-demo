import { useState } from 'react'

interface Props {
  goals: string
  stories: string
  onGoalsChange: (goals: string) => void
  onStoriesChange: (stories: string) => void
  onRegenerate: () => void
  loading: boolean
  hasCharter: boolean
}

export default function InputPanel({
  goals,
  stories,
  onGoalsChange,
  onStoriesChange,
  onRegenerate,
  loading,
  hasCharter,
}: Props) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="border-b border-gray-200 bg-white">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-6 py-3 hover:bg-gray-50 transition-colors"
      >
        <h3 className="text-sm font-medium text-gray-700">Input</h3>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {!collapsed && (
        <div className="px-6 pb-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Business goals
            </label>
            <textarea
              value={goals}
              onChange={e => onGoalsChange(e.target.value)}
              placeholder="What are you trying to achieve with this AI feature?"
              rows={2}
              className="w-full px-2.5 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-transparent resize-y"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              User stories
            </label>
            <textarea
              value={stories}
              onChange={e => onStoriesChange(e.target.value)}
              placeholder="As a [who], I want to [what] so that [why]. Add as many as you need."
              rows={3}
              className="w-full px-2.5 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-transparent resize-y"
            />
          </div>

          {hasCharter && (
            <button
              onClick={onRegenerate}
              disabled={loading}
              className="w-full py-1.5 text-xs border border-blue-200 text-blue-600 rounded hover:bg-blue-50 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Regenerating...' : 'Regenerate from updated input'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
