export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  costUsd: number
  inputCostUsd: number
  outputCostUsd: number
  cacheReadCostUsd: number
  cacheWriteCostUsd: number
}

export interface UsageDailyPoint extends UsageTotals {
  date: string
  models: UsageModelSummary[]
}

export interface UsageModelSummary extends UsageTotals {
  key: string
  /** Actual weighted cost per million recorded tokens for this period. */
  effectiveUsdPerMillionTokens: number
}

export interface UsageSessionSummary extends UsageTotals {
  key: string
  label: string
  sessionId?: string
  sessionFile?: string
  cwd?: string
}

export interface UsageReport {
  month: string
  timezone: string
  currency: 'USD'
  total: UsageTotals
  daily: UsageDailyPoint[]
  models: UsageModelSummary[]
  sessions: UsageSessionSummary[]
  recordCount: number
}
