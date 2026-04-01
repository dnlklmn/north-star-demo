import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { MessageSquare, Settings, X } from 'lucide-react'
import type { Message, SessionState, AgentStatus, StoryGroup, Suggestion, SuggestedStory, Dataset, Example, GapAnalysis } from './types'
import {
  createSession, getSession, sendMessage, patchCharter, finalizeCharter,
  validateCharter, suggestForCharter, suggestGoals,
  createDataset, getDataset, synthesizeExamples, updateExample as apiUpdateExample,
  deleteExample as apiDeleteExample, autoReviewExamples, getGapAnalysis, exportDataset,
  datasetChat,
} from './api'
import GoalsPanel from './components/GoalsPanel'
import UsersPanel from './components/UsersPanel'
import CharterPanel from './components/CharterPanel'
import ConversationPanel from './components/ConversationPanel'
import ExampleReview from './components/ExampleReview'
import CoverageMap from './components/CoverageMap'
import SettingsPanel from './components/SettingsPanel'

type ActiveTab = 'goals' | 'users' | 'charter' | 'examples'

const EMPTY_STATE: SessionState = {
  session_id: '',
  input: { business_goals: null, user_stories: null, conversation_history: [] },
  charter: {
    task: { input_description: '', output_description: '', sample_input: null, sample_output: null },
    coverage: { criteria: [], status: 'pending' },
    balance: { criteria: [], status: 'pending' },
    alignment: [],
    rot: { criteria: [], status: 'pending' },
  },
  validation: {
    coverage: 'untested',
    balance: 'untested',
    alignment: [],
    rot: 'untested',
    overall: 'untested',
  },
  rounds_of_questions: 0,
  agent_status: 'drafting',
}

function formatStoryGroups(groups: StoryGroup[]): string {
  return groups
    .filter(g => g.role.trim())
    .flatMap(g =>
      g.stories
        .filter(s => s.what.trim())
        .map(s => {
          let line = `As a ${g.role.trim()}, I want to ${s.what.trim()}`
          if (s.why.trim()) line += ` so that ${s.why.trim()}`
          return line
        })
    )
    .join('\n')
}

export default function App() {
  // --- Navigation ---
  const [activeTab, setActiveTab] = useState<ActiveTab>('goals')
  const [showAssistant, setShowAssistant] = useState(false)

  // --- Shared state ---
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [state, setState] = useState<SessionState>(EMPTY_STATE)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)

  // --- Goals state ---
  const [goals, setGoals] = useState<string[]>([''])
  const [goalSuggestions, setGoalSuggestions] = useState<string[]>([])
  const [goalSuggestionsLoading, setGoalSuggestionsLoading] = useState(false)

  // --- Charter phase state ---
  const [activeCriteria, setActiveCriteria] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestedStories, setSuggestedStories] = useState<SuggestedStory[]>([])
  const [storyGroups, setStoryGroups] = useState<StoryGroup[]>([
    { role: '', stories: [{ what: '', why: '' }] },
  ])

  // --- Input change tracking for regenerate button ---
  const [savedInput, setSavedInput] = useState<{ goals: string; stories: string } | null>(null)

  // --- Dataset phase state ---
  const [dataset, setDataset] = useState<Dataset | null>(null)
  const [actionSuggestions, setActionSuggestions] = useState<Array<{ action: string; label: string; reason: string }>>([])

  const [gapAnalysis, setGapAnalysis] = useState<GapAnalysis | null>(null)
  const [showCoverageMap, setShowCoverageMap] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const status: AgentStatus = state.agent_status
  const hasCharter = !!(state.charter.coverage.criteria.length || state.charter.alignment.length)
  const nonEmptyGoals = goals.filter(g => g.trim())

  // Tab availability
  const usersAvailable = nonEmptyGoals.length >= 2
  const charterAvailable = hasCharter || loading
  const examplesAvailable = !!dataset

  // Check if input has changed since charter was generated
  const inputChanged = useMemo(() => {
    if (!savedInput) return false
    const currentGoals = nonEmptyGoals.join('\n')
    const currentStories = formatStoryGroups(storyGroups)
    return currentGoals !== savedInput.goals || currentStories !== savedInput.stories
  }, [savedInput, nonEmptyGoals, storyGroups])

  // --- Goals handlers ---

  const handleGoalsChange = useCallback((newGoals: string[]) => {
    setGoals(newGoals)
  }, [])

  const fetchGoalSuggestions = useCallback(async (currentGoals: string[]) => {
    const nonEmpty = currentGoals.filter(g => g.trim())
    if (nonEmpty.length === 0) return

    setGoalSuggestionsLoading(true)
    try {
      const res = await suggestGoals(nonEmpty)
      setGoalSuggestions(res.suggestions)
    } catch (err) {
      console.error('Failed to get goal suggestions:', err)
    } finally {
      setGoalSuggestionsLoading(false)
    }
  }, [])

  // Called by GoalsPanel when user presses Enter on a non-empty goal
  const handleGoalCommit = useCallback(() => {
    fetchGoalSuggestions(goals)
  }, [goals, fetchGoalSuggestions])

  // Debounced re-fetch after accepting a suggestion
  const suggestionDebounceRef = useRef<number | null>(null)

  const handleAcceptGoalSuggestion = useCallback((suggestion: string) => {
    setGoals(prev => {
      const lastIsEmpty = prev.length > 0 && prev[prev.length - 1].trim() === ''
      const newGoals = lastIsEmpty
        ? [...prev.slice(0, -1), suggestion, '']
        : [...prev, suggestion, '']

      // Schedule a debounced re-fetch with the new goals
      if (suggestionDebounceRef.current) {
        window.clearTimeout(suggestionDebounceRef.current)
      }
      suggestionDebounceRef.current = window.setTimeout(() => {
        suggestionDebounceRef.current = null
        const nonEmpty = newGoals.filter(g => g.trim())
        if (nonEmpty.length > 0) {
          fetchGoalSuggestions(newGoals)
        }
      }, 3000)

      return newGoals
    })
    setGoalSuggestions(prev => prev.filter(s => s !== suggestion))
  }, [fetchGoalSuggestions])

  const handleDismissGoalSuggestion = useCallback((suggestion: string) => {
    setGoalSuggestions(prev => prev.filter(s => s !== suggestion))
  }, [])

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (suggestionDebounceRef.current) {
        window.clearTimeout(suggestionDebounceRef.current)
      }
    }
  }, [])

  // --- Charter phase handlers ---

  const handleSubmitIntake = useCallback(async () => {
    const goalsText = nonEmptyGoals.join('\n')
    const storiesText = formatStoryGroups(storyGroups)
    if (!goalsText && !storiesText) return

    setActiveTab('charter')
    setLoading(true)

    try {
      if (!sessionId) {
        const res = await createSession({
          business_goals: goalsText || undefined,
          user_stories: storiesText || undefined,
        })
        setSessionId(res.session_id)
        if (res.message) {
          setMessages([{ role: 'assistant', content: res.message }])
        }
        const session = await getSession(res.session_id)
        setState(session.state as SessionState)
        setSuggestions(res.suggestions || [])
        setSuggestedStories(res.suggested_stories || [])
        setSavedInput({ goals: goalsText, stories: storiesText })
      } else {
        const updateMsg = `I've updated my input.\n\nBusiness goals:\n${goalsText}\n\nUser stories:\n${storiesText}\n\nPlease regenerate the document with this updated input.`
        const res = await sendMessage(sessionId, updateMsg, { regenerate: true })
        setMessages(prev => [
          ...prev,
          { role: 'user', content: '(Updated input)' },
          { role: 'assistant', content: res.message },
        ])
        setState(res.state)
        setSuggestions(res.suggestions || [])
        setSuggestedStories(res.suggested_stories || [])
        setSavedInput({ goals: goalsText, stories: storiesText })
      }
    } catch (err) {
      console.error('Failed:', err)
    } finally {
      setLoading(false)
    }
  }, [nonEmptyGoals, storyGroups, sessionId])

  // Execute an action from the agent
  const executeAgentAction = useCallback(async (action: { action: string; count?: number; example_id?: string }) => {
    if (!dataset) return

    switch (action.action) {
      case 'generate':
        try {
          const res = await synthesizeExamples(dataset.id, action.count ? { count_per_scenario: action.count } : undefined)
          const fullDs = await getDataset(dataset.session_id)
          setDataset(fullDs)
          setMessages(prev => [...prev, { role: 'assistant', content: `Generated ${res.generated} examples.` }])
        } catch (err) {
          console.error('Failed to generate:', err)
        }
        break

      case 'show_coverage':
        try {
          const gaps = await getGapAnalysis(dataset.id)
          setGapAnalysis(gaps)
          setShowCoverageMap(true)
        } catch (err) {
          console.error('Failed to get coverage:', err)
        }
        break

      case 'auto_review':
        try {
          const res = await autoReviewExamples(dataset.id)
          const fullDs = await getDataset(dataset.session_id)
          setDataset(fullDs)
          setMessages(prev => [...prev, { role: 'assistant', content: `Reviewed ${res.reviewed} examples.` }])
        } catch (err) {
          console.error('Failed to auto-review:', err)
        }
        break

      case 'export':
        try {
          const data = await exportDataset(dataset.id)
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `dataset-v${dataset.version}.json`
          a.click()
          URL.revokeObjectURL(url)
        } catch (err) {
          console.error('Failed to export:', err)
        }
        break

      case 'approve':
        if (action.example_id) {
          try {
            await apiUpdateExample(dataset.id, action.example_id, { review_status: 'approved' })
            const fullDs = await getDataset(dataset.session_id)
            setDataset(fullDs)
          } catch (err) {
            console.error('Failed to approve:', err)
          }
        }
        break

      case 'reject':
        if (action.example_id) {
          try {
            await apiUpdateExample(dataset.id, action.example_id, { review_status: 'rejected' })
            const fullDs = await getDataset(dataset.session_id)
            setDataset(fullDs)
          } catch (err) {
            console.error('Failed to reject:', err)
          }
        }
        break
    }
  }, [dataset])

  const handleSend = useCallback(async (message: string) => {
    if (!sessionId) return
    setMessages(prev => [...prev, { role: 'user', content: message }])
    setLoading(true)
    try {
      if (dataset) {
        const res = await datasetChat(dataset.id, message)
        setMessages(prev => [...prev, { role: 'assistant', content: res.message }])
        setState(res.state)
        setActionSuggestions(res.action_suggestions || [])
        if (res.actions && res.actions.length > 0) {
          for (const action of res.actions) {
            await executeAgentAction(action)
          }
          const fullDs = await getDataset(dataset.session_id)
          setDataset(fullDs)
        }
      } else {
        const res = await sendMessage(sessionId, message)
        setMessages(prev => [...prev, { role: 'assistant', content: res.message }])
        setState(res.state)
        setActiveCriteria([])
        setSuggestions(res.suggestions || [])
        setSuggestedStories(res.suggested_stories || [])
      }
    } catch (err) {
      console.error('Failed to send message:', err)
      setMessages(prev => [...prev, { role: 'assistant', content: 'Something went wrong. Please try again.' }])
    } finally {
      setLoading(false)
    }
  }, [sessionId, dataset, executeAgentAction])

  const handleEditCriterion = useCallback(async (dimension: string, index: number, value: string) => {
    if (!sessionId) return
    const charter = { ...state.charter }
    const dim = dimension as 'coverage' | 'balance' | 'rot'
    const criteria = [...charter[dim].criteria]
    criteria[index] = value
    charter[dim] = { ...charter[dim], criteria }

    try {
      const res = await patchCharter(sessionId, { [dimension]: charter[dim] })
      setState(prev => ({ ...prev, ...res.state }))
    } catch (err) {
      console.error('Failed to save edit:', err)
    }
  }, [sessionId, state.charter])

  const handleAddCriterion = useCallback(async (dimension: string, value: string) => {
    if (!sessionId) return
    const dim = dimension as 'coverage' | 'balance' | 'rot'
    const currentCharter = charterRef.current
    const newCriteria = [...currentCharter[dim].criteria, value]
    const newDim = { ...currentCharter[dim], criteria: newCriteria }
    charterRef.current = { ...charterRef.current, [dim]: newDim }
    setState(prev => ({
      ...prev,
      charter: { ...prev.charter, [dim]: newDim }
    }))
    patchCharter(sessionId, { [dim]: newDim }).catch(err => {
      console.error('Failed to add criterion:', err)
    })
  }, [sessionId])

  const handleEditAlignment = useCallback(async (index: number, field: 'good' | 'bad', value: string) => {
    if (!sessionId) return
    const alignment = [...state.charter.alignment]
    alignment[index] = { ...alignment[index], [field]: value }

    try {
      const res = await patchCharter(sessionId, { alignment })
      setState(prev => ({ ...prev, ...res.state }))
    } catch (err) {
      console.error('Failed to save alignment edit:', err)
    }
  }, [sessionId, state.charter.alignment])

  const handleEditTask = useCallback(async (field: 'input_description' | 'output_description' | 'sample_input' | 'sample_output', value: string) => {
    if (!sessionId) return
    const task = { ...state.charter.task, [field]: value }

    try {
      const res = await patchCharter(sessionId, { task })
      setState(prev => ({ ...prev, ...res.state }))
    } catch (err) {
      console.error('Failed to save task edit:', err)
    }
  }, [sessionId, state.charter.task])

  const handleValidate = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      const res = await validateCharter(sessionId)
      setState(prev => ({ ...prev, validation: res.validation }))
    } catch (err) {
      console.error('Failed to validate:', err)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  const handleSuggest = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      const res = await suggestForCharter(sessionId)
      setSuggestions(prev => [...prev, ...res.suggestions])
      setSuggestedStories(prev => [...prev, ...res.suggested_stories])
    } catch (err) {
      console.error('Failed to get suggestions:', err)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  // Use a ref to track latest charter state for rapid updates
  const charterRef = useRef(state.charter)
  useEffect(() => {
    charterRef.current = state.charter
  }, [state.charter])

  const handleAcceptSuggestion = useCallback(async (suggestion: Suggestion) => {
    if (!sessionId) return

    const currentCharter = charterRef.current

    if (suggestion.section === 'alignment' && suggestion.good && suggestion.bad) {
      const newEntry = {
        feature_area: suggestion.text,
        good: suggestion.good,
        bad: suggestion.bad,
        status: 'pending' as const,
      }
      const newAlignment = [...currentCharter.alignment, newEntry]
      charterRef.current = { ...charterRef.current, alignment: newAlignment }
      setState(prev => ({
        ...prev,
        charter: { ...prev.charter, alignment: newAlignment }
      }))
      patchCharter(sessionId, { alignment: newAlignment }).catch(err => {
        console.error('Failed to accept suggestion:', err)
      })
    } else {
      const dim = suggestion.section as 'coverage' | 'balance' | 'rot'
      const newCriteria = [...currentCharter[dim].criteria, suggestion.text]
      const newDim = { ...currentCharter[dim], criteria: newCriteria }
      charterRef.current = { ...charterRef.current, [dim]: newDim }
      setState(prev => ({
        ...prev,
        charter: { ...prev.charter, [dim]: newDim }
      }))
      patchCharter(sessionId, { [dim]: newDim }).catch(err => {
        console.error('Failed to accept suggestion:', err)
      })
    }

    setSuggestions(prev => prev.filter(s => s !== suggestion))
  }, [sessionId])

  const handleDismissSuggestion = useCallback((suggestion: Suggestion) => {
    setSuggestions(prev => prev.filter(s => s !== suggestion))
  }, [])

  const handleAcceptStory = useCallback((story: SuggestedStory) => {
    setStoryGroups(prev => {
      const existing = prev.findIndex(g => g.role.toLowerCase() === story.who.toLowerCase())
      if (existing >= 0) {
        const updated = [...prev]
        updated[existing] = {
          ...updated[existing],
          stories: [...updated[existing].stories, { what: story.what, why: story.why }],
        }
        return updated
      }
      return [...prev, { role: story.who, stories: [{ what: story.what, why: story.why }] }]
    })
    setSuggestedStories(prev => prev.filter(s => s !== story))
  }, [])

  const handleDismissStory = useCallback((story: SuggestedStory) => {
    setSuggestedStories(prev => prev.filter(s => s !== story))
  }, [])

  // --- Phase transition: charter -> dataset ---

  const handleStartDataset = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      await finalizeCharter(sessionId)
      await createDataset(sessionId)
      const fullDs = await getDataset(sessionId)
      setDataset(fullDs)
      setActiveTab('examples')
    } catch (err) {
      console.error('Failed to start dataset:', err)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  // --- Dataset phase handlers ---

  const handleSynthesize = useCallback(async (count?: number) => {
    if (!dataset) return
    setLoading(true)
    try {
      await synthesizeExamples(dataset.id, count ? { count_per_scenario: count } : undefined)
      const fullDs = await getDataset(dataset.session_id)
      setDataset(fullDs)
    } catch (err) {
      console.error('Failed to synthesize:', err)
    } finally {
      setLoading(false)
    }
  }, [dataset])

  const handleUpdateExample = useCallback(async (exampleId: string, fields: Partial<Example>) => {
    if (!dataset) return
    try {
      await apiUpdateExample(dataset.id, exampleId, fields)
      const fullDs = await getDataset(dataset.session_id)
      setDataset(fullDs)
    } catch (err) {
      console.error('Failed to update example:', err)
    }
  }, [dataset])

  const handleDeleteExample = useCallback(async (exampleId: string) => {
    if (!dataset) return
    try {
      await apiDeleteExample(dataset.id, exampleId)
      const fullDs = await getDataset(dataset.session_id)
      setDataset(fullDs)
    } catch (err) {
      console.error('Failed to delete example:', err)
    }
  }, [dataset])

  const handleAutoReview = useCallback(async () => {
    if (!dataset) return
    setLoading(true)
    try {
      await autoReviewExamples(dataset.id)
      const fullDs = await getDataset(dataset.session_id)
      setDataset(fullDs)
    } catch (err) {
      console.error('Failed to auto-review:', err)
    } finally {
      setLoading(false)
    }
  }, [dataset])

  const handleShowCoverageMap = useCallback(async () => {
    if (!dataset) return
    setLoading(true)
    try {
      const gaps = await getGapAnalysis(dataset.id)
      setGapAnalysis(gaps)
      setShowCoverageMap(true)
    } catch (err) {
      console.error('Failed to get gaps:', err)
    } finally {
      setLoading(false)
    }
  }, [dataset])

  const handleExport = useCallback(async () => {
    if (!dataset) return
    try {
      const data = await exportDataset(dataset.id)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `dataset-v${dataset.version}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to export:', err)
    }
  }, [dataset])

  const handleImport = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.csv'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file || !dataset) return

      setLoading(true)
      try {
        const text = await file.text()
        let examples: Array<{ input: string; expected_output: string; feature_area?: string; label?: string }>

        if (file.name.endsWith('.csv')) {
          const lines = text.split('\n').filter(l => l.trim())
          const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
          examples = lines.slice(1).map(line => {
            const values = line.split(',')
            const obj: Record<string, string> = {}
            headers.forEach((h, i) => { obj[h] = values[i]?.trim() || '' })
            return {
              input: obj.input || obj.question || obj.scenario || '',
              expected_output: obj.expected_output || obj.output || obj.answer || '',
              feature_area: obj.feature_area || 'unassigned',
              label: obj.label,
            }
          })
        } else {
          const parsed = JSON.parse(text)
          examples = Array.isArray(parsed) ? parsed : parsed.examples || []
        }

        const { importExamples } = await import('./api')
        await importExamples(dataset.id, examples)
        const fullDs = await getDataset(dataset.session_id)
        setDataset(fullDs)
      } catch (err) {
        console.error('Failed to import:', err)
      } finally {
        setLoading(false)
      }
    }
    input.click()
  }, [dataset])

  // --- Render ---

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Tab bar */}
      <div className="h-11 border-b border-border bg-surface-raised flex items-center justify-between px-2 flex-shrink-0">
        <div className="flex items-center gap-1">
          <TabButton
            label="Goals"
            active={activeTab === 'goals'}
            onClick={() => setActiveTab('goals')}
            badge={nonEmptyGoals.length > 0 ? `${nonEmptyGoals.length}` : undefined}
          />
          <TabButton
            label="Users"
            active={activeTab === 'users'}
            onClick={() => setActiveTab('users')}
            disabled={!usersAvailable}
          />
          <TabButton
            label="Charter"
            active={activeTab === 'charter'}
            onClick={() => setActiveTab('charter')}
            disabled={!charterAvailable}
            badge={suggestions.length > 0 ? `+${suggestions.length}` : undefined}
          />
          <TabButton
            label="Examples"
            active={activeTab === 'examples'}
            onClick={() => setActiveTab('examples')}
            disabled={!examplesAvailable}
            badge={dataset ? `${dataset.examples?.length || 0}` : undefined}
          />
        </div>
        <div className="flex items-center gap-1">
          {sessionId && (
            <button
              onClick={() => setShowAssistant(!showAssistant)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                showAssistant
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              AI Assist
            </button>
          )}
          <button
            onClick={() => setShowSettings(true)}
            className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex min-h-0">
        {/* Tab content */}
        <div className="flex-1 min-w-0 flex flex-col">
          {activeTab === 'goals' && (
            <GoalsPanel
              goals={goals}
              onGoalsChange={handleGoalsChange}
              onGoalCommit={handleGoalCommit}
              goalSuggestions={goalSuggestions}
              onAcceptGoalSuggestion={handleAcceptGoalSuggestion}
              onDismissGoalSuggestion={handleDismissGoalSuggestion}
              suggestionsLoading={goalSuggestionsLoading}
              onDefineUsers={() => setActiveTab('users')}
            />
          )}

          {activeTab === 'users' && (
            <UsersPanel
              storyGroups={storyGroups}
              onStoryGroupsChange={setStoryGroups}
              suggestedStories={suggestedStories}
              onAcceptStory={handleAcceptStory}
              onDismissStory={handleDismissStory}
              onBackToGoals={() => setActiveTab('goals')}
              onGenerate={handleSubmitIntake}
              canGenerate={nonEmptyGoals.length > 0}
              loading={loading}
            />
          )}

          {activeTab === 'charter' && (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="flex-1 min-h-0 flex justify-center overflow-y-auto">
                <div className="w-full max-w-2xl">
                  <CharterPanel
                    charter={state.charter}
                    validation={state.validation}
                    activeCriteria={activeCriteria}
                    onEditCriterion={handleEditCriterion}
                    onAddCriterion={handleAddCriterion}
                    onEditAlignment={handleEditAlignment}
                    onEditTask={handleEditTask}
                    suggestions={suggestions}
                    onAcceptSuggestion={handleAcceptSuggestion}
                    onDismissSuggestion={handleDismissSuggestion}
                    onGenerate={handleSubmitIntake}
                    onRegenerate={handleSubmitIntake}
                    onValidate={handleValidate}
                    onSuggest={handleSuggest}
                    loading={loading}
                    hasSession={!!sessionId}
                    canGenerate={nonEmptyGoals.length > 0}
                    inputChanged={inputChanged}
                    onHeaderClick={() => {}}
                    isFocused={true}
                    isCompact={false}
                  />
                </div>
              </div>
              {hasCharter && !dataset && (
                <div className="p-4 border-t border-border bg-surface-raised flex justify-center">
                  <button
                    onClick={handleStartDataset}
                    disabled={loading}
                    className="px-8 py-2.5 bg-success text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
                  >
                    {loading ? 'Starting...' : 'Finalize & start dataset'}
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === 'examples' && dataset && (
            <div className="flex-1 min-h-0 flex flex-col">
              <ExampleReview
                examples={dataset.examples || []}
                charter={state.charter}
                loading={loading}
                onUpdateExample={handleUpdateExample}
                onDeleteExample={handleDeleteExample}
                onImport={handleImport}
                onSynthesize={handleSynthesize}
                onAutoReview={handleAutoReview}
                onExport={handleExport}
                onShowCoverageMap={handleShowCoverageMap}
                onHeaderClick={() => {}}
                isFocused={true}
              />
            </div>
          )}
        </div>

        {/* Assistant drawer */}
        {showAssistant && (
          <div className="w-96 flex-shrink-0 border-l border-border bg-surface flex flex-col">
            <div className="h-11 px-3 border-b border-border flex items-center justify-between flex-shrink-0">
              <span className="text-xs font-medium text-foreground">AI Assistant</span>
              <button
                onClick={() => setShowAssistant(false)}
                className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <ConversationPanel
              messages={messages}
              status={status}
              validation={state.validation}
              loading={loading}
              onSend={handleSend}
              onProceed={() => {}}
              onKeepRefining={() => {}}
              actionSuggestions={actionSuggestions}
              onActionSuggestion={(action) => {
                executeAgentAction({ action })
              }}
            />
          </div>
        )}
      </div>

      {/* Coverage map overlay */}
      {showCoverageMap && gapAnalysis && (
        <CoverageMap
          gaps={gapAnalysis}
          onClose={() => setShowCoverageMap(false)}
        />
      )}

      {/* Settings overlay */}
      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}

function TabButton({ label, active, onClick, disabled, badge }: {
  label: string
  active: boolean
  onClick: () => void
  disabled?: boolean
  badge?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
        active
          ? 'bg-accent text-accent-foreground'
          : disabled
            ? 'text-muted-foreground/40 cursor-not-allowed'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
      }`}
    >
      {label}
      {badge && (
        <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] ${
          active ? 'bg-accent-foreground/20' : 'bg-muted text-muted-foreground'
        }`}>
          {badge}
        </span>
      )}
    </button>
  )
}
