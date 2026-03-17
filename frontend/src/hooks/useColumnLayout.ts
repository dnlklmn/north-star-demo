import { useState, useCallback } from 'react'

export type FocusedColumn = 'input' | 'charter' | 'examples'

/**
 * Manages the column layout state - which columns are open/collapsed.
 * Always keeps 2 columns open, collapsing the least recently used.
 */
export function useColumnLayout() {
  // Track open columns: [mostRecent, secondMostRecent]
  const [openColumns, setOpenColumns] = useState<[FocusedColumn, FocusedColumn]>(['input', 'charter'])
  const [showCharter, setShowCharter] = useState(false)
  const [showAgent, setShowAgent] = useState(false)

  // Select a column - opens it and closes the least recently used
  const selectColumn = useCallback((column: FocusedColumn) => {
    setOpenColumns(prev => {
      if (prev[0] === column) return prev // Already most recent
      if (prev[1] === column) return [column, prev[0]] // Swap order
      return [column, prev[0]] // New column, drop the oldest
    })
  }, [])

  // Check if a column is currently open
  const isColumnOpen = useCallback((column: FocusedColumn) => {
    return openColumns.includes(column)
  }, [openColumns])

  // Show charter column (called after first generate)
  const revealCharter = useCallback(() => {
    setShowCharter(true)
    selectColumn('charter')
    // Show agent after a small delay
    setTimeout(() => setShowAgent(true), 300)
  }, [selectColumn])

  // Show examples column (called after dataset creation)
  const revealExamples = useCallback(() => {
    selectColumn('examples')
  }, [selectColumn])

  return {
    openColumns,
    showCharter,
    showAgent,
    selectColumn,
    isColumnOpen,
    revealCharter,
    revealExamples,
    isInitialState: !showCharter,
  }
}
