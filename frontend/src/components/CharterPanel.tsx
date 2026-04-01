import { useState } from 'react'
import { ChevronRight, Circle, RefreshCw, Sparkles, Upload, Link, FileText, Wand2, X, Loader2, ShieldCheck, Plus } from 'lucide-react'
import type { Charter, Validation, DimensionStatus, AlignmentEntry, Suggestion, TaskDefinition, DetectSchemaResponse, ImportFromUrlResponse } from '../types'

interface Props {
  charter: Charter
  validation: Validation
  activeCriteria: string[]
  onEditCriterion?: (dimension: string, index: number, value: string) => void
  onAddCriterion?: (dimension: string, value: string) => void
  onEditAlignment?: (index: number, field: 'good' | 'bad', value: string) => void
  onEditTask?: (field: keyof TaskDefinition, value: string) => void
  suggestions?: Suggestion[]
  onAcceptSuggestion?: (suggestion: Suggestion) => void
  onDismissSuggestion?: (suggestion: Suggestion) => void
  onGenerate?: () => void
  onRegenerate?: () => void
  loading?: boolean
  hasSession?: boolean
  canGenerate?: boolean
  inputChanged?: boolean
  onValidate?: () => void
  onSuggest?: () => void
  onHeaderClick?: () => void
  isFocused?: boolean
  isCompact?: boolean
  // Schema detection props
  onDetectSchema?: (content: string, contentType: string) => Promise<DetectSchemaResponse>
  onImportFromUrl?: (url: string) => Promise<ImportFromUrlResponse>
  onApplyDetectedSchema?: (task: Partial<TaskDefinition>) => void
}

export default function CharterPanel({
  charter,
  validation,
  activeCriteria,
  onEditCriterion,
  onAddCriterion,
  onEditAlignment,
  onEditTask,
  suggestions = [],
  onAcceptSuggestion,
  onDismissSuggestion,
  onGenerate,
  onRegenerate,
  loading,
  hasSession,
  canGenerate = true,
  inputChanged = false,
  onHeaderClick,
  isFocused,
  isCompact,
  onValidate,
  onSuggest,
  onDetectSchema,
  onImportFromUrl,
  onApplyDetectedSchema,
}: Props) {
  const isEmpty = !charter.coverage.criteria.length
    && !charter.balance.criteria.length
    && !charter.alignment.length
    && !charter.rot.criteria.length

  const coverageSuggestions = suggestions.filter(s => s.section === 'coverage')
  const balanceSuggestions = suggestions.filter(s => s.section === 'balance')
  const alignmentSuggestions = suggestions.filter(s => s.section === 'alignment')
  const rotSuggestions = suggestions.filter(s => s.section === 'rot')

  return (
    <div className="flex-1 overflow-hidden min-w-0 flex flex-col">
      <div
        onClick={onHeaderClick}
        className={`px-4 h-12 border-b border-border bg-surface-raised flex-shrink-0 flex items-center justify-between ${
          isFocused ? '' : 'hover:bg-muted/50 cursor-pointer'
        }`}
      >
        <h2 className="text-sm font-semibold text-foreground">Charter</h2>
        {hasSession && !isEmpty && !isCompact && (
          <div className="flex items-center gap-2">
            {onSuggest && (
              <button
                onClick={(e) => { e.stopPropagation(); onSuggest(); }}
                disabled={loading}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50"
              >
                <Sparkles className="w-3 h-3" />
                Suggest
              </button>
            )}
            {onValidate && (
              <button
                onClick={(e) => { e.stopPropagation(); onValidate(); }}
                disabled={loading}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50"
              >
                <ShieldCheck className="w-3 h-3" />
                Validate
              </button>
            )}
            {onRegenerate && inputChanged && (
              <button
                onClick={(e) => { e.stopPropagation(); onRegenerate(); }}
                disabled={loading}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50"
              >
                <RefreshCw className="w-3 h-3" />
                Regenerate
              </button>
            )}
          </div>
        )}
      </div>

      {isEmpty && suggestions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-xs">
            <Sparkles className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground mb-4">
              Add your business goals and user stories, then generate a charter.
            </p>
            {onGenerate && (
              <>
                <button
                  onClick={onGenerate}
                  disabled={loading || !canGenerate}
                  className="px-6 py-2.5 bg-accent text-accent-foreground rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {loading ? 'Generating...' : 'Generate charter'}
                </button>
                {!canGenerate && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Add at least a business goal to get started.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 bg-surface space-y-3">
          <TaskSection
            task={charter.task}
            onEdit={onEditTask}
            onDetectSchema={onDetectSchema}
            onImportFromUrl={onImportFromUrl}
            onApplyDetectedSchema={onApplyDetectedSchema}
          />
          <DimensionSection
            name="Coverage"
            description="Input scenarios to test"
            criteria={charter.coverage.criteria}
            status={charter.coverage.status}
            validationStatus={validation.coverage}
            activeCriteria={activeCriteria}
            onEdit={onEditCriterion ? (i, v) => onEditCriterion('coverage', i, v) : undefined}
            onAdd={onAddCriterion ? (v) => onAddCriterion('coverage', v) : undefined}
            suggestions={coverageSuggestions}
            onAcceptSuggestion={onAcceptSuggestion}
            onDismissSuggestion={onDismissSuggestion}
          />
          <DimensionSection
            name="Balance"
            description="What to weight more heavily"
            criteria={charter.balance.criteria}
            status={charter.balance.status}
            validationStatus={validation.balance}
            activeCriteria={activeCriteria}
            onEdit={onEditCriterion ? (i, v) => onEditCriterion('balance', i, v) : undefined}
            onAdd={onAddCriterion ? (v) => onAddCriterion('balance', v) : undefined}
            suggestions={balanceSuggestions}
            onAcceptSuggestion={onAcceptSuggestion}
            onDismissSuggestion={onDismissSuggestion}
          />
          <AlignmentSection
            entries={charter.alignment}
            validations={validation.alignment}
            activeCriteria={activeCriteria}
            onEdit={onEditAlignment}
            suggestions={alignmentSuggestions}
            onAcceptSuggestion={onAcceptSuggestion}
            onDismissSuggestion={onDismissSuggestion}
          />
          <DimensionSection
            name="Rot"
            description="When to update"
            criteria={charter.rot.criteria}
            status={charter.rot.status}
            validationStatus={validation.rot}
            activeCriteria={activeCriteria}
            onEdit={onEditCriterion ? (i, v) => onEditCriterion('rot', i, v) : undefined}
            onAdd={onAddCriterion ? (v) => onAddCriterion('rot', v) : undefined}
            suggestions={rotSuggestions}
            onAcceptSuggestion={onAcceptSuggestion}
            onDismissSuggestion={onDismissSuggestion}
          />
        </div>
      )}
    </div>
  )
}

function completionLabel(status: DimensionStatus | string, validationStatus: string, criteriaCount: number): string {
  // If no criteria yet, show nothing
  if (criteriaCount === 0) return ''
  // Use validation status if available
  const s = validationStatus !== 'untested' ? validationStatus : status
  if (s === 'good' || s === 'pass') return 'complete'
  if (s === 'weak') return '~50%'
  if (s === 'fail') return 'needs work'
  // Fallback: show criteria count when validation hasn't run yet
  return `${criteriaCount} item${criteriaCount !== 1 ? 's' : ''}`
}

type ImportSource = 'paste' | 'url' | 'manual' | null

function TaskSection({
  task,
  onEdit,
  onDetectSchema,
  onImportFromUrl,
  onApplyDetectedSchema,
}: {
  task: TaskDefinition
  onEdit?: (field: keyof TaskDefinition, value: string) => void
  onDetectSchema?: (content: string, contentType: string) => Promise<DetectSchemaResponse>
  onImportFromUrl?: (url: string) => Promise<ImportFromUrlResponse>
  onApplyDetectedSchema?: (task: Partial<TaskDefinition>) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [importSource, setImportSource] = useState<ImportSource>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [pasteContent, setPasteContent] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const [detectedResult, setDetectedResult] = useState<{ input_description: string; sample_input: string } | null>(null)

  const hasContent = task.input_description || task.output_description
  const canImport = onDetectSchema || onImportFromUrl

  const handleDetectFromPaste = async () => {
    if (!onDetectSchema || !pasteContent.trim()) return
    setImporting(true)
    setImportError(null)
    try {
      const result = await onDetectSchema(pasteContent, 'auto')
      setDetectedResult({
        input_description: result.input_description,
        sample_input: result.sample_input,
      })
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to detect schema')
    } finally {
      setImporting(false)
    }
  }

  const handleImportFromUrl = async () => {
    if (!onImportFromUrl || !urlInput.trim()) return
    setImporting(true)
    setImportError(null)
    try {
      const result = await onImportFromUrl(urlInput)
      onApplyDetectedSchema?.(result.task)
      setImportSource(null)
      setUrlInput('')
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import from URL')
    } finally {
      setImporting(false)
    }
  }

  const handleApplyDetected = () => {
    if (detectedResult && onApplyDetectedSchema) {
      onApplyDetectedSchema({
        input_description: detectedResult.input_description,
        sample_input: detectedResult.sample_input,
      })
      setImportSource(null)
      setPasteContent('')
      setDetectedResult(null)
    }
  }

  const handleCancelImport = () => {
    setImportSource(null)
    setPasteContent('')
    setUrlInput('')
    setDetectedResult(null)
    setImportError(null)
  }

  return (
    <div className="border border-border rounded-lg bg-surface-raised">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors rounded-t-lg"
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <div>
            <h3 className="text-sm font-medium text-foreground text-left">Task Definition</h3>
            <p className="text-xs text-muted-foreground text-left">What your app receives and produces</p>
          </div>
        </div>
        {hasContent && (
          <span className="text-xs text-success">defined</span>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {/* Import Source Selector */}
          {canImport && !importSource && (
            <div className="flex items-center gap-2 py-2 border-b border-border mb-2">
              <span className="text-xs text-muted-foreground">Import from:</span>
              <button
                onClick={() => setImportSource('paste')}
                className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/10 rounded transition-colors"
              >
                <FileText className="w-3 h-3" />
                Paste data
              </button>
              <button
                onClick={() => setImportSource('url')}
                className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/10 rounded transition-colors"
              >
                <Link className="w-3 h-3" />
                URL
              </button>
              <button
                onClick={() => setImportSource('manual')}
                className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/10 rounded transition-colors"
              >
                <Wand2 className="w-3 h-3" />
                Describe manually
              </button>
            </div>
          )}

          {/* Import Panel: Paste */}
          {importSource === 'paste' && (
            <div className="p-3 bg-accent/5 rounded-lg border border-accent/20 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">Paste sample data</span>
                <button onClick={handleCancelImport} className="text-muted-foreground hover:text-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <textarea
                value={pasteContent}
                onChange={e => setPasteContent(e.target.value)}
                placeholder="Paste a sample of your input data (JSON, CSV, or plain text)..."
                className="w-full h-32 border border-border rounded px-3 py-2 bg-background text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-accent font-mono"
              />
              {importError && (
                <p className="text-xs text-danger">{importError}</p>
              )}
              {detectedResult ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Detected format:</p>
                  <p className="text-sm text-foreground">{detectedResult.input_description}</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleApplyDetected}
                      className="px-3 py-1.5 text-xs bg-accent text-accent-foreground rounded hover:opacity-90"
                    >
                      Apply
                    </button>
                    <button
                      onClick={() => setDetectedResult(null)}
                      className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Try again
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={handleDetectFromPaste}
                  disabled={importing || !pasteContent.trim()}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs bg-accent text-accent-foreground rounded hover:opacity-90 disabled:opacity-50"
                >
                  {importing && <Loader2 className="w-3 h-3 animate-spin" />}
                  Detect format
                </button>
              )}
            </div>
          )}

          {/* Import Panel: URL */}
          {importSource === 'url' && (
            <div className="p-3 bg-accent/5 rounded-lg border border-accent/20 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">Import from URL</span>
                <button onClick={handleCancelImport} className="text-muted-foreground hover:text-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <input
                type="url"
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                placeholder="https://api.example.com/schema.json or OpenAPI spec URL..."
                className="w-full border border-border rounded px-3 py-2 bg-background text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <p className="text-xs text-muted-foreground">
                Supports JSON data, OpenAPI/Swagger specs, or API documentation pages.
              </p>
              {importError && (
                <p className="text-xs text-danger">{importError}</p>
              )}
              <button
                onClick={handleImportFromUrl}
                disabled={importing || !urlInput.trim()}
                className="flex items-center gap-2 px-3 py-1.5 text-xs bg-accent text-accent-foreground rounded hover:opacity-90 disabled:opacity-50"
              >
                {importing && <Loader2 className="w-3 h-3 animate-spin" />}
                Import
              </button>
            </div>
          )}

          {/* Import Panel: Manual (just shows the fields) */}
          {importSource === 'manual' && (
            <div className="p-3 bg-accent/5 rounded-lg border border-accent/20 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">Describe your format</span>
                <button onClick={handleCancelImport} className="text-muted-foreground hover:text-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground mb-2">
                Fill in the fields below to describe what your app receives and produces.
              </p>
            </div>
          )}

          {/* Regular fields - always shown unless in paste/url import mode */}
          {(importSource === null || importSource === 'manual') && (
            <>
              <TaskField
                label="Input"
                placeholder="What does your app receive? (e.g., 'business goals + user stories')"
                value={task.input_description}
                onSave={v => onEdit?.('input_description', v)}
              />
              <TaskField
                label="Output"
                placeholder="What does your app produce? (e.g., 'structured charter JSON')"
                value={task.output_description}
                onSave={v => onEdit?.('output_description', v)}
              />
              <div className="mt-2 pt-2 border-t border-border space-y-2">
                <TaskField
                  label="Sample input"
                  placeholder="Paste an example of what your app actually receives..."
                  value={task.sample_input || ''}
                  onSave={v => onEdit?.('sample_input', v)}
                  multiline
                />
                <TaskField
                  label="Sample output"
                  placeholder="Paste an example of what your app actually produces..."
                  value={task.sample_output || ''}
                  onSave={v => onEdit?.('sample_output', v)}
                  multiline
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function TaskField({
  label,
  placeholder,
  value,
  onSave,
  multiline = false,
}: {
  label: string
  placeholder: string
  value: string
  onSave?: (value: string) => void
  multiline?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)

  const handleSave = () => {
    setEditing(false)
    if (text !== value && onSave) onSave(text)
  }

  const handleCancel = () => {
    setText(value)
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSave()
    }
    if (e.key === 'Escape') {
      handleCancel()
    }
  }

  return (
    <div className="pl-2">
      <span className="text-xs font-medium text-muted-foreground">{label}:</span>
      {editing ? (
        <div className="mt-1">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            placeholder={placeholder}
            className="w-full border border-accent rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-accent text-xs"
            rows={multiline ? 4 : 2}
          />
          <div className="flex gap-1.5 mt-1">
            <button
              onClick={handleSave}
              className="px-2 py-0.5 text-xs bg-accent text-accent-foreground rounded hover:opacity-90"
            >
              Save
            </button>
            <button
              onClick={handleCancel}
              className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <span className="text-[10px] text-muted-foreground ml-auto self-center">
              Enter to save · Esc to cancel
            </span>
          </div>
        </div>
      ) : (
        <div
          onClick={() => onSave && setEditing(true)}
          className={`mt-0.5 text-xs whitespace-pre-wrap ${value ? 'text-foreground/80' : 'text-muted-foreground italic'} ${onSave ? 'cursor-pointer hover:bg-accent/5 rounded px-1 -mx-1 py-0.5' : ''}`}
        >
          {value || placeholder}
        </div>
      )}
    </div>
  )
}

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
    <div className="flex items-start gap-2 py-1.5 px-2 bg-accent/5 rounded mb-1">
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

function DimensionSection({
  name,
  description,
  criteria,
  status,
  validationStatus,
  activeCriteria,
  onEdit,
  onAdd,
  suggestions = [],
  onAcceptSuggestion,
  onDismissSuggestion,
}: {
  name: string
  description: string
  criteria: string[]
  status: DimensionStatus
  validationStatus: string
  activeCriteria: string[]
  onEdit?: (index: number, value: string) => void
  onAdd?: (value: string) => void
  suggestions?: Suggestion[]
  onAcceptSuggestion?: (s: Suggestion) => void
  onDismissSuggestion?: (s: Suggestion) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [adding, setAdding] = useState(false)
  const [newValue, setNewValue] = useState('')
  const hasSuggestions = suggestions.length > 0
  const label = completionLabel(status, validationStatus, criteria.length)

  const handleAdd = () => {
    if (newValue.trim() && onAdd) {
      onAdd(newValue.trim())
      setNewValue('')
      setAdding(false)
    }
  }

  return (
    <div className="border border-border rounded-lg bg-surface-raised">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors rounded-t-lg"
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <div>
            <h3 className="text-sm font-medium text-foreground text-left">{name}</h3>
            <p className="text-xs text-muted-foreground text-left">{description}</p>
          </div>
          {hasSuggestions && !expanded && (
            <span className="text-xs text-accent font-medium">
              +{suggestions.length}
            </span>
          )}
        </div>
        {label && (
          <span className={`text-xs ${
            label === 'complete' ? 'text-success' :
            label.includes('item') ? 'text-muted-foreground' :
            label === '~50%' ? 'text-warning' :
            'text-danger'
          }`}>
            {label}
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-1">
          {criteria.map((criterion, i) => {
            const isActive = activeCriteria.includes(`${name.toLowerCase()}_${i}`)
            return (
              <CriterionRow
                key={i}
                text={criterion}
                active={isActive}
                onEdit={onEdit ? (v) => onEdit(i, v) : undefined}
              />
            )
          })}
          {criteria.length === 0 && !hasSuggestions && (
            <p className="pl-5 text-xs text-muted-foreground italic">No criteria yet</p>
          )}
          {suggestions.map((s, i) => (
            <SuggestionRow
              key={`sug-${i}`}
              suggestion={s}
              onAccept={onAcceptSuggestion}
              onDismiss={onDismissSuggestion}
            />
          ))}
          {onAdd && (
            adding ? (
              <div className="pl-2 pt-1">
                <textarea
                  value={newValue}
                  onChange={e => setNewValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAdd() }
                    if (e.key === 'Escape') { setNewValue(''); setAdding(false) }
                  }}
                  autoFocus
                  placeholder={`Add a ${name.toLowerCase()} criterion...`}
                  className="w-full text-sm border border-accent rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                  rows={2}
                />
                <div className="flex gap-1.5 mt-1">
                  <button onClick={handleAdd} className="px-2 py-0.5 text-xs bg-accent text-accent-foreground rounded hover:opacity-90">Add</button>
                  <button onClick={() => { setNewValue(''); setAdding(false) }} className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAdding(true)}
                className="flex items-center gap-1 pl-2 pt-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="w-3 h-3" />
                Add criterion
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}

function AlignmentSection({
  entries,
  validations,
  activeCriteria,
  onEdit,
  suggestions = [],
  onAcceptSuggestion,
  onDismissSuggestion,
}: {
  entries: AlignmentEntry[]
  validations: { feature_area: string; status: string; weak_reason: string | null }[]
  activeCriteria: string[]
  onEdit?: (index: number, field: 'good' | 'bad', value: string) => void
  suggestions?: Suggestion[]
  onAcceptSuggestion?: (s: Suggestion) => void
  onDismissSuggestion?: (s: Suggestion) => void
}) {
  const [expanded, setExpanded] = useState(true)

  const passCount = validations.filter(v => v.status === 'pass' || v.status === 'good').length
  const total = entries.length
  const hasSuggestions = suggestions.length > 0
  const hasValidation = validations.length > 0
  const label = total === 0 ? '' : hasValidation
    ? (passCount === total ? 'complete' : `${Math.round((passCount / total) * 100)}%`)
    : `${total} item${total !== 1 ? 's' : ''}`

  return (
    <div className="border border-border rounded-lg bg-surface-raised">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors rounded-t-lg"
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <div>
            <h3 className="text-sm font-medium text-foreground text-left">Alignment</h3>
            <p className="text-xs text-muted-foreground text-left">What good vs bad looks like</p>
          </div>
          {hasSuggestions && !expanded && (
            <span className="text-xs text-accent font-medium">
              +{suggestions.length}
            </span>
          )}
        </div>
        {label && (
          <span className={`text-xs ${label === 'complete' ? 'text-success' : label.includes('item') ? 'text-muted-foreground' : 'text-warning'}`}>
            {label}
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
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
          {entries.length === 0 && !hasSuggestions && (
            <p className="pl-5 text-xs text-muted-foreground italic">No alignment entries yet</p>
          )}
          {suggestions.map((s, i) => (
            <SuggestionRow
              key={`sug-${i}`}
              suggestion={s}
              onAccept={onAcceptSuggestion}
              onDismiss={onDismissSuggestion}
            />
          ))}
        </div>
      )}
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
    if (value !== text && onEdit) {
      onEdit(value)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleBlur()
    }
    if (e.key === 'Escape') {
      setValue(text)
      setEditing(false)
    }
  }

  return (
    <div className={`flex items-start gap-2 pl-2 py-1 group ${active ? 'bg-accent/5 rounded' : ''}`}>
      <Circle className="w-1.5 h-1.5 mt-2 text-muted-foreground fill-current flex-shrink-0" />
      {editing ? (
        <textarea
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
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
  const status = validation?.status || 'pending'

  return (
    <div className={`pl-2 py-1 ${active ? 'bg-accent/5 rounded' : ''}`}>
      <div className="flex items-center gap-2">
        <Circle className="w-1.5 h-1.5 text-muted-foreground fill-current flex-shrink-0" />
        <span className="text-sm font-medium text-foreground">{entry.feature_area}</span>
        {(status === 'weak' || status === 'fail') && validation?.weak_reason && (
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
        <EditableField
          label="Good"
          value={entry.good}
          color="text-success"
          onSave={v => onEdit?.('good', v)}
        />
        <EditableField
          label="Bad"
          value={entry.bad}
          color="text-danger"
          onSave={v => onEdit?.('bad', v)}
        />
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
