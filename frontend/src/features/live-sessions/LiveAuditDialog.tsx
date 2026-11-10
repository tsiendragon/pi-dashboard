import { useEffect, useState } from 'react'
import type { LiveSessionAuditEntry } from '@shared/live-sessions'
import { MaterialIcon } from '../../components/MaterialIcon'

const ACTION_LABEL: Record<LiveSessionAuditEntry['action'], string> = {
  allowed: '已允许',
  denied: '已拒绝',
  answered: '已回答',
  cancelled: '已取消',
  authorized: '已授权',
  withdrawn: '已撤回排队',
}

const METHOD_LABEL: Record<NonNullable<LiveSessionAuditEntry['method']>, string> = {
  confirm: '确认',
  select: '选择',
  input: '输入',
  editor: '编辑器',
  sudo: 'sudo',
  queue: '排队消息',
}

function actionTone(action: LiveSessionAuditEntry['action']): string {
  if (action === 'denied' || action === 'cancelled') return 'text-warn'
  if (action === 'withdrawn') return 'text-muted'
  return 'text-accent'
}

function formatTime(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/**
 * Read-only decision log for one live session.
 *
 * The dashboard records what the user settled and when; this panel shows it without
 * editorializing. A failed load is shown as a failure — an empty list would look like
 * "nothing was ever approved", which is a different (and false) statement.
 */
export default function LiveAuditDialog({
  processInstanceId,
  onClose,
  load,
}: {
  processInstanceId: string
  onClose: () => void
  load: (processInstanceId: string, limit?: number) => Promise<LiveSessionAuditEntry[]>
}) {
  const [entries, setEntries] = useState<LiveSessionAuditEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    load(processInstanceId, 100)
      .then(next => { if (alive) setEntries(next) })
      .catch(failure => { if (alive) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { alive = false }
  }, [processInstanceId, load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
    <div
      role="dialog"
      aria-modal="true"
      aria-label="审批与撤回记录"
      className="flex max-h-[min(80dvh,40rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl"
      onClick={event => event.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="text-sm font-semibold text-text-strong">审批与撤回记录</div>
        <button type="button" onClick={onClose} aria-label="关闭记录" className="rounded border border-border px-2 py-0.5 text-2xs text-muted hover:border-accent hover:text-accent">关闭</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-2xs">
        <p className="mb-2 text-muted">记录由 Dashboard 本地保存，含时间、决定与来源端；不会保存密码或 sudo 完整参数。</p>
        {error && <div role="alert" className="py-2 text-danger">读取记录失败：{error}</div>}
        {!error && entries === null && <div role="status" className="py-2 text-muted">读取中…</div>}
        {!error && entries?.length === 0 && <div className="py-2 text-muted">这一会话还没有需要处理的请求或撤回。</div>}
        {entries && entries.length > 0 && <ul className="divide-y divide-border">
          {entries.map((entry, index) => <li key={`${entry.at}-${index}`} className="flex items-start gap-2 py-1.5">
            <MaterialIcon
              name={entry.action === 'withdrawn' ? 'schedule' : entry.action === 'allowed' || entry.action === 'authorized' ? 'check' : 'block'}
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${actionTone(entry.action)}`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className={actionTone(entry.action)}>{ACTION_LABEL[entry.action]}</span>
                {entry.method && <span className="text-muted">{METHOD_LABEL[entry.method]}</span>}
                <span className="text-muted">{formatTime(entry.at)}</span>
                {entry.client && <span className="text-muted">来源 {entry.client}</span>}
              </div>
              {entry.title && <div className="truncate text-fg" title={entry.title}>{entry.title}</div>}
              {entry.detail && <div className="text-muted">{entry.detail}</div>}
            </div>
          </li>)}
        </ul>}
      </div>
    </div>
  </div>
}