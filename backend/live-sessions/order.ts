import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Manual row order for the Live Pi Sessions sidebar.
 *
 * The sidebar used to be ordered by `startedAt`, which meant a row's position
 * moved whenever an older session exited or a Pi restarted. Users could not
 * learn "where" a session lives. This store freezes the order to whatever the
 * user dragged it to; sessions that were never dragged are appended at the end
 * of their block (see `sessionOrder.ts` on the frontend).
 *
 * Keyed by pi `sessionId` (not the short-lived `processInstanceId`) so the
 * position survives a Pi restart and reattaches with the same session — same
 * contract as `LiveSessionMetaStore` / `LiveSessionGroupStore`.
 *
 * Same shape/guarantees as the other two stores: single JSON file, 0700 dir,
 * 0600 file, temp-file + rename, serialized write queue.
 */
export const DEFAULT_LIVE_SESSION_ORDER_PATH = '/mnt/workspace/lilong/agent/pi/live-session-order.json'

/**
 * Hard cap. Subagent sessions never reach this list (the sidebar hides them),
 * so growth is one entry per interactive session; the cap only exists so a
 * long-lived file cannot grow without bound. Trimming drops the trailing
 * entries, which merely fall back to automatic ordering at the block tail.
 */
const MAX_ORDER_ENTRIES = 1000

type StoredOrder = { version: 1; order: string[] }

/** Trim, drop empties/non-strings, de-duplicate (first wins), cap the length. */
export function normalizeOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_ORDER_ENTRIES) break
  }
  return out
}

export class LiveSessionOrderStore {
  private readonly filePath: string
  private order: string[] = []
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(filePath = process.env.PI_DASH_LIVE_SESSION_ORDER || DEFAULT_LIVE_SESSION_ORDER_PATH) {
    this.filePath = filePath
  }

  async start(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as StoredOrder | unknown
      this.order = normalizeOrder((parsed as StoredOrder)?.order)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[live-session-order] Failed to load ${this.filePath}:`, error)
      }
      this.order = []
    }
  }

  async list(): Promise<string[]> {
    await this.start()
    return [...this.order]
  }

  /** Whole-list replacement: a drag sends one array, not N index patches. */
  async replace(value: unknown): Promise<string[]> {
    await this.start()
    this.order = normalizeOrder(value)
    await this.persist()
    return this.list()
  }

  private async persist(): Promise<void> {
    const payload: StoredOrder = { version: 1, order: this.order }
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