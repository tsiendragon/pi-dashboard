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
})
