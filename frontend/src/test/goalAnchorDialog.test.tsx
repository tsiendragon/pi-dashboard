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

  it('renders a hierarchical goal as milestones with nested short actions', () => {
    render(
      <GoalAnchorDialog
        goal={anchor({
          objective: '证明定理 T',
          acceptanceCriteria: ['proofs/t.lean 被 Lean 接受，状态为 proved'],
          workItems: [
            {
              id: 'm1', title: 'Evidence closed', horizon: 'mid', state: 'done',
              doneWhen: ['evidence matrix has no gaps'], dependsOn: [], evidence: ['reports/evidence.md'],
            },
            {
              id: 'm2', title: 'Independent review', horizon: 'mid', state: 'in_progress',
              doneWhen: ['two reviews have no P0/P1'], dependsOn: ['m1'],
            },
            {
              id: 's2', title: 'Commission two reviews', horizon: 'short', parentId: 'm2',
              state: 'in_progress', dependsOn: [], evidence: ['reports/review.md'],
            },
          ],
        })}
        onClose={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: '任务锚点' })
    expect(dialog.textContent).toContain('里程碑 1/2')
    expect(dialog.textContent).toContain('下一步 0/1')
    expect(within(dialog).getByText('目标（长期）')).toBeInTheDocument()
    expect(within(dialog).getByText('完成标准')).toBeInTheDocument()
    expect(within(dialog).getByText('Independent review')).toBeInTheDocument()
    expect(within(dialog).getByText('Commission two reviews')).toBeInTheDocument()
    expect(within(dialog).getByText('当前')).toBeInTheDocument()
    expect(dialog.textContent).toContain('完成条件：two reviews have no P0/P1')
    expect(dialog.textContent).toContain('证据：reports/review.md')
  })

  it('pauses an active goal and resumes a paused one without asking for confirmation', () => {
    const pause = vi.fn()
    const close = vi.fn()
    const { unmount } = render(<GoalAnchorDialog goal={anchor()} onClose={close} onPause={pause} />)
    fireEvent.click(within(screen.getByRole('dialog', { name: '任务锚点' })).getByRole('button', { name: '暂停目标' }))
    expect(pause).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    unmount()

    const resume = vi.fn()
    render(<GoalAnchorDialog goal={anchor({ status: 'paused' })} onClose={vi.fn()} onResumeGoal={resume} />)
    fireEvent.click(within(screen.getByRole('dialog', { name: '任务锚点' })).getByRole('button', { name: '恢复目标' }))
    expect(resume).toHaveBeenCalledOnce()
  })

  it('asks for explicit confirmation before clearing a goal', () => {
    const clear = vi.fn()
    const close = vi.fn()
    render(<GoalAnchorDialog goal={anchor()} onClose={close} onClearGoal={clear} />)
    const dialog = screen.getByRole('dialog', { name: '任务锚点' })

    fireEvent.click(within(dialog).getByRole('button', { name: '清理目标' }))
    const confirm = screen.getByRole('alertdialog', { name: '清理目标确认' })
    expect(clear).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(clear).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog', { name: '清理目标确认' })).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: '清理目标' }))
    fireEvent.click(within(screen.getByRole('alertdialog', { name: '清理目标确认' })).getByRole('button', { name: '确认清理' }))
    expect(clear).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
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
        session('d', { goal: { done: 1, total: 4, needsUser: 0, status: 'active', stale: false, milestonesDone: 1, milestonesTotal: 3 } }),
        session('c'),
      ]}
      onSelect={vi.fn()}
    />)

    expect(screen.getByText('2/5')).toBeInTheDocument()
    expect(screen.getByText('M1/3')).toBeInTheDocument()
    expect(screen.getByText('需核对')).toBeInTheDocument()
    // A session with no goal draws no badge at all.
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })
})