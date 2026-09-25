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
    onGoal: vi.fn(),
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
  return { handlers, unmount: view.unmount }
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

  it('keeps the composer disabled and offers open when BTW is closed', () => {
    const { handlers } = renderFeatures({ features: { btw: { status: 'closed', conversation: [] } } })

    expect(btwPanel().getByText(/BTW 未打开/)).toBeInTheDocument()
    expect(btwPanel().getByLabelText('BTW 提问')).toBeDisabled()
    fireEvent.click(btwPanel().getByText('打开 BTW'))
    expect(handlers.onOpenBtw).toHaveBeenCalledOnce()
  })

  it('surfaces a BTW startup error', () => {
    renderFeatures({ features: { btw: { status: 'error', error: 'no model available' } } })

    expect(btwPanel().getByRole('alert')).toHaveTextContent('no model available')
  })

  // 「清空」no longer relies on window.confirm (browsers answer it with a silent
  // `false` when dialogs are suppressed), so the rail asks for a second click.
  it('asks for a second click before clearing the session', () => {
    const { handlers, unmount } = renderFeatures()

    const clear = screen.getByLabelText('开始新的空会话（旧对话保留在文件中）')
    fireEvent.click(clear)
    expect(handlers.onClear).toHaveBeenCalledOnce()

    unmount()
    renderFeatures({ clearArmed: true })
    expect(screen.getByText('确认清空')).toBeInTheDocument()
    expect(screen.getByLabelText(/再点一次确认/)).toBeInTheDocument()
  })
})