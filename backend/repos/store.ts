/**
 * The repo registry: `repos` in `~/.pi/dashboard.json` is the single source, the Repos page only
 * edits it. Pure validation lives here; reading/writing the config file goes through `ConfigIo`
 * so tests need no home directory.
 */
import { realpathSync, statSync } from 'fs'
import os from 'os'
import path from 'path'
import type { RepoEntry } from '../../shared/src/repos.js'

export interface ConfigIo {
  load(): RepoEntry[]
  save(entries: RepoEntry[]): void
}

export class RepoError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 64)
  return slug || 'repo'
}

function canonical(input: string): string {
  const expanded = input.startsWith('~') ? input.replace(/^~/, os.homedir()) : input
  if (!path.isAbsolute(expanded)) throw new RepoError(400, 'path_not_absolute', '路径必须是绝对路径')
  const resolved = path.resolve(expanded)
  try {
    if (!statSync(resolved).isDirectory()) throw new RepoError(400, 'path_not_directory', '该路径不是目录')
    return realpathSync(resolved)
  } catch (error) {
    if (error instanceof RepoError) throw error
    throw new RepoError(400, 'path_not_found', '该路径不存在')
  }
}

function realpathOrSelf(value: string): string {
  try { return realpathSync(value) } catch { return value }
}

function cleanTags(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) return undefined
  const out = [...new Set(tags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean))]
  return out.length ? out : undefined
}

export interface RepoInput {
  id?: unknown
  path?: unknown
  name?: unknown
  tags?: unknown
  pinned?: unknown
  defaultBranch?: unknown
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function build(id: string, dir: string, input: RepoInput): RepoEntry {
  const entry: RepoEntry = { id, path: dir }
  const name = optionalString(input.name)
  if (name) entry.name = name
  const tags = cleanTags(input.tags)
  if (tags) entry.tags = tags
  if (input.pinned === true) entry.pinned = true
  const defaultBranch = optionalString(input.defaultBranch)
  if (defaultBranch) entry.defaultBranch = defaultBranch
  return entry
}

export class RepoStore {
  constructor(private readonly io: ConfigIo) {}

  list(): RepoEntry[] {
    return this.io.load()
  }

  get(id: string): RepoEntry | undefined {
    return this.list().find(entry => entry.id === id)
  }

  add(input: RepoInput): RepoEntry {
    if (typeof input.path !== 'string') throw new RepoError(400, 'path_required', '需要 path')
    const dir = canonical(input.path)
    const entries = this.list()
    const duplicate = entries.find(entry => realpathOrSelf(entry.path) === dir)
    if (duplicate) throw new RepoError(409, 'path_duplicate', `该路径已登记为 ${duplicate.id}`)
    let id: string
    if (input.id === undefined || input.id === '') {
      const base = slugify(path.basename(dir))
      id = base
      for (let n = 2; entries.some(entry => entry.id === id); n++) id = `${base}-${n}`.slice(0, 64)
    } else {
      id = String(input.id)
      if (!ID_PATTERN.test(id)) throw new RepoError(400, 'id_invalid', 'id 只能含小写字母、数字、. _ -，且以字母或数字开头')
      if (entries.some(entry => entry.id === id)) throw new RepoError(409, 'id_duplicate', `id ${id} 已存在`)
    }
    const entry = build(id, dir, input)
    this.io.save([...entries, entry])
    return entry
  }

  /** `id` is the stable key and never changes; everything else may. */
  update(id: string, input: RepoInput): RepoEntry {
    const entries = this.list()
    const index = entries.findIndex(entry => entry.id === id)
    if (index < 0) throw new RepoError(404, 'repo_not_found', `没有 id 为 ${id} 的仓库`)
    const current = entries[index]!
    let dir = current.path
    if (input.path !== undefined) {
      if (typeof input.path !== 'string') throw new RepoError(400, 'path_required', 'path 必须是字符串')
      dir = canonical(input.path)
      const duplicate = entries.find(entry => entry.id !== id && realpathOrSelf(entry.path) === dir)
      if (duplicate) throw new RepoError(409, 'path_duplicate', `该路径已登记为 ${duplicate.id}`)
    }
    const merged: RepoInput = { ...current, ...input }
    const next = build(id, dir, merged)
    const copy = [...entries]
    copy[index] = next
    this.io.save(copy)
    return next
  }

  remove(id: string): void {
    const entries = this.list()
    if (!entries.some(entry => entry.id === id)) throw new RepoError(404, 'repo_not_found', `没有 id 为 ${id} 的仓库`)
    this.io.save(entries.filter(entry => entry.id !== id))
  }
}

/** Tolerant read of the raw config value: bad entries are dropped, not fatal. */
export function sanitizeEntries(raw: unknown): RepoEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: RepoEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || !ID_PATTERN.test(record.id) || seen.has(record.id)) continue
    if (typeof record.path !== 'string' || !path.isAbsolute(record.path)) continue
    seen.add(record.id)
    out.push(build(record.id, record.path, record))
  }
  return out
}
