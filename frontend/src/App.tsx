import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import type { Message, SessionState, AgentStatus, StoryGroup, Suggestion, SuggestedStory, Dataset, Example, GapAnalysis } from './types'
import {
  createSession, getSession, sendMessage, proceedToReview, patchCharter, finalizeCharter,
  createDataset, getDataset, synthesizeExamples, updateExample as apiUpdateExample,
  deleteExample as apiDeleteExample, autoReviewExamples, getGapAnalysis, exportDataset,
  datasetChat,
} from './api'
import InputColumn from './components/InputColumn'
import CharterPanel from './components/CharterPanel'
import ConversationPanel from './components/ConversationPanel'
import ExampleReview from './components/ExampleReview'
import CoverageMap from './components/CoverageMap'
import SettingsPanel from './components/SettingsPanel'

type FocusedColumn = 'input' | 'charter' | 'examples'

const EMPTY_STATE: SessionState = {
  session_id: '',
  input: { business_goals: null, user_stories: null, conversation_history: [] },
  charter: {
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
  // --- Shared state ---
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [state, setState] = useState<SessionState>(EMPTY_STATE)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  // Track open columns: [mostRecent, secondMostRecent] - always show 2 columns
  const [openColumns, setOpenColumns] = useState<[FocusedColumn, FocusedColumn]>(['input', 'charter'])

  // Select a column - opens it and closes the least recently used
  const selectColumn = useCallback((column: FocusedColumn) => {
    setOpenColumns(prev => {
      if (prev[0] === column) return prev // Already most recent
      if (prev[1] === column) return [column, prev[0]] // Swap order
      return [column, prev[0]] // New column, drop the oldest
    })
  }, [])

  // Check if a column is currently open
  const isColumnOpen = useCallback((column: FocusedColumn) => {
    return openColumns.includes(column)
  }, [openColumns])

  // --- UI animation states ---
  const [showCharter, setShowCharter] = useState(false)
  const [showAgent, setShowAgent] = useState(false)

  // --- Charter phase state ---
  const [activeCriteria, setActiveCriteria] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestedStories, setSuggestedStories] = useState<SuggestedStory[]>([])
  const [goals, setGoals] = useState('')
  const [storyGroups, setStoryGroups] = useState<StoryGroup[]>([
    { role: '', stories: [{ what: '', why: '' }] },
  ])

  // --- Input change tracking for regenerate button ---
  const [savedInput, setSavedInput] = useState<{ goals: string; stories: string } | null>(null)

  // --- Debounced background messages ---
  const pendingChangesRef = useRef<string[]>([])
  const debounceTimerRef = useRef<number | null>(null)

  // --- Dataset phase state ---
  const [dataset, setDataset] = useState<Dataset | null>(null)
  const [gapAnalysis, setGapAnalysis] = useState<GapAnalysis | null>(null)
  const [showCoverageMap, setShowCoverageMap] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const status: AgentStatus = state.agent_status
  const hasCharter = !!(state.charter.coverage.criteria.length || state.charter.alignment.length)

  // Check if input has changed since charter was generated
  const inputChanged = useMemo(() => {
    if (!savedInput) return false
    const currentStories = formatStoryGroups(storyGroups)
    return goals.trim() !== savedInput.goals || currentStories !== savedInput.stories
  }, [savedInput, goals, storyGroups])

  // --- Charter phase handlers ---

  const handleSubmitIntake = useCallback(async () => {
    const storiesText = formatStoryGroups(storyGroups)
    if (!goals.trim() && !storiesText) return

    // Show charter column with loading state
    setShowCharter(true)
    selectColumn('charter')
    setLoading(true)

    try {
      if (!sessionId) {
        const res = await createSession({
          business_goals: goals.trim() || undefined,
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
        // Save input snapshot for regenerate button logic
        setSavedInput({ goals: goals.trim(), stories: storiesText })
        // Show agent after charter is loaded
        setTimeout(() => setShowAgent(true), 300)
      } else {
        const updateMsg = `I've updated my input.\n\nBusiness goals: ${goals.trim()}\n\nUser stories:\n${storiesText}\n\nPlease regenerate the document with this updated input.`
        const res = await sendMessage(sessionId, updateMsg, { regenerate: true })
        setMessages(prev => [
          ...prev,
          { role: 'user', content: '(Updated input)' },
          { role: 'assistant', content: res.message },
        ])
        setState(res.state)
        setSuggestions(res.suggestions || [])
        setSuggestedStories(res.suggested_stories || [])
        // Save input snapshot for regenerate button logic
        setSavedInput({ goals: goals.trim(), stories: storiesText })
      }
    } catch (err) {
      console.error('Failed:', err)
    } finally {
      setLoading(false)
    }
  }, [goals, storyGroups, sessionId])

  const handleSend = useCallback(async (message: string, { background }: { background?: boolean } = {}) => {
    if (!sessionId) return
    setMessages(prev => [...prev, { role: 'user', content: message }])
    if (!background) setLoading(true)
    try {
      if (dataset) {
        // Dataset phase - use dataset chat
        const res = await datasetChat(dataset.id, message)
        setMessages(prev => [...prev, { role: 'assistant', content: res.message }])
        setState(res.state)
      } else {
        // Charter phase
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
      if (!background) setLoading(false)
    }
  }, [sessionId, dataset])

  // Debounced background send - batches multiple changes together
  const sendDebouncedBackground = useCallback((change: string) => {
    pendingChangesRef.current.push(change)

    // Clear existing timer
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current)
    }

    // Set new timer - send all pending changes after 1 second of no activity
    debounceTimerRef.current = window.setTimeout(async () => {
      const changes = pendingChangesRef.current
      pendingChangesRef.current = []
      debounceTimerRef.current = null

      if (changes.length === 0 || !sessionId) return

      // Combine all changes into one message
      const combinedMessage = changes.length === 1
        ? changes[0]
        : `Multiple changes:\n${changes.map(c => `- ${c}`).join('\n')}`

      try {
        if (dataset) {
          const res = await datasetChat(dataset.id, combinedMessage)
          setMessages(prev => [...prev, { role: 'assistant', content: res.message }])
          setState(res.state)
        } else {
          const res = await sendMessage(sessionId, combinedMessage)
          setMessages(prev => [...prev, { role: 'assistant', content: res.message }])
          setState(res.state)
          setActiveCriteria([])
          setSuggestions(res.suggestions || [])
          setSuggestedStories(res.suggested_stories || [])
        }
      } catch (err) {
        console.error('Failed to send batched message:', err)
      }
    }, 1000)
  }, [sessionId, dataset])

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  const handleProceed = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      const res = await proceedToReview(sessionId)
      setState(res.state)
    } catch (err) {
      console.error('Failed to proceed:', err)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  const handleKeepRefining = useCallback(async () => {
    if (!sessionId) return
    await handleSend("Let's keep refining.")
  }, [sessionId, handleSend])

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

  // Use a ref to track latest charter state for rapid updates
  const charterRef = useRef(state.charter)
  useEffect(() => {
    charterRef.current = state.charter
  }, [state.charter])

  const handleAcceptSuggestion = useCallback(async (suggestion: Suggestion) => {
    if (!sessionId) return

    // Use ref to get latest charter state
    const currentCharter = charterRef.current

    // Optimistically update the UI immediately
    if (suggestion.section === 'alignment' && suggestion.good && suggestion.bad) {
      const newEntry = {
        feature_area: suggestion.text,
        good: suggestion.good,
        bad: suggestion.bad,
        status: 'pending' as const,
      }
      const newAlignment = [...currentCharter.alignment, newEntry]
      // Update ref immediately for subsequent rapid calls
      charterRef.current = { ...charterRef.current, alignment: newAlignment }
      setState(prev => ({
        ...prev,
        charter: { ...prev.charter, alignment: newAlignment }
      }))
      // Patch in background
      patchCharter(sessionId, { alignment: newAlignment }).catch(err => {
        console.error('Failed to accept suggestion:', err)
      })
    } else {
      const dim = suggestion.section as 'coverage' | 'balance' | 'rot'
      const newCriteria = [...currentCharter[dim].criteria, suggestion.text]
      const newDim = { ...currentCharter[dim], criteria: newCriteria }
      // Update ref immediately for subsequent rapid calls
      charterRef.current = { ...charterRef.current, [dim]: newDim }
      setState(prev => ({
        ...prev,
        charter: { ...prev.charter, [dim]: newDim }
      }))
      // Patch in background
      patchCharter(sessionId, { [dim]: newDim }).catch(err => {
        console.error('Failed to accept suggestion:', err)
      })
    }

    setSuggestions(prev => prev.filter(s => s !== suggestion))

    const label = suggestion.section === 'alignment' ? suggestion.text : `"${suggestion.text}"`
    sendDebouncedBackground(`${label} added to ${suggestion.section}.`)
  }, [sessionId, sendDebouncedBackground])

  const handleDismissSuggestion = useCallback((suggestion: Suggestion) => {
    setSuggestions(prev => prev.filter(s => s !== suggestion))
    // Dismissals are tracked but don't need to be sent to AI unless you want feedback
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

    const storyText = `As a ${story.who}, I want to ${story.what}${story.why ? ` in order to ${story.why}` : ''}`
    sendDebouncedBackground(`New user story added: ${storyText}`)
  }, [sendDebouncedBackground])

  const handleDismissStory = useCallback((story: SuggestedStory) => {
    setSuggestedStories(prev => prev.filter(s => s !== story))
  }, [])

  // --- Phase transition: charter → dataset ---

  const handleStartDataset = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      // Finalize charter first
      await finalizeCharter(sessionId)

      // Create dataset
      await createDataset(sessionId)

      // Reload with examples
      const fullDs = await getDataset(sessionId)
      setDataset(fullDs)
      selectColumn('examples')

      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: "Charter finalized. Let's build the dataset — you can import existing data or I can generate examples from the charter." },
      ])
    } catch (err) {
      console.error('Failed to start dataset:', err)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  // --- Dataset phase handlers ---

  const handleSynthesize = useCallback(async () => {
    if (!dataset) {
      console.error('No dataset available')
      return
    }
    setLoading(true)
    try {
      const res = await synthesizeExamples(dataset.id)
      const fullDs = await getDataset(dataset.session_id)
      setDataset(fullDs)
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: `Generated ${res.generated} examples. Review them and approve, edit, or reject.` },
      ])
    } catch (err) {
      console.error('Failed to synthesize:', err)
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: 'Failed to generate examples. Please check the backend logs.' },
      ])
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
      const res = await autoReviewExamples(dataset.id)
      const fullDs = await getDataset(dataset.session_id)
      setDataset(fullDs)
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: `Reviewed ${res.reviewed} examples. Check the judge verdicts and approve or reject.` },
      ])
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
          // Simple CSV parsing
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
        const res = await importExamples(dataset.id, examples)
        const fullDs = await getDataset(dataset.session_id)
        setDataset(fullDs)
        setMessages(prev => [
          ...prev,
          { role: 'assistant', content: `Imported ${res.imported} examples. They're all pending review.` },
        ])
      } catch (err) {
        console.error('Failed to import:', err)
      } finally {
        setLoading(false)
      }
    }
    input.click()
  }, [dataset])

  // --- Render ---

  // Initial state: only input column visible
  const isInitialState = !showCharter

  // Collapsed column component
  const CollapsedColumn = ({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) => (
    <div
      onClick={onClick}
      className="w-12 flex-shrink-0 border-r border-border bg-surface hover:bg-muted/50 cursor-pointer flex flex-col items-center pt-4 gap-1"
      title={label}
    >
      {icon}
      <span className="text-[10px] text-muted-foreground writing-mode-vertical" style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}>
        {label}
      </span>
    </div>
  )

  // Icons for collapsed columns
  const InputIcon = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )

  const CharterIcon = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  )

  const ExamplesIcon = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )

  return (
    <div className="h-screen flex bg-background">
      {/* Column 1: Input */}
      {isInitialState ? (
        // Initial state: Input takes full width, content centered
        <div className="flex-1 min-w-0 bg-surface flex justify-center">
          <div className="w-full max-w-xl">
            <InputColumn
              goals={goals}
              storyGroups={storyGroups}
              onGoalsChange={setGoals}
              onStoryGroupsChange={setStoryGroups}
              suggestedStories={suggestedStories}
              onAcceptStory={handleAcceptStory}
              onDismissStory={handleDismissStory}
              onHeaderClick={() => {}}
              isFocused={true}
              onGenerate={handleSubmitIntake}
              canGenerate={!!goals.trim()}
              loading={loading}
              showGenerateButton={true}
            />
          </div>
        </div>
      ) : isColumnOpen('input') ? (
        // Input expanded
        <div className="flex-1 min-w-0 border-r border-border bg-surface">
          <InputColumn
            goals={goals}
            storyGroups={storyGroups}
            onGoalsChange={setGoals}
            onStoryGroupsChange={setStoryGroups}
            suggestedStories={suggestedStories}
            onAcceptStory={handleAcceptStory}
            onDismissStory={handleDismissStory}
            onHeaderClick={() => selectColumn('input')}
            isFocused={openColumns[0] === 'input'}
            onGenerate={handleSubmitIntake}
            canGenerate={!!goals.trim()}
            loading={loading}
            showGenerateButton={false}
          />
        </div>
      ) : (
        // Input collapsed
        <CollapsedColumn icon={InputIcon} label="Input" onClick={() => selectColumn('input')} />
      )}

      {/* Column 2: Charter */}
      {showCharter && (
        isColumnOpen('charter') ? (
          // Charter expanded
          <div className="flex-1 min-w-0 flex flex-col border-r border-border">
            <CharterPanel
              charter={state.charter}
              validation={state.validation}
              activeCriteria={activeCriteria}
              onEditCriterion={handleEditCriterion}
              onEditAlignment={handleEditAlignment}
              suggestions={suggestions}
              onAcceptSuggestion={handleAcceptSuggestion}
              onDismissSuggestion={handleDismissSuggestion}
              onGenerate={handleSubmitIntake}
              onRegenerate={handleSubmitIntake}
              loading={loading}
              hasSession={!!sessionId}
              canGenerate={!!goals.trim()}
              inputChanged={inputChanged}
              onHeaderClick={() => selectColumn('charter')}
              isFocused={openColumns[0] === 'charter'}
              isCompact={false}
            />
            {hasCharter && !dataset && (
              <div className="p-4 border-t border-border bg-surface-raised">
                <button
                  onClick={handleStartDataset}
                  disabled={loading}
                  className="w-full py-2.5 bg-success text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {loading ? 'Starting...' : 'Finalize & start dataset'}
                </button>
              </div>
            )}
          </div>
        ) : (
          // Charter collapsed
          <CollapsedColumn icon={CharterIcon} label="Charter" onClick={() => selectColumn('charter')} />
        )
      )}

      {/* Column 3: Examples */}
      {dataset && (
        isColumnOpen('examples') ? (
          // Examples expanded
          <div className="flex-1 min-w-0 flex flex-col border-r border-border">
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
              onHeaderClick={() => selectColumn('examples')}
              isFocused={openColumns[0] === 'examples'}
            />
          </div>
        ) : (
          // Examples collapsed
          <CollapsedColumn icon={ExamplesIcon} label="Examples" onClick={() => selectColumn('examples')} />
        )
      )}

      {/* Agent sidebar - appears after charter is generated */}
      {showAgent && (
        <div className="w-96 flex-shrink-0 bg-agent relative">
          <ConversationPanel
            messages={messages}
            status={status}
            validation={state.validation}
            loading={loading}
            onSend={handleSend}
            onProceed={handleProceed}
            onKeepRefining={handleKeepRefining}
          />
          {/* Settings gear icon */}
          <button
            onClick={() => setShowSettings(true)}
            className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            title="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6.5 1.5h3l.5 2 1.5.7 1.8-1 2.1 2.1-1 1.8.7 1.5 2 .5v3l-2 .5-0.7 1.5 1 1.8-2.1 2.1-1.8-1-1.5.7-.5 2h-3l-.5-2-1.5-.7-1.8 1-2.1-2.1 1-1.8-.7-1.5-2-.5v-3l2-.5.7-1.5-1-1.8 2.1-2.1 1.8 1 1.5-.7z" />
              <circle cx="8" cy="8" r="2" />
            </svg>
          </button>
        </div>
      )}

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
