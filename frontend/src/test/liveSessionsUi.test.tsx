import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LiveSessionSummary } from '@shared/live-sessions'
import LiveSessionComposer from '../features/live-sessions/LiveSessionComposer'
import LiveSessionsList from '../features/live-sessions/LiveSessionsList'

function session(processInstanceId: string, pid: number, cwd = '/mnt/workspace/lilong/repos/worktree/task-a'): LiveSessionSummary {
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
      session('a', 101, '/mnt/workspace/lilong/repos/worktree/task-a'),
      session('b', 202, '/mnt/workspace/lilong/repos/worktree/task-b'),
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

  it('accepts a pasted image and sends it with an optional prompt', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<LiveSessionComposer status="idle" onSubmit={onSubmit} />)
    const input = screen.getByPlaceholderText('发送到运行中的 Pi…') as HTMLTextAreaElement
    const file = new File(['image-bytes'], 'screen.png', { type: 'image/png' })
    fireEvent.paste(input, { clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] } })
    await waitFor(() => expect(screen.getByAltText('待发送图片 1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      '请分析这张图片。', undefined,
      [expect.objectContaining({ type: 'image', mimeType: 'image/png' })],
    ))
  })
})
