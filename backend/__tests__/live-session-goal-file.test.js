import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { LiveSessionRegistry } from '../live-sessions/registry.js'
import { SessionGoalFileTracker } from '../live-sessions/session-goal-tracker.js'

const cleanups = []
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
})

async function tempFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-goal-file-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return path.join(dir, 'session.jsonl')
}

function goalStateLine({ state, action = 'create', ts = 1_000 }) {
  return `${JSON.stringify({ type: 'custom', customType: 'goal-state', action, timestamp: ts, data: { action, state } })}\n`
}

function goalState({ status = 'active', items, objective = 'Ship the thing', ts = 1_000 }) {
  return { goalId: 'goal-1', objective, status, acceptanceCriteria: ['it works'], workItems: items ?? [], updatedAt: ts }
}

function messageLine(role = 'user') {
  return `${JSON.stringify({ type: 'message', timestamp: 1_001, message: { role, content: 'hi' } })}\n`
}

function summary(overrides = {}) {
  return {
    processInstanceId: 'process-a', sessionId: 'session-a', pid: 4242,
    cwd: '/tmp/root/task', canonicalCwd: '/tmp/root/task', mode: 'tui',
    status: 'idle', claim: { state: 'unclaimed' }, startedAt: 1,
    lastActivityAt: 2, revision: 1, eventSequence: 0,
    ...overrides,
  }
}

function hello(overrides = {}) {
  return {
    type: 'hello', protocolVersion: 2, brokerToken: 'token',
    processInstanceId: 'process-a', pid: 4242, cwd: '/tmp/root/task',
    mode: 'tui', sessionId: 'session-a', ...overrides,
  }
}

describe('SessionGoalFileTracker', () => {
  it('reads the newest goal state and counts messages since it', async () => {
    const file = await tempFile()
    await writeFile(file, goalStateLine({ state: goalState({ items: [{ id: 'a', title: 'a', state: 'todo' }] }) }))
    await appendFile(file, messageLine())
    await appendFile(file, messageLine('assistant'))

    const tracker = new SessionGoalFileTracker()
    const scan = await tracker.refresh(file)
    expect(scan?.goal).toMatchObject({ objective: 'Ship the thing', status: 'active', messagesSinceUpdate: 2 })
    expect(scan?.updatedAt).toBe(1_000)

    // Appending only advances the message counter until a new goal-state lands.
    await appendFile(file, messageLine())
    const next = await tracker.refresh(file)
    expect(next?.goal).toMatchObject({ messagesSinceUpdate: 3 })

    await appendFile(file, goalStateLine({
      action: 'progress',
      ts: 2_000,
      state: goalState({ items: [{ id: 'a', title: 'a', state: 'done' }], ts: 2_000 }),
    }))
    const updated = await tracker.refresh(file)
    expect(updated?.updatedAt).toBe(2_000)
    expect(updated?.goal).toMatchObject({ messagesSinceUpdate: 0 })
    expect(updated?.goal?.workItems).toMatchObject([{ id: 'a', state: 'done' }])
  })

  it('reports a cleared goal and keeps a half-written line pending', async () => {
    const file = await tempFile()
    const line = goalStateLine({ ts: 3_000, state: goalState({ ts: 3_000 }) })
    const half = line.slice(0, Math.floor(line.length / 2))
    await writeFile(file, goalStateLine({ ts: 2_000, state: goalState({ ts: 2_000 }) }))

    const tracker = new SessionGoalFileTracker()
    await appendFile(file, half)
    // The truncated tail must not be parsed as a complete entry.
    const mid = await tracker.refresh(file)
    expect(mid?.updatedAt).toBe(2_000)

    await appendFile(file, line.slice(half.length))
    const complete = await tracker.refresh(file)
    expect(complete?.updatedAt).toBe(3_000)

    await appendFile(file, goalStateLine({ action: 'clear', ts: 4_000, state: null }))
    const cleared = await tracker.refresh(file)
    expect(cleared).toMatchObject({ goal: null, updatedAt: 4_000 })
  })

  it('re-seeds from a tail window after truncation and boundaries', async () => {
    const file = await tempFile()
    const stale = goalStateLine({ ts: 1_000, state: goalState({ objective: 'Old goal', ts: 1_000 }) })
    const fresh = goalStateLine({ ts: 5_000, state: goalState({ objective: 'New goal', ts: 5_000 }) })
    await writeFile(file, stale + fresh)

    const tracker = new SessionGoalFileTracker({ tailBytes: fresh.length })
    const scan = await tracker.refresh(file)
    // The window starts mid-line; only the boundary decision keeps the new goal.
    expect(scan?.goal?.objective).toBe('New goal')

    // Truncation (file replaced) must not trust the old offset.
    await writeFile(file, stale)
    const reseeded = await tracker.refresh(file)
    expect(reseeded?.goal?.objective).toBe('Old goal')

    tracker.retain(new Set())
    expect(await tracker.refresh(file)).toMatchObject({ goal: { objective: 'Old goal' } })
  })
})

describe('LiveSessionRegistry goal file sync', () => {
  async function harness(entries, options = {}) {
    const file = await tempFile()
    await writeFile(file, entries)
    const registry = new LiveSessionRegistry({ commandTimeoutMs: 1_000, goalFileSyncIntervalMs: 0 })
    cleanups.push(() => registry.stop())
    const transport = { send() {} }
    registry.connect(hello(), '/tmp/root/task', transport)
    registry.applySnapshot({
      type: 'snapshot', processInstanceId: 'process-a', revision: 1, sequence: 0,
      summary: summary({ sessionFile: file }), entries: [],
    }, transport, '/tmp/root/task')
    const events = []
    registry.on('goal_changed', payload => events.push(payload))
    return { registry, transport, file, events }
  }

  it('surfaces a goal the snapshot stream never carried and follows edits', async () => {
    const { registry, events, file } = await harness(goalStateLine({
      state: goalState({ items: [{ id: 'a', title: 'a', state: 'todo' }, { id: 'b', title: 'b', state: 'todo' }] }),
    }))
    expect(registry.list()[0].goal).toBeUndefined()

    await registry.refreshGoalsFromFiles()
    expect(registry.list()[0].goal).toMatchObject({ done: 0, total: 2, status: 'active', stale: false })
    expect(registry.get('process-a').goal).toMatchObject({ objective: 'Ship the thing' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ processInstanceId: 'process-a', goal: { total: 2 } })

    // Nothing new: no second broadcast.
    await registry.refreshGoalsFromFiles()
    expect(events).toHaveLength(1)

    await appendFile(file, goalStateLine({
      action: 'progress',
      ts: 2_000,
      state: goalState({ ts: 2_000, items: [{ id: 'a', title: 'a', state: 'done' }, { id: 'b', title: 'b', state: 'todo' }] }),
    }))
    await registry.refreshGoalsFromFiles()
    expect(registry.list()[0].goal).toMatchObject({ done: 1, total: 2 })
    expect(events).toHaveLength(2)
  })

  it('keeps the file-scanned goal when a stale snapshot arrives afterwards', async () => {
    const { registry, transport, events } = await harness(goalStateLine({ ts: 3_000, state: goalState({ ts: 3_000 }) }))
    await registry.refreshGoalsFromFiles()
    expect(registry.list()[0].goal).toMatchObject({ status: 'active' })
    expect(events).toHaveLength(1)

    // A newer snapshot whose entries still carry an older goal-state window.
    registry.applySnapshot({
      type: 'snapshot', processInstanceId: 'process-a', revision: 2, sequence: 0,
      summary: summary({ sessionFile: registry.list()[0].sessionFile }),
      entries: [{ type: 'custom', customType: 'goal-state', timestamp: 1_000, data: { action: 'pause', state: { goalId: 'goal-0', objective: 'Stale goal', status: 'paused', workItems: [] } } }],
    }, transport, '/tmp/root/task')

    expect(registry.list()[0].goal).toMatchObject({ status: 'active' })
    expect(registry.get('process-a').goal).toMatchObject({ objective: 'Ship the thing' })
  })

  it('clears the row when the newest file entry clears the goal', async () => {
    const { registry, events, file } = await harness(goalStateLine({ ts: 2_000, state: goalState({ ts: 2_000 }) }))
    await registry.refreshGoalsFromFiles()
    expect(registry.list()[0].goal).toBeDefined()

    await appendFile(file, goalStateLine({ action: 'clear', ts: 3_000, state: null }))
    await registry.refreshGoalsFromFiles()
    expect(registry.list()[0].goal).toBeUndefined()
    expect(registry.get('process-a').goal).toBeUndefined()
    expect(events.at(-1)).toMatchObject({ goal: null, anchor: null })
  })
})