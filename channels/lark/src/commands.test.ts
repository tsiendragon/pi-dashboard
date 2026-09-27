import { describe, expect, it } from 'vitest'
import type { LiveSessionSummary } from '../../../shared/src/live-sessions.js'
import { handleCommand } from './commands.js'
import type { Catalog } from './catalog.js'
import type { DashboardClient } from './dashboardClient.js'
import type { Mapping } from './mapping.js'

function makeSession(overrides: Partial<LiveSessionSummary> = {}): LiveSessionSummary {
  return {
    processInstanceId: 'process-123456',
    sessionId: 'session-123456',
    sessionFile: '/home/user/.pi/agent/sessions/session-123456.jsonl',
    sessionName: '修复 Lark 会话列表',
    pid: 1234,
    cwd: '/home/user/apps/pi-dashboard',
    canonicalCwd: '/home/user/apps/pi-dashboard',
    mode: 'rpc',
    model: { provider: 'anthropic', id: 'claude-sonnet' },
    status: 'idle',
    claim: { state: 'unclaimed' },
    startedAt: 1,
    lastActivityAt: 2,
    revision: 1,
    eventSequence: 1,
    git: { branch: 'feature/lark-list' },
    ...overrides,
  }
}

function context(sessions: LiveSessionSummary[], cachedSessions = sessions) {
  let currentSessions = cachedSessions
  const catalog = {
    list: () => currentSessions,
    replace: (next: LiveSessionSummary[]) => { currentSessions = next },
  } as unknown as Catalog
  const mapping = {
    lookupByChat: () => undefined,
    lookupsBySession: () => [],
  } as unknown as Mapping
  return {
    chatId: 'chat-1',
    threadId: null,
    catalog,
    mapping,
    dashboard: { listSessions: async () => sessions } as unknown as DashboardClient,
  }
}

describe('Lark /list command', () => {
  it('shows friendly session details and how to bind by index', async () => {
    const result = await handleCommand('/list', context([makeSession()]))

    expect(result).toContain('当前 dashboard 有 1 个在线会话')
    expect(result).toContain('「修复 Lark 会话列表」')
    expect(result).toContain('项目：pi-dashboard')
    expect(result).toContain('分支：feature/lark-list')
    expect(result).toContain('状态：空闲待命')
    expect(result).toContain('模型：claude-sonnet')
    expect(result).toContain('/bind <序号>')
  })

  it('includes every session returned by the live-session catalog', async () => {
    const sessions = [
      makeSession({ processInstanceId: 'p1', sessionName: '会话一' }),
      makeSession({ processInstanceId: 'p2', sessionName: '会话二' }),
      makeSession({ processInstanceId: 'p3', sessionName: '会话三' }),
      makeSession({ processInstanceId: 'p4', sessionName: '会话四' }),
    ]
    const result = await handleCommand('/list', context(sessions, []))

    expect(result).toContain('当前 dashboard 有 4 个在线会话')
    for (const name of ['会话一', '会话二', '会话三', '会话四']) expect(result).toContain(name)
  })

  it('uses the project directory as a readable fallback when no session name exists', async () => {
    const result = await handleCommand('/list', context([makeSession({ sessionName: undefined })]))

    expect(result).toContain('「pi-dashboard 项目会话」')
  })
})
