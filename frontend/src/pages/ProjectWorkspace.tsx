import { useState, useCallback, useRef, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { MessageSquare, Settings, X, ShieldCheck, ArrowRight, ArrowLeft, Sparkles, Upload, Loader2 } from 'lucide-react'
import type { Message, SessionState, AgentStatus, StoryGroup, Suggestion, SuggestedStory, Dataset, Example, GapAnalysis, ScorerDef } from '../types'
import {
  createSession, getSession, sendMessage, patchCharter, finalizeCharter,
  validateCharter, suggestForCharter, suggestGoals, evaluateGoals, suggestStories,
  createDataset, getDataset, synthesizeExamples, updateExample as apiUpdateExample,
  deleteExample as apiDeleteExample, autoReviewExamples, getGapAnalysis, exportDataset,
  datasetChat, updateSessionName, updateSessionInput, saveScorers,
} from '../api'
import GoalsPanel from '../components/GoalsPanel'
import UsersPanel from '../components/UsersPanel'
import CharterPanel from '../components/CharterPanel'
import ScorersPanel from '../components/ScorersPanel'
import EvaluatePanel from '../components/EvaluatePanel'
import ConversationPanel from '../components/ConversationPanel'
import ExampleReview from '../components/ExampleReview'
import CoverageMap from '../components/CoverageMap'
import SettingsPanel from '../components/SettingsPanel'

type ActiveTab = 'goals' | 'users' | 'charter' | 'dataset' | 'scorers' | 'evaluate'

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

export default function ProjectWorkspace() {
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()

  // --- Navigation ---
  const [activeTab, setActiveTab] = useState<ActiveTab>('goals')
  const [showAssistant, setShowAssistant] = useState(false)

  // --- Project metadata ---
  const [projectName, setProjectName] = useState('Untitled project')
  const [editingName, setEditingName] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // --- Shared state ---
  const [sessionId, setSessionId] = useState<string | null>(urlSessionId || null)
  const [state, setState] = useState<SessionState>(EMPTY_STATE)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [hydrating, setHydrating] = useState(!!urlSessionId)

  // --- Goals state ---
  const [goals, setGoals] = useState<string[]>([''])
  const [goalSuggestions, setGoalSuggestions] = useState<string[]>([])
  const [goalSuggestionsLoading, setGoalSuggestionsLoading] = useState(false)
  const [goalFeedback, setGoalFeedback] = useState<Array<{ goal: string; issue: string | null; suggestion: string | null }>>([])
  const [goalFeedbackLoading, setGoalFeedbackLoading] = useState(false)

  // --- Story suggestion state ---
  const [storySuggestionsLoading, setStorySuggestionsLoading] = useState(false)

  // --- Charter phase state ---
  const [activeCriteria, setActiveCriteria] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestedStories, setSuggestedStories] = useState<SuggestedStory[]>([])
  const [storyGroups, setStoryGroups] = useState<StoryGroup[]>([
    { role: '', stories: [{ what: '', why: '' }] },
  ])

  // --- Input change tracking for regenerate button ---
  const [, setSavedInput] = useState<{ goals: string; stories: string } | null>(null)

  // --- Dataset phase state ---
  const [dataset, setDataset] = useState<Dataset | null>(null)
  const [actionSuggestions, setActionSuggestions] = useState<Array<{ action: string; label: string; reason: string }>>([])

  // --- Scorers state (lifted up for persistence across tab switches) ---
  const [scorers, setScorers] = useState<ScorerDef[]>([])

  const [gapAnalysis, setGapAnalysis] = useState<GapAnalysis | null>(null)
  const [showCoverageMap, setShowCoverageMap] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  // --- Hydration: load existing session from DB ---
  useEffect(() => {
    if (!urlSessionId) { setHydrating(false); return }

    const hydrate = async () => {
      try {
        const session = await getSession(urlSessionId)
        const s = session.state as SessionState
        setSessionId(urlSessionId)
        setState(s)
        setMessages(session.conversation?.map((m: { role: string; content: string }) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })) || [])

        // Restore structured goals/stories if available
        if (s.input.goals && s.input.goals.length > 0) {
          setGoals([...s.input.goals, ''])
        } else if (s.input.business_goals) {
          setGoals([...s.input.business_goals.split('\n').filter(g => g.trim()), ''])
        }

        if (s.input.story_groups && s.input.story_groups.length > 0) {
          setStoryGroups(s.input.story_groups as StoryGroup[])
        }

        // Restore project name
        if ((session as { name?: string }).name) setProjectName((session as { name?: string }).name!)

        // Restore scorers
        if (s.scorers && s.scorers.length > 0) {
          setScorers(s.scorers)
        }

        // Determine active tab
        const hasCharter = !!(s.charter.coverage.criteria.length || s.charter.alignment.length)

        // Try to load dataset
        try {
          const ds = await getDataset(urlSessionId)
          setDataset(ds)
          if (ds.examples?.length > 0) {
            setActiveTab('dataset')
          } else if (hasCharter) {
            setActiveTab('charter')
          }
        } catch {
          // No dataset yet
          if (hasCharter) {
            setActiveTab('charter')
          } else if (s.input.story_groups && s.input.story_groups.length > 0) {
            setActiveTab('users')
          }
        }

        if (s.input.business_goals || s.input.user_stories) {
          setSavedInput({
            goals: s.input.business_goals || '',
            stories: s.input.user_stories || '',
          })
        }
      } catch (err) {
        console.error('Failed to load project:', err)
        navigate('/', { replace: true })
      } finally {
        setHydrating(false)
      }
    }
    hydrate()
  }, [urlSessionId, navigate])

  const status: AgentStatus = state.agent_status
  const hasCharter = !!(state.charter.coverage.criteria.length || state.charter.alignment.length)
  const nonEmptyGoals = goals.filter(g => g.trim())

  // Tab availability
  const usersAvailable = nonEmptyGoals.length >= 2
  const charterAvailable = hasCharter || loading
  const datasetAvailable = hasCharter
  const scorersAvailable = hasCharter
  const evaluateAvailable = !!dataset

  // --- Project name ---
  const startEditingName = () => {
    setEditingName(true)
    requestAnimationFrame(() => nameInputRef.current?.select())
  }

  const saveName = async () => {
    setEditingName(false)
    if (sessionId && projectName.trim()) {
      updateSessionName(sessionId, projectName.trim()).catch(err => {
        console.error('Failed to save project name:', err)
      })
    }
  }

  // --- Auto-save goals/stories to DB ---
  const saveInputDebounceRef = useRef<number | null>(null)

  const scheduleSaveInput = useCallback(() => {
    if (!sessionId) return
    if (saveInputDebounceRef.current) {
      window.clearTimeout(saveInputDebounceRef.current)
    }
    saveInputDebounceRef.current = window.setTimeout(() => {
      saveInputDebounceRef.current = null
      const nonEmpty = goals.filter(g => g.trim())
      const groups = storyGroups.filter(g => g.role.trim())
      if (nonEmpty.length > 0 || groups.length > 0) {
        updateSessionInput(sessionId!, { goals: nonEmpty, story_groups: groups }).catch(err => {
          console.error('Failed to auto-save input:', err)
        })
      }
    }, 2000)
  }, [sessionId, goals, storyGroups])

  useEffect(() => {
    return () => {
      if (saveInputDebounceRef.current) {
        window.clearTimeout(saveInputDebounceRef.current)
      }
    }
  }, [])

  // --- Goals handlers ---

  const handleGoalsChange = useCallback((newGoals: string[]) => {
    setGoals(newGoals)
  }, [])

  // Auto-save when goals or stories change
  useEffect(() => {
    if (!hydrating && sessionId) {
      scheduleSaveInput()
    }
  }, [goals, storyGroups, hydrating, sessionId, scheduleSaveInput])

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

  const fetchGoalFeedback = useCallback(async (currentGoals: string[]) => {
    const nonEmpty = currentGoals.filter(g => g.trim())
    if (nonEmpty.length < 1) return

    setGoalFeedbackLoading(true)
    try {
      const res = await evaluateGoals(nonEmpty)
      setGoalFeedback(res.feedback)
    } catch (err) {
      console.error('Failed to evaluate goals:', err)
    } finally {
      setGoalFeedbackLoading(false)
    }
  }, [])

  // Called by GoalsPanel when user presses Enter on a non-empty goal
  const handleGoalCommit = useCallback(() => {
    fetchGoalSuggestions(goals)
    fetchGoalFeedback(goals)
  }, [goals, fetchGoalSuggestions, fetchGoalFeedback])

  // Debounced re-fetch after accepting a suggestion
  const suggestionDebounceRef = useRef<number | null>(null)

  const handleAcceptGoalSuggestion = useCallback((suggestion: string) => {
    setGoals(prev => {
      const lastIsEmpty = prev.length > 0 && prev[prev.length - 1].trim() === ''
      const newGoals = lastIsEmpty
        ? [...prev.slice(0, -1), suggestion, '']
        : [...prev, suggestion, '']

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

  useEffect(() => {
    return () => {
      if (suggestionDebounceRef.current) {
        window.clearTimeout(suggestionDebounceRef.current)
      }
    }
  }, [])

  // --- Story suggestion handlers ---

  const fetchStorySuggestions = useCallback(async (currentGoals: string[], currentGroups: StoryGroup[]) => {
    const nonEmpty = currentGoals.filter(g => g.trim())
    if (nonEmpty.length === 0) return

    const existingStories = currentGroups
      .filter(g => g.role.trim())
      .flatMap(g => g.stories.filter(s => s.what.trim()).map(s => ({ who: g.role, what: s.what, why: s.why })))

    setStorySuggestionsLoading(true)
    try {
      const res = await suggestStories(nonEmpty, existingStories)
      setSuggestedStories(res.suggestions.map(s => ({ who: s.who, what: s.what, why: s.why || '' })))
    } catch (err) {
      console.error('Failed to get story suggestions:', err)
    } finally {
      setStorySuggestionsLoading(false)
    }
  }, [])

  const handleStoryCommit = useCallback(() => {
    fetchStorySuggestions(goals, storyGroups)
  }, [goals, storyGroups, fetchStorySuggestions])

  const storySuggestionDebounceRef = useRef<number | null>(null)

  const handleAcceptStory = useCallback((story: SuggestedStory) => {
    setStoryGroups(prev => {
      const existing = prev.findIndex(g => g.role.toLowerCase() === story.who.toLowerCase())
      let updated: StoryGroup[]
      if (existing >= 0) {
        updated = [...prev]
        updated[existing] = {
          ...updated[existing],
          stories: [...updated[existing].stories, { what: story.what, why: story.why }],
        }
      } else {
        updated = [...prev, { role: story.who, stories: [{ what: story.what, why: story.why }] }]
      }

      if (storySuggestionDebounceRef.current) {
        window.clearTimeout(storySuggestionDebounceRef.current)
      }
      storySuggestionDebounceRef.current = window.setTimeout(() => {
        storySuggestionDebounceRef.current = null
        fetchStorySuggestions(goals, updated)
      }, 3000)

      return updated
    })
    setSuggestedStories(prev => prev.filter(s => s !== story))
  }, [goals, fetchStorySuggestions])

  const handleDismissStory = useCallback((story: SuggestedStory) => {
    setSuggestedStories(prev => prev.filter(s => s !== story))
  }, [])

  useEffect(() => {
    return () => {
      if (storySuggestionDebounceRef.current) {
        window.clearTimeout(storySuggestionDebounceRef.current)
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
          goals: nonEmptyGoals,
          story_groups: storyGroups.filter(g => g.role.trim()),
        })
        setSessionId(res.session_id)
        navigate(`/project/${res.session_id}`, { replace: true })
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
  }, [nonEmptyGoals, storyGroups, sessionId, navigate])

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

  // --- Charter suggestion state ---
  const [charterSuggestionsLoading, setCharterSuggestionsLoading] = useState(false)
  const charterSuggestionDebounceRef = useRef<number | null>(null)

  const handleSuggest = useCallback(async () => {
    if (!sessionId) return
    setCharterSuggestionsLoading(true)
    try {
      const res = await suggestForCharter(sessionId)
      setSuggestions(prev => [...prev, ...res.suggestions])
      setSuggestedStories(prev => [...prev, ...res.suggested_stories])
    } catch (err) {
      console.error('Failed to get suggestions:', err)
    } finally {
      setCharterSuggestionsLoading(false)
    }
  }, [sessionId])

  const scheduleCharterSuggestionRegen = useCallback(() => {
    if (charterSuggestionDebounceRef.current) {
      window.clearTimeout(charterSuggestionDebounceRef.current)
    }
    charterSuggestionDebounceRef.current = window.setTimeout(() => {
      charterSuggestionDebounceRef.current = null
      handleSuggest()
    }, 3000)
  }, [handleSuggest])

  useEffect(() => {
    return () => {
      if (charterSuggestionDebounceRef.current) {
        window.clearTimeout(charterSuggestionDebounceRef.current)
      }
    }
  }, [])

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
    scheduleCharterSuggestionRegen()
  }, [sessionId, scheduleCharterSuggestionRegen])

  const handleDismissSuggestion = useCallback((suggestion: Suggestion) => {
    setSuggestions(prev => prev.filter(s => s !== suggestion))
    scheduleCharterSuggestionRegen()
  }, [scheduleCharterSuggestionRegen])

  // --- Phase transition: charter -> dataset ---

  const handleStartDataset = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      await finalizeCharter(sessionId)
      setActiveTab('dataset')
    } catch (err) {
      console.error('Failed to finalize charter:', err)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  const handleGenerateDataset = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      if (!dataset) {
        await createDataset(sessionId)
      }
      const ds = await getDataset(sessionId)
      await synthesizeExamples(ds.id)
      const fullDs = await getDataset(sessionId)
      setDataset(fullDs)
    } catch (err) {
      console.error('Failed to generate dataset:', err)
    } finally {
      setLoading(false)
    }
  }, [sessionId, dataset])

  const handleImportDataset = useCallback(async () => {
    if (!sessionId) return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.csv'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return

      setLoading(true)
      try {
        if (!dataset) {
          await createDataset(sessionId)
        }
        const ds = await getDataset(sessionId)

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

        const { importExamples } = await import('../api')
        await importExamples(ds.id, examples)
        const fullDs = await getDataset(sessionId)
        setDataset(fullDs)
      } catch (err) {
        console.error('Failed to import:', err)
      } finally {
        setLoading(false)
      }
    }
    input.click()
  }, [sessionId, dataset])

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

        const { importExamples } = await import('../api')
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

  if (hydrating) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header: back + name | tabs (centered) | AI assist + settings */}
      <div className="h-11 border-b border-border bg-surface-raised flex items-center px-2 flex-shrink-0">
        {/* Left: back + project name */}
        <div className="flex items-center gap-1.5 min-w-0 w-48 flex-shrink-0">
          <button
            onClick={() => navigate('/')}
            className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors flex-shrink-0"
            title="All projects"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          {editingName ? (
            <input
              ref={nameInputRef}
              type="text"
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              onBlur={saveName}
              onKeyDown={e => { if (e.key === 'Enter') saveName() }}
              className="text-xs font-medium text-foreground bg-transparent border-b border-accent outline-none min-w-0 flex-1"
            />
          ) : (
            <button
              onClick={startEditingName}
              className="text-xs font-medium text-foreground hover:text-accent truncate min-w-0 text-left transition-colors"
              title="Click to rename"
            >
              {projectName}
            </button>
          )}
        </div>

        {/* Center: tabs */}
        <div className="flex-1 flex items-center justify-center gap-1">
          <TabButton label="Goals" active={activeTab === 'goals'} onClick={() => setActiveTab('goals')}
            badge={nonEmptyGoals.length > 0 ? `${nonEmptyGoals.length}` : undefined} />
          <TabButton label="Users" active={activeTab === 'users'} onClick={() => setActiveTab('users')}
            disabled={!usersAvailable} />
          <TabButton label="Charter" active={activeTab === 'charter'} onClick={() => setActiveTab('charter')}
            disabled={!charterAvailable} badge={suggestions.length > 0 ? `+${suggestions.length}` : undefined} />
          <TabButton label="Dataset" active={activeTab === 'dataset'} onClick={() => setActiveTab('dataset')}
            disabled={!datasetAvailable} badge={dataset ? `${dataset.examples?.length || 0}` : undefined} />
          <TabButton label="Scorers" active={activeTab === 'scorers'} onClick={() => setActiveTab('scorers')}
            disabled={!scorersAvailable} />
          <TabButton label="Evaluate" active={activeTab === 'evaluate'} onClick={() => setActiveTab('evaluate')}
            disabled={!evaluateAvailable} />
        </div>

        {/* Right: AI assist + settings */}
        <div className="flex items-center gap-1 w-48 justify-end flex-shrink-0">
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
              goalFeedback={goalFeedback}
              goalFeedbackLoading={goalFeedbackLoading}
              onDefineUsers={() => setActiveTab('users')}
              hasCharter={hasCharter}
            />
          )}

          {activeTab === 'users' && (
            <UsersPanel
              storyGroups={storyGroups}
              onStoryGroupsChange={setStoryGroups}
              onStoryCommit={handleStoryCommit}
              suggestedStories={suggestedStories}
              onAcceptStory={handleAcceptStory}
              onDismissStory={handleDismissStory}
              storySuggestionsLoading={storySuggestionsLoading}
              onBackToGoals={() => setActiveTab('goals')}
              onGenerate={handleSubmitIntake}
              canGenerate={nonEmptyGoals.length > 0}
              loading={loading}
              hasCharter={hasCharter}
            />
          )}

          {activeTab === 'charter' && (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="px-4 h-12 border-b border-border bg-surface-raised flex items-center justify-between flex-shrink-0">
                <h2 className="text-sm font-semibold text-foreground">Charter</h2>
                <div className="flex items-center gap-2">
                  {hasCharter && (
                    <button
                      onClick={handleValidate}
                      disabled={loading}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50"
                    >
                      <ShieldCheck className="w-3 h-3" />
                      Validate
                    </button>
                  )}
                  {hasCharter && (
                    <button
                      onClick={handleStartDataset}
                      disabled={loading}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50 transition-all"
                    >
                      Dataset
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
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
                onRegenSuggestions={handleSuggest}
                suggestionsLoading={charterSuggestionsLoading}
                loading={loading}
              />
            </div>
          )}

          {activeTab === 'dataset' && (
            <div className="flex-1 min-h-0 flex flex-col">
              {dataset && (dataset.examples?.length || 0) > 0 ? (
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
                  onNavigateToScorers={() => setActiveTab('scorers')}
                  onHeaderClick={() => {}}
                  isFocused={true}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-6 max-w-md text-center">
                    <div>
                      <h2 className="text-lg font-semibold text-foreground mb-1">Build your dataset</h2>
                      <p className="text-sm text-muted-foreground">
                        Create evaluation examples from your charter criteria, or import an existing dataset.
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <button
                        onClick={handleGenerateDataset}
                        disabled={loading}
                        className="flex flex-col items-center gap-2 px-6 py-5 rounded-xl border border-border bg-surface-raised hover:border-accent hover:bg-accent/5 transition-all group disabled:opacity-50"
                      >
                        <Sparkles className="w-6 h-6 text-muted-foreground group-hover:text-accent transition-colors" />
                        <span className="text-sm font-medium text-foreground">{loading ? 'Generating...' : 'Generate'}</span>
                        <span className="text-xs text-muted-foreground">Create examples from charter</span>
                      </button>
                      <span className="text-xs text-muted-foreground">or</span>
                      <button
                        onClick={handleImportDataset}
                        disabled={loading}
                        className="flex flex-col items-center gap-2 px-6 py-5 rounded-xl border border-border bg-surface-raised hover:border-accent hover:bg-accent/5 transition-all group disabled:opacity-50"
                      >
                        <Upload className="w-6 h-6 text-muted-foreground group-hover:text-accent transition-colors" />
                        <span className="text-sm font-medium text-foreground">Import</span>
                        <span className="text-xs text-muted-foreground">Upload JSON or CSV file</span>
                      </button>
                    </div>
                    <button
                      onClick={() => setActiveTab('scorers')}
                      className="text-xs text-muted-foreground hover:text-accent transition-colors"
                    >
                      Skip dataset, go straight to scorers →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'scorers' && (
            <ScorersPanel
              charter={state.charter}
              hasDataset={!!dataset}
              scorers={scorers}
              onScorersChange={(newScorers) => {
                setScorers(newScorers)
                if (sessionId) {
                  saveScorers(sessionId, newScorers).catch(err => console.error('Failed to save scorers:', err))
                }
              }}
              onNavigateToEvaluate={() => setActiveTab('evaluate')}
            />
          )}

          {activeTab === 'evaluate' && (
            <EvaluatePanel
              dataset={dataset}
              onExport={handleExport}
            />
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
