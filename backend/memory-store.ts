/**
 * Read-only view of the Pi long-term memory database.
 *
 * The memory extension (`pi-tsien-memory`) owns `~/.pi/tsien-memory/memory.db`. The dashboard never
 * writes to it: this module only answers what the agent remembers, what it changed on its own, what
 * is waiting for a human, and whether recalled memory actually reached the model.
 *
 * The legacy `~/.pi/memory/memory.db` used by earlier dashboard builds is intentionally ignored.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const STATUSES = ['active', 'candidate', 'stale', 'superseded', 'rejected', 'forgotten'] as const
export type MemoryStatus = (typeof STATUSES)[number]

export interface MemorySourceView {
  authority: string
  verified: boolean
  sourceType: string
  sourceUri: string
}

export interface MemoryItemView {
  id: string
  kind: string
  status: MemoryStatus
  scopeType: string
  scopeKey: string
  content: string
  confidence: number
  version: number
  observedCount: number
  verifiedCount: number
  appliedCount: number
  correctedCount: number
  createdAt: number
  updatedAt: number
  source?: MemorySourceView
  conflicts: number
}

export interface MemoryChangeView {
  id: string
  memoryId: string
  eventType: string
  fromStatus?: string
  toStatus?: string
  actor: string
  reasonCode: string
  createdAt: number
  contentPreview: string
}

export interface MemoryOverview {
  available: boolean
  databasePath: string
  hint?: string
  counts: Record<MemoryStatus, number> & { total: number }
  review: { total: number; conflicts: number; unverified: number; scopeEscalation: number }
  usage: {
    recallRuns: number
    recallCandidates: number
    contextInjected: number
    verified: number
    corrected: number
    lastActivityAt?: number
  }
  health: { pendingIndexJobs: number; failedIndexJobs: number; lastEventAt?: number }
  selfManagement: { autoAccepted: number; agentCreated: number; userDecided: number; rejectedByAgent: number }
}

export function memoryDataDir(): string {
  return process.env.PI_TSIEN_MEMORY_DIR?.trim() || join(homedir(), '.pi', 'tsien-memory')
}

export function memoryDatabasePath(): string {
  return join(memoryDataDir(), 'memory.db')
}

function openReadOnly(): DatabaseSync | undefined {
  const path = memoryDatabasePath()
  if (!existsSync(path)) return undefined
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return undefined
  }
}

function scalar(db: DatabaseSync, sql: string, fallback = 0): number {
  try {
    const rows = db.prepare(sql).all() as Array<Record<string, unknown>>
    const first = rows[0]
    if (!first) return fallback
    const value = Object.values(first)[0]
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : fallback
  } catch {
    return fallback
  }
}

function unavailable(hint: string): MemoryOverview {
  return {
    available: false,
    databasePath: memoryDatabasePath(),
    hint,
    counts: { active: 0, candidate: 0, stale: 0, superseded: 0, rejected: 0, forgotten: 0, total: 0 },
    review: { total: 0, conflicts: 0, unverified: 0, scopeEscalation: 0 },
    usage: { recallRuns: 0, recallCandidates: 0, contextInjected: 0, verified: 0, corrected: 0 },
    health: { pendingIndexJobs: 0, failedIndexJobs: 0 },
    selfManagement: { autoAccepted: 0, agentCreated: 0, userDecided: 0, rejectedByAgent: 0 },
  }
}

export function getMemoryOverview(): MemoryOverview {
  const path = memoryDatabasePath()
  if (!existsSync(path)) {
    return unavailable('没有找到记忆数据库。启动一次 Pi 会话并让 pi-tsien-memory 扩展运行后即可生成。')
  }
  const db = openReadOnly()
  if (!db) return unavailable('记忆数据库存在但无法只读打开，请检查文件权限。')
  try {
    const counts = { active: 0, candidate: 0, stale: 0, superseded: 0, rejected: 0, forgotten: 0 } as Record<MemoryStatus, number>
    try {
      for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM memory_items GROUP BY status').all() as Array<{ status: string; n: number }>) {
        if ((STATUSES as readonly string[]).includes(row.status)) counts[row.status as MemoryStatus] = Number(row.n)
      }
    } catch {
      return unavailable('记忆数据库结构无法识别，可能是不兼容的旧版本。')
    }
    const total = STATUSES.reduce((sum, status) => sum + counts[status], 0)

    const reviewConflicts = scalar(db, `SELECT COUNT(DISTINCT i.id) AS n FROM memory_items i JOIN memory_relations r ON r.from_memory_id = i.id AND r.relation = 'conflicts_with' JOIN memory_items t ON t.id = r.to_memory_id AND t.status IN ('active','candidate','stale') WHERE i.status = 'candidate'`)
    const reviewUnverified = scalar(db, `SELECT COUNT(*) AS n FROM memory_items i WHERE i.status = 'candidate' AND NOT EXISTS (SELECT 1 FROM memory_sources s JOIN memory_revisions v ON v.id = s.revision_id WHERE v.memory_id = i.id AND s.verified = 1 AND s.authority IN ('user_explicit','user_confirmed','verified_tool'))`)
    const reviewScope = scalar(db, `SELECT COUNT(*) AS n FROM memory_items i WHERE i.status = 'candidate' AND i.scope_type = 'global'`)

    const usage = {
      recallRuns: scalar(db, 'SELECT COUNT(*) AS n FROM recall_runs'),
      recallCandidates: scalar(db, 'SELECT COALESCE(SUM(injected_count), 0) AS n FROM recall_runs'),
      contextInjected: scalar(db, `SELECT COUNT(*) AS n FROM application_events WHERE outcome = 'injected'`),
      verified: scalar(db, `SELECT COUNT(*) AS n FROM application_events WHERE outcome = 'verified'`),
      corrected: scalar(db, `SELECT COUNT(*) AS n FROM application_events WHERE outcome = 'corrected'`),
      lastActivityAt: optionalScalar(db, 'SELECT MAX(created_at) AS n FROM memory_events'),
    }

    return {
      available: true,
      databasePath: path,
      counts: { ...counts, total },
      review: { total: counts.candidate, conflicts: reviewConflicts, unverified: reviewUnverified, scopeEscalation: reviewScope },
      usage,
      health: {
        pendingIndexJobs: scalar(db, `SELECT COUNT(*) AS n FROM index_outbox WHERE state IN ('pending','failed')`),
        failedIndexJobs: scalar(db, `SELECT COUNT(*) AS n FROM index_outbox WHERE state = 'failed'`),
        lastEventAt: optionalScalar(db, 'SELECT MAX(created_at) AS n FROM memory_events'),
      },
      selfManagement: {
        autoAccepted: scalar(db, `SELECT COUNT(*) AS n FROM memory_events WHERE actor = 'system' AND reason_code LIKE 'evidence_%'`),
        agentCreated: scalar(db, `SELECT COUNT(*) AS n FROM memory_events WHERE actor = 'agent'`),
        userDecided: scalar(db, `SELECT COUNT(*) AS n FROM memory_events WHERE actor = 'user' AND reason_code IN ('candidate_confirmed','candidate_rejected')`),
        rejectedByAgent: scalar(db, `SELECT COUNT(*) AS n FROM memory_events WHERE actor = 'agent' AND to_status = 'rejected'`),
      },
    }
  } finally {
    db.close()
  }
}

function optionalScalar(db: DatabaseSync, sql: string): number | undefined {
  try {
    const rows = db.prepare(sql).all() as Array<Record<string, unknown>>
    const value = rows[0] ? Object.values(rows[0])[0] : undefined
    const numeric = Number(value)
    return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined
  } catch {
    return undefined
  }
}

interface ItemRow {
  id: string
  kind: string
  status: string
  scope_type: string
  scope_key: string
  confidence: number
  version: number
  observed_count: number
  verified_count: number
  applied_count: number
  corrected_count: number
  created_at: number
  updated_at: number
  content: string | null
  authority: string | null
  verified: number | null
  source_type: string | null
  source_uri: string | null
  conflicts: number
}

const ITEM_SELECT = `
  SELECT i.id, i.kind, i.status, i.scope_type, i.scope_key, i.confidence, i.version,
         i.observed_count, i.verified_count, i.applied_count, i.corrected_count,
         i.created_at, i.updated_at,
         v.content,
         (SELECT s.authority FROM memory_sources s WHERE s.revision_id = i.current_revision_id ORDER BY s.created_at DESC LIMIT 1) AS authority,
         (SELECT s.verified FROM memory_sources s WHERE s.revision_id = i.current_revision_id ORDER BY s.created_at DESC LIMIT 1) AS verified,
         (SELECT s.source_type FROM memory_sources s WHERE s.revision_id = i.current_revision_id ORDER BY s.created_at DESC LIMIT 1) AS source_type,
         (SELECT s.source_uri FROM memory_sources s WHERE s.revision_id = i.current_revision_id ORDER BY s.created_at DESC LIMIT 1) AS source_uri,
         (SELECT COUNT(*) FROM memory_relations r JOIN memory_items t ON t.id = r.to_memory_id
            WHERE r.from_memory_id = i.id AND r.relation = 'conflicts_with' AND t.status IN ('active','candidate','stale')) AS conflicts
    FROM memory_items i
    LEFT JOIN memory_revisions v ON v.id = i.current_revision_id`

function toItem(row: ItemRow): MemoryItemView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as MemoryStatus,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    content: row.content ?? '',
    confidence: Number(row.confidence),
    version: Number(row.version),
    observedCount: Number(row.observed_count),
    verifiedCount: Number(row.verified_count),
    appliedCount: Number(row.applied_count),
    correctedCount: Number(row.corrected_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    conflicts: Number(row.conflicts),
    source: row.authority
      ? { authority: row.authority, verified: Number(row.verified) === 1, sourceType: row.source_type ?? '', sourceUri: row.source_uri ?? '' }
      : undefined,
  }
}

export function listMemoryItems(options: { status?: string; search?: string; limit?: number } = {}): MemoryItemView[] {
  const db = openReadOnly()
  if (!db) return []
  try {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
    const status = options.status && (STATUSES as readonly string[]).includes(options.status) ? options.status : undefined
    const search = options.search?.trim()
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (status) {
      clauses.push('i.status = ?')
      params.push(status)
    }
    if (search) {
      clauses.push('v.content LIKE ?')
      params.push(`%${search}%`)
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = db.prepare(`${ITEM_SELECT}${where} ORDER BY i.updated_at DESC LIMIT ?`).all(...params, limit) as unknown as ItemRow[]
    return rows.map(toItem)
  } catch {
    return []
  } finally {
    db.close()
  }
}

export function getReviewQueue(limit = 30): MemoryItemView[] {
  const items = listMemoryItems({ status: 'candidate', limit: Math.min(Math.max(limit, 1), 200) })
  const rank = (item: MemoryItemView): number => {
    if (item.conflicts > 0) return 0
    if (!item.source?.verified) return 1
    if (item.scopeType === 'global') return 2
    return 3
  }
  return items.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
}

interface EventRow {
  id: string
  memory_id: string
  event_type: string
  from_status: string | null
  to_status: string | null
  actor: string
  reason_code: string
  created_at: number
  content: string | null
}

export function listMemoryChanges(limit = 40): MemoryChangeView[] {
  const db = openReadOnly()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT e.id, e.memory_id, e.event_type, e.from_status, e.to_status, e.actor, e.reason_code, e.created_at,
                v.content
           FROM memory_events e
           LEFT JOIN memory_items i ON i.id = e.memory_id
           LEFT JOIN memory_revisions v ON v.id = i.current_revision_id
          ORDER BY e.created_at DESC LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 200)) as unknown as EventRow[]
    return rows.map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      eventType: row.event_type,
      fromStatus: row.from_status ?? undefined,
      toStatus: row.to_status ?? undefined,
      actor: row.actor,
      reasonCode: row.reason_code,
      createdAt: Number(row.created_at),
      contentPreview: (row.content ?? '').slice(0, 200),
    }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

export interface MemoryUsageView {
  windowDays: number
  recallRuns: number
  recallCandidates: number
  contextInjected: number
  verified: number
  averageLatencyMs: number
  lastContextInjectionAt?: number
  topUsed: Array<{ id: string; content: string; injected: number; verified: number }>
}

export function getMemoryUsage(days = 7): MemoryUsageView {
  const db = openReadOnly()
  if (!db) return { windowDays: days, recallRuns: 0, recallCandidates: 0, contextInjected: 0, verified: 0, averageLatencyMs: 0, topUsed: [] }
  const since = Date.now() - Math.max(days, 1) * 86_400_000
  try {
    const runs = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(injected_count),0) AS candidates, COALESCE(AVG(latency_ms),0) AS latency FROM recall_runs WHERE created_at >= ?').all(since) as Array<{ n: number; candidates: number; latency: number }>
    const outcomes = db.prepare('SELECT outcome, COUNT(*) AS n FROM application_events WHERE created_at >= ? GROUP BY outcome').all(since) as Array<{ outcome: string; n: number }>
    const top = db
      .prepare(
        `SELECT a.memory_id AS id, COALESCE(v.content, '') AS content,
                SUM(CASE WHEN a.outcome = 'injected' THEN 1 ELSE 0 END) AS injected,
                SUM(CASE WHEN a.outcome = 'verified' THEN 1 ELSE 0 END) AS verified
           FROM application_events a
           LEFT JOIN memory_items i ON i.id = a.memory_id
           LEFT JOIN memory_revisions v ON v.id = i.current_revision_id
          WHERE a.created_at >= ?
          GROUP BY a.memory_id
          ORDER BY injected DESC, verified DESC LIMIT 10`,
      )
      .all(since) as Array<{ id: string; content: string; injected: number; verified: number }>
    const outcomeOf = (name: string) => Number(outcomes.find((row) => row.outcome === name)?.n ?? 0)
    return {
      windowDays: days,
      recallRuns: Number(runs[0]?.n ?? 0),
      recallCandidates: Number(runs[0]?.candidates ?? 0),
      contextInjected: outcomeOf('injected'),
      verified: outcomeOf('verified'),
      averageLatencyMs: Math.round(Number(runs[0]?.latency ?? 0)),
      lastContextInjectionAt: optionalScalar(db, `SELECT MAX(created_at) AS n FROM application_events WHERE outcome = 'injected'`),
      topUsed: top.map((row) => ({ id: row.id, content: (row.content ?? '').slice(0, 200), injected: Number(row.injected), verified: Number(row.verified) })),
    }
  } catch {
    return { windowDays: days, recallRuns: 0, recallCandidates: 0, contextInjected: 0, verified: 0, averageLatencyMs: 0, topUsed: [] }
  } finally {
    db.close()
  }
}

/** Timestamp the database file last changed; lets the UI tell fresh from stale without polling the DB twice. */
export function memoryDatabaseUpdatedAt(): number | undefined {
  try {
    const info = statSync(memoryDatabasePath())
    return info.mtimeMs
  } catch {
    return undefined
  }
}

export interface PromotionProposalView {
  id: string
  memoryId: string
  suggestedType: string
  status: string
  strength?: string
  content: string
  createdAt: number
}

export function listPromotionProposals(limit = 50): PromotionProposalView[] {
  const db = openReadOnly()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT p.id, p.memory_id, p.suggested_type, p.status, p.bundle_json, p.created_at,
                v.content
           FROM promotion_proposals p
           LEFT JOIN memory_items i ON i.id = p.memory_id
           LEFT JOIN memory_revisions v ON v.id = i.current_revision_id
          WHERE p.status = 'proposed'
          ORDER BY p.created_at DESC LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 200)) as unknown as Array<{
      id: string
      memory_id: string
      suggested_type: string
      status: string
      bundle_json: string
      created_at: number
      content: string | null
    }>
    return rows.map((row) => {
      let strength: string | undefined
      try {
        const bundle = JSON.parse(row.bundle_json) as { strength?: string }
        strength = bundle.strength
      } catch {
        strength = undefined
      }
      return {
        id: row.id,
        memoryId: row.memory_id,
        suggestedType: row.suggested_type,
        status: row.status,
        strength,
        content: (row.content ?? '').slice(0, 400),
        createdAt: Number(row.created_at),
      }
    })
  } catch {
    return []
  } finally {
    db.close()
  }
}

export interface NightlyReviewView {
  generatedAt?: string
  markdown?: string
  windowDays?: number
  available: boolean
}

/** The nightly job writes a digest; the page shows it verbatim so nothing is re-interpreted. */
export function getNightlyReview(): NightlyReviewView {
  const dir = join(memoryDataDir(), 'nightly')
  try {
    const markdown = readFileSync(join(dir, 'latest.md'), 'utf8')
    let generatedAt: string | undefined
    let windowDays: number | undefined
    try {
      const digest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')) as { generatedAt?: string; windowDays?: number }
      generatedAt = digest.generatedAt
      windowDays = digest.windowDays
    } catch {
      generatedAt = undefined
    }
    return { available: true, markdown, generatedAt, windowDays }
  } catch {
    return { available: false }
  }
}
