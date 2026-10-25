import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentDir } from './env-file.js'
import { dateInTimezone } from './usage-ledger.js'
import type {
  SubagentStats,
  SubagentStatsDay,
  SubagentStatsFailure,
  SubagentStatsGroup,
  SubagentStatsTotals,
} from '../shared/src/subagent-stats.js'

const OPEN = new Set(['queued', 'running', 'paused'])
const MAX_FAILURES = 12

interface LedgerRow {
  workId: string
  kind: 'agent' | 'workflow'
  status: string
  label?: string
  role?: string
  tier?: string
  model?: string
  error?: string
  createdAt?: number
  startedAt?: number
  completedAt?: number
  at?: number
  tasks?: number
  tasksFailed?: number
}

export interface SubagentStatsOptions {
  /** Directory holding `subagent-jobs.jsonl`; defaults to the pi agent dir. */
  ledgerDir?: string
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseRow(line: string): LedgerRow | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const workId = asString(raw.workId)
  const status = asString(raw.status)
  if (!workId || !status) return undefined
  const kind = raw.kind === 'workflow' ? 'workflow' : 'agent'
  return {
    workId,
    kind,
    status,
    label: asString(raw.label),
    role: asString(raw.role),
    tier: asString(raw.tier),
    model: asString(raw.model),
    error: asString(raw.error),
    createdAt: asNumber(raw.createdAt),
    startedAt: asNumber(raw.startedAt),
    completedAt: asNumber(raw.completedAt),
    at: asNumber(raw.at),
    tasks: asNumber(raw.tasks),
    tasksFailed: asNumber(raw.tasksFailed),
  }
}

function emptyBuckets() {
  return { launched: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, running: 0 }
}

function bump(bucket: ReturnType<typeof emptyBuckets>, status: string): void {
  bucket.launched += 1
  if (status === 'completed') bucket.completed += 1
  else if (status === 'failed') bucket.failed += 1
  else if (status === 'cancelled') bucket.cancelled += 1
  else if (status === 'interrupted') bucket.interrupted += 1
  else if (OPEN.has(status)) bucket.running += 1
}

function successRate(completed: number, failed: number): number {
  const denominator = completed + failed
  return denominator > 0 ? completed / denominator : 0
}

function group(
  entries: readonly { key: string; status: string }[],
): SubagentStatsGroup[] {
  const buckets = new Map<string, ReturnType<typeof emptyBuckets>>()
  for (const entry of entries) {
    const bucket = buckets.get(entry.key) ?? emptyBuckets()
    bump(bucket, entry.status)
    buckets.set(entry.key, bucket)
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      ...bucket,
      successRate: successRate(bucket.completed, bucket.failed),
    }))
    .sort((left, right) => right.launched - left.launched)
}

function totalsOf(entries: readonly { status: string; tasks?: number; tasksFailed?: number }[]): SubagentStatsTotals {
  const bucket = emptyBuckets()
  let tasks = 0
  let tasksFailed = 0
  for (const entry of entries) {
    bump(bucket, entry.status)
    tasks += entry.tasks ?? 0
    tasksFailed += entry.tasksFailed ?? 0
  }
  return {
    ...bucket,
    settled: bucket.completed + bucket.failed + bucket.cancelled + bucket.interrupted,
    successRate: successRate(bucket.completed, bucket.failed),
    tasks,
    tasksFailed,
  }
}

/**
 * Reads the append-only ledger the subagent extension writes on every launch
 * and settlement. The ledger keeps one row per event, so the last row per
 * workId is the job's current state.
 */
export class SubagentStatsLedger {
  readonly ledgerDir: string

  constructor(options: SubagentStatsOptions = {}) {
    this.ledgerDir = options.ledgerDir ?? agentDir()
  }

  private get ledgerPath(): string {
    return join(this.ledgerDir, 'subagent-jobs.jsonl')
  }

  async getReport(windowDays = 7, timezone = ''): Promise<SubagentStats> {
    const zone = timezone || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const days = Math.min(90, Math.max(1, Math.round(windowDays)))
    const now = Date.now()
    const today = dateInTimezone(now, zone)
    const startDate = dateInTimezone(now - (days - 1) * 86_400_000, zone)

    let content = ''
    let empty = false
    try {
      content = await readFile(this.ledgerPath, 'utf8')
    } catch {
      empty = true
    }

    let records = 0
    const latest = new Map<string, LedgerRow>()
    for (const line of content.split('\n')) {
      if (!line.includes('workId')) continue
      const row = parseRow(line)
      if (!row) continue
      records += 1
      latest.set(row.workId, { ...latest.get(row.workId), ...row })
    }

    const inWindow = (row: LedgerRow): boolean => {
      const at = row.completedAt ?? row.startedAt ?? row.createdAt ?? row.at ?? 0
      if (at <= 0) return false
      const date = dateInTimezone(at, zone)
      return date >= startDate && date <= today
    }

    const selected = [...latest.values()].filter(inWindow)
    const dayBuckets = new Map<string, SubagentStatsDay>()
    for (let index = days - 1; index >= 0; index -= 1) {
      const date = dateInTimezone(now - index * 86_400_000, zone)
      dayBuckets.set(date, { date, ...emptyBuckets(), tasks: 0, tasksFailed: 0 })
    }
    for (const row of selected) {
      const at = row.completedAt ?? row.startedAt ?? row.createdAt ?? row.at ?? now
      const date = dateInTimezone(at, zone)
      const bucket = dayBuckets.get(date)
      if (!bucket) continue
      bump(bucket, row.status)
      bucket.tasks += row.tasks ?? 0
      bucket.tasksFailed += row.tasksFailed ?? 0
    }

    const failures: SubagentStatsFailure[] = selected
      .filter((row) => row.status === 'failed' || row.status === 'interrupted')
      .sort(
        (left, right) =>
          (right.completedAt ?? right.at ?? 0) - (left.completedAt ?? left.at ?? 0),
      )
      .slice(0, MAX_FAILURES)
      .map((row) => ({
        workId: row.workId,
        kind: row.kind,
        status: row.status,
        label: row.label,
        role: row.role,
        tier: row.tier,
        model: row.model,
        error: row.error?.slice(0, 300),
        at: row.completedAt ?? row.at ?? 0,
      }))

    return {
      windowDays: days,
      timezone: zone,
      records,
      empty,
      totals: totalsOf(selected),
      byKind: group(selected.map((row) => ({ key: row.kind, status: row.status }))),
      // An omitted role means `code` in the controller, so both land in one row.
      byRole: group(
        selected.map((row) => ({ key: row.role ?? 'code', status: row.status })),
      ),
      byTier: group(
        selected.map((row) => ({ key: row.tier ?? '(按角色默认)', status: row.status })),
      ),
      byModel: group(
        selected
          .filter((row) => row.model)
          .map((row) => ({ key: row.model as string, status: row.status })),
      ),
      days: [...dayBuckets.values()],
      recentFailures: failures,
    }
  }
}
