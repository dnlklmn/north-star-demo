import { useState, useCallback, useRef, useEffect } from 'react'
import type { Message, SessionState, AgentStatus, Screen, Phase, Suggestion, SuggestedStory, ExtractedStory, Dataset, Example, GapAnalysis } from './types'
import {
  createSession, getSession, sendMessage, advancePhase, reevaluate, proceedToReview, patchCharter, patchGoals, patchUsers, patchStories, finalizeCharter,
  createDataset, getDataset, synthesizeExamples, updateExample as apiUpdateExample,
  deleteExample as apiDeleteExample, autoReviewExamples, getGapAnalysis, exportDataset,
  datasetChat,
} from './api'
import ProgressBar from './components/ProgressBar'
import DiscoveryScreen from './components/DiscoveryScreen'
import CharterPanel from './components/CharterPanel'
import ConversationPanel from './components/ConversationPanel'
import ExampleReview from './components/ExampleReview'
import CoverageMap from './components/CoverageMap'
import SettingsPanel from './components/SettingsPanel'

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
  agent_status: 'discovery',
  extracted_goals: [],
  extracted_users: [],
  extracted_stories: [],
  discovery_rounds: 0,
}

export default function App() {
  // --- Core state ---
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [state, setState] = useState<SessionState>(EMPTY_STATE)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [advancing, setAdvancing] = useState(false)

  // --- Screen & phase ---
  const [currentScreen, setCurrentScreen] = useState<Screen>('goals')
  const [phase, setPhase] = useState<Phase>('goals')

  // --- Extracted data (from discovery) ---
  const [extractedGoals, setExtractedGoals] = useState<string[]>([])
  const [extractedUsers, setExtractedUsers] = useState<string[]>([])
  const [extractedStories, setExtractedStories] = useState<ExtractedStory[]>([])

  // --- Charter phase state ---
  const [activeCriteria, setActiveCriteria] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [, setSuggestedStories] = useState<SuggestedStory[]>([])

  // --- Discovery clickable options ---
  const [suggestedGoals, setSuggestedGoals] = useState<string[]>([])
  const [suggestedUsers, setSuggestedUsers] = useState<string[]>([])
  const [suggestedStoryOptions, setSuggestedStoryOptions] = useState<ExtractedStory[]>([])

  // --- Chat input control (for prefilling from screen clicks) ---
  const [chatInput, setChatInput] = useState('')

  // --- Debounced background messages ---
  const pendingChangesRef = useRef<string[]>([])
  const debounceTimerRef = useRef<number | null>(null)

  // --- Debounced reevaluation after pill clicks ---
  const reevalTimerRef = useRef<number | null>(null)

  // --- Dataset phase state ---
  const [dataset, setDataset] = useState<Dataset | null>(null)
  const [actionSuggestions, setActionSuggestions] = useState<Array<{ action: string; label: string; reason: string }>>([])
  const [gapAnalysis, setGapAnalysis] = useState<GapAnalysis | null>(null)
  const [showCoverageMap, setShowCoverageMap] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const status: AgentStatus = state.agent_status
  const hasCharter = !!(state.charter.coverage.criteria.length || state.charter.alignment.length)

  // --- Initialize session on mount ---
  const sessionInitRef = useRef(false)
  useEffect(() => {
    if (sessionInitRef.current) return
    sessionInitRef.current = true

    const initSession = async () => {
      setLoading(true)
      try {
        const res = await createSession()
        setSessionId(res.session_id)
        if (res.message) {
          setMessages([{ role: 'assistant', content: res.message }])
        }
        const session = await getSession(res.session_id)
        setState(session.state as SessionState)
        setPhase(res.phase as Phase)
        setExtractedGoals(res.extracted_goals || [])
        setExtractedUsers(res.extracted_users || [])
        setExtractedStories(res.extracted_stories || [])
        setSuggestions(res.suggestions || [])
        setSuggestedStories(res.suggested_stories || [])
        setSuggestedGoals(res.suggested_goals || [])
        setSuggestedUsers(res.suggested_users || [])
        setSuggestedStoryOptions(res.suggested_stories_options || [])
      } catch (err) {
        console.error('Failed to init session:', err)
      } finally {
        setLoading(false)
      }
    }

    initSession()
  }, [])

  // --- Phase transition: auto-navigate forward when phase advances ---
  const prevPhaseRef = useRef(phase)
  useEffect(() => {
    if (phase !== prevPhaseRef.current) {
      prevPhaseRef.current = phase
      // Only auto-navigate forward when the phase advances, not on every render
      setCurrentScreen(phase as Screen)
    }
  }, [phase])

  // --- Handle screen navigation ---
  const handleNavigate = useCallback((screen: Screen) => {
    // Can navigate back freely, forward only if phase permits
    const order: Screen[] = ['goals', 'users', 'stories', 'charter', 'dataset']
    const phaseIndex = order.indexOf(phase)
    const screenIndex = order.indexOf(screen)
    if (screenIndex <= phaseIndex) {
      setCurrentScreen(screen)
    }
  }, [phase])

  // --- Handle screen element clicks → prefill chat ---
  const handleDiscoveryItemClick = useCallback((type: 'goal' | 'user' | 'story', index: number) => {
    if (type === 'goal' && extractedGoals[index]) {
      setChatInput(`About the goal "${extractedGoals[index]}", `)
    } else if (type === 'user' && extractedUsers[index]) {
      setChatInput(`About the "${extractedUsers[index]}" user, `)
    } else if (type === 'story' && extractedStories[index]) {
      const s = extractedStories[index]
      setChatInput(`About the "${s.who}" user story, `)
    }
  }, [extractedGoals, extractedUsers, extractedStories])

  const handleCharterSectionClick = useCallback((section: string) => {
    const sectionLabels: Record<string, string> = {
      coverage: 'For coverage, I think we should also consider ',
      balance: 'For the weighting, ',
      alignment: 'For what good output looks like, ',
      rot: 'This should be updated when ',
    }
    setChatInput(sectionLabels[section] || `About ${section}, `)
  }, [])

  // --- Debounced reevaluation: after pill clicks, wait 3s then ask agent to re-evaluate ---
  const triggerReevaluation = useCallback(() => {
    if (!sessionId) return
    if (reevalTimerRef.current) {
      window.clearTimeout(reevalTimerRef.current)
    }
    reevalTimerRef.current = window.setTimeout(async () => {
      reevalTimerRef.current = null
      setLoading(true)
      try {
        const res = await reevaluate(sessionId)
        const willAutoAdvance = !!(res.ready_for_users || res.ready_for_stories)
        // Skip intermediate message if auto-advancing — the advance response replaces it
        if (!willAutoAdvance) {
          setMessages(prev => [...prev, { role: 'assistant', content: res.message }])
        }
        setState(res.state)
        setSuggestedGoals(res.suggested_goals || [])
        setSuggestedUsers(res.suggested_users || [])
        setSuggestedStoryOptions(res.suggested_stories_options || [])
        setSuggestions(res.suggestions || [])
        if (res.extracted_goals?.length) setExtractedGoals(res.extracted_goals)
        if (res.extracted_users?.length) setExtractedUsers(res.extracted_users)
        if (res.extracted_stories?.length) setExtractedStories(res.extracted_stories)
        if (res.phase && res.phase !== phase) setPhase(res.phase as Phase)
        if (willAutoAdvance) {
          await handleAdvancePhase()
        }
      } catch (err) {
        console.error('Failed to reevaluate:', err)
      } finally {
        setLoading(false)
      }
    }, 3000)
  }, [sessionId, phase])

  // --- Handle clicking a suggested goal/user/story option (adds it immediately, debounced reevaluation) ---
  const handleAcceptSuggestedGoal = useCallback(async (goal: string) => {
    if (!sessionId) return
    const updated = [...extractedGoals, goal]
    setExtractedGoals(updated)
    setSuggestedGoals(prev => prev.filter(g => g !== goal))
    try {
      await patchGoals(sessionId, updated)
    } catch (err) {
      console.error('Failed to add suggested goal:', err)
    }
    triggerReevaluation()
  }, [sessionId, extractedGoals, triggerReevaluation])

  const handleAcceptSuggestedUser = useCallback(async (user: string) => {
    if (!sessionId) return
    const updated = [...extractedUsers, user]
    setExtractedUsers(updated)
    setSuggestedUsers(prev => prev.filter(u => u !== user))
    try {
      await patchUsers(sessionId, updated)
    } catch (err) {
      console.error('Failed to add suggested user:', err)
    }
    triggerReevaluation()
  }, [sessionId, extractedUsers, triggerReevaluation])

  const handleAcceptSuggestedStory = useCallback(async (story: ExtractedStory) => {
    if (!sessionId) return
    const updated = [...extractedStories, story]
    setExtractedStories(updated)
    setSuggestedStoryOptions(prev => prev.filter(s => s !== story))
    try {
      await patchStories(sessionId, updated)
    } catch (err) {
      console.error('Failed to add suggested story:', err)
    }
    triggerReevaluation()
  }, [sessionId, extractedStories, triggerReevaluation])

  // --- Advance discovery phase (goals→stories or stories→charter) ---
  const handleAdvancePhase = useCallback(async () => {
    if (!sessionId) return
    setAdvancing(true)
    setLoading(true)
    try {
      const res = await advancePhase(sessionId)
      setMessages(prev => [...prev, { role: 'assistant', content: res.message }])
      setState(res.state)
      if (res.phase) {
        setPhase(res.phase as Phase)
      }
      if (res.extracted_goals?.length) {
        setExtractedGoals(res.extracted_goals)
      }
      if (res.extracted_users?.length) {
        setExtractedUsers(res.extracted_users)
      }
      if (res.extracted_stories?.length) {
        setExtractedStories(res.extracted_stories)
      }
      setSuggestions(res.suggestions || [])
      setSuggestedStories(res.suggested_stories || [])
      setSuggestedGoals(res.suggested_goals || [])
      setSuggestedUsers(res.suggested_users || [])
      setSuggestedStoryOptions(res.suggested_stories_options || [])
    } catch (err) {
      console.error('Failed to advance phase:', err)
    } finally {
      setAdvancing(false)
      setLoading(false)
    }
  }, [sessionId])

  // --- Execute agent action ---
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

  // --- Send message ---
  const handleSend = useCallback(async (message: string, { background }: { background?: boolean } = {}) => {
    if (!sessionId) return
    setMessages(prev => [...prev, { role: 'user', content: message }])
    if (!background) setLoading(true)
    try {
      if (dataset) {
        // Dataset phase
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
        // Discovery or charter phase
        const res = await sendMessage(sessionId, message)
        const willAutoAdvance = !!(res.ready_for_users || res.ready_for_stories)

        // Skip showing the intermediate response if we're about to auto-advance
        // (it's just a summary before the transition — the advance response replaces it)
        if (!willAutoAdvance) {
          setMessages(prev => [...prev, { role: 'assistant', content: res.message }])
        }
        setState(res.state)
        setActiveCriteria([])
        setSuggestions(res.suggestions || [])
        setSuggestedStories(res.suggested_stories || [])
        setSuggestedGoals(res.suggested_goals || [])
        setSuggestedUsers(res.suggested_users || [])
        setSuggestedStoryOptions(res.suggested_stories_options || [])

        // Update extracted data from response
        if (res.extracted_goals?.length) {
          setExtractedGoals(res.extracted_goals)
        }
        if (res.extracted_users?.length) {
          setExtractedUsers(res.extracted_users)
        }
        if (res.extracted_stories?.length) {
          setExtractedStories(res.extracted_stories)
        }

        // Phase transition
        if (res.phase && res.phase !== phase) {
          setPhase(res.phase as Phase)
        }

        // Auto-advance if agent signals readiness (goals→users or users→stories only, not stories→charter)
        if (willAutoAdvance) {
          const advRes = await advancePhase(sessionId)
          setMessages(prev => [...prev, { role: 'assistant', content: advRes.message }])
          setState(advRes.state)
          setSuggestedGoals(advRes.suggested_goals || [])
          setSuggestedUsers(advRes.suggested_users || [])
          setSuggestedStoryOptions(advRes.suggested_stories_options || [])
          if (advRes.extracted_goals?.length) setExtractedGoals(advRes.extracted_goals)
          if (advRes.extracted_users?.length) setExtractedUsers(advRes.extracted_users)
          if (advRes.extracted_stories?.length) setExtractedStories(advRes.extracted_stories)
          if (advRes.phase && advRes.phase !== phase) setPhase(advRes.phase as Phase)
        }
      }
    } catch (err) {
      console.error('Failed to send message:', err)
      setMessages(prev => [...prev, { role: 'assistant', content: 'Something went wrong. Please try again.' }])
    } finally {
      if (!background) setLoading(false)
    }
  }, [sessionId, dataset, executeAgentAction, phase])

  // --- Debounced background send ---
  const sendDebouncedBackground = useCallback((change: string) => {
    pendingChangesRef.current.push(change)
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = window.setTimeout(async () => {
      const changes = pendingChangesRef.current
      pendingChangesRef.current = []
      debounceTimerRef.current = null
      if (changes.length === 0 || !sessionId) return

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
    }, 3000)
  }, [sessionId, dataset])

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current)
      }
      if (reevalTimerRef.current) {
        window.clearTimeout(reevalTimerRef.current)
      }
    }
  }, [])

  // --- Charter phase handlers ---

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
    sendDebouncedBackground(`New ${dimension} criterion added: "${value}"`)
  }, [sessionId, sendDebouncedBackground])

  const handleAddAlignment = useCallback(async (entry: { feature_area: string; good: string; bad: string }) => {
    if (!sessionId) return
    const currentCharter = charterRef.current
    const newEntry = { ...entry, status: 'pending' as const }
    const newAlignment = [...currentCharter.alignment, newEntry]
    charterRef.current = { ...charterRef.current, alignment: newAlignment }
    setState(prev => ({
      ...prev,
      charter: { ...prev.charter, alignment: newAlignment }
    }))
    patchCharter(sessionId, { alignment: newAlignment }).catch(err => {
      console.error('Failed to add alignment:', err)
    })
    sendDebouncedBackground(`New alignment entry added: "${entry.feature_area}"`)
  }, [sessionId, sendDebouncedBackground])

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
    const label = suggestion.section === 'alignment' ? suggestion.text : `"${suggestion.text}"`
    sendDebouncedBackground(`${label} added to ${suggestion.section}.`)
  }, [sessionId, sendDebouncedBackground])

  const handleDismissSuggestion = useCallback((suggestion: Suggestion) => {
    setSuggestions(prev => prev.filter(s => s !== suggestion))
    const label = suggestion.section === 'alignment' ? suggestion.text : `"${suggestion.text}"`
    sendDebouncedBackground(`${label} dismissed from ${suggestion.section}.`)
  }, [sendDebouncedBackground])

  // --- Discovery screen edit handlers ---
  const handleEditGoal = useCallback(async (index: number, value: string) => {
    if (!sessionId) return
    const updated = [...extractedGoals]
    updated[index] = value
    setExtractedGoals(updated)
    try {
      await patchGoals(sessionId, updated)
    } catch (err) {
      console.error('Failed to patch goals:', err)
    }
  }, [sessionId, extractedGoals])

  const handleAddGoal = useCallback(async (value: string) => {
    if (!sessionId) return
    const updated = [...extractedGoals, value]
    setExtractedGoals(updated)
    try {
      await patchGoals(sessionId, updated)
    } catch (err) {
      console.error('Failed to patch goals:', err)
    }
  }, [sessionId, extractedGoals])

  const handleDeleteGoal = useCallback(async (index: number) => {
    if (!sessionId) return
    const updated = extractedGoals.filter((_, i) => i !== index)
    setExtractedGoals(updated)
    try {
      await patchGoals(sessionId, updated)
    } catch (err) {
      console.error('Failed to patch goals:', err)
    }
  }, [sessionId, extractedGoals])

  const handleEditUser = useCallback(async (index: number, value: string) => {
    if (!sessionId) return
    const updated = [...extractedUsers]
    updated[index] = value
    setExtractedUsers(updated)
    try {
      await patchUsers(sessionId, updated)
    } catch (err) {
      console.error('Failed to patch users:', err)
    }
  }, [sessionId, extractedUsers])

  const handleAddUser = useCallback(async (value: string) => {
    if (!sessionId) return
    const updated = [...extractedUsers, value]
    setExtractedUsers(updated)
    try {
      await patchUsers(sessionId, updated)
    } catch (err) {
      console.error('Failed to patch users:', err)
    }
  }, [sessionId, extractedUsers])

  const handleDeleteUser = useCallback(async (index: number) => {
    if (!sessionId) return
    const updated = extractedUsers.filter((_, i) => i !== index)
    setExtractedUsers(updated)
    try {
      await patchUsers(sessionId, updated)
    } catch (err) {
      console.error('Failed to patch users:', err)
    }
  }, [sessionId, extractedUsers])

  const handleEditStory = useCallback(async (index: number, story: ExtractedStory) => {
    if (!sessionId) return
    const updated = [...extractedStories]
    updated[index] = story
    setExtractedStories(updated)
    try {
      await patchStories(sessionId, updated)
    } catch (err) {
      console.error('Failed to patch stories:', err)
    }
  }, [sessionId, extractedStories])

  const handleAddStory = useCallback(async (story: ExtractedStory) => {
    if (!sessionId) return
    const updated = [...extractedStories, story]
    setExtractedStories(updated)
    try {
      await patchStories(sessionId, updated)
    } catch (err) {
      console.error('Failed to patch stories:', err)
    }
  }, [sessionId, extractedStories])

  const handleDeleteStory = useCallback(async (index: number) => {
    if (!sessionId) return
    const updated = extractedStories.filter((_, i) => i !== index)
    setExtractedStories(updated)
    try {
      await patchStories(sessionId, updated)
    } catch (err) {
      console.error('Failed to patch stories:', err)
    }
  }, [sessionId, extractedStories])

  // --- Phase transition: charter → dataset ---
  const handleStartDataset = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      await finalizeCharter(sessionId)
      await createDataset(sessionId)
      const fullDs = await getDataset(sessionId)
      setDataset(fullDs)
      setPhase('dataset')
      setCurrentScreen('dataset')
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
  const handleSynthesize = useCallback(async (count?: number) => {
    if (!dataset) return
    setLoading(true)
    try {
      const res = await synthesizeExamples(dataset.id, count ? { count_per_scenario: count } : undefined)
      const fullDs = await getDataset(dataset.session_id)
      setDataset(fullDs)
      setMessages(prev => [...prev, { role: 'assistant', content: `Generated ${res.generated} examples. Review them and approve, edit, or reject.` }])
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
      const res = await autoReviewExamples(dataset.id)
      const fullDs = await getDataset(dataset.session_id)
      setDataset(fullDs)
      setMessages(prev => [...prev, { role: 'assistant', content: `Reviewed ${res.reviewed} examples. Check the judge verdicts and approve or reject.` }])
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
        const res = await importExamples(dataset.id, examples)
        const fullDs = await getDataset(dataset.session_id)
        setDataset(fullDs)
        setMessages(prev => [...prev, { role: 'assistant', content: `Imported ${res.imported} examples. They're all pending review.` }])
      } catch (err) {
        console.error('Failed to import:', err)
      } finally {
        setLoading(false)
      }
    }
    input.click()
  }, [dataset])

  // --- Chat input placeholder based on screen ---
  const chatPlaceholder = currentScreen === 'goals'
    ? 'Tell me about your AI feature...'
    : currentScreen === 'users'
      ? 'Tell me about who uses this...'
      : currentScreen === 'stories'
        ? 'What do they need to accomplish?'
        : currentScreen === 'charter'
          ? 'Which section would you like to refine?'
          : 'How can I help with the dataset?'

  // --- Render ---
  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Progress bar */}
      <ProgressBar
        currentScreen={currentScreen}
        phase={phase}
        onNavigate={handleNavigate}
        goalCount={extractedGoals.length || undefined}
        userCount={extractedUsers.length || undefined}
        storyCount={extractedStories.length || undefined}
      />

      {/* Main content area */}
      <div className="flex-1 flex min-h-0">
        {/* Screen content */}
        <div className="flex-1 min-w-0 flex flex-col">
          {(currentScreen === 'goals' || currentScreen === 'users' || currentScreen === 'stories') && (
            <DiscoveryScreen
              phase={phase}
              goals={extractedGoals}
              users={extractedUsers}
              stories={extractedStories}
              onEditGoal={handleEditGoal}
              onAddGoal={handleAddGoal}
              onDeleteGoal={handleDeleteGoal}
              onEditUser={handleEditUser}
              onAddUser={handleAddUser}
              onDeleteUser={handleDeleteUser}
              onEditStory={handleEditStory}
              onAddStory={handleAddStory}
              onDeleteStory={handleDeleteStory}
              onItemClick={handleDiscoveryItemClick}
              onAdvancePhase={handleAdvancePhase}
              advancing={advancing}
            />
          )}

          {currentScreen === 'charter' && (
            <div className="flex-1 min-h-0 flex flex-col">
              <CharterPanel
                charter={state.charter}
                validation={state.validation}
                activeCriteria={activeCriteria}
                onEditCriterion={handleEditCriterion}
                onAddCriterion={handleAddCriterion}
                onEditAlignment={handleEditAlignment}
                onAddAlignment={handleAddAlignment}
                onEditTask={handleEditTask}
                suggestions={suggestions}
                onAcceptSuggestion={handleAcceptSuggestion}
                onDismissSuggestion={handleDismissSuggestion}
                loading={loading}
                hasSession={!!sessionId}
                onSectionClick={handleCharterSectionClick}
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
          )}

          {currentScreen === 'dataset' && dataset && (
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
              isFocused={currentScreen === 'dataset'}
            />
          )}
        </div>

        {/* Agent sidebar — always visible */}
        <div className="w-96 flex-shrink-0 bg-agent relative border-l border-border">
          <ConversationPanel
            messages={messages}
            status={status}
            validation={state.validation}
            loading={loading}
            onSend={handleSend}
            onProceed={handleProceed}
            onKeepRefining={handleKeepRefining}
            actionSuggestions={actionSuggestions}
            onActionSuggestion={(action) => {
              executeAgentAction({ action })
            }}
            chatInput={chatInput}
            onChatInputChange={setChatInput}
            placeholder={chatPlaceholder}
            phase={phase}
            hasCharter={hasCharter}
            isInit={!sessionId}
            suggestedGoals={suggestedGoals}
            suggestedUsers={suggestedUsers}
            suggestedStoryOptions={suggestedStoryOptions}
            onAcceptSuggestedGoal={handleAcceptSuggestedGoal}
            onAcceptSuggestedUser={handleAcceptSuggestedUser}
            onAcceptSuggestedStory={handleAcceptSuggestedStory}
          />
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
      </div>

      {/* Coverage map overlay */}
      {showCoverageMap && gapAnalysis && (
        <CoverageMap
          gaps={gapAnalysis}
          onClose={() => setShowCoverageMap(false)}
          loading={loading}
          onFillGaps={async () => {
            if (!dataset) return
            setShowCoverageMap(false)
            await handleSynthesize(2)
          }}
        />
      )}

      {/* Settings overlay */}
      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}
