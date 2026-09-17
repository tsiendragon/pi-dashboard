import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExternalProviderConfig, ProviderCapabilities, TaskFact, TaskKind, TaskProgress } from '@shared/tasks.js'
import type { TaskProvider } from '../types.js'
import { mapCompletion } from '../mapping.js'

const KINDS = new Set<TaskKind>(['epic', 'task', 'todo', 'item'])

function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

function asProgress(value: unknown): TaskProgress | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as { done?: unknown; total?: unknown }
  if (typeof v.done !== 'number' || typeof v.total !== 'number') return undefined
  return { done: v.done, total: v.total }
}

function toFact(providerId: string, label: string, raw: Record<string, unknown>): TaskFact | null {
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null
  if (!id) return null
  const { completion, completionRaw } = mapCompletion(raw.status ?? raw.completion)
  return {
    uid: `${providerId}:${id}`,
    providerId,
    id,
    kind: typeof raw.kind === 'string' && KINDS.has(raw.kind as TaskKind) ? (raw.kind as TaskKind) : 'task',
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : id,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    completion,
    completionRaw,
    archived: raw.archived === true,
    plannable: raw.plannable !== false,
    path: typeof raw.path === 'string' ? expandHome(raw.path) : undefined,
    progress: asProgress(raw.progress),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    writable: false,
    sourceLabel: label,
    raw,
  }
}

function parseItems(text: string): Record<string, unknown>[] {
  const data = JSON.parse(text) as unknown
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { tasks?: unknown }).tasks)
      ? (data as { tasks: unknown[] }).tasks
      : null
  if (!arr) throw new Error('expected a JSON array or { tasks: [...] }')
  return arr.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
}

/**
 * Read-only provider whose source is declared in config. Adding a source such as
 * Jira/Lark needs no code change: point it at a command (stdout JSON) or a file.
 */
export class ExternalTaskProvider implements TaskProvider {
  readonly type = 'external'
  readonly capabilities: ProviderCapabilities = { writable: false, providesTodos: true, providesProgress: true }

  constructor(private readonly cfg: ExternalProviderConfig) {}

  get id(): string { return this.cfg.id }
  get label(): string { return this.cfg.label || this.cfg.id }

  private async loadRaw(): Promise<TaskFact[]> {
    const text = this.cfg.kind === 'file'
      ? await readFile(expandHome(this.cfg.file), 'utf8')
      : await this.runCommand()
    return parseItems(text).map(r => toFact(this.id, this.label, r)).filter((t): t is TaskFact => !!t)
  }

  private async runCommand(): Promise<string> {
    if (this.cfg.kind !== 'command') throw new Error('not a command provider')
    const [bin, ...args] = this.cfg.command
    if (!bin) throw new Error('command is empty')
    // Loaded lazily so module import does not require child_process (keeps
    // partially-mocked test environments working).
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { stdout } = await promisify(execFile)(expandHome(bin), args.map(expandHome), {
      cwd: this.cfg.cwd ? expandHome(this.cfg.cwd) : undefined,
      timeout: this.cfg.timeoutMs ?? 20_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout
  }

  async available(): Promise<boolean> {
    // Avoid running the command twice (available() then list()); report config
    // validity here and let list() surface real failures as a warning.
    if (this.cfg.kind === 'command') return Array.isArray(this.cfg.command) && this.cfg.command.length > 0
    try {
      await readFile(expandHome(this.cfg.file), 'utf8')
      return true
    } catch {
      return false
    }
  }

  async list(): Promise<TaskFact[]> {
    return this.loadRaw()
  }

  async get(id: string): Promise<TaskFact | null> {
    return (await this.loadRaw()).find(t => t.id === id) ?? null
  }
}
