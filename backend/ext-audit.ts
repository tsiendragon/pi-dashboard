/**
 * Audit trail for extension operations.
 *
 * JSONL at `<agent dir>/extension-audit.jsonl`, one record per operation, append-only. Records keep
 * the backup path that `SettingsStore` created, so any change can be rolled back from the UI.
 * Parsing is lenient: a malformed line is skipped instead of failing the page.
 */
import { appendFileSync, readFileSync } from 'fs'
import { join } from 'path'

export type ExtAuditAction = 'install' | 'remove' | 'update' | 'toggle' | 'order' | 'rollback' | 'config'

export interface ExtAuditRecord {
  id: string
  ts: string
  action: ExtAuditAction
  /** Package source, extension path or config name the action targeted. */
  target: string
  /** Browser client id of the actor, when the request was authenticated. */
  actor: string | null
  ok: boolean
  backupPath: string | null
  before: string[] | null
  after: string[] | null
  output?: string
  error?: string
}

export function auditLogPath(agentDir: string): string {
  return join(agentDir, 'extension-audit.jsonl')
}

export function appendAuditRecord(
  agentDir: string,
  record: Omit<ExtAuditRecord, 'id' | 'ts' | 'before' | 'after'> & {
    before?: string[] | null
    after?: string[] | null
    id?: string
    ts?: string
  },
): ExtAuditRecord {
  const full: ExtAuditRecord = {
    id: record.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ts: record.ts ?? new Date().toISOString(),
    action: record.action,
    target: record.target,
    actor: record.actor ?? null,
    ok: record.ok,
    backupPath: record.backupPath ?? null,
    before: record.before ?? null,
    after: record.after ?? null,
    ...(record.output === undefined ? {} : { output: record.output.slice(0, 4000) }),
    ...(record.error === undefined ? {} : { error: record.error.slice(0, 2000) }),
  }
  try {
    appendFileSync(auditLogPath(agentDir), `${JSON.stringify(full)}\n`, { encoding: 'utf-8', mode: 0o600 })
  } catch {
    // The audit file is best-effort: never fail an operation because logging failed.
  }
  return full
}

/** Newest first. */
export function readAuditRecords(agentDir: string, limit = 50): ExtAuditRecord[] {
  let raw: string
  try {
    raw = readFileSync(auditLogPath(agentDir), 'utf-8')
  } catch {
    return []
  }
  const records: ExtAuditRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as ExtAuditRecord
      if (parsed && typeof parsed === 'object' && typeof parsed.ts === 'string') records.push(parsed)
    } catch {
      // skip malformed line
    }
  }
  return records.reverse().slice(0, Math.max(1, Math.min(limit, 500)))
}