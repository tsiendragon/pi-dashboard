/**
 * The memory page reads the pi-tsien-memory database directly, so its SQL has to keep matching that
 * schema. These tests build a throwaway database with the same tables and assert the read model.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalDir = process.env.PI_TSIEN_MEMORY_DIR
let workspace = ''

async function loadStore() {
  return import('../memory-store.js')
}

function seed(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE memory_items (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      scope_type TEXT NOT NULL, scope_key TEXT NOT NULL, claim_key TEXT, current_revision_id TEXT, confidence REAL NOT NULL,
      observed_count INTEGER NOT NULL DEFAULT 1, verified_count INTEGER NOT NULL DEFAULT 0, applied_count INTEGER NOT NULL DEFAULT 0,
      corrected_count INTEGER NOT NULL DEFAULT 0, valid_from INTEGER NOT NULL, valid_until INTEGER, superseded_by_id TEXT,
      version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE memory_revisions (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, revision_no INTEGER NOT NULL, content TEXT NOT NULL,
      content_hash TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE memory_sources (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, source_type TEXT NOT NULL, source_uri TEXT NOT NULL,
      source_entry_id TEXT, source_hash TEXT NOT NULL, evidence_summary TEXT, authority TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE memory_relations (from_memory_id TEXT NOT NULL, to_memory_id TEXT NOT NULL, relation TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE memory_events (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, event_type TEXT NOT NULL, from_status TEXT, to_status TEXT,
      revision_id TEXT, actor TEXT NOT NULL, reason_code TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
    CREATE TABLE recall_runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, query_hash TEXT NOT NULL, route TEXT NOT NULL, status TEXT NOT NULL,
      latency_ms INTEGER NOT NULL, injected_count INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE application_events (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, session_id TEXT, task_key_hash TEXT, outcome TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE index_outbox (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, operation TEXT NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `)
  const now = Date.now()
  const insert = (sql: string, ...params: Array<string | number | null>) => db.prepare(sql).run(...params)
  // One verified active memory, one conflicting candidate, one candidate with no verified source.
  insert(`INSERT INTO memory_items VALUES ('m1','default','preference','active','repository','repository:r',NULL,'r1',0.98,1,0,0,0,?,NULL,NULL,1,?,?)`, now, now, now)
  insert(`INSERT INTO memory_revisions VALUES ('r1','m1',1,'use pnpm for installs','h1','user',?)`, now)
  insert(`INSERT INTO memory_sources VALUES ('s1','r1','user_message','session:s',NULL,'h1',NULL,'user_explicit',1,?)`, now)
  insert(`INSERT INTO memory_items VALUES ('m2','default','decision','candidate','repository','repository:r','ck',  'r2',0.68,1,0,0,0,?,NULL,NULL,1,?,?)`, now, now, now)
  insert(`INSERT INTO memory_revisions VALUES ('r2','m2',1,'deploy from the release branch','h2','review',?)`, now)
  insert(`INSERT INTO memory_sources VALUES ('s2','r2','tool_result','tool:shell',NULL,'h2',NULL,'verified_tool',1,?)`, now)
  insert(`INSERT INTO memory_items VALUES ('m3','default','experience','candidate','global','global:default',NULL,'r3',0.68,1,0,0,0,?,NULL,NULL,1,?,?)`, now, now, now)
  insert(`INSERT INTO memory_revisions VALUES ('r3','m3',1,'unverified guess','h3','review',?)`, now)
  insert(`INSERT INTO memory_sources VALUES ('s3','r3','assistant_summary','session:s',NULL,'h3',NULL,'agent_inference',0,?)`, now)
  insert(`INSERT INTO memory_relations VALUES ('m2','m1','conflicts_with',?)`, now)
  insert(`INSERT INTO memory_events VALUES ('e1','m1','status_changed','candidate','active','r1','system','evidence_backed','{}',?)`, now - 1000)
  insert(`INSERT INTO memory_events VALUES ('e2','m2','created',NULL,'candidate','r2','agent','capture_candidate','{}',?)`, now)
  insert(`INSERT INTO recall_runs VALUES ('run1','s','qh','memory','completed',12,3,?)`, now)
  insert(`INSERT INTO application_events VALUES ('a1','m1','s',NULL,'injected',?)`, now)
  insert(`INSERT INTO index_outbox VALUES ('i1','m1','upsert','failed',1,'emb',?,?)`, now, now)
  db.close()
}

describe('memory store', () => {
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pi-memory-store-'))
    process.env.PI_TSIEN_MEMORY_DIR = workspace
  })

  afterEach(() => {
    if (originalDir === undefined) delete process.env.PI_TSIEN_MEMORY_DIR
    else process.env.PI_TSIEN_MEMORY_DIR = originalDir
    rmSync(workspace, { recursive: true, force: true })
  })

  it('reports a missing database instead of pretending it is empty', async () => {
    const store = await loadStore()
    const overview = store.getMemoryOverview()
    expect(overview.available).toBe(false)
    expect(overview.hint).toContain('没有找到记忆数据库')
    expect(store.listMemoryItems({ limit: 5 })).toEqual([])
  })

  it('summarises counts, review reasons, usage and health from the real schema', async () => {
    seed(join(workspace, 'memory.db'))
    const store = await loadStore()
    const overview = store.getMemoryOverview()
    expect(overview.available).toBe(true)
    expect(overview.counts).toMatchObject({ active: 1, candidate: 2, total: 3 })
    expect(overview.review).toMatchObject({ total: 2, conflicts: 1, scopeEscalation: 1 })
    expect(overview.usage.contextInjected).toBe(1)
    expect(overview.usage.verified).toBe(0)
    expect(overview.health.failedIndexJobs).toBe(1)
    expect(overview.health.pendingIndexJobs).toBe(1)
    expect(overview.selfManagement.autoAccepted).toBe(1)
  })

  it('exposes source provenance so the UI can tell verified memory from inference', async () => {
    seed(join(workspace, 'memory.db'))
    const store = await loadStore()
    const active = store.listMemoryItems({ status: 'active' })
    expect(active).toHaveLength(1)
    expect(active[0].content).toBe('use pnpm for installs')
    expect(active[0].source).toMatchObject({ authority: 'user_explicit', verified: true })

    const inferred = store.listMemoryItems({ status: 'candidate', search: 'unverified' })
    expect(inferred).toHaveLength(1)
    expect(inferred[0].source?.verified).toBe(false)
  })

  it('orders the review queue by what actually needs a human', async () => {
    seed(join(workspace, 'memory.db'))
    const store = await loadStore()
    const queue = store.getReviewQueue()
    expect(queue.map((item) => item.id)).toEqual(['m2', 'm3'])
    expect(queue[0].conflicts).toBe(1)
  })

  it('separates recall candidates from context injection in usage', async () => {
    seed(join(workspace, 'memory.db'))
    const store = await loadStore()
    const usage = store.getMemoryUsage(7)
    expect(usage.recallRuns).toBe(1)
    expect(usage.recallCandidates).toBe(3)
    expect(usage.contextInjected).toBe(1)
    expect(usage.verified).toBe(0)
    expect(usage.topUsed[0]).toMatchObject({ id: 'm1', injected: 1, verified: 0 })
  })

  it('lists recent changes with actor and reason', async () => {
    seed(join(workspace, 'memory.db'))
    const store = await loadStore()
    const changes = store.listMemoryChanges(10)
    expect(changes).toHaveLength(2)
    expect(changes[0]).toMatchObject({ actor: 'agent', eventType: 'created' })
    expect(changes[1]).toMatchObject({ actor: 'system', reasonCode: 'evidence_backed', toStatus: 'active' })
  })
})