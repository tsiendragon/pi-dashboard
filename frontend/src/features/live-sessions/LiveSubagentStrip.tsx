import { useState } from 'react'
import type { SubagentSessionItem } from './subagentSessions'
import { isFailedSubagent, subagentGroups } from './subagentSessions'

export default function LiveSubagentStrip({ items, focusedId, confirmCloseId, closingIds = [], onFocus, onStop }: {
  items: SubagentSessionItem[]
  focusedId?: string
  confirmCloseId?: string
  closingIds?: string[]
  onFocus: (item: SubagentSessionItem) => void
  onStop: (item: SubagentSessionItem) => void
}) {
  const [hidden, setHidden] = useState<Record<string, string>>({})
  const signature = (item: SubagentSessionItem) => JSON.stringify([item.status, item.record?.latestRunId, item.record?.error, item.session?.processInstanceId])
  const isHidden = (item: SubagentSessionItem) => item.bucket !== 'active' && hidden[item.id] === signature(item)
  const hiddenItems = items.filter(isHidden)
  const visible = items.filter(item => !isHidden(item))
  const groups = subagentGroups(visible)
  const failed = groups.attention.filter(item => isFailedSubagent(item.status))
  const attention = groups.attention.filter(item => !isFailedSubagent(item.status))
  if (!items.length) return null
  const rows = (entries: SubagentSessionItem[]) => <div className="flex flex-wrap gap-1.5">
    {entries.map(item => <div key={item.id} className={`flex min-w-0 max-w-full items-center rounded border text-xs ${focusedId === item.id ? 'border-accent bg-accent-subtle' : 'border-border bg-card'}`}>
      <button type="button" className="min-w-0 px-2 py-1 text-left hover:text-accent focus-visible:outline-accent" onClick={() => onFocus(item)} title={item.label}>
        <span className="block max-w-64 truncate">{item.label}</span>
        <span className={item.bucket === 'attention' ? 'text-2xs text-danger' : 'text-2xs text-muted'}>
          {isFailedSubagent(item.status) ? '执行失败' : item.bucket === 'active' ? '运行中' : item.bucket === 'completed' ? '已完成' : item.bucket === 'stopped' ? '已停止' : item.bucket === 'attention' ? '需要处理' : '状态待确认'}
          {!item.session && ' · 无实时连接'}
        </span>
      </button>
      {item.session && item.bucket !== 'completed' && item.bucket !== 'stopped' && <button type="button"
        className="shrink-0 px-2 py-1 text-muted hover:text-danger focus-visible:outline-accent" aria-label={`停止子助手：${item.label}`}
        title="结束执行会话；这不是收起记录" disabled={closingIds.includes(item.session.processInstanceId)}
        onClick={() => onStop(item)}>{closingIds.includes(item.session.processInstanceId) ? '正在停止' : confirmCloseId === item.session.processInstanceId ? '确认停止' : '停止'}</button>}
      {item.bucket !== 'active' && (!item.session || item.bucket === 'completed' || item.bucket === 'stopped') && <button type="button"
        className="shrink-0 px-2 py-1 text-muted hover:text-accent focus-visible:outline-accent" aria-label={`收起记录：${item.label}`}
        title="仅从当前列表收起，不停止进程、不删除历史；可恢复"
        onClick={() => setHidden(previous => ({ ...previous, [item.id]: signature(item) }))}>收起</button>}
    </div>)}
  </div>
  return <section aria-label="子助手任务" className="shrink-0 space-y-2 border-b border-border bg-card px-3 py-2">
    {groups.active.length > 0 && <div><div className="mb-1 text-2xs font-medium text-muted">运行中 · {groups.active.length}</div>{rows(groups.active)}</div>}
    {attention.length > 0 && <div><div className="mb-1 text-2xs font-medium text-warn">需要处理或确认 · {attention.length}</div>{rows(attention)}</div>}
    {failed.length > 0 && <details>
      <summary className="cursor-pointer text-2xs font-medium text-danger">执行失败 · {failed.length}（展开查看原因）</summary>
      <div className="mt-1">{rows(failed)}</div>
    </details>}
    {(['completed', 'stopped'] as const).map(key => groups[key].length > 0 && <details key={key}>
      <summary className="cursor-pointer text-2xs font-medium text-muted">{key === 'completed' ? '已完成' : '已停止'} · {groups[key].length}</summary>
      <div className="mt-1">{rows(groups[key])}</div>
    </details>)}
    {hiddenItems.length > 0 && <div className="flex flex-wrap items-center gap-2 text-2xs text-muted">
      <span>本页已收起 · {hiddenItems.length}（历史未删除）</span>
      <button type="button" className="rounded px-2 py-1 hover:text-accent focus-visible:outline-accent" onClick={() => setHidden({})}>恢复收起的记录</button>
    </div>}
  </section>
}
