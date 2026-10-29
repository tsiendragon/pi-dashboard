import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ActivityTimeline from '../features/live-sessions/ActivityTimeline'
import { buildLiveActivities } from '../features/live-sessions/LiveSessionPage'

const COMMAND = 'npx vitest run src/test/liveToolEntries.test.ts'

function runningSession(entries: unknown[]) {
  return buildLiveActivities(entries, 'running', null)
}

const runningEntries = [
  { type: 'message', message: { role: 'user', content: '跑一下回归测试' } },
  { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'run-1', name: 'bash', arguments: { command: COMMAND } }] } },
  { type: 'tool_execution_start', data: { toolCallId: 'run-1', toolName: 'bash' } },
]

/** 点开命令 chip：弹层里能看到全文，运行中的前台命令还能一键转后台。 */
describe('activity command chip', () => {
  it('opens the command detail from the running step', () => {
    const onMove = vi.fn()
    render(<ActivityTimeline activities={runningSession(runningEntries)} onMoveToBackground={onMove} />)

    const chip = screen.getByRole('button', { name: new RegExp(`查看命令详情：${COMMAND}`) })
    fireEvent.click(chip)

    const dialog = screen.getByRole('dialog', { name: '命令详情' })
    expect(dialog.textContent).toContain(COMMAND)
    fireEvent.click(screen.getByRole('button', { name: '转到后台' }))
    expect(onMove).toHaveBeenCalledWith('run-1')
  })

  it('offers 转后台 only while a foreground command is running', () => {
    const { container } = render(<ActivityTimeline activities={runningSession(runningEntries)} onMoveToBackground={() => {}} />)
    expect(container.textContent).toContain('转后台')

    // 没有回调时按钮不出现（详情弹层同样不提供转后台）。
    const { container: withoutHandler } = render(<ActivityTimeline activities={runningSession(runningEntries)} />)
    expect(withoutHandler.textContent).not.toContain('转后台')
  })

  it('marks a command the background snapshot already took over', () => {
    const entries = [
      ...runningEntries,
      { type: 'live_feature_snapshot', data: { feature: 'background-commands', snapshot: { tasks: [{
        taskId: 'bg-1',
        toolCallId: 'run-1',
        mode: 'background',
        status: 'running',
        command: COMMAND,
        cwd: '/repo',
        startedAt: 1_700_000_000_000,
      }] } } },
    ]
    const activities = buildLiveActivities(entries, 'running', null)

    const step = activities.flatMap(activity => activity.steps).find(item => item.command)
    expect(step?.command).toMatchObject({ command: COMMAND, background: true, cwd: '/repo', toolCallId: 'run-1' })

    const { container } = render(<ActivityTimeline activities={activities} onMoveToBackground={() => {}} />)
    expect(container.textContent).toContain('已在后台')
    expect(container.textContent).not.toContain('转后台')
  })
})