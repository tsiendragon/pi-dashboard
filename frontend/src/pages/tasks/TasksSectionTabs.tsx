import { useNavigate } from 'react-router-dom'

/**
 * The ledger is a child view of Tasks, so both pages share one switch instead of living as two top-level pages.
 */
export function TasksSectionTabs({ active }: { active: 'list' | 'events' }) {
  const navigate = useNavigate()
  const items = [
    { id: 'list' as const, label: '任务清单', path: '/tasks' },
    { id: 'events' as const, label: '事件流水账', path: '/tasks/events' },
  ]
  return <div role="tablist" aria-label="Tasks 视图" className="flex items-center rounded-md border border-border overflow-hidden">
    {items.map(item => (
      <button
        key={item.id}
        role="tab"
        aria-selected={active === item.id}
        onClick={() => navigate(item.path)}
        className={`px-2.5 py-1 text-body-s ${active === item.id ? 'bg-accent-subtle text-accent' : 'text-muted hover:bg-bg-hover'}`}
      >{item.label}</button>
    ))}
  </div>
}