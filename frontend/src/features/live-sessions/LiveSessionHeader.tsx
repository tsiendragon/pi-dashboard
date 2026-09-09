import type { LiveSessionSummary } from '@shared/live-sessions'
import { displayWorktreePath } from '../../utils/displayPath'

interface LiveSessionHeaderProps {
  summary: LiveSessionSummary
  owned: boolean
  busy: boolean
  onClaim: () => void
  onRelease: () => void
  onAbort: () => void
  sidebarVisible?: boolean
}

export default function LiveSessionHeader({ summary, owned, busy, onClaim, onRelease, onAbort, sidebarVisible = true }: LiveSessionHeaderProps) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${summary.status === 'running' ? 'bg-ok animate-pulse' : summary.status === 'reconnecting' ? 'bg-warn' : 'bg-muted'}`} />
          <h1 className="min-w-0 whitespace-normal break-words text-sm font-semibold text-text-strong" title={summary.sessionName || `Pi session ${summary.pid}`}>{summary.sessionName || `Pi session ${summary.pid}`}</h1>
          {summary.claim.state === 'claimed' && <span className="text-[11px] px-2 py-0.5 rounded-full bg-warn-subtle text-warn">{owned ? '已取得强控制' : '其他端持有强控制'}</span>}
        </div>
        {sidebarVisible ? (
          <div className="mt-1 text-[10px] text-muted">{summary.status === 'running' ? '运行中' : summary.status === 'reconnecting' ? '连接中断' : '空闲'} · {summary.mode.toUpperCase()}</div>
        ) : (
          <>
            <div className="mt-1 text-[11px] text-muted font-mono whitespace-normal break-all" title={summary.canonicalCwd}>{displayWorktreePath(summary.canonicalCwd)}</div>
            <div className="mt-1 text-[10px] text-muted whitespace-normal break-all">
              PID {summary.pid} · {summary.mode.toUpperCase()} · {summary.model ? `${summary.model.provider}/${summary.model.id}` : 'model unavailable'}
              {summary.thinkingLevel ? ` · ${summary.thinkingLevel}` : ''}
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        {summary.status === 'running' && owned && (
          <button type="button" disabled={busy} onClick={onAbort} className="px-3 py-1.5 rounded-md border border-danger/40 bg-danger-subtle text-danger text-xs disabled:opacity-50">Abort</button>
        )}
        {owned ? (
          <button type="button" disabled={busy} onClick={onRelease} className="px-3 py-1.5 rounded-md border border-border bg-bg text-xs text-text disabled:opacity-50">释放强控制</button>
        ) : (
          <button type="button" disabled={busy || summary.status === 'reconnecting'} onClick={onClaim} className="px-3 py-1.5 rounded-md border border-accent bg-accent text-white text-xs disabled:opacity-50">取得强控制</button>
        )}
      </div>
    </header>
  )
}
