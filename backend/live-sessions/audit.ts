import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { agentDir } from '../env-file.js'

/**
 * Append-only record of the decisions that are easy to lose afterwards: which
 * extension request was allowed or denied, which sudo run was authorized, and which
 * queued prompt was withdrawn.
 *
 * Deliberately narrow. Passwords and sudo argv are never written; the request title is
 * truncated; the client is a shortened browser id, because the dashboard has no stronger
 * identity to name. Entries live in memory (newest first) and are mirrored to a JSONL file
 * so a restart does not erase who approved what.
 */
export type LiveSessionAuditAction = 'allowed' | 'denied' | 'answered' | 'cancelled' | 'authorized' | 'withdrawn'

export interface LiveSessionAuditEntry {
  /** Epoch milliseconds. */
  at: number
  processInstanceId: string
  sessionId?: string
  action: LiveSessionAuditAction
  /** `queue` marks a queued-prompt withdrawal rather than an extension request. */
  method?: 'confirm' | 'select' | 'input' | 'editor' | 'sudo' | 'queue'
  title?: string
  /** Short browser id; never a cookie or a token. */
  client?: string
  detail?: string
}

export const DEFAULT_LIVE_SESSION_AUDIT_PATH = join(agentDir(), 'pi', 'live-session-audit.jsonl')

const MAX_MEMORY_ENTRIES = 2_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const TITLE_LIMIT = 120

const ACTIONS = new Set<LiveSessionAuditAction>(['allowed', 'denied', 'answered', 'cancelled', 'authorized', 'withdrawn'])
const METHODS = new Set(['confirm', 'select', 'input', 'editor', 'sudo', 'queue'])

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, limit) : undefined
}

/** One line of the audit file, or undefined when the line is not a valid entry. */
export function parseAuditLine(line: string): LiveSessionAuditEntry | undefined {
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return undefined }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return undefined
  if (typeof value.processInstanceId !== 'string' || !value.processInstanceId) return undefined
  if (typeof value.action !== 'string' || !ACTIONS.has(value.action as LiveSessionAuditAction)) return undefined
  const method = typeof value.method === 'string' && METHODS.has(value.method) ? value.method as LiveSessionAuditEntry['method'] : undefined
  return {
    at: value.at,
    processInstanceId: value.processInstanceId.slice(0, 256),
    ...(text(value.sessionId, 256) ? { sessionId: text(value.sessionId, 256) } : {}),
    action: value.action as LiveSessionAuditAction,
    ...(method ? { method } : {}),
    ...(text(value.title, TITLE_LIMIT) ? { title: text(value.title, TITLE_LIMIT) } : {}),
    ...(text(value.client, 64) ? { client: text(value.client, 64) } : {}),
    ...(text(value.detail, 200) ? { detail: text(value.detail, 200) } : {}),
  }
}

export class LiveSessionAuditStore {
  readonly filePath: string
  private readonly now: () => number
  private readonly maxEntries: number
  private entries: LiveSessionAuditEntry[] = []
  private writeQueue: Promise<void> = Promise.resolve()
  private started = false

  constructor(options: { filePath?: string; now?: () => number; maxEntries?: number } = {}) {
    this.filePath = options.filePath ?? DEFAULT_LIVE_SESSION_AUDIT_PATH
    this.now = options.now ?? Date.now
    this.maxEntries = options.maxEntries ?? MAX_MEMORY_ENTRIES
  }

  /** Loads the tail of the file once; a file over the cap is rotated instead of read. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      const info = await stat(this.filePath)
      if (info.size > MAX_FILE_BYTES) {
        await rename(this.filePath, `${this.filePath}.1`).catch(() => {})
        return
      }
      const content = await readFile(this.filePath, 'utf8')
      const parsed = content.split('\n').flatMap(line => {
        const entry = line.trim() ? parseAuditLine(line) : undefined
        return entry ? [entry] : []
      })
      this.entries = parsed.slice(-this.maxEntries)
    } catch (error) {
      // A missing file is the normal first run; anything else is reported once and ignored.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[live-session-audit] Failed to load ${this.filePath}:`, error)
    }
  }

  record(input: Omit<LiveSessionAuditEntry, 'at'> & { at?: number }): LiveSessionAuditEntry {
    const entry: LiveSessionAuditEntry = {
      ...input,
      at: input.at ?? this.now(),
      ...(text(input.title, TITLE_LIMIT) ? { title: text(input.title, TITLE_LIMIT) } : {}),
      ...(text(input.detail, 200) ? { detail: text(input.detail, 200) } : {}),
    }
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) this.entries = this.entries.slice(-this.maxEntries)
    const line = `${JSON.stringify(entry)}\n`
    // Serialized appends: two answers at once must not interleave half lines.
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
        await appendFile(this.filePath, line, { mode: 0o600 })
      })
      .catch(error => console.error(`[live-session-audit] Failed to append ${this.filePath}:`, error))
    return entry
  }

  /** Newest first, so the UI can show the latest decision without reversing anything. */
  recent(processInstanceId: string, limit = 50): LiveSessionAuditEntry[] {
    const bounded = Math.max(1, Math.min(limit, 200))
    return this.entries
      .filter(entry => entry.processInstanceId === processInstanceId)
      .slice(-bounded)
      .reverse()
  }

  /** Test/shutdown hook: wait for the pending append. */
  async flush(): Promise<void> {
    await this.writeQueue
  }
}