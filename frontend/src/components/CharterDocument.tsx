import { X, Copy, Check } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Charter } from '../types'

interface Props {
  charter: Charter
  title?: string
  subtitle?: string
  onClose: () => void
}

/**
 * Full-screen modal that renders a Charter as one scrollable document.
 * Used from the Charter tab header ("View as document") and from any
 * eval run ("View charter" — reads charter_snapshot from the run).
 *
 * Output is markdown-shaped so a user can copy-paste into a PRD or PR
 * description.
 */
export default function CharterDocument({
  charter,
  title = 'Charter',
  subtitle,
  onClose,
}: Props) {
  const markdown = useMemo(() => charterToMarkdown(charter), [charter])
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // noop
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg-default max-w-4xl w-full max-h-[90vh] flex flex-col border border-border shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground truncate">{title}</h2>
            {subtitle && (
              <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 text-xs px-2 py-1 text-muted-foreground hover:text-foreground"
              title="Copy as markdown"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <pre className="whitespace-pre-wrap break-words text-xs font-mono text-foreground leading-relaxed">
            {markdown}
          </pre>
        </div>
      </div>
    </div>
  )
}

/**
 * Renders a Charter as a flat markdown document. Missing sections render
 * with "(none)" so the document is always structurally complete and diffs
 * well across runs.
 */
function charterToMarkdown(charter: Charter): string {
  const lines: string[] = []
  const t = charter.task

  lines.push('# Charter')
  lines.push('')

  // Task / skill metadata
  lines.push('## Task definition')
  lines.push('')
  if (t.skill_name) {
    lines.push(`- **Skill name:** ${t.skill_name}`)
  }
  if (t.skill_description) {
    lines.push(`- **Skill description (routing signal):** ${t.skill_description}`)
  }
  lines.push(`- **Input:** ${t.input_description || '(not specified)'}`)
  lines.push(`- **Output:** ${t.output_description || '(not specified)'}`)
  if (t.sample_input) {
    lines.push('')
    lines.push('**Sample input:**')
    lines.push('```')
    lines.push(t.sample_input)
    lines.push('```')
  }
  if (t.sample_output) {
    lines.push('')
    lines.push('**Sample output:**')
    lines.push('```')
    lines.push(t.sample_output)
    lines.push('```')
  }
  lines.push('')

  // SKILL.md body
  if (t.skill_body) {
    lines.push('## SKILL.md body')
    lines.push('')
    lines.push('```markdown')
    lines.push(t.skill_body)
    lines.push('```')
    lines.push('')
  }

  // Coverage
  lines.push('## Coverage')
  lines.push('')
  lines.push('### Positive — scenarios the skill SHOULD handle')
  if (charter.coverage.criteria.length === 0) {
    lines.push('- (none)')
  } else {
    for (const c of charter.coverage.criteria) lines.push(`- ${c}`)
  }
  const negatives = charter.coverage.negative_criteria ?? []
  if (negatives.length > 0) {
    lines.push('')
    lines.push('### Off-target — scenarios the skill should NOT handle')
    for (const c of negatives) lines.push(`- ${c}`)
  }
  lines.push('')

  // Balance
  lines.push('## Balance')
  lines.push('')
  if (charter.balance.criteria.length === 0) {
    lines.push('- (none)')
  } else {
    for (const c of charter.balance.criteria) lines.push(`- ${c}`)
  }
  lines.push('')

  // Alignment
  lines.push('## Alignment')
  lines.push('')
  if (charter.alignment.length === 0) {
    lines.push('*(no feature areas)*')
  } else {
    for (const a of charter.alignment) {
      lines.push(`### ${a.feature_area}`)
      lines.push(`- **Good:** ${a.good || '(none)'}`)
      lines.push(`- **Bad:** ${a.bad || '(none)'}`)
      lines.push('')
    }
  }

  // Rot
  lines.push('## Rot')
  lines.push('')
  if (charter.rot.criteria.length === 0) {
    lines.push('- (none)')
  } else {
    for (const c of charter.rot.criteria) lines.push(`- ${c}`)
  }
  lines.push('')

  // Safety (optional)
  const safetyCriteria = charter.safety?.criteria ?? []
  if (safetyCriteria.length > 0) {
    lines.push('## Safety')
    lines.push('')
    lines.push('*Output-level rules the skill must obey. Not runtime safety.*')
    lines.push('')
    for (const c of safetyCriteria) lines.push(`- ${c}`)
    lines.push('')
  }

  return lines.join('\n').trimEnd() + '\n'
}
