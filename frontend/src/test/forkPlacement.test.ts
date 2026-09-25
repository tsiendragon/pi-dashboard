import { describe, expect, it, vi, afterEach } from 'vitest'
import type { LiveSessionGroup, LiveSessionSummary } from '@shared/live-sessions'
import { forkLiveSessionAtStep, placeForkBesideParent } from '../features/live-sessions/forkPlacement'

function session(sessionId: string, startedAt: number, over: Partial<LiveSessionSummary> = {}): LiveSessionSummary {
  return {
    processInstanceId: `pid-${sessionId}`,
    sessionId,
    pid: startedAt,
    cwd: '/tmp/app',
    canonicalCwd: '/tmp/app',
    mode: 'tui',
    status: 'idle',
    claim: { state: 'unclaimed' },
    startedAt,
    lastActivityAt: startedAt,
    revision: 1,
    eventSequence: 0,
    ...over,
  }
}

/** Route-mocked fetch for the stores the placement writes to, plus the fork call. */
function mockStores(input: {
  groups?: LiveSessionGroup[]
  order?: string[]
  fork?: { processInstanceId?: string; sessionId?: string }
} = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const groups = input.groups || []
  let order = input.order || []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload })
    if (url === '/api/live-session-groups' && method === 'GET') return ok({ groups })
    if (url === '/api/live-session-meta' && method === 'GET') return ok({ meta: {} })
    if (url === '/api/live-session-order' && method === 'GET') return ok({ order })
    if (url === '/api/live-session-order' && method === 'PUT') {
      order = Array.isArray(body?.order) ? body.order as string[] : []
      return ok({ ok: true, order })
    }
    if (method === 'POST' && /^\/api\/live-sessions\/[^/]+\/fork$/.test(url)) {
      return ok({ ok: true, result: { ...(input.fork ?? { processInstanceId: 'fork-pid', sessionId: 'fork' }) } })
    }
    if (url.endsWith('/members') && method === 'POST') return ok({ ok: true, groups })
    return ok({})
  }))
  return { calls, order: () => order }
}

describe('placeForkBesideParent', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('joins the parent task group and lands directly behind it', async () => {
    const groups: LiveSessionGroup[] = [{ id: 'g1', name: '任务A', sessionIds: ['parent'], createdAt: '', updatedAt: '' }]
    const { calls, order } = mockStores({ groups })
    const parent = session('parent', 1)

    await placeForkBesideParent({
      parent,
      forkedProcessInstanceId: 'fork-pid',
      forkedSessionId: 'fork',
      sessions: [session('other', 2), parent],
    })

    expect(calls.some(call => call.url === '/api/live-session-groups/g1/members' && call.method === 'POST' && (call.body as { processInstanceId?: string }).processInstanceId === 'fork-pid')).toBe(true)
    // the parent is grouped, so the fork is inserted after it inside that block
    expect(order()).toEqual(['parent', 'fork', 'other'])
  })

  it('leaves the fork ungrouped when its parent has no task group, still behind it', async () => {
    const { calls, order } = mockStores()
    const parent = session('parent', 2)

    await placeForkBesideParent({
      parent,
      forkedProcessInstanceId: 'fork-pid',
      forkedSessionId: 'fork',
      sessions: [session('older', 1), parent],
    })

    expect(calls.some(call => call.url.endsWith('/members'))).toBe(false)
    expect(order()).toEqual(['older', 'parent', 'fork'])
  })
})

describe('forkLiveSessionAtStep', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('forks at the entry, then lands the new session beside its source', async () => {
    const groups: LiveSessionGroup[] = [{ id: 'g1', name: '任务A', sessionIds: ['parent'], createdAt: '', updatedAt: '' }]
    const { calls, order } = mockStores({ groups, fork: { processInstanceId: 'fork-pid', sessionId: 'fork' } })
    const source = session('parent', 1)

    const forked = await forkLiveSessionAtStep({
      source,
      entryId: 'entry-5',
      sessions: [session('other', 2), source],
    })

    expect(forked).toEqual({ processInstanceId: 'fork-pid', sessionId: 'fork' })
    expect(calls.some(call => call.url === '/api/live-sessions/pid-parent/fork' && call.method === 'POST' && (call.body as { entryId?: string }).entryId === 'entry-5')).toBe(true)
    expect(calls.some(call => call.url === '/api/live-session-groups/g1/members' && (call.body as { processInstanceId?: string }).processInstanceId === 'fork-pid')).toBe(true)
    expect(order()).toEqual(['parent', 'fork', 'other'])
  })

  it('fails loudly and does not touch the stores when the launcher returns no session identity', async () => {
    const { calls } = mockStores({ fork: { processInstanceId: undefined, sessionId: undefined } })

    await expect(forkLiveSessionAtStep({
      source: session('parent', 1),
      entryId: 'entry-5',
      sessions: [session('parent', 1)],
    })).rejects.toThrow('没有拿到会话标识')

    expect(calls.some(call => call.url === '/api/live-session-order' && call.method === 'PUT')).toBe(false)
  })
})