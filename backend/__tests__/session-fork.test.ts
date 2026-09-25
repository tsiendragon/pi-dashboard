import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionForkError, createBranchedSessionFile } from '../live-sessions/session-fork.js'

const HEADER = {
  type: 'session', version: 3, id: 'source-id',
  timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/app',
}

const userEntry = (id, parentId, text) => ({
  type: 'message', id, parentId, timestamp: '2026-01-01T00:00:01.000Z',
  message: { role: 'user', content: [{ type: 'text', text }] },
})

const assistantEntry = (id, parentId, text) => ({
  type: 'message', id, parentId, timestamp: '2026-01-01T00:00:02.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

/** A throwaway source session file; returns its path. */
function writeSource(entries) {
  const file = join(mkdtempSync(join(tmpdir(), 'session-fork-')), 'source.jsonl')
  writeFileSync(file, [HEADER, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  return file
}

describe('createBranchedSessionFile', () => {
  it('extracts the root→entry branch into a new file and never touches the source', () => {
    const source = writeSource([
      userEntry('u1', null, 'first'),
      assistantEntry('a1', 'u1', 'reply'),
      userEntry('u2', 'a1', 'second'),
    ])
    const before = readFileSync(source, 'utf8')

    const branched = createBranchedSessionFile(source, 'a1')

    expect(branched).not.toBe(source)
    expect(existsSync(branched)).toBe(true)
    const lines = readFileSync(branched, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(lines[0]).toMatchObject({ type: 'session', parentSession: source })
    expect(lines.slice(1).map(entry => entry.id)).toEqual(['u1', 'a1'])
    // the entry after the fork point is gone, and the source is byte-identical
    expect(readFileSync(source, 'utf8')).toBe(before)
  })

  it('materialises a branch pi would have deferred (no assistant message yet)', () => {
    const source = writeSource([userEntry('u1', null, 'only')])

    const branched = createBranchedSessionFile(source, 'u1')

    // pi defers the write until the first reply; the dashboard needs the file now
    expect(existsSync(branched)).toBe(true)
    const lines = readFileSync(branched, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(lines.slice(1).map(entry => entry.id)).toEqual(['u1'])
  })

  it('reports an unknown entry instead of writing a file', () => {
    const source = writeSource([userEntry('u1', null, 'first')])
    expect(() => createBranchedSessionFile(source, 'missing')).toThrow(SessionForkError)
  })

  it('reports a missing session file', () => {
    expect(() => createBranchedSessionFile(join(tmpdir(), 'does-not-exist-9d3a.jsonl'), 'u1')).toThrow(SessionForkError)
  })
})