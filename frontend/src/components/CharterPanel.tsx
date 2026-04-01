import { useState } from 'react'
import { Plus, Circle, Loader2 } from 'lucide-react'
import type { Charter, Validation, DimensionStatus, AlignmentEntry, Suggestion, TaskDefinition, TaskEntry } from '../types'
import RadarChart from './RadarChart'

interface Props {
  charter: Charter
  validation: Validation
  activeCriteria: string[]
  onEditCriterion?: (dimension: string, index: number, value: string) => void
  onAddCriterion?: (dimension: string, value: string) => void
  onEditAlignment?: (index: number, field: 'good' | 'bad', value: string) => void
  onAddAlignment?: (entry: { feature_area: string; good: string; bad: string }) => void
  onEditTask?: (field: keyof TaskDefinition, value: string) => void
  onEditTaskEntry?: (side: 'input' | 'output', index: number, entry: TaskEntry) => void
  onAddTaskEntry?: (side: 'input' | 'output', entry: TaskEntry) => void
  onDeleteTaskEntry?: (side: 'input' | 'output', index: number) => void
  suggestions?: Suggestion[]
  onAcceptSuggestion?: (suggestion: Suggestion) => void
  onDismissSuggestion?: (suggestion: Suggestion) => void
  loading?: boolean
  hasSession?: boolean
  onSectionClick?: (section: string) => void
  softOkThreshold?: number // 0-100, default 70
}

// --- Helpers ---

function validationToPercent(status: string, dimensionStatus: DimensionStatus, criteriaCount: number): number {
  if (criteriaCount === 0) return 0
  const s = status !== 'untested' ? status : dimensionStatus
  if (s === 'pass' || s === 'good') return 100
  if (s === 'weak') return 50
  if (s === 'fail') return 15
  // pending with items
  return criteriaCount > 0 ? 30 : 0
}

function percentToActionText(pct: number): string {
  if (pct >= 100) return 'Complete'
  if (pct >= 70) return 'Almost there'
  if (pct >= 40) return 'Needs refinement'
  if (pct > 0) return 'Needs work'
  return 'Not started'
}

function percentToColor(pct: number): string {
  if (pct >= 100) return 'bg-success'
  if (pct >= 70) return 'bg-accent'
  if (pct >= 40) return 'bg-warning'
  return 'bg-danger'
}

// --- Main Component ---

export default function CharterPanel({
  charter,
  validation,
  activeCriteria,
  onEditCriterion,
  onAddCriterion,
  onEditAlignment,
  onAddAlignment,
  onEditTask,
  onEditTaskEntry,
  onAddTaskEntry,
  onDeleteTaskEntry,
  suggestions = [],
  onAcceptSuggestion,
  onDismissSuggestion,
  loading,
  hasSession,
  onSectionClick,
  softOkThreshold = 70,
}: Props) {
  const isEmpty = !charter.coverage.criteria.length
    && !charter.balance.criteria.length
    && !charter.alignment.length
    && !charter.rot.criteria.length

  const coverageSuggestions = suggestions.filter(s => s.section === 'coverage')
  const balanceSuggestions = suggestions.filter(s => s.section === 'balance')
  const alignmentSuggestions = suggestions.filter(s => s.section === 'alignment')
  const rotSuggestions = suggestions.filter(s => s.section === 'rot')

  // Percentages for each section
  const coveragePct = validationToPercent(validation.coverage, charter.coverage.status, charter.coverage.criteria.length)
  const balancePct = validationToPercent(validation.balance, charter.balance.status, charter.balance.criteria.length)
  const rotPct = validationToPercent(validation.rot, charter.rot.status, charter.rot.criteria.length)

  // Alignment percentage
  const alignPassCount = validation.alignment.filter(v => v.status === 'pass').length
  const alignTotal = charter.alignment.length
  const alignmentPct = alignTotal === 0 ? 0 : Math.round((alignPassCount / alignTotal) * 100)

  return (
    <div className="flex-1 overflow-hidden min-w-0 flex flex-col">
      {isEmpty && suggestions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-xs">
            <p className="text-sm text-muted-foreground">
              Charter will be generated from your discovery inputs.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {/* Loading indicator */}
          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span className="text-xs">Evaluating charter...</span>
            </div>
          )}

          {/* --- Radar Chart Overview --- */}
          <div className="flex justify-center">
            <RadarChart
              points={[
                { label: 'Coverage', value: coveragePct },
                { label: 'Balance', value: balancePct },
                { label: 'Alignment', value: alignmentPct },
                { label: 'Rot', value: rotPct },
              ]}
              threshold={softOkThreshold}
              size={220}
            />
          </div>

          {/* --- Task Definition --- */}
          <TaskSection
            task={charter.task}
            onEdit={onEditTask}
            onEditEntry={onEditTaskEntry}
            onAddEntry={onAddTaskEntry}
            onDeleteEntry={onDeleteTaskEntry}
          />

          {/* --- Coverage --- */}
          <DimensionSection
            name="Coverage"
            description="Input scenarios to test"
            criteria={charter.coverage.criteria}
            percent={coveragePct}
            softOkThreshold={softOkThreshold}
            activeCriteria={activeCriteria}
            dimension="coverage"
            onEdit={onEditCriterion}
            onAdd={onAddCriterion}
            suggestions={coverageSuggestions}
            onAcceptSuggestion={onAcceptSuggestion}
            onDismissSuggestion={onDismissSuggestion}
            onHeaderClick={onSectionClick ? () => onSectionClick('coverage') : undefined}
          />

          {/* --- Balance --- */}
          <DimensionSection
            name="Balance"
            description="What to weight more heavily"
            criteria={charter.balance.criteria}
            percent={balancePct}
            softOkThreshold={softOkThreshold}
            activeCriteria={activeCriteria}
            dimension="balance"
            onEdit={onEditCriterion}
            onAdd={onAddCriterion}
            suggestions={balanceSuggestions}
            onAcceptSuggestion={onAcceptSuggestion}
            onDismissSuggestion={onDismissSuggestion}
            onHeaderClick={onSectionClick ? () => onSectionClick('balance') : undefined}
          />

          {/* --- Alignment --- */}
          <AlignmentSection
            entries={charter.alignment}
            validations={validation.alignment}
            percent={alignmentPct}
            softOkThreshold={softOkThreshold}
            activeCriteria={activeCriteria}
            onEdit={onEditAlignment}
            onAdd={onAddAlignment}
            suggestions={alignmentSuggestions}
            onAcceptSuggestion={onAcceptSuggestion}
            onDismissSuggestion={onDismissSuggestion}
            onHeaderClick={onSectionClick ? () => onSectionClick('alignment') : undefined}
          />

          {/* --- Rot --- */}
          <DimensionSection
            name="Rot"
            description="When to update"
            criteria={charter.rot.criteria}
            percent={rotPct}
            softOkThreshold={softOkThreshold}
            activeCriteria={activeCriteria}
            dimension="rot"
            onEdit={onEditCriterion}
            onAdd={onAddCriterion}
            suggestions={rotSuggestions}
            onAcceptSuggestion={onAcceptSuggestion}
            onDismissSuggestion={onDismissSuggestion}
            onHeaderClick={onSectionClick ? () => onSectionClick('rot') : undefined}
          />
        </div>
      )}
    </div>
  )
}

// --- Progress Bar ---

function ProgressBar({ percent, softOkThreshold }: { percent: number; softOkThreshold: number }) {
  return (
    <div className="relative h-1.5 bg-border rounded-full overflow-visible">
      {/* Fill */}
      <div
        className={`h-full rounded-full transition-all duration-500 ${percentToColor(percent)}`}
        style={{ width: `${Math.min(percent, 100)}%` }}
      />
      {/* Soft OK threshold marker */}
      <div
        className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-muted-foreground/40 rounded-full"
        style={{ left: `${softOkThreshold}%` }}
        title={`Soft OK threshold: ${softOkThreshold}%`}
      />
    </div>
  )
}

// --- Task Section ---

function TaskSection({
  task,
  onEdit,
  onEditEntry,
  onAddEntry,
  onDeleteEntry,
}: {
  task: TaskDefinition
  onEdit?: (field: keyof TaskDefinition, value: string) => void
  onEditEntry?: (side: 'input' | 'output', index: number, entry: TaskEntry) => void
  onAddEntry?: (side: 'input' | 'output', entry: TaskEntry) => void
  onDeleteEntry?: (side: 'input' | 'output', index: number) => void
}) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
        Task Definition
      </h3>
      <div className="grid grid-cols-2 gap-6">
        <TaskSide
          label="Input"
          description={task.input_description}
          descriptionPlaceholder="What does your app receive?"
          entries={task.input_entries || (task.sample_input ? [{ label: 'Sample', content: task.sample_input }] : [])}
          onEditDescription={onEdit ? (v) => onEdit('input_description', v) : undefined}
          onEditEntry={onEditEntry ? (i, e) => onEditEntry('input', i, e) : undefined}
          onAddEntry={onAddEntry ? (e) => onAddEntry('input', e) : undefined}
          onDeleteEntry={onDeleteEntry ? (i) => onDeleteEntry('input', i) : undefined}
        />
        <TaskSide
          label="Output"
          description={task.output_description}
          descriptionPlaceholder="What does your app produce?"
          entries={task.output_entries || (task.sample_output ? [{ label: 'Sample', content: task.sample_output }] : [])}
          onEditDescription={onEdit ? (v) => onEdit('output_description', v) : undefined}
          onEditEntry={onEditEntry ? (i, e) => onEditEntry('output', i, e) : undefined}
          onAddEntry={onAddEntry ? (e) => onAddEntry('output', e) : undefined}
          onDeleteEntry={onDeleteEntry ? (i) => onDeleteEntry('output', i) : undefined}
        />
      </div>
    </section>
  )
}

function TaskSide({
  label,
  description,
  descriptionPlaceholder,
  entries,
  onEditDescription,
  onEditEntry,
  onAddEntry,
  onDeleteEntry,
}: {
  label: string
  description: string
  descriptionPlaceholder: string
  entries: TaskEntry[]
  onEditDescription?: (v: string) => void
  onEditEntry?: (index: number, entry: TaskEntry) => void
  onAddEntry?: (entry: TaskEntry) => void
  onDeleteEntry?: (index: number) => void
}) {
  const [editingDesc, setEditingDesc] = useState(false)
  const [descText, setDescText] = useState(description)
  const [showAdd, setShowAdd] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newContent, setNewContent] = useState('')

  const handleSaveDesc = () => {
    setEditingDesc(false)
    if (descText !== description && onEditDescription) onEditDescription(descText)
  }

  const handleAddEntry = () => {
    if (newContent.trim() && onAddEntry) {
      onAddEntry({ label: newLabel.trim() || 'Sample', content: newContent.trim() })
      setNewLabel('')
      setNewContent('')
      setShowAdd(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-foreground">{label}</span>
        {onAddEntry && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 text-xs text-accent hover:text-accent/80"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
        )}
      </div>

      {/* Description */}
      {editingDesc ? (
        <div className="mb-2">
          <textarea
            value={descText}
            onChange={e => setDescText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { setDescText(description); setEditingDesc(false) }
            }}
            autoFocus
            placeholder={descriptionPlaceholder}
            className="w-full border border-accent rounded px-2 py-1.5 bg-background text-foreground text-xs focus:outline-none focus:ring-1 focus:ring-accent"
            rows={3}
          />
          <div className="flex gap-1.5 mt-1">
            <button
              onClick={handleSaveDesc}
              className="px-2 py-0.5 text-xs bg-accent text-accent-foreground rounded hover:opacity-90"
            >
              Save
            </button>
            <button
              onClick={() => { setDescText(description); setEditingDesc(false) }}
              className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div
          onClick={() => onEditDescription && setEditingDesc(true)}
          className={`text-xs mb-2 ${description ? 'text-foreground/80' : 'text-muted-foreground italic'} ${onEditDescription ? 'cursor-pointer hover:bg-accent/5 rounded px-1 -mx-1 py-0.5' : ''}`}
        >
          {description || descriptionPlaceholder}
        </div>
      )}

      {/* Entries */}
      <div className="space-y-1.5">
        {entries.map((entry, i) => (
          <EntryItem
            key={i}
            entry={entry}
            onEdit={onEditEntry ? (e) => onEditEntry(i, e) : undefined}
            onDelete={onDeleteEntry ? () => onDeleteEntry(i) : undefined}
          />
        ))}
      </div>

      {/* Add entry form */}
      {showAdd && (
        <div className="mt-2 p-2 rounded bg-surface border border-border space-y-1.5">
          <input
            autoFocus
            className="w-full text-xs bg-transparent border-b border-border focus:border-accent outline-none pb-1"
            placeholder="Label (e.g. JSON schema, sample, API spec...)"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
          />
          <textarea
            className="w-full text-xs bg-transparent border border-border rounded px-2 py-1.5 focus:border-accent outline-none font-mono"
            placeholder="Content..."
            rows={3}
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && e.metaKey) handleAddEntry()
              if (e.key === 'Escape') { setShowAdd(false); setNewLabel(''); setNewContent('') }
            }}
          />
          <div className="flex gap-1.5">
            <button onClick={handleAddEntry} className="px-2 py-0.5 text-xs bg-accent text-accent-foreground rounded hover:opacity-90">
              Add
            </button>
            <button onClick={() => { setShowAdd(false); setNewLabel(''); setNewContent('') }} className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function EntryItem({
  entry,
  onEdit,
  onDelete,
}: {
  entry: TaskEntry
  onEdit?: (entry: TaskEntry) => void
  onDelete?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [content, setContent] = useState(entry.content)
  const [label, setLabel] = useState(entry.label)

  const handleSave = () => {
    setEditing(false)
    if ((content !== entry.content || label !== entry.label) && onEdit) {
      onEdit({ label: label.trim() || entry.label, content })
    }
  }

  if (editing) {
    return (
      <div className="p-2 rounded bg-surface border border-accent/30 space-y-1">
        <input
          className="w-full text-xs bg-transparent border-b border-accent outline-none pb-1"
          value={label}
          onChange={e => setLabel(e.target.value)}
        />
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          onBlur={handleSave}
          onKeyDown={e => {
            if (e.key === 'Enter' && e.metaKey) handleSave()
            if (e.key === 'Escape') { setContent(entry.content); setLabel(entry.label); setEditing(false) }
          }}
          autoFocus
          className="w-full text-xs font-mono bg-transparent border border-border rounded px-2 py-1 focus:border-accent outline-none"
          rows={3}
        />
      </div>
    )
  }

  return (
    <div
      onClick={() => onEdit && setEditing(true)}
      className={`group p-2 rounded bg-surface text-xs ${onEdit ? 'cursor-pointer hover:bg-surface-raised' : ''}`}
    >
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-muted-foreground font-medium">{entry.label}</span>
        {onDelete && (
          <button
            onClick={e => { e.stopPropagation(); onDelete() }}
            className="text-muted-foreground hover:text-danger opacity-0 group-hover:opacity-100 text-xs"
          >
            remove
          </button>
        )}
      </div>
      <pre className="text-foreground/80 font-mono whitespace-pre-wrap break-words text-[11px] leading-relaxed max-h-24 overflow-hidden">
        {entry.content}
      </pre>
    </div>
  )
}

// --- Dimension Section ---

function DimensionSection({
  name,
  description,
  criteria,
  percent,
  softOkThreshold,
  activeCriteria,
  dimension,
  onEdit,
  onAdd,
  suggestions = [],
  onAcceptSuggestion,
  onDismissSuggestion,
  onHeaderClick,
}: {
  name: string
  description: string
  criteria: string[]
  percent: number
  softOkThreshold: number
  activeCriteria: string[]
  dimension: string
  onEdit?: (dimension: string, index: number, value: string) => void
  onAdd?: (dimension: string, value: string) => void
  suggestions?: Suggestion[]
  onAcceptSuggestion?: (s: Suggestion) => void
  onDismissSuggestion?: (s: Suggestion) => void
  onHeaderClick?: () => void
}) {
  const [showAdd, setShowAdd] = useState(false)
  const [newValue, setNewValue] = useState('')
  const actionText = percentToActionText(percent)

  const handleAdd = () => {
    if (newValue.trim() && onAdd) {
      onAdd(dimension, newValue.trim())
      setNewValue('')
      setShowAdd(false)
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-1.5">
        <div
          onClick={onHeaderClick}
          className={onHeaderClick ? 'cursor-pointer hover:text-accent transition-colors' : ''}
          title={onHeaderClick ? 'Click to discuss in chat' : undefined}
        >
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">{name}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="text-right flex-shrink-0 ml-4">
          <span className="text-xs font-medium text-foreground">{percent}%</span>
          <span className="text-xs text-muted-foreground ml-1.5">{actionText}</span>
        </div>
      </div>

      <ProgressBar percent={percent} softOkThreshold={softOkThreshold} />

      <div className="mt-3 space-y-1">
        {criteria.map((criterion, i) => {
          const isActive = activeCriteria.includes(`${dimension}_${i}`)
          return (
            <CriterionRow
              key={i}
              text={criterion}
              active={isActive}
              onEdit={onEdit ? (v) => onEdit(dimension, i, v) : undefined}
            />
          )
        })}

        {suggestions.map((s, i) => (
          <SuggestionRow
            key={`sug-${i}`}
            suggestion={s}
            onAccept={onAcceptSuggestion}
            onDismiss={onDismissSuggestion}
          />
        ))}

        {/* Add button */}
        {showAdd ? (
          <div className="flex items-start gap-2 pl-2 py-1">
            <Circle className="w-1.5 h-1.5 mt-2 text-muted-foreground fill-current flex-shrink-0" />
            <div className="flex-1">
              <textarea
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAdd() }
                  if (e.key === 'Escape') { setShowAdd(false); setNewValue('') }
                }}
                autoFocus
                placeholder={`Add a ${name.toLowerCase()} criterion...`}
                className="w-full text-sm border border-accent rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                rows={2}
              />
            </div>
          </div>
        ) : onAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 pl-2 py-1 text-xs text-accent hover:text-accent/80"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
        )}
      </div>
    </section>
  )
}

// --- Alignment Section ---

function AlignmentSection({
  entries,
  validations,
  percent,
  softOkThreshold,
  activeCriteria,
  onEdit,
  onAdd,
  suggestions = [],
  onAcceptSuggestion,
  onDismissSuggestion,
  onHeaderClick,
}: {
  entries: AlignmentEntry[]
  validations: { feature_area: string; status: string; weak_reason: string | null }[]
  percent: number
  softOkThreshold: number
  activeCriteria: string[]
  onEdit?: (index: number, field: 'good' | 'bad', value: string) => void
  onAdd?: (entry: { feature_area: string; good: string; bad: string }) => void
  suggestions?: Suggestion[]
  onAcceptSuggestion?: (s: Suggestion) => void
  onDismissSuggestion?: (s: Suggestion) => void
  onHeaderClick?: () => void
}) {
  const [showAdd, setShowAdd] = useState(false)
  const [newArea, setNewArea] = useState('')
  const [newGood, setNewGood] = useState('')
  const [newBad, setNewBad] = useState('')
  const actionText = percentToActionText(percent)

  const handleAdd = () => {
    if (newArea.trim() && newGood.trim() && newBad.trim() && onAdd) {
      onAdd({ feature_area: newArea.trim(), good: newGood.trim(), bad: newBad.trim() })
      setNewArea(''); setNewGood(''); setNewBad('')
      setShowAdd(false)
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-1.5">
        <div
          onClick={onHeaderClick}
          className={onHeaderClick ? 'cursor-pointer hover:text-accent transition-colors' : ''}
          title={onHeaderClick ? 'Click to discuss in chat' : undefined}
        >
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Alignment</h3>
          <p className="text-xs text-muted-foreground">What good vs bad looks like</p>
        </div>
        <div className="text-right flex-shrink-0 ml-4">
          <span className="text-xs font-medium text-foreground">{percent}%</span>
          <span className="text-xs text-muted-foreground ml-1.5">{actionText}</span>
        </div>
      </div>

      <ProgressBar percent={percent} softOkThreshold={softOkThreshold} />

      <div className="mt-3 space-y-2">
        {entries.map((entry, i) => {
          const val = validations.find(v => v.feature_area === entry.feature_area)
          const isActive = activeCriteria.includes(`alignment_${entry.feature_area}`)
          return (
            <AlignmentRow
              key={i}
              entry={entry}
              validation={val}
              active={isActive}
              onEdit={onEdit ? (field, value) => onEdit(i, field, value) : undefined}
            />
          )
        })}

        {suggestions.map((s, i) => (
          <SuggestionRow
            key={`sug-${i}`}
            suggestion={s}
            onAccept={onAcceptSuggestion}
            onDismiss={onDismissSuggestion}
          />
        ))}

        {/* Add button */}
        {showAdd ? (
          <div className="p-2 rounded bg-surface border border-accent/30 space-y-1.5">
            <input
              autoFocus
              className="w-full text-sm bg-transparent border-b border-border focus:border-accent outline-none pb-1"
              placeholder="Feature area..."
              value={newArea}
              onChange={e => setNewArea(e.target.value)}
            />
            <input
              className="w-full text-xs bg-transparent border-b border-border focus:border-accent outline-none pb-1 text-success"
              placeholder="What good looks like..."
              value={newGood}
              onChange={e => setNewGood(e.target.value)}
            />
            <input
              className="w-full text-xs bg-transparent border-b border-border focus:border-accent outline-none pb-1 text-danger"
              placeholder="What bad looks like..."
              value={newBad}
              onChange={e => setNewBad(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleAdd()
                if (e.key === 'Escape') { setShowAdd(false); setNewArea(''); setNewGood(''); setNewBad('') }
              }}
            />
            <div className="flex gap-1.5">
              <button onClick={handleAdd} className="px-2 py-0.5 text-xs bg-accent text-accent-foreground rounded hover:opacity-90">Add</button>
              <button onClick={() => { setShowAdd(false); setNewArea(''); setNewGood(''); setNewBad('') }} className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
            </div>
          </div>
        ) : onAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 pl-2 py-1 text-xs text-accent hover:text-accent/80"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
        )}
      </div>
    </section>
  )
}

// --- Shared Sub-components ---

function SuggestionRow({
  suggestion,
  onAccept,
  onDismiss,
}: {
  suggestion: Suggestion
  onAccept?: (s: Suggestion) => void
  onDismiss?: (s: Suggestion) => void
}) {
  return (
    <div className="flex items-start gap-2 py-1.5 px-2 bg-accent/5 rounded">
      <span className="text-accent font-bold text-xs mt-0.5">+</span>
      <span className="flex-1 text-sm text-foreground">
        {suggestion.text}
        {suggestion.good && (
          <span className="block text-xs text-muted-foreground mt-0.5">
            Good: {suggestion.good} / Bad: {suggestion.bad}
          </span>
        )}
      </span>
      <div className="flex gap-1 flex-shrink-0">
        <button
          onClick={() => onAccept?.(suggestion)}
          className="text-xs px-2 py-0.5 bg-accent/20 text-accent rounded hover:bg-accent/30 font-medium"
        >
          Add
        </button>
        <button
          onClick={() => onDismiss?.(suggestion)}
          className="text-xs px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
        >
          dismiss
        </button>
      </div>
    </div>
  )
}

function CriterionRow({
  text,
  active,
  onEdit,
}: {
  text: string
  active: boolean
  onEdit?: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(text)

  const handleBlur = () => {
    setEditing(false)
    if (value !== text && onEdit) onEdit(value)
  }

  return (
    <div className={`flex items-start gap-2 pl-2 py-1 group ${active ? 'bg-accent/5 rounded' : ''}`}>
      <Circle className="w-1.5 h-1.5 mt-2 text-muted-foreground fill-current flex-shrink-0" />
      {editing ? (
        <textarea
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleBlur() }
            if (e.key === 'Escape') { setValue(text); setEditing(false) }
          }}
          autoFocus
          className="flex-1 text-sm border border-accent rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
          rows={2}
        />
      ) : (
        <span
          onClick={() => onEdit && setEditing(true)}
          className={`flex-1 text-sm text-foreground/80 ${onEdit ? 'cursor-pointer hover:bg-accent/5 rounded px-1 -mx-1' : ''}`}
        >
          {text}
        </span>
      )}
    </div>
  )
}

function AlignmentRow({
  entry,
  validation,
  active,
  onEdit,
}: {
  entry: AlignmentEntry
  validation?: { status: string; weak_reason: string | null }
  active: boolean
  onEdit?: (field: 'good' | 'bad', value: string) => void
}) {
  const [showDetail, setShowDetail] = useState(false)

  return (
    <div className={`pl-2 py-1 ${active ? 'bg-accent/5 rounded' : ''}`}>
      <div className="flex items-center gap-2">
        <Circle className="w-1.5 h-1.5 text-muted-foreground fill-current flex-shrink-0" />
        <span className="text-sm font-medium text-foreground">{entry.feature_area}</span>
        {validation?.weak_reason && (
          <button
            onClick={() => setShowDetail(!showDetail)}
            className="text-xs text-warning hover:opacity-80"
          >
            why?
          </button>
        )}
      </div>

      {showDetail && validation?.weak_reason && (
        <div className="ml-4 mt-1 p-2 bg-warning/10 rounded text-xs text-warning">
          {validation.weak_reason}
        </div>
      )}

      <div className="ml-4 mt-1 space-y-1">
        <EditableField label="Good" value={entry.good} color="text-success" onSave={v => onEdit?.('good', v)} />
        <EditableField label="Bad" value={entry.bad} color="text-danger" onSave={v => onEdit?.('bad', v)} />
      </div>
    </div>
  )
}

function EditableField({
  label,
  value,
  color,
  onSave,
}: {
  label: string
  value: string
  color: string
  onSave?: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)

  const handleBlur = () => {
    setEditing(false)
    if (text !== value && onSave) onSave(text)
  }

  return (
    <div className="text-xs">
      <span className={`font-medium ${color}`}>{label}:</span>{' '}
      {editing ? (
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleBlur() }
            if (e.key === 'Escape') { setText(value); setEditing(false) }
          }}
          autoFocus
          className="w-full border border-accent rounded px-1 py-0.5 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-accent text-xs"
          rows={2}
        />
      ) : (
        <span
          onClick={() => onSave && setEditing(true)}
          className={`text-muted-foreground ${onSave ? 'cursor-pointer hover:bg-accent/5 rounded px-0.5' : ''}`}
        >
          {value}
        </span>
      )}
    </div>
  )
}
