import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, CardTitle, SearchInput } from '../../components/ui'
import InfoTip from '../../components/InfoTip'
import MaterialIcon from '../../components/MaterialIcon'
import { authHeader } from '../../api/auth'
import AdvancedSettings from './AdvancedSettings'
import { ACTION_LABEL, TIERS, TIER_LABEL, assignModel, emptyConfig, moveCandidate, tierOf, type SubagentModelsConfig, type Tier } from './config'

type CatalogModel = { id: string; name?: string; provider: string }
type Loaded = { config: SubagentModelsConfig | null; mtimeMs: number | null; path: string; warnings: string[] }
type Notice = { type: 'ok' | 'err'; msg: string; conflict?: boolean }
type Filter = 'all' | 'assigned' | 'unused'

/** What each tier is for, in the words the main agent is told. */
const TIER_HINT: Record<Tier, string> = {
  light: '简单活：抽取、分诊、只读查找',
  medium: '日常活：分析、写代码、调研',
  heavy: '难题：疑难排查、架构判断',
  ultra: '强档不够时，由主 Agent 明确指定才用',
}
/** Semantic theme colour per tier (dot + selected segment), from cheap to expensive. */
const TIER_TONE: Record<Tier, { dot: string; on: string }> = {
  light: { dot: 'bg-ok', on: 'bg-ok-subtle text-ok border-ok' },
  medium: { dot: 'bg-accent', on: 'bg-accent-subtle text-accent border-accent' },
  heavy: { dot: 'bg-warn', on: 'bg-warn-subtle text-warn border-warn' },
  ultra: { dot: 'bg-danger', on: 'bg-danger-subtle text-danger border-danger' },
}
const DEFAULT_EXHAUSTED: Record<Tier, string> = {
  light: '先等 2 分钟，再升到普通档',
  medium: '排队等待',
  heavy: '直接失败',
  ultra: '直接失败',
}

const iconBtn = 'flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-bg-hover hover:text-text focus-ring disabled:pointer-events-none disabled:opacity-25'

function splitRef(model: string): { provider: string; id: string } {
  const i = model.indexOf('/')
  return { provider: model.slice(0, i), id: model.slice(i + 1) }
}

function exhaustedText(config: SubagentModelsConfig, tier: Tier): string {
  const ex = config.tiers[tier].onExhausted
  if (!ex) return DEFAULT_EXHAUSTED[tier]
  const wait = ex.maxWaitMs ? `${Math.round(ex.maxWaitMs / 60_000)} 分钟` : ''
  const to = ex.escalateTo ? `${TIER_LABEL[ex.escalateTo]}档` : ''
  if (ex.action === 'wait_then_escalate') return `先等${wait ? ` ${wait}` : ''}，再升到${to}`
  if (ex.action === 'escalate') return `直接升到${to}`
  if (ex.action === 'wait') return wait ? `最多等待 ${wait}` : '排队等待'
  return ACTION_LABEL[ex.action] ?? ex.action
}

export default function SubagentModelsTab() {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [config, setConfig] = useState<SubagentModelsConfig>(emptyConfig())
  const [dirty, setDirty] = useState(false)
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const [data, cat] = await Promise.all([
        fetch('/api/subagent-models').then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
        fetch('/api/models/catalog').then(r => r.json()).catch(() => ({ models: [] })),
      ])
      setLoaded(data as Loaded)
      setConfig((data as Loaded).config ?? emptyConfig())
      setCatalog(cat?.models ?? [])
      setDirty(false)
      setNotice(null)
    } catch (e) {
      setNotice({ type: 'err', msg: `读取失败：${e instanceof Error ? e.message : String(e)}` })
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const edit = (next: SubagentModelsConfig) => { setConfig(next); setDirty(true); setNotice(null) }

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/subagent-models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ config, baseMtimeMs: loaded?.mtimeMs ?? null }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        setLoaded(l => ({ config, mtimeMs: body.mtimeMs, path: body.path ?? l?.path ?? '', warnings: body.warnings ?? [] }))
        setDirty(false)
        setNotice({ type: 'ok', msg: '已保存，旧文件已备份。子任务下次选模型时自动生效。' })
      } else if (res.status === 409) {
        setNotice({ type: 'err', conflict: true, msg: '文件在你打开之后被别处改过了，没有保存。请重新加载后再改（当前未保存的修改会丢失）。' })
      } else {
        setNotice({ type: 'err', msg: `未保存：${body.error ?? `HTTP ${res.status}`}` })
      }
    } catch (e) {
      setNotice({ type: 'err', msg: `未保存：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setSaving(false)
    }
  }

  const known = useMemo(() => new Set(catalog.map(m => `${m.provider}/${m.id}`)), [catalog])
  const assignedCount = useMemo(() => TIERS.reduce((n, t) => n + config.tiers[t].candidates.length, 0), [config])

  // Catalog models plus any configured model the catalog no longer lists, so they stay visible and removable.
  const rows = useMemo(() => {
    const ids = new Map<string, CatalogModel>()
    for (const m of catalog) ids.set(`${m.provider}/${m.id}`, m)
    for (const t of TIERS) for (const c of config.tiers[t].candidates) if (!ids.has(c.model)) ids.set(c.model, splitRef(c.model))
    const q = query.trim().toLowerCase()
    const byProvider = new Map<string, { full: string; m: CatalogModel }[]>()
    for (const [full, m] of ids) {
      if (q && !`${full} ${m.name ?? ''}`.toLowerCase().includes(q)) continue
      const assigned = tierOf(config, full) !== null
      if ((filter === 'assigned' && !assigned) || (filter === 'unused' && assigned)) continue
      byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), { full, m }])
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [catalog, config, query, filter])
  const totalModels = useMemo(() => {
    const all = new Set(known)
    for (const t of TIERS) for (const c of config.tiers[t].candidates) all.add(c.model)
    return all.size
  }, [known, config])

  if (!loaded && !notice) return <p className="text-body-s text-muted">加载中…</p>

  return (
    <div className="space-y-4">
      {/* Save bar stays visible while scrolling through the long model list. */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
        <div className="min-w-[12rem] flex-1">
          <div className="text-meta text-muted">配置文件</div>
          {loaded && (
            <p className="mt-0.5 truncate font-mono text-meta text-muted" title={loaded.path}>
              {loaded.path}{loaded.config === null ? '（文件不存在，保存时会新建）' : ''}
            </p>
          )}
        </div>
        {dirty && <span className="rounded-full bg-warn-subtle px-2.5 py-0.5 text-meta font-medium text-warn">有未保存的修改</span>}
        {dirty && (
          <button className="rounded-md border border-border px-3 py-1.5 text-body-s text-muted transition hover:bg-bg-hover hover:text-text focus-ring" onClick={() => void load()}>
            放弃修改
          </button>
        )}
        <button
          className="rounded-md border border-accent bg-accent px-4 py-1.5 text-body-s font-medium text-accent-fg transition hover:opacity-90 focus-ring disabled:cursor-not-allowed disabled:border-border disabled:bg-bg-elevated disabled:text-muted"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>

      {notice && (
        <div role="alert" className={`flex items-center gap-3 rounded-md border px-3 py-2 text-body-s font-medium ${notice.type === 'ok' ? 'border-ok bg-ok-subtle text-ok' : 'border-danger bg-danger-subtle text-danger'}`}>
          <MaterialIcon name={notice.type === 'ok' ? 'check' : 'error'} className="h-4 w-4 shrink-0" />
          <span className="flex-1">{notice.msg}</span>
          {(notice.conflict || !loaded) && <button className="rounded-md border border-current px-2 py-1 text-body-s" onClick={() => void load()}>重新加载</button>}
        </div>
      )}
      {loaded && loaded.warnings.length > 0 && (
        <ul className="space-y-1 rounded-md border border-warn bg-warn-subtle px-3 py-2 text-body-s text-warn">
          {loaded.warnings.map(w => <li key={w}>⚠ {w}</li>)}
        </ul>
      )}

      <Card>
        <CardTitle>
          各档位的模型
          <InfoTip text="主 Agent 只说要哪一档；程序按顺序挑第一个能用的模型，遇到限流、额度用完或模型不可用会自动换下一个。每个模型最多放进一个档位。" />
        </CardTitle>
        <p className="-mt-2 mb-3 text-meta text-muted">越靠上越优先；前一个用不了时自动换下一个。</p>
        <div className="space-y-3">
          {TIERS.map(tier => {
            const list = config.tiers[tier].candidates
            return (
              <section key={tier} aria-label={`${TIER_LABEL[tier]}档`} className="flex flex-col rounded-lg border border-border bg-bg">
                <header className="border-b border-border px-3.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${TIER_TONE[tier].dot}`} aria-hidden="true" />
                    <h4 className="text-body-s font-semibold text-text-strong">{TIER_LABEL[tier]}</h4>
                    <span className="rounded-full bg-bg-hover px-2 text-meta text-muted">{list.length} 个</span>
                  </div>
                  <p className="mt-1 text-meta text-muted">{TIER_HINT[tier]}</p>
                  <p className="text-meta text-muted">全部用不了时：{exhaustedText(config, tier)}</p>
                </header>
                {list.length === 0 ? (
                  <p className="px-3.5 py-4 text-meta text-muted">还没有模型。在下方「给模型分档」里选「{TIER_LABEL[tier]}」即可加入。</p>
                ) : (
                  <ol className="divide-y divide-border">
                    {list.map((c, i) => {
                      const { provider, id } = splitRef(c.model)
                      const missing = known.size > 0 && !known.has(c.model)
                      return (
                        <li key={c.model} className="flex items-center gap-2.5 px-3.5 py-1.5">
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${i === 0 ? TIER_TONE[tier].on + ' border' : 'bg-bg-hover text-muted'}`}>{i + 1}</span>
                          <div className="min-w-0 flex-1">
                            <div className="break-all font-mono text-body-s text-text" title={c.model}>{id}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-meta text-muted">
                              <span>{provider}</span>
                              {i === 0 && <span className="rounded bg-bg-hover px-1.5">首选</span>}
                              {c.thinking && <span className="rounded bg-bg-hover px-1.5">思考 {c.thinking}</span>}
                              {missing && <span className="rounded bg-danger-subtle px-1.5 text-danger">不在模型列表</span>}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center">
                            <button aria-label={`上移 ${c.model}`} title="上移" className={iconBtn} disabled={i === 0} onClick={() => edit(moveCandidate(config, tier, i, -1))}>
                              <MaterialIcon name="keyboard_arrow_up" className="h-4 w-4" />
                            </button>
                            <button aria-label={`下移 ${c.model}`} title="下移" className={iconBtn} disabled={i === list.length - 1} onClick={() => edit(moveCandidate(config, tier, i, 1))}>
                              <MaterialIcon name="keyboard_arrow_up" className="h-4 w-4 rotate-180" />
                            </button>
                            <button aria-label={`移出 ${c.model}`} title="移出这个档位（改为不用）" className={`${iconBtn} hover:text-danger`} onClick={() => edit(assignModel(config, c.model, null))}>
                              <MaterialIcon name="close" className="h-4 w-4" />
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                )}
              </section>
            )
          })}
        </div>
        <AdvancedSettings config={config} onChange={edit} />
      </Card>

      <Card>
        <CardTitle>
          给模型分档
        </CardTitle>
        <p className="-mt-2 mb-3 text-meta text-muted">新分进来的模型排在该档最后，可在上面调整顺序。</p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <SearchInput className="min-w-[200px] flex-1" placeholder="搜索模型或供应商" aria-label="搜索模型" value={query} onChange={e => setQuery(e.target.value)} />
          <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="筛选">
            {([['all', `全部 ${totalModels}`], ['assigned', `已分档 ${assignedCount}`], ['unused', `不用 ${totalModels - assignedCount}`]] as const).map(([key, label]) => (
              <button
                key={key}
                aria-pressed={filter === key}
                className={`rounded px-2.5 py-1 text-meta transition focus-ring ${filter === key ? 'bg-bg-hover font-medium text-text-strong' : 'text-muted hover:text-text'}`}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {rows.length === 0 && <p className="py-6 text-center text-body-s text-muted">没有匹配的模型。</p>}
        <div className="space-y-3">
          {rows.map(([provider, models]) => (
            <section key={provider} className="overflow-hidden rounded-lg border border-border">
              <h4 className="flex items-center gap-2 border-b border-border bg-bg-elevated px-3.5 py-2 text-body-s font-semibold text-text-strong">
                {provider}
                <span className="text-meta font-normal text-muted">{models.length}</span>
              </h4>
              <div className="divide-y divide-border">
                {models.map(({ full, m }) => {
                  const current = tierOf(config, full)
                  return (
                    <div key={full} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2">
                      <div className="min-w-[180px] flex-1">
                        <div className={`break-all font-mono text-body-s ${current ? 'text-text-strong' : 'text-text'}`}>{m.id}</div>
                        {m.name && m.name !== m.id && <div className="break-all text-meta text-muted">{m.name}</div>}
                      </div>
                      <div role="radiogroup" aria-label={`档位 ${full}`} className="flex shrink-0 overflow-hidden rounded-md border border-border">
                        {([null, ...TIERS] as const).map(t => {
                          const on = current === t
                          const tone = t ? TIER_TONE[t].on : 'bg-bg-hover text-text-strong'
                          return (
                            <button
                              key={t ?? 'none'}
                              role="radio"
                              aria-checked={on}
                              className={`border-l border-border px-2.5 py-1 text-meta transition first:border-l-0 focus-ring ${on ? `${tone} font-medium` : 'text-muted hover:bg-bg-hover hover:text-text'}`}
                              onClick={() => { if (!on) edit(assignModel(config, full, t)) }}
                            >
                              {t ? TIER_LABEL[t] : '不用'}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </Card>
    </div>
  )
}
