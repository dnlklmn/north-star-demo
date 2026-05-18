import type { JudgeAgreement } from '../types'

interface JudgeAgreementBadgeProps {
  agreement: JudgeAgreement | null
}

/** Renders the judge ↔ human label agreement metric for a dataset.
 *
 *  Visual states:
 *  - reviewed_count < 10 → muted "not enough data" hint
 *  - agreement_rate < 0.8 (with enough data) → warning color
 *  - kappa < 0.6 with reviewed_count >= 20 → warning color
 *  - otherwise → muted neutral
 *
 *  The intent is a quantitative trust signal for the dataset, not a precise
 *  inter-rater statistic — the threshold colors are deliberately conservative.
 */
export default function JudgeAgreementBadge({ agreement }: JudgeAgreementBadgeProps) {
  if (!agreement) return null

  const { reviewed_count, agreement_rate, kappa, not_enough_data } = agreement

  // Suppress entirely until at least one row has been reviewed — the stats
  // row already shows pending/approved counts, no need for a placeholder.
  if (reviewed_count === 0) return null

  if (not_enough_data) {
    return (
      <span
        className="text-xs text-fg-dim"
        title="Cohen's kappa is noisy below 10 reviewed rows; review more to get a stable signal"
      >
        Judge agreement: {Math.round(agreement_rate * 100)}% ({reviewed_count} reviewed)
      </span>
    )
  }

  const lowAgreement = agreement_rate < 0.8
  const lowKappa = kappa !== null && kappa < 0.6 && reviewed_count >= 20
  const warning = lowAgreement || lowKappa

  const tooltip = warning
    ? 'The judge disagrees with your labels too often. Tighten the charter alignment definitions or stop auto-trusting suggestions.'
    : 'How often the judge\'s suggested label matches the reviewer\'s final label.'

  const colorCls = warning ? 'text-warning' : 'text-fg-dim'

  return (
    <span className={`text-xs ${colorCls}`} title={tooltip}>
      Judge agreement: {Math.round(agreement_rate * 100)}%
      {kappa !== null && <> (κ = {kappa.toFixed(2)})</>}
      <span className="text-fg-dim"> over {reviewed_count} reviewed</span>
    </span>
  )
}
