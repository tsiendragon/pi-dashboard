import { describe, expect, it } from 'vitest'
import type { LiveSessionDetail, LiveSessionEventMessage, LiveSessionSummary } from '@shared/live-sessions'
import reducer, {
  liveSessionEvent,
  liveSessionOwned,
  liveSessionReleased,
  liveSessionSnapshot,
  liveSessionUserMessageAdded,
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

describe('liveSessionsSlice', () => {
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
