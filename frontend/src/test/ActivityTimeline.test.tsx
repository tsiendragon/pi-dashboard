import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ActivityTimeline from '../features/live-sessions/ActivityTimeline'

describe('ActivityTimeline', () => {
  it('shows quote/comment follow-ups inside the activity that owns them', () => {
    render(<ActivityTimeline activities={[
      {
        id: 'activity-1',
        title: '核对近期订单',
        sourceLabel: '用户请求',
        status: 'done',
        steps: [{ id: 'read', label: '读取订单记录', status: 'done', entryIndex: 2 }],
        replies: [],
        followUps: [
          { id: 'follow-up-3', kind: 'quote', text: '引用（来自 Agent 回复）：\n> 订单金额和时间都对得上\n\n那渠道为什么缺？', entryIndex: 3 },
          { id: 'follow-up-5', kind: 'comment', text: 'Please review and address the comment in docs/plan.md:', entryIndex: 5, queued: true },
          {
            id: 'follow-up-7',
            kind: 'comment',
            entryIndex: 7,
            text: ['Please review and address these comments about the quoted parts of our conversation:', '', '[1] Agent 回复', 'Quoted: "订单金额和时间都对得上"', 'Comment: 这条结论要补上渠道字段的依据', '', '[2] Agent 回复', 'Quoted: "风险入口已检查"', 'Comment: 说明检查了哪些入口'].join('\n'),
          },
        ],
      },
    ]} />)

    const card = screen.getByRole('article')
    expect(within(card).getByText(/引用 \/ 批注追问 · 3 条/)).toBeInTheDocument()
    expect(within(card).getByText(/并入本活动，不另开一个/)).toBeInTheDocument()
    expect(within(card).getByText('引用回复')).toBeInTheDocument()
    expect(within(card).getAllByText('批注')).toHaveLength(2)
    // 排队中的追问明确标出来，且不进入「排队中的输入」那一行。
    expect(within(card).getByText('排队中，等 Pi 接手')).toBeInTheDocument()
    expect(within(card).queryByText(/排队中的输入/)).toBeNull()
    // 长追问（多轮批注）可以展开看全文，默认只露前三行。
    const longBody = within(card).getByText(/\[2\] Agent 回复/)
    expect(longBody.className).toContain('line-clamp-3')
    fireEvent.click(within(card).getAllByRole('button', { name: '展开批注追问全文' })[0])
    expect(longBody.className).not.toContain('line-clamp-3')
  })

  it('interleaves follow-ups and replies by when they actually happened', () => {
    render(<ActivityTimeline activities={[{
      id: 'activity-1',
      title: '补齐三个模型的状态',
      sourceLabel: '用户请求',
      status: 'done',
      steps: [],
      replies: [
        { id: 'reply-1', text: '模型文件都齐了，但服务还没真跑通。', kind: 'final', entryIndex: 4, related: [] },
        { id: 'reply-2', text: '服务已起，冒烟测试通过。', kind: 'final', entryIndex: 12, related: [] },
      ],
      followUps: [
        { id: 'follow-up-8', kind: 'quote', text: '引用（来自 Agent 回复）：\n> 模型文件都齐了\n\n那先把服务起来验证？', entryIndex: 8 },
        { id: 'follow-up-20', kind: 'comment', text: 'Please review and address the comment in docs/plan.md:', entryIndex: 20 },
      ],
    }]} />)

    const activity = screen.getByRole('article')
    // 两种内容合成一条时间线：标题只报总数，不再各自分段。
    expect(within(activity).getByText('Agent 回复 · 2 条')).toBeInTheDocument()
    expect(within(activity).getByText(/引用 \/ 批注追问 · 2 条（并入本活动，不另开一个）/)).toBeInTheDocument()
    const text = activity.textContent ?? ''
    const order = ['模型文件都齐了', '那先把服务起来验证？', '服务已起，冒烟测试通过。', 'docs/plan.md'].map(needle => text.indexOf(needle))
    expect(order.every(position => position >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((left, right) => left - right))
  })

  it('renders activities in chronological order with explicit step completion states', () => {
    render(<ActivityTimeline activities={[
      {
        id: 'activity-1',
        title: '核对近期出金订单',
        sourceLabel: 'Agent 阶段报告',
        startedAt: '2026-10-08 10:42:05',
        status: 'done',
        plan: {
          lines: [{
            text: '先核对订单金额、时间与渠道，再确认是否需要升级。',
            entryIndex: 1,
            related: ['检查订单数据：orders.csv'],
          }],
          items: [{ id: 'plan-1', label: '核对订单', status: 'done', entryIndex: 1 }],
        },
        replies: [],
        steps: [
          { id: 'read', label: '检查订单数据', detail: 'orders.csv', status: 'done', entryIndex: 2 },
          { id: 'query', label: '核对交易通道', detail: 'Web · 3 条记录', status: 'done', entryIndex: 4 },
        ],
      },
      {
        id: 'activity-2',
        title: '检查风险请求入口',
        sourceLabel: 'Agent 进度说明',
        startedAt: '2026-10-08 10:55:26',
        status: 'running',
        plan: { lines: [], items: [] },
        replies: [{
          id: 'reply-2-1',
          text: '先在风险入口里定位这段代码。',
          kind: 'commentary',
          entryIndex: 6,
          related: ['定位入口代码：risk_router.py', '运行回归测试：vitest'],
        }],
        steps: [
          { id: 'search', label: '定位入口代码', detail: 'risk_router.py', status: 'done', entryIndex: 7 },
          { id: 'test', label: '运行回归测试', detail: 'vitest', status: 'running', entryIndex: 9 },
          { id: 'verify', label: '核实结果', status: 'pending', entryIndex: 11 },
          { id: 'compare', label: '对照订单与风险记录', status: 'pending', entryIndex: 12 },
          { id: 'report', label: '整理最终报告', status: 'pending', entryIndex: 13 },
          { id: 'update', label: '更新分析结论', status: 'pending', entryIndex: 14 },
        ],
      },
    ]} />)

    const activities = screen.getAllByRole('article')
    expect(activities).toHaveLength(2)
    expect(within(activities[0]!).getByText('活动 1')).toBeTruthy()
    expect(within(activities[0]!).getByText('核对近期出金订单')).toBeTruthy()
    // 活动徽标 + 2 个步骤 + 1 个计划要点
    expect(within(activities[0]!).getAllByText('已完成')).toHaveLength(4)
    expect(within(activities[0]!).getByText('检查订单数据')).toBeTruthy()
    expect(within(activities[0]!).getByText('Agent 计划')).toBeTruthy()
    expect(within(activities[0]!).getByText('先核对订单金额、时间与渠道，再确认是否需要升级。')).toBeTruthy()
    expect(within(activities[0]!).getByText('核对订单')).toBeTruthy()
    expect(within(activities[0]!).getByText('接着做了：检查订单数据：orders.csv')).toBeTruthy()
    expect(within(activities[1]!).queryByText('Agent 计划')).toBeNull()
    expect(within(activities[1]!).getByText('活动 2')).toBeTruthy()
    expect(within(activities[1]!).getByText('检查风险请求入口')).toBeTruthy()
    expect(within(activities[1]!).getAllByText('进行中')).toHaveLength(2)
    expect(within(activities[1]!).getAllByText('未完成')).toHaveLength(3)
    expect(within(activities[0]!).queryByText('Agent 回复')).toBeNull()
    expect(within(activities[1]!).getByText('Agent 回复')).toBeTruthy()
    expect(within(activities[1]!).getByText('进度说明')).toBeTruthy()
    expect(within(activities[1]!).getByText('先在风险入口里定位这段代码。')).toBeTruthy()
    expect(within(activities[1]!).getByText('接着做了：定位入口代码：risk_router.py、运行回归测试：vitest')).toBeTruthy()
    expect(within(activities[1]!).queryByText('更新分析结论')).toBeNull()
    fireEvent.click(within(activities[1]!).getByRole('button', { name: '展开其余 1 项' }))
    expect(within(activities[1]!).getByText('更新分析结论')).toBeTruthy()
    // 2 个已完成步骤 + 1 个已完成计划要点 + 活动 2 的 1 个已完成步骤
    expect(screen.getAllByLabelText('已完成')).toHaveLength(4)
  })

  it('renders the agent reply body and collapses a long one', () => {
    const longReply = Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行说明`).join('\n')
    render(<ActivityTimeline activities={[{
      id: 'activity-1',
      title: '核对近期出金订单',
      sourceLabel: '用户请求',
      startedAt: '2026-10-08 10:42:05',
      status: 'done',
      steps: [],
      replies: [
        { id: 'reply-1', text: '核对完成：3 笔订单全部匹配。', kind: 'final', entryIndex: 3, related: [] },
        { id: 'reply-2', text: longReply, kind: 'commentary', entryIndex: 5, related: [] },
      ],
    }]} />)

    const activity = screen.getByRole('article')
    expect(within(activity).getByText('Agent 回复 · 2 条')).toBeTruthy()
    expect(within(activity).getByText('回复正文')).toBeTruthy()
    expect(within(activity).getByText('核对完成：3 笔订单全部匹配。')).toBeTruthy()
    expect(within(activity).queryByText(/第 20 行说明/)).toBeNull()
    fireEvent.click(within(activity).getByRole('button', { name: '展开全部正文（20 行）' }))
    expect(within(activity).getByText(/第 20 行说明/)).toBeTruthy()
    expect(within(activity).getByRole('button', { name: '收起正文' })).toBeTruthy()
  })

  it('marks agent text as quotable so replies can be quoted or commented', () => {
    render(<ActivityTimeline activities={[{
      id: 'activity-1',
      title: '这一步你为什么这么做？',
      sourceLabel: '用户请求',
      status: 'done',
      plan: {
        lines: [{ text: '先核对文档再改代码。', entryIndex: 1, related: [], entryId: 'entry-plan' }],
        items: [],
      },
      steps: [],
      replies: [{
        id: 'reply-1',
        text: '因为旧代码把两个概念混在一起了。',
        kind: 'final',
        entryIndex: 5,
        related: [],
        entryId: 'entry-reply',
      }],
    }]} />)

    const anchors = screen.getAllByRole('article')[0]!.querySelectorAll('[data-msg-anchor]')
    expect(anchors).toHaveLength(2)
    expect([...anchors].map(node => node.getAttribute('data-msg-role'))).toEqual(['assistant', 'assistant'])
    expect([...anchors].map(node => node.getAttribute('data-msg-id'))).toEqual(['entry-plan', 'entry-reply'])
    expect(within(anchors[0] as HTMLElement).getByText('先核对文档再改代码。')).toBeTruthy()
    expect(within(anchors[1] as HTMLElement).getByText('因为旧代码把两个概念混在一起了。')).toBeTruthy()
  })

  it('opens a step file in the dashboard and shows queued inputs', () => {
    const onFileOpen = vi.fn()
    render(<ActivityTimeline onFileOpen={onFileOpen} activities={[{
      id: 'activity-1',
      title: '没有问题吧 可以关闭流程了？',
      sourceLabel: '用户请求',
      status: 'running',
      steps: [{ id: 'read', label: '读取文件', detail: 'process.md', path: '/repo/docs/process.md', status: 'done', entryIndex: 3 }],
      replies: [],
      queuedInputs: ['另外在操作步骤可以把文件放在一起吗'],
    }]} />)

    const activity = screen.getByRole('article')
    // 文件名跟在操作后面（同一个步骤行），不再另起一列。
    const row = screen.getByText('读取文件').closest('li') as HTMLElement
    expect(within(row).getByText('process.md')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'process.md' }))
    expect(onFileOpen).toHaveBeenCalledWith('/repo/docs/process.md')
    expect(within(activity).getByText('排队中的输入')).toBeTruthy()
    expect(within(activity).getByText(/另外在操作步骤可以把文件放在一起吗/)).toBeTruthy()
  })

  it('keeps every agent reply of one activity in order', () => {
    render(<ActivityTimeline activities={[{
      id: 'activity-1',
      title: '重跑缺失预测文件',
      sourceLabel: '用户请求',
      status: 'running',
      steps: [],
      replies: [
        { id: 'reply-1', text: '先确认缺失清单。', kind: 'commentary', entryIndex: 2, related: [] },
        { id: 'reply-2', text: '开始重跑 14 个国家。', kind: 'commentary', entryIndex: 6, related: ['运行脚本:rerun_predictions.py'] },
        { id: 'reply-3', text: '重跑完成：108 个文件已补齐。', kind: 'final', entryIndex: 20, related: [] },
      ],
    }]} />)

    const activity = screen.getByRole('article')
    expect(within(activity).getByText('Agent 回复 · 3 条')).toBeTruthy()
    expect(within(activity).getAllByText('进度说明')).toHaveLength(2)
    expect(within(activity).getAllByText('回复正文')).toHaveLength(1)
    const text = activity.textContent ?? ''
    const positions = ['先确认缺失清单。', '开始重跑 14 个国家。', '重跑完成：108 个文件已补齐。'].map(body => text.indexOf(body))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  it('shows user images as bounded thumbnail previews', () => {
    render(<ActivityTimeline activities={[{
      id: 'activity-image',
      title: '请看一下这张卡',
      sourceLabel: '用户请求',
      status: 'running',
      steps: [],
      replies: [],
      images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
    }]} />)

    const image = screen.getByRole('img', { name: '用户发送的图片 1' })
    expect(image).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=')
    expect(image.className).toContain('object-contain')
  })
})
