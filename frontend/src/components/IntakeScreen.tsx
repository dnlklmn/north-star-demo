import type { UserStory, SuggestedStory } from '../types'

interface Props {
  goals: string
  stories: UserStory[]
  onGoalsChange: (goals: string) => void
  onStoriesChange: (stories: UserStory[]) => void
  onSubmit: () => void
  onBack?: () => void
  loading: boolean
  hasSession: boolean
  suggestedStories?: SuggestedStory[]
  onAcceptStory?: (story: SuggestedStory) => void
  onDismissStory?: (story: SuggestedStory) => void
}

export default function IntakeScreen({
  goals,
  stories,
  onGoalsChange,
  onStoriesChange,
  onSubmit,
  onBack,
  loading,
  hasSession,
  suggestedStories = [],
  onAcceptStory,
  onDismissStory,
}: Props) {
  const addStory = () => {
    onStoriesChange([...stories, { who: '', what: '', why: '' }])
  }

  const updateStory = (index: number, field: keyof UserStory, value: string) => {
    const updated = [...stories]
    updated[index] = { ...updated[index], [field]: value }
    onStoriesChange(updated)
  }

  const removeStory = (index: number) => {
    onStoriesChange(stories.filter((_, i) => i !== index))
  }

  const hasContent = goals.trim() || stories.some(s => s.who.trim() && s.what.trim())

  return (
    <div className="h-screen flex items-start justify-center bg-gray-50 overflow-y-auto">
      <div className="w-full max-w-xl p-8 pb-16">
        <h1 className="text-2xl font-semibold text-gray-800 mb-1">North Star</h1>
        <p className="text-sm text-gray-500 mb-6">
          Define what good AI output looks like for your feature.
        </p>

        <div className="space-y-6">
          {/* Business goals */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Business goals
            </label>
            <textarea
              value={goals}
              onChange={e => onGoalsChange(e.target.value)}
              placeholder="What are you trying to achieve with this AI feature?"
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* User stories */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">
                User stories
              </label>
              <button
                onClick={addStory}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                + Add story
              </button>
            </div>

            {stories.length === 0 && (
              <button
                onClick={addStory}
                className="w-full py-6 border-2 border-dashed border-gray-200 rounded-lg text-sm text-gray-400 hover:border-gray-300 hover:text-gray-500 transition-colors"
              >
                Add your first user story
              </button>
            )}

            <div className="space-y-3">
              {stories.map((story, i) => (
                <div key={i} className="border border-gray-200 rounded-lg p-3 bg-white">
                  <div className="flex items-start justify-between mb-2">
                    <span className="text-xs text-gray-400 font-medium">Story {i + 1}</span>
                    <button
                      onClick={() => removeStory(i)}
                      className="text-xs text-gray-300 hover:text-red-400 transition-colors"
                    >
                      remove
                    </button>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-500 w-10 flex-shrink-0">As a</label>
                      <input
                        type="text"
                        value={story.who}
                        onChange={e => updateStory(i, 'who', e.target.value)}
                        placeholder="hiring manager, customer, analyst..."
                        className="flex-1 px-2.5 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-500 w-10 flex-shrink-0">I want</label>
                      <input
                        type="text"
                        value={story.what}
                        onChange={e => updateStory(i, 'what', e.target.value)}
                        placeholder="to see a ranked list of candidates..."
                        className="flex-1 px-2.5 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-500 w-10 flex-shrink-0">So that</label>
                      <input
                        type="text"
                        value={story.why}
                        onChange={e => updateStory(i, 'why', e.target.value)}
                        placeholder="(optional) I can focus on the best fits first"
                        className="flex-1 px-2.5 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                </div>
              ))}

              {suggestedStories.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-blue-600">Suggested stories</p>
                  {suggestedStories.map((story, i) => (
                    <div key={`sug-${i}`} className="border border-blue-200 rounded-lg p-3 bg-blue-50">
                      <div className="text-sm text-blue-800 mb-2">
                        As a <strong>{story.who}</strong>, I want to <strong>{story.what}</strong>
                        {story.why && <> so that <strong>{story.why}</strong></>}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => onAcceptStory?.(story)}
                          className="text-xs px-3 py-1 bg-blue-200 text-blue-700 rounded hover:bg-blue-300 font-medium"
                        >
                          Add this story
                        </button>
                        <button
                          onClick={() => onDismissStory?.(story)}
                          className="text-xs px-2 py-1 text-blue-400 hover:text-blue-600"
                        >
                          dismiss
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <button
            onClick={onSubmit}
            disabled={loading || !hasContent}
            className="w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Working...' : hasSession ? 'Regenerate with updated input' : 'Start building'}
          </button>

          {hasSession && onBack && (
            <button
              onClick={onBack}
              className="w-full text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              &larr; Back to charter
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
