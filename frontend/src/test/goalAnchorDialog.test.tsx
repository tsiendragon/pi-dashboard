/**
 * Task anchor: the dialog itself and the session-list badge.
 *
 * The dialog is deliberately value-driven (no fetching), so these tests cover the
 * two states the live page could not show before: a finished session's snapshot,
 * and a checklist that has gone quiet while the goal is still open.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionSummary } from '@shared/live-sessions'
import { GOAL_STALE_MESSAGE_THRESHOLD, type GoalAnchor } from '@shared/goal-anchor'
import GoalAnchorDialog from '../features/live-sessions/goal/GoalAnchorDialog'
import LiveSessionsList from '../features/live-sessions/LiveSessionsList'

afterEach(() => vi.restoreAllMocks())

function anchor(overrides: Partial<GoalAnchor> = {}): GoalAnchor {
  return {
    objective: '完成新增九国的 OCR benchmark',
    status: 'active',
    progress: { current: '计算正式指标' },
    blockers: [],
    acceptanceCriteria: ['范围与权威范围一致'],
    constraints: [],
    workItems: [
      { id: 'a', title: '冻结范围', state: 'done', dependsOn: [] },
      { id: 'b', title: '重跑推理', state: 'in_progress', dependsOn: ['a'] },
      { id: 'c', title: '更新报告', state: 'todo', dependsOn: ['b'] },
    ],
    sourceDocs: [{ path: 'tasks/ocr/PLAN.md', kind: 'doc', brief: '范围与合同' }],
    updatedAt: Date.now(),
    messagesSinceUpdate: 0,
    ...overrides,
  }
}

function session(processInstanceId: string, overrides: Partial<LiveSessionSummary> = {}): LiveSessionSummary {
  return {
    processInstanceId, sessionId: `session-${processInstanceId}`, pid: 101,
    cwd: '~/repos/worktree/task-a', canonicalCwd: '~/repos/worktree/task-a',
    mode: 'tui', status: 'idle', claim: { state: 'unclaimed' },
    startedAt: 1, lastActivityAt: 2, revision: 1, eventSequence: 0,
    ...overrides,
  }
}

describe('GoalAnchorDialog', () => {
  it('renders a finished session as a read-only snapshot with no write action', () => {
    render(<GoalAnchorDialog goal={anchor({ status: 'complete' })} mode="snapshot" onClose={vi.fn()} onResume={vi.fn()} />)

    const dialog = screen.getByRole('dialog', { name: '任务锚点' })
    expect(within(dialog).getByText('只读快照')).toBeInTheDocument()
    expect(within(dialog).getByText('会话已结束')).toBeInTheDocument()
    expect(within(dialog).getByText('1/3 完成')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '在新会话里继续' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '让 agent 同步清单' })).not.toBeInTheDocument()
  })

  it('explains why a quiet checklist is probably out of date', () => {
    render(
      <GoalAnchorDialog
        goal={anchor({ messagesSinceUpdate: GOAL_STALE_MESSAGE_THRESHOLD })}
        mode="live"
        onClose={vi.fn()}
        onSync={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: '任务锚点' })
    expect(within(dialog).getByText('这份清单可能过期')).toBeInTheDocument()
    expect(dialog.textContent).toContain('对话记录没有更新')
  })

  it('uses the acceptance-criteria wording without pretending they are tickable', () => {
    render(<GoalAnchorDialog goal={anchor()} onClose={vi.fn()} />)

    const dialog = screen.getByRole('dialog', { name: '任务锚点' })
    fireEvent.click(within(dialog).getByText(/更多详情/))
    expect(within(dialog).getByText('范围与权威范围一致')).toBeInTheDocument()
    expect(dialog.textContent).toContain('验收标准没有单条勾选状态')
  })

  it('shows a loading state instead of the empty state before the timeline arrives', () => {
    render(<GoalAnchorDialog goal={null} loaded={false} onClose={vi.fn()} />)

    const dialog = screen.getByRole('dialog', { name: '任务锚点' })
    expect(within(dialog).getByRole('status')).toHaveTextContent('正在读取任务锚点')
    expect(within(dialog).queryByText('这条会话还没有设目标')).not.toBeInTheDocument()
  })
})

describe('LiveSessionsList goal badge', () => {
  it('shows checklist progress on rows that have a goal, and marks stale ones', () => {
    render(<LiveSessionsList
      sessions={[
        session('a', { goal: { done: 2, total: 5, needsUser: 1, status: 'active', stale: false } }),
        session('b', { goal: { done: 0, total: 4, needsUser: 0, status: 'complete', stale: true } }),
        session('c'),
      ]}
      onSelect={vi.fn()}
    />)

    expect(screen.getByText('2/5')).toBeInTheDocument()
    expect(screen.getByText('需核对')).toBeInTheDocument()
    // A session with no goal draws no badge at all.
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })
})