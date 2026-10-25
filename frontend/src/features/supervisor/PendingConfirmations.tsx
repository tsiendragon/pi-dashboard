import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppDispatch, useAppSelector } from '../../store'
import { uiAnswered } from '../../store/liveSessionsSlice'
import { liveSessionApi } from '../live-sessions/api'
import { collectPendingConfirmations, type PendingConfirmation } from './pendingConfirmation'

/**
 * Approvals for main-agent writes, kept where the write belongs.
 *
 * A modal covers the screen and, for a long record, pushes its own buttons out of view. These
 * surfaces stay put instead: the task page shows its own pending write, the sidebar badge shows
 * every pending write, and the modal remains only as a fallback for requests with no target.
 */

function usePendingConfirmations(objectRef?: string): PendingConfirmation[] {
  const pendingUi = useAppSelector(state => state.liveSessions.pendingUi)
  const sessions = useAppSelector(state => state.liveSessions.sessions)
  return collectPendingConfirmations(pendingUi, sessions, objectRef)
}

/**
 * Send the answer, then drop the row.
 *
 * Deliberately not optimistic: dropping the card before the answer lands made a failed send look
 * exactly like a success, while pi kept waiting and the agent stayed blocked. On failure the row
 * stays put so the user can retry.
 */
function useAnswer(): (item: PendingConfirmation, decision: 'approve' | 'deny') => Promise<string | undefined> {
  const dispatch = useAppDispatch()
  return async (item, decision) => {
    try {
      await liveSessionApi.command(item.processInstanceId, decision === 'approve'
        ? { type: 'answer_ui', id: item.request.id, value: 'true' }
        : { type: 'answer_ui', id: item.request.id, cancelled: true })
      dispatch(uiAnswered({ processInstanceId: item.processInstanceId, id: item.request.id }))
      return undefined
    } catch (error) {
      // Answered elsewhere (another tab, the TUI) arrives as `extension_ui_closed` and removes the
      // row by itself, so anything caught here is a real send failure worth showing.
      return error instanceof Error && error.message ? error.message : '发送失败，请重试'
    }
  }
}

function ApproveButtons({ onDecide }: { onDecide: (decision: 'approve' | 'deny') => Promise<string | undefined> }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const run = async (decision: 'approve' | 'deny'): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFailure(undefined)
    try { setFailure(await onDecide(decision)) } finally { setBusy(false) }
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {failure && <span role="alert" className="text-2xs text-danger">{failure}</span>}
      <button
        type="button"
        disabled={busy}
        onClick={() => void run('deny')}
        className="rounded-lg border border-border px-3 py-1.5 text-body-s font-medium text-muted transition hover:border-danger hover:text-danger disabled:opacity-40"
      >不允许</button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run('approve')}
        className="rounded-lg border-none bg-accent px-3 py-1.5 text-body-s font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-40"
      >允许这次操作</button>
    </div>
  )
}

function targetLabel(item: PendingConfirmation): string {
  if (item.sessionLabel) return `来自「${item.sessionLabel}」`
  return '来自主 Agent'
}

/**
 * Pending writes for one object, rendered inline on the page that owns that object.
 * Returns nothing when this object has no pending write, so the page never grows a dead block.
 */
export function PendingConfirmations({ objectRef, className = '' }: { objectRef: string; className?: string }) {
  const items = usePendingConfirmations(objectRef)
  const answer = useAnswer()
  if (!items.length) return null
  return (
    <section aria-label="等待你确认的写入" className={`space-y-2 ${className}`}>
      {items.map(item => (
        <article key={`${item.processInstanceId}:${item.request.id}`} className="rounded-xl border border-accent bg-accent-subtle/40 px-4 py-3">
          <div className="mb-1 flex flex-wrap items-baseline gap-2">
            <span className="text-body-s font-semibold text-text-strong">等你确认：{item.summary || item.request.title || '一次写入'}</span>
            <span className="text-2xs text-muted">{targetLabel(item)}{item.operation ? ` · ${item.operation}` : ''}</span>
          </div>
          {item.body && (
            <p className="mb-2 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-2xs leading-5 text-muted">{item.body}</p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-2xs text-muted">不点不会超时取消；也可以直接对主 Agent 回复「确认」。</span>
            <ApproveButtons onDecide={decision => answer(item, decision)} />
          </div>
        </article>
      ))}
    </section>
  )
}

/**
 * Sidebar fallback: a count plus a short list, so a pending write is never invisible while the
 * user is on an unrelated page. Each row can be answered right here.
 */
export function PendingConfirmationBadge({ collapsed = false }: { collapsed?: boolean }) {
  const items = usePendingConfirmations()
  const answer = useAnswer()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  return (
    <div className="relative mt-1 shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${items.length} 项待确认`}
        title={`${items.length} 项等待你确认的主 Agent 写入`}
        onClick={() => setOpen(value => !value)}
        className={`flex items-center rounded-md border border-accent bg-accent-subtle text-body-s font-semibold text-accent transition hover:bg-accent/15 ${collapsed ? 'justify-center px-2 py-1.5' : 'w-full justify-between px-2.5 py-2'}`}
      >
        <span className={collapsed ? 'text-xs' : ''}>{collapsed ? items.length : '待确认'}</span>
        {!collapsed && <span className="rounded-full bg-accent px-1.5 text-2xs font-semibold text-accent-fg">{items.length}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" aria-hidden="true" onClick={() => setOpen(false)} />
          <section
            role="dialog"
            aria-label="待确认的主 Agent 写入"
            onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }}
            className="absolute bottom-full left-0 z-40 mb-2 max-h-[min(60vh,26rem)] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-border bg-card p-3 shadow-xl"
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-body-s font-semibold text-text-strong">待确认的主 Agent 写入</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="关闭待确认列表" className="text-muted hover:text-text">×</button>
            </div>
            <ul className="space-y-2">
              {items.map(item => {
                const target = item.objectRef
                return <li key={`${item.processInstanceId}:${item.request.id}`} className="rounded-lg border border-border p-2">
                  <p className="text-body-s font-medium text-text-strong">{item.summary || item.request.title || '一次写入'}</p>
                  <p className="mt-0.5 text-2xs text-muted">{targetLabel(item)}{item.operation ? ` · ${item.operation}` : ''}</p>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    {target ? (
                      <button
                        type="button"
                        className="text-2xs text-accent hover:underline"
                        onClick={() => { setOpen(false); navigate(`/tasks/events?objectRef=${encodeURIComponent(target)}`) }}
                      >去对应页面 →</button>
                    ) : <span />}
                    <ApproveButtons onDecide={async decision => {
                      const failure = await answer(item, decision)
                      // Keep the panel open when the answer did not land, so its error stays readable.
                      if (!failure) setOpen(false)
                      return failure
                    }} />
                  </div>
                </li>
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}