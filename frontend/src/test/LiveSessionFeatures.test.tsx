import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import LiveSessionFeatures from '../features/live-sessions/LiveSessionFeatures'

type Props = Parameters<typeof LiveSessionFeatures>[0]

/** All the rails' plumbing stubbed; individual tests override what they assert. */
function renderFeatures(overrides: Partial<Props> = {}) {
  const handlers = {
    onFileOpen: vi.fn(),
    onOpenBtw: vi.fn(),
    onCloseBtw: vi.fn(),
    onBtwSubmit: vi.fn(),
    onBtwAbort: vi.fn(),
    onBtwRefreshParent: vi.fn(),
    onOpenWorkflow: vi.fn(),
    onGoalSync: vi.fn(),
    onCompact: vi.fn(),
    onClear: vi.fn(),
    onReload: vi.fn(),
    onAbort: vi.fn(),
  }
  const props: Props = {
    features: {},
    cwd: '/repo',
    status: 'idle',
    ...handlers,
    ...overrides,
  }
  const view = render(<LiveSessionFeatures {...props} />)
  return { handlers: props, unmount: view.unmount }
}

/** The panel body lives next to the rail button, inside the same <details>. */
const btwPanel = () => within(screen.getByLabelText('BTW').closest('details') as HTMLElement)

describe('LiveSessionFeatures', () => {
  it('renders BTW, scheduler, subagent and workflow snapshots', () => {
    renderFeatures({
      features: {
        btw: { status: 'ready', conversation: [{ role: 'assistant', text: 'side answer' }] },
        schedule: { tasks: [{ id: 'schedule-1', title: 'Check job', instruction: 'Inspect output', nextRunAt: Date.now() + 60_000 }] },
        'subagent-workflow': {
          conversations: { items: [{ id: 'work-1', label: 'Scout', status: 'running' }] },
          workflows: { items: [{ id: 'workflow-1', label: 'Benchmark', status: 'running' }] },
        },
      },
    })

    expect(within(screen.getByLabelText('BTW')).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Scheduler')).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Subagent / Workflow')).getByText('2')).toBeInTheDocument()
  })

  it('invites a question once BTW is ready instead of claiming there is nothing to do', () => {
    renderFeatures({ features: { btw: { status: 'ready', conversation: [] } } })

    expect(btwPanel().getByText(/BTW 已就绪/)).toBeInTheDocument()
    expect(btwPanel().queryByText(/暂无对话/)).not.toBeInTheDocument()
    // The composer is the point of the panel: an open side chat must be askable.
    expect(btwPanel().getByLabelText('BTW 提问')).toBeEnabled()
  })

  it('submits the typed question and clears the box', () => {
    const { handlers } = renderFeatures({ features: { btw: { status: 'ready', conversation: [] } } })
    const box = btwPanel().getByLabelText('BTW 提问') as HTMLTextAreaElement

    fireEvent.change(box, { target: { value: '这个报错是从哪里来的？' } })
    fireEvent.click(btwPanel().getByText('发送'))

    expect(handlers.onBtwSubmit).toHaveBeenCalledWith('这个报错是从哪里来的？')
    expect(box.value).toBe('')
  })

  it('sends on Enter but keeps Shift+Enter as a newline', () => {
    const { handlers } = renderFeatures({ features: { btw: { status: 'ready', conversation: [] } } })
    const box = btwPanel().getByLabelText('BTW 提问')

    fireEvent.change(box, { target: { value: 'first line' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(handlers.onBtwSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(box, { key: 'Enter' })
    expect(handlers.onBtwSubmit).toHaveBeenCalledWith('first line')
  })

  it('offers abort while BTW is answering and refresh-parent while idle', () => {
    const { handlers: busyHandlers, unmount } = renderFeatures({ features: { btw: { status: 'busy', activity: '正在回答', conversation: [{ role: 'user', text: 'q' }] } } })
    expect(btwPanel().getByText(/正在回答/)).toBeInTheDocument()
    fireEvent.click(btwPanel().getByText('中止'))
    expect(busyHandlers.onBtwAbort).toHaveBeenCalledOnce()
    expect(btwPanel().queryByText('发送')).not.toBeInTheDocument()

    unmount()
    const { handlers: idleHandlers } = renderFeatures({ features: { btw: { status: 'ready', conversation: [] } } })
    fireEvent.click(btwPanel().getByText('同步上下文'))
    expect(idleHandlers.onBtwRefreshParent).toHaveBeenCalledOnce()
  })

  it('keeps the composer disabled while BTW is closed', () => {
    const { handlers } = renderFeatures({ features: { btw: { status: 'closed', conversation: [] } } })

    expect(btwPanel().getByLabelText('BTW 提问')).toBeDisabled()
    expect(btwPanel().getByText('发送')).toBeDisabled()
    fireEvent.click(btwPanel().getByText('打开 BTW'))
    expect(handlers.onOpenBtw).toHaveBeenCalledOnce()
    expect(handlers.onBtwSubmit).not.toHaveBeenCalled()
  })

  it('keeps the side chat askable while the main session is working', () => {
    const { handlers } = renderFeatures({
      busy: true,
      status: 'running',
      features: { btw: { status: 'ready', conversation: [] } },
    })

    // The side chat runs in its own session: the main turn must not lock it.
    const box = btwPanel().getByLabelText('BTW 提问') as HTMLTextAreaElement
    expect(box).toBeEnabled()
    fireEvent.change(box, { target: { value: '主会话现在跑到哪了' } })
    fireEvent.click(btwPanel().getByText('发送'))
    expect(handlers.onBtwSubmit).toHaveBeenCalledWith('主会话现在跑到哪了')
  })

  it('keeps the typed question while the side chat is answering', () => {
    const { handlers } = renderFeatures({ features: { btw: { status: 'busy', activity: '只读工具：read src/app.ts', conversation: [{ role: 'user', text: 'q' }, { role: 'assistant', text: '' }] } } })

    expect(btwPanel().getByText(/只读工具：read src\/app.ts/)).toBeInTheDocument()
    expect(btwPanel().getByText('正在生成…')).toBeInTheDocument()
    const box = btwPanel().getByLabelText('BTW 提问') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '我下一句先打好' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    expect(handlers.onBtwSubmit).not.toHaveBeenCalled()
    expect(box.value).toBe('我下一句先打好')
    expect(btwPanel().getByText(/先「中止」或等它答完/)).toBeInTheDocument()
  })

  it('names the transcript roles in plain words and copies an answer', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderFeatures({
      features: {
        btw: {
          status: 'ready',
          model: 'dashscope/deepseek-v4.1-flash-1017',
          parentMessageCount: 12,
          conversation: [
            { role: 'user', text: '刚才那个文件叫什么' },
            { role: 'assistant', text: 'src/app.ts' },
            { role: 'notice', text: '已刷新主会话快照' },
          ],
        },
      },
    })

    const transcript = () => within(btwPanel().getByLabelText('BTW 对话记录'))
    expect(transcript().getByText('你')).toBeInTheDocument()
    expect(transcript().getByText('BTW')).toBeInTheDocument()
    expect(transcript().getByText('提示')).toBeInTheDocument()
    expect(btwPanel().getByText(/已同步主上下文 12 条/)).toBeInTheDocument()

    fireEvent.click(btwPanel().getByRole('button', { name: '复制 BTW 这个回答' }))
    expect(writeText).toHaveBeenCalledWith('src/app.ts')
    expect(await btwPanel().findByText('已复制这个回答的原文')).toBeInTheDocument()
  })

  it('tells the user that the closed side chat was kept', () => {
    renderFeatures({ features: { btw: { status: 'closed', conversation: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }] } } })

    expect(btwPanel().getByText(/已保留 2 条记录/)).toBeInTheDocument()
  })

  it('surfaces a BTW startup error', () => {
    renderFeatures({ features: { btw: { status: 'error', error: 'no model available' } } })

    expect(btwPanel().getByRole('alert')).toHaveTextContent('no model available')
  })

  // 「清空」used to rely on window.confirm (browsers answer it with a silent `false`),
  // then on a two-step arm — which failed on its own terms: a 5s window, a banner that
  // outlived it, and a press that vanished while the session was busy. One click acts.
  it('clears the session on the first click', () => {
    const { handlers } = renderFeatures()

    const clear = screen.getByLabelText('点击即开始新的空会话（旧对话保留在文件中）')
    fireEvent.click(clear)
    expect(handlers.onClear).toHaveBeenCalledOnce()
  })

  it('shows checklist progress, blockers and expandable details while the session is running', async () => {
    const { handlers } = renderFeatures({
      status: 'running',
      onGoalSync: vi.fn(),
      goal: {
        objective: '显示当前 goal',
        status: 'active',
        progress: { lastSummary: '已完成主视图', current: '补齐可展开详情' },
        blockers: [{
          title: '等待接口权限',
          reason: '需要管理员确认',
          owner: 'user',
          kind: 'user_decision',
          disposition: 'needs_user',
          proposedResolution: '请管理员确认权限',
        }],
        acceptanceCriteria: ['弹窗展示目标和未解决 blocker'],
        constraints: ['不向聊天发送 /goal'],
        workItems: [
          { id: 'main', title: '主视图', state: 'done', dependsOn: [] },
          { id: 'details', title: '补齐可展开详情', state: 'in_progress', dependsOn: ['主视图'] },
        ],
        sourceDocs: [{ path: 'docs/goal-ui.md', kind: 'prd', brief: '目标弹窗需求' }],
        updatedAt: Date.now(),
        messagesSinceUpdate: 0,
      },
    })
    const goal = screen.getByRole('button', { name: /任务锚点：进行中/ })

    expect(goal).toBeEnabled()
    fireEvent.click(goal)
    const dialog = await screen.findByRole('dialog', { name: '任务锚点' })
    expect(within(dialog).getByText('显示当前 goal')).toBeInTheDocument()
    expect(within(dialog).getByText('1/2 完成')).toBeInTheDocument()
    expect(within(dialog).getByText('1 项需要你处理')).toBeInTheDocument()
    
    expect(within(dialog).getAllByText('补齐可展开详情').length).toBeGreaterThan(0)
    expect(within(dialog).getByText('依赖：主视图')).toBeInTheDocument()
    expect(within(dialog).getByText('当前在哪一步')).toBeInTheDocument()
    expect(dialog.textContent).toContain('已完成主视图')
    expect(within(dialog).getByText('等待接口权限')).toBeInTheDocument()
    expect(within(dialog).getByText('需要管理员确认')).toBeInTheDocument()
    expect(within(dialog).getByText('请管理员确认权限')).toBeInTheDocument()

    const summary = within(dialog).getByText(/更多详情/).closest('details') as HTMLElement
    fireEvent.click(within(summary).getByText(/更多详情/))
    expect(within(summary).getByText('弹窗展示目标和未解决 blocker')).toBeInTheDocument()
    expect(within(summary).getByText('不向聊天发送 /goal')).toBeInTheDocument()
    expect(within(summary).getByText('目标弹窗需求')).toBeInTheDocument()
    expect(within(summary).getByText('docs/goal-ui.md')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: '让 agent 同步清单' }))
    expect(handlers.onGoalSync).toHaveBeenCalledOnce()
  })

  it('warns when the goal is complete but its checklist was never ticked', async () => {
    renderFeatures({
      status: 'running',
      onGoalSync: vi.fn(),
      goal: {
        objective: '监督台 PRD 规划',
        status: 'complete',
        progress: {},
        blockers: [],
        acceptanceCriteria: [],
        constraints: [],
        workItems: [
          { id: 'a', title: '写 PRD 草案', state: 'todo', dependsOn: [] },
          { id: 'b', title: '列出 MVP 范围', state: 'todo', dependsOn: [] },
        ],
        sourceDocs: [],
        updatedAt: Date.now(),
        messagesSinceUpdate: 0,
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /任务锚点：已完成/ }))
    const dialog = await screen.findByRole('dialog', { name: '任务锚点' })
    expect(within(dialog).getByText('这份清单可能过期')).toBeInTheDocument()
    expect(dialog.textContent).toContain('但 2 个工作项还没勾选')
    expect(within(dialog).getAllByRole('button', { name: '让 agent 同步清单' }).length).toBeGreaterThan(0)
  })

  it('invites a goal draft when the session never set one', async () => {
    renderFeatures({ status: 'running' })

    fireEvent.click(screen.getByRole('button', { name: /查看当前 session 的目标/ }))
    const dialog = await screen.findByRole('dialog', { name: '任务锚点' })
    expect(within(dialog).getByText('这条会话还没有设目标')).toBeInTheDocument()
    expect(dialog.textContent).toContain('每轮对话前重新放进上下文')
  })


  it('disables 目标 while the session is reconnecting', () => {
    renderFeatures({ status: 'reconnecting' })

    expect(screen.getByRole('button', { name: /查看当前 session 的目标/ })).toBeDisabled()
  })

  it('shows the goal working even before any checklist item exists', () => {
    renderFeatures({
      status: 'running',
      goal: {
        objective: '自动推进 global-remaining 任务',
        status: 'active',
        progress: { current: '扫描第 3 批' },
        blockers: [], acceptanceCriteria: [], constraints: [], workItems: [], sourceDocs: [],
        updatedAt: Date.now(), messagesSinceUpdate: 0,
      },
    })

    const goal = screen.getByRole('button', { name: /任务锚点：进行中/ })
    expect(goal).toHaveAttribute('data-goal-state', 'active')
    expect(goal.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('marks a paused goal so it is not mistaken for running', () => {
    renderFeatures({
      status: 'running',
      goal: {
        objective: '等待权限后继续',
        status: 'paused',
        progress: {}, blockers: [], acceptanceCriteria: [], constraints: [], workItems: [], sourceDocs: [],
        updatedAt: Date.now(), messagesSinceUpdate: 0,
      },
    })

    const goal = screen.getByRole('button', { name: /任务锚点：已暂停/ })
    expect(goal).toHaveAttribute('data-goal-state', 'paused')
    expect(goal.querySelector('.animate-pulse')).toBeNull()
  })

  it('keeps 清空 clickable while the session works', () => {
    // The old `status !== 'idle'` gate made the confirm press vanish silently: the
    // button was disabled, so the click never reached the handler, while the banner
    // kept asking for it. `/clear` waits for idle itself, so the click is always
    // accepted and always answered.
    const { handlers } = renderFeatures({ status: 'running' })
    const clear = screen.getByLabelText(/自动切换/)
    expect(clear).not.toBeDisabled()
    fireEvent.click(clear)
    expect(handlers.onClear).toHaveBeenCalledOnce()
  })
})