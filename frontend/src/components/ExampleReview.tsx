import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { ChevronDown, Check, X, RefreshCw, Pencil, Trash2, Loader2 } from 'lucide-react'
import type { Example, Charter, GapAnalysis, JudgeAgreement } from '../types'
import DeleteModal from './examples/DeleteModal'
import GenerateModal from './examples/GenerateModal'
import CharterSidebar from './CharterSidebar'
import JudgeAgreementBadge from './JudgeAgreementBadge'

type CellId = 'scenario' | 'input' | 'output' | 'labels' | 'status'
type ActionId = 'approve' | 'reject' | 'relabel' | 'edit' | 'delete'

const CELL_ORDER: CellId[] = ['scenario', 'input', 'output', 'labels', 'status']

// What action set is contextually relevant when each cell is focused.
// Status owns approve/reject, labels owns relabel, input/output own edit,
// scenario owns delete (the row-level destructive action).
const ACTIONS_BY_CELL: Record<CellId, ActionId[]> = {
  scenario: ['delete'],
  input: ['edit'],
  output: ['edit'],
  labels: ['relabel'],
  status: ['approve', 'reject'],
}

interface ExampleReviewProps {
  examples: Example[]
  charter: Charter
  loading: boolean
  /** Distinguishes "generating new examples" (long-running, blocking) from
   *  smaller utility loads like Auto-review or Suggest revisions. When true,
   *  we render a full-area overlay with a centered spinner that blocks all
   *  dataset interactions until generation finishes. Other `loading=true`
   *  paths just disable the affected buttons inline. */
  generating?: boolean
  /** Approximate row count we're about to generate, surfaced in the overlay
   *  copy ("Generating ~24 rows…"). Computed at the parent from
   *  charter dimensions × the count requested. Used as a fallback when
   *  no live progress event has landed yet. */
  generatingTotal?: number
  /** Live progress driven by the backend's per-cell `synth_progress` SSE
   *  event. When present, the overlay swaps the rough estimate for an
   *  actual count ("12 of 24 rows generated"). */
  generatingProgress?: { generated: number; total: number } | null
  onUpdateExample: (exampleId: string, fields: Partial<Example>) => void
  onDeleteExample: (exampleId: string) => void
  onSynthesize: (count?: number) => void
  onAutoReview: () => void
  onExport: () => void
  /** Opens the full Coverage Map matrix in a modal. The matrix lives in a
   *  modal/subpage so the row workspace stays focused on per-row review;
   *  the sidebar carries the at-a-glance signal (radar + score). */
  onShowCoverageMap: () => void
  /** Cached gap analysis. Drives the compact coverage summary in the
   *  sidebar (radar + score + "Fix coverage" CTA). */
  gaps?: GapAnalysis | null
  /** Judge-human label agreement, rendered next to the stats counts. */
  agreement?: JudgeAgreement | null
  /** Bulk "fix every empty cell" — surfaced from the sidebar's compact
   *  coverage summary. The matrix's per-cell "+" buttons live in the modal. */
  onRequestFillGaps?: () => void
  onNavigateToScorers?: () => void
  onHeaderClick?: () => void
  isFocused?: boolean
  coverageGaps?: { uncoveredCount: number; totalScenarios: number } | null
  /** 0–1 dataset coverage score, used for the dot on the "Coverage map"
   *  button. Null when no matrix has been computed yet. */
  coverageScore?: number | null
  onSuggestRevision?: (exampleId: string) => void
  onSuggestRevisions?: () => void
  onAcceptRevision?: (exampleId: string) => void
  onDismissRevision?: (exampleId: string) => void
  revisionsLoading?: boolean
  /** Re-tags every example's feature_area + coverage_tags against the current
   *  charter. Only useful for prompt-eval datasets seeded from sampled turns —
   *  the parent passes undefined for skill-eval to hide the button. */
  onRetagAgainstCharter?: () => void
  retagLoading?: boolean
  /** Read-only when false: synthesize, auto-review, delete, inline edit, and
   *  revision-acceptance buttons all hide. The list itself remains visible. */
  canEdit?: boolean
  /** When set, applies as the initial value of the feature_area filter on
   *  mount. Used by the Evaluations → "Open in Dataset" deep-link to
   *  pre-narrow the list to rows the eval flagged as out-of-charter. The
   *  sentinel value `(unmapped)` filters to rows whose feature_area isn't
   *  one of the charter's alignment entries. */
  initialFeatureAreaFilter?: string | null
  /** Called once the deep-link initial filter has been applied so the parent
   *  can clear the latched value — without this, navigating away and back
   *  would re-apply the same filter on every mount. */
  onInitialFilterApplied?: () => void
}

/** Sentinel filter value for "rows whose feature_area is not in the charter
 *  alignment list". Picked to match the same string the backend uses when
 *  it snaps an out-of-range synthesis output, so the UI filter and the
 *  data tag match without further mapping. */
const UNMAPPED_FEATURE_AREA = '(unmapped)'

export default function ExampleReview({
  examples,
  charter,
  loading,
  generating = false,
  generatingTotal,
  generatingProgress,
  onUpdateExample,
  onDeleteExample,
  onSynthesize,
  onAutoReview,
  onExport,
  onShowCoverageMap,
  gaps,
  agreement,
  onRequestFillGaps,
  onNavigateToScorers: _onNavigateToScorers,
  onHeaderClick: _onHeaderClick,
  isFocused,
  coverageGaps,
  coverageScore,
  onSuggestRevision,
  onSuggestRevisions,
  onAcceptRevision,
  onDismissRevision,
  revisionsLoading,
  onRetagAgainstCharter,
  retagLoading,
  canEdit = true,
  initialFeatureAreaFilter,
  onInitialFilterApplied,
}: ExampleReviewProps) {
  // Lazy initial value picks up the deep-linked filter on first mount.
  // We don't sync setState if the prop changes later — that would let the
  // filter snap back after the user manually cleared it. Telling the
  // parent we've "consumed" the prop happens in a fire-and-forget effect
  // below.
  const [filterArea, setFilterArea] = useState<string>(initialFeatureAreaFilter ?? '')
  const initialFilterAppliedRef = useRef(false)
  useEffect(() => {
    if (initialFilterAppliedRef.current) return
    initialFilterAppliedRef.current = true
    // setState was redundant here — useState already initialized with the
    // same value — so removing it satisfies react-hooks/set-state-in-effect
    // without changing behavior.
    onInitialFilterApplied?.()
  }, [onInitialFilterApplied])
  const [filterLabel, setFilterLabel] = useState<string>('')
  // Default to "pending" so the user's attention lands on what still needs
  // review. Once nothing is pending, flip to "all" so the full list stays
  // visible rather than showing an empty state.
  const [filterStatus, setFilterStatus] = useState<string>('pending')
  // Once nothing is pending, flip the filter to "all" so we don't sit on an
  // empty list. Set during render rather than in an effect — this is the
  // React-recommended pattern when state needs to follow derived data.
  const pendingCount = examples.filter(e => e.review_status === 'pending').length
  if (filterStatus === 'pending' && pendingCount === 0 && examples.length > 0) {
    setFilterStatus('')
  }
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Row in view (topmost visible). Updates as the user scrolls so the
  // sidebar's charter criteria track what the eye is on, without
  // hijacking the click-selected row. Falls back to selectedId.
  const [scrollFocusedId, setScrollFocusedId] = useState<string | null>(null)
  const listScrollRef = useRef<HTMLDivElement | null>(null)
  const [focusedCell, setFocusedCell] = useState<CellId>('status')

  // Polaris nav: when the agent runs `nav_example`, ProjectWorkspace switches
  // to the dataset tab and broadcasts the example id. We pick it up here so
  // the row gets selected without lifting selection state out of this
  // component.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string }>).detail
      if (detail?.id) setSelectedId(detail.id)
    }
    window.addEventListener('polaris:select-example', handler)
    return () => window.removeEventListener('polaris:select-example', handler)
  }, [])

  // Polaris nav: `set_dataset_filter` drives the table filters from chat.
  // Each field is independent — undefined means "leave alone", "" means
  // "clear". This matches the agent's schema so the model can update one
  // dimension without touching the others.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{
        feature_area?: string
        label?: string
        review_status?: string
      }>).detail
      if (!detail) return
      if (detail.feature_area !== undefined) setFilterArea(detail.feature_area)
      if (detail.label !== undefined) setFilterLabel(detail.label)
      if (detail.review_status !== undefined) setFilterStatus(detail.review_status)
    }
    window.addEventListener('polaris:set-filter', handler)
    return () => window.removeEventListener('polaris:set-filter', handler)
  }, [])
  // Edit state carries both row id and which cell is being edited so only
  // that one cell becomes a textarea. The other cells stay read-only.
  const [editing, setEditing] = useState<{ id: string; cell: 'input' | 'output' } | null>(null)
  const editingId = editing?.id ?? null
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [showGenerateModal, setShowGenerateModal] = useState(false)

  // Edit defaults to whichever of input/output is focused. If the focused
  // cell isn't one of those, fall back to input — the action button is in
  // 'outline' state for non-edit cells, but still works.
  const beginEdit = useCallback((exampleId: string) => {
    const cell = focusedCell === 'output' ? 'output' : 'input'
    setEditing({ id: exampleId, cell })
  }, [focusedCell])

  const featureAreas = charter.alignment.map(a => a.feature_area)

  const getSuggestedGeneration = () => {
    const coverageCriteria = charter.coverage?.criteria?.length || 0
    const alignmentAreas = charter.alignment?.length || 0
    const totalScenarios = Math.max(coverageCriteria * alignmentAreas, 1)

    if (coverageGaps && coverageGaps.uncoveredCount > 0) {
      const countPerGap = 2
      return {
        count: countPerGap,
        reason: `Based on coverage analysis: ${coverageGaps.uncoveredCount} of ${coverageGaps.totalScenarios} scenarios lack examples. Generating ${countPerGap} examples per scenario will help fill these gaps.`,
      }
    }

    if (examples.length === 0) {
      return {
        count: 2,
        reason: `Starting fresh: generating 2 examples per scenario (${totalScenarios} scenarios = ~${totalScenarios * 2} examples) provides good initial coverage for your ${alignmentAreas} feature areas × ${coverageCriteria} coverage criteria.`,
      }
    }

    const approvedCount = examples.filter(e => e.review_status === 'approved').length
    if (approvedCount < totalScenarios) {
      return {
        count: 2,
        reason: `You have ${approvedCount} approved examples but ${totalScenarios} scenario combinations. Generating more will improve coverage across all feature areas and criteria.`,
      }
    }

    return {
      count: 1,
      reason: `You have good coverage (${approvedCount} approved). Generate additional examples to increase diversity or cover edge cases.`,
    }
  }

  const { count: suggestedCount, reason: suggestionReason } = getSuggestedGeneration()
  const totalScenarios = Math.max(
    (charter.coverage?.criteria?.length || 0) * (charter.alignment?.length || 0),
    1,
  )

  const validAreas = useMemo(() => new Set(featureAreas), [featureAreas])
  // Are any rows tagged with a feature_area outside the charter alignment
  // list? Drives both the conditional `(unmapped)` filter option and any
  // hint text upstream wants to show. (off-target) is a triggered-mode
  // sentinel and isn't considered unmapped.
  const hasUnmappedRows = useMemo(
    () =>
      examples.some(
        (ex) =>
          ex.feature_area &&
          ex.feature_area !== '(off-target)' &&
          !validAreas.has(ex.feature_area),
      ),
    [examples, validAreas],
  )

  const filtered = useMemo(
    () =>
      examples.filter(ex => {
        if (filterArea === UNMAPPED_FEATURE_AREA) {
          // "Unmapped" is a synthetic filter — match anything outside the
          // charter alignment list. Excludes the (off-target) sentinel
          // because that's a deliberate label, not a synthesis miss.
          if (!ex.feature_area) return false
          if (ex.feature_area === '(off-target)') return false
          if (validAreas.has(ex.feature_area)) return false
        } else if (filterArea && ex.feature_area !== filterArea) {
          return false
        }
        if (filterLabel && ex.label !== filterLabel) return false
        if (filterStatus && ex.review_status !== filterStatus) return false
        return true
      }),
    [examples, filterArea, filterLabel, filterStatus, validAreas],
  )

  // Group by feature_area, preserving original insertion order.
  const groups = useMemo(() => {
    const map = new Map<string, Example[]>()
    for (const ex of filtered) {
      const key = ex.feature_area || 'uncategorized'
      const list = map.get(key)
      if (list) list.push(ex)
      else map.set(key, [ex])
    }
    return Array.from(map.entries())
  }, [filtered])

  // Flat list in the order rows actually render. Arrow-key nav must walk
  // this list so ↓ always moves to the next visible row, even across groups.
  const orderedExamples = useMemo(
    () => groups.flatMap(([, items]) => items),
    [groups],
  )

  // Auto-select first example if none selected (or selected one was filtered out).
  // Derive during render so we don't pay the extra render of a setState-in-effect.
  if (
    orderedExamples.length > 0 &&
    (!selectedId || !orderedExamples.find(e => e.id === selectedId))
  ) {
    setSelectedId(orderedExamples[0].id)
  }

  const selectedIndex = orderedExamples.findIndex(e => e.id === selectedId)
  const selectedExample = orderedExamples.find(e => e.id === selectedId)
  // Sidebar's focused row: the topmost row currently visible. Falls back to
  // the click-selected row so the sidebar is never empty when scroll hasn't
  // happened yet (e.g. fresh mount, short lists).
  const focusedExample = useMemo(
    () =>
      orderedExamples.find(e => e.id === scrollFocusedId) ?? selectedExample,
    [orderedExamples, scrollFocusedId, selectedExample],
  )

  // Watch which rows are intersecting the list viewport; the topmost
  // intersecting one becomes the sidebar's focused row. Re-bound whenever
  // the rendered set changes (filter / synth landing new rows).
  useEffect(() => {
    const root = listScrollRef.current
    if (!root) return
    const rowEls = Array.from(
      root.querySelectorAll<HTMLElement>("[data-row-id]"),
    )
    if (rowEls.length === 0) return

    const visibleIds = new Set<string>()
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-row-id")
          if (!id) continue
          if (entry.isIntersecting) visibleIds.add(id)
          else visibleIds.delete(id)
        }
        // Pick the topmost visible row by walking orderedExamples and
        // grabbing the first match. Walking in render order is cheaper
        // than reading bounding rects per entry.
        const topmost = orderedExamples.find(e => visibleIds.has(e.id))
        if (topmost) setScrollFocusedId(topmost.id)
      },
      { root, threshold: 0 },
    )
    rowEls.forEach(el => observer.observe(el))
    return () => observer.disconnect()
  }, [orderedExamples])

  const examplesWithIssues = examples.filter(
    ex => ex.judge_verdict?.issues && ex.judge_verdict.issues.length > 0 && !ex.revision_suggestion,
  ).length

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Block per-row shortcuts while a regeneration is in flight — actions
      // would race against the upcoming row reset and lose work.
      if (generating) return
      if (editingId || deleteConfirmId) {
        if (e.key === 'Escape') setEditing(null)
        return
      }
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
        return

      switch (e.key) {
        case 'ArrowUp':
        case 'k':
          e.preventDefault()
          if (selectedIndex > 0) setSelectedId(orderedExamples[selectedIndex - 1].id)
          break
        case 'ArrowDown':
        case 'j':
          e.preventDefault()
          if (selectedIndex < orderedExamples.length - 1)
            setSelectedId(orderedExamples[selectedIndex + 1].id)
          break
        case 'ArrowLeft': {
          e.preventDefault()
          const ci = CELL_ORDER.indexOf(focusedCell)
          if (ci > 0) setFocusedCell(CELL_ORDER[ci - 1])
          break
        }
        case 'ArrowRight': {
          e.preventDefault()
          const ci = CELL_ORDER.indexOf(focusedCell)
          if (ci < CELL_ORDER.length - 1) setFocusedCell(CELL_ORDER[ci + 1])
          break
        }
        case 'a':
        case 'A':
          if (selectedExample) {
            e.preventDefault()
            onUpdateExample(selectedExample.id, { review_status: 'approved' })
          }
          break
        case 'e':
        case 'E':
          if (selectedExample) {
            e.preventDefault()
            beginEdit(selectedExample.id)
          }
          break
        case 'r':
        case 'R':
          if (selectedExample) {
            e.preventDefault()
            onUpdateExample(selectedExample.id, { review_status: 'rejected' })
          }
          break
        case 'l':
        case 'L':
          if (selectedExample) {
            e.preventDefault()
            onUpdateExample(selectedExample.id, {
              label: selectedExample.label === 'good' ? 'bad' : 'good',
            })
          }
          break
        case 'd':
        case 'D':
          if (selectedExample) {
            e.preventDefault()
            setDeleteConfirmId(selectedExample.id)
          }
          break
        case 's':
        case 'S':
          if (
            selectedExample &&
            onSuggestRevision &&
            selectedExample.judge_verdict?.issues?.length &&
            !selectedExample.revision_suggestion
          ) {
            e.preventDefault()
            onSuggestRevision(selectedExample.id)
          }
          break
      }
    },
    [editingId, deleteConfirmId, selectedIndex, orderedExamples, selectedExample, focusedCell, onUpdateExample, onSuggestRevision, beginEdit, generating],
  )

  useEffect(() => {
    if (isFocused) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isFocused, handleKeyDown])

  const handleConfirmDelete = () => {
    if (deleteConfirmId) {
      onDeleteExample(deleteConfirmId)
      setDeleteConfirmId(null)
      if (selectedIndex < orderedExamples.length - 1)
        setSelectedId(orderedExamples[selectedIndex + 1].id)
      else if (selectedIndex > 0) setSelectedId(orderedExamples[selectedIndex - 1].id)
      else setSelectedId(null)
    }
  }

  const stats = {
    total: examples.length,
    pending: examples.filter(e => e.review_status === 'pending').length,
    approved: examples.filter(e => e.review_status === 'approved').length,
    rejected: examples.filter(e => e.review_status === 'rejected').length,
    // Rows tagged "new" in coverage_tags arrived via the prompt-eval
    // auto-refresh (turns landed since the last visit). Surface the count
    // in the header so the user notices fresh evidence without digging.
    newSinceRefresh: examples.filter(e => (e.coverage_tags || []).includes('new')).length,
  }

  const actOnSelected = (fn: (ex: Example) => void) => {
    if (selectedExample) fn(selectedExample)
  }

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      {/* Generation overlay — covers the dataset surface while a synth is in
          flight so the user can't approve/reject/edit/delete rows that are
          about to be replaced. Centered spinner + row count gives them
          something to look at. Lives outside the inner padded body so the
          backdrop reaches the page edges. */}
      {generating && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-bg-default/70 backdrop-blur-[2px]"
          aria-busy="true"
        >
          <div
            className="flex flex-col items-center gap-3 px-6 py-5 bg-surface-raised border border-border shadow-lg"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="w-8 h-8 text-accent animate-spin" />
            <div className="text-center min-w-[14rem]">
              <p className="text-sm font-medium text-fg-contrast">
                {examples.length > 0
                  ? "Regenerating dataset…"
                  : "Generating dataset…"}
              </p>
              {(() => {
                // Live count when we have one, fall back to the rough
                // estimate before the first cell lands. Total can grow
                // beyond the estimate if the LLM returns more rows than
                // asked — clamp the bar via Math.min for sanity.
                const live = generatingProgress
                if (live && live.total > 0) {
                  const pct = Math.min(
                    100,
                    Math.round((live.generated / live.total) * 100),
                  )
                  return (
                    <>
                      <p className="text-xs text-fg-dim mt-1">
                        {live.generated} of {live.total} rows generated
                      </p>
                      <div className="mt-3 h-1 w-full bg-fill-neutral overflow-hidden">
                        <div
                          className="h-full bg-accent transition-[width] duration-300 ease-out"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </>
                  )
                }
                if (generatingTotal && generatingTotal > 0) {
                  return (
                    <p className="text-xs text-fg-dim mt-1">
                      About {generatingTotal} row
                      {generatingTotal === 1 ? "" : "s"} expected
                    </p>
                  )
                }
                return null
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Page body — title + filters + grouped table */}
      <div
        className={`flex-1 min-h-0 flex flex-col gap-6 p-6 overflow-hidden ${
          generating ? "pointer-events-none select-none" : ""
        }`}
      >
        {/* Title + Dataset QA subtitle — framing without a dismissable
            banner. Distinguishes this phase from later eval-result review. */}
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-fg-contrast leading-none">Dataset</h1>
          <p className="text-xs text-fg-dim">
            The test cases your eval will run against — review for quality, not model performance.
          </p>
        </div>

        {/* Stats + dataset-level utilities (Coverage map / Export / Auto-review /
            Suggest revisions / Generate). Sits directly under the title — these
            are about the dataset as a whole. Filters and per-row actions live
            in a second toolbar below. */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap text-xs text-fg-dim">
            <span>
              {stats.total} total · {stats.pending} pending · {stats.approved} approved
              {stats.newSinceRefresh > 0 && (
                <>
                  {' · '}
                  <span className="text-accent font-medium">{stats.newSinceRefresh} new</span>
                </>
              )}
            </span>
            {agreement && <JudgeAgreementBadge agreement={agreement} />}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onShowCoverageMap}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-fg-dim hover:text-fg-contrast border border-border-hint transition-colors"
              title="Open the full coverage matrix"
            >
              {coverageScore != null && <CoverageDot score={coverageScore} />}
              Coverage map
            </button>
            <button
              onClick={onExport}
              disabled={stats.approved === 0}
              className="px-2 py-1 text-xs text-fg-dim hover:text-fg-contrast border border-border-hint transition-colors disabled:opacity-40"
            >
              Export
            </button>
            {canEdit && (
              <button
                onClick={onAutoReview}
                disabled={loading || stats.pending === 0}
                className="px-2 py-1 text-xs border border-border-hint hover:bg-fill-neutral transition-colors disabled:opacity-50"
              >
                Auto-review
              </button>
            )}
            {canEdit && onRetagAgainstCharter && (
              <button
                onClick={onRetagAgainstCharter}
                disabled={loading || retagLoading || stats.total === 0}
                className="px-2 py-1 text-xs border border-border-hint hover:bg-fill-neutral transition-colors disabled:opacity-50"
                title="Re-tag every row's feature_area and coverage_tags against the current charter. Useful after generating or editing the charter so the Coverage Map matrix lines up."
              >
                {retagLoading ? 'Retagging…' : 'Retag against charter'}
              </button>
            )}
            {canEdit && onSuggestRevisions && (
              <button
                onClick={onSuggestRevisions}
                disabled={loading || revisionsLoading || examplesWithIssues === 0}
                className="px-2 py-1 text-xs border border-border-hint hover:bg-fill-neutral transition-colors disabled:opacity-50"
                title="Suggest fixes for examples auto-review flagged with issues. Doesn't change the good/bad label — just refines the input or expected_output to better match the scenario."
              >
                {revisionsLoading
                  ? 'Suggesting...'
                  : `Fix flagged${examplesWithIssues > 0 ? ` (${examplesWithIssues})` : ''}`}
              </button>
            )}
            {canEdit && (
              <button
                onClick={() => setShowGenerateModal(true)}
                disabled={loading}
                className="px-2.5 py-1 text-xs bg-fill-primary text-bg-default hover:bg-fill-primary-hover transition-colors disabled:opacity-50"
              >
                {loading ? 'Generating...' : 'Generate'}
              </button>
            )}
          </div>
        </div>

        {/* Filters + per-row actions — sits closer to the table since it
            scopes to which rows are shown and what to do with the selected
            row's focused cell. */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <FilterSelect
              value={filterArea}
              onChange={setFilterArea}
              placeholder="All areas"
              options={[
                ...featureAreas.map(a => ({ value: a, label: a })),
                // Surface the synthetic "(unmapped)" option only when there
                // are rows that match it — listing it on a clean dataset
                // would just be noise.
                ...(hasUnmappedRows
                  ? [{ value: UNMAPPED_FEATURE_AREA, label: 'Unmapped (no alignment)' }]
                  : []),
              ]}
            />
            <FilterSelect
              value={filterLabel}
              onChange={setFilterLabel}
              placeholder="All labels"
              options={[
                { value: 'good', label: 'Good' },
                { value: 'bad', label: 'Bad' },
                { value: 'unlabeled', label: 'Unlabeled' },
              ]}
            />
            <FilterSelect
              value={filterStatus}
              onChange={setFilterStatus}
              placeholder="All status"
              options={[
                { value: 'pending', label: 'Pending' },
                { value: 'approved', label: 'Approved' },
                { value: 'rejected', label: 'Rejected' },
                { value: 'needs_edit', label: 'Needs edit' },
              ]}
            />
          </div>

          {canEdit && (
            <div className="flex items-center gap-2 flex-wrap">
              <ActionButton
                icon={<Check className="w-4 h-4" />}
                shortcut="A"
                label="pprove"
                variant={ACTIONS_BY_CELL[focusedCell].includes('approve') ? 'neutral' : 'outline'}
                onClick={() => actOnSelected(ex => onUpdateExample(ex.id, { review_status: 'approved' }))}
                disabled={!selectedExample}
              />
              <ActionButton
                icon={<X className="w-4 h-4" />}
                shortcut="R"
                label="eject"
                variant={ACTIONS_BY_CELL[focusedCell].includes('reject') ? 'neutral' : 'outline'}
                onClick={() => actOnSelected(ex => onUpdateExample(ex.id, { review_status: 'rejected' }))}
                disabled={!selectedExample}
              />
              <ActionButton
                icon={<RefreshCw className="w-4 h-4" />}
                prefix="Re"
                shortcut="l"
                label="abel"
                variant={ACTIONS_BY_CELL[focusedCell].includes('relabel') ? 'neutral' : 'outline'}
                onClick={() =>
                  actOnSelected(ex =>
                    onUpdateExample(ex.id, { label: ex.label === 'good' ? 'bad' : 'good' }),
                  )
                }
                disabled={!selectedExample}
              />
              <ActionButton
                icon={<Pencil className="w-4 h-4" />}
                shortcut="E"
                label="dit"
                variant={ACTIONS_BY_CELL[focusedCell].includes('edit') ? 'neutral' : 'outline'}
                onClick={() => actOnSelected(ex => beginEdit(ex.id))}
                disabled={!selectedExample}
              />
              <ActionButton
                icon={<Trash2 className="w-4 h-4" />}
                shortcut="D"
                label="elete"
                variant={ACTIONS_BY_CELL[focusedCell].includes('delete') ? 'neutral' : 'outline'}
                onClick={() => actOnSelected(ex => setDeleteConfirmId(ex.id))}
                disabled={!selectedExample}
              />
            </div>
          )}
        </div>

        {/* Grouped list + right rail (charter context + compact coverage).
            The list is the primary surface; the sidebar carries criteria
            for the focused row and the at-a-glance coverage signal. */}
        <div className="flex-1 min-h-0 flex gap-4">
          <div ref={listScrollRef} className="flex-1 min-w-0 overflow-y-auto flex flex-col gap-0">
          {filtered.length === 0 && filterStatus === 'pending' && stats.total > 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center">
              <div className="text-center max-w-sm">
                <div className="w-12 h-12 bg-success/10 flex items-center justify-center mx-auto mb-4">
                  <Check className="w-6 h-6 text-success" />
                </div>
                <h3 className="text-base font-semibold text-fg-contrast mb-2">All examples reviewed!</h3>
                <p className="text-xs text-fg-dim mb-6">
                  You've reviewed all {stats.total} examples. {stats.approved} approved, {stats.rejected} rejected.
                </p>
                <div className="flex flex-col gap-3">
                  <button
                    onClick={onShowCoverageMap}
                    className="w-full py-2.5 px-4 bg-fill-neutral border border-border-hint text-sm font-medium hover:bg-fill-neutral-hover transition-colors"
                  >
                    Check coverage gaps
                  </button>
                  <button
                    onClick={() => setShowGenerateModal(true)}
                    disabled={loading}
                    className="w-full py-2.5 px-4 bg-fill-neutral border border-border-hint text-sm font-medium hover:bg-fill-neutral-hover transition-colors disabled:opacity-50"
                  >
                    Generate more examples
                  </button>
                  <button
                    onClick={onExport}
                    disabled={stats.approved === 0}
                    className="w-full py-2.5 px-4 bg-fill-primary text-bg-default text-sm font-medium hover:bg-fill-primary-hover transition-colors disabled:opacity-50"
                  >
                    Export dataset ({stats.approved} examples)
                  </button>
                </div>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-fg-dim">
              <p className="text-sm mb-2">No examples match filters</p>
              <p className="text-xs">Try adjusting the filters above.</p>
            </div>
          ) : (
            <>
              {/* Sticky column header row */}
              <ColumnHeaderRow />
              <div className="flex flex-col gap-0">
                {groups.map(([groupName, items], gi) => (
                  <div key={groupName} className="flex flex-col">
                    {gi > 0 && <div className="h-4" />}
                    <GroupHeader name={groupName} />
                    {items.map(ex => (
                      <ExampleRow
                        key={ex.id}
                        example={ex}
                        isSelected={selectedId === ex.id}
                        editingCell={editing?.id === ex.id ? editing.cell : null}
                        focusedCell={focusedCell}
                        onSelect={() => setSelectedId(ex.id)}
                        onCellSelect={cell => {
                          setSelectedId(ex.id)
                          setFocusedCell(cell)
                        }}
                        onUpdate={fields => onUpdateExample(ex.id, fields)}
                        onCancelEdit={() => setEditing(null)}
                        onAcceptRevision={onAcceptRevision}
                        onDismissRevision={onDismissRevision}
                        onSuggestRevision={onSuggestRevision}
                        onStartEdit={() => beginEdit(ex.id)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
          </div>
          <CharterSidebar
            charter={charter}
            focusedFeatureArea={focusedExample?.feature_area}
            focusedCoverageTags={focusedExample?.coverage_tags ?? []}
            gaps={gaps}
            onOpenCoverageMatrix={onShowCoverageMap}
            onRequestFillGaps={onRequestFillGaps}
          />
        </div>
      </div>

      {deleteConfirmId && (
        <DeleteModal onConfirm={handleConfirmDelete} onCancel={() => setDeleteConfirmId(null)} />
      )}
      {showGenerateModal && (
        <GenerateModal
          onConfirm={count => {
            onSynthesize(count)
            setShowGenerateModal(false)
          }}
          onCancel={() => setShowGenerateModal(false)}
          suggestedCount={suggestedCount}
          suggestionReason={suggestionReason}
          totalScenarios={totalScenarios}
        />
      )}
    </div>
  )
}

/* ── Toolbar widgets ────────────────────────────────────────────── */

function FilterSelect({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  options: { value: string; label: string }[]
}) {
  // Native <select> styled to look like the Figma ButtonMed:
  // dark surface, hint border, mono label, chevron on the right.
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="appearance-none h-10 pl-3 pr-9 text-sm font-mono font-semibold text-fg-contrast bg-transparent border border-border-hint hover:bg-fill-neutral transition-colors cursor-pointer focus:outline-none focus:border-border-primary"
      >
        <option value="">{placeholder}</option>
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-contrast pointer-events-none" />
    </div>
  )
}

function ActionButton({
  icon,
  prefix,
  shortcut,
  label,
  onClick,
  disabled,
  variant = 'neutral',
}: {
  icon?: React.ReactNode
  prefix?: string
  shortcut: string
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'neutral' | 'outline'
}) {
  // 'neutral' = filled — used for actions relevant to the focused cell.
  // 'outline' = transparent w/ border — actions still available but
  // not the contextual default for the current cell.
  const variantCls =
    variant === 'neutral'
      ? 'bg-fill-neutral text-fg-contrast hover:bg-fill-neutral-hover'
      : 'bg-transparent text-fg-contrast border border-border-hint hover:bg-fill-neutral'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`h-10 px-2 flex items-center gap-2 text-sm font-mono font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${variantCls}`}
    >
      {icon}
      <span className="leading-none">
        {prefix}
        <span className="underline">{shortcut}</span>
        {label}
      </span>
    </button>
  )
}

/* ── Table parts ────────────────────────────────────────────────── */

function ColumnHeaderRow() {
  return (
    <div className="flex items-end gap-4 px-4 py-2 text-sm text-fg-contrast">
      <div className="flex-1 basis-0">Scenario</div>
      <div className="flex-1 basis-0">Input</div>
      <div className="flex-1 basis-0">Output</div>
      <div className="w-[200px] flex-shrink-0">Labels</div>
      <div className="w-[100px] flex-shrink-0">Status</div>
    </div>
  )
}

function GroupHeader({ name }: { name: string }) {
  // Sticky so the section label stays pinned while scrolling. Criteria for
  // the focused row live in the right sidebar — keeping the header to the
  // section name only avoids duplicating that info on every separator.
  return (
    <div className="sticky top-0 z-10 px-4 py-2 bg-gray-200">
      <span className="text-sm font-semibold text-white font-sans">{name}</span>
    </div>
  )
}

/* ── Row ────────────────────────────────────────────────────────── */

function ExampleRow({
  example,
  isSelected,
  editingCell,
  focusedCell,
  onSelect,
  onCellSelect,
  onUpdate,
  onCancelEdit,
  onAcceptRevision,
  onDismissRevision,
  onSuggestRevision,
  onStartEdit,
}: {
  example: Example
  isSelected: boolean
  /** Which single cell is being edited on this row. Null means read-only. */
  editingCell: 'input' | 'output' | null
  focusedCell: CellId
  onSelect: () => void
  onCellSelect: (cell: CellId) => void
  onUpdate: (fields: Partial<Example>) => void
  onCancelEdit: () => void
  onAcceptRevision?: (exampleId: string) => void
  onDismissRevision?: (exampleId: string) => void
  onSuggestRevision?: (exampleId: string) => void
  onStartEdit: () => void
}) {
  // Light-grey wash on the focused cell, with a 2px transparent gap on all
  // sides (achieved via padding + bg-clip-content). Padding stays applied
  // to every cell so non-focused → focused doesn't shift content.
  const cellCls = (cell: CellId) =>
    isSelected && focusedCell === cell ? 'bg-gray-150 bg-clip-content' : ''
  const [editInput, setEditInput] = useState(example.input)
  const [editOutput, setEditOutput] = useState(example.expected_output)
  // Track the source values we hydrated edit state from. When the parent
  // updates the underlying example, reset the edit buffers. Derived during
  // render to avoid a setState-in-effect cascade.
  const [prevSource, setPrevSource] = useState({ input: example.input, output: example.expected_output })
  if (prevSource.input !== example.input || prevSource.output !== example.expected_output) {
    setPrevSource({ input: example.input, output: example.expected_output })
    setEditInput(example.input)
    setEditOutput(example.expected_output)
  }
  const [showRevision, setShowRevision] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isSelected])

  const handleSaveEdit = () => {
    // Only persist whichever single cell was being edited. The other cell
    // never changed, so don't pretend to "approve" both.
    const update: Partial<Example> = {
      review_status: 'approved',
      revision_suggestion: null,
    } as Partial<Example>
    if (editingCell === 'input') update.input = editInput
    else if (editingCell === 'output') update.expected_output = editOutput
    onUpdate(update)
    onCancelEdit()
  }

  const handleEditWithRevision = () => {
    if (example.revision_suggestion) {
      setEditInput(example.revision_suggestion.input)
      setEditOutput(example.revision_suggestion.expected_output)
    }
    onStartEdit()
  }

  const hasIssues = example.judge_verdict?.issues && example.judge_verdict.issues.length > 0
  const hasRevision = !!example.revision_suggestion

  // Scenario column: chip per coverage_tag so reviewers see every criterion
  // the row covers. Fall back to feature_area when no tags are present —
  // that's mostly orphaned rows; the group header already shows the area.
  const scenarioTags = example.coverage_tags.length > 0
    ? example.coverage_tags
    : example.feature_area
      ? [example.feature_area]
      : []

  return (
    <>
      <div
        ref={rowRef}
        data-row-id={example.id}
        onClick={onSelect}
        className={[
          'flex items-stretch gap-4 px-4 py-4 cursor-pointer transition-colors max-h-[480px]',
          isSelected
            ? 'bg-bg-default outline outline-2 outline-border-primary -outline-offset-2'
            : 'bg-gray-150 hover:bg-fill-neutral-hover',
        ].join(' ')}
      >
        {/* Scenario — coverage_tags rendered as chips so all tagged
            criteria are visible, not just the first. Fallback to
            feature_area only when tags are empty (orphaned rows). */}
        <div
          onClick={e => { e.stopPropagation(); onCellSelect('scenario') }}
          className={`flex-1 basis-0 self-stretch p-px overflow-hidden ${cellCls('scenario')}`}
        >
          <div className="h-full p-2 flex flex-wrap gap-1 content-start overflow-y-auto">
            {scenarioTags.length === 0 ? (
              <span className="text-xs text-fg-dim italic">untagged</span>
            ) : (
              scenarioTags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center px-1.5 py-0.5 text-[11px] leading-tight bg-fill-neutral text-fg-contrast border border-border-hint"
                >
                  {tag}
                </span>
              ))
            )}
          </div>
        </div>

        {/* Input */}
        <div
          onClick={e => { e.stopPropagation(); onCellSelect('input') }}
          className={`flex-1 basis-0 self-stretch p-px overflow-hidden ${cellCls('input')}`}
        >
          <div className="h-full p-2 overflow-y-auto">
            {editingCell === 'input' ? (
              <EditCell
                value={editInput}
                onChange={setEditInput}
                onSave={handleSaveEdit}
                onCancel={onCancelEdit}
              />
            ) : (
              <div className="text-sm text-fg-contrast leading-[1.5] whitespace-pre-wrap break-words">
                {example.input}
              </div>
            )}
          </div>
        </div>

        {/* Output */}
        <div
          onClick={e => { e.stopPropagation(); onCellSelect('output') }}
          className={`flex-1 basis-0 self-stretch p-px overflow-hidden ${cellCls('output')}`}
        >
          <div className="h-full p-2 overflow-y-auto">
            {editingCell === 'output' ? (
              <EditCell
                value={editOutput}
                onChange={setEditOutput}
                onSave={handleSaveEdit}
                onCancel={onCancelEdit}
              />
            ) : (
              <div className="text-sm text-fg-contrast leading-[1.5] whitespace-pre-wrap break-words">
                {example.expected_output || <span className="text-fg-dim italic">—</span>}
              </div>
            )}
          </div>
        </div>

        {/* Labels */}
        <div
          onClick={e => { e.stopPropagation(); onCellSelect('labels') }}
          className={`w-[200px] flex-shrink-0 self-stretch p-px ${cellCls('labels')}`}
        >
          <div className="h-full p-2 flex flex-col gap-2">
            <div className="flex items-start gap-1 flex-wrap">
              <Chip>{example.label === 'good' ? 'Good' : example.label === 'bad' ? 'Bad' : 'Unlabeled'}</Chip>
              <Chip>{example.source.charAt(0).toUpperCase() + example.source.slice(1)}</Chip>
            </div>
          </div>
        </div>

        {/* Status */}
        <div
          onClick={e => { e.stopPropagation(); onCellSelect('status') }}
          className={`w-[100px] flex-shrink-0 self-stretch p-px ${cellCls('status')}`}
        >
          <div className="h-full p-2 flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
              <StatusDot status={example.review_status} />
              <span className="text-sm text-fg-contrast capitalize">
                {example.review_status === 'needs_edit' ? 'Needs edit' : example.review_status}
              </span>
            </div>
            {hasRevision && (
              <button
                onClick={e => {
                  e.stopPropagation()
                  setShowRevision(!showRevision)
                }}
                className="text-[10px] text-purple-700 hover:text-purple-800 self-start"
              >
                {showRevision ? 'Hide revision' : 'View revision'}
              </button>
            )}
            {hasIssues && !hasRevision && onSuggestRevision && (
              <button
                onClick={e => {
                  e.stopPropagation()
                  onSuggestRevision(example.id)
                }}
                className="text-[10px] text-warning hover:opacity-80 self-start"
              >
                Suggest fix
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Revision suggestion drawer */}
      {isSelected && showRevision && hasRevision && example.revision_suggestion && (
        <div className="px-4 py-3 bg-fill-neutral border-l-2 border-l-border-primary">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-medium text-purple-700 uppercase tracking-wider">
              Suggested revision
            </span>
            <div className="flex gap-1.5">
              {onAcceptRevision && (
                <button
                  onClick={e => {
                    e.stopPropagation()
                    onAcceptRevision(example.id)
                  }}
                  className="px-2 py-0.5 text-[10px] text-success hover:bg-success/10 border border-success/20 transition-colors"
                >
                  Accept
                </button>
              )}
              <button
                onClick={e => {
                  e.stopPropagation()
                  handleEditWithRevision()
                }}
                className="px-2 py-0.5 text-[10px] text-fg-primary hover:bg-fill-primary/10 border border-fill-primary/20 transition-colors"
              >
                Edit
              </button>
              {onDismissRevision && (
                <button
                  onClick={e => {
                    e.stopPropagation()
                    onDismissRevision(example.id)
                    setShowRevision(false)
                  }}
                  className="px-2 py-0.5 text-[10px] text-fg-dim hover:text-fg-contrast border border-border-hint transition-colors"
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>
          <p className="text-xs text-fg-dim italic mb-2">{example.revision_suggestion.reasoning}</p>
          <div className="grid grid-cols-2 gap-3">
            <RevisionDiff label="Input" before={example.input} after={example.revision_suggestion.input} />
            <RevisionDiff
              label="Expected Output"
              before={example.expected_output}
              after={example.revision_suggestion.expected_output}
            />
          </div>
        </div>
      )}
    </>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-2 py-1 bg-gray-150 text-sm text-fg-contrast">
      {children}
    </span>
  )
}

function EditCell({
  value,
  onChange,
  onSave,
  onCancel,
}: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // Mount-time focus + cursor at end of text. Selecting via setSelectionRange
  // after focus works across browsers; just calling .focus() leaves the cursor
  // at position 0 in some implementations.
  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    ta.focus()
    const len = ta.value.length
    ta.setSelectionRange(len, len)
  }, [])
  return (
    <div className="flex flex-col gap-1" onClick={e => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          // Enter saves, Shift+Enter inserts a newline. Esc cancels. Mirrors
          // the inline-edit pattern in the rest of the app.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSave()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        className="w-full p-2 text-sm bg-bg-default border border-border-hint resize-none text-fg-contrast leading-[1.5]"
        rows={4}
      />
      <div className="flex gap-1 justify-end">
        <button
          onClick={onCancel}
          className="px-2 py-0.5 text-[10px] text-fg-dim hover:text-fg-contrast"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          className="px-2 py-0.5 text-[10px] bg-success text-white hover:opacity-90"
        >
          Save
        </button>
      </div>
    </div>
  )
}

function CoverageDot({ score }: { score: number }) {
  // Same three-tier scheme as the CoverageMap header dot, the charter
  // dimension chips, etc. Keeps the visual language consistent.
  const cls = score >= 0.8 ? 'bg-success' : score >= 0.4 ? 'bg-warning' : 'bg-danger'
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />
}

function StatusDot({ status }: { status: Example['review_status'] }) {
  const color =
    status === 'approved'
      ? 'bg-success'
      : status === 'rejected'
        ? 'bg-danger'
        : status === 'needs_edit'
          ? 'bg-warning'
          : 'bg-gray-500'
  return <span className={`w-2 h-2 rounded-full ${color}`} />
}

function RevisionDiff({ label, before, after }: { label: string; before: string; after: string }) {
  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
  return (
    <div>
      <div className="text-[10px] text-fg-dim mb-1 font-medium">{label}</div>
      <div className="text-xs bg-bg-default p-2 border border-border-hint">
        {after !== before ? (
          <>
            <div className="text-danger/60 line-through mb-1">{truncate(before, 300)}</div>
            <div className="text-success">{truncate(after, 300)}</div>
          </>
        ) : (
          <span className="text-fg-dim">No changes</span>
        )}
      </div>
    </div>
  )
}
