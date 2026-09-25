import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Per-session UI metadata (tags + pin) for the Live Pi Sessions sidebar.
 *
 * Deliberately NOT part of `LiveSessionSummary`: the live-session wire protocol
 * is versioned and validated, and this is browser-side organization data. Keyed
 * by pi `sessionId` (not `processInstanceId`) so a tag survives a Pi restart and
 * reattaches when the same session comes back.
 *
 * Same shape/guarantees as `LiveSessionGroupStore`: single JSON file, 0700 dir,
 * 0600 file, temp-file + rename, serialized write queue.
 */
export interface LiveSessionMeta {
  tags: string[]
  pinned: boolean
  /**
   * Namespaced tmux session hosting this live Pi (`pi-dash-live-xxxxxxxx`),
   * written only by the launcher. Present ⇒ the session can be reached from a
   * terminal (`tmux attach -t …`) and can be closed by killing that session.
   */
  tmux?: string
  updatedAt: string
}

export type LiveSessionMetaMap = Record<string, LiveSessionMeta>

export const DEFAULT_LIVE_SESSION_META_PATH = '/mnt/workspace/lilong/agent/pi/live-session-meta.json'

const MAX_TAGS_PER_SESSION = 12
const MAX_TAG_LENGTH = 32

/** Lowercase, trimmed, de-duplicated, human-tag-only-safe list. */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH)
    if (!tag || tag.includes(':')) continue // reject namespaced/system-looking tags from user input
    if (!out.includes(tag)) out.push(tag)
    if (out.length >= MAX_TAGS_PER_SESSION) break
  }
  return out
}

type StoredMeta = { version: 1; meta: LiveSessionMetaMap }

function normalizeEntry(value: unknown): LiveSessionMeta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const tags = normalizeTags(record.tags)
  const pinned = record.pinned === true
  const tmux = typeof record.tmux === 'string' && record.tmux.trim() ? record.tmux.trim().slice(0, 128) : undefined
  if (!tags.length && !pinned && !tmux) return undefined
  return {
    tags,
    pinned,
    ...(tmux ? { tmux } : {}),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
  }
}

export class LiveSessionMetaStore {
  private readonly filePath: string
  private meta: LiveSessionMetaMap = {}
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(filePath = process.env.PI_DASH_LIVE_SESSION_META || DEFAULT_LIVE_SESSION_META_PATH) {
    this.filePath = filePath
  }

  async start(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as StoredMeta | unknown
      const values = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && (parsed as StoredMeta).meta && typeof (parsed as StoredMeta).meta === 'object'
        ? Object.entries((parsed as StoredMeta).meta)
        : []
      const out: LiveSessionMetaMap = {}
      for (const [sessionId, raw] of values) {
        if (typeof sessionId !== 'string' || !sessionId) continue
        const entry = normalizeEntry(raw)
        if (entry) out[sessionId] = entry
      }
      this.meta = out
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[live-session-meta] Failed to load ${this.filePath}:`, error)
      }
      this.meta = {}
    }
  }

  async list(): Promise<LiveSessionMetaMap> {
    await this.start()
    return { ...this.meta }
  }

  /**
   * Merge a partial update for one session. `null`/`[]` clears the field; an
   * entry that ends up empty is removed so the file does not accumulate ghosts.
   * `tmux` is machine-written (launcher only) and never comes from the browser.
   */
  async update(sessionId: string, patch: { tags?: unknown; pinned?: unknown; tmux?: unknown }): Promise<LiveSessionMeta> {
    await this.start()
    if (!sessionId) throw new Error('session_id_required')
    const current = this.meta[sessionId] || { tags: [], pinned: false, updatedAt: new Date().toISOString() }
    const tmux = Object.prototype.hasOwnProperty.call(patch, 'tmux')
      ? (typeof patch.tmux === 'string' && patch.tmux.trim() ? patch.tmux.trim().slice(0, 128) : undefined)
      : current.tmux
    const next: LiveSessionMeta = {
      tags: Object.prototype.hasOwnProperty.call(patch, 'tags') ? normalizeTags(patch.tags) : current.tags,
      pinned: Object.prototype.hasOwnProperty.call(patch, 'pinned') ? patch.pinned === true : current.pinned,
      ...(tmux ? { tmux } : {}),
      updatedAt: new Date().toISOString(),
    }
    if (next.tags.length || next.pinned || next.tmux) this.meta[sessionId] = next
    else delete this.meta[sessionId]
    await this.persist()
    return next
  }

  async remove(sessionId: string): Promise<LiveSessionMetaMap> {
    await this.start()
    delete this.meta[sessionId]
    await this.persist()
    return this.list()
  }

  /**
   * Move one session's tags/pin to a new `sessionId`.
   *
   * A live Pi can switch session in-process (`/clear`, `/ls-fork`) while keeping
   * its `processInstanceId`; the row is the same row to the user, so its labels
   * must follow the new id instead of disappearing.
   */
  async rekey(from: string, to: string): Promise<LiveSessionMetaMap> {
    await this.start()
    if (!from || !to || from === to) return this.list()
    const entry = this.meta[from]
    if (!entry) return this.list()
    delete this.meta[from]
    if (!this.meta[to]) this.meta[to] = entry
    await this.persist()
    return this.list()
  }

  private async persist(): Promise<void> {
    const payload: StoredMeta = { version: 1, meta: this.meta }
    const content = `${JSON.stringify(payload, null, 2)}\n`
    const tempPath = `${this.filePath}.${process.pid}.tmp`
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 })
      await rename(tempPath, this.filePath)
    })
    return this.writeQueue
  }
}
