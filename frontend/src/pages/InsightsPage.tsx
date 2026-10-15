import { useSearchParams } from 'react-router-dom'
import UsagePage from './UsagePage'
import TimePage from './TimePage'
import ModelLeaderboard from './ModelLeaderboard'

type TabId = 'cost' | 'time' | 'models'

const TABS: { id: TabId; label: string; title: string; subtitle: string }[] = [
  { id: 'cost', label: '成本', title: 'Cost · Time · 模型榜', subtitle: '成本、耗时与模型能力排行，统一入口' },
  { id: 'time', label: '耗时', title: 'Cost · Time · 模型榜', subtitle: '成本、耗时与模型能力排行，统一入口' },
  { id: 'models', label: '模型排行榜', title: 'Cost · Time · 模型榜', subtitle: '成本、耗时与模型能力排行，统一入口' },
]

export default function InsightsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab: TabId = tabParam === 'time' || tabParam === 'models' ? tabParam : 'cost'
  const active = TABS.find(t => t.id === tab) ?? TABS[0]

  const selectTab = (id: TabId) => {
    const next = new URLSearchParams()
    if (id !== 'cost') next.set('tab', id)
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg overflow-hidden">
      <header className="shrink-0 border-b border-border bg-bg px-4 md:px-6 pt-4">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-lg font-semibold text-text-strong">{active.title}</h1>
              <p className="text-xs text-muted mt-0.5">{active.subtitle}</p>
            </div>
          </div>
          <div className="mt-3 flex gap-1 -mb-px" role="tablist" aria-label="统计视图">
            {TABS.map(t => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => selectTab(t.id)}
                className={`px-3 py-1.5 text-sm rounded-t-md border border-b-0 transition-colors ${
                  tab === t.id
                    ? 'border-border bg-card text-text-strong font-medium'
                    : 'border-transparent text-muted hover:text-text hover:bg-bg-hover'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </header>
      {tab === 'cost' && <UsagePage embedded />}
      {tab === 'time' && <TimePage embedded />}
      {tab === 'models' && <ModelLeaderboard />}
    </div>
  )
}
