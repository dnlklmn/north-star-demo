/** Helpers for classifying a generated scorer's scoring method.
 *
 *  Generated scorers come in two shapes from the hybrid-scoring pass:
 *
 *  - **Judge** — call `call_judge(prompt)` with a decomposed rubric prompt,
 *    paying per-row LLM cost.
 *  - **Deterministic** — pure Python (`json.loads`, `re.search`,
 *    `json_schema_ok`), no LLM call, microsecond execution.
 *
 *  Several UI surfaces need to label or count these (Scorers panel grouping,
 *  Evaluate panel "this run uses N judge scorers" hint, future filter chips).
 *  Centralising the rule here keeps those surfaces consistent — a drift
 *  between two ad-hoc copies has bitten this codebase before
 *  (`scoring_method` frontmatter on the publish bridge was added precisely
 *  so downstream tools don't re-parse the code).
 *
 *  Detection mirrors `backend/app/scorer_publish.py::_is_deterministic_scorer`
 *  in its textual-fallback branch: substring check for `judge_prompt` and
 *  `call_judge(`. AST would be overkill for a UI label — a false positive
 *  here just paints the wrong header / count; backend stays authoritative
 *  for actual scoring routing and Braintrust markdown emission.
 */
export function isDeterministicScorer(code: string | null | undefined): boolean {
  if (!code) return false
  return !code.includes('judge_prompt') && !code.includes('call_judge(')
}

/** Count scorers by scoring method.
 *
 *  Returned in a single sweep (vs two `.filter` passes) because both counts
 *  are almost always needed together — Evaluate panel's hint, Scorers panel's
 *  group headers, etc. The dead-tree path (zero scorers) returns `{0, 0}`,
 *  matching what every caller would do anyway with an empty list.
 */
export function countScorerKinds<T extends { code?: string | null }>(
  scorers: readonly T[] | null | undefined,
): { deterministic: number; judge: number; total: number } {
  let deterministic = 0
  let judge = 0
  for (const s of scorers ?? []) {
    if (isDeterministicScorer(s.code)) deterministic++
    else judge++
  }
  return { deterministic, judge, total: deterministic + judge }
}
