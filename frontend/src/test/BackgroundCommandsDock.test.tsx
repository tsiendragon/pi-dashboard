import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BackgroundCommandsDock from '../features/background-commands/BackgroundCommandsDock'

const state = vi.hoisted(() => ({
  tasks: [] as Array<Record<string, unknown>>,
  send: vi.fn(async () => ({})),
}))

vi.mock('../features/useIntegration', () => ({
  useIntegration: () => ({
    attached: true,
    pending: 0,
    error: undefined,
    snapshot: { revision: 1, tasks: state.tasks },
    send: state.send,
  }),
}))

function task(overrides: Record<string, unknown>) {
  return {
    taskId: 'bash-t001',
    title: 'sleep 30',
    status: 'running',
    command: 'sleep 30',
    cwd: '/tmp',
    startedAt: Date.now(),
    outputBytes: 0,
    outputFile: '/tmp/bash-t001.log',
    outputTail: '',
    ...overrides,
  }
}

describe('BackgroundCommandsDock', () => {
  beforeEach(() => {
    state.tasks = []
    state.send.mockClear()
  })

  afterEach(() => cleanup())

  it('moves a running foreground command to the background', async () => {
    state.tasks = [task({ mode: 'foreground', toolCallId: 'tool-call-1' })]

    render(<BackgroundCommandsDock slot="slot-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Move to background' }))

    await waitFor(() => expect(state.send).toHaveBeenCalledWith({ type: 'background', toolCallId: 'tool-call-1' }))
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('keeps cancel for background commands', async () => {
    state.tasks = [task({ mode: 'background' })]

    render(<BackgroundCommandsDock slot="slot-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(state.send).toHaveBeenCalledWith({ type: 'cancel', taskId: 'bash-t001' }))
    expect(screen.queryByRole('button', { name: 'Move to background' })).toBeNull()
  })
})
