import { describe, expect, it } from 'vitest'
import { isWorkflowChild, projectStatus, projectSubagentSnapshot, projectTaskCounts, stableTaskId } from '../features/live-sessions/subagentProjection'

describe('subagent projection', () => {
  it('keeps unknown statuses visible instead of treating them as success', () => {
    expect(projectStatus('new-runner-state')).toBe('unknown')
    expect(projectStatus('failed')).toBe('attention')
    expect(projectStatus('completed')).toBe('completed')
    expect(projectStatus('disconnected')).toBe('attention')
  })

  it('counts failed and skipped tasks separately and does not invent zero progress', () => {
    expect(projectTaskCounts([])).toMatchObject({ total: 0, hasProgress: false, completed: 0 })
    expect(projectTaskCounts([{ id: 'a', status: 'completed' }, { id: 'b', status: 'failed' }, { id: 'c', status: 'skipped' }, { id: 'd', status: 'cancelled' }])).toMatchObject({ total: 4, completed: 1, failed: 1, skipped: 1, stopped: 1, hasProgress: true })
  })

  it('keeps direct work handles visible and uses logical task keys over execution IDs', () => {
    expect(isWorkflowChild({ subagentWorkId: 'work-direct' })).toBe(false)
    expect(stableTaskId({ key: 'logical-task', id: 'attempt-2' })).toBe('logical-task')
    const snapshot = projectSubagentSnapshot({ conversations: { items: [{ id: 'done', status: 'idle', latestRunStatus: 'completed' }] } }, 'workbench')
    expect(snapshot.topLevelConversations[0].status).toBe('completed')
  })

  it('does not count blocked/approval tasks as failures', () => {
    expect(projectTaskCounts([{ status: 'waiting_approval' }, { status: 'blocked' }, { status: 'failed' }])).toMatchObject({ failed: 1, attention: 2 })
  })

  it('uses stable ids and does not duplicate workflow children in the top-level list', () => {
    expect(stableTaskId({ key: 'task-key' }, 3)).toBe('task-key')
    expect(stableTaskId({}, 3)).toBe('task-3')
    expect(isWorkflowChild({ workflowId: 'workflow-1' })).toBe(true)
    expect(projectSubagentSnapshot({ conversations: { items: [{ id: 'child', workflowId: 'workflow-1' }, { id: 'top' }] }, workflows: { items: [{ id: 'workflow-1' }] } }, 'live-session').topLevelConversations.map(item => item.id)).toEqual(['top'])
  })
})
