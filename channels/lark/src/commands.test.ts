import { beforeEach, describe, expect, it } from 'vitest'
import type { LiveSessionModelOption, LiveSessionSummary } from '../../../shared/src/live-sessions.js'
import { handleCommand, resetCommandState, type CommandContext } from './commands.js'
import type { Catalog } from './catalog.js'
import { DashboardRequestError, type DashboardClient } from './dashboardClient.js'
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
    lookup: () => undefined,
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

const MODELS: LiveSessionModelOption[] = [
  { provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet', reasoning: true, contextWindow: 200_000, thinkingLevels: ['low', 'high'] },
  { provider: 'openai-codex', id: 'gpt-6-luna', name: 'GPT-6 Luna', reasoning: true, contextWindow: 400_000, thinkingLevels: ['low', 'high'] },
  { provider: 'openai-codex', id: 'gpt-6-luna-mini', name: 'GPT-6 Luna Mini', reasoning: false, contextWindow: 128_000, thinkingLevels: [] },
]

interface FakeCall {
  type: string
  payload: Record<string, unknown>
}

/** A gateway context bound to one live session, with a scripted dashboard. */
function sessionContext(options: { models?: LiveSessionModelOption[]; failClaim?: unknown; failCommand?: unknown } = {}) {
  const summary = makeSession()
  const binding = {
    platform: 'lark',
    chatId: 'chat-1',
    threadId: null,
    sessionFile: summary.sessionFile!,
    sessionName: summary.sessionName,
    boundAt: '2026-10-18T00:00:00.000Z',
  }
  const calls: FakeCall[] = []
  const claims: string[] = []
  const releases: string[] = []
  const notices: string[] = []
  const forwards: string[] = []
  const catalog = {
    list: () => [summary],
    replace: () => {},
    resolve: () => summary,
    resolveBinding: (file: string) => (file === summary.sessionFile ? summary : undefined),
  } as unknown as Catalog
  const mapping = {
    lookup: () => binding,
    lookupsBySession: () => [binding],
    bind: async () => binding,
    unbind: async () => true,
  } as unknown as Mapping
  let leaseSeq = 0
  const dashboard = {
    listSessions: async () => [summary],
    startSession: async () => ({ sessionId: 'session-new' }),
    models: async () => options.models ?? MODELS,
    claim: async () => {
      if (options.failClaim) throw options.failClaim
      leaseSeq += 1
      const leaseId = `lease-${leaseSeq}`
      claims.push(leaseId)
      return { leaseId }
    },
    release: async (_processInstanceId: string, leaseId: string) => { releases.push(leaseId) },
    command: async (_processInstanceId: string, command: unknown) => {
      if (options.failCommand) throw options.failCommand
      const payload = command as Record<string, unknown>
      calls.push({ type: String(payload.type), payload })
      if (payload.type === 'get_context') {
        return {
          source: 'provider_request',
          format: 'anthropic-messages',
          model: { provider: 'anthropic', id: 'claude-sonnet' },
          totals: { tokens: 12345 },
          contextUsage: { percent: 42.8, contextWindow: 87_600 },
        }
      }
      return {}
    },
  } as unknown as DashboardClient
  const ctx: CommandContext = {
    chatId: 'chat-1',
    threadId: null,
    catalog,
    mapping,
    dashboard,
    notify: async (text: string) => { notices.push(text) },
    forward: async (text: string) => { forwards.push(text) },
  }
  return { ctx, calls, claims, releases, notices, forwards }
}

describe('Lark session commands', () => {
  beforeEach(() => {
    resetCommandState()
  })

  it('/model lists numbered models and marks the current one', async () => {
    const { ctx } = sessionContext()
    const reply = await handleCommand('/model', ctx)

    expect(reply).toContain('当前模型：anthropic/claude-sonnet')
    expect(reply).toContain('1. anthropic/claude-sonnet（Claude Sonnet） ← 当前')
    expect(reply).toContain('2. openai-codex/gpt-6-luna（GPT-6 Luna）')
  })

  it('/model <序号> switches using the list it just printed', async () => {
    const { ctx, calls } = sessionContext()
    await handleCommand('/model', ctx)
    const reply = await handleCommand('/model 2', ctx)

    expect(reply).toContain('已切换模型：openai-codex/gpt-6-luna')
    expect(calls).toEqual([
      { type: 'set_model', payload: { type: 'set_model', provider: 'openai-codex', modelId: 'gpt-6-luna' } },
    ])
  })

  it('/model provider/id and a unique name fragment both switch', async () => {
    const direct = sessionContext()
    await handleCommand('/model anthropic/claude-sonnet', direct.ctx)
    expect(direct.calls[0]?.payload).toMatchObject({ type: 'set_model', provider: 'anthropic', modelId: 'claude-sonnet' })

    const fuzzy = sessionContext()
    const reply = await handleCommand('/model sonnet', fuzzy.ctx)
    expect(reply).toContain('已切换模型：anthropic/claude-sonnet')
  })

  it('/model refuses an ambiguous fragment and lists the candidates', async () => {
    const { ctx, calls } = sessionContext()
    const reply = await handleCommand('/model luna', ctx)

    expect(reply).toContain('匹配到 2 个模型')
    expect(reply).toContain('openai-codex/gpt-6-luna-mini')
    expect(calls).toEqual([])
  })

  it('/compact takes the lease, compacts and hands the lease straight back', async () => {
    const { ctx, calls, claims, releases, notices } = sessionContext()
    const reply = await handleCommand('/compact', ctx)

    expect(notices[0]).toContain('正在压缩')
    expect(claims).toEqual(['lease-1'])
    expect(calls).toEqual([{ type: 'compact', payload: { type: 'compact', leaseId: 'lease-1' } }])
    expect(releases).toEqual(['lease-1'])
    expect(reply).toContain('上下文压缩完成')
  })

  it('/compact explains a session already held by the web UI instead of failing', async () => {
    const { ctx, calls, releases } = sessionContext({
      failClaim: new DashboardRequestError(423, 'session_already_claimed', 'claim_failed: 423 refused'),
    })
    const reply = await handleCommand('/compact', ctx)

    expect(reply).toContain('网页端接管')
    expect(calls).toEqual([])
    expect(releases).toEqual([])
  })

  it('/abort releases the lease even when the command fails', async () => {
    const { ctx, releases } = sessionContext({ failCommand: new Error('command_failed: 504 timed out') })
    await expect(handleCommand('/abort', ctx)).rejects.toThrow('504')
    expect(releases).toEqual(['lease-1'])
  })

  it('/reload, /name and /context map onto structured commands', async () => {
    const reloadRun = sessionContext()
    await handleCommand('/reload', reloadRun.ctx)
    expect(reloadRun.calls.map(call => call.type)).toEqual(['reload'])

    const renameRun = sessionContext()
    const renamed = await handleCommand('/name 新的会话名', renameRun.ctx)
    expect(renameRun.calls[0]?.payload).toMatchObject({ type: 'set_session_name', name: '新的会话名' })
    expect(renamed).toContain('新的会话名')

    const contextRun = sessionContext()
    const usage = await handleCommand('/context', contextRun.ctx)
    expect(usage).toContain('12,345')
    expect(usage).toContain('42.8%')
  })

  it('/shutdown refuses without confirm and closes with it', async () => {
    const guarded = sessionContext()
    const refusal = await handleCommand('/shutdown', guarded.ctx)
    expect(refusal).toContain('/shutdown confirm')
    expect(guarded.calls).toEqual([])

    const confirmed = sessionContext()
    await handleCommand('/shutdown confirm', confirmed.ctx)
    expect(confirmed.calls.map(call => call.type)).toEqual(['shutdown'])
  })

  it('/effort needs a level and forwards the rest as an extension command', async () => {
    const bare = sessionContext()
    expect(await handleCommand('/effort', bare.ctx)).toContain('用法：/effort')
    expect(bare.forwards).toEqual([])

    const withLevel = sessionContext()
    expect(await handleCommand('/effort high', withLevel.ctx)).toBe('已下发 /effort high')
    expect(withLevel.forwards).toEqual(['/effort high'])
  })

  it('lets pi/extension commands through to the session instead of answering "unknown command"', async () => {
    const { ctx, calls } = sessionContext()
    expect(await handleCommand('/clear', ctx)).toBeNull()
    expect(await handleCommand('/goal 修完 lark 通道', ctx)).toBeNull()
    expect(calls).toEqual([])
  })
})
