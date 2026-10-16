import type { SubagentSessionItem } from './subagentSessions'
import { subagentGroups } from './subagentSessions'

export default function LiveSubagentStrip({ items, focusedId, confirmCloseId, closingIds = [], onFocus, onStop }: {
  items: SubagentSessionItem[]
  focusedId?: string
  confirmCloseId?: string
  closingIds?: string[]
  onFocus: (item: SubagentSessionItem) => void
  onStop: (item: SubagentSessionItem) => void
}) {
  if (!items.length) return null
  const groups = subagentGroups(items)
  const rows = (entries: SubagentSessionItem[]) => <div className="flex flex-wrap gap-1.5">
    {entries.map(item => <div key={item.id} className={`flex min-w-0 max-w-full items-center rounded border text-xs ${focusedId === item.id ? 'border-accent bg-accent-subtle' : 'border-border bg-card'}`}>
      <button type="button" className="min-w-0 px-2 py-1 text-left hover:text-accent focus-visible:outline-accent" onClick={() => onFocus(item)} title={item.label}>
        <span className="block max-w-64 truncate">{item.label}</span>
        <span className={`text-2xs ${item.bucket === 'attention' ? 'text-danger' : 'text-muted'}`}>
          {item.bucket === 'active' ? '运行中' : item.bucket === 'completed' ? '已完成' : item.bucket === 'stopped' ? '已停止' : item.bucket === 'attention' ? '需要处理' : '状态待确认'}
          {!item.session && ' · 当前无连接'}
        </span>
      </button>
      {item.session && item.bucket !== 'completed' && item.bucket !== 'stopped' && <button type="button"
        className="shrink-0 px-2 py-1 text-muted hover:text-danger" aria-label={`停止子助手：${item.label}`}
        title="结束执行会话；这不是收起记录" disabled={closingIds.includes(item.session.processInstanceId)}
        onClick={() => onStop(item)}>{closingIds.includes(item.session.processInstanceId) ? '正在停止' : confirmCloseId === item.session.processInstanceId ? '确认停止' : '停止'}</button>}
    </div>)}
  </div>
  return <section aria-label="子助手任务" className="shrink-0 space-y-2 border-b border-border bg-card px-3 py-2">
    {groups.active.length > 0 && <div><div className="mb-1 text-2xs font-medium text-muted">运行中 · {groups.active.length}</div>{rows(groups.active)}</div>}
    {groups.attention.length > 0 && <div><div className="mb-1 text-2xs font-medium text-warn">需要处理或确认 · {groups.attention.length}</div>{rows(groups.attention)}</div>}
    {(['completed', 'stopped'] as const).map(key => groups[key].length > 0 && <details key={key}>
      <summary className="cursor-pointer text-2xs font-medium text-muted">{key === 'completed' ? '已完成' : '已停止'} · {groups[key].length}</summary>
      <div className="mt-1">{rows(groups[key])}</div>
    </details>)}
  </section>
}
