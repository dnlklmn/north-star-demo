/**
 * Minimal line-level diff for showing SKILL.md version changes.
 *
 * Uses a straightforward LCS (longest common subsequence) approach. Not the
 * fastest algorithm for huge texts but SKILL.md files are small (< 500 lines),
 * so O(n*m) is fine.
 *
 * Output is a flat list of operations the UI can render directly — each line
 * gets tagged "equal" | "added" | "removed" with its original index (for
 * showing line numbers where meaningful).
 */

export type DiffOp = {
  kind: 'equal' | 'added' | 'removed'
  text: string
  oldLineNumber: number | null
  newLineNumber: number | null
}

export function diffLines(oldText: string, newText: string): DiffOp[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const m = oldLines.length
  const n = newLines.length

  // LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  // Walk the table, producing operations.
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({
        kind: 'equal',
        text: oldLines[i],
        oldLineNumber: i + 1,
        newLineNumber: j + 1,
      })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({
        kind: 'removed',
        text: oldLines[i],
        oldLineNumber: i + 1,
        newLineNumber: null,
      })
      i++
    } else {
      ops.push({
        kind: 'added',
        text: newLines[j],
        oldLineNumber: null,
        newLineNumber: j + 1,
      })
      j++
    }
  }
  while (i < m) {
    ops.push({
      kind: 'removed',
      text: oldLines[i],
      oldLineNumber: i + 1,
      newLineNumber: null,
    })
    i++
  }
  while (j < n) {
    ops.push({
      kind: 'added',
      text: newLines[j],
      oldLineNumber: null,
      newLineNumber: j + 1,
    })
    j++
  }
  return ops
}

/** Count added/removed lines for a compact summary ("+12 −4"). */
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.kind === 'added') added++
    else if (op.kind === 'removed') removed++
  }
  return { added, removed }
}
