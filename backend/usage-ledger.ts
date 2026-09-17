import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'
import type { LiveSessionEventMessage, LiveSessionSummary } from '../shared/src/live-sessions.js'
import type {
  UsageDailyPoint,
  UsageModelSummary,
  UsageReport,
  UsageSessionSummary,
  UsageTotals,
} from '../shared/src/usage.js'

export const DEFAULT_USAGE_DIRECTORY = '/mnt/workspace/lilong/agent/pi/token-usage'

export interface UsageLedgerMessageMeta {
  sessionId?: string
  sessionFile?: string
  processInstanceId?: string
  slotKey?: string
  label?: string
  cwd?: string
}

interface UsageRecord extends UsageTotals {
  id: string
  at: number
  sessionKey: string
  sessionId?: string
  sessionFile?: string
  processInstanceId?: string
  slotKey?: string
  label?: string
  cwd?: string
  modelKey: string
}

interface RawUsage {
  input?: unknown
  output?: unknown
  cacheRead?: unknown
  cacheWrite?: unknown
  totalTokens?: unknown
  cost?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; total?: unknown }
}

interface FileCacheEntry {
  size: number
  mtimeMs: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function usageTotals(value: unknown): UsageTotals | undefined {
  const raw = record(value) as RawUsage | undefined
  if (!raw) return undefined
  const inputTokens = finiteNonNegative(raw.input)
  const outputTokens = finiteNonNegative(raw.output)
  const cacheReadTokens = finiteNonNegative(raw.cacheRead)
  const cacheWriteTokens = finiteNonNegative(raw.cacheWrite)
  const totalTokens = typeof raw.totalTokens === 'number' && Number.isFinite(raw.totalTokens) && raw.totalTokens >= 0
    ? raw.totalTokens
    : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  const cost = record(raw.cost)
  const costUsd = finiteNonNegative(cost?.total)
  const componentCost = {
    inputCostUsd: finiteNonNegative(cost?.input),
    outputCostUsd: finiteNonNegative(cost?.output),
    cacheReadCostUsd: finiteNonNegative(cost?.cacheRead),
    cacheWriteCostUsd: finiteNonNegative(cost?.cacheWrite),
  }
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0 && costUsd === 0) return undefined
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, costUsd, ...componentCost }
}

function storedUsage(value: Partial<UsageRecord>): UsageTotals | undefined {
  const totals: UsageTotals = {
    inputTokens: finiteNonNegative(value.inputTokens),
    outputTokens: finiteNonNegative(value.outputTokens),
    cacheReadTokens: finiteNonNegative(value.cacheReadTokens),
    cacheWriteTokens: finiteNonNegative(value.cacheWriteTokens),
    totalTokens: finiteNonNegative(value.totalTokens),
    costUsd: finiteNonNegative(value.costUsd),
    inputCostUsd: finiteNonNegative(value.inputCostUsd),
    outputCostUsd: finiteNonNegative(value.outputCostUsd),
    cacheReadCostUsd: finiteNonNegative(value.cacheReadCostUsd),
    cacheWriteCostUsd: finiteNonNegative(value.cacheWriteCostUsd),
  }
  return totals.totalTokens > 0 || totals.costUsd > 0 ? totals : undefined
}

function addTotals(target: UsageTotals, value: UsageTotals): void {
  target.inputTokens += value.inputTokens
  target.outputTokens += value.outputTokens
  target.cacheReadTokens += value.cacheReadTokens
  target.cacheWriteTokens += value.cacheWriteTokens
  target.totalTokens += value.totalTokens
  target.costUsd += value.costUsd
  target.inputCostUsd += value.inputCostUsd
  target.outputCostUsd += value.outputCostUsd
  target.cacheReadCostUsd += value.cacheReadCostUsd
  target.cacheWriteCostUsd += value.cacheWriteCostUsd
}

function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, inputCostUsd: 0, outputCostUsd: 0, cacheReadCostUsd: 0, cacheWriteCostUsd: 0 }
}

function effectiveUsdPerMillionTokens(value: UsageTotals): number {
  const pricedTokens = value.inputTokens + value.outputTokens + value.cacheReadTokens + value.cacheWriteTokens
  return pricedTokens > 0 ? (value.costUsd / pricedTokens) * 1_000_000 : 0
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function timestampOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  const raw = stringValue(value)
  if (!raw) return undefined
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function modelKeyOf(message: Record<string, unknown>): string {
  if (message.role === 'toolResult') return 'Tools/summaries'
  const provider = stringValue(message.provider) || 'unknown'
  const model = stringValue(message.responseModel) || stringValue(message.model) || 'unknown'
  // Self-hosted servers often echo a provider-qualified canonical name (for
  // example a vLLM `--served-model-name` of `dsw/deepseek_v41_flash`). Adding
  // the provider again would produce `dsw/dsw/deepseek_v41_flash`, so keep a
  // model name that already carries the provider prefix as the whole key.
  if (provider !== 'unknown' && model.startsWith(`${provider}/`)) return model
  return `${provider}/${model}`
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function validMonth(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  return !!match && Number(match[2]) >= 1 && Number(match[2]) <= 12
}

function defaultTimezone(): string {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function dateInTimezone(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at))
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function monthInTimezone(at: number, timezone: string): string {
  return dateInTimezone(at, timezone).slice(0, 7)
}

function daysInMonth(month: string): number {
  const [year, value] = month.split('-').map(Number)
  return new Date(Date.UTC(year, value, 0)).getUTCDate()
}

function isUsageMessage(message: Record<string, unknown>): boolean {
  return message.role === 'assistant' || message.role === 'toolResult'
}

export class UsageLedger {
  readonly storageDirectory: string
  readonly timezone: string
  private readonly recordsByMonth = new Map<string, Map<string, UsageRecord>>()
  private readonly loadedMonths = new Set<string>()
  private readonly loadPromises = new Map<string, Promise<void>>()
  private readonly fileCache = new Map<string, FileCacheEntry>()
  private readonly fileTails = new Map<string, Promise<number>>()
  private writeTail: Promise<void> = Promise.resolve()
  private startPromise?: Promise<void>

  constructor(
    storageDirectory = process.env.PI_DASH_USAGE_DIR || DEFAULT_USAGE_DIRECTORY,
    timezone = process.env.PI_DASH_TIMEZONE || defaultTimezone(),
  ) {
    this.storageDirectory = storageDirectory
    this.timezone = timezone
  }

  start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = mkdir(this.storageDirectory, { recursive: true, mode: 0o700 }).then(() => undefined)
    }
    return this.startPromise
  }

  async ingestSessionFile(sessionFile: string | undefined, meta: UsageLedgerMessageMeta = {}): Promise<number> {
    if (!sessionFile) return 0
    await this.start()
    const previous = this.fileTails.get(sessionFile) || Promise.resolve(0)
    const current = previous.then(() => this.ingestSessionFileNow(sessionFile, meta))
    this.fileTails.set(sessionFile, current.catch(() => 0))
    return current
  }

  async recordLiveEvent(message: LiveSessionEventMessage, summary?: LiveSessionSummary): Promise<boolean> {
    if (message.event.type !== 'message_end') return false
    const data = record(message.event.data)
    const sourceMessage = record(data?.message)
    if (!sourceMessage || !isUsageMessage(sourceMessage)) return false
    const usage = usageTotals(sourceMessage.usage)
    if (!usage) return false

    const entryId = stringValue(data?.entryId)
    if (!entryId && summary?.sessionFile) {
      await this.ingestSessionFile(summary.sessionFile, {
        sessionId: summary.sessionId,
        sessionFile: summary.sessionFile,
        processInstanceId: summary.processInstanceId,
        label: summary.sessionName || summary.canonicalCwd,
        cwd: summary.canonicalCwd,
      })
      return true
    }

    return this.recordUsage({
      id: this.messageId({
        sourceKey: summary?.sessionFile || summary?.sessionId || message.processInstanceId,
        entryId,
        message: sourceMessage,
        sequence: message.sequence,
      }),
      at: timestampOf(sourceMessage.timestamp) || Date.now(),
      usage,
      modelKey: modelKeyOf(sourceMessage),
      meta: {
        sessionId: summary?.sessionId,
        sessionFile: summary?.sessionFile,
        processInstanceId: summary?.processInstanceId || message.processInstanceId,
        label: summary?.sessionName || summary?.canonicalCwd,
        cwd: summary?.canonicalCwd,
      },
    })
  }

  async getReport(month: string, timezone = this.timezone): Promise<UsageReport> {
    await this.start()
    if (!validMonth(month)) throw new Error('month must use YYYY-MM format')
    await this.loadMonth(month)
    const records = this.recordsByMonth.get(month) || new Map<string, UsageRecord>()

    const daily = new Map<string, UsageTotals>()
    const dailyModels = new Map<string, Map<string, UsageTotals>>()
    const models = new Map<string, UsageTotals>()
    const sessions = new Map<string, { totals: UsageTotals; label: string; sessionId?: string; sessionFile?: string; cwd?: string }>()
    const prefix = `${month}-`

    for (const item of records.values()) {
      const date = dateInTimezone(item.at, timezone)
      if (!date.startsWith(prefix)) continue
      const day = daily.get(date) || emptyTotals()
      addTotals(day, item)
      daily.set(date, day)
      const dayModels = dailyModels.get(date) || new Map<string, UsageTotals>()
      const dayModel = dayModels.get(item.modelKey) || emptyTotals()
      addTotals(dayModel, item)
      dayModels.set(item.modelKey, dayModel)
      dailyModels.set(date, dayModels)

      const model = models.get(item.modelKey) || emptyTotals()
      addTotals(model, item)
      models.set(item.modelKey, model)

      const session = sessions.get(item.sessionKey) || {
        totals: emptyTotals(),
        label: item.label || item.sessionKey,
        sessionId: item.sessionId,
        sessionFile: item.sessionFile,
        cwd: item.cwd,
      }
      addTotals(session.totals, item)
      if (item.label) session.label = item.label
      sessions.set(item.sessionKey, session)
    }

    const total = emptyTotals()
    for (const value of daily.values()) addTotals(total, value)
    const dailyPoints: UsageDailyPoint[] = []
    for (let day = 1; day <= daysInMonth(month); day += 1) {
      const date = `${month}-${String(day).padStart(2, '0')}`
      const modelsForDay = [...(dailyModels.get(date) || new Map<string, UsageTotals>()).entries()]
        .map(([key, totals]) => ({ key, ...totals, effectiveUsdPerMillionTokens: effectiveUsdPerMillionTokens(totals) }))
        .sort((left, right) => right.costUsd - left.costUsd)
      dailyPoints.push({ date, ...(daily.get(date) || emptyTotals()), models: modelsForDay })
    }

    const modelsResult: UsageModelSummary[] = [...models.entries()]
      .map(([key, totals]) => ({ key, ...totals, effectiveUsdPerMillionTokens: effectiveUsdPerMillionTokens(totals) }))
      .sort((left, right) => right.costUsd - left.costUsd)
    const sessionsResult: UsageSessionSummary[] = [...sessions.entries()]
      .map(([key, value]) => ({
        key,
        label: value.label,
        ...(value.sessionId ? { sessionId: value.sessionId } : {}),
        ...(value.sessionFile ? { sessionFile: value.sessionFile } : {}),
        ...(value.cwd ? { cwd: value.cwd } : {}),
        ...value.totals,
      }))
      .sort((left, right) => right.costUsd - left.costUsd)

    return {
      month,
      timezone,
      currency: 'USD',
      total,
      daily: dailyPoints,
      models: modelsResult,
      sessions: sessionsResult,
      recordCount: records.size,
    }
  }

  private filePath(month: string): string {
    return path.join(this.storageDirectory, `${month}.jsonl`)
  }

  private async loadMonth(month: string): Promise<void> {
    if (this.loadedMonths.has(month)) return
    const previous = this.loadPromises.get(month)
    if (previous) return previous
    const current = this.loadMonthNow(month)
    this.loadPromises.set(month, current)
    return current
  }

  private async loadMonthNow(month: string): Promise<void> {
    const monthRecords = new Map<string, UsageRecord>()
    try {
      const content = await readFile(this.filePath(month), 'utf8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const value = JSON.parse(line) as Partial<UsageRecord>
          const usage = storedUsage(value)
          if (!value.id || typeof value.id !== 'string' || typeof value.at !== 'number' || !value.modelKey || !value.sessionKey || !usage) continue
          monthRecords.set(value.id, {
            id: value.id,
            at: value.at,
            sessionKey: value.sessionKey,
            modelKey: value.modelKey,
            ...(value.sessionId ? { sessionId: value.sessionId } : {}),
            ...(value.sessionFile ? { sessionFile: value.sessionFile } : {}),
            ...(value.processInstanceId ? { processInstanceId: value.processInstanceId } : {}),
            ...(value.slotKey ? { slotKey: value.slotKey } : {}),
            ...(value.label ? { label: value.label } : {}),
            ...(value.cwd ? { cwd: value.cwd } : {}),
            ...usage,
          })
        } catch {
          // A partially-written line is ignored; the source session remains authoritative.
        }
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
    this.recordsByMonth.set(month, monthRecords)
    this.loadedMonths.add(month)
  }

  private async ingestSessionFileNow(sessionFile: string, meta: UsageLedgerMessageMeta): Promise<number> {
    let fileStats
    try {
      fileStats = await stat(sessionFile)
    } catch (error: any) {
      if (error?.code === 'ENOENT') return 0
      throw error
    }
    const cached = this.fileCache.get(sessionFile)
    if (cached && cached.size === fileStats.size && cached.mtimeMs === fileStats.mtimeMs) return 0

    let sessionId = meta.sessionId
    let added = 0
    const input = createReadStream(sessionFile, { encoding: 'utf8' })
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (!line.trim()) continue
        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (entry.type === 'session') {
          sessionId = stringValue(entry.id) || sessionId
          continue
        }
        const entryId = stringValue(entry.id)
        const message = record(entry.message)
        if (entry.type === 'message' && message && isUsageMessage(message)) {
          if (await this.recordMessage(message, entryId, { ...meta, sessionId, sessionFile }, entry.timestamp)) added += 1
          continue
        }
        const summaryUsage = usageTotals(entry.usage)
        if ((entry.type === 'compaction' || entry.type === 'branch_summary') && summaryUsage) {
          if (await this.recordUsage({
            id: `${sessionFile}#${entryId || fingerprint(entry)}`,
            at: timestampOf(entry.timestamp) || Date.now(),
            usage: summaryUsage,
            modelKey: 'Tools/summaries',
            meta: { ...meta, sessionId, sessionFile },
          })) added += 1
        }
      }
    } finally {
      lines.close()
      input.destroy()
    }
    this.fileCache.set(sessionFile, { size: fileStats.size, mtimeMs: fileStats.mtimeMs })
    return added
  }

  private async recordMessage(message: Record<string, unknown>, entryId: string | undefined, meta: UsageLedgerMessageMeta, entryTimestamp?: unknown): Promise<boolean> {
    const usage = usageTotals(message.usage)
    if (!usage) return false
    return this.recordUsage({
      id: this.messageId({ sourceKey: meta.sessionFile || meta.sessionId || meta.slotKey || 'session', entryId, message }),
      at: timestampOf(message.timestamp) || timestampOf(entryTimestamp) || Date.now(),
      usage,
      modelKey: modelKeyOf(message),
      meta,
    })
  }

  private messageId(input: { sourceKey: string; entryId?: string; message: Record<string, unknown>; sequence?: number }): string {
    if (input.entryId) return `${input.sourceKey}#${input.entryId}`
    return `${input.sourceKey}#message-${fingerprint({
      role: input.message.role,
      timestamp: input.message.timestamp,
      provider: input.message.provider,
      model: input.message.responseModel || input.message.model,
      usage: input.message.usage,
      sequence: input.sequence,
    })}`
  }

  private async recordUsage(input: { id: string; at: number; usage: UsageTotals; modelKey: string; meta: UsageLedgerMessageMeta }): Promise<boolean> {
    await this.start()
    const month = monthInTimezone(input.at, this.timezone)
    await this.loadMonth(month)
    const monthRecords = this.recordsByMonth.get(month)!
    if (monthRecords.has(input.id)) return false

    const sessionKey = input.meta.sessionId || input.meta.sessionFile || input.meta.processInstanceId || input.meta.slotKey || 'unknown-session'
    const item: UsageRecord = {
      id: input.id,
      at: input.at,
      sessionKey,
      modelKey: input.modelKey,
      ...input.usage,
      ...(input.meta.sessionId ? { sessionId: input.meta.sessionId } : {}),
      ...(input.meta.sessionFile ? { sessionFile: input.meta.sessionFile } : {}),
      ...(input.meta.processInstanceId ? { processInstanceId: input.meta.processInstanceId } : {}),
      ...(input.meta.slotKey ? { slotKey: input.meta.slotKey } : {}),
      ...(input.meta.label ? { label: input.meta.label } : {}),
      ...(input.meta.cwd ? { cwd: input.meta.cwd } : {}),
    }
    monthRecords.set(item.id, item)
    const line = `${JSON.stringify(item)}\n`
    const write = this.writeTail.then(() => appendFile(this.filePath(month), line, 'utf8'))
    this.writeTail = write.catch(() => undefined)
    try {
      await write
    } catch (error) {
      monthRecords.delete(item.id)
      throw error
    }
    return true
  }
}
