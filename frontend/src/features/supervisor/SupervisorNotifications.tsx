import { useState } from 'react'
import type { SupervisorAgentOpenOptions } from './SupervisorAgentProvider'
import { supervisorApi } from './api'
import { useSupervisorResource } from './useSupervisorResource'
import { SupervisorFailure, timeText } from './SupervisorViews'

export default function SupervisorNotifications({ className, openAgent }: { className?: string; openAgent: (options?: SupervisorAgentOpenOptions) => void }) {
  const [open, setOpen] = useState(false)
  const state = useSupervisorResource(supervisorApi.state, true, 30000)
  const actions = (state.data?.actions || []).filter(action => action.state === 'open' || action.state === 'suggested').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return <div className="relative">
    <button type="button" className={className} aria-label="打开最近待办通知" aria-expanded={open} onClick={() => setOpen(value => !value)} title="查看当前授权范围内的待办与建议">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 shrink-0 fill-none stroke-current" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg><span className="truncate">通知</span>{actions.length > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full bg-accent px-1 text-center text-[9px] font-semibold leading-[15px] text-accent-fg">{actions.length}</span>}
    </button>
    {open && <>
      <div className="fixed inset-0 z-30" aria-hidden="true" onClick={() => setOpen(false)} />
      <section role="dialog" aria-label="最近待办通知" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }} className="absolute right-full top-0 z-40 mr-3 max-h-[70vh] w-[min(360px,calc(100vw-100px))] overflow-y-auto rounded-xl border border-border bg-card p-3 shadow-xl">
        <div className="flex items-center justify-between"><h2 className="font-medium">最近要做的事情</h2><button type="button" onClick={() => setOpen(false)} aria-label="关闭待办通知">×</button></div>
        <p className="my-2 text-2xs text-muted">仅当前授权范围；建议未确认，不代表正式任务已变更。</p>
        <SupervisorFailure error={state.error} retry={state.refresh} />
        {state.loading && !state.data && <p role="status">正在读取待办…</p>}
        {!state.loading && !state.error && !actions.length && <p className="text-body-s text-muted">当前范围没有待处理事项。</p>}
        <ul className="space-y-2">{actions.map(action => <li key={action.id} className="rounded-lg border border-border p-2">
          <p className="text-body-s font-medium">{action.title}</p>
          <p className="text-2xs text-muted">{action.state === 'suggested' ? '建议，待确认' : '待处理'} · {timeText(action.updatedAt)}</p>
          <p className="my-1 whitespace-pre-wrap text-body-s">{action.reason}</p>
          <button type="button" className="text-body-s text-accent hover:underline" onClick={() => { setOpen(false); openAgent({ objectRef: action.objectRef, prompt: `请检查待办 ${action.id}：${action.title}。核对来源后说明下一步，不要直接标记完成。` }) }}>交给主 Agent 检查</button>
        </li>)}</ul>
      </section>
    </>}
  </div>
}
