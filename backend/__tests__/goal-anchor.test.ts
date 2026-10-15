/**
 * Goal anchor parsing and derived counts.
 *
 * The anchor is what keeps a long session honest: the dashboard shows its
 * checklist and flags it when the list and the goal disagree. These tests pin the
 * parsing contract and the two staleness rules.
 */
import { describe, expect, it } from 'vitest'
import {
  GOAL_STALE_MESSAGE_THRESHOLD,
  goalAnchorFromEntries,
  goalProgressOf,
  goalStaleness,
} from '../../shared/src/goal-anchor.js'

function goalEntry(state: unknown) {
  return { type: 'custom', customType: 'goal-state', data: { state }, timestamp: '2026-01-01T00:00:00.000Z' }
}

describe('goalAnchorFromEntries', () => {
  it('reads the newest goal state and ignores unrelated entries', () => {
    const anchor = goalAnchorFromEntries([
      { type: 'message', role: 'user' },
      goalEntry({ objective: 'Old goal', workItems: [], acceptanceCriteria: [] }),
      { type: 'custom', customType: 'goal-context', data: { state: { objective: 'injected context' } } },
      goalEntry({
        objective: 'Ship the anchor dialog',
        status: 'active',
        progress: { current: 'Render checklist', lastSummary: 'Dialog skeleton done', blocked: ['Need review'] },
        acceptanceCriteria: ['Show objective'],
        constraints: ['Do not edit the goal'],
        workItems: [
          { id: 'a', title: 'Checklist', state: 'done', dependsOn: [] },
          { id: 'b', title: 'Blocks', state: 'in_progress', dependsOn: ['a'] },
        ],
        sourceDocs: [{ path: 'tasks/x/PLAN.md', kind: 'doc', brief: 'Plan' }],
      }),
    ])

    expect(anchor).not.toBeNull()
    expect(anchor?.objective).toBe('Ship the anchor dialog')
    expect(anchor?.workItems.map(item => item.id)).toEqual(['a', 'b'])
    expect(anchor?.workItems[1]?.dependsOn).toEqual(['a'])
    // Free-text legacy blockers are kept, but never duplicated against structured ones.
    expect(anchor?.blockers).toEqual([{ title: 'Need review' }])
    expect(anchor?.updatedAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
  })

  it('returns null when the session never set a goal, and when the state is unusable', () => {
    expect(goalAnchorFromEntries([])).toBeNull()
    expect(goalAnchorFromEntries([{ type: 'message' }, { type: 'custom', customType: 'other', data: {} }])).toBeNull()
    expect(goalAnchorFromEntries([goalEntry({ status: 'active' })])).toBeNull()
  })

  it('counts only open blockers, and only messages after the newest goal update', () => {
    const anchor = goalAnchorFromEntries([
      { type: 'message' },
      goalEntry({
        objective: 'Count things',
        blockers: [
          { state: 'open', title: 'Open one', disposition: 'needs_user' },
          { state: 'resolved', title: 'Done one' },
        ],
      }),
      { type: 'message' },
      { type: 'custom', customType: 'goal-state', data: { state: { objective: 'Replaced goal' } } },
      { type: 'message' },
      { type: 'message' },
    ])

    expect(anchor?.objective).toBe('Replaced goal')
    expect(anchor?.blockers).toEqual([])
    expect(anchor?.messagesSinceUpdate).toBe(2)
  })
})

describe('goalProgressOf / goalStaleness', () => {
  const base = {
    objective: 'Goal',
    acceptanceCriteria: [],
    constraints: [],
    sourceDocs: [],
    progress: {},
    messagesSinceUpdate: 0,
  }

  it('counts finished items and user-owned blockers', () => {
    const progress = goalProgressOf({
      ...base,
      status: 'active',
      workItems: [
        { id: 'a', title: 'A', state: 'done', dependsOn: [] },
        { id: 'b', title: 'B', state: 'todo', dependsOn: [] },
      ],
      blockers: [
        { title: 'Ask user', disposition: 'needs_user' },
        { title: 'Wait', disposition: 'external_wait' },
      ],
    })

    expect(progress).toMatchObject({ done: 1, total: 2, needsUser: 1, stale: false })
    expect(goalProgressOf(null)).toBeNull()
  })

  it('flags a finished goal whose checklist was never ticked', () => {
    const anchor = {
      ...base,
      status: 'complete' as const,
      workItems: [
        { id: 'a', title: 'A', state: 'todo', dependsOn: [] },
        { id: 'b', title: 'B', state: 'todo', dependsOn: [] },
      ],
      blockers: [],
    }

    expect(goalStaleness(anchor)).toBe('complete_with_open_items')
    expect(goalProgressOf(anchor)?.stale).toBe(true)
  })

  it('flags a quiet checklist only after the message threshold', () => {
    const workItems = [
      { id: 'a', title: 'A', state: 'done', dependsOn: [] },
      { id: 'b', title: 'B', state: 'in_progress', dependsOn: [] },
    ]
    expect(goalStaleness({ ...base, status: 'active', workItems, messagesSinceUpdate: GOAL_STALE_MESSAGE_THRESHOLD - 1, blockers: [] })).toBeNull()
    expect(goalStaleness({ ...base, status: 'active', workItems, messagesSinceUpdate: GOAL_STALE_MESSAGE_THRESHOLD, blockers: [] })).toBe('no_recent_update')
    // A fully ticked checklist is never stale, however quiet the session gets.
    expect(goalStaleness({
      ...base,
      status: 'active',
      workItems: workItems.map(item => ({ ...item, state: 'done' as const })),
      messagesSinceUpdate: 999,
      blockers: [],
    })).toBeNull()
  })
})