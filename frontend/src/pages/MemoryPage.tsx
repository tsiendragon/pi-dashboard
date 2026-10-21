import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'

type Tab = 'overview' | 'review' | 'active' | 'changes' | 'usage'

interface MemoryOverviewResponse {
  available: boolean
  databasePath: string
  hint?: string
  updatedAt?: number
  counts: { active: number; candidate: number; stale: number; superseded: number; rejected: number; forgotten: number; total: number }
  review: { total: number; conflicts: number; unverified: number; scopeEscalation: number }
  usage: { recallRuns: number; recallCandidates: number; contextInjected: number; verified: number; corrected: number; lastActivityAt?: number }
  health: { pendingIndexJobs: number; failedIndexJobs: number; lastEventAt?: number }
  selfManagement: { autoAccepted: number; agentCreated: number; userDecided: number; rejectedByAgent: number }
}

interface MemoryItem {
  id: string
  kind: string
  status: string
  scopeType: string
  scopeKey: string
  content: string
  confidence: number
  version: number
  observedCount: number
  appliedCount: number
  verifiedCount: number
  correctedCount: number
  createdAt: number
  updatedAt: number
  conflicts: number
  source?: { authority: string; verified: boolean; sourceType: string; sourceUri: string }
}

interface MemoryChange {
  id: string
  memoryId: string
  eventType: string
  fromStatus?: string
  toStatus?: string
  actor: string
  reasonCode: string
  createdAt: number
  contentPreview: string
}

interface MemoryUsageResponse {
  windowDays: number
  recallRuns: number
  recallCandidates: number
  contextInjected: number
  verified: number
  averageLatencyMs: number
  lastContextInjectionAt?: number
  topUsed: Array<{ id: string; content: string; injected: number; verified: number }>
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'review', label: '待确认' },
  { id: 'active', label: '生效记忆' },
  { id: 'changes', label: '最近变化' },
  { id: 'usage', label: '使用与效果' },
]

function timeAgo(ts?: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function Card({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-2xs text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold text-text-strong">{value}</div>
      {hint && <div className="mt-1 text-2xs text-muted">{hint}</div>}
    </div>
  )
}

function reviewReason(item: MemoryItem): string {
  if (item.conflicts > 0) return `与 ${item.conflicts} 条现有记忆冲突`
  if (item.scopeType === 'global') return '想升级为全局记忆'
  if (!item.source?.verified) return '没有可核验来源'
  return '等待确认'
}

function MemoryRow({ item, showReason }: { item: MemoryItem; showReason?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-2xs text-muted">
        <span className="rounded bg-bg-hover px-1.5 py-0.5">{item.kind}</span>
        <span className="rounded bg-bg-hover px-1.5 py-0.5">{item.scopeType}</span>
        <span>置信 {item.confidence.toFixed(2)}</span>
        <span>更新 {timeAgo(item.updatedAt)}</span>
        {item.source && (
          <span className={item.source.verified ? 'text-success' : 'text-warning'}>
            {item.source.verified ? '已验证来源' : '未验证来源'} · {item.source.authority}
          </span>
        )}
      </div>
      <div className="mt-2 whitespace-pre-wrap break-words text-body-s text-text">{item.content}</div>
      {showReason && <div className="mt-2 text-2xs text-warning">需要你确认：{reviewReason(item)}</div>}
    </div>
  )
}

export default function MemoryPage() {
  const [tab, setTab] = useState<Tab>('overview')
  const [overview, setOverview] = useState<MemoryOverviewResponse | null>(null)
  const [items, setItems] = useState<MemoryItem[]>([])
  const [review, setReview] = useState<MemoryItem[]>([])
  const [changes, setChanges] = useState<MemoryChange[]>([])
  const [usage, setUsage] = useState<MemoryUsageResponse | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)

  const loadTab = useCallback(
    async (target: Tab) => {
      setLoading(true)
      try {
        if (target === 'review') setReview((await api.memoryReviewQueue(50)).items as MemoryItem[])
        if (target === 'active') setItems((await api.memoryItems({ status: 'active', search: search || undefined, limit: 100 })).items as MemoryItem[])
        if (target === 'changes') setChanges((await api.memoryChanges(80)).changes as MemoryChange[])
        if (target === 'usage') setUsage((await api.memoryUsage(7)) as MemoryUsageResponse)
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error))
      } finally {
        setLoading(false)
      }
    },
    [search],
  )
  const [errorText, setErrorText] = useState<string>('')

  const refresh = useCallback(async () => {
    setErrorText('')
    try {
      setOverview((await api.memoryOverview()) as MemoryOverviewResponse)
      await loadTab(tab)
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error))
    }
  }, [tab, search, loadTab])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const needsAuth = useMemo(() => /authentication_required|401/.test(errorText), [errorText])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <div className="text-lg font-semibold text-text-strong">Memory</div>
          <div className="text-2xs text-muted">
            {overview?.available
              ? `助手自己维护的长期记忆 · 数据更新于 ${timeAgo(overview.updatedAt)}`
              : '记忆数据库不可用'}
          </div>
        </div>
        <button className="rounded border border-border px-3 py-1.5 text-body-s hover:bg-bg-hover" onClick={() => void refresh()} disabled={loading}>
          {loading ? '读取中…' : '刷新'}
        </button>
      </div>

      <div className="flex gap-1 border-b border-border px-6 py-2">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            className={`rounded px-3 py-1.5 text-body-s ${tab === entry.id ? 'bg-bg-hover text-text-strong' : 'text-muted hover:bg-bg-hover'}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {entry.id === 'review' && (overview?.counts.candidate ?? 0) > 0 ? ` (${overview?.counts.candidate})` : ''}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {needsAuth && (
          <div className="mb-4 rounded-lg border border-warning bg-card px-4 py-3 text-body-s text-text">
            需要先在 dashboard 的终端面板完成一次认证，浏览器拿到凭据后才能查看记忆内容。
          </div>
        )}
        {!needsAuth && errorText && <div className="mb-4 rounded-lg border border-warning bg-card px-4 py-3 text-body-s text-text">{errorText}</div>}
        {overview && !overview.available && (
          <div className="mb-4 rounded-lg border border-warning bg-card px-4 py-3 text-body-s text-text">
            {overview.hint}
            <div className="mt-1 text-2xs text-muted">{overview.databasePath}</div>
          </div>
        )}

        {tab === 'overview' && overview && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card label="生效记忆" value={overview.counts.active} hint="能自动被检索到" />
              <Card label="待确认" value={overview.counts.candidate} hint={`冲突 ${overview.review.conflicts} · 无来源 ${overview.review.unverified} · 全局 ${overview.review.scopeEscalation}`} />
              <Card label="最近 7 天实际入模" value={overview.usage.contextInjected} hint="真正送进模型的条数" />
              <Card label="经验证采用" value={overview.usage.verified} hint={overview.usage.verified === 0 ? '尚无验证闭环' : '有结果证据的采用'} />
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card label="助手自动采纳" value={overview.selfManagement.autoAccepted} hint="有来源且无冲突" />
              <Card label="助手自动提取" value={overview.selfManagement.agentCreated} hint="候选来源" />
              <Card label="你确认/拒绝" value={overview.selfManagement.userDecided} hint="只处理疑难项" />
              <Card label="检索运行" value={overview.usage.recallRuns} hint="记忆检索次数" />
            </div>
            <div className="rounded-lg border border-border bg-card px-4 py-3 text-body-s text-text">
              <div className="text-2xs text-muted">后台状态</div>
              <div className="mt-1">
                索引任务积压 {overview.health.pendingIndexJobs} 条{overview.health.failedIndexJobs > 0 ? `（失败 ${overview.health.failedIndexJobs}）` : ''} · 最近变动 {timeAgo(overview.health.lastEventAt)}
              </div>
              <div className="mt-1 text-2xs text-muted">{overview.databasePath}</div>
            </div>
          </div>
        )}

        {tab === 'review' && (
          <div className="space-y-3">
            {review.length === 0 && <div className="text-body-s text-muted">没有需要你确认的记忆。含糊或冲突的内容会出现在这里。</div>}
            {review.map((item) => (
              <MemoryRow key={item.id} item={item} showReason />
            ))}
          </div>
        )}

        {tab === 'active' && (
          <div className="space-y-3">
            <input
              className="w-full rounded border border-border bg-card px-3 py-2 text-body-s"
              placeholder="搜索记忆内容"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {items.length === 0 && <div className="text-body-s text-muted">没有匹配的生效记忆。</div>}
            {items.map((item) => (
              <MemoryRow key={item.id} item={item} />
            ))}
          </div>
        )}

        {tab === 'changes' && (
          <div className="space-y-2">
            {changes.length === 0 && <div className="text-body-s text-muted">暂无变动记录。</div>}
            {changes.map((change) => (
              <div key={change.id} className="rounded-lg border border-border bg-card px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2 text-2xs text-muted">
                  <span className="rounded bg-bg-hover px-1.5 py-0.5">{change.actor}</span>
                  <span>{change.eventType}</span>
                  {change.toStatus && <span>{change.fromStatus ? `${change.fromStatus} → ${change.toStatus}` : change.toStatus}</span>}
                  <span>{change.reasonCode}</span>
                  <span>{timeAgo(change.createdAt)}</span>
                </div>
                {change.contentPreview && <div className="mt-1 break-words text-body-s text-text">{change.contentPreview}</div>}
              </div>
            ))}
          </div>
        )}

        {tab === 'usage' && usage && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card label={`近 ${usage.windowDays} 天检索`} value={usage.recallRuns} />
              <Card label="检索候选条数" value={usage.recallCandidates} hint="可能被预算裁掉" />
              <Card label="实际入模条数" value={usage.contextInjected} hint="最终进入上下文" />
              <Card label="经验证采用" value={usage.verified} hint={usage.verified === 0 ? '未验证，不作效果结论' : '有结果证据'} />
            </div>
            <div className="rounded-lg border border-border bg-card px-4 py-3 text-body-s text-text">
              平均检索耗时 {usage.averageLatencyMs} ms · 最近一次入模 {timeAgo(usage.lastContextInjectionAt)}
              <div className="mt-1 text-2xs text-muted">“检索候选”只说明被找到，“实际入模”才说明送到模型眼前；两者都不等于“帮上了忙”。</div>
            </div>
            <div className="space-y-2">
              <div className="text-2xs text-muted">使用最多的记忆</div>
              {usage.topUsed.length === 0 && <div className="text-body-s text-muted">这段时间没有记忆被使用。</div>}
              {usage.topUsed.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-border bg-card px-4 py-2.5">
                  <div className="flex items-center gap-2 text-2xs text-muted">
                    <span>入模 {entry.injected}</span>
                    <span>验证 {entry.verified}</span>
                  </div>
                  <div className="mt-1 break-words text-body-s text-text">{entry.content}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
