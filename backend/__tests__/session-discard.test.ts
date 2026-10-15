import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupSessionDiscard, commitSessionDiscard, prepareSessionDiscard, prepareSessionWithdrawal } from '../live-sessions/session-discard.js'

const HEADER = { type: 'session', version: 3, id: 'session-a', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/app' }
const user = (id: string, parentId: string | null, text: string) => ({
  type: 'message', id, parentId, timestamp: '2026-01-01T00:00:01.000Z',
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const assistant = (id: string, parentId: string, text: string) => ({
  type: 'message', id, parentId, timestamp: '2026-01-01T00:00:02.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function sourceFile(entries: unknown[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'session-discard-'))
  directories.push(directory)
  const file = join(directory, 'source.jsonl')
  writeFileSync(file, [HEADER, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  return file
}

function records(file: string): Array<{ id?: string }> {
  return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { id?: string })
}

describe('prepareSessionWithdrawal', () => {
  it('removes the latest user message and descendants, then resumes at its parent', () => {
    const file = sourceFile([
      user('u1', null, 'first'), assistant('a1', 'u1', 'reply'),
      user('u2', 'a1', 'withdraw'), assistant('a2', 'u2', 'answer'),
    ])
    const plan = prepareSessionWithdrawal(file, 'u2')
    try {
      expect(plan.deletedEntries).toBe(1)
      expect(plan.removedEntries).toBe(2)
      commitSessionDiscard(plan)
      expect(records(file).slice(1).map(entry => entry.id)).toEqual(['u1', 'a1'])
      expect(records(file).at(-1)?.id).toBe('a1')
    } finally {
      cleanupSessionDiscard(plan)
    }
  })

  it('allows withdrawing a root prompt only when it has no sibling branches', () => {
    const file = sourceFile([user('u1', null, 'first'), assistant('a1', 'u1', 'reply')])
    const plan = prepareSessionWithdrawal(file, 'u1')
    try {
      expect(plan.removedEntries).toBe(2)
      commitSessionDiscard(plan)
      expect(records(file)).toHaveLength(1)
    } finally {
      cleanupSessionDiscard(plan)
    }

    const branchedFile = sourceFile([
      user('u-old', null, 'old root'), assistant('a-old', 'u-old', 'old reply'),
      user('u1', null, 'current root'), assistant('a1', 'u1', 'current reply'),
    ])
    expect(() => prepareSessionWithdrawal(branchedFile, 'u1')).toThrowError(
      expect.objectContaining({ code: 'rewind_root_has_other_branches' }),
    )
  })

  it('only allows withdrawing the latest user message on the active branch', () => {
    const file = sourceFile([
      user('u1', null, 'first'), assistant('a1', 'u1', 'reply'),
      user('u2', 'a1', 'latest'), assistant('a2', 'u2', 'answer'),
    ])
    expect(() => prepareSessionWithdrawal(file, 'u1')).toThrowError(
      expect.objectContaining({ code: 'not_latest_user_message' }),
    )
  })
})

describe('prepareSessionDiscard', () => {
  it('stages an in-place rewind, keeps earlier alternate branches, and leaves source untouched until commit', () => {
    const file = sourceFile([
      user('u1', null, 'first'), assistant('a1', 'u1', 'reply'),
      user('u-alt', 'a1', 'alternate'), assistant('a-alt', 'u-alt', 'alternate reply'),
      user('u2', 'a1', 'checkpoint'), assistant('a2', 'u2', 'discard me'), user('u3', 'a2', 'also discard'),
    ])
    const original = readFileSync(file, 'utf8')
    const plan = prepareSessionDiscard(file, 'u2')
    try {
      expect(plan.deletedEntries).toBe(2)
      expect(readFileSync(file, 'utf8')).toBe(original)
      commitSessionDiscard(plan)
      expect(records(file).slice(1).map(entry => entry.id)).toEqual(['u1', 'a1', 'u-alt', 'a-alt', 'u2'])
      expect(records(file).at(-1)?.id).toBe('u2')
    } finally {
      cleanupSessionDiscard(plan)
    }
  })

  it('rejects non-user checkpoints without changing the source', () => {
    const file = sourceFile([user('u1', null, 'first'), assistant('a1', 'u1', 'reply'), user('u2', 'a1', 'later')])
    const original = readFileSync(file, 'utf8')
    expect(() => prepareSessionDiscard(file, 'a1')).toThrowError(expect.objectContaining({ code: 'entry_not_user_message' }))
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  it('rejects stale alternate-branch checkpoints and checkpoints with no later entries', () => {
    const file = sourceFile([
      user('u1', null, 'first'), assistant('a1', 'u1', 'reply'),
      user('u-alt', 'a1', 'alternate'), assistant('a-alt', 'u-alt', 'alternate reply'),
      user('u2', 'a1', 'active'),
    ])
    expect(() => prepareSessionDiscard(file, 'u-alt')).toThrowError(expect.objectContaining({ code: 'entry_not_on_active_branch' }))
    expect(() => prepareSessionDiscard(file, 'u2')).toThrowError(expect.objectContaining({ code: 'nothing_to_discard' }))
  })

  it('refuses to overwrite a session changed after staging', () => {
    const file = sourceFile([user('u1', null, 'first'), assistant('a1', 'u1', 'reply'), user('u2', 'a1', 'later'), assistant('a2', 'u2', 'answer')])
    const plan = prepareSessionDiscard(file, 'u2')
    try {
      writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ type: 'custom', id: 'new', parentId: 'a2' }) + '\n')
      expect(() => commitSessionDiscard(plan)).toThrowError(expect.objectContaining({ code: 'session_changed' }))
      expect(records(file).at(-1)?.id).toBe('new')
    } finally {
      cleanupSessionDiscard(plan)
    }
  })
})
