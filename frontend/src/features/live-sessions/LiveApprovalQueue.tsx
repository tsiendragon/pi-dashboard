import { useCallback, useEffect, useState } from 'react'
import type { LiveSessionQueue, LiveSessionQueueItem, LiveSessionUiRequest } from '@shared/live-sessions'
import { MaterialIcon } from '../../components/MaterialIcon'

/** A queued prompt is only withdrawn by id; nothing is removed optimistically. */
export type QueueAnswer = { cancelled: boolean; remaining: number }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Prompts the bridge is still holding for this session.
 *
 * The transcript cannot show these: they have not reached Pi yet, so they leave no entry.
 * The bridge queue is the authority on what can still be withdrawn, which is why this bar
 * refreshes after a send, a withdrawal or a status change instead of guessing locally.
 */
export default function LiveQueueBar({
  processInstanceId,
  enabled,
  revision,
  onCountChange,
  onQueue,
  onWithdraw,
}: {
  processInstanceId: string
  enabled: boolean
  /** Bumped by the page after a send/abort so the bar re-reads the bridge. */
  revision: number
  onCountChange?: (count: number) => void
  onQueue: (processInstanceId: string) => Promise<LiveSessionQueue>
  onWithdraw: (processInstanceId: string, id: string) => Promise<QueueAnswer>
}) {
  const [queue, setQueue] = useState<LiveSessionQueue | null>(null)
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [localRevision, setLocalRevision] = useState(0)

  useEffect(() => {
    if (!enabled) { setQueue(null); setOpen(false); onCountChange?.(0); return }
    let alive = true
    onQueue(processInstanceId)
      .then(next => { if (alive) { setQueue(next); onCountChange?.(next.items.length) } })
      // An older bridge without the capability, or a dropped read: stay hidden rather than
      // pretend the queue is empty and lost.
      .catch(() => { if (alive) { setQueue(null); onCountChange?.(0) } })
    return () => { alive = false }
  }, [processInstanceId, enabled, revision, localRevision, onQueue, onCountChange])

  const items = queue?.items ?? []
  const active = queue?.active ?? null
  const withdraw = useCallback(async (item: LiveSessionQueueItem) => {
    setBusyId(item.id); setError(null)
    try {
      await onWithdraw(processInstanceId, item.id)
      // Re-read instead of splicing: another tab may have withdrawn it first.
      setLocalRevision(value => value + 1)
    } catch (failure) {
      setError(errorText(failure) || '撤回失败；这条可能已经开始执行。')
    } finally {
      setBusyId(null)
    }
  }, [onWithdraw, processInstanceId])

  if (!enabled || (items.length === 0 && !active)) return null
  return (
    <div className="border-t border-border bg-chrome text-2xs">
      <div className="flex items-center gap-2 px-2 py-1" role="status" aria-label="排队的消息">
        <MaterialIcon name="schedule" className="h-3.5 w-3.5 shrink-0 text-warn" />
        <span className="shrink-0 text-warn">
          {items.length > 0 ? `${items.length} 条消息还在排队` : '没有可撤回的排队消息'}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted" title={items.map(item => item.text).join('\n')}>
          {items[0]?.text ?? active?.text ?? ''}
        </span>
        <button
          type="button"
          onClick={() => setOpen(value => !value)}
          aria-expanded={open}
          className="shrink-0 rounded border border-border px-2 py-0.5 text-muted hover:border-accent hover:text-accent"
        >
          {open ? '收起' : '查看'}
        </button>
      </div>
      {open && <div className="border-t border-border bg-bg px-2 py-1">
        {error && <div role="alert" className="px-1 py-1 text-danger">{error}</div>}
        <ul className="max-h-40 overflow-y-auto">
          {items.map(item => (
            <li key={item.id} className="flex items-start gap-2 border-b border-border/60 px-1 py-1 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-fg" title={item.text}>{item.text || '（图片）'}</div>
                <div className="text-muted">
                  {item.deliverAs === 'steer' ? '引导' : '排队'}
                  {item.imageCount > 0 ? ` · ${item.imageCount} 张图片` : ''}
                  {item.channel ? ` · ${item.channel}` : ''}
                </div>
              </div>
              <button
                type="button"
                disabled={busyId === item.id}
                onClick={() => { void withdraw(item) }}
                className="shrink-0 rounded border border-border px-2 py-0.5 text-muted hover:border-danger hover:text-danger disabled:opacity-50"
              >
                {busyId === item.id ? '撤回中…' : '撤回'}
              </button>
            </li>
          ))}
        </ul>
        {active && <div className="px-1 py-1 text-muted">正在发送（已交给 Pi，无法撤回）：{active.text}</div>}
        {items.length === 0 && <div className="px-1 py-1 text-muted">这些消息都已经发出去了，没有可撤回的项。</div>}
      </div>}
    </div>
  )
}

/** The card only ever carries `confirm`; text and password prompts keep their dialog. */
export function LiveApprovalCard({
  requests,
  onAnswer,
}: {
  requests: LiveSessionUiRequest[]
  onAnswer: (request: LiveSessionUiRequest, allow: boolean) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = requests[0]
  useEffect(() => { setError(null); setBusy(false) }, [request?.id])
  if (!request) return null

  const answer = async (allow: boolean) => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      await onAnswer(request, allow)
    } catch (failure) {
      // Keep the card: a failed answer must not look like a granted request.
      setError(errorText(failure) || '回答失败；请求可能已在其他端处理。')
      setBusy(false)
    }
  }

  return (
    <div className="border-t border-border bg-accent-subtle px-3 py-2" role="group" aria-label="需要你处理的确认">
      <div className="flex items-center gap-2">
        <span className="text-2xs font-semibold text-accent">需要你处理</span>
        {requests.length > 1 && <span className="text-2xs text-muted">还有 {requests.length - 1} 个</span>}
      </div>
      <div className="mt-0.5 truncate text-sm text-fg" title={request.title}>{request.title || '扩展请求'}</div>
      {request.message && <div className="mt-0.5 line-clamp-2 text-2xs text-muted" title={request.message}>{request.message}</div>}
      {error && <div role="alert" className="mt-1 text-2xs text-danger">{error}</div>}
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => { void answer(true) }}
          className="rounded border border-accent bg-accent px-3 py-1 text-xs text-accent-fg hover:opacity-90 disabled:opacity-50"
        >
          允许
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => { void answer(false) }}
          className="rounded border border-border px-3 py-1 text-xs text-muted hover:border-danger hover:text-danger disabled:opacity-50"
        >
          拒绝
        </button>
      </div>
    </div>
  )
}