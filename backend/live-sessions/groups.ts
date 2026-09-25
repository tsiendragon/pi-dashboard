import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LiveSessionGroup } from '../../shared/src/live-sessions.js'

export const DEFAULT_LIVE_SESSION_GROUPS_PATH = '/mnt/workspace/lilong/agent/pi/live-session-groups.json'

type StoredGroups = {
  version: 1
  groups: LiveSessionGroup[]
}

function normalizeGroup(value: unknown): LiveSessionGroup | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return undefined
  const sessionIds = Array.isArray(record.sessionIds)
    ? [...new Set(record.sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
  const now = new Date().toISOString()
  return {
    id: record.id,
    name: record.name.trim().slice(0, 120) || '未命名任务',
    sessionIds,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now,
  }
}

export class LiveSessionGroupStore {
  private readonly filePath: string
  private groups: LiveSessionGroup[] = []
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(filePath = process.env.PI_DASH_LIVE_SESSION_GROUPS || DEFAULT_LIVE_SESSION_GROUPS_PATH) {
    this.filePath = filePath
  }

  async start(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as StoredGroups | unknown
      const values = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as StoredGroups).groups)
        ? (parsed as StoredGroups).groups
        : []
      this.groups = values.map(normalizeGroup).filter((group): group is LiveSessionGroup => !!group)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[live-session-groups] Failed to load ${this.filePath}:`, error)
      }
      this.groups = []
    }
  }

  async list(): Promise<LiveSessionGroup[]> {
    await this.start()
    return this.groups.map(group => ({ ...group, sessionIds: [...group.sessionIds] }))
  }

  async create(name: string): Promise<LiveSessionGroup[]> {
    await this.start()
    const normalized = name.trim().slice(0, 120)
    if (!normalized) throw new Error('group_name_required')
    const now = new Date().toISOString()
    this.groups.push({ id: randomUUID(), name: normalized, sessionIds: [], createdAt: now, updatedAt: now })
    await this.persist()
    return this.list()
  }

  async rename(groupId: string, name: string): Promise<LiveSessionGroup[]> {
    await this.start()
    const group = this.find(groupId)
    const normalized = name.trim().slice(0, 120)
    if (!normalized) throw new Error('group_name_required')
    group.name = normalized
    group.updatedAt = new Date().toISOString()
    await this.persist()
    return this.list()
  }

  async remove(groupId: string): Promise<LiveSessionGroup[]> {
    await this.start()
    const index = this.groups.findIndex(group => group.id === groupId)
    if (index < 0) throw new Error('group_not_found')
    this.groups.splice(index, 1)
    await this.persist()
    return this.list()
  }

  async addMember(groupId: string, sessionId: string): Promise<LiveSessionGroup[]> {
    await this.start()
    const group = this.find(groupId)
    for (const candidate of this.groups) {
      if (candidate.id === groupId) continue
      candidate.sessionIds = candidate.sessionIds.filter(id => id !== sessionId)
    }
    if (!group.sessionIds.includes(sessionId)) group.sessionIds.push(sessionId)
    group.updatedAt = new Date().toISOString()
    await this.persist()
    return this.list()
  }

  async removeMember(groupId: string, sessionId: string): Promise<LiveSessionGroup[]> {
    await this.start()
    const group = this.find(groupId)
    group.sessionIds = group.sessionIds.filter(id => id !== sessionId)
    group.updatedAt = new Date().toISOString()
    await this.persist()
    return this.list()
  }

  /**
   * Move a member to a new `sessionId`, keeping its slot inside its group.
   *
   * A live Pi can switch session in-process (`/clear`, `/ls-fork`) while keeping
   * its `processInstanceId`; without this the row silently leaves its task group.
   */
  async rekey(from: string, to: string): Promise<LiveSessionGroup[]> {
    await this.start()
    if (!from || !to || from === to) return this.list()
    let touched = false
    for (const group of this.groups) {
      const index = group.sessionIds.indexOf(from)
      if (index < 0) continue
      group.sessionIds.splice(index, 1)
      if (!group.sessionIds.includes(to)) group.sessionIds.splice(index, 0, to)
      group.updatedAt = new Date().toISOString()
      touched = true
    }
    if (touched) await this.persist()
    return this.list()
  }

  private find(groupId: string): LiveSessionGroup {
    const group = this.groups.find(candidate => candidate.id === groupId)
    if (!group) throw new Error('group_not_found')
    return group
  }

  private async persist(): Promise<void> {
    const payload: StoredGroups = { version: 1, groups: this.groups }
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
