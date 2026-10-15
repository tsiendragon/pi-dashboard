import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { SupervisorEvent } from '../../shared/src/supervisor'
import { EventTimeline, FOLD_THRESHOLD, clockOf, groupByDay, plainSummary } from '../features/supervisor/EventTimeline'

const base: SupervisorEvent = {
  id: 'event-base', objectRef: 'local:t-1', objectSnapshot: { title: '测试任务', kind: 'task' }, title: '记录', type: 'progress',
  description: '描述', occurredAt: '2026-10-13T10:00:00+08:00', recordedAt: '2026-10-13T10:05:00+08:00', recorder: '主 Agent',
  participants: [], source: { kind: 'agent' }, attachmentIds: [], version: 1, requestId: 'req-1', payloadHash: 'hash', revisions: [],
}
const event = (over: Partial<SupervisorEvent>): SupervisorEvent => ({ ...base, ...over })

const newest = event({ id: 'event-new', title: '最新一条记录', type: 'decision', occurredAt: '2026-10-13T14:51:00+08:00', description: '换 GPU 可行，两项都还没执行。' })
const sameDayEarlier = event({ id: 'event-mid', title: '同日更早的记录', type: 'progress', occurredAt: '2026-10-13T10:20:00+08:00', description: '核对了 EU 侧机型。' })
const previousDay = event({ id: 'event-old', title: '上周的记录', type: 'result', occurredAt: '2026-09-28T11:05:00+08:00', description: '首次部署完成。', attachmentIds: ['attachment-1', 'attachment-2'] })
const noTime = event({ id: 'event-unknown', title: '没有可用时间的记录', type: 'reply', occurredAt: null, recordedAt: '', description: '只记到日期。' })

function renderTimeline(events: SupervisorEvent[]) {
  return render(<MemoryRouter><EventTimeline events={events} tasks={[{ uid: 'local:t-1', title: '测试任务' }]} /></MemoryRouter>)
}

describe('事件时间线分组与摘要', () => {
  it('按天分组、新的在前，没有可用时间的记录单独一组并说明', () => {
    const days = groupByDay([sameDayEarlier, previousDay, newest, noTime])
    expect(days.map(day => day.label)).toEqual(['2026/10/13', '2026/09/28', '时间未知'])
    expect(days[0].weekday).toBe('周二')
    expect(days[0].items.map(item => item.id)).toEqual(['event-new', 'event-mid'])
    expect(days[2].weekday).toContain('不代表没有发生')
    expect(groupByDay([newest, previousDay], 'asc').map(day => day.label)).toEqual(['2026/09/28', '2026/10/13'])
  })
  it('摘要压成一行可读文本；没有描述时不留空', () => {
    expect(plainSummary(event({ description: '## 结论\n- **换 GPU** 可行\n- 见 [文档](http://x)' }))).toBe('结论 - 换 GPU 可行 - 见 文档')
    expect(plainSummary(event({ description: '' }))).toBe('')
  })
  it('缺少发生时间时，轴上标出这是记录时间而不是发生时间', () => {
    expect(clockOf(newest)).toBe('14:51')
    expect(clockOf(event({ occurredAt: null, recordedAt: '2026-10-13T09:07:00+08:00' }))).toBe('记 09:07')
  })
})

describe('事件时间线展开与折叠', () => {
  it('默认只展开最新一条，其余显示摘要，点开才显示完整字段与图片', () => {
    renderTimeline([newest, sameDayEarlier, previousDay])
    // 最新一条默认展开：完整字段在页面上
    const newestBody = document.getElementById('timeline-body-event-new')
    expect(newestBody).not.toBeNull()
    expect(within(newestBody!).getByText(/事件 event-new · 请求 req-1/)).toBeInTheDocument()
    expect(within(newestBody!).getByText('记录人：主 Agent')).toBeInTheDocument()
    // 其余只有摘要，没有正文
    expect(screen.getByText('核对了 EU 侧机型。')).toBeInTheDocument()
    expect(screen.queryByText(/事件 event-mid · 请求 req-1/)).not.toBeInTheDocument()
    expect(screen.queryByText(/事件 event-old · 请求 req-1/)).not.toBeInTheDocument()
    // 收起时最多 1 张缩略图（该条有两张附件）；展开后才给全部附件
    expect(screen.getAllByRole('img', { name: /事件图片/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /上周的记录/ }))
    expect(screen.getByText(/事件 event-old · 请求 req-1/)).toBeInTheDocument()
    expect(screen.getAllByRole('img', { name: /事件图片/ })).toHaveLength(2)
  })
  it('点日期折叠整天，展开全部日期可恢复', () => {
    renderTimeline([newest, sameDayEarlier, previousDay])
    const dayButtons = screen.getAllByRole('button', { name: /2026\/10\/13/ })
    fireEvent.click(dayButtons[0])
    expect(dayButtons[0]).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/事件 event-new · 请求 req-1/)).not.toBeInTheDocument()
    expect(screen.getByText(/该日 2 条记录已折叠/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开全部日期' }))
    expect(screen.getByText(/事件 event-new · 请求 req-1/)).toBeInTheDocument()
  })
  it('记录很多时默认折叠除最新一天以外的日期，并如实说明折叠了几条', () => {
    const many = Array.from({ length: FOLD_THRESHOLD + 2 }, (_, index) => event({
      id: 'event-' + index, title: '第 ' + index + ' 条记录', type: 'progress',
      occurredAt: index > 5 ? '2026-10-13T1' + (index % 10) + ':00:00+08:00' : '2026-09-20T0' + (index % 10) + ':00:00+08:00',
      description: '批量记录 ' + index,
    }))
    renderTimeline(many)
    expect(screen.getByText(/已折叠 1 天/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开全部日期' }))
    expect(screen.queryByText(/已折叠/)).not.toBeInTheDocument()
  })
  it('没有事件时说明不代表没有发生工作', () => {
    render(<MemoryRouter><EventTimeline events={[]} /></MemoryRouter>)
    expect(screen.getByText(/没有返回事件；不代表没有发生工作/)).toBeInTheDocument()
  })
  it('日期标题同时是折叠开关，且带无障碍状态', () => {
    renderTimeline([newest, previousDay])
    const header = screen.getByRole('button', { name: /2026\/09\/28/ })
    expect(within(header).getByText(/1 条/)).toBeInTheDocument()
    expect(header).toHaveAttribute('aria-expanded', 'true')
  })
})