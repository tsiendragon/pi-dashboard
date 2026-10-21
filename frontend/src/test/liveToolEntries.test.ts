import { describe, expect, it } from 'vitest'
import { buildLiveActivities, buildLiveActivityEvidence, currentActivityDescription, emptyThinkingLabel, groupLiveToolEntries, mergeThinkingParts } from '../features/live-sessions/LiveSessionPage'

function assistant(id: string, calls: Array<{ id: string; name: string }>): Record<string, unknown> {
  return {
    type: 'message',
    id,
    message: {
      role: 'assistant',
      timestamp: '2026-09-10T23:48:00.000Z',
      content: calls.map(call => ({ type: 'toolCall', id: call.id, name: call.name, arguments: { command: `${call.name} --check` } })),
    },
  }
}

function result(id: string, name: string): Record<string, unknown> {
  return {
    type: 'message',
    message: { role: 'toolResult', toolCallId: id, toolName: name, content: 'ok', timestamp: '2026-09-10T23:48:01.000Z' },
  }
}

describe('mergeThinkingParts', () => {
  it('combines adjacent empty and non-empty thinking blocks into one block', () => {
    expect(mergeThinkingParts([
      { type: 'thinking', thinking: '' },
      { type: 'thinking', thinking: '' },
      { type: 'thinking', thinking: 'first reasoning' },
      { type: 'thinking', thinking: 'second reasoning' },
      { type: 'text', text: 'answer' },
    ])).toEqual([
      { type: 'thinking', thinking: 'first reasoning\nsecond reasoning', emptyThinkingCount: 2 },
      { type: 'text', text: 'answer' },
    ])
  })

  it('compresses empty thinking frames into a bounded emoji label', () => {
    expect(emptyThinkingLabel(1)).toBe('🤔')
    expect(emptyThinkingLabel(4)).toBe('🤔🤔🤔🤔')
    expect(emptyThinkingLabel(12)).toBe('🤔🤔🤔🤔🤔🤔 ×12')
  })
})

describe('groupLiveToolEntries', () => {
  it('keeps separate tool calls as separate timeline rows', () => {
    const { items: timeline } = groupLiveToolEntries([
      assistant('assistant-1', [{ id: 'call-1', name: 'bash' }]),
      result('call-1', 'bash'),
      assistant('assistant-2', [{ id: 'call-2', name: 'read' }]),
      result('call-2', 'read'),
      assistant('assistant-3', [{ id: 'call-3', name: 'git' }]),
      result('call-3', 'git'),
    ])

    expect(timeline.some(item => item.type === 'toolGroup')).toBe(false)
    expect(timeline.filter(item => item.type === 'entry')).toHaveLength(3)
  })

  it('groups multiple tool calls emitted in one assistant message', () => {
    const { items: timeline } = groupLiveToolEntries([
      assistant('assistant-batch', [
        { id: 'call-1', name: 'read' },
        { id: 'call-2', name: 'bash' },
      ]),
      result('call-1', 'read'),
      result('call-2', 'bash'),
      { type: 'message', message: { role: 'user', content: 'next' } },
    ])

    // The batch folds into one group; the later user turn stays visible.
    expect(timeline).toHaveLength(2)
    expect(timeline[0]?.type).toBe('toolGroup')
    if (timeline[0]?.type === 'toolGroup') expect(timeline[0].items).toHaveLength(2)
    expect(timeline[1]?.type).toBe('entry')
  })

  it('keeps the reply body of a message that issues several tool calls', () => {
    const { items } = groupLiveToolEntries([
      {
        type: 'message',
        id: 'assistant-batch',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先看两处' },
            { type: 'text', text: '两处一起查' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a' } },
            { type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: 'b' } },
          ],
        },
      },
      result('call-1', 'read'),
      result('call-2', 'bash'),
    ])

    // The calls still fold into one group, but the prose rides along as its own
    // entry instead of disappearing behind the group.
    expect(items.some(item => item.type === 'toolGroup')).toBe(true)
    const body = items.find(item => item.type === 'entry')
    expect(body).toBeTruthy()
    if (body?.type === 'entry') {
      const content = (body.entry as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? []
      expect(content.some(part => part.type === 'text' && part.text === '两处一起查')).toBe(true)
      expect(content.some(part => part.type === 'toolCall')).toBe(false)
    }
  })
})

describe('activity timeline', () => {
  it('prefers structured phase reports and otherwise uses visible commentary or the user request', () => {
    const goal = {
      objective: 'Fix compact session activity display',
      status: 'active' as const,
      progress: { current: '排查精简阅读模式为何仍显示 Bash 卡片' },
      blockers: [],
      acceptanceCriteria: [],
      constraints: [],
      workItems: [],
      sourceDocs: [],
    }
    expect(currentActivityDescription([], goal)).toMatchObject({
      title: '排查精简阅读模式为何仍显示 Bash 卡片',
      sourceLabel: 'Agent 阶段报告',
    })

    const entries = [
      { type: 'message', message: { role: 'user', content: '修复活动摘要显示' } },
      { type: 'message', message: { role: 'assistant', channel: 'commentary', content: '正在检查会话时间线的过滤逻辑。' } },
    ]
    expect(currentActivityDescription(entries, null)).toMatchObject({
      title: '正在检查会话时间线的过滤逻辑。',
      sourceLabel: 'Agent 进度说明',
    })
    expect(currentActivityDescription([entries[0]], null)).toMatchObject({
      title: '修复活动摘要显示',
      sourceLabel: '最近用户请求',
    })
  })

  it('summarizes standalone execution events without exposing raw tool names', () => {
    const evidence = buildLiveActivityEvidence([
      { type: 'message', message: { role: 'user', content: '运行回归测试' } },
      { type: 'tool_execution_start', data: { toolCallId: 'run-1', toolName: 'bash', command: 'npm test -- src/test/liveToolEntries.test.ts' } },
      { type: 'tool_execution_end', data: { toolCallId: 'run-1', toolName: 'bash' } },
    ])

    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ label: '运行回归测试', status: 'done' })
    expect(evidence[0]?.detail).toContain('npm test')
  })

  it('summarizes tool calls as human-readable actions and uses test output as evidence', () => {
    const evidence = buildLiveActivityEvidence([
      { type: 'message', message: { role: 'user', content: '修复精简阅读中的 Bash 卡片' } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: '/repo/src/LiveSessionPage.tsx' } },
            { type: 'toolCall', id: 'edit-1', name: 'edit', arguments: { path: '/repo/src/test/liveToolEntries.test.ts' } },
            { type: 'toolCall', id: 'test-1', name: 'bash', arguments: { command: 'npm test -- src/test/liveToolEntries.test.ts' } },
          ],
        },
      },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: 'source' } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'edit-1', toolName: 'edit', content: 'updated' } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'test-1', toolName: 'bash', content: 'Test Files 1 passed\\nTests 9 passed' } },
    ])

    expect(evidence.map(item => item.label)).toEqual(['检查代码逻辑', '编写回归测试', '运行回归测试'])
    expect(evidence.map(item => item.status)).toEqual(['done', 'done', 'done'])
    expect(evidence[2]?.detail).toContain('9 项通过')
  })

  it('shows structured goal work items as the agent plan with their states', () => {
    const activities = buildLiveActivities([
      {
        type: 'custom',
        customType: 'goal-state',
        data: {
          state: {
            objective: '检查出金记录',
            status: 'active',
            progress: { current: '核对订单并确认渠道' },
            workItems: [
              { id: 'read-orders', title: '读取订单记录', state: 'done' },
              { id: 'verify-channel', title: '确认交易渠道', state: 'in_progress' },
              { id: 'write-result', title: '更新分析结论', state: 'todo' },
            ],
          },
        },
      },
    ], 'running', null)

    expect(activities).toHaveLength(1)
    expect(activities[0]?.title).toBe('核对订单并确认渠道')
    // 工作项是"打算做什么"，放计划区；实际步骤只来自真实工具调用。
    expect(activities[0]?.plan?.items.map(item => [item.label, item.status])).toEqual([
      ['读取订单记录', 'done'],
      ['确认交易渠道', 'running'],
      ['更新分析结论', 'pending'],
    ])
    expect(activities[0]?.steps).toEqual([])
  })

  it('merges a snapshot-pinned goal state into the current activity instead of opening one', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '核对近期订单' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: '/repo/orders.csv' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: '3 rows' } },
      {
        // 快照把开头的目标状态带到末尾（长会话），它只带着当前清单，不是新阶段。
        type: 'custom',
        customType: 'goal-state',
        pinned: true,
        data: {
          state: {
            objective: '核对近期订单',
            status: 'active',
            progress: { current: '核对订单并确认渠道' },
            workItems: [{ id: 'verify-channel', title: '确认交易渠道', state: 'in_progress' }],
          },
        },
      },
    ], 'running', null)

    expect(activities).toHaveLength(1)
    expect(activities[0]?.title).toBe('核对近期订单')
    expect(activities[0]?.plan?.items.map(item => [item.label, item.status])).toEqual([
      ['确认交易渠道', 'running'],
    ])
  })

  it('keeps the goal checklist when the state carries no current step', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '把目标面板接上' } },
      { type: 'message', message: { role: 'assistant', channel: 'commentary', content: '先看数据链路' } },
      {
        type: 'custom',
        customType: 'goal-state',
        data: {
          state: {
            objective: '把目标面板接上',
            status: 'complete',
            // 收尾后的目标只有清单，没有「当前正在做」。
            progress: { lastSummary: '已接通并验证' },
            workItems: [
              { id: 'wire', title: '接通快照转发', state: 'done' },
              { id: 'verify', title: '真实会话验证', state: 'todo' },
            ],
          },
        },
      },
    ], 'idle', null)

    expect(activities).toHaveLength(1)
    // 没有可当标题的句子，就沿用当前活动的标题，别新开一个没有标题的活动。
    expect(activities[0]?.title).toBe('把目标面板接上')
    expect(activities[0]?.plan?.items.map(item => [item.label, item.status])).toEqual([
      ['接通快照转发', 'done'],
      ['真实会话验证', 'pending'],
    ])
  })

  it('merges a quote reply into the activity it quotes instead of opening a new one', () => {
    const quoteReply = [
      '引用（来自 Agent 回复）：',
      '> 读取订单记录这一步失败了',
      '',
      '为什么失败？',
    ].join('\n')
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '核对近期订单' } },
      { type: 'message', message: { role: 'assistant', content: '读取订单记录这一步失败了，因为渠道字段缺失。' } },
      { type: 'message', entryId: 'q1', message: { role: 'user', content: quoteReply } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'read-2', name: 'read', arguments: { path: '/repo/channels.csv' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'read-2', toolName: 'read', content: '3 rows' } },
    ], 'idle', null)

    // 仍然是同一个活动：追问没有把它拆成两个。
    expect(activities).toHaveLength(1)
    expect(activities[0]?.title).toBe('核对近期订单')
    expect(activities[0]?.followUps?.map(item => item.kind)).toEqual(['quote'])
    expect(activities[0]?.followUps?.[0]?.text).toContain('为什么失败？')
    // 追问之后的执行步骤也留在同一个活动里。
    expect(activities[0]?.steps.map(step => [step.label, step.path])).toEqual([['读取文件', '/repo/channels.csv']])
  })

  it('puts a quote back into the earlier activity it points at, and keeps later work there', () => {
    const quoteReply = [
      '引用（来自 Agent 回复）：',
      '> 订单金额和时间都对得上',
      '',
      '那渠道为什么缺？',
    ].join('\n')
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '核对近期订单' } },
      { type: 'message', message: { role: 'assistant', content: '订单金额和时间都对得上。' } },
      { type: 'message', message: { role: 'user', content: '检查风险请求入口' } },
      { type: 'message', message: { role: 'assistant', content: '风险入口已检查。' } },
      { type: 'message', entryId: 'q2', message: { role: 'user', content: quoteReply } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'read-3', name: 'read', arguments: { path: '/repo/orders.csv' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'read-3', toolName: 'read', content: '3 rows' } },
    ], 'idle', null)

    // 追问回到被引用的第一个活动，而不是当时最新的第二个活动。
    expect(activities.map(activity => activity.title)).toEqual(['核对近期订单', '检查风险请求入口'])
    expect(activities[0]?.followUps?.map(item => item.text)).toEqual([quoteReply])
    expect(activities[1]?.followUps).toBeUndefined()
    // 追问之后的执行也留在同一个活动里。
    expect(activities[0]?.steps.map(step => step.path)).toEqual(['/repo/orders.csv'])
    expect(activities[1]?.steps).toEqual([])
  })

  it.each([
    ['history quote', false, '引用（来自你的回复）：\n> repos 使用 roots 配置\n\n每个 repo 一个路径，不需要 roots'],
    ['live quote', true, '引用（来自你的回复）：\n> repos 使用 roots 配置\n\n每个 repo 一个路径，不需要 roots'],
    ['history comment', false, 'Please review and address these comments about the quoted parts of our conversation:\n\n[1] Agent 回复\nQuoted: "repos 使用 roots 配置"\nComment: 每个 repo 一个路径，不需要 roots'],
    ['live comment', true, 'Please review and address these comments about the quoted parts of our conversation:\n\n[1] Agent 回复\nQuoted: "repos 使用 roots 配置"\nComment: 每个 repo 一个路径，不需要 roots'],
  ])('keeps an in-flight supplement in the current activity: %s', (_label, live, supplement) => {
    const entries = [
      { type: 'message', message: { role: 'user', content: '增加仓库页面' } },
      { type: 'message', message: { role: 'assistant', content: 'repos 使用 roots 配置。' } },
      { type: 'message', message: { role: 'user', content: '增加 Git Graph 按钮' } },
      ...(live ? [{ type: 'agent_start' }] : []),
      { type: 'message', message: { role: 'assistant', content: [
        { type: 'text', text: '读取真实提交历史。' },
        { type: 'toolCall', id: 'git-history', name: 'bash', arguments: { command: 'git log' } },
      ] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'git-history', toolName: 'bash', content: 'commits' } },
      { type: 'message', message: { role: 'user', content: supplement } },
      { type: 'message', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'write-mock', name: 'write', arguments: { path: '/repo/repos-mock.html', content: 'mock' } },
      ] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'write-mock', toolName: 'write', content: 'written' } },
      { type: 'message', message: { role: 'assistant', content: '已去掉 roots，并增加 Git Graph 按钮。' } },
      ...(live ? [{ type: 'agent_settled' }] : []),
    ]
    const activities = buildLiveActivities(entries, 'idle', null)

    expect(activities.map(activity => activity.title)).toEqual(['增加仓库页面', '增加 Git Graph 按钮'])
    expect(activities.map(activity => activity.status)).toEqual(['done', 'done'])
    expect(activities[0]?.steps).toEqual([])
    expect(activities[0]?.followUps).toBeUndefined()
    expect(activities[0]?.replies.map(reply => reply.text)).toEqual(['repos 使用 roots 配置。'])
    expect(activities[1]?.followUps?.map(item => item.text)).toEqual([supplement])
    expect(activities[1]?.steps.map(step => step.entryIndex)).toEqual(live ? [4, 7] : [3, 6])
    expect(activities[1]?.replies.map(reply => [reply.kind, reply.text])).toEqual([
      ['commentary', '读取真实提交历史。'],
      ['final', '已去掉 roots，并增加 Git Graph 按钮。'],
    ])
  })

  it('merges a comment round and keeps its queued flag until Pi picks it up', () => {
    const commentRound = [
      'Please review and address these comments about the quoted parts of our conversation:',
      '',
      '[1] Agent 回复',
      'Quoted: "读取订单记录这一步失败了"',
      'Comment: 说清楚失败原因',
    ].join('\n')
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '核对近期订单' } },
      { type: 'message', message: { role: 'assistant', content: '读取订单记录这一步失败了，因为渠道字段缺失。' } },
      { type: 'agent_start' },
      { type: 'message', pendingDelivery: true, message: { role: 'user', content: commentRound } },
    ], 'running', null)

    expect(activities).toHaveLength(1)
    expect(activities[0]?.followUps?.[0]?.kind).toBe('comment')
    // Pi 还在忙：先标明排队中，且不进入「排队中的输入」（那条会被提升成新活动）。
    expect(activities[0]?.followUps?.[0]?.queued).toBe(true)
    expect(activities[0]?.queuedInputs).toBeUndefined()

    const settled = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '核对近期订单' } },
      { type: 'message', message: { role: 'assistant', content: '读取订单记录这一步失败了，因为渠道字段缺失。' } },
      { type: 'agent_start' },
      { type: 'message', pendingDelivery: true, message: { role: 'user', content: commentRound } },
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', content: '渠道字段缺失，已改用备用表。' } },
    ], 'idle', null)
    // Pi 接手之后：排队标记收掉，回复仍然属于同一个活动。
    expect(settled).toHaveLength(1)
    expect(settled[0]?.followUps?.[0]?.queued).toBeUndefined()
    expect(settled[0]?.replies.map(reply => reply.text)).toContain('渠道字段缺失，已改用备用表。')
  })

  it('still opens a new activity for an ordinary follow-up message', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '核对近期订单' } },
      { type: 'message', message: { role: 'assistant', content: '订单已核对。' } },
      { type: 'message', message: { role: 'user', content: '再顺手把渠道表也更新一下' } },
    ], 'idle', null)

    expect(activities.map(activity => activity.title)).toEqual(['核对近期订单', '再顺手把渠道表也更新一下'])
    expect(activities[0]?.followUps).toBeUndefined()
  })

  it('groups chronological agent phases and attaches observed tool steps with completion status', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '核对近期订单并检查风险入口' } },
      { type: 'message', message: { role: 'assistant', channel: 'commentary', content: '核对近期订单' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: '/repo/orders.csv' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: '3 rows' } },
      { type: 'message', message: { role: 'assistant', channel: 'commentary', content: '检查风险请求入口' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'test-1', name: 'bash', arguments: { command: 'npm test' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'test-1', toolName: 'bash', content: 'Tests 9 passed' } },
      { type: 'agent_settled' },
    ], 'idle', null)

    // 标题保持用户请求；动手前的说明成为该活动的计划。
    expect(activities.map(activity => activity.title)).toEqual(['核对近期订单并检查风险入口', '检查风险请求入口'])
    expect(activities.map(activity => activity.status)).toEqual(['done', 'done'])
    expect(activities.map(activity => (activity.plan?.lines ?? []).map(note => note.text))).toEqual([['核对近期订单'], []])
    expect(activities.map(activity => activity.steps.map(step => step.status))).toEqual([['done'], ['done']])
    expect(activities.map(activity => activity.steps[0]?.label)).toEqual(['读取文件', '运行回归测试'])
    expect(activities.map(activity => activity.replies)).toEqual([[], []])
  })

  it('settles the orphan fallback activity once a real user request supersedes it', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'boot-1', name: 'bash', arguments: { command: 'uname -a' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'boot-1', toolName: 'bash', content: 'Linux' } },
      { type: 'message', message: { role: 'assistant', channel: 'commentary', content: '会话启动检查完成。' } },
      { type: 'message', message: { role: 'user', content: '搜索可用 repo' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '已找到候选 repo 列表。' }] } },
      { type: 'agent_settled' },
    ], 'idle', null)

    expect(activities.map(activity => activity.title)).toEqual(['正在处理会话任务', '搜索可用 repo'])
    expect(activities.map(activity => activity.status)).toEqual(['done', 'done'])
  })

  it('keeps the user request when turn_start arrives before its message', () => {
    // 实测顺序：桥先推 agent_start / turn_start，用户消息紧随其后。
    // 旧逻辑把这条请求当成「排队输入」塞进占位活动，等工作跑完才另开活动，
    // 于是时间线上多出一条只有执行记录的「正在处理会话任务」。
    const activities = buildLiveActivities([
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message', message: { role: 'user', content: '帮我 pull 最新代码' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'g-1', name: 'bash', arguments: { command: 'git status' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'g-1', toolName: 'bash', content: 'clean' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '拉取完成。' }] } },
      { type: 'agent_settled' },
    ], 'idle', null)

    expect(activities.map(activity => activity.title)).toEqual(['帮我 pull 最新代码'])
    expect(activities[0]?.steps.map(step => step.label)).toEqual(['检查代码变更'])
    expect(activities[0]?.replies.map(reply => reply.text)).toEqual(['拉取完成。'])
    expect(activities[0]?.queuedInputs).toBeUndefined()
  })

  it('still treats a follow-up sent into a running activity as queued', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '核对近期订单' } },
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'r-1', name: 'read', arguments: { path: '/repo/orders.csv' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'r-1', toolName: 'read', content: '3 rows' } },
      { type: 'message', pendingDelivery: true, message: { role: 'user', content: '顺便把渠道表也更新' } },
      { type: 'turn_end' },
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '两件事都做完了。' }] } },
    ], 'idle', null)

    expect(activities.map(activity => activity.title)).toEqual(['核对近期订单', '顺便把渠道表也更新'])
    expect(activities[0]?.steps.map(step => step.label)).toEqual(['读取文件'])
  })

  it('marks an activity done when a single command failed but the turn wrapped up', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '看看仓库状态' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'g-1', name: 'bash', arguments: { command: 'git status' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'g-1', toolName: 'bash', content: 'fatal: not a repo', isError: true } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '仓库是干净的，刚才那条命令本来就该失败。' }] } },
    ], 'idle', null)

    expect(activities[0]?.status).toBe('done')
    expect(activities[0]?.steps.map(step => step.status)).toEqual(['error'])
  })

  it('marks a stopped session activity done without a settle signal', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '看下日志' } },
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'r-1', name: 'read', arguments: { path: '/repo/a.log' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'r-1', toolName: 'read', content: 'ok' } },
    ], 'idle', null)

    expect(activities.map(activity => activity.status)).toEqual(['done'])
  })

  it('closes the previous activity once a new request is running', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '先检查依赖' } },
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'd-1', name: 'bash', arguments: { command: 'npm ls' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'd-1', toolName: 'bash', content: 'ok' } },
      { type: 'message', message: { role: 'user', content: '再跑一遍测试' } },
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't-1', name: 'bash', arguments: { command: 'npm test' } }] } },
      { type: 'tool_execution_start', data: { toolCallId: 't-1', toolName: 'bash', args: { command: 'npm test' } } },
    ], 'running', null)

    expect(activities.map(activity => activity.status)).toEqual(['done', 'running'])
  })

  it('keeps an interrupted run incomplete once the session stopped', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '跑个长任务' } },
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'l-1', name: 'bash', arguments: { command: 'sleep 100' } }] } },
      { type: 'tool_execution_start', data: { toolCallId: 'l-1', toolName: 'bash', args: { command: 'sleep 100' } } },
    ], 'idle', null)

    expect(activities.map(activity => activity.status)).toEqual(['incomplete'])
  })

  it('keeps the agent reply body on the activity that produced it', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '检查出金记录' } },
      { type: 'message', message: { role: 'assistant', channel: 'commentary', content: '我先读取订单文件。' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: '/repo/orders.csv' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: '3 rows' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '核对完成：3 笔订单全部匹配。' }] } },
    ], 'idle', null)

    expect(activities).toHaveLength(1)
    // 动手前的说明进计划，不占回复位。
    expect(activities[0]?.plan?.lines.map(note => note.text)).toEqual(['我先读取订单文件。'])
    expect(activities[0]?.replies.map(reply => [reply.kind, reply.text])).toEqual([
      ['final', '核对完成：3 笔订单全部匹配。'],
    ])
    expect(activities[0]?.replies[0]?.related).toEqual([])
  })

  it('carries the file path so steps can be opened from the dashboard', () => {
    const evidence = buildLiveActivityEvidence([
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'r1', name: 'read', arguments: { path: '/repo/docs/process.md' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: 'ok' } },
    ])

    expect(evidence.map(item => [item.label, item.detail, item.path])).toEqual([
      ['读取文件', 'process.md', '/repo/docs/process.md'],
    ])
  })

  it('keeps work in the running activity while an input is still queued', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '检查一下流程' } },
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', channel: 'commentary', content: '先读文档。' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'r1', name: 'read', arguments: { path: '/repo/docs/lifecycle.md' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: 'ok' } },
      // Pi 还在干活：这条只是排队，后续步骤仍然属于第一个活动。
      { type: 'message', message: { role: 'user', content: '另外把文件也能点开' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'e1', name: 'edit', arguments: { path: '/repo/src/ActivityTimeline.tsx' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'e1', toolName: 'edit', content: 'ok' } },
    ], 'running', null)

    // 还在排队：只有一个活动，排队输入挂在它上面，后续步骤也留在它这里。
    expect(activities.map(activity => activity.title)).toEqual(['检查一下流程'])
    expect(activities[0]?.queuedInputs).toEqual(['另外把文件也能点开'])
    expect(activities[0]?.steps.map(step => step.detail)).toEqual(['lifecycle.md', 'ActivityTimeline.tsx'])
  })

  it('moves the notes written for a queued input into the new activity', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '会话里的 todo 有哪些' } },
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'r1', name: 'read', arguments: { path: '/repo/docs/lifecycle.md' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: 'ok' } },
      // 旧回合还在跑时，用户发了新问题：这条先排队。
      { type: 'message', message: { role: 'user', content: '做一个 todo 按钮怎么样' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '旧回合的收尾结论。' }] } },
      { type: 'agent_settled' },
      // 旧回合已经结束，这段文字已经是新输入的答复，但那时新活动还没建立。
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '喵。明白了，你说的是会话里的待办清单。' }] } },
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'e1', name: 'edit', arguments: { path: '/repo/src/TodoButton.tsx' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'e1', toolName: 'edit', content: 'ok' } },
    ], 'running', null)

    expect(activities.map(activity => activity.title)).toEqual(['会话里的 todo 有哪些', '做一个 todo 按钮怎么样'])
    // 旧回合的收尾留在第一个活动。
    expect(activities[0]?.replies.map(reply => reply.text)).toEqual(['旧回合的收尾结论。'])
    // 新输入的答复已经搬进第二个活动，并带上它之后的动作。
    expect(activities[1]?.replies.map(reply => reply.text)).toEqual(['喵。明白了，你说的是会话里的待办清单。'])
    expect(activities[1]?.replies[0]?.related).toEqual(['修改代码：TodoButton.tsx'])
    expect(activities[1]?.steps.map(step => step.detail)).toEqual(['TodoButton.tsx'])
    expect(activities[0]?.steps.map(step => step.detail)).toEqual(['lifecycle.md'])
  })

  it('promotes a queued input to its own activity once Pi picks it up', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '检查一下流程' } },
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'r1', name: 'read', arguments: { path: '/repo/docs/lifecycle.md' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: 'ok' } },
      { type: 'message', message: { role: 'user', content: '另外把文件也能点开' } },
      { type: 'agent_settled' },
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'e2', name: 'edit', arguments: { path: '/repo/src/other.tsx' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'e2', toolName: 'edit', content: 'ok' } },
    ], 'running', null)

    expect(activities.map(activity => activity.title)).toEqual(['检查一下流程', '另外把文件也能点开'])
    expect(activities[0]?.queuedInputs ?? []).toEqual([])
    expect(activities[0]?.steps.map(step => step.detail)).toEqual(['lifecycle.md'])
    expect(activities[1]?.steps.map(step => step.detail)).toEqual(['other.tsx'])
  })

  it('reuses a bare execution activity for the next user request', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'context-1', name: 'event_objects', arguments: {} }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'context-1', toolName: 'event_objects', content: 'context loaded' } },
      { type: 'message', message: { role: 'user', content: '把这条记录到对应任务' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'query-1', name: 'event_query', arguments: {} }] } },
    ], 'running', null)

    expect(activities).toHaveLength(1)
    expect(activities[0]?.title).toBe('把这条记录到对应任务')
    expect(activities[0]?.sourceLabel).toBe('用户请求')
    expect(activities[0]?.steps).toHaveLength(2)
  })

  it('reuses a bare execution activity when a queued user request starts', () => {
    const activities = buildLiveActivities([
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'context-1', name: 'event_objects', arguments: {} }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'context-1', toolName: 'event_objects', content: 'context loaded' } },
      { type: 'message', message: { role: 'user', content: '把这条记录到对应任务' } },
      { type: 'agent_settled' },
      { type: 'agent_start' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'query-1', name: 'event_query', arguments: {} }] } },
    ], 'running', null)

    expect(activities).toHaveLength(1)
    expect(activities[0]?.title).toBe('把这条记录到对应任务')
    expect(activities[0]?.sourceLabel).toBe('用户请求')
    expect(activities[0]?.queuedInputs ?? []).toEqual([])
    expect(activities[0]?.steps).toHaveLength(2)
  })

  it('attaches user image previews to the matching activity without an image placeholder in the title', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: [
        { type: 'text', text: '请看一下这张卡' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ] } },
    ], 'idle', null)

    expect(activities).toHaveLength(1)
    expect(activities[0]?.title).toBe('请看一下这张卡')
    expect(activities[0]?.images).toEqual([{ data: 'aGVsbG8=', mimeType: 'image/png' }])
  })

  it('keeps image-only queued requests and shows their image after promotion', () => {
    const activities = buildLiveActivities([
      { type: 'agent_start' },
      { type: 'message', message: { role: 'user', content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/webp' }] } },
      { type: 'agent_settled' },
      { type: 'agent_start' },
    ], 'running', null)

    expect(activities).toHaveLength(1)
    expect(activities[0]?.title).toBe('用户发送了 1 张图片')
    expect(activities[0]?.images).toEqual([{ data: 'aGVsbG8=', mimeType: 'image/webp' }])
    expect(activities[0]?.queuedInputs ?? []).toEqual([])
  })

  it('attaches the concrete actions that follow each reply', () => {
    const activities = buildLiveActivities([
      { type: 'message', message: { role: 'user', content: '把这次的结论同步到文档' } },
      { type: 'message', message: { role: 'assistant', channel: 'commentary', content: 'Docs 同步：' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'w1', name: 'write', arguments: { path: '/repo/docs/records/2026-10-08-draft.md' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'w1', toolName: 'write', content: 'ok' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'w2', name: 'edit', arguments: { path: '/repo/docs/design/summary.md' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'w2', toolName: 'edit', content: 'ok' } },
    ], 'idle', null)

    const activity = activities[0]!
    // “Docs 同步：”这样的短句补上具体动了哪些文档，用户才知道到底同步了什么。
    expect(activity.plan?.lines).toEqual([{
      text: 'Docs 同步：',
      entryIndex: 1,
      related: ['修改文件：2026-10-08-draft.md', '修改文件：summary.md'],
    }])
    expect(activity.steps.map(step => step.detail)).toEqual(['2026-10-08-draft.md', 'summary.md'])
    expect(activity.replies).toEqual([])
  })
})

describe('groupLiveToolEntries compact reading', () => {
  it('drops thinking and tool/script rows while keeping the reply body', () => {
    const { items, hidden } = groupLiveToolEntries([
      assistant('assistant-1', [{ id: 'call-1', name: 'bash' }]),
      result('call-1', 'bash'),
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'the answer' }],
        },
      },
      { type: 'message', message: { role: 'user', content: 'what changed?' } },
    ], false)

    // Nothing is rendered as a tool row, and the pure-tool entries are gone.
    expect(items.every(item => item.type === 'entry')).toBe(true)
    expect(items).toHaveLength(2)
    expect(hidden.tools).toBe(2)      // one tool call + its result
    expect(hidden.thinking).toBe(1)   // the thinking part on the mixed message
  })

  it('drops standalone tool execution lifecycle rows while reading', () => {
    const { items, hidden } = groupLiveToolEntries([
      { type: 'tool_execution_start', data: { toolCallId: 'call-1', toolName: 'bash', command: 'npm test' } },
      { type: 'tool_execution_update', data: { toolCallId: 'call-1', toolName: 'bash', partialResult: 'running' } },
      { type: 'tool_execution_end', data: { toolCallId: 'call-1', toolName: 'bash' } },
      { type: 'message', message: { role: 'user', content: 'next' } },
    ], false)

    expect(items).toHaveLength(1)
    expect(hidden.tools).toBe(3)
    expect(items[0]?.type).toBe('entry')
  })

  it('also drops extension telemetry rows while reading', () => {
    const { items, hidden } = groupLiveToolEntries([
      { type: 'custom', customType: 'compact-thinking-duration', data: { ms: 12 } },
      { type: 'message', message: { role: 'user', content: 'only this should remain' } },
    ], false)
    expect(items).toHaveLength(1)
    expect(hidden.other).toBe(1)
  })

  it('keeps the auxiliary rows when reading in full', () => {
    const { items, hidden } = groupLiveToolEntries([
      assistant('assistant-1', [{ id: 'call-1', name: 'bash' }]),
      result('call-1', 'bash'),
    ])
    expect(hidden).toEqual({ tools: 0, thinking: 0, other: 0 })
    expect(items.length).toBeGreaterThan(0)
  })
})
