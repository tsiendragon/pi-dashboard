import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import type { SupervisorAction, SupervisorAttachment, SupervisorEvent, SupervisorReport } from '../../shared/src/supervisor.js'

export class SupervisorError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) {
    super(message)
    this.name = 'SupervisorError'
  }
}
const safeId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v)
export function validateId(value: unknown): string {
  if (!safeId(value)) throw new SupervisorError(400, 'invalid_id')
  return value
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  const result = JSON.stringify(value)
  if (result === undefined) throw new SupervisorError(400, 'invalid_payload')
  return result
}
export function payloadHash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
interface Receipt {
  payloadHash: string
  state: 'pending' | 'done' | 'failed'
  result?: unknown
  error?: { status: number; code: string; message: string }
}
export interface SupervisorArchive {
  version: 1
  events: SupervisorEvent[]
  actions: SupervisorAction[]
  reports: SupervisorReport[]
  attachments: SupervisorAttachment[]
  actionVersions: Record<string, number>
  actionRevisions: Record<string, Array<{ version: number; at: string; actor: string; previous: SupervisorAction }>>
  requests: Record<string, Receipt>
}
const empty = (): SupervisorArchive => ({ version: 1, events: [], actions: [], reports: [], attachments: [], actionVersions: {}, actionRevisions: {}, requests: {} })
const queues = new Map<string, Promise<unknown>>()
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const text = (o: Record<string, unknown>, ...keys: string[]) => keys.every(k => typeof o[k] === 'string')
const version = (v: unknown) => Number.isInteger(v) && Number(v) > 0
const hashValid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
function validateArchive(raw: unknown): asserts raw is SupervisorArchive {
  const corrupt = () => { throw new SupervisorError(503, 'storage_corrupt', 'Supervisor archive is corrupted; repair it before writing') }
  if (!object(raw) || raw.version !== 1) return corrupt()
  for (const key of ['events', 'actions', 'reports', 'attachments']) {
    const rows = raw[key]
    if (!Array.isArray(rows) || rows.some(r => !object(r) || !safeId(r.id)) || new Set(rows.map(r => r.id)).size !== rows.length) return corrupt()
  }
  for (const e of raw.events as Record<string, unknown>[]) {
    if (!text(e, 'objectRef', 'title', 'type', 'description', 'recordedAt', 'requestId', 'payloadHash') || !safeId(e.requestId) || !hashValid(e.payloadHash) || !version(e.version) || !(e.occurredAt === null || typeof e.occurredAt === 'string') || !strings(e.participants) || !strings(e.attachmentIds) || !e.attachmentIds.every(safeId) || !object(e.source) || !['user', 'relay', 'agent'].includes(String(e.source.kind)) || !Array.isArray(e.revisions) || e.revisions.some(r => !object(r) || !version(r.version) || !text(r, 'at', 'actor') || !object(r.previous)) || (e.interval !== undefined && (!object(e.interval) || !['wait', 'stage', 'effort'].includes(String(e.interval.kind)) || !safeId(e.interval.startEventId) || (e.interval.durationMinutes !== undefined && (typeof e.interval.durationMinutes !== 'number' || !Number.isFinite(e.interval.durationMinutes) || e.interval.durationMinutes < 0))))) return corrupt()
  }
  for (const a of raw.actions as Record<string, unknown>[]) if (!text(a, 'title', 'reason', 'createdAt', 'updatedAt') || !strings(a.sourceRefs) || !['suggested', 'open', 'done', 'dismissed'].includes(String(a.state)) || (a.objectRef !== undefined && typeof a.objectRef !== 'string')) return corrupt()
  for (const r of raw.reports as Record<string, unknown>[]) if (!text(r, 'content', 'coverage', 'createdAt') || !['summary', 'review', 'retrospective'].includes(String(r.kind)) || !strings(r.sourceRefs) || !strings(r.missing) || !object(r.inputVersions) || !Object.values(r.inputVersions).every(version) || (r.objectRef !== undefined && typeof r.objectRef !== 'string')) return corrupt()
  for (const a of raw.attachments as Record<string, unknown>[]) if (!text(a, 'name', 'mime', 'createdAt') || !['image/jpeg', 'image/png', 'image/webp'].includes(String(a.mime)) || !Number.isInteger(a.bytes) || Number(a.bytes) <= 0 || Number(a.bytes) > 3 * 1024 * 1024) return corrupt()
  if (!object(raw.requests) || !object(raw.actionVersions) || !object(raw.actionRevisions)) return corrupt()
  if (Object.entries(raw.requests).some(([id, r]) => !safeId(id) || !object(r) || !hashValid(r.payloadHash) || !['pending', 'done', 'failed'].includes(String(r.state)) || (r.state === 'done' && !('result' in r)) || (r.state === 'failed' && (!object(r.error) || !text(r.error, 'code', 'message') || !Number.isInteger(r.error.status))))) return corrupt()
  if (Object.entries(raw.actionVersions).some(([id, v]) => !safeId(id) || !version(v)) || Object.entries(raw.actionRevisions).some(([id, v]) => !safeId(id) || !Array.isArray(v) || v.some(r => !object(r) || !version(r.version) || !text(r, 'at', 'actor') || !object(r.previous)))) return corrupt()
  const attachmentIds = new Set((raw.attachments as SupervisorAttachment[]).map(a => a.id))
  for (const e of raw.events as SupervisorEvent[]) if (e.version !== e.revisions.length + 1 || e.revisions.some((r, i) => r.version !== i + 1) || e.attachmentIds.some(id => !attachmentIds.has(id))) return corrupt()
  for (const a of raw.actions as SupervisorAction[]) {
    const revisions = raw.actionRevisions[a.id]
    if (!Array.isArray(revisions) || raw.actionVersions[a.id] !== revisions.length + 1) return corrupt()
  }
}

/** Atomic authoritative JSON archive; queued in-process, exclusive lock across processes. */
export class SupervisorStore {
  readonly root: string
  constructor(root: string) { this.root = resolve(root) }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = (queues.get(this.root) ?? Promise.resolve()).then(work, work)
    const tail = run.then(() => undefined, () => undefined)
    queues.set(this.root, tail)
    void tail.then(() => { if (queues.get(this.root) === tail) queues.delete(this.root) })
    return run
  }
  private async directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SupervisorError(503, 'unsafe_storage')
    await chmod(path, 0o700)
  }
  private async readBytes(path: string): Promise<Buffer> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!(await handle.stat()).isFile()) throw new SupervisorError(503, 'unsafe_storage')
      await handle.chmod(0o600)
      return await handle.readFile()
    } finally { await handle.close() }
  }
  private async load(): Promise<SupervisorArchive> {
    await this.directory(this.root)
    let data: Buffer
    try { data = await this.readBytes(join(this.root, 'archive.json')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error }
    let raw: unknown
    try { raw = JSON.parse(data.toString('utf8')) }
    catch { throw new SupervisorError(503, 'storage_corrupt', 'Supervisor archive contains invalid JSON') }
    validateArchive(raw)
    return raw
  }
  private async atomic(path: string, data: Buffer | string): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      const handle = await open(temp, 'wx', 0o600)
      try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
      await rename(temp, path)
      const dir = await open(dirname(path), 'r')
      try { await dir.sync() } finally { await dir.close() }
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  async snapshot(): Promise<SupervisorArchive> { return this.serialize(() => this.load()) }
  /** commit checkpoints external outcomes before audit writes. */
  async transaction<T>(work: (archive: SupervisorArchive, commit: () => Promise<void>) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      await this.directory(this.root)
      const lockPath = join(this.root, '.write-lock')
      let lock
      try { lock = await open(lockPath, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SupervisorError(503, 'storage_locked', 'Another writer or interrupted write holds the archive lock; reconcile before retrying')
        throw error
      }
      try {
        const archive = await this.load()
        let persisted = payloadHash(archive)
        const commit = async () => {
          validateArchive(archive)
          await this.atomic(join(this.root, 'archive.json'), JSON.stringify(archive) + '\n')
          persisted = payloadHash(archive)
        }
        const result = await work(archive, commit)
        if (persisted !== payloadHash(archive)) await commit()
        return result
      } finally { await lock.close(); await unlink(lockPath) }
    })
  }
  async request<T>(requestId: string, payload: unknown, work: (archive: SupervisorArchive, commit: () => Promise<void>) => Promise<T>): Promise<T> {
    validateId(requestId)
    const hash = payloadHash(payload)
    let outcome: T | undefined
    return this.transaction(async (archive, commit) => {
      const receipt = Object.hasOwn(archive.requests, requestId) ? archive.requests[requestId] : undefined
      if (receipt) {
        if (receipt.payloadHash !== hash) throw new SupervisorError(409, 'idempotency_conflict')
        if (receipt.state === 'done') return receipt.result as T
        if (receipt.state === 'failed') throw new SupervisorError(receipt.error!.status, receipt.error!.code, receipt.error!.message)
        throw new SupervisorError(409, 'request_pending', 'An interrupted request may have written a task; reconcile instead of creating another')
      }
      archive.requests[requestId] = { state: 'pending', payloadHash: hash }
      await commit()
      try {
        const result = await work(archive, commit)
        outcome = result
        archive.requests[requestId] = { state: 'done', payloadHash: hash, result }
        return result
      } catch (error) {
        if (archive.requests[requestId].state === 'done') { await commit(); throw error }
        const err = error instanceof SupervisorError ? error : new SupervisorError(503, 'operation_failed', 'Operation failed; check persisted outcomes before retrying')
        archive.requests[requestId] = { state: 'failed', payloadHash: hash, error: { status: err.status, code: err.code, message: err.message } }
        await commit()
        throw err
      }
    }).catch(error => {
      // A successful external write cannot be rolled back when archive I/O fails.
      if (object(outcome) && outcome.taskWritten === true) return { ...outcome, event: undefined, eventRecorded: false, warnings: ['Task write succeeded, but archive persistence failed; reconcile before retrying this request'] } as T
      throw error
    })
  }
  async uploadImage(input: { name: string; mime: string; data: Buffer }): Promise<SupervisorAttachment> {
    if (!Buffer.isBuffer(input.data) || !input.data.length) throw new SupervisorError(400, 'invalid_image')
    if (input.data.length > 3 * 1024 * 1024) throw new SupervisorError(413, 'image_too_large')
    const b = input.data
    const actual = b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg' : b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null
    if (!actual || actual !== input.mime) throw new SupervisorError(400, 'invalid_image', 'Image MIME and JPEG/PNG/WebP magic must match')
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 255 || /[\\/\x00-\x1f]/.test(input.name) || input.name === '..') throw new SupervisorError(400, 'invalid_image_name')
    return this.transaction(async archive => {
      await this.directory(join(this.root, 'attachments'))
      const metadata: SupervisorAttachment = { id: randomUUID(), name: input.name, mime: actual, bytes: b.length, createdAt: new Date().toISOString() }
      await this.atomic(join(this.root, 'attachments', metadata.id), b)
      archive.attachments.push(metadata)
      return metadata
    })
  }
  async readAttachment(id: string): Promise<{ metadata: SupervisorAttachment; data: Buffer }> {
    validateId(id)
    return this.serialize(async () => {
      const metadata = (await this.load()).attachments.find(a => a.id === id)
      if (!metadata) throw new SupervisorError(404, 'attachment_not_found')
      await this.directory(join(this.root, 'attachments'))
      let data: Buffer
      try { data = await this.readBytes(join(this.root, 'attachments', id)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SupervisorError(503, 'attachment_missing'); throw error }
      if (data.length !== metadata.bytes) throw new SupervisorError(503, 'attachment_corrupt')
      return { metadata, data }
    })
  }
}
