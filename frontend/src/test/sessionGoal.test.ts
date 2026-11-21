import { describe, expect, it } from 'vitest'
import { goalWorkPlan } from '@shared/goal-anchor'
import { sessionGoalFromEntries } from '../features/live-sessions/sessionGoal'

describe('sessionGoalFromEntries', () => {
  it('reads the latest goal, progress, details and open blockers', () => {
    const result = sessionGoalFromEntries([
      { type: 'custom', customType: 'goal-state', data: { state: { objective: 'Old goal' } } },
      {
        type: 'custom',
        customType: 'goal-state',
        data: {
          state: {
            objective: 'Ship the dashboard goal dialog',
            status: 'active',
            progress: {
              current: 'Render goal details',
              lastSummary: 'The status popup is implemented',
              blocked: ['Need approval', 'Write the test'],
            },
            acceptanceCriteria: ['Show current objective', 'Show open blockers'],
            constraints: ['Do not send /goal as chat input'],
            workItems: [{
              id: 'goal-dialog',
              title: 'Render goal details',
              state: 'in_progress',
              description: 'Show the current progress and acceptance criteria',
              dependsOn: [],
            }],
            sourceDocs: [{ path: 'docs/goal-ui.md', kind: 'prd', brief: 'Goal dialog requirements' }],
            blockers: [
              {
                state: 'open',
                title: 'Need approval',
                reason: 'Waiting for a decision',
                owner: 'user',
                kind: 'user_decision',
                disposition: 'needs_user',
                proposedResolution: 'Ask the owner to approve',
              },
              { state: 'resolved', title: 'Old blocker', reason: 'Already fixed' },
            ],
          },
        },
      },
    ])

    expect(result).toEqual({
      objective: 'Ship the dashboard goal dialog',
      status: 'active',
      progress: {
        current: 'Render goal details',
        lastSummary: 'The status popup is implemented',
      },
      blockers: [
        {
          title: 'Need approval',
          reason: 'Waiting for a decision',
          kind: 'user_decision',
          disposition: 'needs_user',
          owner: 'user',
          proposedResolution: 'Ask the owner to approve',
        },
        { title: 'Write the test' },
      ],
      acceptanceCriteria: ['Show current objective', 'Show open blockers'],
      constraints: ['Do not send /goal as chat input'],
      messagesSinceUpdate: 0,
      workItems: [{
        id: 'goal-dialog',
        title: 'Render goal details',
        state: 'in_progress',
        description: 'Show the current progress and acceptance criteria',
        dependsOn: [],
      }],
      sourceDocs: [{ path: 'docs/goal-ui.md', kind: 'prd', brief: 'Goal dialog requirements' }],
    })
  })

  it('groups milestones and short actions, and marks the current milestone', () => {
    const goal = sessionGoalFromEntries([
      {
        type: 'custom',
        customType: 'goal-state',
        data: {
          state: {
            objective: '证明定理 T',
            status: 'active',
            workItems: [
              {
                id: 'm1', title: 'Evidence closed', horizon: 'mid', state: 'done',
                doneWhen: ['evidence matrix has no gaps'], dependsOn: [], evidence: ['reports/evidence.md'],
              },
              {
                id: 'm2', title: 'Independent review', horizon: 'mid', state: 'todo',
                doneWhen: ['two reviews have no P0/P1'], dependsOn: ['m1'],
              },
              {
                id: 's2', title: 'Commission two reviews', horizon: 'short', parentId: 'm2',
                state: 'todo', dependsOn: [], evidence: ['reports/review.md'],
              },
            ],
            acceptanceCriteria: ['T is proved'],
          },
        },
      },
    ])

    expect(goal?.workItems[0]).toMatchObject({
      horizon: 'mid', doneWhen: ['evidence matrix has no gaps'], evidence: ['reports/evidence.md'],
    })
    const plan = goalWorkPlan(goal)
    expect(plan?.currentId).toBe('m2')
    expect(plan?.milestones).toEqual([
      expect.objectContaining({ current: false, actions: [] }),
      expect.objectContaining({
        current: true,
        actions: [expect.objectContaining({ id: 's2', horizon: 'short', parentId: 'm2' })],
      }),
    ])
  })

  it('returns empty when the session has no goal or the latest state cleared it', () => {
    expect(sessionGoalFromEntries([])).toBeNull()
    expect(sessionGoalFromEntries([
      { type: 'custom', customType: 'goal-state', data: { state: { objective: 'Old goal' } } },
      { type: 'custom', customType: 'goal-state', data: { state: null } },
    ])).toBeNull()
  })
})
