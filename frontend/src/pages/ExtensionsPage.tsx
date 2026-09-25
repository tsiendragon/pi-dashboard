import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ExtInventory, ExtensionEntry } from '@shared/ext-inventory'

/**
 * Extensions — read-only view of the set Pi will actually load.
 *
 * The old endpoint (`/api/pi/extensions`) only listed `<agent dir>/extensions/*.ts`, which is not
 * the loaded set. This page reads `GET /api/pi/ext/list` (settings.json + extensions.config.json +
 * package manifests) and groups entries by who provides them. Writing (enable/disable, reorder)
 * arrives with the P2 phase; config values are edited in Settings → General.
 */

const STATE_STYLES: Record<ExtensionEntry['state'], { dot: string; label: string }> = {
  enabled: { dot: 'bg-emerald-400', label: 'enabled' },
  forced: { dot: 'bg-sky-400', label: 'forced (!)' },
  disabled: { dot: 'bg-zinc-500', label: 'disabled (-)' },
}

function Badge({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'bad' | 'info'; title?: string }) {
  const tones = {
    muted: 'border-border text-muted',
    ok: 'border-emerald-500/40 text-emerald-300',
    warn: 'border-amber-500/40 text-amber-300',
    bad: 'border-red-500/40 text-red-300',
    info: 'border-sky-500/40 text-sky-300',
  } as const
  return (
    <span title={title} className={`rounded border px-1.5 py-0.5 text-2xs ${tones[tone]}`}>
      {children}
    </span>
  )
}

function SummaryCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-2xs text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold text-text-strong">{value}</div>
      {hint && <div className="mt-1 text-2xs text-muted">{hint}</div>}
    </div>
  )
}

function EntryRow({ entry, expanded, onToggle }: { entry: ExtensionEntry; expanded: boolean; onToggle: () => void }) {
  const state = STATE_STYLES[entry.state]
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-card/60">
        <span className={`h-2 w-2 shrink-0 rounded-full ${state.dot}`} title={state.label} />
        <span className="text-2xs text-muted">#{entry.appliedOrder}</span>
        <span className="text-sm text-text-strong">{entry.name ?? entry.raw}</span>
        {entry.packageId && <Badge tone="info">{entry.packageId}</Badge>}
        {!entry.packageId && <Badge>path</Badge>}
        {entry.version && <Badge>{entry.version}</Badge>}
        {entry.declared && <Badge tone="ok">declared</Badge>}
        {!entry.declared && entry.group === 'package' && <Badge tone="warn" title="包内文件但未在该包 manifest 的 pi.extensions 里声明">undeclared</Badge>}
        {entry.duplicate && <Badge tone="warn" title="同一路径在 settings.json 里出现多次">duplicate</Badge>}
        {!entry.exists && <Badge tone="bad" title="文件不存在，Pi 会跳过">missing</Badge>}
        {entry.patchedApi.length > 0 && (
          <Badge tone="warn" title={`推断（扫描源码得到，非声明依赖）：${entry.patchedApi.join(', ')}；需要补丁版 pi`}>
            需要补丁版 pi
          </Badge>
        )}
        <span className="ml-auto text-2xs text-muted">{expanded ? '收起' : '详情'}</span>
      </button>
      {expanded && (
        <div className="space-y-1 bg-card/40 px-4 py-3 text-2xs text-muted">
          <div className="font-mono break-all">settings.json: {entry.raw}</div>
          {entry.path && <div className="font-mono break-all">resolved: {entry.path}</div>}
          {entry.manifestPath && <div className="font-mono break-all">package entry: {entry.manifestPath}</div>}
          {entry.packageSource && <div className="font-mono break-all">package source: {entry.packageSource}</div>}
          <div>
            受管顺序：{entry.managedOrder === null ? '未在 extensions.config.json 的 loadOrder 中声明' : `#${entry.managedOrder}`}
            {entry.state === 'disabled' && ' ｜ 禁用只改前缀，不会卸载代码'}
          </div>
          {entry.description && <div>{entry.description}</div>}
          {entry.patchedApi.length > 0 && (
            <div>补丁 API（推断）：{entry.patchedApi.join('、')} —— 由源码文本扫描得到，不代表真实依赖关系</div>
          )}
        </div>
      )}
    </div>
  )
}

export default function ExtensionsPage() {
  const [data, setData] = useState<ExtInventory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/pi/ext/list')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setData((await response.json()) as ExtInventory)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = (key: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const groups = useMemo(() => {
    const entries = data?.extensions ?? []
    return {
      package: entries.filter(entry => entry.group === 'package'),
      path: entries.filter(entry => entry.group === 'path'),
    }
  }, [data])

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-text-strong">Extensions</h1>
        <span className="text-2xs text-muted">Pi 实际会加载的清单（来自 settings.json + extensions.config.json）</span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto rounded border border-border px-3 py-1 text-xs text-muted hover:text-text-strong disabled:opacity-50"
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-xs text-red-300">读取失败：{error}</div>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <SummaryCard label="Packages" value={data.counts.packages} />
            <SummaryCard label="已加载条目" value={data.counts.applied} />
            <SummaryCard label="启用 / 禁用" value={`${data.counts.enabled} / ${data.counts.disabled}`} />
            <SummaryCard label="来自 package" value={data.counts.packageEntries} />
            <SummaryCard label="直接路径" value={data.counts.pathEntries} />
            <SummaryCard label="未纳管文件" value={data.counts.auto} hint="agent dir 的 extensions/ 下自动发现" />
            <SummaryCard label="异常 / 需补丁" value={`${data.counts.broken} / ${data.counts.patched}`} hint="文件缺失 / 用到补丁 API" />
          </div>

          {data.drift.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
              <div className="font-semibold">与声明清单不一致（{data.drift.length}）</div>
              <ul className="mt-1 space-y-0.5 font-mono break-all">
                {data.drift.slice(0, 6).map(item => <li key={item}>{item}</li>)}
              </ul>
              {data.drift.length > 6 && <div className="mt-1">…另有 {data.drift.length - 6} 条</div>}
            </div>
          )}

          {data.warnings.length > 0 && (
            <div className="rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted">
              <div className="font-semibold text-text-strong">读取提示（{data.warnings.length}）</div>
              <ul className="mt-1 space-y-0.5 font-mono break-all">
                {data.warnings.slice(0, 6).map(item => <li key={item}>{item}</li>)}
              </ul>
            </div>
          )}

          <section className="overflow-hidden rounded-lg border border-border bg-card/40">
            <header className="flex items-center gap-2 border-b border-border px-3 py-2">
              <span className="text-sm font-medium text-text-strong">① 由 package 提供</span>
              <span className="text-2xs text-muted">{groups.package.length} 条 · 版本与描述来自各包 package.json</span>
            </header>
            {groups.package.length === 0
              ? <div className="px-4 py-3 text-xs text-muted">无</div>
              : groups.package.map(entry => (
                  <EntryRow key={`${entry.appliedOrder}-${entry.raw}`} entry={entry} expanded={expanded.has(entry.raw)} onToggle={() => toggle(entry.raw)} />
                ))}
          </section>

          <section className="overflow-hidden rounded-lg border border-border bg-card/40">
            <header className="flex items-center gap-2 border-b border-border px-3 py-2">
              <span className="text-sm font-medium text-text-strong">② 直接路径（单文件）</span>
              <span className="text-2xs text-muted">{groups.path.length} 条 · 无版本概念，不伪造版本号</span>
            </header>
            {groups.path.length === 0
              ? <div className="px-4 py-3 text-xs text-muted">无</div>
              : groups.path.map(entry => (
                  <EntryRow key={`${entry.appliedOrder}-${entry.raw}`} entry={entry} expanded={expanded.has(entry.raw)} onToggle={() => toggle(entry.raw)} />
                ))}
          </section>

          <section className="overflow-hidden rounded-lg border border-border bg-card/40">
            <header className="flex items-center gap-2 border-b border-border px-3 py-2">
              <span className="text-sm font-medium text-text-strong">③ 自动发现但未纳管</span>
              <span className="text-2xs text-muted">{data.auto.length} 条 · 严格模式同步会把这些移到 quarantine</span>
            </header>
            {data.auto.length === 0
              ? <div className="px-4 py-3 text-xs text-muted">无</div>
              : data.auto.map(item => (
                  <div key={item.path} className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted last:border-b-0">
                    <span className="h-2 w-2 rounded-full bg-zinc-500" />
                    <span className="text-text-strong">{item.name}</span>
                    <Badge tone="warn">未纳管</Badge>
                    <span className="ml-auto font-mono break-all">{item.path}</span>
                  </div>
                ))}
          </section>

          <div className="rounded-lg border border-border bg-card px-4 py-3 text-2xs text-muted">
            <div>agent dir：<span className="font-mono break-all">{data.agentDir}</span></div>
            <div>清单文件：<span className="font-mono break-all">{data.settingsPath}</span>{data.configExists ? '（存在）' : '（不存在）'}</div>
            <div className="mt-1">
              配置值在各扩展自己的 JSON 文件里，编辑入口在 <span className="text-text-strong">Settings → General</span> 的 Extension config 面板。
              启用 / 禁用与排序（写 `+`/`-` 前缀、重排 loadOrder）属于下一阶段。
            </div>
          </div>
        </>
      )}
    </div>
  )
}