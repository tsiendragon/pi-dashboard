import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionSummary } from '@shared/live-sessions'
import LiveSessionComposer from '../features/live-sessions/LiveSessionComposer'
import LiveSessionsList from '../features/live-sessions/LiveSessionsList'
import { api } from '../api/client'

afterEach(() => vi.restoreAllMocks())

function session(processInstanceId: string, pid: number, cwd = '~/repos/worktree/task-a'): LiveSessionSummary {
  return {
    processInstanceId, sessionId: `session-${processInstanceId}`, pid,
    cwd, canonicalCwd: cwd,
    mode: 'tui', status: 'idle', claim: { state: 'unclaimed' },
    startedAt: pid, lastActivityAt: pid, revision: 1, eventSequence: 0,
  }
}

describe('Live Session UI', () => {
  it('renders and selects sessions from different worktrees', () => {
    const onSelect = vi.fn()
    render(<LiveSessionsList sessions={[
      session('a', 101, '~/repos/worktree/task-a'),
      session('b', 202, '~/repos/worktree/task-b'),
    ]} onSelect={onSelect} />)
    expect(screen.getByText('pi 101')).toBeInTheDocument()
    expect(screen.getByText('pi 202')).toBeInTheDocument()
    fireEvent.click(screen.getByText('pi 202'))
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  it('preserves the prompt draft when sending fails', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('offline'))
    render(<LiveSessionComposer status="idle" owned={false} claimedByAnother={false} onSubmit={onSubmit} />)
    const input = screen.getByPlaceholderText('发送到运行中的 Pi…') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'keep this draft' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('keep this draft', undefined))
    expect(input.value).toBe('keep this draft')
  })

  it('keeps an unsent draft scoped to its own live session', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<LiveSessionComposer sessionKey="a" status="idle" onSubmit={onSubmit} />)
    const input = screen.getByPlaceholderText('发送到运行中的 Pi…') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'draft-a' } })
    expect(input.value).toBe('draft-a')

    rerender(<LiveSessionComposer sessionKey="b" status="idle" onSubmit={onSubmit} />)
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: 'draft-b' } })

    rerender(<LiveSessionComposer sessionKey="a" status="idle" onSubmit={onSubmit} />)
    expect(input.value).toBe('draft-a')
  })

  it('offers effort (thinking level) inside the model picker', async () => {
    const onSelectThinkingLevel = vi.fn().mockResolvedValue(undefined)
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<LiveSessionComposer
      status="idle"
      models={[{ provider: 'anthropic', id: 'claude-x', name: 'Claude X', reasoning: true, contextWindow: 200_000, thinkingLevels: ['low', 'medium', 'high'] }]}
      currentModel={{ provider: 'anthropic', id: 'claude-x' }}
      currentThinkingLevel="medium"
      onSelectThinkingLevel={onSelectThinkingLevel}
      onSubmit={onSubmit}
    />)

    fireEvent.click(screen.getByTitle('切换当前模型'))
    const high = await screen.findByRole('button', { name: 'high' })
    fireEvent.click(high)
    await waitFor(() => expect(onSelectThinkingLevel).toHaveBeenCalledWith('high'))
  })

  it('filters the model picker and picks with the keyboard', async () => {
    const onSelectModel = vi.fn().mockResolvedValue(undefined)
    render(<LiveSessionComposer
      status="idle"
      models={[
        { provider: 'dashscope', id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', reasoning: false, contextWindow: 128_000, thinkingLevels: [] },
        { provider: 'dashscope', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: true, contextWindow: 1_048_576, thinkingLevels: ['xhigh', 'max'] },
      ]}
      currentModel={{ provider: 'dashscope', id: 'qwen3-coder-plus' }}
      onSelectModel={onSelectModel}
      onSubmit={vi.fn().mockResolvedValue(undefined)}
    />)

    fireEvent.click(screen.getByTitle('切换当前模型'))
    const search = await screen.findByLabelText('搜索模型')
    // Grouped by provider, with a compact context size per row.
    expect(screen.getByText('dashscope')).toBeInTheDocument()
    expect(screen.getByText('1.0M')).toBeInTheDocument()
    expect(screen.getByText('128K')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'deepseek' } })
    expect(screen.queryByText('Qwen3 Coder Plus')).not.toBeInTheDocument()

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(onSelectModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'deepseek-v4.1-flash' })))
  })

  it('shows a live activity indicator above the composer', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<LiveSessionComposer
      status="running"
      activity={{ label: '思考中', tone: 'accent', thinkingStartedAt: Date.now() - 1_000 }}
      onSubmit={onSubmit}
    />)
    const indicator = screen.getByRole('status', { name: 'Agent 状态：思考中' })
    expect(indicator).toHaveTextContent('思考中')
    expect(indicator.querySelector('.typing-dots')).toBeTruthy()
    expect(indicator.querySelectorAll('.typing-dots > span')).toHaveLength(3)
  })

  it('does not show the activity indicator while the Agent is idle', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<LiveSessionComposer status="idle" activity={{ label: '等待输入', tone: 'muted' }} onSubmit={onSubmit} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('offers an interrupt control beside send while the turn is running', () => {
    const onInterrupt = vi.fn()
    const { rerender } = render(<LiveSessionComposer status="running" onInterrupt={onInterrupt} onSubmit={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '中止当前回合' }))
    expect(onInterrupt).toHaveBeenCalledTimes(1)

    // Idle sessions have nothing to interrupt.
    rerender(<LiveSessionComposer status="idle" onInterrupt={onInterrupt} onSubmit={async () => {}} />)
    expect(screen.queryByRole('button', { name: '中止当前回合' })).not.toBeInTheDocument()

    // Read-only viewers (no interrupt capability) must not see it either.
    rerender(<LiveSessionComposer status="running" onSubmit={async () => {}} />)
    expect(screen.queryByRole('button', { name: '中止当前回合' })).not.toBeInTheDocument()
  })

  it('shows the interrupt control as busy while it is in flight', () => {
    render(<LiveSessionComposer status="running" interrupting onInterrupt={() => {}} onSubmit={async () => {}} />)
    const button = screen.getByRole('button', { name: '中止当前回合' })
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('中止中…')
  })

  it('accepts a pasted image and sends it with an optional prompt', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<LiveSessionComposer status="idle" onSubmit={onSubmit} />)
    const input = screen.getByPlaceholderText('发送到运行中的 Pi…') as HTMLTextAreaElement
    const file = new File(['image-bytes'], 'screen.png', { type: 'image/png' })
    fireEvent.paste(input, { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } })
    await waitFor(() => expect(screen.getByAltText('待发送图片 1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      '请分析这张图片。', undefined,
      [expect.objectContaining({ type: 'image', mimeType: 'image/png' })],
    ))
  })

  it('uploads a pasted document and sends its path', async () => {
    vi.spyOn(api, 'uploadFiles').mockResolvedValue({ ok: true, paths: ['/tmp/pi-dashboard-uploads/1-notes.md'] })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<LiveSessionComposer status="idle" cwd="/repo" onSubmit={onSubmit} />)
    const input = screen.getByPlaceholderText('发送到运行中的 Pi…') as HTMLTextAreaElement
    const file = new File(['# hi'], 'notes.md', { type: 'text/markdown' })

    fireEvent.paste(input, { clipboardData: { items: [{ kind: 'file', type: 'text/markdown', getAsFile: () => file }] } })
    await waitFor(() => expect(screen.getByLabelText('待发送文件')).toHaveTextContent('notes.md'))

    fireEvent.change(input, { target: { value: '看一下这个' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      '/tmp/pi-dashboard-uploads/1-notes.md\n\n看一下这个', undefined,
    ))
    expect(input.value).toBe('')
  })

  it('attaches a pasted file name that resolves inside the workspace', async () => {
    vi.spyOn(api, 'browseFiles').mockResolvedValue({
      path: '/repo', parent: '/', entries: [{ name: 'design.md', path: '/repo/design.md', isDir: false }],
    })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<LiveSessionComposer status="idle" cwd="/repo" onSubmit={onSubmit} />)
    const input = screen.getByPlaceholderText('发送到运行中的 Pi…') as HTMLTextAreaElement

    fireEvent.paste(input, { clipboardData: { items: [{ kind: 'string', type: 'text/plain' }], getData: (type: string) => (type === 'text/plain' ? 'design.md' : '') } })
    await waitFor(() => expect(screen.getByLabelText('待发送文件')).toHaveTextContent('design.md'))
    expect(input.value).toBe('')
  })

  it('explains why a pasted name that exists only off-host cannot be attached', async () => {
    vi.spyOn(api, 'browseFiles').mockRejectedValue(new Error('ENOENT'))
    vi.spyOn(api, 'fileSearch').mockResolvedValue({ entries: [] })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<LiveSessionComposer status="idle" cwd="/repo" onSubmit={onSubmit} />)
    const input = screen.getByPlaceholderText('发送到运行中的 Pi…') as HTMLTextAreaElement

    fireEvent.paste(input, { clipboardData: { items: [{ kind: 'string', type: 'text/plain' }], getData: (type: string) => (type === 'text/plain' ? 'Local_Report.md' : '') } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Local_Report.md'))
    expect(input.value).toBe('Local_Report.md')
  })
})
