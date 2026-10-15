/**
 * Task anchor sources outside the live registry.
 *
 * Two behaviours matter here:
 *  - a finished session still answers, read from its own file;
 *  - a live session keeps its anchor even after its `goal-state` entry has been
 *    pushed out of the entries window by newer output.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LiveSessionRegistry } from '../live-sessions/registry.js'
import { readSessionGoalAnchor } from '../live-sessions/session-goal.js'
import { SessionTreeError } from '../live-sessions/session-tree.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
})

function summary(overrides: Record<string, unknown> = {}) {
  return {
    processInstanceId: 'process-a', sessionId: 'session-a', pid: 4242,
    cwd: '/tmp/root/task', canonicalCwd: '/tmp/root/task', mode: 'tui',
    status: 'idle', claim: { state: 'unclaimed' }, startedAt: 1,
    lastActivityAt: 2, revision: 1, eventSequence: 0,
    ...overrides,
  }
}

function hello(overrides: Record<string, unknown> = {}) {
  return {
    type: 'hello', protocolVersion: 2, brokerToken: 'token',
    processInstanceId: 'process-a', pid: 4242, cwd: '/tmp/root/task',
    mode: 'tui', sessionId: 'session-a', ...overrides,
  }
}

function goalStateEntry(objective: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'custom',
    customType: 'goal-state',
    data: { state: { objective, ...extra } },
    timestamp: '2026-01-01T00:00:00.000Z',
  }
}

describe('readSessionGoalAnchor', () => {
  it('reads the newest goal state from a finished session file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-goal-file-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const previous = process.env.PI_DASH_SESSIONS_DIR
    process.env.PI_DASH_SESSIONS_DIR = root
    cleanups.push(async () => {
      if (previous === undefined) delete process.env.PI_DASH_SESSIONS_DIR
      else process.env.PI_DASH_SESSIONS_DIR = previous
    })

    const file = join(root, '2026-01-01T00-00-00-000Z_session.jsonl')
    await writeFile(file, [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'do the thing' } }),
      JSON.stringify(goalStateEntry('First goal')),
      'not json at all',
      JSON.stringify(goalStateEntry('Final goal', {
        status: 'complete',
        workItems: [
          { id: 'a', title: 'A', state: 'done', dependsOn: [] },
          { id: 'b', title: 'B', state: 'todo', dependsOn: [] },
        ],
      })),
      JSON.stringify({ type: 'message', id: 'm2', message: { role: 'assistant', content: 'ok' } }),
      '',
    ].join('\n'))

    const result = await readSessionGoalAnchor(file)

    expect(result.partial).toBe(false)
    expect(result.goal?.objective).toBe('Final goal')
    expect(result.goal?.workItems).toHaveLength(2)
    expect(result.goal?.messagesSinceUpdate).toBe(1)
  })

  it('refuses files outside the sessions directory and files that do not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-goal-scope-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const sessions = join(root, 'sessions')
    const outside = join(root, 'outside')
    await Promise.all([mkdir(sessions, { recursive: true }), mkdir(outside, { recursive: true })])
    const stray = join(outside, 'stray.jsonl')
    await writeFile(stray, JSON.stringify(goalStateEntry('Should not be readable')))

    const previous = process.env.PI_DASH_SESSIONS_DIR
    process.env.PI_DASH_SESSIONS_DIR = sessions
    cleanups.push(async () => {
      if (previous === undefined) delete process.env.PI_DASH_SESSIONS_DIR
      else process.env.PI_DASH_SESSIONS_DIR = previous
    })

    await expect(readSessionGoalAnchor(stray)).rejects.toBeInstanceOf(SessionTreeError)
    await expect(readSessionGoalAnchor(join(sessions, 'missing.jsonl'))).rejects.toMatchObject({ code: 'session_file_unavailable' })
  })
})

describe('LiveSessionRegistry goal progress', () => {
  it('derives the badge from entries and keeps the anchor when the window moves past it', () => {
    const registry = new LiveSessionRegistry({ commandTimeoutMs: 1_000, maxTimelineEntries: 4 })
    cleanups.push(() => registry.stop())
    const transport = { send() {} }
    registry.connect(hello(), '/tmp/root/task', transport)
    registry.applySnapshot({
      type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0, summary: summary(),
      entries: [
        goalStateEntry('Keep me', {
          status: 'complete',
          workItems: [
            { id: 'a', title: 'A', state: 'done', dependsOn: [] },
            { id: 'b', title: 'B', state: 'todo', dependsOn: [] },
            { id: 'c', title: 'C', state: 'todo', dependsOn: [] },
          ],
          blockers: [{ state: 'open', title: 'Ask', disposition: 'needs_user' }],
        }),
      ],
    }, transport, '/tmp/root/task')

    expect(registry.list()[0]?.goal).toMatchObject({ done: 1, total: 3, needsUser: 1, stale: true })
    expect(registry.get('process-a')?.goal?.objective).toBe('Keep me')

    // Newer output evicts the goal entry from a 4-entry window ...
    registry.applySnapshot({
      type: 'snapshot', processInstanceId: 'process-a', revision: 2, sequence: 1, summary: summary(),
      entries: [
        { type: 'message', message: { role: 'user' } },
        { type: 'message', message: { role: 'assistant' } },
        { type: 'message', message: { role: 'user' } },
        { type: 'message', message: { role: 'assistant' } },
      ],
    }, transport, '/tmp/root/task')

    expect(registry.get('process-a')?.entries.some(entry => (entry as { customType?: string }).customType === 'goal-state')).toBe(false)
    // ... and the cached anchor still answers.
    expect(registry.list()[0]?.goal).toMatchObject({ done: 1, total: 3 })
    expect(registry.get('process-a')?.goal?.objective).toBe('Keep me')
  })

  it('drops the anchor when a session switch starts a new session', () => {
    const registry = new LiveSessionRegistry({ commandTimeoutMs: 1_000 })
    cleanups.push(() => registry.stop())
    const transport = { send() {} }
    registry.connect(hello(), '/tmp/root/task', transport)
    registry.applySnapshot({
      type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0, summary: summary(),
      entries: [goalStateEntry('Old session goal', { workItems: [{ id: 'a', title: 'A', state: 'todo', dependsOn: [] }] })],
    }, transport, '/tmp/root/task')
    expect(registry.list()[0]?.goal).toMatchObject({ total: 1 })

    registry.applySnapshot({
      type: 'snapshot', processInstanceId: 'process-a', revision: 2, sequence: 0,
      summary: summary({ sessionId: 'session-b' }), entries: [],
    }, transport, '/tmp/root/task')

    expect(registry.list()[0]?.sessionId).toBe('session-b')
    expect(registry.list()[0]?.goal).toBeUndefined()
    expect(registry.get('process-a')?.goal).toBeUndefined()
  })
})