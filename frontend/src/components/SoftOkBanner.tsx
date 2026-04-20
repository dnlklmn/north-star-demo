import type { Validation } from '../types'

interface Props {
  validation: Validation
  onKeepRefining: () => void
  onProceed: () => void
}

export default function SoftOkBanner({ validation, onKeepRefining, onProceed }: Props) {
  const weakItems: string[] = []

  if (validation.coverage === 'weak' || validation.coverage === 'fail') {
    weakItems.push('Coverage — some scenarios need more detail')
  }
  if (validation.balance === 'weak' || validation.balance === 'fail') {
    weakItems.push('Balance — weighting decisions need work')
  }
  if (validation.rot === 'weak' || validation.rot === 'fail') {
    weakItems.push('Rot — update triggers not specific enough')
  }
  for (const a of validation.alignment) {
    if (a.status === 'weak' || a.status === 'fail') {
      weakItems.push(`Alignment — ${a.feature_area}${a.weak_reason ? `: ${a.weak_reason}` : ''}`)
    }
  }

  return (
    <div className="mx-3 my-2 p-3 bg-warning/10 border border-warning/20">
      <p className="text-sm text-foreground font-medium mb-2">
        A few criteria are still uncertain:
      </p>
      <ul className="text-sm text-muted-foreground mb-3 space-y-1">
        {weakItems.map((item, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-warning">·</span>
            {item}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <button
          onClick={onKeepRefining}
          className="px-3 py-1.5 text-xs border border-border text-foreground hover:bg-muted transition-colors"
        >
          Keep refining
        </button>
        <button
          onClick={onProceed}
          className="px-3 py-1.5 text-xs bg-accent text-accent-foreground hover:opacity-90 transition-opacity"
        >
          Proceed to review
        </button>
      </div>
    </div>
  )
}
