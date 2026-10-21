import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LiveSessionSummary } from '@shared/live-sessions'
import { projectSubagentSessions, subagentGroups } from '../features/live-sessions/subagentSessions'
import LiveSubagentStrip from '../features/live-sessions/LiveSubagentStrip'
import LiveSubagentRecordPanel from '../features/live-sessions/LiveSubagentRecordPanel'
import LiveSubagentPanel from '../features/live-sessions/LiveSubagentPanel'

const child = (workId = 'work-1'): LiveSessionSummary => ({
  processInstanceId: 'proc-1', sessionId: 'pi-session', parentSessionId: 'parent', role: 'subagent',
  subagentWorkId: workId, pid: 42, cwd: '/tmp/project', canonicalCwd: '/tmp/project', mode: 'rpc',
  status: 'idle', claim: { state: 'unclaimed' }, startedAt: 0, lastActivityAt: 0, revision: 1, eventSequence: 0,
})

describe('subagent task/session projection', () => {
  it('matches a work handle through jobs and keeps completed tasks out of active work', () => {
    const items = projectSubagentSessions([child()], {
      jobs: { items: [{ kind: 'agent', workId: 'work-1', sessionId: 'controller-session', status: 'completed' }] },
      conversations: { items: [{ id: 'controller-session', label: '检查代码', status: 'idle', latestRunStatus: 'completed' }] },
    })
    expect(items).toHaveLength(1)
    expect(items[0].session?.processInstanceId).toBe('proc-1')
    expect(subagentGroups(items).active).toHaveLength(0)
    expect(subagentGroups(items).completed).toHaveLength(1)
  })

  it('does not guess completion from idle or incorrectly match missing work identifiers', () => {
    const items = projectSubagentSessions([child()], {
      jobs: { items: [{ kind: 'agent', workId: 'unrelated', sessionId: 'other', status: 'completed' }] },
      conversations: { items: [{ id: 'unknown-session', label: '待确认', status: 'idle' }] },
    })
    expect(items).toHaveLength(2)
    expect(items.every(item => item.bucket === 'unknown')).toBe(true)
  })

  it('uses explicit tool result status, including failed and cancelled, without hiding unknown records', () => {
    expect(projectSubagentSessions([child()], {}, { 'work-1': 'completed' })[0].bucket).toBe('completed')
    expect(projectSubagentSessions([child()], {}, { 'work-1': 'failed' })[0].bucket).toBe('attention')
    expect(projectSubagentSessions([child()], {}, { 'work-1': 'cancelled' })[0].bucket).toBe('stopped')
    expect(projectSubagentSessions([child()], {})[0].bucket).toBe('unknown')
  })

  it('keeps an offline result and excludes only explicitly associated workflow children', () => {
    const items = projectSubagentSessions([], { conversations: { items: [
      { id: 'done', status: 'idle', latestRunStatus: 'completed', resultPreview: '检查通过' },
      { id: 'workflow-child', workflowId: 'flow', status: 'running' },
    ] } })
    expect(items).toHaveLength(1)
    expect(items[0].record?.resultPreview).toBe('检查通过')
    expect(items[0].session).toBeUndefined()
  })

  it('uses a known workflow identity, not a generic work-id prefix, to associate child sessions', () => {
    const items = projectSubagentSessions([child('flow:stage:task'), { ...child('work-direct'), processInstanceId: 'proc-2', sessionId: 'pi-2' }], {
      workflows: { items: [{ id: 'flow', stages: [] }] },
    })
    expect(items.map(item => item.id)).toEqual(['work-direct'])
  })
})

describe('subagent grouped UI', () => {
  it('folds twenty completed results while keeping every result selectable', () => {
    const items = projectSubagentSessions([], { conversations: { items: Array.from({ length: 20 }, (_, i) => ({
      id: `task-${i}`, label: `检查 ${i}`, latestRunStatus: 'completed', status: 'idle',
    })) } })
    const onFocus = vi.fn()
    const { container } = render(<LiveSubagentStrip items={items} onFocus={onFocus} onStop={() => {}} />)
    expect(screen.queryByText(/运行中 ·/)).toBeNull()
    expect(container.querySelector('details')?.open).toBe(false)
    expect(screen.getByText('已完成 · 20')).toBeInTheDocument()
    fireEvent.click(screen.getByText('检查 0'))
    expect(onFocus).toHaveBeenCalledWith(items[0])
  })

  it('shows an explicit second-step stop button instead of conflating stop and collapse', () => {
    const items = projectSubagentSessions([{ ...child(), status: 'running' }], {})
    const { rerender } = render(<LiveSubagentStrip items={items} onFocus={() => {}} onStop={() => {}} />)
    expect(screen.getByRole('button', { name: '停止子助手：子助手' })).toHaveTextContent('停止')
    rerender(<LiveSubagentStrip items={items} confirmCloseId="proc-1" onFocus={() => {}} onStop={() => {}} />)
    expect(screen.getByRole('button', { name: '停止子助手：子助手' })).toHaveTextContent('确认停止')
  })

  it('folds failures automatically, allows reversible dismissal without stopping, and reveals a retry', () => {
    const feature = { conversations: { items: [{ id: 'failed', label: '失败任务', latestRunStatus: 'failed', error: 'boom' }] } }
    const items = projectSubagentSessions([], feature)
    const onStop = vi.fn()
    const onFocus = vi.fn()
    const { container, rerender } = render(<LiveSubagentStrip items={items} onFocus={onFocus} onStop={onStop} />)
    expect(container.querySelector('details')?.open).toBe(false)
    fireEvent.click(screen.getByText('执行失败 · 1（展开查看原因）'))
    fireEvent.click(screen.getByText('失败任务'))
    expect(onFocus).toHaveBeenCalledWith(items[0])
    fireEvent.click(screen.getByRole('button', { name: '收起记录：失败任务' }))
    expect(screen.queryByText('失败任务')).toBeNull()
    expect(onStop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '恢复收起的记录' }))
    expect(screen.getByText('失败任务')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '收起记录：失败任务' }))
    const retry = projectSubagentSessions([], { conversations: { items: [{ ...feature.conversations.items[0], activeRunId: 'retry' }] } })
    rerender(<LiveSubagentStrip items={retry} onFocus={onFocus} onStop={onStop} />)
    expect(screen.getByText('失败任务')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '收起记录：失败任务' })).toBeNull()
    expect(screen.getByText('运行中 · 1')).toBeInTheDocument()
  })

  it('keeps disconnected unknown tasks visible without claiming that they stopped', () => {
    const items = projectSubagentSessions([], { conversations: { items: [{ id: 'unknown', label: '待确认任务', status: 'idle' }] } })
    const { container } = render(<LiveSubagentStrip items={items} onFocus={() => {}} onStop={() => {}} />)
    expect(screen.getByText('待确认任务')).toBeInTheDocument()
    expect(container.querySelector('details')).toBeNull()
    expect(screen.getByText('状态待确认 · 无实时连接')).toBeInTheDocument()
  })

  it('explains missing models and confirmed process exits while preserving the original error', () => {
    const error = 'Pi RPC process exited (code=1 signal=null); stderr: Error: Model "azure-gateway/gpt-5.6-luna" not found.'
    const { rerender } = render(<LiveSubagentRecordPanel record={{ error }} onClose={() => {}} />)
    expect(screen.getByText(/子助手进程已退出/)).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('所选模型不可用')
    expect(screen.getByText(error)).toBeInTheDocument()
    expect(screen.getByText('子助手在模型启动阶段退出，本次没有生成结果。')).toBeInTheDocument()
    rerender(<LiveSubagentRecordPanel record={{ error, activeRunId: 'retry' }} onClose={() => {}} />)
    expect(screen.queryByText(/子助手进程已退出/)).toBeNull()
    rerender(<LiveSubagentRecordPanel record={{ error: '网络断开' }} onClose={() => {}} />)
    expect(screen.getByText(/不代表执行进程已退出/)).toBeInTheDocument()
    expect(screen.queryByText(/所选模型不可用/)).toBeNull()
  })

  it('retains detail text when disconnected and disables a dead live route', () => {
    render(<LiveSubagentPanel summary={child()} disconnected detail={{ summary: child(), entries: [
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '结果仍可阅读' }] } },
    ] }} onClose={() => {}} />)
    expect(screen.getByText('结果仍可阅读')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '完整页' })).toBeDisabled()
    expect(screen.getByText('当前无连接')).toBeInTheDocument()
  })

  it('shows saved result previews and marks partial results honestly', () => {
    render(<LiveSubagentRecordPanel record={{ label: '检查', model: 'model-a', resultPreview: '快照结果', resultTruncated: true }} onClose={() => {}} />)
    expect(screen.getByText('快照结果')).toBeInTheDocument()
    expect(screen.getByText('这里只展示结果摘要，完整结果未删除。')).toBeInTheDocument()
  })
})
