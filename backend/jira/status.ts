import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { JiraCategory, JiraStatus } from '@shared/tasks.js'

/**
 * Jira status cache.
 *
 * Reading Jira means running `acli` (see the task-pilot rules: no direct REST, machine read-back only).
 * That is an external, authenticated, rate-limited call, so it never runs while rendering the task page:
 * the page shows whatever the cache says plus its age, and the user refreshes on demand. A failed read
 * degrades to "unknown" — it must never make the task list fail or hang.
 */

export const JIRA_CACHE_PATH = join(homedir(), '.pi', 'dashboard', 'jira-status.json')
/** After this the page still shows the value but marks it stale. */
export const JIRA_TTL_MS = 30 * 60 * 1000
/** `key in (...)` stays comfortably small; bigger groups risk a slow or rejected query. */
const CHUNK = 50
export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/

interface CachedStatus { name: string; category: JiraCategory; assignee?: string; priority?: string }
interface CacheFile { version: 1; readAt: string; statuses: Record<string, CachedStatus> }

export interface JiraMeta { available: boolean; readAt?: string; stale: boolean; error?: string }
export interface JiraReadResult { statuses: Record<string, JiraStatus>; meta: JiraMeta }

/** Jira's own status name → three buckets the UI can colour. */
export function jiraCategoryOf(categoryName: unknown): JiraCategory {
  const value = String(categoryName ?? '').toLowerCase()
  if (value.includes('done')) return 'done'
  if (value.includes('progress') || value.includes('review')) return 'inprogress'
  if (value.includes('to do') || value.includes('todo')) return 'todo'
  return 'unknown'
}

export type AcliRunner = (keys: string[]) => Promise<Array<{ key: string; status: string; category: string; assignee?: string; priority?: string }>>

/** Run the real `acli`; throws with a short reason so the caller can surface it without a stack. */
export const acliRunner: AcliRunner = async keys => {
  const out: Array<{ key: string; status: string; category: string; assignee?: string; priority?: string }> = []
  for (let index = 0; index < keys.length; index += CHUNK) {
    const group = keys.slice(index, index + CHUNK)
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'acli',
        ['jira', 'workitem', 'search', '-j', `key in (${group.join(', ')})`, '--fields', 'key,status,assignee,priority', '--json', '--limit', String(group.length)],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
        (error, output) => {
          if (error) return reject(new Error(String((error as NodeJS.ErrnoException).code || error.message).slice(0, 200)))
          resolve(String(output))
        },
      )
    })
    const parsed = JSON.parse(stdout) as unknown
    const items = Array.isArray(parsed) ? parsed : []
    for (const item of items as Array<{ key?: unknown; fields?: { status?: { name?: unknown; statusCategory?: { name?: unknown } }; assignee?: { displayName?: unknown } | null; priority?: { name?: unknown } | null } }>) {
      const key = typeof item?.key === 'string' ? item.key : ''
      if (!JIRA_KEY_PATTERN.test(key)) continue
      const status = item.fields?.status
      const assignee = item.fields?.assignee
      const priority = item.fields?.priority
      out.push({
        key,
        status: String(status?.name ?? 'Unknown'),
        category: String(status?.statusCategory?.name ?? ''),
        ...(typeof assignee?.displayName === 'string' ? { assignee: assignee.displayName } : {}),
        ...(typeof priority?.name === 'string' ? { priority: priority.name } : {}),
      })
    }
  }
  return out
}

export class JiraStatusStore {
  private memory?: CacheFile

  constructor(private readonly file: string = JIRA_CACHE_PATH, private readonly run: AcliRunner = acliRunner) {}

  private async load(): Promise<CacheFile> {
    if (this.memory) return this.memory
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<CacheFile>
      const statuses = parsed && typeof parsed.statuses === 'object' && parsed.statuses ? parsed.statuses : {}
      this.memory = { version: 1, readAt: typeof parsed?.readAt === 'string' ? parsed.readAt : new Date(0).toISOString(), statuses: statuses as Record<string, CachedStatus> }
    } catch {
      // No cache yet (or unreadable): an empty one, never an error the page has to handle.
      this.memory = { version: 1, readAt: new Date(0).toISOString(), statuses: {} }
    }
    return this.memory
  }

  private async save(cache: CacheFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(cache), { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, this.file)
    this.memory = cache
  }

  /** Cache only: fills the statuses it knows, marks staleness. Never calls acli. */
  async peek(keys: string[]): Promise<JiraReadResult> {
    const cache = await this.load()
    const wanted = [...new Set(keys.filter(key => JIRA_KEY_PATTERN.test(key)))]
    const statuses: Record<string, JiraStatus> = {}
    for (const key of wanted) {
      const entry = cache.statuses[key]
      if (!entry) continue
      statuses[key] = { ...entry, readAt: cache.readAt }
    }
    const stale = !cache.readAt || Date.now() - Date.parse(cache.readAt) > JIRA_TTL_MS
    return { statuses, meta: { available: wanted.length > 0, ...(cache.readAt ? { readAt: cache.readAt } : {}), stale } }
  }

  /** Explicit refresh: reads Jira for the given keys, merges into the cache, reports why it failed if it did. */
  async refresh(keys: string[]): Promise<JiraReadResult> {
    const wanted = [...new Set(keys.filter(key => JIRA_KEY_PATTERN.test(key)))]
    if (!wanted.length) return this.peek([])
    let rows: Awaited<ReturnType<AcliRunner>>
    try {
      rows = await this.run(wanted)
    } catch (error) {
      const peeking = await this.peek(wanted)
      return { statuses: peeking.statuses, meta: { ...peeking.meta, error: error instanceof Error ? error.message : String(error) } }
    }
    const cache = await this.load()
    const readAt = new Date().toISOString()
    const statuses: Record<string, CachedStatus> = { ...cache.statuses }
    for (const row of rows) {
      const category = jiraCategoryOf(row.category || row.status)
      statuses[row.key] = { name: row.status, category, ...(row.assignee ? { assignee: row.assignee } : {}), ...(row.priority ? { priority: row.priority } : {}) }
    }
    await this.save({ version: 1, readAt, statuses })
    const ours: Record<string, JiraStatus> = {}
    for (const key of wanted) {
      const entry = statuses[key]
      if (entry) ours[key] = { ...entry, readAt }
    }
    const missing = wanted.filter(key => !statuses[key])
    return { statuses: ours, meta: { available: true, readAt, stale: false, ...(missing.length ? { error: `${missing.length} 个 key 没读到（可能无权限或已被删除）` } : {}) } }
  }
}