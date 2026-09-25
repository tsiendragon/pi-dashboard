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

interface EntryActions {
  onEnable: () => void
  onDisable: () => void
  onMove: (direction: -1 | 1) => void
  canMoveUp: boolean
  canMoveDown: boolean
}

function EntryRow({
  entry,
  expanded,
  onToggle,
  actions,
  busy,
}: {
  entry: ExtensionEntry
  expanded: boolean
  onToggle: () => void
  actions?: EntryActions
  busy?: boolean
}) {
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
      {actions && (
        <div className="flex items-center gap-1 px-3 pb-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void (entry.state === 'disabled' ? actions.onEnable() : actions.onDisable())}
            className="rounded border border-border px-2 py-0.5 text-2xs text-muted hover:text-text-strong disabled:opacity-50"
          >
            {entry.state === 'disabled' ? '启用' : '禁用'}
          </button>
          {entry.state !== 'disabled' && (
            <>
              <button type="button" disabled={busy || !actions.canMoveUp} onClick={() => void actions.onMove(-1)}
                className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted hover:text-text-strong disabled:opacity-30">↑</button>
              <button type="button" disabled={busy || !actions.canMoveDown} onClick={() => void actions.onMove(1)}
                className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted hover:text-text-strong disabled:opacity-30">↓</button>
            </>
          )}
          {entry.state === 'disabled' && <span className="text-2xs text-muted">禁用只改前缀，代码仍会被别的扩展 import</span>}
        </div>
      )}
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
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<{ title: string; diff: string[]; note: string; run: () => Promise<void> } | null>(null)

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

  /** Managed (unprefixed) paths in applied order — the only entries reorder may touch. */
  const managedPaths = useMemo(
    () => (data?.extensions ?? []).filter(entry => entry.path && !/^[+\-!]/.test(entry.raw)).map(entry => entry.path as string),
    [data],
  )

  const post = useCallback(async (url: string, method: string, body: unknown) => {
    const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const payload = (await response.json()) as { error?: string; hint?: string; diff?: string[]; backupPath?: string | null; changed?: boolean }
    if (!response.ok) {
      const detail = payload.hint ? `${payload.error ?? `HTTP ${response.status}`} —— ${payload.hint}` : payload.error ?? `HTTP ${response.status}`
      throw new Error(detail)
    }
    return payload
  }, [])

  const requestToggle = (entry: ExtensionEntry) => {
    const enabling = entry.state === 'disabled'
    setPending({
      title: `${enabling ? '启用' : '禁用'} ${entry.name ?? entry.raw}`,
      diff: [`${enabling ? '~ 去掉 - 前缀' : '~ 加 - 前缀'}：${entry.raw}`],
      note: enabling
        ? '恢复为默认包含（原样回到未加前缀的写法）。'
        : '禁用只让 Pi 不加载这一条，不会卸载代码：别的扩展仍可能 import 它的模块。',
      run: async () => {
        const payload = await post('/api/pi/ext/toggle', 'POST', { path: entry.path, enabled: enabling })
        setNotice(`${enabling ? '已启用' : '已禁用'} ${entry.name ?? entry.raw}｜备份：${payload.backupPath ?? '（无变化，未写盘）'}`)
        await load()
      },
    })
  }

  const requestMove = (entry: ExtensionEntry, direction: -1 | 1) => {
    const path = entry.path as string
    const index = managedPaths.indexOf(path)
    const target = index + direction
    if (index < 0 || target < 0 || target >= managedPaths.length) return
    const reordered = [...managedPaths]
    reordered.splice(index, 1)
    reordered.splice(target, 0, path)
    setPending({
      title: `调整 ${entry.name ?? entry.raw} 的顺序`,
      diff: [`~ ${index + 1} → ${target + 1}（受管条目内）`],
      note: '顺序约束：tool-result-pipeline 必须紧跟 web-tools；trajectory-recorder 与 capability 通常在最后。',
      run: async () => {
        const payload = await post('/api/pi/ext/order', 'PUT', { paths: reordered })
        setNotice(`顺序已更新｜备份：${payload.backupPath ?? '（无变化，未写盘）'}`)
        await load()
      },
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
      {notice && <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200">{notice}</div>}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl">
            <div className="text-sm font-semibold text-text-strong">{pending.title}</div>
            <ul className="mt-2 space-y-0.5 font-mono text-2xs text-muted">
              {pending.diff.map(line => <li key={line} className="break-all">{line}</li>)}
            </ul>
            <div className="mt-2 text-2xs text-amber-300">{pending.note}</div>
            <div className="mt-2 text-2xs text-muted">写前会把 settings.json 备份到 agent 目录的 backups/，改动是原子写入；取消不会写盘。</div>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setPending(null)}
                className="rounded border border-border px-3 py-1 text-xs text-muted hover:text-text-strong disabled:opacity-50">取消</button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  setError(null)
                  try {
                    await pending.run()
                    setPending(null)
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause))
                  } finally {
                    setBusy(false)
                  }
                }}
                className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
              >
                {busy ? '写入中…' : '确认'}
              </button>
            </div>
          </div>
        </div>
      )}

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
                  <EntryRow
                    key={`${entry.appliedOrder}-${entry.raw}`}
                    entry={entry}
                    expanded={expanded.has(entry.raw)}
                    onToggle={() => toggle(entry.raw)}
                    busy={busy}
                    actions={{
                      onEnable: () => requestToggle(entry),
                      onDisable: () => requestToggle(entry),
                      onMove: direction => requestMove(entry, direction),
                      canMoveUp: entry.path !== null && managedPaths.indexOf(entry.path) > 0,
                      canMoveDown: entry.path !== null && managedPaths.indexOf(entry.path) < managedPaths.length - 1,
                    }}
                  />
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