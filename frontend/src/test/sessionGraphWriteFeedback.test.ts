/**
 * Why a graph write action could not run — and where its outcome is shown.
 *
 * Reported bug: “我在 graph 上点击了从此分叉之后 并没有创建新的 session”. The button was
 * disabled (or the request was refused by pi) and **nothing** was shown: `runCommand`
 * returned early, and pi's refusal only reached the terminal via `ctx.ui.notify`.
 * These tests pin down the two replacements — a written reason for every blocked
 * state, and a `tree_action` outcome that always lands in the UI.
 */
import { describe, expect, it } from 'vitest'
import { graphWriteBlockReason, treeActionFeedback, type TreeActionOutcome } from '../features/live-sessions/graph/SessionGraphPage'

const outcome = (overrides: Partial<TreeActionOutcome> = {}): TreeActionOutcome => ({
  action: 'fork',
  ok: true,
  entryId: 'e1',
  message: '已从 e1 分叉出新会话。',
  at: 1,
  ...overrides,
})

describe('graphWriteBlockReason', () => {
  it('explains that a session without a live process cannot be written to', () => {
    const reason = graphWriteBlockReason({ live: false, treeCapable: false, claimedByOther: false })
    expect(reason).toContain('没有在线的 Pi 进程')
  })

  it('tells the user to /reload when the pi extension is too old', () => {
    const reason = graphWriteBlockReason({ live: true, treeCapable: false, claimedByOther: false })
    expect(reason).toContain('/reload')
    expect(reason).toContain('session_tree')
  })

  it('explains a lease held by another browser', () => {
    const reason = graphWriteBlockReason({ live: true, treeCapable: true, claimedByOther: true })
    expect(reason).toContain('另一个浏览器')
  })

  it('returns no reason when the action can run', () => {
    expect(graphWriteBlockReason({ live: true, treeCapable: true, claimedByOther: false })).toBeUndefined()
  })
})

describe('treeActionFeedback', () => {
  it('shows a refusal — the case that used to be invisible', () => {
    const feedback = treeActionFeedback(outcome({ ok: false, message: '会话正在运行，请等当前回合结束后再分叉。' }))
    expect(feedback.error).toBe('会话正在运行，请等当前回合结束后再分叉。')
    expect(feedback.toast).toBeUndefined()
  })

  it('shows a success as a toast', () => {
    expect(treeActionFeedback(outcome()).toast).toBe('已从 e1 分叉出新会话。')
  })

  it('passes the deferred-file wording through, so the wait is explained', () => {
    const feedback = treeActionFeedback(outcome({ filePending: true, message: '已从 e1 分叉出新会话，但 pi 还没把它写入磁盘（该文件会随新会话的第一条回复生成）。' }))
    expect(feedback.toast).toContain('还没把它写入磁盘')
  })
})