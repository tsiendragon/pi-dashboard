import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { TaskFact } from '@shared/tasks.js'
import type { TaskProvider, TaskCreateInput, TaskUpdateInput } from '../types.js'
import { mapCompletion } from '../mapping.js'

export const DEFAULT_LOCAL_TASKS_PATH = join(homedir(), '.pi', 'tasks', 'tasks.json')

interface LocalTaskRecord {
  id: string
  title: string
  description?: string
  status?: string
  parentId?: string | null
  path?: string
  tags?: string[]
  createdAt?: string
  updatedAt?: string
}

interface StoredLocal {
  version: number
  tasks: LocalTaskRecord[]
}

/**
 * Built-in fallback / personal inbox source. Always available, never touches any
 * external system — this is where ad-hoc items live (waiting on someone, follow-ups).
 *
 * Identity is a stable uuid ⇒ plannable. Stored at `~/.pi/tasks/tasks.json`
 * (0600, temp-file + rename, serialized writes).
 */
export class LocalTaskProvider implements TaskProvider {
  readonly type = 'local'
  readonly capabilities = { writable: true, providesTodos: true, providesProgress: false }
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly path: string = DEFAULT_LOCAL_TASKS_PATH,
    readonly id: string = 'local',
    readonly label: string = 'Local',
  ) {}

  async available(): Promise<boolean> {
    return true
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run as Promise<T>
  }

  private async read(): Promise<StoredLocal> {
    if (!existsSync(this.path)) return { version: 1, tasks: [] }
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoredLocal>
      return { version: typeof raw.version === 'number' ? raw.version : 1, tasks: Array.isArray(raw.tasks) ? raw.tasks : [] }
    } catch {
      return { version: 1, tasks: [] }
    }
  }

  private async write(store: StoredLocal): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, this.path)
  }

  private toFact(record: LocalTaskRecord): TaskFact {
    const { completion, completionRaw } = mapCompletion(record.status)
    return {
      uid: `${this.id}:${record.id}`,
      providerId: this.id,
      id: record.id,
      kind: 'item',
      parentUid: record.parentId ? `${this.id}:${record.parentId}` : undefined,
      title: record.title,
      description: record.description,
      completion,
      ...(completionRaw ? { completionRaw } : {}),
      archived: record.status === 'archived',
      plannable: true,
      path: record.path,
      tags: Array.isArray(record.tags) ? record.tags : [],
      updatedAt: record.updatedAt,
      writable: true,
      sourceLabel: this.label,
      raw: record,
    }
  }

  async list(): Promise<TaskFact[]> {
    const store = await this.read()
    return store.tasks
      .filter(r => r && typeof r.id === 'string' && typeof r.title === 'string')
      .map(r => this.toFact(r))
  }

  async get(id: string): Promise<TaskFact | null> {
    return (await this.list()).find(t => t.id === id) ?? null
  }

  async createTask(input: TaskCreateInput): Promise<TaskFact> {
    return this.serialize(async () => {
      const store = await this.read()
      const now = new Date().toISOString()
      const record: LocalTaskRecord = {
        id: `t-${randomUUID().slice(0, 8)}`,
        title: input.title.trim(),
        description: input.description,
        status: input.status ?? 'todo',
        path: input.path,
        tags: input.tags ?? [],
        createdAt: now,
        updatedAt: now,
      }
      store.tasks.push(record)
      await this.write(store)
      return this.toFact(record)
    })
  }

  async updateTask(id: string, patch: TaskUpdateInput): Promise<TaskFact | null> {
    return this.serialize(async () => {
      const store = await this.read()
      const record = store.tasks.find(r => r.id === id)
      if (!record) return null
      if (patch.title !== undefined) record.title = patch.title
      if (patch.description !== undefined) record.description = patch.description
      if (patch.status !== undefined) record.status = patch.status
      if (patch.path !== undefined) record.path = patch.path
      if (patch.tags !== undefined) record.tags = patch.tags
      record.updatedAt = new Date().toISOString()
      await this.write(store)
      return this.toFact(record)
    })
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.serialize(async () => {
      const store = await this.read()
      const before = store.tasks.length
      store.tasks = store.tasks.filter(r => r.id !== id)
      if (store.tasks.length === before) return false
      await this.write(store)
      return true
    })
  }
}
