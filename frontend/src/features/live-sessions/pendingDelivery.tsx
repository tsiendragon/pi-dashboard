import type { LiveSessionStatus } from '@shared/live-sessions'
import { MaterialIcon } from '../../components/MaterialIcon'

/**
 * Delivery state for messages this browser just sent.
 *
 * The bridge accepts an `input` command immediately (`{ accepted: true }`), but a
 * message sent while the Pi is working is only *queued*: `deliverAs: 'followUp'`
 * waits for the current turn to end, `deliverAs: 'steer'` is injected at the next
 * tool boundary. Until Pi echoes the user message back, the transcript holds the
 * optimistic bubble — indistinguishable from a handled message, which is exactly
 * how “was this even accepted?” confusion happens. These helpers turn that
 * pending window into a visible state.
 *
 * Only plain prompts are tracked: text starting with `/` may be an extension
 * command, which Pi executes immediately and never echoes as a user message, so
 * calling it “queued” would be a lie.
 */
export type PendingDelivery = {
  localId: string
  text: string
  deliverAs: 'steer' | 'followUp'
  /** `sending` = waiting for the bridge to accept; `queued` = accepted, not yet delivered. */
  state: 'sending' | 'queued'
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (record(part)?.type === 'text' && typeof record(part)?.text === 'string' ? String(record(part)?.text) : ''))
    .filter(Boolean)
    .join('\n')
}

/** Read the pending-delivery state of one timeline entry, if it carries any. */
export function pendingDeliveryOf(entry: unknown): PendingDelivery | undefined {
  const entryRecord = record(entry)
  const localId = typeof entryRecord?.dashboardLocalId === 'string' ? entryRecord.dashboardLocalId : undefined
  const deliverAs = entryRecord?.dashboardDeliverAs === 'steer' || entryRecord?.dashboardDeliverAs === 'followUp'
    ? entryRecord.dashboardDeliverAs
    : undefined
  const state = entryRecord?.dashboardQueueState === 'queued'
    ? 'queued'
    : entryRecord?.dashboardQueueState === 'sending' ? 'sending' : undefined
  if (!localId || !deliverAs || !state) return undefined
  return { localId, deliverAs, state, text: textOf(record(entryRecord?.message)?.content) }
}

/** Every message still waiting to reach Pi, in transcript order. */
export function pendingDeliveries(entries: readonly unknown[]): PendingDelivery[] {
  const pending: PendingDelivery[] = []
  for (const entry of entries) {
    const delivery = pendingDeliveryOf(entry)
    if (delivery) pending.push(delivery)
  }
  return pending
}

/**
 * Delivery mode to remember for a prompt that was just sent, or undefined when it
 * is not expected to wait in a queue.
 *
 * Mirrors the bridge's own default: an explicit `steer`/`followUp` wins, otherwise a
 * prompt sent while Pi is working is queued as `followUp`. Slash-prefixed text is
 * excluded — Pi runs a registered extension command immediately and never echoes it
 * back as a user message, so calling that “queued” would be a lie.
 */
export function queuedDeliveryFor(input: { status?: LiveSessionStatus; deliverAs?: 'steer' | 'followUp'; text: string }): 'steer' | 'followUp' | undefined {
  if (input.text.trim().startsWith('/')) return undefined
  return input.deliverAs ?? (input.status === 'running' ? 'followUp' : undefined)
}

/** Short badge for the message header, e.g. 「排队中 · 等当前回合结束」. */
export function pendingDeliveryLabel(delivery: PendingDelivery): string {
  if (delivery.state === 'sending') return '发送中…'
  return delivery.deliverAs === 'steer' ? '插话中 · 下个工具调用生效' : '排队中 · 等当前回合结束'
}

/** Tooltip explaining what the badge means for this delivery mode. */
export function pendingDeliveryTitle(delivery: PendingDelivery): string {
  if (delivery.state === 'sending') return '已发出，等待 Pi 确认接收'
  return delivery.deliverAs === 'steer'
    ? 'Pi 已接受这条插话，会在下一个工具调用后插入本轮'
    : 'Pi 已接受这条追加消息，等当前回合结束后处理'
}

/** Sits directly above the composer so a queued message stays visible while the turn keeps scrolling. */
export function PendingDeliveryBar({ deliveries }: { deliveries: PendingDelivery[] }) {
  if (deliveries.length === 0) return null
  const sending = deliveries.filter(delivery => delivery.state === 'sending').length
  const texts = deliveries.map(delivery => delivery.text).join(' / ')
  return (
    <div role="status" aria-label="排队中的消息" className="flex items-center gap-2 border-t border-border bg-chrome px-2 py-1 text-2xs text-warn">
      <MaterialIcon name="schedule" className="h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0">
        {deliveries.length} 条消息尚未被 Pi 处理
        {sending > 0 ? `（${sending} 条仍在发送）` : deliveryHint(deliveries)}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted" title={deliveries.map(delivery => delivery.text).join('\n')}>{texts}</span>
    </div>
  )
}

function deliveryHint(deliveries: PendingDelivery[]): string {
  return deliveries.every(delivery => delivery.deliverAs === 'steer') ? '（下个工具调用生效）' : '（等当前回合结束）'
}