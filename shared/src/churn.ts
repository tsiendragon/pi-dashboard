export interface ChurnTotals {
  /** Lines introduced through edit/write tool calls. */
  added: number
  /** Lines replaced or removed through edit tool calls and shrinking rewrites. */
  removed: number
  codeAdded: number
  codeRemoved: number
  docAdded: number
  docRemoved: number
  /** Number of edit/write tool calls that changed at least one line. */
  calls: number
  /** Distinct files touched. */
  files: number
}

export interface ChurnDay extends ChurnTotals {
  date: string
}

export interface ChurnReport {
  month: string
  timezone: string
  /** True while session files are still being scanned; numbers are partial. */
  scanning: boolean
  /** Session files read for this month so far. */
  filesScanned: number
  days: ChurnDay[]
  total: ChurnTotals
}