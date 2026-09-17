import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { PlanningOverlay } from '@shared/tasks.js'

/**
 * Planning overlay store (user × task) — the writable layer.
 *
 * Deliberately independent of any provider: keyed by `uid`, so it works the same
 * for local tasks and journal tasks. Single JSON file, 0600, temp-file + rename,
 * serialized write queue (same guarantees as LiveSessionMetaStore).
 *
 * Kept out of the journal repo on purpose (facts are read-only there).
 */
export const DEFAULT_PLANNING_PATH = join(homedir(), '.pi', 'tasks', 'planning.json')

interface StoredPlanning {
  version: number
  overlay: PlanningOverlay
}

function isEntry(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeOverlay(value: unknown): PlanningOverlay {
  if (!isEntry(value)) return {}
  const out: PlanningOverlay = {}
  for (const [uid, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!uid || !isEntry(entry)) continue
    out[uid] = entry as PlanningOverlay[string]
  }
  return out
}

export class PlanningStore {
  private cache: StoredPlanning | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string = DEFAULT_PLANNING_PATH) {}

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run as Promise<T>
  }

  private async load(): Promise<StoredPlanning> {
    if (this.cache) return this.cache
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoredPlanning>
      this.cache = { version: typeof raw.version === 'number' ? raw.version : 0, overlay: sanitizeOverlay(raw.overlay) }
    } catch {
      this.cache = { version: 0, overlay: {} }
    }
    return this.cache
  }

  async snapshot(): Promise<{ version: number; overlay: PlanningOverlay }> {
    const stored = await this.load()
    return { version: stored.version, overlay: { ...stored.overlay } }
  }

  /**
   * Merge `patch` into the overlay. When `expectedVersion` is provided and does
   * not match the stored version, returns null (caller maps to 409 conflict).
   */
  async merge(patch: PlanningOverlay, expectedVersion?: number): Promise<{ version: number; overlay: PlanningOverlay } | null> {
    return this.serialize(async () => {
      const stored = await this.load()
      if (expectedVersion !== undefined && expectedVersion !== stored.version) return null
      const overlay: PlanningOverlay = { ...stored.overlay }
      for (const [uid, entry] of Object.entries(patch)) {
        if (entry === null || entry === undefined) { delete overlay[uid]; continue }
        const merged = { ...(overlay[uid] || {}), ...entry }
        // Drop keys explicitly set to null/undefined (lets callers clear one field).
        for (const key of Object.keys(merged) as (keyof typeof merged)[]) {
          if (merged[key] === null || merged[key] === undefined) delete merged[key]
        }
        if (Object.keys(merged).length === 0) delete overlay[uid]
        else overlay[uid] = merged
      }
      const next: StoredPlanning = { version: stored.version + 1, overlay }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ version: next.version, overlay: next.overlay }, null, 2) + '\n', { mode: 0o600 })
      await rename(tmp, this.path)
      this.cache = next
      return { version: next.version, overlay: { ...next.overlay } }
    })
  }

  /** Remove overlay entries whose uid is no longer present in the fact set. */
  async prune(validUids: Set<string>): Promise<number> {
    return this.serialize(async () => {
      const stored = await this.load()
      const overlay: PlanningOverlay = {}
      let removed = 0
      for (const [uid, entry] of Object.entries(stored.overlay)) {
        if (validUids.has(uid)) overlay[uid] = entry
        else removed += 1
      }
      if (removed === 0) return 0
      const next: StoredPlanning = { version: stored.version + 1, overlay }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ version: next.version, overlay: next.overlay }, null, 2) + '\n', { mode: 0o600 })
      await rename(tmp, this.path)
      this.cache = next
      return removed
    })
  }
}
