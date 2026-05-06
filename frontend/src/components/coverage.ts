import type { GapAnalysis } from '../types'

/** 0-1 score: filled (count > 0) cells / total cells in the matrix. */
export function computeCoverageScore(gaps: GapAnalysis | null | undefined): number | null {
  if (!gaps) return null
  const matrix = gaps.coverage_matrix || {}
  const criteria = Object.keys(matrix)
  if (criteria.length === 0) return null
  const featureAreas = Object.keys(matrix[criteria[0]] || {})
  if (featureAreas.length === 0) return null
  const total = criteria.length * featureAreas.length
  let filled = 0
  for (const c of criteria) {
    for (const fa of featureAreas) {
      if ((matrix[c]?.[fa] ?? 0) > 0) filled++
    }
  }
  return filled / total
}

/** Three-tier status from coverage score: green / orange / red. */
export function coverageStatus(score: number | null): 'good' | 'warn' | 'bad' | null {
  if (score == null) return null
  if (score >= 0.8) return 'good'
  if (score >= 0.4) return 'warn'
  return 'bad'
}
