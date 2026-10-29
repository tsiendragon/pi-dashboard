import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import LiveCommandChips, { collectCommandChips, type ForegroundToolInput } from '../features/live-sessions/LiveCommandChips'
import { collectToolStates, latestUserMessageAt } from '../features/live-sessions/LiveSessionPage'

const ROUND_START = 1_000_000

function tool(partial: Partial<ForegroundToolInput> & { toolCallId: string }): ForegroundToolInput {
  return { called: true, started: true, ended: false, abandoned: false, command: 'echo hi', ...partial }
}

describe('collectCommandChips', () => {
  it('keeps running commands from any round but finished ones only from the latest round', () => {
    const chips = collectCommandChips([
      tool({ toolCallId: 'old-done', command: 'ls', startedAtMs: ROUND_START - 5_000, ended: true, result: { text: 'a' } }),
      tool({ toolCallId: 'new-done', command: 'git status', startedAtMs: ROUND_START + 1_000, ended: true, result: { text: 'ok' } }),
      tool({ toolCallId: 'running', command: 'npm run build', startedAtMs: ROUND_START + 2_000 }),
    ], {
      'background-commands': { tasks: [
        { taskId: 'bash-old1', status: 'running', command: 'python train.py', startedAt: ROUND_START - 60_000 },
        { taskId: 'bash-old2', status: 'exited', exitCode: 0, command: 'rsync', startedAt: ROUND_START - 60_000, endedAt: ROUND_START - 10_000 },
        { taskId: 'bash-new1', status: 'exited', exitCode: 2, command: 'pytest', startedAt: ROUND_START - 60_000, endedAt: ROUND_START + 500 },
      ] },
    }, ROUND_START)

    expect(chips.map(chip => [chip.key, chip.kind, chip.state])).toEqual([
      ['tool:running', 'foreground', 'running'],
      ['task:bash-old1', 'background', 'running'],
      ['tool:new-done', 'foreground', 'done'],
      ['task:bash-new1', 'background', 'failed'],
    ])
  })

  it('prefers the background-commands mirror of a foreground bash run and skips tools without a command', () => {
    const chips = collectCommandChips([
      tool({ toolCallId: 'toolu_1', command: 'make test' }),
      tool({ toolCallId: 'toolu_read', command: undefined, toolName: 'read' }),
    ], {
      'background-commands': { tasks: [
        { taskId: 'bash-fg01', status: 'running', mode: 'foreground', toolCallId: 'toolu_1', command: 'make test', cwd: '/repo', startedAt: ROUND_START, outputTail: 'line 1' },
      ] },
    }, ROUND_START)

    expect(chips).toHaveLength(1)
    expect(chips[0]).toMatchObject({ key: 'task:bash-fg01', kind: 'foreground', state: 'running', cwd: '/repo', toolCallId: 'toolu_1', output: 'line 1' })
  })
})

describe('collectToolStates timing', () => {
  it('records when a tool started and ended', () => {
    const states = collectToolStates([
      { type: 'tool_execution_start', timestamp: ROUND_START, data: { toolCallId: 't1', toolName: 'bash' } },
      { type: 'tool_execution_end', timestamp: ROUND_START + 3_000, data: { toolCallId: 't1', toolName: 'bash' } },
    ])
    expect(states.get('t1')).toMatchObject({ startedAtMs: ROUND_START, endedAtMs: ROUND_START + 3_000 })
  })
})

describe('LiveCommandChips', () => {
  it('opens details and moves a running foreground command to the background', async () => {
    const onMove = vi.fn().mockResolvedValue(undefined)
    render(<LiveCommandChips onMoveToBackground={onMove} chips={collectCommandChips([], {
      'background-commands': { tasks: [
        { taskId: 'bash-fg01', status: 'running', mode: 'foreground', toolCallId: 'toolu_1', command: 'make test', cwd: '/repo', startedAt: Date.now(), outputTail: 'compiling…' },
        { taskId: 'bash-bg01', status: 'running', command: 'python train.py', startedAt: Date.now() },
      ] },
    })} />)

    fireEvent.click(screen.getByRole('listitem', { name: '前台命令：make test' }))
    const dialog = screen.getByRole('dialog', { name: '命令详情' })
    expect(within(dialog).getByText('/repo')).toBeTruthy()
    expect(within(dialog).getByText('compiling…')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '转到后台' }))
    expect(onMove).toHaveBeenCalledWith('toolu_1')
    // 转完按钮就地变成「已转到后台」，避免重复点击。
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '已转到后台' })).toBeDisabled())

    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    fireEvent.click(screen.getByRole('listitem', { name: '后台命令：python train.py' }))
    expect(within(screen.getByRole('dialog', { name: '命令详情' })).queryByRole('button', { name: '转到后台' })).toBeNull()
  })
})

describe('latestUserMessageAt', () => {
  const user = (timestamp?: number) => ({ type: 'message', ...(timestamp ? { timestamp } : {}), message: { role: 'user', content: 'hi', ...(timestamp ? { timestamp } : {}) } })
  const toolResult = (timestamp: number) => ({ type: 'message', message: { role: 'toolResult', toolCallId: 'x', content: 'ok', timestamp } })

  it('uses the newest user message timestamp', () => {
    expect(latestUserMessageAt([user(100), toolResult(150), user(200)], {})).toBe(200)
  })

  it('treats a just-sent local prompt as starting after everything seen so far', () => {
    const at = latestUserMessageAt([user(100), toolResult(150), user()], {
      'background-commands': { tasks: [{ taskId: 'bash-a', status: 'exited', startedAt: 120, endedAt: 180 }] },
    })
    expect(at).toBe(181)
    const chips = collectCommandChips([
      { toolCallId: 'old', command: 'ls', called: true, started: true, ended: true, abandoned: false, startedAtMs: 140, result: { text: 'a' } },
    ], { 'background-commands': { tasks: [{ taskId: 'bash-a', status: 'exited', exitCode: 0, command: 'make', startedAt: 120, endedAt: 180 }] } }, at)
    expect(chips).toEqual([])
  })
})
