import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { TaskCounts, HistoryPoint } from '@shared/tasks.js'

/**
 * Daily snapshot of task counts — the trend layer.
 *
 * One point per local day, written idempotently: repeated snapshots within a day
 * only rewrite when the counts actually change. Recording is best-effort
 * observability and must never break the read path.
 *
 * Single JSON file, 0600, temp-file + rename, serialized write queue
 * (same guarantees as PlanningStore).
 */
export const DEFAULT_HISTORY_PATH = join(homedir(), '.pi', 'tasks', 'history.json')
const RETENTION_DAYS = 120

interface StoredHistory {
  days: Record<string, TaskCounts>
}

function localDate(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function sameCounts(a: TaskCounts, b: TaskCounts): boolean {
  return a.total === b.total && a.todo === b.todo && a.doing === b.doing &&
    a.done === b.done && a.paused === b.paused && a.archived === b.archived
}

export class HistoryStore {
  private cache: StoredHistory | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string = DEFAULT_HISTORY_PATH) {}

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run as Promise<T>
  }

  private async load(): Promise<StoredHistory> {
    if (this.cache) return this.cache
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoredHistory>
      this.cache = { days: raw.days && typeof raw.days === 'object' ? raw.days : {} }
    } catch {
      this.cache = { days: {} }
    }
    return this.cache
  }

  private async write(days: Record<string, TaskCounts>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ days }, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, this.path)
  }

  /** Record `counts` for `date` (default today). No write when unchanged. */
  async record(counts: TaskCounts, date: string = localDate()): Promise<void> {
    return this.serialize(async () => {
      const stored = await this.load()
      const existing = stored.days[date]
      if (existing && sameCounts(existing, counts)) return
      const days: Record<string, TaskCounts> = { ...stored.days, [date]: counts }
      const cutoff = localDate(new Date(Date.now() - RETENTION_DAYS * 86_400_000))
      for (const key of Object.keys(days)) if (key < cutoff) delete days[key]
      await this.write(days)
      this.cache = { days }
    })
  }

  /** Chronological points, most recent `days` entries. */
  async series(days = 30): Promise<HistoryPoint[]> {
    const stored = await this.load()
    return Object.entries(stored.days)
      .map(([date, counts]) => ({ date, ...counts }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-Math.max(1, days))
  }
}
