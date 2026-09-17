/**
 * Agent time analysis types.
 *
 * Wall-clock fields (`activeMs`, `modelMs`, `toolMs`, `overheadMs`) are scoped to
 * root processes so a parent's wall clock and its nested subagent processes do not
 * double count. Call/throughput fields (`modelCalls`, `outputTokens`, `ttftMs`,
 * `thinkingMs`) include every process, because subagent model calls are real work
 * worth comparing per model.
 */
export type TimingRange = 'month' | '7d' | '30d'

export interface TimingTotals {
  /** Wall clock of root agent runs (agent_start → agent_settled), root scope only. */
  activeMs: number
  /** Wall clock of nested subagent runs, kept separate from the root total. */
  childActiveMs: number
  /** Model request time inside root runs. */
  modelMs: number
  /** Tool execution time inside root runs. */
  toolMs: number
  /** activeMs − modelMs − toolMs, never below zero. */
  overheadMs: number
  modelCalls: number
  toolCalls: number
  outputTokens: number
  errors: number
  runs: number
  childRuns: number
  /** Calls that reported a first-token time, and their summed first-token time. */
  ttftCalls: number
  ttftMs: number
  /** Calls that reported thinking time, and their summed thinking time. */
  thinkingCalls: number
  thinkingMs: number
  /** Summed stream time after the first token, for calls that reported TTFT. */
  decodeMs: number
}

export interface TimingDailyPoint extends TimingTotals {
  date: string
}

export interface TimingModelSummary {
  key: string
  provider: string
  model: string
  calls: number
  errors: number
  totalMs: number
  avgTotalMs: number
  ttftCalls: number
  ttftAvgMs: number
  ttftP50Ms: number
  ttftP90Ms: number
  outputTokens: number
  decodeTokensPerSec: number
  thinkingCalls: number
  thinkingMs: number
  thinkingAvgMs: number
  /** thinkingMs ÷ totalMs for calls that reported both. */
  thinkingShare: number
}

export interface TimingToolSummary {
  name: string
  calls: number
  errors: number
  totalMs: number
  avgMs: number
  p50Ms: number
  p90Ms: number
  maxMs: number
}

export interface TimingSessionSummary {
  key: string
  label: string
  runs: number
  activeMs: number
  modelMs: number
  toolMs: number
}

export interface TimingCoverage {
  modelCalls: number
  withTtft: number
  withThinking: number
  runs: number
}

export interface TimingReport {
  range: TimingRange
  month?: string
  timezone: string
  from: number
  to: number
  total: TimingTotals
  daily: TimingDailyPoint[]
  models: TimingModelSummary[]
  tools: TimingToolSummary[]
  sessions: TimingSessionSummary[]
  /** Records aggregated for this period. */
  recordCount: number
  coverage: TimingCoverage
}