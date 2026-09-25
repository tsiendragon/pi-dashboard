import { describe, expect, it } from 'vitest'
import type { LiveSessionDetail, LiveSessionEventMessage, LiveSessionSummary } from '@shared/live-sessions'
import reducer, {
  liveSessionEvent,
  liveSessionOwned,
  liveSessionReleased,
  liveSessionSnapshot,
  liveSessionUserMessageAdded,
  liveSessionUserMessageAcknowledged,
  liveSessionUserMessageRemoved,
  sessionsLoaded,
} from '../store/liveSessionsSlice'

function summary(processInstanceId: string, revision = 1, sequence = 0): LiveSessionSummary {
  return {
    processInstanceId,
    sessionId: `session-${processInstanceId}`,
    pid: processInstanceId === 'a' ? 1 : 2,
    cwd: '/mnt/workspace/lilong/repos/worktree/task',
    canonicalCwd: '/mnt/workspace/lilong/repos/worktree/task',
    mode: 'tui', status: 'idle', claim: { state: 'unclaimed' },
    startedAt: processInstanceId === 'a' ? 1 : 2, lastActivityAt: revision, revision, eventSequence: sequence,
  }
}

function detail(value: LiveSessionSummary, entries: unknown[] = []): LiveSessionDetail {
  return { summary: value, entries }
}

function event(processInstanceId: string, sequence: number, type = 'agent_start'): LiveSessionEventMessage {
  return { type: 'event', processInstanceId, sequence, event: { type, data: {} } }
}

function uiEvent(processInstanceId: string, sequence: number, type: 'extension_ui' | 'extension_ui_closed', data: unknown): LiveSessionEventMessage {
  return { type: 'event', processInstanceId, sequence, event: { type, data } }
}

describe('liveSessionsSlice', () => {
  it('restores an unanswered dialog from a snapshot (page switch / reconnect)', () => {
    const request = { id: 'ui-1', method: 'select' as const, title: '选择目标', options: ['x', 'y'] }
    let state = reducer(undefined, sessionsLoaded({ sessions: [summary('a')] }))
    state = reducer(state, liveSessionSnapshot({ ...detail(summary('a')), pendingUi: [request] }))
    expect(state.pendingUi.a).toEqual({ 'ui-1': request })

    // Snapshot is authoritative: a dialog answered elsewhere disappears again.
    state = reducer(state, liveSessionSnapshot({ ...detail(summary('a', 2, 1)), pendingUi: [] }))
    expect(state.pendingUi.a).toEqual({})
  })

  it('tracks dialog open/close events and drops them on detach', () => {
    let state = reducer(undefined, sessionsLoaded({ sessions: [summary('a')] }))
    state = reducer(state, liveSessionSnapshot(detail(summary('a'))))
    state = reducer(state, liveSessionEvent(uiEvent('a', 1, 'extension_ui', { id: 'ui-9', method: 'confirm', title: '继续？' })))
    expect(state.pendingUi.a).toEqual({ 'ui-9': { id: 'ui-9', method: 'confirm', title: '继续？' } })

    state = reducer(state, liveSessionEvent(uiEvent('a', 2, 'extension_ui_closed', { id: 'ui-9' })))
    expect(state.pendingUi.a).toEqual({})
  })

  it('binds a message_entry carrier to the message it belongs to, and hides the carrier', () => {
    let state = reducer(undefined, sessionsLoaded({ sessions: [summary('a', 1, 1)] }))
    state = reducer(state, liveSessionSnapshot(detail(summary('a', 1, 1))))
    state = reducer(state, liveSessionEvent({
      type: 'event', processInstanceId: 'a', sequence: 2,
      event: { type: 'message_end', data: { message: { role: 'user', content: 'fork me' } } },
    }))
    state = reducer(state, liveSessionEvent({
      type: 'event', processInstanceId: 'a', sequence: 3,
      event: { type: 'message_entry', data: { entryId: 'entry-7' } },
    }))
    expect(state.details.a.entries).toEqual([
      expect.objectContaining({ type: 'message_end', data: expect.objectContaining({ entryId: 'entry-7' }) }),
    ])
  })

  it('keeps every process in one cwd and accepts independent snapshots', () => {
    let state = reducer(undefined, sessionsLoaded({ sessions: [summary('a'), summary('b')] }))
    expect(Object.keys(state.sessions)).toEqual(['a', 'b'])
    state = reducer(state, liveSessionSnapshot(detail(summary('a', 3), [{ type: 'fresh' }])))
    expect(state.sessions.a).toBeDefined()
    expect(state.sessions.b).toBeDefined()
    expect(state.details.a.entries).toEqual([{ type: 'fresh' }])
  })

  it('normalizes a raw snapshot with many streaming updates to one final message', () => {
    const value = summary('a', 2, 3)
    const entries = [
      { type: 'message_update', data: { message: { role: 'assistant', content: 'a' } } },
      { type: 'message_update', data: { message: { role: 'assistant', content: 'ab' } } },
      { type: 'message_end', data: { message: { role: 'assistant', content: 'done' } } },
    ]
    const state = reducer(undefined, liveSessionSnapshot(detail(value, entries)))
    expect(state.details.a.entries).toEqual([expect.objectContaining({ type: 'message_end' })])
  })

  it('applies contiguous events and requests resync for a sequence gap', () => {
    let state = reducer(undefined, sessionsLoaded({ sessions: [summary('a', 1, 4)] }))
    state = reducer(state, liveSessionSnapshot(detail(summary('a', 2, 4))))
    state = reducer(state, liveSessionEvent(event('a', 5)))
    expect(state.details.a.summary.eventSequence).toBe(5)
    expect(state.details.a.needsResync).toBeUndefined()
    state = reducer(state, liveSessionEvent(event('a', 7)))
    expect(state.details.a.summary.eventSequence).toBe(5)
    expect(state.details.a.needsResync).toBe(true)
  })

  it('heals a missed event from a resync snapshot that only advances eventSequence', () => {
    // The scenario that used to freeze a transcript forever: the browser missed
    // a frame (WS drop / reconnect), and the recovery GET returns the registry
    // state whose `revision` equals the copy we already hold because the session
    // has not pushed a fresh snapshot since.
    let state = reducer(undefined, sessionsLoaded({ sessions: [summary('a', 5, 100)] }))
    state = reducer(state, liveSessionSnapshot(detail(summary('a', 5, 100), [{ type: 'm1' }])))
    state = reducer(state, liveSessionEvent(event('a', 102)))
    expect(state.details.a.needsResync).toBe(true)

    state = reducer(state, liveSessionSnapshot(detail(summary('a', 5, 102), [{ type: 'm1' }, { type: 'm2' }])))
    expect(state.details.a.needsResync).toBeUndefined()
    expect(state.details.a.summary.eventSequence).toBe(102)
    expect(state.details.a.entries).toHaveLength(2)

    // Events flow again after the heal.
    state = reducer(state, liveSessionEvent(event('a', 103)))
    expect(state.details.a.summary.eventSequence).toBe(103)
    expect(state.details.a.entries).toHaveLength(3)
  })

  it('still ignores snapshots that are not newer than the local copy', () => {
    const state = reducer(undefined, liveSessionSnapshot(detail(summary('a', 5, 100), [{ type: 'm1' }])))
    const same = reducer(state, liveSessionSnapshot(detail(summary('a', 5, 100), [{ type: 'older' }])))
    expect(same.details.a.entries).toEqual([{ type: 'm1' }])
    const older = reducer(state, liveSessionSnapshot(detail(summary('a', 4, 99), [{ type: 'older' }])))
    expect(older.details.a.entries).toEqual([{ type: 'm1' }])
  })

  it('shows Dashboard user input immediately, rolls it back, and deduplicates Pi echoes', () => {
    let state = reducer(undefined, sessionsLoaded({ sessions: [summary('a')] }))
    state = reducer(state, liveSessionSnapshot(detail(summary('a', 2))))
    state = reducer(state, liveSessionUserMessageAdded({ processInstanceId: 'a', localId: 'local-1', text: 'hello' }))
    expect(state.details.a.entries).toEqual([expect.objectContaining({
      dashboardLocalId: 'local-1', message: { role: 'user', content: 'hello' },
    })])

    state = reducer(state, liveSessionEvent({
      type: 'event', processInstanceId: 'a', sequence: 1,
      event: { type: 'message_end', data: { message: { role: 'user', content: 'hello' } } },
    }))
    expect(state.details.a.entries).toEqual([expect.objectContaining({ type: 'message_end' })])

    state = reducer(state, liveSessionUserMessageAdded({ processInstanceId: 'a', localId: 'local-2', text: 'retry' }))
    state = reducer(state, liveSessionUserMessageRemoved({ processInstanceId: 'a', localId: 'local-2' }))
    expect(state.details.a.entries).toHaveLength(1)
  })

  it('marks a queued prompt as sending, then accepted-and-queued until Pi echoes it', () => {
    let state = reducer(undefined, sessionsLoaded({ sessions: [summary('a')] }))
    state = reducer(state, liveSessionSnapshot(detail(summary('a', 2))))
    state = reducer(state, liveSessionUserMessageAdded({
      processInstanceId: 'a', localId: 'local-q', text: 'then run the tests', deliverAs: 'followUp',
    }))
    expect(state.details.a.entries[0]).toMatchObject({ dashboardDeliverAs: 'followUp', dashboardQueueState: 'sending' })

    // The bridge accepted the input: it is queued inside Pi, not handled yet.
    state = reducer(state, liveSessionUserMessageAcknowledged({ processInstanceId: 'a', localId: 'local-q' }))
    expect(state.details.a.entries[0]).toMatchObject({ dashboardQueueState: 'queued' })

    // Pi echoing the message is what ends the pending state.
    state = reducer(state, liveSessionEvent({
      type: 'event', processInstanceId: 'a', sequence: 1,
      event: { type: 'message_end', data: { message: { role: 'user', content: 'then run the tests' } } },
    }))
    expect(state.details.a.entries.some(entry => (entry as Record<string, unknown>).dashboardLocalId === 'local-q')).toBe(false)

    // A plain prompt sent while idle carries no queue state at all.
    state = reducer(state, liveSessionUserMessageAdded({ processInstanceId: 'a', localId: 'local-3', text: 'plain' }))
    expect(state.details.a.entries.at(-1)).toMatchObject({ dashboardLocalId: 'local-3' })
    expect((state.details.a.entries.at(-1) as Record<string, unknown>).dashboardQueueState).toBeUndefined()
  })

  it('tracks only leases acquired by this browser and clears them on release', () => {
    let state = reducer(undefined, sessionsLoaded({ sessions: [summary('a')] }))
    state = reducer(state, liveSessionOwned({ processInstanceId: 'a', leaseId: 'lease-a', expiresAt: 10 }))
    expect(state.ownedLeases.a).toBe('lease-a')
    expect(state.sessions.a.claim).toEqual({ state: 'claimed', leaseId: 'lease-a', expiresAt: 10 })
    state = reducer(state, liveSessionReleased('a'))
    expect(state.ownedLeases.a).toBeUndefined()
    expect(state.sessions.a.claim).toEqual({ state: 'unclaimed' })
  })
})
