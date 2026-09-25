import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  PendingDeliveryBar,
  pendingDeliveries,
  pendingDeliveryLabel,
  pendingDeliveryOf,
  pendingDeliveryTitle,
  queuedDeliveryFor,
  type PendingDelivery,
} from '../features/live-sessions/pendingDelivery'
// The badge rides the timeline entry through this grouping step, so prove the
// local queue fields survive it in both reading modes.
import { groupLiveToolEntries } from '../features/live-sessions/LiveSessionPage'

function queuedEntry(text: string, deliverAs: 'steer' | 'followUp', state: 'sending' | 'queued') {
  return {
    type: 'message',
    dashboardLocalId: `local-${text}`,
    dashboardDeliverAs: deliverAs,
    dashboardQueueState: state,
    message: { role: 'user', content: text },
  }
}

const delivery = (over: Partial<PendingDelivery> = {}): PendingDelivery => ({ localId: 'l', text: 't', deliverAs: 'followUp', state: 'queued', ...over })

describe('pendingDelivery', () => {
  it('reads queue state only from entries this browser marked', () => {
    expect(pendingDeliveryOf(queuedEntry('one', 'followUp', 'queued'))).toEqual({
      localId: 'local-one', text: 'one', deliverAs: 'followUp', state: 'queued',
    })
    // Pi's own echo, and any other timeline entry, carries no pending state.
    expect(pendingDeliveryOf({ type: 'message_end', data: { message: { role: 'user', content: 'one' } } })).toBeUndefined()
    expect(pendingDeliveryOf({ type: 'message', dashboardLocalId: 'x', message: { role: 'user', content: 'one' } })).toBeUndefined()
    expect(pendingDeliveryOf(undefined)).toBeUndefined()
  })

  it('collects pending messages in transcript order', () => {
    const entries = [queuedEntry('one', 'followUp', 'sending'), { type: 'message_end' }, queuedEntry('two', 'steer', 'queued')]
    expect(pendingDeliveries(entries).map(item => item.text)).toEqual(['one', 'two'])
  })

  it('survives timeline grouping in both full and compact reading', () => {
    const entry = queuedEntry('one', 'followUp', 'queued')
    for (const auxiliary of [true, false]) {
      const { items } = groupLiveToolEntries([{ type: 'message_start' }, entry], auxiliary)
      const grouped = items.flatMap(item => (item.type === 'entry' ? [item.entry] : []))
      expect(pendingDeliveries(grouped).map(delivery => delivery.text)).toEqual(['one'])
    }
  })

  it('decides the queue mode the way the bridge does', () => {
    // Explicit choice wins.
    expect(queuedDeliveryFor({ status: 'running', deliverAs: 'steer', text: 'go left' })).toBe('steer')
    // No explicit mode while Pi works ⇒ the bridge queues it as followUp.
    expect(queuedDeliveryFor({ status: 'running', text: 'then run the tests' })).toBe('followUp')
    // Idle: Pi takes it right away, so nothing is claimed.
    expect(queuedDeliveryFor({ status: 'idle', text: 'hi' })).toBeUndefined()
    // Extension commands run immediately and are never echoed as a user message.
    expect(queuedDeliveryFor({ status: 'running', text: '/goal ship it' })).toBeUndefined()
    expect(queuedDeliveryFor({ status: 'running', text: '   /compact' })).toBeUndefined()
  })

  it('spells out the delivery mode, and flags a not-yet-accepted send', () => {
    expect(pendingDeliveryLabel(delivery())).toBe('排队中 · 等当前回合结束')
    expect(pendingDeliveryLabel(delivery({ deliverAs: 'steer' }))).toBe('插话中 · 下个工具调用生效')
    expect(pendingDeliveryLabel(delivery({ state: 'sending' }))).toBe('发送中…')
    expect(pendingDeliveryTitle(delivery({ state: 'sending' }))).toBe('已发出，等待 Pi 确认接收')
    expect(pendingDeliveryTitle(delivery({ deliverAs: 'steer' }))).toContain('下一个工具调用后插入')
  })

  it('renders a bar above the composer, and nothing when the queue is empty', () => {
    const { rerender } = render(<PendingDeliveryBar deliveries={[]} />)
    expect(screen.queryByRole('status', { name: '排队中的消息' })).not.toBeInTheDocument()

    rerender(<PendingDeliveryBar deliveries={pendingDeliveries([queuedEntry('one', 'followUp', 'queued'), queuedEntry('two', 'followUp', 'sending')])} />)
    const bar = screen.getByRole('status', { name: '排队中的消息' })
    expect(bar).toHaveTextContent('2 条消息尚未被 Pi 处理')
    expect(bar).toHaveTextContent('1 条仍在发送')
    expect(bar).toHaveTextContent('one / two')

    rerender(<PendingDeliveryBar deliveries={[delivery({ text: 'steer it', deliverAs: 'steer' })]} />)
    expect(screen.getByRole('status', { name: '排队中的消息' })).toHaveTextContent('（下个工具调用生效）')
  })
})