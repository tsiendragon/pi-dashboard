import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { payloadHash, SupervisorStore } from '../supervisor/store.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-store-'))
  roots.push(root)
  return { root, store: new SupervisorStore(root) }
}
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
const jpeg = Buffer.from([255, 216, 255, 224])
const webp = Buffer.from('RIFF0000WEBP')

describe('SupervisorStore', () => {
  it('serializes concurrent instances and survives reload with private file modes', async () => {
    const { root, store } = await fixture()
    const other = new SupervisorStore(root)
    const uploads = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? store : other).uploadImage({ name: `${i}.png`, mime: 'image/png', data: png })))
    const reloaded = new SupervisorStore(root)
    expect((await reloaded.snapshot()).attachments).toHaveLength(12)
    expect((await reloaded.readAttachment(uploads[0].id)).data).toEqual(png)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, 'archive.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'attachments'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, 'attachments', uploads[0].id))).mode & 0o777).toBe(0o600)
  })

  it('persists canonical idempotency hashes and replays results without rerunning work', async () => {
    const { root, store } = await fixture()
    const work = vi.fn(async () => ({ persisted: true }))
    const one = await store.request('r1', { b: 2, a: 1 }, work)
    const two = await new SupervisorStore(root).request('r1', { a: 1, b: 2 }, work)
    expect(one).toEqual(two)
    expect(work).toHaveBeenCalledTimes(1)
    expect((await store.snapshot()).requests.r1.payloadHash).toBe(payloadHash({ a: 1, b: 2 }))
    await expect(store.request('r1', { a: 2 }, work)).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' })
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('keeps a crash checkpoint pending rather than repeating an external side effect', async () => {
    const { store } = await fixture()
    await store.transaction(async archive => { archive.requests.interrupted = { state: 'pending', payloadHash: payloadHash({ title: 'new' }) } })
    const work = vi.fn()
    await expect(store.request('interrupted', { title: 'new' }, work)).rejects.toMatchObject({ code: 'request_pending', status: 409 })
    expect(work).not.toHaveBeenCalled()
  })

  it.each(['{bad json', '{}', '{"version":99}', '{"version":1,"events":[]}'])('fails closed for corrupt archives: %s', async data => {
    const { root, store } = await fixture()
    await writeFile(join(root, 'archive.json'), data)
    await expect(store.snapshot()).rejects.toMatchObject({ status: 503, code: 'storage_corrupt' })
    await expect(store.uploadImage({ name: 'a.png', mime: 'image/png', data: png })).rejects.toMatchObject({ code: 'storage_corrupt' })
    expect(await readFile(join(root, 'archive.json'), 'utf8')).toBe(data)
  })

  it('rejects malformed records rather than hiding corruption', async () => {
    const { root, store } = await fixture()
    await store.uploadImage({ name: 'a.png', mime: 'image/png', data: png })
    const archive = await store.snapshot()
    archive.events.push({ id: 'e1' } as never)
    await writeFile(join(root, 'archive.json'), JSON.stringify(archive))
    await expect(store.snapshot()).rejects.toMatchObject({ code: 'storage_corrupt' })
  })

  it.each(['../secret', 'a/b', '/etc/passwd', 'a\\b', '.', '..', ''])('rejects attachment and request traversal ID %s', async id => {
    const { store } = await fixture()
    await expect(store.readAttachment(id)).rejects.toMatchObject({ code: 'invalid_id', status: 400 })
    await expect(store.request(id, {}, async () => true)).rejects.toMatchObject({ code: 'invalid_id' })
  })

  it.each([['image/png', png], ['image/jpeg', jpeg], ['image/webp', webp]] as const)('accepts %s magic and returns metadata plus data', async (mime, data) => {
    const { store } = await fixture()
    const metadata = await store.uploadImage({ name: 'evidence', mime, data })
    expect(await store.readAttachment(metadata.id)).toEqual({ metadata, data })
  })

  it('checks MIME, magic, names, empty bytes and 3 MiB bound before persistence', async () => {
    const { store } = await fixture()
    for (const input of [
      { name: 'a.png', mime: 'image/jpeg', data: png },
      { name: 'a.gif', mime: 'image/gif', data: Buffer.from('GIF89a') },
      { name: '../secret', mime: 'image/png', data: png },
      { name: 'a.png', mime: 'image/png', data: Buffer.alloc(0) },
    ]) await expect(store.uploadImage(input)).rejects.toMatchObject({ status: 400 })
    const big = Buffer.alloc(3 * 1024 * 1024 + 1)
    png.copy(big)
    await expect(store.uploadImage({ name: 'big.png', mime: 'image/png', data: big })).rejects.toMatchObject({ status: 413 })
    expect((await store.snapshot()).attachments).toEqual([])
  })

  it('accepts exactly 3 MiB, rejects missing data and symlinked attachment files', async () => {
    const { root, store } = await fixture()
    const data = Buffer.alloc(3 * 1024 * 1024)
    png.copy(data)
    const metadata = await store.uploadImage({ name: 'boundary.png', mime: 'image/png', data })
    expect((await store.readAttachment(metadata.id)).data.length).toBe(data.length)
    const path = join(root, 'attachments', metadata.id)
    await writeFile(path, png)
    await expect(store.readAttachment(metadata.id)).rejects.toMatchObject({ code: 'attachment_corrupt', status: 503 })
    await rm(path)
    await expect(store.readAttachment(metadata.id)).rejects.toMatchObject({ code: 'attachment_missing', status: 503 })
    await symlink(join(root, 'archive.json'), path)
    await expect(store.readAttachment(metadata.id)).rejects.toMatchObject({ code: 'ELOOP' })
  })

  it('rejects symlink roots and concurrent/stale cross-process write locks', async () => {
    const { root, store } = await fixture()
    const link = join(root, 'link')
    await symlink(root, link)
    await expect(new SupervisorStore(link).snapshot()).rejects.toMatchObject({ code: 'unsafe_storage' })
    await writeFile(join(root, '.write-lock'), '')
    await expect(store.uploadImage({ name: 'a.png', mime: 'image/png', data: png })).rejects.toMatchObject({ code: 'storage_locked', status: 503 })
  })

  it('does not replace the last valid JSON on a failed atomic commit', async () => {
    const { root, store } = await fixture()
    await store.uploadImage({ name: 'a.png', mime: 'image/png', data: png })
    const before = await readFile(join(root, 'archive.json'), 'utf8')
    vi.spyOn(store as unknown as { atomic(): Promise<void> }, 'atomic').mockRejectedValueOnce(new Error('simulated I/O failure'))
    await expect(store.transaction(async archive => { archive.attachments = [] })).rejects.toThrow('simulated I/O failure')
    expect(await readFile(join(root, 'archive.json'), 'utf8')).toBe(before)
    expect((await new SupervisorStore(root).snapshot()).attachments).toHaveLength(1)
  })
})
