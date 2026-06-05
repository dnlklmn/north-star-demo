/** Helpers for classifying a generated scorer's scoring method.
 *
 *  Generated scorers come in three shapes:
 *
 *  - **Judge** — call `call_judge(prompt)` with a decomposed rubric prompt,
 *    paying per-row LLM cost.
 *  - **Deterministic** — pure Python (`json.loads`, `re.search`,
 *    `json_schema_ok`), no LLM call, microsecond execution.
 *  - **kNN** — call `knn_vote(output, k=5)`, embedding the candidate output
 *    and voting from the k nearest labeled rows in the dataset. No LLM
 *    call per row at scoring time (only at backfill time when embeddings
 *    are created); cost scales with embedding price + cosine compute.
 *
 *  Several UI surfaces need to label or count these (Scorers panel grouping,
 *  Evaluate panel "this run uses N judge scorers" hint, future filter chips).
 *  Centralising the rule here keeps those surfaces consistent — a drift
 *  between two ad-hoc copies has bitten this codebase before
 *  (`scoring_method` frontmatter on the publish bridge was added precisely
 *  so downstream tools don't re-parse the code).
 *
 *  Detection mirrors `backend/app/scorer_publish.py::_is_deterministic_scorer`
 *  in its textual-fallback branch: substring check for `judge_prompt`,
 *  `call_judge(`, and `knn_vote(`. AST would be overkill for a UI label
 *  — a false positive here just paints the wrong header / count; backend
 *  stays authoritative for actual scoring routing and Braintrust markdown
 *  emission.
 */

export type ScorerKind = 'deterministic' | 'judge' | 'knn'

/** Classify a scorer by inspecting its source. kNN takes priority over
 *  judge because a hybrid scorer that uses both (rare but possible
 *  future) should be filed under the more specific, cheaper method —
 *  same precedence rule used by `scorer_publish` server-side. */
export function classifyScorer(code: string | null | undefined): ScorerKind {
  if (!code) return 'deterministic'
  if (code.includes('knn_vote(')) return 'knn'
  if (code.includes('judge_prompt') || code.includes('call_judge(')) return 'judge'
  return 'deterministic'
}

export function isDeterministicScorer(code: string | null | undefined): boolean {
  return classifyScorer(code) === 'deterministic'
}

export function isKnnScorer(code: string | null | undefined): boolean {
  return classifyScorer(code) === 'knn'
}

export function isJudgeScorer(code: string | null | undefined): boolean {
  return classifyScorer(code) === 'judge'
}

/** Count scorers by scoring method.
 *
 *  Returned in a single sweep (vs three `.filter` passes) because the
 *  counts are almost always needed together — Evaluate panel's hint,
 *  Scorers panel's group headers, etc. The dead-tree path (zero
 *  scorers) returns all zeros, matching what every caller would do
 *  anyway with an empty list.
 */
export function countScorerKinds<T extends { code?: string | null }>(
  scorers: readonly T[] | null | undefined,
): { deterministic: number; judge: number; knn: number; total: number } {
  let deterministic = 0
  let judge = 0
  let knn = 0
  for (const s of scorers ?? []) {
    const k = classifyScorer(s.code)
    if (k === 'deterministic') deterministic++
    else if (k === 'judge') judge++
    else knn++
  }
  return { deterministic, judge, knn, total: deterministic + judge + knn }
}
