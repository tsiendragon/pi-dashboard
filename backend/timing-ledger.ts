/**
 * Agent timing ledger.
 *
 * Reads the compact timing ledger written by the Pi `trajectory-recorder`
 * extension (`<timingDir>/<sessionId>.jsonl`, one small JSON line per model call,
 * tool call, and agent run) and aggregates it for the dashboard timing report.
 *
 * The files are append-only, so ingestion resumes from the last complete byte
 * offset per file. In-memory buckets are bounded: percentile samples are pruned
 * by retention, while per-day sums stay small enough to keep.
 */
import { readdir, mkdir, open, stat } from 'node:fs/promises'
import path from 'node:path'
import { dateInTimezone } from './usage-ledger.js'
import { join } from 'node:path'
import { agentDir } from './env-file.js'
import type {
  TimingCoverage,
  TimingDailyPoint,
  TimingModelSummary,
  TimingRange,
  TimingReport,
  TimingSessionSummary,
  TimingToolSummary,
  TimingTotals,
} from '../shared/src/timing.js'

/** Default ledger location (portable); override with `PI_DASH_TIMING_DIR`. */
export const DEFAULT_TIMING_DIRECTORY = join(agentDir(), 'pi-timing')

/** Percentile samples are kept this long; per-day sums are kept indefinitely. */
const SAMPLE_RETENTION_MS = 45 * 24 * 60 * 60 * 1000
const REFRESH_INTERVAL_MS = 3_000

type TimingKind = 'model' | 'tool' | 'run'
type TimingScope = 'root' | 'child'

interface ModelBucket {
  provider: string
  model: string
  calls: number
  errors: number
  totalMs: number
  outputTokens: number
  thinkingMs: number
  thinkingCalls: number
  ttftCalls: number
  ttftMs: number
  decodeMs: number
  ttftSamples: number[]
}

interface ToolBucket {
  calls: number
  errors: number
  totalMs: number
  durations: number[]
}

interface SessionBucket {
  label: string
  runs: number
  activeMs: number
  modelMs: number
  toolMs: number
}

interface DayBucket {
  activeMs: number
  childActiveMs: number
  modelMs: number
  toolMs: number
  modelCalls: number
  toolCalls: number
  outputTokens: number
  errors: number
  runs: number
  childRuns: number
  ttftCalls: number
  ttftMs: number
  thinkingCalls: number
  thinkingMs: number
  decodeMs: number
  models: Map<string, ModelBucket>
  tools: Map<string, ToolBucket>
  sessions: Map<string, SessionBucket>
}

interface ParsedTimingRecord {
  id: string
  at: number
  kind: TimingKind
  scope: TimingScope
  sessionKey: string
  label: string
  provider?: string
  model?: string
  totalMs?: number
  durationMs?: number
  ttftMs?: number
  thinkingMs?: number
  outputTokens?: number
  toolName?: string
  isError: boolean
}

function emptyDay(): DayBucket {
  return {
    activeMs: 0,
    childActiveMs: 0,
    modelMs: 0,
    toolMs: 0,
    modelCalls: 0,
    toolCalls: 0,
    outputTokens: 0,
    errors: 0,
    runs: 0,
    childRuns: 0,
    ttftCalls: 0,
    ttftMs: 0,
    thinkingCalls: 0,
    thinkingMs: 0,
    decodeMs: 0,
    models: new Map(),
    tools: new Map(),
    sessions: new Map(),
  }
}

function emptyTotals(): TimingTotals {
  return {
    activeMs: 0,
    childActiveMs: 0,
    modelMs: 0,
    toolMs: 0,
    overheadMs: 0,
    modelCalls: 0,
    toolCalls: 0,
    outputTokens: 0,
    errors: 0,
    runs: 0,
    childRuns: 0,
    ttftCalls: 0,
    ttftMs: 0,
    thinkingCalls: 0,
    thinkingMs: 0,
    decodeMs: 0,
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegative(value: unknown): number | undefined {
  const parsed = finiteNumber(value)
  return parsed === undefined ? undefined : Math.max(0, parsed)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function validMonth(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  return !!match && Number(match[2]) >= 1 && Number(match[2]) <= 12
}

function daysInMonth(month: string): number {
  const [year, value] = month.split('-').map(Number)
  return new Date(Date.UTC(year, value, 0)).getUTCDate()
}

function defaultTimezone(): string {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function parseRecord(raw: unknown): ParsedTimingRecord | undefined {
  const value = record(raw)
  if (!value) return undefined
  const id = stringValue(value.id)
  const at = finiteNumber(value.at)
  const kind = value.kind
  const sessionKey = stringValue(value.sessionId)
  if (!id || at === undefined || at <= 0 || !sessionKey) return undefined
  if (kind !== 'model' && kind !== 'tool' && kind !== 'run') return undefined
  const scope: TimingScope = value.scope === 'child' ? 'child' : 'root'
  const cwd = stringValue(value.cwd)
  const sessionFile = stringValue(value.sessionFile)
  return {
    id,
    at,
    kind,
    scope,
    sessionKey,
    label: cwd || sessionFile || sessionKey,
    ...(stringValue(value.provider) ? { provider: value.provider as string } : {}),
    ...(stringValue(value.model) ? { model: value.model as string } : {}),
    ...(nonNegative(value.totalMs) === undefined ? {} : { totalMs: nonNegative(value.totalMs) }),
    ...(nonNegative(value.durationMs) === undefined ? {} : { durationMs: nonNegative(value.durationMs) }),
    ...(nonNegative(value.ttftMs) === undefined ? {} : { ttftMs: nonNegative(value.ttftMs) }),
    ...(nonNegative(value.thinkingMs) === undefined ? {} : { thinkingMs: nonNegative(value.thinkingMs) }),
    ...(nonNegative(value.outputTokens) === undefined ? {} : { outputTokens: nonNegative(value.outputTokens) }),
    ...(stringValue(value.toolName) ? { toolName: value.toolName as string } : {}),
    isError: value.isError === true,
  }
}

export class TimingLedger {
  readonly storageDirectory: string
  readonly timezone: string
  readonly refreshIntervalMs: number
  private readonly days = new Map<string, DayBucket>()
  private readonly fileOffsets = new Map<string, number>()
  private started = false
  private lastRefreshAt = 0
  private refreshing?: Promise<void>

  constructor(
    storageDirectory = process.env.PI_DASH_TIMING_DIR || DEFAULT_TIMING_DIRECTORY,
    timezone = process.env.PI_DASH_TIMEZONE || defaultTimezone(),
    refreshIntervalMs = Number(process.env.PI_DASH_TIMING_REFRESH_MS) || REFRESH_INTERVAL_MS,
  ) {
    this.storageDirectory = storageDirectory
    this.timezone = timezone
    this.refreshIntervalMs = refreshIntervalMs
  }

  async start(): Promise<void> {
    if (this.started) return
    await mkdir(this.storageDirectory, { recursive: true, mode: 0o700 })
    this.started = true
  }

  async getReport(range: TimingRange, month?: string, timezone = this.timezone): Promise<TimingReport> {
    await this.refresh()
    const zone = timezone
    const window = this.window(range, month, zone)
    const daily: TimingDailyPoint[] = []
    const total = emptyTotals()
    const models = new Map<string, ModelBucket>()
    const tools = new Map<string, ToolBucket>()
    const sessions = new Map<string, SessionBucket>()
    const coverage: TimingCoverage = { modelCalls: 0, withTtft: 0, withThinking: 0, runs: 0 }
    let recordCount = 0

    for (const date of window.dates) {
      const bucket = this.days.get(date) ?? emptyDay()
      const point = this.dayPoint(date, bucket)
      daily.push(point)
      addTotals(total, point)
      recordCount += bucket.modelCalls + bucket.toolCalls + bucket.runs + bucket.childRuns
      mergeModels(models, bucket.models)
      mergeTools(tools, bucket.tools)
      mergeSessions(sessions, bucket.sessions)
    }

    total.overheadMs = Math.max(0, total.activeMs - total.modelMs - total.toolMs)
    coverage.modelCalls = total.modelCalls
    coverage.withTtft = total.ttftCalls
    coverage.withThinking = total.thinkingCalls
    coverage.runs = total.runs + total.childRuns

    return {
      range,
      ...(range === 'month' && month ? { month } : {}),
      timezone: zone,
      from: window.from,
      to: window.to,
      total,
      daily,
      models: [...models.values()].map(toModelSummary).sort((left, right) => right.totalMs - left.totalMs),
      tools: [...tools.entries()].map(([name, bucket]) => toToolSummary(name, bucket)).sort((left, right) => right.totalMs - left.totalMs),
      sessions: [...sessions.entries()]
        .map(([key, value]) => ({
          key,
          label: value.label,
          runs: value.runs,
          activeMs: value.activeMs,
          modelMs: value.modelMs,
          toolMs: value.toolMs,
        }))
        .sort((left, right) => right.activeMs - left.activeMs),
      recordCount,
      coverage,
    }
  }

  private window(range: TimingRange, month: string | undefined, timezone: string): { dates: string[]; from: number; to: number } {
    if (range === 'month' && month && validMonth(month)) {
      const [year, value] = month.split('-').map(Number)
      const dates = Array.from({ length: daysInMonth(month) }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`)
      return {
        dates,
        from: Date.UTC(year, value - 1, 1),
        to: Date.UTC(year, value, 1) - 1,
      }
    }
    const days = range === '30d' ? 30 : 7
    const today = dateInTimezone(Date.now(), timezone)
    const [year, value, day] = today.split('-').map(Number)
    const end = Date.UTC(year, value - 1, day)
    const from = end - (days - 1) * 24 * 60 * 60 * 1000
    const dates: string[] = []
    for (let offset = 0; offset < days; offset += 1) {
      dates.push(dateInTimezone(from + offset * 24 * 60 * 60 * 1000, timezone))
    }
    return { dates, from, to: end + 24 * 60 * 60 * 1000 - 1 }
  }

  private dayPoint(date: string, bucket: DayBucket): TimingDailyPoint {
    return {
      date,
      activeMs: bucket.activeMs,
      childActiveMs: bucket.childActiveMs,
      modelMs: bucket.modelMs,
      toolMs: bucket.toolMs,
      overheadMs: Math.max(0, bucket.activeMs - bucket.modelMs - bucket.toolMs),
      modelCalls: bucket.modelCalls,
      toolCalls: bucket.toolCalls,
      outputTokens: bucket.outputTokens,
      errors: bucket.errors,
      runs: bucket.runs,
      childRuns: bucket.childRuns,
      ttftCalls: bucket.ttftCalls,
      ttftMs: bucket.ttftMs,
      thinkingCalls: bucket.thinkingCalls,
      thinkingMs: bucket.thinkingMs,
      decodeMs: bucket.decodeMs,
    }
  }

  private async refresh(): Promise<void> {
    await this.start()
    if (this.refreshing) return this.refreshing
    if (Date.now() - this.lastRefreshAt < this.refreshIntervalMs) return
    this.refreshing = this.refreshNow().finally(() => {
      this.refreshing = undefined
      this.lastRefreshAt = Date.now()
    })
    return this.refreshing
  }

  private async refreshNow(): Promise<void> {
    let entries
    try {
      entries = await readdir(this.storageDirectory, { withFileTypes: true })
    } catch {
      return
    }
    const cutoff = Date.now() - SAMPLE_RETENTION_MS
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const file = path.join(this.storageDirectory, entry.name)
      let size = 0
      try {
        size = (await stat(file)).size
      } catch {
        continue
      }
      let offset = this.fileOffsets.get(file) ?? 0
      if (size < offset) offset = 0
      if (size === offset) continue
      const consumed = await this.readTail(file, offset, cutoff).catch(() => 0)
      if (consumed > 0) this.fileOffsets.set(file, consumed)
    }
  }

  /** Reads appended bytes only; returns the new complete-line offset. */
  private async readTail(file: string, offset: number, cutoff: number): Promise<number> {
    const handle = await open(file, 'r')
    try {
      const size = (await handle.stat()).size
      const length = size - offset
      if (length <= 0) return offset
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, offset)
      const text = buffer.toString('utf8')
      const lastNewline = text.lastIndexOf('\n')
      if (lastNewline < 0) return offset
      const complete = text.slice(0, lastNewline)
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          continue
        }
        const parsed = parseRecord(raw)
        if (!parsed || parsed.at < cutoff) continue
        this.ingest(parsed)
      }
      return offset + Buffer.byteLength(complete, 'utf8') + 1
    } finally {
      await handle.close()
    }
  }

  private ingest(entry: ParsedTimingRecord): void {
    const date = dateInTimezone(entry.at, this.timezone)
    let day = this.days.get(date)
    if (!day) {
      day = emptyDay()
      this.days.set(date, day)
    }
    if (entry.kind === 'model') {
      day.modelCalls += 1
      day.outputTokens += entry.outputTokens ?? 0
      if (entry.scope === 'root') day.modelMs += entry.totalMs ?? 0
      if (entry.isError) day.errors += 1
      if (entry.ttftMs !== undefined && entry.totalMs !== undefined) {
        day.ttftCalls += 1
        day.ttftMs += entry.ttftMs
        day.decodeMs += Math.max(0, entry.totalMs - entry.ttftMs)
      }
      if (entry.thinkingMs !== undefined) {
        day.thinkingCalls += 1
        day.thinkingMs += entry.thinkingMs
      }
      const key = `${entry.provider ?? 'unknown'}/${entry.model ?? 'unknown'}`
      const bucket = day.models.get(key) ?? {
        provider: entry.provider ?? 'unknown',
        model: entry.model ?? 'unknown',
        calls: 0,
        errors: 0,
        totalMs: 0,
        outputTokens: 0,
        thinkingMs: 0,
        thinkingCalls: 0,
        ttftCalls: 0,
        ttftMs: 0,
        decodeMs: 0,
        ttftSamples: [],
      }
      bucket.calls += 1
      bucket.totalMs += entry.totalMs ?? 0
      bucket.outputTokens += entry.outputTokens ?? 0
      if (entry.isError) bucket.errors += 1
      if (entry.ttftMs !== undefined && entry.totalMs !== undefined) {
        bucket.ttftCalls += 1
        bucket.ttftMs += entry.ttftMs
        bucket.decodeMs += Math.max(0, entry.totalMs - entry.ttftMs)
        bucket.ttftSamples.push(entry.ttftMs)
      }
      if (entry.thinkingMs !== undefined) {
        bucket.thinkingCalls += 1
        bucket.thinkingMs += entry.thinkingMs
      }
      day.models.set(key, bucket)
      if (entry.scope === 'root') addSession(day, entry.sessionKey, entry.label, session => { session.modelMs += entry.totalMs ?? 0 })
      return
    }
    if (entry.kind === 'tool') {
      day.toolCalls += 1
      if (entry.scope === 'root') day.toolMs += entry.durationMs ?? 0
      if (entry.isError) day.errors += 1
      const name = entry.toolName ?? 'unknown'
      const bucket = day.tools.get(name) ?? { calls: 0, errors: 0, totalMs: 0, durations: [] }
      bucket.calls += 1
      bucket.totalMs += entry.durationMs ?? 0
      if (entry.isError) bucket.errors += 1
      bucket.durations.push(entry.durationMs ?? 0)
      day.tools.set(name, bucket)
      if (entry.scope === 'root') addSession(day, entry.sessionKey, entry.label, session => { session.toolMs += entry.durationMs ?? 0 })
      return
    }
    if (entry.scope === 'child') {
      day.childRuns += 1
      day.childActiveMs += entry.durationMs ?? 0
      return
    }
    day.runs += 1
    day.activeMs += entry.durationMs ?? 0
    addSession(day, entry.sessionKey, entry.label, session => {
      session.runs += 1
      session.activeMs += entry.durationMs ?? 0
    })
  }
}

function addSession(
  day: DayBucket,
  key: string,
  label: string,
  update: (session: SessionBucket) => void,
): void {
  const session = day.sessions.get(key) ?? { label, runs: 0, activeMs: 0, modelMs: 0, toolMs: 0 }
  session.label = label || session.label
  update(session)
  day.sessions.set(key, session)
}

function addTotals(target: TimingTotals, point: TimingDailyPoint): void {
  target.activeMs += point.activeMs
  target.childActiveMs += point.childActiveMs
  target.modelMs += point.modelMs
  target.toolMs += point.toolMs
  target.modelCalls += point.modelCalls
  target.toolCalls += point.toolCalls
  target.outputTokens += point.outputTokens
  target.errors += point.errors
  target.runs += point.runs
  target.childRuns += point.childRuns
  target.ttftCalls += point.ttftCalls
  target.ttftMs += point.ttftMs
  target.thinkingCalls += point.thinkingCalls
  target.thinkingMs += point.thinkingMs
  target.decodeMs += point.decodeMs
}

function mergeModels(target: Map<string, ModelBucket>, source: Map<string, ModelBucket>): void {
  for (const [key, bucket] of source) {
    const current = target.get(key)
    if (!current) {
      target.set(key, { ...bucket, ttftSamples: [...bucket.ttftSamples] })
      continue
    }
    current.calls += bucket.calls
    current.errors += bucket.errors
    current.totalMs += bucket.totalMs
    current.outputTokens += bucket.outputTokens
    current.thinkingMs += bucket.thinkingMs
    current.thinkingCalls += bucket.thinkingCalls
    current.ttftCalls += bucket.ttftCalls
    current.ttftMs += bucket.ttftMs
    current.decodeMs += bucket.decodeMs
    current.ttftSamples.push(...bucket.ttftSamples)
  }
}

function mergeTools(target: Map<string, ToolBucket>, source: Map<string, ToolBucket>): void {
  for (const [key, bucket] of source) {
    const current = target.get(key)
    if (!current) {
      target.set(key, { ...bucket, durations: [...bucket.durations] })
      continue
    }
    current.calls += bucket.calls
    current.errors += bucket.errors
    current.totalMs += bucket.totalMs
    current.durations.push(...bucket.durations)
  }
}

function mergeSessions(target: Map<string, SessionBucket>, source: Map<string, SessionBucket>): void {
  for (const [key, bucket] of source) {
    const current = target.get(key)
    if (!current) {
      target.set(key, { ...bucket })
      continue
    }
    current.runs += bucket.runs
    current.activeMs += bucket.activeMs
    current.modelMs += bucket.modelMs
    current.toolMs += bucket.toolMs
    if (bucket.label) current.label = bucket.label
  }
}

function toModelSummary(bucket: ModelBucket): TimingModelSummary {
  const sorted = [...bucket.ttftSamples].sort((left, right) => left - right)
  const decodeSeconds = bucket.decodeMs / 1000
  return {
    key: `${bucket.provider}/${bucket.model}`,
    provider: bucket.provider,
    model: bucket.model,
    calls: bucket.calls,
    errors: bucket.errors,
    totalMs: bucket.totalMs,
    avgTotalMs: bucket.calls > 0 ? bucket.totalMs / bucket.calls : 0,
    ttftCalls: bucket.ttftCalls,
    ttftAvgMs: bucket.ttftCalls > 0 ? bucket.ttftMs / bucket.ttftCalls : 0,
    ttftP50Ms: percentile(sorted, 0.5),
    ttftP90Ms: percentile(sorted, 0.9),
    outputTokens: bucket.outputTokens,
    decodeTokensPerSec: decodeSeconds > 0 ? bucket.outputTokens / decodeSeconds : 0,
    thinkingCalls: bucket.thinkingCalls,
    thinkingMs: bucket.thinkingMs,
    thinkingAvgMs: bucket.thinkingCalls > 0 ? bucket.thinkingMs / bucket.thinkingCalls : 0,
    thinkingShare: bucket.totalMs > 0 ? bucket.thinkingMs / bucket.totalMs : 0,
  }
}

function toToolSummary(name: string, bucket: ToolBucket): TimingToolSummary {
  const sorted = [...bucket.durations].sort((left, right) => left - right)
  return {
    name,
    calls: bucket.calls,
    errors: bucket.errors,
    totalMs: bucket.totalMs,
    avgMs: bucket.calls > 0 ? bucket.totalMs / bucket.calls : 0,
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
  }
}