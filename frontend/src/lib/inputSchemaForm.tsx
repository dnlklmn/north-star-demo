/**
 * inputSchemaForm — render an `InputSchema` as a controlled React form.
 *
 * Shared utility: Track 4 (Deploy panel) renders this inline as a preview;
 * Track 5 (prod observer) reuses it to power "try it again" replays. Keep
 * it dependency-free (no design system imports) so both can compose it.
 *
 * Field renderers map 1:1 with the backend `InputFieldType` enum so the
 * deploy-server HTML form and the in-app form stay in lockstep.
 */
import { useCallback, useState, type ChangeEvent, type FormEvent } from 'react'
import type {
  ArtifactRef,
  FeatureInput,
  InputField,
  InputSchema,
} from '../types'

/** Per-field value held in form state. Files become ArtifactRef on submit. */
type FieldValue = string | number | boolean | File | null

export type InputSchemaFormValues = Record<string, FieldValue>

export interface InputSchemaFormProps {
  schema: InputSchema
  /** Called with the parsed FeatureInput when the user submits the form. */
  onSubmit: (input: FeatureInput) => void | Promise<void>
  /** Disable all controls (e.g. while a previous submit is in flight). */
  disabled?: boolean
  /** Submit-button label. Default: "Run". */
  submitLabel?: string
  /** Optional initial values, keyed by field name. */
  initialValues?: InputSchemaFormValues
  /**
   * Hook to convert a File into an ArtifactRef before it goes into the
   * submitted input. Defaults to a `pending:` placeholder ref so the form
   * works end-to-end without a real upload endpoint — Track 4 will swap
   * this for a real uploader once the artifact store lands.
   */
  uploadFile?: (field: InputField, file: File) => Promise<ArtifactRef>
  className?: string
}

function defaultUpload(field: InputField, file: File): Promise<ArtifactRef> {
  // Inline metadata only — the runner falls back to a text-block stub for
  // `pending:` refs. Real artifact storage is a follow-up in Track 4.
  return Promise.resolve({
    type: field.type === 'image' ? 'image' : 'file',
    mime: file.type || field.mime || 'application/octet-stream',
    ref: `pending:${file.name}`,
    filename: file.name,
  })
}

function initialValueFor(field: InputField): FieldValue {
  if (field.type === 'boolean') return false
  if (field.type === 'number') return ''
  return ''
}

export function InputSchemaForm(props: InputSchemaFormProps) {
  const { schema, onSubmit, disabled, submitLabel, initialValues, uploadFile, className } = props
  const [values, setValues] = useState<InputSchemaFormValues>(() => {
    const seed: InputSchemaFormValues = {}
    for (const f of schema.fields) {
      seed[f.name] = initialValues?.[f.name] ?? initialValueFor(f)
    }
    return seed
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setField = useCallback((name: string, value: FieldValue) => {
    setValues((v) => ({ ...v, [name]: value }))
  }, [])

  const handleSubmit = useCallback(
    async (ev: FormEvent<HTMLFormElement>) => {
      ev.preventDefault()
      setSubmitting(true)
      setError(null)
      try {
        const input = await buildInput(schema, values, uploadFile ?? defaultUpload)
        await onSubmit(input)
      } catch (e) {
        setError(String((e as Error)?.message ?? e))
      } finally {
        setSubmitting(false)
      }
    },
    [schema, values, uploadFile, onSubmit],
  )

  const isBusy = disabled || submitting
  return (
    <form className={className} onSubmit={handleSubmit}>
      {schema.fields.map((field) => (
        <FieldRow
          key={field.name}
          field={field}
          value={values[field.name]}
          onChange={(v) => setField(field.name, v)}
          disabled={isBusy}
        />
      ))}
      {error && (
        <div className="text-sm text-red-600" role="alert">
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={isBusy}
        className="mt-2 inline-flex items-center rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
      >
        {submitting ? 'Running…' : submitLabel ?? 'Run'}
      </button>
    </form>
  )
}

function FieldRow(props: {
  field: InputField
  value: FieldValue | undefined
  onChange: (v: FieldValue) => void
  disabled: boolean
}) {
  const { field, value, onChange, disabled } = props
  return (
    <div className="mb-3">
      <label htmlFor={`f-${field.name}`} className="block text-sm font-medium text-foreground">
        {field.name}
        {field.required ? ' *' : ''}
      </label>
      {field.description && (
        <div className="mb-1 text-xs text-muted-foreground">{field.description}</div>
      )}
      <FieldControl field={field} value={value} onChange={onChange} disabled={disabled} />
    </div>
  )
}

function FieldControl(props: {
  field: InputField
  value: FieldValue | undefined
  onChange: (v: FieldValue) => void
  disabled: boolean
}) {
  const { field, value, onChange, disabled } = props
  const id = `f-${field.name}`
  const baseClass =
    'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground'

  if (field.type === 'longtext' || field.type === 'json') {
    return (
      <textarea
        id={id}
        name={field.name}
        rows={field.type === 'json' ? 4 : 6}
        required={field.required}
        disabled={disabled}
        value={typeof value === 'string' ? value : ''}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        className={baseClass}
        placeholder={field.type === 'json' ? 'JSON value' : undefined}
      />
    )
  }
  if (field.type === 'number') {
    return (
      <input
        id={id}
        name={field.name}
        type="number"
        step="any"
        required={field.required}
        disabled={disabled}
        value={typeof value === 'number' || typeof value === 'string' ? value : ''}
        onChange={(e) => {
          const raw = e.target.value
          onChange(raw === '' ? '' : Number(raw))
        }}
        className={baseClass}
      />
    )
  }
  if (field.type === 'boolean') {
    return (
      <input
        id={id}
        name={field.name}
        type="checkbox"
        disabled={disabled}
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4"
      />
    )
  }
  if (field.type === 'enum') {
    const options = field.enum ?? []
    return (
      <select
        id={id}
        name={field.name}
        required={field.required}
        disabled={disabled}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        className={baseClass}
      >
        {!field.required && <option value="">--</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  if (field.type === 'file' || field.type === 'image') {
    const accept = field.mime ?? (field.type === 'image' ? 'image/*' : undefined)
    return (
      <input
        id={id}
        name={field.name}
        type="file"
        accept={accept}
        required={field.required}
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null
          onChange(f)
        }}
        className="text-sm"
      />
    )
  }
  // text (default)
  return (
    <input
      id={id}
      name={field.name}
      type="text"
      required={field.required}
      disabled={disabled}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      className={baseClass}
    />
  )
}

async function buildInput(
  schema: InputSchema,
  values: InputSchemaFormValues,
  upload: (field: InputField, file: File) => Promise<ArtifactRef>,
): Promise<FeatureInput> {
  // Single-text-field shortcut → bare string, matches the backend contract.
  if (
    schema.fields.length === 1 &&
    (schema.fields[0].type === 'text' || schema.fields[0].type === 'longtext')
  ) {
    const v = values[schema.fields[0].name]
    return typeof v === 'string' ? v : ''
  }

  const out: Record<string, unknown> = {}
  for (const field of schema.fields) {
    const v = values[field.name]
    if (v == null || v === '') {
      if (field.required) {
        throw new Error(`Field "${field.name}" is required`)
      }
      continue
    }
    if (v instanceof File) {
      out[field.name] = await upload(field, v)
      continue
    }
    if (field.type === 'json' && typeof v === 'string') {
      try {
        out[field.name] = JSON.parse(v)
      } catch {
        // Pass the raw string through — the runner can still render it as text.
        out[field.name] = v
      }
      continue
    }
    out[field.name] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Convenience: a synchronous form-builder that mirrors the backend HTML
// renderer, exported for tests / dev tools that want a string of markup.
// ---------------------------------------------------------------------------

export function describeFieldControl(field: InputField): string {
  switch (field.type) {
    case 'longtext':
      return 'textarea'
    case 'number':
      return 'number input'
    case 'boolean':
      return 'checkbox'
    case 'enum':
      return 'select'
    case 'json':
      return 'JSON textarea'
    case 'file':
    case 'image':
      return 'file input'
    default:
      return 'text input'
  }
}
