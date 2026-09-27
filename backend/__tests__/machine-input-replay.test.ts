import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMachineInputReplay } from '../machine-input-replay.js'

const dirs: string[] = []
const stores: { close(): void }[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-replay-'))
  dirs.push(dir)
  return join(dir, 'machine-input-replay.json')
}
function open(path: string) {
  const store = openMachineInputReplay(path)
  stores.push(store)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('durable remote-input reservation', () => {
  it('persists before returning, survives reopen, and stores no input or raw identifiers', () => {
    const path = fixture()
    const first = open(path)
    expect(first.reserve('remote-private-client', 'private-uuid')).toBe(true)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    const bytes = readFileSync(path, 'utf8')
    expect(bytes).not.toContain('private-client')
    expect(bytes).not.toContain('private-uuid')
    expect(JSON.parse(bytes).ids).toHaveLength(1)
    first.close() // same durability guarantee on process restart, including crashed dispatch
    const restarted = open(path)
    expect(restarted.reserve('remote-private-client', 'private-uuid')).toBe(false)
    expect(restarted.reserve('remote-private-client', 'another-uuid')).toBe(true)
  })
  it('fails closed on symlinks, wrong modes, non-files, corrupt state, changed state, and concurrent owners', () => {
    const path = fixture()
    symlinkSync(join(tmpdir(), 'nonexistent-replay-target'), path)
    expect(() => open(path)).toThrow()
    rmSync(path)
    writeFileSync(path, '{}', { mode: 0o644 })
    expect(() => open(path)).toThrow()
    chmodSync(path, 0o600)
    expect(() => open(path)).toThrow()
    writeFileSync(path, '{"ids":["bad"]}')
    expect(() => open(path)).toThrow()
    writeFileSync(path, '{"ids":[],"ids":[]}')
    expect(() => open(path)).toThrow()
    writeFileSync(path, '{"ids":[]}')
    const store = open(path)
    expect(() => open(path)).toThrow()
    writeFileSync(path, '{"ids":[],"unexpected":1}')
    expect(() => store.reserve('c', 'id')).toThrow()
    expect(() => store.reserve('c', 'next')).toThrow()
  })
  it('rejects unsafe directories, nonregular files and stale locks', () => {
    const path = fixture()
    chmodSync(join(path, '..'), 0o777)
    expect(() => open(path)).toThrow()
    chmodSync(join(path, '..'), 0o700)
    const store = open(path)
    expect(store.reserve('c', 'id')).toBe(true)
    expect(() => open(path)).toThrow()
    store.close()
    rmSync(path)
    mkdirSync(path)
    expect(() => open(path)).toThrow()
  })
  it('never evicts at the cap and refuses further reservations', () => {
    const path = fixture()
    const ids = Array.from({ length: 100_000 }, (_, i) => createHash('sha256').update(String(i)).digest('hex'))
    writeFileSync(path, JSON.stringify({ ids }), { mode: 0o600 })
    const store = open(path)
    expect(() => store.reserve('c', 'new')).toThrow('Replay store full')
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify({ ids }))
  })
})
