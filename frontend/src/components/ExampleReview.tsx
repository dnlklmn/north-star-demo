import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { ChevronDown, ChevronRight, Check, X, RefreshCw, Pencil, Trash2 } from 'lucide-react'
import type { Example, Charter } from '../types'
import DeleteModal from './examples/DeleteModal'
import GenerateModal from './examples/GenerateModal'

// Persisted preference: when true, technical-detail fields (judge confidence,
// judge reasoning/issues, router verdict, full coverage tag list, raw
// feature_area, should_trigger flags) collapse behind a per-row "Show details"
// disclosure. PMs landing on this screen shouldn't have to decode our schema
// to review examples; engineers can flip it off to see everything inline.
const PM_MODE_STORAGE_KEY = 'northstar.pm_mode'

function readPmModePref(): boolean {
  if (typeof window === 'undefined') return true
  const v = window.localStorage.getItem(PM_MODE_STORAGE_KEY)
  // Default to PM-friendly. Only an explicit "false" opts out.
  return v !== 'false'
}

function writePmModePref(v: boolean) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PM_MODE_STORAGE_KEY, v ? 'true' : 'false')
}

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
  onUpdateExample: (exampleId: string, fields: Partial<Example>) => void
  onDeleteExample: (exampleId: string) => void
  onSynthesize: (count?: number) => void
  onAutoReview: () => void
  onExport: () => void
  onShowCoverageMap: () => void
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
}

export default function ExampleReview({
  examples,
  charter,
  loading,
  onUpdateExample,
  onDeleteExample,
  onSynthesize,
  onAutoReview,
  onExport,
  onShowCoverageMap,
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
}: ExampleReviewProps) {
  const [filterArea, setFilterArea] = useState<string>('')
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
  const [focusedCell, setFocusedCell] = useState<CellId>('status')
  const [pmMode, setPmMode] = useState<boolean>(() => readPmModePref())
  // When the user explicitly opens "Show details" on a row, remember it so
  // navigating away and back doesn't slam it shut again. Keyed by example id.
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({})
  const togglePmMode = useCallback(() => {
    setPmMode(prev => {
      const next = !prev
      writePmModePref(next)
      return next
    })
  }, [])
  const toggleDetailsFor = useCallback((id: string) => {
    setOpenDetails(prev => ({ ...prev, [id]: !prev[id] }))
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

  const filtered = useMemo(
    () =>
      examples.filter(ex => {
        if (filterArea && ex.feature_area !== filterArea) return false
        if (filterLabel && ex.label !== filterLabel) return false
        if (filterStatus && ex.review_status !== filterStatus) return false
        return true
      }),
    [examples, filterArea, filterLabel, filterStatus],
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

  const examplesWithIssues = examples.filter(
    ex => ex.judge_verdict?.issues && ex.judge_verdict.issues.length > 0 && !ex.revision_suggestion,
  ).length

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
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
    [editingId, deleteConfirmId, selectedIndex, orderedExamples, selectedExample, focusedCell, onUpdateExample, onSuggestRevision, beginEdit],
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
    <div className="h-full flex flex-col overflow-hidden">
      {/* Page body — title + filters + grouped table */}
      <div className="flex-1 min-h-0 flex flex-col gap-6 p-6 overflow-hidden">
        {/* Title */}
        <h1 className="text-xl font-semibold text-fg-contrast leading-none">Dataset</h1>

        {/* Stats + dataset-level utilities (Coverage map / Export / Auto-review /
            Suggest revisions / Generate). Sits directly under the title — these
            are about the dataset as a whole. Filters and per-row actions live
            in a second toolbar below. */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs text-fg-dim">
            {stats.total} total · {stats.pending} pending · {stats.approved} approved
            {stats.newSinceRefresh > 0 && (
              <>
                {' · '}
                <span className="text-accent font-medium">{stats.newSinceRefresh} new</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onShowCoverageMap}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-fg-dim hover:text-fg-contrast border border-border-hint transition-colors"
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
                title="Re-tag every row's feature area and scenarios covered against the current charter. Useful after generating or editing the charter so the Coverage Map matrix lines up."
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
              options={featureAreas.map(a => ({ value: a, label: a }))}
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
            <DetailsToggle pmMode={pmMode} onToggle={togglePmMode} />
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

        {/* Grouped list */}
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0">
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
                        pmMode={pmMode}
                        detailsOpen={openDetails[ex.id] ?? !pmMode}
                        onToggleDetails={() => toggleDetailsFor(ex.id)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
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
  return (
    <div className="px-4 py-2 bg-gray-200">
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
  pmMode,
  detailsOpen,
  onToggleDetails,
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
  pmMode: boolean
  detailsOpen: boolean
  onToggleDetails: () => void
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

  // Scenario column: prefer first coverage tag, fall back to feature_area
  const scenarioText = example.coverage_tags[0] || example.feature_area

  return (
    <>
      <div
        ref={rowRef}
        onClick={onSelect}
        className={[
          'flex items-stretch gap-4 px-4 py-4 cursor-pointer transition-colors max-h-[480px]',
          isSelected
            ? 'bg-bg-default outline outline-2 outline-border-primary -outline-offset-2'
            : 'bg-gray-150 hover:bg-fill-neutral-hover',
        ].join(' ')}
      >
        {/* Scenario */}
        <div
          onClick={e => { e.stopPropagation(); onCellSelect('scenario') }}
          className={`flex-1 basis-0 self-stretch p-px overflow-hidden ${cellCls('scenario')}`}
        >
          <div className="h-full p-2 flex flex-col gap-1 overflow-y-auto">
            <div className="text-sm text-fg-contrast leading-[1.5]">{scenarioText}</div>
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

      {/* Details disclosure (plain-English view of the technical fields) */}
      {isSelected && (
        <DetailsPanel
          example={example}
          pmMode={pmMode}
          open={detailsOpen}
          onToggle={onToggleDetails}
        />
      )}

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

function DetailsToggle({ pmMode, onToggle }: { pmMode: boolean; onToggle: () => void }) {
  // Two-segment pill mirroring the rest of the toolbar's filled/outline
  // styling. Active segment uses bg-fill-neutral; inactive is transparent.
  const seg = (active: boolean) =>
    `h-10 px-3 text-sm font-mono font-semibold transition-colors ${
      active
        ? 'bg-fill-neutral text-fg-contrast'
        : 'bg-transparent text-fg-dim hover:text-fg-contrast'
    }`
  return (
    <div
      className="inline-flex items-center border border-border-hint"
      title="Hide or show the technical fields (judge confidence, judge reasoning, router check, full scenario tags). PMs can leave these hidden; engineers debugging the dataset can flip them on."
    >
      <span className="px-3 text-xs text-fg-dim border-r border-border-hint h-10 inline-flex items-center">
        Technical details
      </span>
      <button onClick={() => { if (pmMode) return; onToggle() }} className={seg(pmMode)}>
        Hidden
      </button>
      <button onClick={() => { if (!pmMode) return; onToggle() }} className={seg(!pmMode)}>
        Shown
      </button>
    </div>
  )
}

function DetailsPanel({
  example,
  pmMode,
  open,
  onToggle,
}: {
  example: Example
  pmMode: boolean
  open: boolean
  onToggle: () => void
}) {
  const v = example.judge_verdict ?? null
  const tv = v?.trigger_verdict ?? null
  const hasJudge = !!(v && (v.confidence || v.reasoning || (v.issues && v.issues.length > 0)))
  const hasRouter = !!tv
  const hasTags = (example.coverage_tags?.length ?? 0) > 0
  const hasTrigger = example.should_trigger === true || example.should_trigger === false
  const hasArea = !!example.feature_area
  const hasAdv = example.is_adversarial === true

  // If literally nothing populates, don't render the panel at all — empty
  // disclosures are noise.
  const anything = hasJudge || hasRouter || hasTags || hasTrigger || hasArea || hasAdv
  if (!anything) return null

  // PM-mode default: collapsed, with a subtle "Show details" affordance.
  // Engineers (PM mode off) get it expanded, but they can still collapse.
  const showHeader = pmMode || !open
  return (
    <div className="px-4 py-2 bg-fill-neutral/40 border-l-2 border-l-border-hint">
      {showHeader ? (
        <button
          onClick={onToggle}
          className="text-[11px] text-fg-dim hover:text-fg-contrast inline-flex items-center gap-1"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {open ? 'Hide details' : 'Show details'}
        </button>
      ) : (
        <button
          onClick={onToggle}
          className="text-[11px] text-fg-dim hover:text-fg-contrast inline-flex items-center gap-1"
        >
          <ChevronDown className="w-3 h-3" /> Hide details
        </button>
      )}

      {open && (
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
          {hasArea && <DetailRow label="Feature area" value={example.feature_area} />}
          {hasTrigger && (
            <DetailRow
              label="Should trigger?"
              value={example.should_trigger ? 'Yes — the feature should fire on this input' : 'No — the feature should NOT fire on this input'}
            />
          )}
          {hasAdv && (
            <DetailRow
              label="Adversarial probe"
              value="Yes — this row tests the feature's safety boundary (e.g. prompt injection)"
            />
          )}
          {hasTags && (
            <DetailRow
              label="Scenarios covered"
              value={
                <div className="flex gap-1 flex-wrap">
                  {example.coverage_tags.map((t, i) => (
                    <span key={i} className="px-1.5 py-0.5 bg-fill-neutral text-fg-dim border border-border-hint">
                      {t}
                    </span>
                  ))}
                </div>
              }
            />
          )}
          {v?.confidence && (
            <DetailRow
              label="Judge confidence"
              value={
                v.confidence === 'high'
                  ? 'High — the auto-reviewer is sure about its take on this row'
                  : v.confidence === 'medium'
                    ? 'Medium — the auto-reviewer has a take but isn’t certain'
                    : 'Low — the auto-reviewer is guessing; worth a human eye'
              }
            />
          )}
          {v?.reasoning && <DetailRow label="Judge says" value={v.reasoning} />}
          {v?.issues && v.issues.length > 0 && (
            <DetailRow
              label="Issues flagged"
              value={
                <ul className="list-disc pl-4 space-y-0.5 text-warning">
                  {v.issues.map((iss, i) => (
                    <li key={i}>{iss}</li>
                  ))}
                </ul>
              }
            />
          )}
          {tv && (
            <DetailRow
              label="Router check"
              value={`Expected to ${tv.expected_fire ? 'fire' : 'not fire'}; would actually ${tv.would_fire ? 'fire' : 'not fire'} — ${tv.correct ? 'correct' : 'wrong'}. ${tv.reasoning}`}
            />
          )}
        </div>
      )}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 col-span-2 sm:col-span-1">
      <span className="text-[10px] uppercase tracking-wide text-fg-dim">{label}</span>
      <span className="text-fg-contrast leading-[1.5]">{value}</span>
    </div>
  )
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
