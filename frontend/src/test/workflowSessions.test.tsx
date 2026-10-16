import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LiveSessionSummary } from '@shared/live-sessions'
import { linkedWorkflowSessions, workflowTaskSession } from '../features/live-sessions/workflowSessions'
import LiveWorkflowPanel from '../features/live-sessions/LiveWorkflowPanel'
import LiveWorkflowProgressCard from '../features/live-sessions/LiveWorkflowProgressCard'

const session: LiveSessionSummary = { processInstanceId: 'proc', sessionId: 'actual-pi-id', parentSessionId: 'parent', role: 'subagent', subagentWorkId: 'work-1', subagentTaskId: 'task-1', pid: 42, cwd: '/tmp', canonicalCwd: '/tmp', mode: 'rpc', status: 'idle', claim: { state: 'unclaimed' }, startedAt: 0, lastActivityAt: 0, revision: 1, eventSequence: 0 }
const workflow = { id: 'workflow_work-1', label: '检查工作流', status: 'completed', stages: [{ id: 'stage', label: '第一阶段', status: 'completed', tasks: [{ id: 'task-1', key: 'logical-task', label: '离线检查', sessionId: 'controller-id', status: 'completed', output: '完整结果仍在' }] }] }

describe('workflow task/session association', () => {
  it('matches a trace task identity even when the controller id differs from the actual Pi id', () => {
    expect(workflowTaskSession(workflow.stages[0].tasks[0], [session])).toBe(session)
    expect(linkedWorkflowSessions(workflow, [session])).toEqual([session])
    expect(workflowTaskSession({ id: 'unrelated', sessionId: 'other' }, [session])).toBeUndefined()
  })

  it('opens offline task output without requiring a live session', () => {
    render(<LiveWorkflowPanel workflow={workflow} sessions={[]} onClose={() => {}} onOpenSubagent={() => {}} />)
    fireEvent.click(screen.getByText('离线检查'))
    expect(screen.getByText('完整结果仍在')).toBeInTheDocument()
    expect(screen.getByText(/当前无实时连接/)).toBeInTheDocument()
  })

  it('opens exactly the matching live child instead of another task in the same workflow', () => {
    const onOpen = vi.fn()
    render(<LiveWorkflowPanel workflow={workflow} sessions={[session]} onClose={() => {}} onOpenSubagent={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: '实时详情', hidden: true }))
    expect(onOpen).toHaveBeenCalledWith('proc')
  })

  it('does not put interactive details inside a workflow card button or count approval as failure', () => {
    const { container } = render(<LiveWorkflowProgressCard workflow={{ ...workflow, status: 'running', stages: [{ id: 'stage', status: 'running', tasks: [{ id: 'task', status: 'waiting_approval' }] }] }} sessions={[]} onOpen={() => {}} />)
    expect(container.querySelector('button details')).toBeNull()
    expect(container.querySelector('button summary')).toBeNull()
    expect(screen.getByText('待处理 1')).toBeInTheDocument()
    expect(screen.queryByText('失败 1')).toBeNull()
  })
})
