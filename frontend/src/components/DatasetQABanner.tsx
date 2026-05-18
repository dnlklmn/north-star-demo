import { useState } from 'react'
import { X, HelpCircle } from 'lucide-react'

interface DatasetQABannerProps {
  /** Used to scope the per-dataset dismissal key so a fresh dataset resets the
   *  banner. Without scoping, a single dismissal would hide it forever. */
  datasetId: string
}

function storageKey(datasetId: string): string {
  return `northstar.datasetQABanner.dismissed.${datasetId}`
}

export default function DatasetQABanner({ datasetId }: DatasetQABannerProps) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey(datasetId)) === '1'
    } catch {
      return false
    }
  })
  const [helpOpen, setHelpOpen] = useState(false)

  if (dismissed) return null

  const dismiss = () => {
    try {
      localStorage.setItem(storageKey(datasetId), '1')
    } catch {
      // Private browsing / quota — silently fall back to per-mount state.
    }
    setDismissed(true)
  }

  return (
    <>
      <div className="bg-fill-primary/5 border border-fill-primary/30 px-4 py-3 flex items-start gap-3">
        <div className="flex-1 text-sm leading-relaxed">
          <div className="font-semibold text-fg-contrast mb-0.5">
            Dataset QA — are these good test cases?
          </div>
          <div className="text-fg-dim">
            Approve rows that test something real. Fix or reject the rest. You're not
            judging model output yet — that comes next.
          </div>
        </div>
        <button
          onClick={() => setHelpOpen(true)}
          className="text-fg-dim hover:text-fg-contrast text-xs underline flex items-center gap-1"
          title="What am I doing here?"
        >
          <HelpCircle className="w-3.5 h-3.5" />
          What am I doing?
        </button>
        <button
          onClick={dismiss}
          className="text-fg-dim hover:text-fg-contrast"
          aria-label="Dismiss banner"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {helpOpen && <DatasetQAHelpPanel onClose={() => setHelpOpen(false)} />}
    </>
  )
}

function DatasetQAHelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-bg-default border border-border-hint shadow-xl max-w-xl w-full mx-4 max-h-[85vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-hint">
          <h3 className="text-sm font-semibold text-fg-contrast">What am I doing here?</h3>
          <button onClick={onClose} aria-label="Close" className="text-fg-dim hover:text-fg-contrast">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4 text-sm text-fg-contrast leading-relaxed">
          <p className="text-fg-dim">
            This is the dataset QA phase. Your job is to decide whether each row is a
            good test case — not whether the model would pass it. Model evaluation comes
            later, against the rows you approve here.
          </p>

          <section>
            <h4 className="font-semibold mb-1">Every row has three things you can act on</h4>
            <ul className="space-y-2 text-fg-dim">
              <li>
                <span className="text-fg-contrast">Input labels</span> — the
                feature area and coverage tags the agent picked. Glance to confirm,
                override if miscategorized.
              </li>
              <li>
                <span className="text-fg-contrast">Expected output</span> — what the
                agent thinks "good" looks like for this input. Read it; edit if it's wrong.
              </li>
              <li>
                <span className="text-fg-contrast">Verdict</span> — the agent's
                judgement (good/bad as a test case). Approve it, or override.
              </li>
            </ul>
          </section>

          <section>
            <h4 className="font-semibold mb-1">Approve / Fix / Reject</h4>
            <ul className="space-y-1 text-fg-dim">
              <li><span className="text-fg-contrast">Approve</span> — the row tests something real and the expected output is right.</li>
              <li><span className="text-fg-contrast">Fix</span> — the scenario is useful but the labels or expected output need editing.</li>
              <li><span className="text-fg-contrast">Reject</span> — this isn't a useful test case (off-scope, duplicate, malformed).</li>
            </ul>
          </section>

          <section>
            <h4 className="font-semibold mb-1">Why the Coverage Map matters</h4>
            <p className="text-fg-dim">
              Row-by-row review can't see what's missing. The matrix shows which
              scenarios × feature areas have zero or thin coverage — that's where the
              agent should be generating more rows. Curation happens at the matrix level,
              not row by row.
            </p>
          </section>

          <section>
            <h4 className="font-semibold mb-1">Why judge agreement matters</h4>
            <p className="text-fg-dim">
              The number on the header is how often the judge's suggested verdict
              matches yours. Low agreement (under 80%) means the judge is misreading
              the charter — that's a signal to clarify alignment before trusting
              auto-review on new rows.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
