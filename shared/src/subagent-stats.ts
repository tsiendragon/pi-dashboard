/** Daily rollup of subagent launches and how they ended. */
export interface SubagentStatsDay {
  date: string
  /** Launches recorded that day, including ones still running. */
  launched: number
  completed: number
  failed: number
  cancelled: number
  interrupted: number
  running: number
  /** Workflow child tasks started that day (a workflow job carries its own count). */
  tasks: number
  tasksFailed: number
}

export interface SubagentStatsGroup {
  key: string
  launched: number
  completed: number
  failed: number
  cancelled: number
  interrupted: number
  running: number
  /** completed ÷ (completed + failed); cancellations are excluded from the denominator. */
  successRate: number
}

export interface SubagentUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  /** Jobs whose ledger row carried usage; older rows have none. */
  reported: number
  toolCalls: number
  modelCalls: number
}

export interface SubagentStatsTotals extends Omit<SubagentStatsGroup, 'key'> {
  /** Jobs that reached a terminal state. */
  settled: number
  tasks: number
  tasksFailed: number
  /** Token and cost the children burned; only counted after the ledger started recording it. */
  usage: SubagentUsage
}

export interface SubagentStatsFailure {
  workId: string
  kind: 'agent' | 'workflow'
  status: string
  label?: string
  role?: string
  tier?: string
  model?: string
  error?: string
  at: number
}

export interface SubagentStats {
  windowDays: number
  timezone: string
  /** Ledger rows read from the file. */
  records: number
  /** True when the ledger file does not exist yet (nothing recorded). */
  empty: boolean
  totals: SubagentStatsTotals
  byKind: SubagentStatsGroup[]
  byRole: SubagentStatsGroup[]
  byTier: SubagentStatsGroup[]
  byModel: SubagentStatsGroup[]
  days: SubagentStatsDay[]
  recentFailures: SubagentStatsFailure[]
}