import { describe, expect, it } from 'vitest'
import type { LiveSessionSummary } from '@shared/live-sessions'
import {
  DETACH_GRACE_MS,
  cancelDetach,
  expireDetaches,
  pendingSummaries,
  scheduleDetach,
  type PendingDetach,
} from '../features/live-sessions/detachGrace'
import reducer, { liveSessionDetached, liveSessionReconnecting, sessionsLoaded } from '../store/liveSessionsSlice'

function summary(processInstanceId = 'a', over: Partial<LiveSessionSummary> = {}): LiveSessionSummary {
  return {
    processInstanceId,
    sessionId: `session-${processInstanceId}`,
    pid: 101,
    cwd: '~/repos/worktree/task-a',
    canonicalCwd: '~/repos/worktree/task-a',
    mode: 'tui',
    status: 'idle',
    claim: { state: 'unclaimed' },
    startedAt: 1,
    lastActivityAt: 1,
    revision: 1,
    eventSequence: 0,
    ...over,
  }
}

describe('detachGrace', () => {
  it('keeps a detached session in the next list payload', () => {
    const pending = new Map<string, PendingDetach>()
    const now = 1_000
    scheduleDetach(pending, summary('a'), now)
    expect(pendingSummaries(pending, now + 1, []).map(entry => entry.processInstanceId)).toEqual(['a'])
  })

  it('lets the server payload win once the session is reported again', () => {
    const pending = new Map<string, PendingDetach>()
    const now = 1_000
    scheduleDetach(pending, summary('a'), now)
    expect(pendingSummaries(pending, now + 1, ['a'])).toEqual([])
  })

  it('stops keeping the row once the grace window has closed', () => {
    const pending = new Map<string, PendingDetach>()
    const now = 1_000
    scheduleDetach(pending, summary('a'), now)
    expect(pendingSummaries(pending, now + DETACH_GRACE_MS - 1, [])).toHaveLength(1)
    expect(pendingSummaries(pending, now + DETACH_GRACE_MS + 1, [])).toHaveLength(0)
    expect(expireDetaches(pending, now + DETACH_GRACE_MS + 1).map(entry => entry.summary.processInstanceId)).toEqual(['a'])
    expect(pending.size).toBe(0)
    expect(expireDetaches(pending, now + DETACH_GRACE_MS + 1)).toEqual([])
  })

  it('forgets a detach as soon as the session reconnects', () => {
    const pending = new Map<string, PendingDetach>()
    scheduleDetach(pending, summary('b'), 1_000)
    cancelDetach(pending, 'b')
    expect(pendingSummaries(pending, 1_100, [])).toEqual([])
  })

  it('honours a custom window and carries the reason through', () => {
    const pending = new Map<string, PendingDetach>()
    scheduleDetach(pending, summary('c'), 1_000, 'connection_closed', 5_000)
    const [entry] = expireDetaches(pending, 6_000)
    expect(entry.reason).toBe('connection_closed')
  })
})

describe('live session detach grace in the store', () => {
  it('keeps the row through a list sweep and drops it when the window closes', () => {
    let state = reducer(undefined, sessionsLoaded({ sessions: [summary('a')] }))
    state = reducer(state, liveSessionReconnecting(summary('a')))
    expect(state.sessions.a?.status).toBe('reconnecting')

    // The registry already dropped the entry, so a refresh no longer reports it.
    const pending = new Map<string, PendingDetach>()
    const now = 2_000
    scheduleDetach(pending, summary('a'), now)
    state = reducer(state, sessionsLoaded({ sessions: pendingSummaries(pending, now + 100, []) }))
    expect(state.sessions.a?.processInstanceId).toBe('a')

    const [expired] = expireDetaches(pending, now + DETACH_GRACE_MS + 1)
    state = reducer(state, liveSessionDetached({ summary: expired.summary, ...(expired.reason ? { reason: expired.reason } : {}) }))
    expect(state.sessions.a).toBeUndefined()
  })
})