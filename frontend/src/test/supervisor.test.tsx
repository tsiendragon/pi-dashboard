import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { SupervisorConfig, SupervisorEvent, SupervisorState } from '../../../shared/src/supervisor'
import type { LiveSessionDetail } from '../../../shared/src/live-sessions'
import { renderWithProviders } from './helpers'
import { SupervisorAgentButton, SupervisorAgentProvider, SupervisorAgentSidebarButton, SupervisorNotificationsSidebarButton } from '../features/supervisor/SupervisorAgentProvider'
import { errorText, SupervisorApiError } from '../features/supervisor/api'
import SupervisorPage from '../pages/SupervisorPage'
import EventLedgerPage from '../pages/EventLedgerPage'
import TaskDetailPage from '../pages/tasks/TaskDetail'

vi.mock('../features/live-sessions/useLiveSessions', () => ({ useLiveSessionsRuntime: () => ({ refresh: vi.fn() }) }))
const config: SupervisorConfig = {
  enabled: true, cwd: '/work', pollIntervalMs: 10_000, staleAfterMs: 60_000,
  allowedObjects: ['journal:42'], allowedSessionIds: ['session-1'], allowedRoots: ['/work'],
  agentResources: { rolePath: '/work/role.md', skillPaths: ['/work/SKILL.md'], extensionPaths: ['/work/supervisor.ts'], allowedTools: ['supervisor_events'], mode: 'observe' },
}
const detail: LiveSessionDetail = {
  summary: { processInstanceId: 'process-1', sessionId: 'session-1', role: 'main', pid: 12, cwd: '/work', canonicalCwd: '/work', mode: 'tui', status: 'idle', claim: { state: 'unclaimed' }, startedAt: 1000, lastActivityAt: 2000, revision: 1, eventSequence: 1 },
  entries: [{ type: 'message', id: 'message-1', message: { role: 'assistant', content: [{ type: 'text', text: '**真实主管回复**' }] } }],
  pendingUi: [],
}
const event: SupervisorEvent = {
  id: 'event-1', objectRef: 'journal:42', title: '客户反馈已收到', type: 'feedback', description: '真实反馈内容', occurredAt: null, recordedAt: '2026-01-02T10:00:00Z', participants: ['客户', '工程师'], source: { kind: 'relay', sessionId: 'session-1', messageRef: 'message-7' }, originalReply: '原始回复', nextStep: '复核证据', attachmentIds: ['attachment-1'], version: 2, requestId: 'request-1', payloadHash: 'hash-1', revisions: [{ version: 1, at: '2026-01-02T09:00:00Z', actor: 'operator', previous: { title: '初始反馈' } }],
}
const state: SupervisorState = {
  enabled: true, mode: 'observe', agent: { sessionId: 'session-1', processInstanceId: 'process-1', connected: true, resourceState: 'loaded' },
  tasks: { tasks: [{ uid: 'journal:42', id: '42', providerId: 'journal', kind: 'task', title: '真实任务标题', completion: 'doing', archived: false, plannable: true, tags: [], writable: true, sourceLabel: '任务日志' }], planning: {}, providers: [], sessionRefs: {}, warnings: [], lanes: [], defaultView: 'execute' },
  sessions: [{ ...detail.summary, observation: 'unknown', evidence: '缺少最近采样' }], events: [event], actions: [], reports: [], warnings: ['仅覆盖授权对象'], sampledAt: '2026-01-02T10:00:00Z',
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let fetchMock: ReturnType<typeof vi.fn>
function installFetch(override?: (url: string, init?: RequestInit) => Response | undefined | Promise<Response>) {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const custom = override?.(url, init)
    if (custom) return await custom
    if (url.endsWith('/state')) return response(state)
    if (url.endsWith('/config')) return response(config)
    if (url.endsWith('/agent/detail')) return response(detail)
    if (url.endsWith('/agent/start')) return response({ processInstanceId: 'process-1', sessionId: 'session-1' })
    if (url.endsWith('/agent/input')) return response({ ok: true })
    if (url.endsWith('/attachments')) return response({ attachment: { id: 'attachment-1', name: 'capture.png', mime: 'image/png', bytes: 3, createdAt: '2026-01-02T10:00:00Z' } })
    if (url.endsWith('/execute')) {
      const request = JSON.parse(String(init?.body))
      if (request.operation === 'events') return response({ result: [event] })
      if (request.operation === 'analyze') return response({ result: { intervals: [], actualEffortMinutes: null, missing: ['投入记录缺失'], computedAt: state.sampledAt } })
    }
    throw new Error('Unexpected fetch: ' + url)
  })
  vi.stubGlobal('fetch', fetchMock)
}
function renderAgent() {
  return renderWithProviders(<SupervisorAgentProvider><SupervisorAgentButton>入口一</SupervisorAgentButton><SupervisorAgentProvider><SupervisorAgentButton>入口二</SupervisorAgentButton></SupervisorAgentProvider></SupervisorAgentProvider>)
}
it('明确启用观察模式但不自动启动或协调会话', async () => {
  let current = { ...config, enabled: false }
  installFetch((url, init) => {
    if (url.endsWith('/config') && init?.method === 'PUT') { current = JSON.parse(String(init.body)).config; return response(current) }
    if (url.endsWith('/config')) return response(current)
    if (url.endsWith('/state')) return response({ ...state, enabled: current.enabled })
    return undefined
  })
  renderWithProviders(<SupervisorAgentProvider><SupervisorPage /></SupervisorAgentProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '启用只读观察模式（不自动启动）' }))
  await waitFor(() => expect(current.enabled).toBe(true))
  expect(current.agentResources.mode).toBe('observe')
  expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/agent/start'))).toBe(false)
})
it('原任务来源不可用时仍能选择已授权历史档案', async () => {
  installFetch(url => url.endsWith('/state') ? response({ ...state, tasks: { ...state.tasks, tasks: [] } }) : undefined)
  renderWithProviders(<SupervisorAgentProvider><EventLedgerPage /></SupervisorAgentProvider>, { route: '/events?objectRef=journal%3A42' })
  expect(await screen.findByRole('option', { name: '历史档案 · 原任务来源不可用 · journal:42' })).toBeInTheDocument()
})

it('监督模式下任务抽屉不能直接录入，修改打开同一个主 Agent', async () => {
  renderWithProviders(<SupervisorAgentProvider><TaskDetailPage supervised task={state.tasks.tasks[0]} entry={undefined} sessions={[]} lanes={[]} planning={{}} authReady liveOptions={[]} onClose={vi.fn()} onUpdate={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onStart={vi.fn()} onOpenSession={vi.fn()} /></SupervisorAgentProvider>)
  for (const input of screen.getAllByRole('textbox')) expect(input).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '通过主 Agent 记录或修改' }))
  expect(await screen.findByRole('dialog', { name: '工作主管 Agent' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '给主管的消息' })).toBeEnabled()
})
it('监督模式仍可直接修改本地任务状态', async () => {
  const onEdit = vi.fn()
  const localTask = { ...state.tasks.tasks[0], uid: 'local:42', providerId: 'local', sourceLabel: 'Local' }
  renderWithProviders(<SupervisorAgentProvider><TaskDetailPage supervised task={localTask} entry={undefined} sessions={[]} lanes={[]} planning={{}} authReady liveOptions={[]} onClose={vi.fn()} onUpdate={vi.fn()} onEdit={onEdit} onDelete={vi.fn()} onStart={vi.fn()} onOpenSession={vi.fn()} /></SupervisorAgentProvider>)
  expect(screen.getByRole('textbox', { name: '任务标题' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '待办' }))
  expect(onEdit).toHaveBeenCalledWith('local:42', { status: 'todo' })
})
it('任务抽屉把时间线放在最前面，按天显示真实事件', async () => {
  installFetch()
  renderWithProviders(<SupervisorAgentProvider><TaskDetailPage supervised task={state.tasks.tasks[0]} entry={undefined} sessions={[]} lanes={[]} planning={{}} authReady liveOptions={[]} onClose={vi.fn()} onUpdate={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onStart={vi.fn()} onOpenSession={vi.fn()} /></SupervisorAgentProvider>)
  expect(screen.getByRole('heading', { name: '任务时间线' })).toBeInTheDocument()
  // 事件按记录时间落在当天节点上，标题与摘要都在抽屉里，不需要跳转
  expect(await screen.findByText('客户反馈已收到')).toBeInTheDocument()
  expect(screen.getByText('2026/01/02')).toBeInTheDocument()
  // 时间线排在内容/字段之前
  const timeline = screen.getByRole('heading', { name: '任务时间线' })
  const content = screen.getByRole('heading', { name: '任务说明' })
  expect(timeline.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
it('本地观察状态与来源事实分开展示，不把转述当作独立核实', async () => {
  installFetch(url => url.endsWith('/state') ? response({ ...state, workingStates: { 'journal:42': { objectRef: 'journal:42', stage: '等待后端', waitingFor: '后端', nextStep: '完成联调', sourceEventId: 'event-1', sourceKind: 'relay', version: 1, updatedAt: state.sampledAt } } }) : undefined)
  renderWithProviders(<SupervisorAgentProvider><SupervisorPage /></SupervisorAgentProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '显示其他任务（1）' }))
  expect(await screen.findByText(/本地观察（不改来源状态）：等待后端/)).toBeInTheDocument()
  expect(screen.getByText(/用户转述，尚未独立核实/)).toBeInTheDocument()
  expect(screen.getByText(/来源事实：doing/)).toBeInTheDocument()
})

it('首页聚焦在线会话关联任务和本地任务，其他任务按需展开且不改变授权', async () => {
  const base = state.tasks.tasks[0]
  const task = (uid: string, title: string, extra = {}) => ({ ...base, uid, id: uid, title, ...extra })
  const focused = {
    ...state,
    sessions: [...state.sessions, { ...detail.summary, processInstanceId: 'dev-process', sessionId: 'dev-session', observation: 'idle' }],
    tasks: { ...state.tasks,
      tasks: [task('journal:epic', '开发分组', { kind: 'epic' }), task('journal:active', '在线开发任务', { parentUid: 'journal:epic' }), task('local:collab', '本地协作任务', { providerId: 'local' }), task('journal:old', '其他历史任务'), task('journal:done', '已完成开发任务', { completion: 'done' }), task('journal:supervisor', '主管会话自身任务'), task('local:archived', '已归档本地任务', { providerId: 'local', archived: true })],
      sessionRefs: {
        'journal:active': [{ sessionId: 'dev-session', processInstanceId: 'dev-process', cwd: '/work', tags: [], live: true }],
        'journal:done': [{ sessionId: 'dev-session', processInstanceId: 'dev-process', cwd: '/work', tags: [], live: true }],
        'journal:old': [{ sessionId: 'old-session', processInstanceId: 'old-process', cwd: '/work', tags: [], live: false }],
        'journal:supervisor': [{ sessionId: 'session-1', processInstanceId: 'process-1', cwd: '/work', tags: [], live: true }],
      },
    },
  }
  installFetch(url => url.endsWith('/state') ? response(focused) : undefined)
  renderWithProviders(<SupervisorAgentProvider><SupervisorPage /></SupervisorAgentProvider>)
  expect(await screen.findByRole('link', { name: /在线开发任务/ })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /本地协作任务/ })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /开发分组/ })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /其他历史任务/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /已完成开发任务/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /主管会话自身任务/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /已归档本地任务/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '显示其他任务（4）' }))
  expect(screen.getByRole('link', { name: /其他历史任务/ })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /已完成开发任务/ })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '收起其他任务（4）' }))
  expect(screen.queryByRole('link', { name: /其他历史任务/ })).not.toBeInTheDocument()
  expect(fetchMock.mock.calls.some(call => String(call[1]?.method || 'GET') !== 'GET')).toBe(false)
})

it('没有Task Journal和会话关联时仍默认展示本地任务', async () => {
  const local = { ...state.tasks.tasks[0], uid: 'local:only', providerId: 'local', title: '独立本地任务' }
  installFetch(url => url.endsWith('/state') ? response({ ...state, sessions: [], tasks: { ...state.tasks, tasks: [local], providers: [], sessionRefs: {} } }) : undefined)
  renderWithProviders(<SupervisorAgentProvider><SupervisorPage /></SupervisorAgentProvider>)
  expect(await screen.findByRole('link', { name: /独立本地任务/ })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /显示其他任务/ })).not.toBeInTheDocument()
})

it('禁用状态与授权不足给出不同提示，不把未启用误报成越权', () => {
  expect(errorText(new SupervisorApiError(403, 'supervisor_disabled'))).toContain('监督服务未启用')
  expect(errorText(new SupervisorApiError(403, 'supervisor_disabled'))).not.toContain('权限或授权范围不足')
  expect(errorText(new SupervisorApiError(403, 'not_authorized'))).toBe('权限或授权范围不足：not_authorized')
  expect(errorText(new SupervisorApiError(401, 'unauthorized'))).toBe('需要认证：unauthorized')
})

it('侧栏按钮打开原来的唯一主 Agent 弹窗', async () => {
  renderWithProviders(<SupervisorAgentProvider><SupervisorAgentSidebarButton className="sidebar-button" /></SupervisorAgentProvider>)
  const button = screen.getByRole('button', { name: '打开主 Agent' })
  expect(button.textContent).toBe('')
  expect(button.querySelector('svg')).toHaveClass('stroke-current', 'fill-none')
  expect(button).toHaveAttribute('title', '打开全局主 Agent 对话')
  fireEvent.click(button)
  expect(await screen.findByRole('dialog', { name: '工作主管 Agent' })).toBeInTheDocument()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
})

  it('扩展代码更新时监督台与弹窗提示重启而不丢功能', async () => {
    installFetch(url => url.endsWith('/state') ? response({ ...state, agent: { ...state.agent, extensionsStale: true } }) : undefined)
    renderWithProviders(<SupervisorAgentProvider><SupervisorPage /></SupervisorAgentProvider>)
    expect(await screen.findByText(/扩展代码已更新（主会话仍在用启动时的版本）/)).toBeInTheDocument()
    renderWithProviders(<SupervisorAgentProvider><SupervisorAgentSidebarButton className="sidebar-button" /></SupervisorAgentProvider>)
    fireEvent.click(screen.getAllByRole('button', { name: '打开主 Agent' })[0])
    expect(await screen.findByRole('dialog', { name: '工作主管 Agent' })).toBeInTheDocument()
    expect(screen.getAllByText(/扩展代码已更新（主会话仍在用启动时的版本）/).length).toBeGreaterThan(0)
  })

it('资源已变更但旧主会话已结束时仍可启动', async () => {
  installFetch(url => url.endsWith('/state') ? response({ ...state, agent: { ...state.agent, resourceState: 'pending' as const, connected: false, processInstanceId: undefined, sessionId: 'session-stale' } }) : undefined)
  renderWithProviders(<SupervisorAgentProvider><SupervisorAgentSidebarButton className="sidebar-button" /></SupervisorAgentProvider>)
  fireEvent.click(screen.getByRole('button', { name: '打开主 Agent' }))
  await screen.findByRole('dialog', { name: '工作主管 Agent' })
  expect(await screen.findByText(/旧主会话已结束（当前未连接）/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '启动 / 重试启动' })).toBeEnabled()
})

it('资源已变更且旧主会话仍在运行时拦住启动', async () => {
  installFetch(url => url.endsWith('/state') ? response({ ...state, agent: { ...state.agent, resourceState: 'pending' as const, connected: true, processInstanceId: 'process-old' } }) : undefined)
  renderWithProviders(<SupervisorAgentProvider><SupervisorAgentSidebarButton className="sidebar-button" /></SupervisorAgentProvider>)
  fireEvent.click(screen.getByRole('button', { name: '打开主 Agent' }))
  expect(await screen.findByText(/旧主会话仍在运行/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '启动 / 重试启动' })).toBeDisabled()
})

it('通知展示真实未处理事项，点击检查只打开主 Agent 草稿而不改变任务', async () => {
  const base = { objectRef: 'journal:42', sourceRefs: ['event-1'], createdAt: state.sampledAt, updatedAt: state.sampledAt, reason: '需要核对后端反馈' }
  installFetch(url => url.endsWith('/state') ? response({ ...state, actions: [{ ...base, id: 'todo-1', title: '核对接口', state: 'open' }, { ...base, id: 'todo-2', title: '建议补测试', state: 'suggested' }, { ...base, id: 'todo-done', title: '已做完的事项', state: 'done' }] }) : undefined)
  renderWithProviders(<SupervisorAgentProvider><SupervisorNotificationsSidebarButton /></SupervisorAgentProvider>)
  const notificationButton = screen.getByRole('button', { name: '打开最近待办通知' })
  expect(notificationButton.querySelector('svg')).toHaveClass('stroke-current', 'fill-none')
  fireEvent.click(notificationButton)
  expect(await screen.findByText('核对接口')).toBeInTheDocument()
  expect(screen.getByText('建议补测试')).toBeInTheDocument()
  expect(screen.queryByText('已做完的事项')).not.toBeInTheDocument()
  fireEvent.click(screen.getAllByRole('button', { name: '交给主 Agent 检查' })[0])
  expect(await screen.findByRole('dialog', { name: '工作主管 Agent' })).toBeInTheDocument()
  expect((screen.getByRole('textbox', { name: '给主管的消息' }) as HTMLTextAreaElement).value).toContain('todo-1')
  expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/agent/input'))).toBe(false)
})

beforeEach(() => installFetch())
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); Reflect.deleteProperty(document, 'hidden') })

describe('主管唯一弹窗', () => {
  it('多个入口及嵌套 provider 仍只有一个弹窗，焦点循环、Esc 恢复且保留草稿', async () => {
    renderAgent()
    const trigger = screen.getByRole('button', { name: '入口一' })
    trigger.focus(); fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '工作主管 Agent' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(dialog).toHaveClass('max-w-[960px]')
    const composer = screen.getByRole('textbox', { name: '给主管的消息' })
    expect(composer).toHaveFocus()
    fireEvent.change(composer, { target: { value: '尚未发送的草稿' } })
    await screen.findByText('真实主管回复')
    const close = within(dialog).getByRole('button', { name: '关闭主管弹窗' })
    close.focus(); fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(screen.getByRole('button', { name: '发送给主管' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '入口二' })) })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: '给主管的消息' })).toHaveValue('尚未发送的草稿')
  })
  it('真实明细进入 live-session bridge，确认留给全局扩展弹窗处理', async () => {
    installFetch(url => url.endsWith('/agent/detail') ? response({ ...detail, pendingUi: [{ id: 'confirm-1', method: 'confirm', title: '确认保存报告' }] }) : undefined)
    const { store } = renderAgent()
    fireEvent.click(screen.getByText('入口一'))
    await screen.findByText('真实主管回复')
    await waitFor(() => expect(store.getState().liveSessions.pendingUi['process-1']['confirm-1'].title).toBe('确认保存报告'))
    expect(screen.getByText(/主管正在等待全局确认弹窗回答/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送给主管' })).toBeDisabled()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })
  it('截图先持久上传，同图与附件 ID 发送；失败保留草稿和附件，不冒充成功', async () => {
    installFetch(url => url.endsWith('/agent/input') ? response({ error: '输入桥离线' }, 503) : undefined)
    renderAgent(); fireEvent.click(screen.getByText('入口一'))
    await screen.findByText('真实主管回复')
    fireEvent.change(screen.getByRole('textbox', { name: '给主管的消息' }), { target: { value: '请记录客户截图' } })
    fireEvent.change(screen.getByLabelText('上传截图'), { target: { files: [new File(['abc'], 'capture.png', { type: 'image/png' })] } })
    await screen.findByText(/已持久保存/)
    const upload = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/attachments'))!
    expect(JSON.parse(upload[1].body)).toEqual({ name: 'capture.png', mime: 'image/png', data: 'YWJj' })
    fireEvent.click(screen.getByRole('button', { name: '发送给主管' }))
    await screen.findByRole('alert')
    expect(screen.getByText('输入桥离线')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '给主管的消息' })).toHaveValue('请记录客户截图')
    expect(screen.getByText(/已持久保存/)).toBeInTheDocument()
    const input = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/agent/input'))!
    expect(JSON.parse(input[1].body)).toEqual({ text: '请记录客户截图', images: [{ type: 'image', mimeType: 'image/png', data: 'YWJj' }], attachmentIds: ['attachment-1'] })
    expect(input[1].credentials).toBe('same-origin')
    expect(screen.queryByText('消息已接收，等待主管回复。')).not.toBeInTheDocument()
  })
  it('上传失败禁用发送，认证错误显示已有认证面板', async () => {
    installFetch(url => url.endsWith('/attachments') ? response({ error: '认证过期' }, 401) : undefined)
    renderAgent(); fireEvent.click(screen.getByText('入口一')); await screen.findByText('真实主管回复')
    fireEvent.change(screen.getByLabelText('上传截图'), { target: { files: [new File(['abc'], 'capture.png', { type: 'image/png' })] } })
    await screen.findByText('Live Pi Session 认证')
    expect(screen.getByRole('button', { name: '发送给主管' })).toBeDisabled()
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/agent/input'))).toBe(false)
  })
  it('启动失败显示真实错误且保留草稿', async () => {
    installFetch(url => url.endsWith('/state') ? response({ ...state, agent: { connected: false, resourceState: 'not_started' } }) : url.endsWith('/agent/start') ? response({ error: '角色文件不存在' }, 503) : undefined)
    renderAgent(); fireEvent.click(screen.getByText('入口一'))
    const input = screen.getByRole('textbox', { name: '给主管的消息' })
    fireEvent.change(input, { target: { value: '启动后再发' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '启动 / 重试启动' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '启动 / 重试启动' }))
    await screen.findByText('角色文件不存在')
    expect(input).toHaveValue('启动后再发')
    expect(screen.getByRole('button', { name: '发送给主管' })).toBeDisabled()
    expect(screen.queryByText(/启动请求已确认/)).not.toBeInTheDocument()
  })
  it('启动响应真实确认后接入明细，发送仅在 ok 后清空草稿', async () => {
    let started = false
    installFetch(url => {
      if (url.endsWith('/state')) return response(started ? state : { ...state, agent: { connected: false, resourceState: 'not_started' } })
      if (url.endsWith('/agent/start')) { started = true; return response({ processInstanceId: 'process-1', sessionId: 'session-1' }) }
      return undefined
    })
    renderAgent(); fireEvent.click(screen.getByText('入口一'))
    await waitFor(() => expect(screen.getByRole('button', { name: '启动 / 重试启动' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '启动 / 重试启动' }))
    await screen.findByText(/启动请求已确认，会话：session-1/)
    await screen.findByText('真实主管回复')
    const composer = screen.getByRole('textbox', { name: '给主管的消息' })
    fireEvent.change(composer, { target: { value: '查看真实事件' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送给主管' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '发送给主管' }))
    await screen.findByText('消息已接收，等待主管回复。')
    expect(composer).toHaveValue('')
  })
  it('配置缺失禁用启动且没有自动配置写入', async () => {
    installFetch(url => url.endsWith('/config') ? response(null) : undefined)
    renderAgent(); fireEvent.click(screen.getByText('入口一'))
    await screen.findByText(/配置缺失，主管不可启用/)
    expect(screen.getByRole('button', { name: '启动 / 重试启动' })).toBeDisabled()
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })
})

describe('真实事件与监督页面', () => {
  it('读取 URL UID，显示真实标题、任务/会话链接、发生未知与修订，按子对象重新查询', async () => {
    renderWithProviders(<SupervisorAgentProvider><EventLedgerPage /></SupervisorAgentProvider>, { route: '/event-ledger?objectRef=journal%3A42' })
    await screen.findByRole('button', { name: /客户反馈已收到/ })
    expect(screen.getAllByRole('link', { name: /真实任务标题/ })[0]).toHaveAttribute('href', '/tasks/journal%3A42')
    expect(screen.getByRole('link', { name: '来源会话 session-1' })).toHaveAttribute('href', '/live-sessions/process-1')
    expect(screen.getByText('发生时间：未知')).toBeInTheDocument()
    expect(screen.getByText('参与人：客户、工程师')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '事件图片 attachment-1' })).toHaveAttribute('src', '/api/supervisor/attachments/attachment-1')
    expect(screen.getByText('修订历史（1）')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: '包含子对象事件' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/execute')).map(([, init]) => JSON.parse(init.body)).some(request => request.operation === 'events' && request.args.includeChildren === true)).toBe(true))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
  it('分析在页面标签内执行；未知投入不会显示为零', async () => {
    renderWithProviders(<SupervisorAgentProvider><EventLedgerPage /></SupervisorAgentProvider>, { route: '/event-ledger?objectRef=journal%3A42' })
    await screen.findByText('客户反馈已收到')
    fireEvent.click(screen.getByRole('tab', { name: '时间分析' }))
    await screen.findByText(/实际投入：未知/)
    expect(screen.getByText('缺口：投入记录缺失')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/execute') && JSON.parse(init.body).operation === 'analyze')).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('切换 UID 后查询失败，不把旧对象事件显示到新对象', async () => {
    installFetch((url, init) => {
      if (url.endsWith('/state')) return response({ ...state, tasks: { ...state.tasks, tasks: [...state.tasks.tasks, { ...state.tasks.tasks[0], uid: 'journal:43', id: '43', title: '另一真实任务' }] } })
      if (url.endsWith('/execute') && JSON.parse(String(init?.body)).args.objectRef === 'journal:43') return response({ error: '另一对象查询失败' }, 503)
      return undefined
    })
    renderWithProviders(<SupervisorAgentProvider><EventLedgerPage /></SupervisorAgentProvider>, { route: '/events?objectRef=journal%3A42' })
    await screen.findByRole('button', { name: /客户反馈已收到/ })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'journal:43' } })
    await screen.findByText('另一对象查询失败')
    expect(screen.queryByText('客户反馈已收到')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /另一真实任务/ })).toHaveAttribute('href', '/tasks/journal%3A43')
  })
  it('事件查询失败是失败，不显示空记录作为成功', async () => {
    installFetch(url => url.endsWith('/execute') ? response({ error: '事件存储不可用' }, 503) : undefined)
    renderWithProviders(<SupervisorAgentProvider><EventLedgerPage /></SupervisorAgentProvider>, { route: '/event-ledger?objectRef=journal%3A42' })
    await screen.findByText('事件存储不可用')
    expect(screen.queryByText(/该对象没有返回事件/)).not.toBeInTheDocument()
    expect(screen.queryByText('客户反馈已收到')).not.toBeInTheDocument()
  })
  it('会话观察把原始输出改写成可读摘要，并保留原始输出可展开', async () => {
    const raw = '喵，先跑一段：\n```bash\nnpm test -- --run\n```\n喵，这个任务的结果我已经读过了：exit=0，三个测试文件全部通过。需要你确认：是否保留右上角入口？'
    installFetch(url => url.endsWith('/state') ? response({ ...state, sessions: [{ ...detail.summary, observation: 'idle', evidence: '运行时空闲，尚未确认是完成、等待输入还是后台作业。', lastText: raw, digest: { headline: '这个任务的结果我已经读过了：exit=0，三个测试文件全部通过。', points: ['这条回复会按发生顺序纵向堆叠在同一个活动的回复块里。'], waitingFor: '需要你确认：是否保留右上角入口？', coveredMessages: 4, source: 'recent_output' } }] }) : undefined)
    renderWithProviders(<SupervisorAgentProvider><SupervisorPage /></SupervisorAgentProvider>)
    expect(await screen.findByText('最近输出摘要')).toBeInTheDocument()
    expect(screen.getByText(/摘自最近 4 条回复，新→旧，便于阅读；不是任务事实/)).toBeInTheDocument()
    expect(screen.getByText('这个任务的结果我已经读过了：exit=0，三个测试文件全部通过。')).toBeInTheDocument()
    expect(screen.getByText('这条回复会按发生顺序纵向堆叠在同一个活动的回复块里。')).toBeInTheDocument()
    expect(screen.getByText(/在等：需要你确认/)).toBeInTheDocument()
    // The raw transcript stays reachable, and the digest is not shown as a replacement for it.
    expect(screen.getByText('原始输出（末尾 88 字）')).toBeInTheDocument()
  })
  it('没有摘要时直接显示原始文本，不伪装成已总结', async () => {
    installFetch(url => url.endsWith('/state') ? response({ ...state, sessions: [{ ...detail.summary, observation: 'idle', evidence: '证据', lastText: '喵，原始回复内容。' }] }) : undefined)
    renderWithProviders(<SupervisorAgentProvider><SupervisorPage /></SupervisorAgentProvider>)
    expect(await screen.findByText('喵，原始回复内容。')).toBeInTheDocument()
    expect(screen.queryByText('最近输出摘要')).not.toBeInTheDocument()
  })
  it('概览保留真实来源、未知观察和授权警告，无页面聊天', async () => {
    renderWithProviders(<SupervisorAgentProvider><SupervisorPage /></SupervisorAgentProvider>)
    await screen.findByText('未知 · 缺少最近采样')
    expect(screen.getByText('仅覆盖授权对象')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '显示其他任务（1）' }))
    expect(screen.getByText(/来源：任务日志（journal）/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '事件流水账' })).toHaveAttribute('href', '/tasks/events?objectRef=journal%3A42')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
  it('主管关闭后停止轮询，隐藏文档时暂停，返回可见后恢复', async () => {
    vi.useFakeTimers()
    renderAgent()
    await act(async () => { fireEvent.click(screen.getByText('入口一')) })
    expect(screen.getByText('真实主管回复')).toBeInTheDocument()
    const stateCount = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/state')).length
    const detailCount = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/agent/detail')).length
    const initialStateCount = stateCount(), initialDetailCount = detailCount()
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(stateCount()).toBe(initialStateCount + 1)
    expect(detailCount()).toBe(initialDetailCount + 1)
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    fireEvent(document, new Event('visibilitychange'))
    const count = fetchMock.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(fetchMock).toHaveBeenCalledTimes(count)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    await act(async () => { fireEvent(document, new Event('visibilitychange')); await Promise.resolve() })
    expect(fetchMock.mock.calls.length).toBeGreaterThan(count)
    fireEvent.keyDown(document, { key: 'Escape' })
    const closedCount = fetchMock.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(fetchMock).toHaveBeenCalledTimes(closedCount)
  })
})
