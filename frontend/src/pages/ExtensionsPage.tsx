import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExtDependencies, ExtInventory, ExtensionEntry, ExtensionPackage } from '@shared/ext-inventory'
import { Badge, PageHeader, SearchInput, Skeleton } from '../components/ui'
import InfoTip from '../components/InfoTip'
import MaterialIcon from '../components/MaterialIcon'
import { SettingsSectionSlot } from '../plugins/slot-consumers'

interface GalleryPackage { name: string; description: string; version: string; author: string; date: string }
interface AuditRecord { id: string; ts: string; action: string; target: string; ok: boolean; backupPath: string | null; error?: string }

/**
 * Extensions — one page, four tabs.
 *
 * The page used to be a single long scroll mixing "what is loaded", "install something", "config
 * values" and "diagnostics". It now separates those concerns, because they answer different
 * questions:
 *   已安装    → 现在到底是什么在加载（含条目、自带资源、未纳管散文件）
 *   安装新扩展 → 装/更新/卸载，以及已安装的 packages 从哪来
 *   配置      → 各扩展自己的 JSON 配置（复用 Settings 里同一套面板实现）
 *   审计与诊断 → 操作记录/回滚 + 跨包引用静态扫描
 *
 * Data: `GET /api/pi/ext/list`, `GET /api/pi/ext/deps` (cached scan), `GET /api/pi/ext/audit`.
 * Writes: toggle / order / install / remove / update / rollback — all gated by the browser-auth
 * cookie; a 401 is surfaced with the server's hint instead of pretending success.
 */

type TabId = 'installed' | 'install' | 'config' | 'diagnostics'

const TABS: Array<{ id: TabId; label: string; hint: string }> = [
  { id: 'installed', label: '已安装', hint: 'Pi 当前会加载的条目、包自带的资源、未纳管的散文件' },
  { id: 'install', label: '安装新扩展', hint: '从 npm / 本地路径 / git 安装、更新、卸载' },
  { id: 'config', label: '配置', hint: '各扩展自己的 JSON 配置（与 Settings → General 里同一套面板）' },
  { id: 'diagnostics', label: '审计与诊断', hint: '操作记录与回滚、跨包引用、读取提示' },
]

const STATE_STYLE: Record<ExtensionEntry['state'], { dot: string; label: string; tone: 'ok' | 'warn' | 'aim' }> = {
  enabled: { dot: 'bg-emerald-400', label: '已启用', tone: 'ok' },
  forced: { dot: 'bg-sky-400', label: '强制加载', tone: 'aim' },
  disabled: { dot: 'bg-zinc-500', label: '已禁用', tone: 'warn' },
}

const AUDIT_LABEL: Record<string, string> = {
  toggle: '启停',
  order: '排序',
  install: '安装',
  remove: '卸载',
  update: '更新',
  rollback: '回滚',
}

const SOURCE_LABEL: Record<ExtensionPackage['sourceKind'], string> = {
  local: '本地路径',
  npm: 'npm',
  git: 'git',
}

/** Small neutral label (paths, versions, sources) — quieter than the shared status Badge. */
function Chip({ children, title, mono = false }: { children: React.ReactNode; title?: string; mono?: boolean }) {
  return (
    <span
      title={title}
      className={`shrink-0 rounded border border-border/80 bg-bg/40 px-1.5 py-0.5 text-[11px] leading-4 text-muted ${mono ? 'font-mono' : ''}`}
    >
      {children}
    </span>
  )
}

function TextButton({
  children,
  onClick,
  disabled,
  tone = 'muted',
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: 'muted' | 'ok' | 'danger'
  title?: string
}) {
  const toneCls =
    tone === 'ok'
      ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
      : tone === 'danger'
        ? 'border-red-500/40 text-red-300 hover:bg-red-500/10'
        : 'border-border text-muted hover:text-text-strong'
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded border px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${toneCls}`}
    >
      {children}
    </button>
  )
}

function StatCard({
  label,
  value,
  hint,
  active,
  onClick,
  tone = 'default',
}: {
  label: string
  value: string | number
  hint?: string
  active?: boolean
  onClick?: () => void
  tone?: 'default' | 'warn' | 'ok'
}) {
  const valueCls = tone === 'warn' ? 'text-amber-300' : tone === 'ok' ? 'text-emerald-300' : 'text-text-strong'
  const className = `rounded-lg border px-3 py-2.5 text-left transition-colors ${
    active ? 'border-accent bg-accent/10' : 'border-border bg-card hover:border-accent/50'
  }`
  const body = (
    <>
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold leading-6 ${valueCls}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] leading-4 text-muted">{hint}</div>}
    </>
  )
  return onClick ? (
    <button type="button" onClick={onClick} className={className} aria-pressed={active}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  )
}

function Section({
  id,
  title,
  count,
  hint,
  children,
  collapsed,
  onToggleCollapsed,
}: {
  id: string
  title: string
  count?: number | string
  hint?: string
  children: React.ReactNode
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  return (
    <section id={id} className="scroll-mt-24 overflow-hidden rounded-lg border border-border bg-card/40">
      <header className="flex items-center gap-2 border-b border-border bg-card/60 px-3 py-2">
        <span className="text-sm font-medium text-text-strong">{title}</span>
        {count !== undefined && <Chip mono>{count}</Chip>}
        {hint && <InfoTip text={hint} />}
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? '展开' : '收起'}
          aria-label={collapsed ? '展开' : '收起'}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted hover:text-text-strong"
        >
          <MaterialIcon name="expand_more" className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
        </button>
      </header>
      {!collapsed && children}
    </section>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="px-4 py-6 text-center text-xs text-muted">{text}</div>
}

interface EntryActions {
  onToggleEnabled: () => void
  onMove: (direction: -1 | 1) => void
  canMoveUp: boolean
  canMoveDown: boolean
}

function EntryRow({
  entry,
  expanded,
  onToggleExpanded,
  actions,
  busy,
  importedBy,
}: {
  entry: ExtensionEntry
  expanded: boolean
  onToggleExpanded: () => void
  actions?: EntryActions
  busy?: boolean
  importedBy?: string[]
}) {
  const state = STATE_STYLE[entry.state]
  const label = entry.name ?? entry.raw

  return (
    <div className={`border-b border-border/60 last:border-b-0 ${expanded ? 'bg-card/30' : 'hover:bg-card/50'}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${state.dot}`} title={state.label} />
        <span className="w-6 shrink-0 text-right font-mono text-[11px] text-muted">#{entry.appliedOrder}</span>

        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          title={expanded ? '收起详情' : '展开详情'}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <span className="truncate text-sm text-text-strong">{label}</span>
          {entry.packageId && !entry.packageId.startsWith('@') && entry.packageId !== label && (
            <Chip mono title="extensions.config.json 里的 id">{entry.packageId}</Chip>
          )}
          {entry.version && <Chip mono>{entry.version}</Chip>}
          {entry.declared && <Chip title="已在所属包的 manifest（pi.extensions）里声明">declared</Chip>}
          {!entry.declared && entry.group === 'package' && (
            <Chip title="包内文件，但未在该包 manifest 的 pi.extensions 里声明">undeclared</Chip>
          )}
          {entry.duplicate && <Chip title="同一路径在 settings.json 里出现多次">重复</Chip>}
          {!entry.exists && <Chip title="文件不存在，Pi 会跳过">缺失</Chip>}
          {importedBy && importedBy.length > 0 && (
            <Chip title={`静态扫描：${importedBy.join('、')} 会 import 这个包的代码 —— 禁用本条目不会卸载代码`}>
              被 {importedBy.length} 个条目 import
            </Chip>
          )}
          {entry.patchedApi.length > 0 && (
            <span title={`用到补丁版 pi 才有的 API（源码文本扫描推断）：${entry.patchedApi.join(', ')}`}>
              <Badge variant="warn">需补丁版 pi</Badge>
            </span>
          )}
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <span className="hidden sm:inline">
            <Badge variant={state.tone}>{state.label}</Badge>
          </span>
          {actions && (
            <>
              <TextButton
                tone={entry.state === 'disabled' ? 'ok' : 'danger'}
                disabled={busy}
                title={entry.state === 'disabled' ? '去掉前缀，让 Pi 重新加载' : '加 - 前缀禁用它（不删除文件）'}
                onClick={actions.onToggleEnabled}
              >
                {entry.state === 'disabled' ? '启用' : '禁用'}
              </TextButton>
              {entry.state !== 'disabled' && (
                <>
                  <TextButton title="在受管条目里上移一位" disabled={busy || !actions.canMoveUp} onClick={() => actions.onMove(-1)}>↑</TextButton>
                  <TextButton title="在受管条目里下移一位" disabled={busy || !actions.canMoveDown} onClick={() => actions.onMove(1)}>↓</TextButton>
                </>
              )}
            </>
          )}
          <TextButton title={expanded ? '收起详情' : '展开详情'} onClick={onToggleExpanded}>{expanded ? '收起' : '详情'}</TextButton>
        </div>
      </div>

      {expanded && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 bg-bg/30 px-4 py-3 text-[11px] text-muted">
          <dt className="text-muted/70">settings.json</dt>
          <dd className="break-all font-mono">{entry.raw}</dd>
          {entry.path && (
            <>
              <dt className="text-muted/70">解析为</dt>
              <dd className="break-all font-mono">{entry.path}</dd>
            </>
          )}
          {entry.manifestPath && (
            <>
              <dt className="text-muted/70">包内入口</dt>
              <dd className="break-all font-mono">{entry.manifestPath}</dd>
            </>
          )}
          {entry.packageSource && (
            <>
              <dt className="text-muted/70">包来源</dt>
              <dd className="break-all font-mono">{entry.packageSource}</dd>
            </>
          )}
          <dt className="text-muted/70">受管顺序</dt>
          <dd>
            {entry.managedOrder === null
              ? '未在 extensions.config.json 的 loadOrder 中声明（仅存在于 settings.json）'
              : `loadOrder #${entry.managedOrder}`}
          </dd>
          {entry.description && (
            <>
              <dt className="text-muted/70">说明</dt>
              <dd className="break-words">{entry.description}</dd>
            </>
          )}
          {entry.patchedApi.length > 0 && (
            <>
              <dt className="text-muted/70">补丁 API</dt>
              <dd>推断：{entry.patchedApi.join('、')}（源码文本扫描，不代表真实依赖）</dd>
            </>
          )}
        </dl>
      )}
    </div>
  )
}

export default function ExtensionsPage() {
  const [data, setData] = useState<ExtInventory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<{ title: string; diff: string[]; note: string; run: () => Promise<void> } | null>(null)
  const [gallery, setGallery] = useState<GalleryPackage[] | null>(null)
  const [galleryLoading, setGalleryLoading] = useState(false)
  const [audit, setAudit] = useState<AuditRecord[]>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [source, setSource] = useState('')
  const [deps, setDeps] = useState<ExtDependencies | null>(null)
  const [query, setQuery] = useState('')
  const [stateFilter, setStateFilter] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [issuesOnly, setIssuesOnly] = useState(false)
  const [tab, setTab] = useState<TabId>(() => {
    const hash = typeof window === 'undefined' ? '' : window.location.hash.replace('#', '')
    return (TABS.some(item => item.id === hash) ? hash : 'installed') as TabId
  })
  const noticeTimer = useRef<number | null>(null)

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

  const loadAudit = useCallback(async () => {
    setAuditLoading(true)
    try {
      const response = await fetch('/api/pi/ext/audit?limit=30')
      const payload = (await response.json()) as { records?: AuditRecord[] }
      setAudit(payload.records ?? [])
    } catch {
      setAudit([])
    } finally {
      setAuditLoading(false)
    }
  }, [])

  const searchGallery = useCallback(async () => {
    setGalleryLoading(true)
    try {
      const response = await fetch('/api/pi/gallery')
      const payload = (await response.json()) as { packages?: GalleryPackage[] }
      setGallery(payload.packages ?? [])
    } catch {
      setGallery([])
    } finally {
      setGalleryLoading(false)
    }
  }, [])

  const loadDeps = useCallback(async () => {
    try {
      const response = await fetch('/api/pi/ext/deps')
      if (response.ok) setDeps((await response.json()) as ExtDependencies)
    } catch {
      // the dependency scan is optional information; leave it empty on failure
    }
  }, [])

  useEffect(() => {
    void load()
    void loadAudit()
    void loadDeps()
  }, [load, loadAudit, loadDeps])

  // Keep the tab in the URL hash so a refresh (or a shared link) lands on the same view.
  useEffect(() => {
    if (typeof window !== 'undefined') window.history.replaceState(null, '', `#${tab}`)
  }, [tab])

  const flash = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 8000)
  }, [])

  const toggleExpanded = useCallback((key: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Only prefix-free entries are the managed set (pi's config-selector writes +/- on top of these).
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

  const sharedByPackage = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const item of deps?.sharedPackages ?? []) {
      if (item.packageId) map.set(item.packageId, item.importedBy)
    }
    return map
  }, [deps])

  const requestToggle = (entry: ExtensionEntry) => {
    const enabling = entry.state === 'disabled'
    const importers = entry.packageId ? sharedByPackage.get(entry.packageId) : undefined
    const warn = !enabling && importers && importers.length > 0
    setPending({
      title: `${enabling ? '启用' : '禁用'} ${entry.name ?? entry.raw}`,
      diff: [`${entry.raw}  →  ${enabling ? entry.raw.replace(/^-/, '+') : (entry.raw.startsWith('-') ? entry.raw : `-${entry.raw}`)}`],
      note: enabling
        ? '启用会写 + 前缀（只影响这一项在加载顺序里的位置）。'
        : `禁用只写 - 前缀，不会卸载代码。${warn ? `注意：${importers!.join('、')} 仍会 import 这个包的代码。` : ''}`,
      run: async () => {
        const payload = await post('/api/pi/ext/toggle', 'POST', { path: entry.path ?? entry.raw, enabled: enabling })
        flash(`${enabling ? '已启用' : '已禁用'} ${entry.name ?? entry.raw}｜备份：${payload.backupPath ?? '（无变化，未写盘）'}`)
        await Promise.all([load(), loadAudit()])
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
      diff: [`~ 受管顺序 ${index + 1} → ${target + 1}`],
      note: '顺序约束提醒：tool-result-pipeline 需紧跟 web-tools；trajectory-recorder / capability 通常在最后。',
      run: async () => {
        const payload = await post('/api/pi/ext/order', 'PUT', { paths: reordered })
        flash(`顺序已更新｜备份：${payload.backupPath ?? '（无变化，未写盘）'}`)
        await load()
      },
    })
  }

  const requestSource = (action: 'install' | 'remove' | 'update', pkgSource: string) => {
    const title = action === 'install' ? '安装' : action === 'remove' ? '卸载' : '更新'
    setPending({
      title: `${title} ${pkgSource}`,
      diff: [`${action === 'install' ? '+' : action === 'remove' ? '-' : '~'} 运行 pi ${action} ${pkgSource}`],
      note:
        action === 'install'
          ? '第三方代码会在你的机器上被安装并加载。安装前会自动备份 settings.json，失败也会留审计记录，可随时回滚。'
          : action === 'remove'
            ? '只从 settings.json 移除该 package；已下载的文件不会删除。'
            : '会重新拉取该 package 的最新内容（git 包等价于 git pull）。',
      run: async () => {
        const payload = await post(`/api/pi/ext/${action}`, 'POST', { source: pkgSource })
        flash(`${title}完成：${pkgSource}｜备份：${payload.backupPath ?? '（无）'}`)
        await Promise.all([load(), loadAudit()])
      },
    })
  }

  const requestRollback = (backupPath: string) => {
    setPending({
      title: '回滚到该备份',
      diff: [`~ 用 ${backupPath.split('/').pop()} 覆盖 settings.json`],
      note: '回滚本身也会先备份当前状态，所以可以再回滚回来。',
      run: async () => {
        const payload = await post('/api/pi/ext/rollback', 'POST', { backupPath })
        flash(`已回滚｜本次备份：${payload.backupPath ?? '（无）'}`)
        await Promise.all([load(), loadAudit()])
      },
    })
  }

  useEffect(() => {
    if (!pending) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPending(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending])

  const hasIssue = (entry: ExtensionEntry) =>
    !entry.exists || entry.duplicate || (!entry.declared && entry.group === 'package') || entry.patchedApi.length > 0

  const visible = useMemo(() => {
    const entries = data?.extensions ?? []
    const needle = query.trim().toLowerCase()
    return entries.filter(entry => {
      if (stateFilter === 'enabled' && entry.state === 'disabled') return false
      if (stateFilter === 'disabled' && entry.state !== 'disabled') return false
      if (issuesOnly && !hasIssue(entry)) return false
      if (!needle) return true
      return [entry.name, entry.raw, entry.path, entry.packageId].filter(Boolean).some(value => String(value).toLowerCase().includes(needle))
    })
  }, [data, query, stateFilter, issuesOnly])

  const groups = useMemo(() => ({
    package: visible.filter(entry => entry.group === 'package'),
    path: visible.filter(entry => entry.group === 'path'),
  }), [visible])

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })

  const jumpNav = [
    { id: 'sec-package', label: '由 package 提供', count: groups.package.length },
    { id: 'sec-path', label: '直接路径', count: groups.path.length },
    { id: 'sec-provided', label: '包自带', count: data?.provided.length ?? 0 },
    { id: 'sec-auto', label: '未纳管', count: data?.auto.length ?? 0 },
  ]

  const packageRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (data?.packages ?? []).filter(pkg => !needle || [pkg.name, pkg.rawSource, pkg.resolved].filter(Boolean).some(value => String(value).toLowerCase().includes(needle)))
  }, [data, query])

  return (
    <div className="mx-auto max-w-6xl pb-10">
      <PageHeader title="Extensions" subtitle="Pi 实际会加载的清单 —— 来自 settings.json + extensions.config.json + 各包 manifest" />

      <div className="flex flex-wrap items-center gap-2 px-3 md:px-6">
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-xs text-muted hover:text-text-strong disabled:opacity-50"
        >
          <MaterialIcon name="sync" className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          {loading ? '刷新中…' : '刷新'}
        </button>
        <InfoTip text="只读信息来自 settings.json / extensions.config.json / 各包 package.json；跨包引用是把源码 import 静态解析出来的（不代表运行时真实依赖）。写操作会先备份 settings.json 并记录审计。" />
        <span className="ml-auto text-[11px] text-muted">
          agent dir：<span className="font-mono">{data?.agentDir ?? '…'}</span>
        </span>
      </div>

      <div role="tablist" aria-label="Extensions 分区" className="mt-2 flex gap-1 border-b border-border px-3 md:px-6">
        {TABS.map(item => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            title={item.hint}
            onClick={() => setTab(item.id)}
            className={`-mb-px rounded-t border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === item.id
                ? 'border-accent text-text-strong'
                : 'border-transparent text-muted hover:text-text-strong'
            }`}
          >
            {item.label}
            {item.id === 'installed' && data && <span className="ml-1.5 font-mono text-[11px] text-muted">{data.extensions.length}</span>}
            {item.id === 'install' && data && <span className="ml-1.5 font-mono text-[11px] text-muted">{data.packages.length}</span>}
            {item.id === 'diagnostics' && <span className="ml-1.5 font-mono text-[11px] text-muted">{audit.length}</span>}
          </button>
        ))}
      </div>

      {error && (
        <div className="mx-3 mt-3 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300 md:mx-6">
          <MaterialIcon name="error" className="h-4 w-4" />
          <span className="min-w-0 flex-1 break-all">{error}</span>
          <TextButton onClick={() => void load()}>重试</TextButton>
        </div>
      )}
      {notice && (
        <div className="mx-3 mt-3 flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 md:mx-6">
          <span className="min-w-0 flex-1 break-all">{notice}</span>
          <TextButton onClick={() => { setTab('diagnostics'); setNotice(null) }}>看审计</TextButton>
          <TextButton title="关闭提示" onClick={() => setNotice(null)}>✕</TextButton>
        </div>
      )}

      {!data && loading && (
        <div className="mt-3 space-y-2 px-3 md:px-6">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {data && tab === 'installed' && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2 px-3 md:grid-cols-3 md:px-6 lg:grid-cols-6">
            <StatCard label="已加载条目" value={data.counts.applied} hint="settings.json 的 extensions" />
            <StatCard
              label="启用 / 禁用"
              value={`${data.counts.enabled} / ${data.counts.disabled}`}
              hint={data.counts.disabled > 0 ? '点按只看禁用' : '全部启用'}
              active={stateFilter === 'disabled'}
              onClick={() => setStateFilter(previous => (previous === 'disabled' ? 'all' : 'disabled'))}
            />
            <StatCard label="Packages" value={data.counts.packages} hint="settings.json 的 packages" />
            <StatCard label="由包自带" value={data.counts.provided} hint="autoload，未列在 extensions" />
            <StatCard
              label="异常 / 需补丁"
              value={`${data.counts.broken} / ${data.counts.patched}`}
              tone="warn"
              hint={issuesOnly ? '已筛选，点按取消' : '缺失 / 重复 / 未声明 / 需补丁'}
              active={issuesOnly}
              onClick={() => setIssuesOnly(previous => !previous)}
            />
            <StatCard
              label="跨包引用"
              value={deps ? deps.crossImports.length : '…'}
              hint={deps ? `静态扫描 ${deps.scannedFiles} 个文件${deps.truncated ? '（已截断）' : ''}` : '扫描中…'}
              onClick={() => setTab('diagnostics')}
            />
          </div>

          <nav className="sticky top-0 z-20 flex gap-1.5 overflow-x-auto border-y border-border bg-bg/85 px-3 py-2 backdrop-blur md:px-6">
            {jumpNav.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => jump(item.id)}
                className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted hover:border-accent/60 hover:text-text-strong"
              >
                {item.label}
                <span className="font-mono text-muted/70">{item.count}</span>
              </button>
            ))}
          </nav>

          <div className="flex flex-wrap items-center gap-2 px-3 md:px-6">
            <div className="min-w-[12rem] flex-1">
              <SearchInput
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="按名称 / 路径 / id 过滤…"
                aria-label="过滤扩展条目"
              />
            </div>
            <div className="flex overflow-hidden rounded border border-border">
              {([['all', '全部'], ['enabled', '启用'], ['disabled', '禁用']] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setStateFilter(key)}
                  aria-label={`筛选状态：${label}`}
                  aria-pressed={stateFilter === key}
                  className={`px-2.5 py-1 text-[11px] ${stateFilter === key ? 'bg-accent/15 text-text-strong' : 'text-muted hover:text-text-strong'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="flex select-none items-center gap-1.5 text-[11px] text-muted">
              <input type="checkbox" checked={issuesOnly} onChange={event => setIssuesOnly(event.target.checked)} />
              只看异常
            </label>
            <span className="text-[11px] text-muted">
              {visible.length} / {data.extensions.length} 条
            </span>
            <TextButton onClick={() => setCollapsed(new Set())} disabled={collapsed.size === 0}>全部展开</TextButton>
            <TextButton onClick={() => setCollapsed(new Set(['sec-package', 'sec-path', 'sec-provided', 'sec-auto']))} disabled={collapsed.size > 0}>
              全部收起
            </TextButton>
          </div>

          <div className="space-y-3 px-3 md:px-6">
            <Section
              id="sec-package"
              title="① 由 package 提供"
              count={groups.package.length}
              hint="这些条目的路径落在某个 package 目录内；版本与描述来自该包的 package.json。declared = 已在该包 manifest 的 pi.extensions 里声明。"
              collapsed={collapsed.has('sec-package')}
              onToggleCollapsed={() => toggleCollapsed('sec-package')}
            >
              {groups.package.length === 0
                ? <Empty text={query || issuesOnly ? '没有匹配的条目' : '无'} />
                : groups.package.map(entry => (
                  <EntryRow
                    key={`${entry.appliedOrder}-${entry.raw}`}
                    entry={entry}
                    expanded={expanded.has(entry.raw)}
                    onToggleExpanded={() => toggleExpanded(entry.raw)}
                    busy={busy}
                    importedBy={entry.packageId ? sharedByPackage.get(entry.packageId) : undefined}
                    actions={{
                      onToggleEnabled: () => requestToggle(entry),
                      onMove: direction => requestMove(entry, direction),
                      canMoveUp: entry.path !== null && managedPaths.indexOf(entry.path) > 0,
                      canMoveDown: entry.path !== null && managedPaths.indexOf(entry.path) < managedPaths.length - 1,
                    }}
                  />
                ))}
            </Section>

            <Section
              id="sec-path"
              title="② 直接路径（单文件）"
              count={groups.path.length}
              hint="settings.json 里直接写的单文件条目，不属于任何 package；不显示版本号（避免伪造）。"
              collapsed={collapsed.has('sec-path')}
              onToggleCollapsed={() => toggleCollapsed('sec-path')}
            >
              {groups.path.length === 0
                ? <Empty text="无" />
                : groups.path.map(entry => (
                  <EntryRow
                    key={`path-${entry.appliedOrder}-${entry.raw}`}
                    entry={entry}
                    expanded={expanded.has(entry.raw)}
                    onToggleExpanded={() => toggleExpanded(entry.raw)}
                    busy={busy}
                    actions={{
                      onToggleEnabled: () => requestToggle(entry),
                      onMove: direction => requestMove(entry, direction),
                      canMoveUp: entry.path !== null && managedPaths.indexOf(entry.path) > 0,
                      canMoveDown: entry.path !== null && managedPaths.indexOf(entry.path) < managedPaths.length - 1,
                    }}
                  />
                ))}
            </Section>

            <Section
              id="sec-provided"
              title="③ 由 package 自带（autoload）"
              count={data.provided.length}
              hint="来自 packages 清单里 string 形态（= 加载该包全部资源）或 filters 命中的资源，它们没有单独的 settings.extensions 条目。glob 按 pi 的规则展开。"
              collapsed={collapsed.has('sec-provided')}
              onToggleCollapsed={() => toggleCollapsed('sec-provided')}
            >
              {data.provided.length === 0
                ? <Empty text="无（所有包都走 settings.extensions 的显式条目）" />
                : (
                  <div className="divide-y divide-border/60">
                    {data.provided.map(item => (
                      <div key={item.path} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${item.exists ? 'bg-emerald-400' : 'bg-red-400'}`} />
                        <span className="text-text-strong">{item.packageName ?? item.packageId ?? '(package)'}</span>
                        <Chip mono>{item.manifestPath}</Chip>
                        <Chip title={`来源：${item.kind === 'manifest' ? '包 manifest pi.extensions' : 'settings 里的 filters'}，模式 ${item.pattern}`}>{item.kind}</Chip>
                        <span className="ml-auto truncate font-mono text-[11px] text-muted">{item.path}</span>
                      </div>
                    ))}
                  </div>
                )}
            </Section>

            <Section
              id="sec-auto"
              title="④ 自动发现但未纳管"
              count={data.auto.length}
              hint="agent 目录 extensions/ 下的散文件：严格模式同步时会被移入 extension-quarantine/，不会留在加载清单里。"
              collapsed={collapsed.has('sec-auto')}
              onToggleCollapsed={() => toggleCollapsed('sec-auto')}
            >
              {data.auto.length === 0
                ? <Empty text="无（没有未纳管的散文件）" />
                : data.auto.map(item => (
                  <div key={item.path} className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-b-0">
                    <span className="text-text-strong">{item.name}</span>
                    <Chip title="未在 settings.json / extensions.config.json 中声明">未纳管</Chip>
                    <span className="ml-auto truncate font-mono text-[11px] text-muted">{item.path}</span>
                  </div>
                ))}
            </Section>
          </div>
        </div>
      )}

      {data && tab === 'install' && (
        <div className="mt-3 space-y-3 px-3 md:px-6">
          <section className="rounded-lg border border-border bg-card/40 px-3 py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text-strong">安装 / 更新 / 卸载</span>
              <InfoTip text="来源支持：npm registry 的包名（自动补 npm: 前缀）、本地目录（/path 或 ./path）、git 仓库（git:host/owner/repo）。安装会执行 pi install 并写入 settings.json，装前自动备份。" />
            </div>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                value={source}
                onChange={event => setSource(event.target.value)}
                placeholder="pi-tsien-web-tools  或  /path/to/pkg  或  git:github.com/user/repo"
                aria-label="要安装的来源"
                className="min-w-0 flex-1 rounded border border-border bg-bg/40 px-2.5 py-1.5 font-mono text-xs text-text-strong placeholder:text-muted/60"
              />
              <div className="flex gap-2">
                <TextButton tone="ok" disabled={!source.trim() || busy} onClick={() => requestSource('install', source.trim())}>安装</TextButton>
                <TextButton disabled={!source.trim() || busy} onClick={() => requestSource('update', source.trim())}>更新</TextButton>
                <TextButton tone="danger" disabled={!source.trim() || busy} onClick={() => requestSource('remove', source.trim())}>卸载</TextButton>
              </div>
            </div>
            {source.trim() && (
              <div className="mt-2 font-mono text-[11px] text-muted">
                将执行：pi install
                {/^(npm:|git:|\/|\.)/.test(source.trim()) ? ` ${source.trim()}` : ` npm:${source.trim()}`}
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
              快速填入：
              <TextButton onClick={() => setSource('npm:pi-tsien-web-tools')}>npm 单个包</TextButton>
              <TextButton onClick={() => setSource('git:github.com/tsiendragon/pi-tsien-extension')}>GitHub 装齐 25 个</TextButton>
              <TextButton onClick={() => void searchGallery()}>{galleryLoading ? '搜索中…' : '搜索 npm 上的 pi 包'}</TextButton>
            </div>
            {gallery && (
              gallery.length === 0
                ? <Empty text="没有搜到 pi 包" />
                : (
                  <ul className="mt-2 divide-y divide-border/60 overflow-hidden rounded border border-border">
                    {gallery.slice(0, 20).map(item => (
                      <li key={`${item.name}@${item.version}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <span className="font-mono text-xs text-text-strong">{item.name}</span>
                        <Chip mono>{item.version}</Chip>
                        {item.author && <Chip>{item.author}</Chip>}
                        <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={item.description}>{item.description}</span>
                        <TextButton onClick={() => setSource(`npm:${item.name}`)}>填入</TextButton>
                        <TextButton tone="ok" disabled={busy} onClick={() => requestSource('install', `npm:${item.name}`)}>安装</TextButton>
                      </li>
                    ))}
                  </ul>
                )
            )}
          </section>

          <section className="overflow-hidden rounded-lg border border-border bg-card/40">
            <header className="flex items-center gap-2 border-b border-border bg-card/60 px-3 py-2">
              <span className="text-sm font-medium text-text-strong">已安装的 packages</span>
              <Chip mono>{packageRows.length}</Chip>
              <InfoTip text="settings.json 的 packages 段：每个包可以带来源类型、形态（string = 加载全部资源 / object = 过滤）、声明的入口数。卸载只改 settings.json，不删文件。" />
            </header>
            {packageRows.length === 0
              ? <Empty text="没有匹配的 package" />
              : (
                <div className="divide-y divide-border/60">
                  {packageRows.map(pkg => (
                    <div key={pkg.rawSource} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${pkg.exists ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                      <span className="text-text-strong">{pkg.name ?? pkg.rawSource}</span>
                      {pkg.version && <Chip mono>{pkg.version}</Chip>}
                      <Chip title="来源类型（解析自 settings.json 的写法）">{SOURCE_LABEL[pkg.sourceKind]}</Chip>
                      <Chip title="string = 加载该包全部资源；object = 按 filters 过滤">{pkg.form}</Chip>
                      <Chip mono title="包 manifest 里声明的入口数">{pkg.declaredEntries.length} entries</Chip>
                      {!pkg.exists && <Chip title="未在磁盘上解析到（未安装 / 变量未解析）">未解析到</Chip>}
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={pkg.resolved ?? pkg.rawSource}>{pkg.resolved ?? pkg.rawSource}</span>
                      <TextButton disabled={busy} onClick={() => requestSource('update', pkg.rawSource)}>更新</TextButton>
                      <TextButton tone="danger" disabled={busy} onClick={() => requestSource('remove', pkg.rawSource)}>卸载</TextButton>
                    </div>
                  ))}
                </div>
              )}
          </section>
        </div>
      )}

      {tab === 'config' && (
        <div className="mt-3 space-y-3 px-3 md:px-6">
          <section className="rounded-lg border border-border bg-card/40 px-3 py-2 text-[11px] text-muted">
            各扩展读取自己的 JSON 配置文件（如 <span className="font-mono">bash-digest.json</span>）。
            面板由 <span className="font-mono">pi-extension-config</span> 插件声明并渲染到这里（同一个插件槽位机制）。
            扩展在加载时读取配置，所以改动要 <span className="font-mono">/reload</span> 或重开会话才生效；保存需要浏览器认证。
          </section>
          <SettingsSectionSlot tab="extensions" />
        </div>
      )}

      {data && tab === 'diagnostics' && (
        <div className="mt-3 space-y-3 px-3 md:px-6">
          {data.drift.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              <div className="font-semibold">与声明清单不一致（{data.drift.length}）—— 同步器会修正</div>
              <ul className="mt-1 space-y-0.5 font-mono break-all">
                {data.drift.slice(0, 6).map(item => <li key={item}>{item}</li>)}
              </ul>
              {data.drift.length > 6 && <div className="mt-1">…另有 {data.drift.length - 6} 条</div>}
            </div>
          )}

          {data.warnings.length > 0 && (
            <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted">
              <div className="font-semibold text-text-strong">读取提示（{data.warnings.length}）</div>
              <ul className="mt-1 space-y-0.5 font-mono break-all">
                {data.warnings.slice(0, 6).map(item => <li key={item}>{item}</li>)}
              </ul>
              {data.warnings.length > 6 && <div className="mt-1">…另有 {data.warnings.length - 6} 条</div>}
            </div>
          )}

          <Section
            id="sec-shared"
            title="跨包引用（静态扫描）"
            count={deps?.sharedPackages.length ?? 0}
            hint="哪些包的代码被别的条目 import —— 说明「禁用 ≠ 卸载代码」。只统计显式 import，扫描有上限（每包 80 文件、单文件 256KB），动态 import 看不到。"
            collapsed={collapsed.has('sec-shared')}
            onToggleCollapsed={() => toggleCollapsed('sec-shared')}
          >
            {!deps
              ? <div className="space-y-2 px-3 py-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
              : (
                <div className="space-y-2 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                    <Chip mono>{deps.crossImports.length} 条引用</Chip>
                    <Chip mono>{deps.scannedFiles} 个文件</Chip>
                    <Chip mono>缓存 {deps.cached ? '命中' : '未命中'}</Chip>
                    {deps.truncated && <Chip title="有包超过文件数上限，未计入">已截断</Chip>}
                  </div>
                  {deps.sharedPackages.length === 0
                    ? <Empty text="没有跨包引用" />
                    : deps.sharedPackages.map(item => (
                      <div key={item.packageId ?? item.packageName ?? 'unknown'} className="rounded border border-border bg-bg/30 px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs text-text-strong">{item.packageName ?? item.packageId}</span>
                          <Chip mono>{item.files} 个文件</Chip>
                          <span className="text-[11px] text-muted">被 {item.importedBy.length} 个条目 import</span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {item.importedBy.slice(0, 6).map(name => <Chip key={name}>{name.replace('pi-tsien-', '')}</Chip>)}
                          {item.importedBy.length > 6 && <Chip title={item.importedBy.slice(6).join('、')}>+{item.importedBy.length - 6}</Chip>}
                        </div>
                      </div>
                    ))}
                  {deps.externalPackages.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                      外部依赖（npm 包，不算共享代码）：
                      {deps.externalPackages.map(name => <Chip key={name} mono>{name}</Chip>)}
                    </div>
                  )}
                </div>
              )}
          </Section>

          <Section
            id="sec-audit"
            title="操作审计"
            count={audit.length}
            hint="记录文件：agent 目录下的 extension-audit.jsonl。启停/排序/安装/卸载/回滚都会写一条，含备份路径，可一键回滚。"
            collapsed={collapsed.has('sec-audit')}
            onToggleCollapsed={() => toggleCollapsed('sec-audit')}
          >
            <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
              <TextButton onClick={() => void loadAudit()} disabled={auditLoading}>{auditLoading ? '读取中…' : '刷新'}</TextButton>
              <span className="text-[11px] text-muted">最近 30 条（按时间倒序）</span>
            </div>
            {audit.length === 0
              ? <Empty text="暂无记录 —— 做一次启停/排序/安装后就会出现" />
              : (
                <div className="max-h-80 overflow-auto">
                  <table className="w-full text-left text-[11px]">
                    <thead className="sticky top-0 bg-card/95 text-muted">
                      <tr>
                        <th className="px-3 py-1.5 font-normal">时间</th>
                        <th className="px-3 py-1.5 font-normal">操作</th>
                        <th className="px-3 py-1.5 font-normal">目标</th>
                        <th className="px-3 py-1.5 font-normal">结果</th>
                        <th className="px-3 py-1.5 font-normal">备份 / 操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audit.map(record => (
                        <tr key={record.id} className="border-t border-border/50">
                          <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted">{record.ts.replace('T', ' ').slice(0, 19)}</td>
                          <td className="px-3 py-1.5">{AUDIT_LABEL[record.action] ?? record.action}</td>
                          <td className="max-w-[18rem] truncate px-3 py-1.5 font-mono" title={record.target}>{record.target}</td>
                          <td className="px-3 py-1.5">
                            {record.ok ? <span className="text-emerald-300">成功</span> : <span className="text-red-300" title={record.error}>失败</span>}
                          </td>
                          <td className="px-3 py-1.5">
                            {record.backupPath
                              ? (
                                <div className="flex items-center gap-2">
                                  <span className="truncate font-mono text-muted" title={record.backupPath}>{record.backupPath.split('/').pop()}</span>
                                  <TextButton disabled={busy} onClick={() => requestRollback(record.backupPath as string)}>回滚</TextButton>
                                </div>
                              )
                              : <span className="text-muted">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Section>

          <div className="rounded-lg border border-border bg-card/40 px-3 py-2 text-[11px] text-muted">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>agent dir：<span className="font-mono">{data.agentDir}</span></span>
              <span>清单文件：<span className="font-mono">{data.settingsPath}</span> {data.configExists ? '（存在）' : '（不存在）'}</span>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg rounded-lg border border-border bg-card p-4 shadow-xl">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text-strong">{pending.title}</span>
              <TextButton title="取消（Esc）" onClick={() => setPending(null)}>✕</TextButton>
            </div>
            <ul className="mt-2 space-y-1 rounded border border-border bg-bg/40 px-3 py-2 font-mono text-[11px] text-muted">
              {pending.diff.map(line => <li key={line} className="break-all">{line}</li>)}
            </ul>
            <div className="mt-2 text-[11px] text-amber-300">{pending.note}</div>
            <div className="mt-1 text-[11px] text-muted">写前会把 settings.json 备份到 agent 目录的 backups/，改动是原子写入；取消不会写盘。</div>
            <div className="mt-3 flex justify-end gap-2">
              <TextButton disabled={busy} onClick={() => setPending(null)}>取消（Esc）</TextButton>
              <TextButton
                tone="ok"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  setError(null)
                  try {
                    await pending.run()
                    setPending(null)
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause))
                    setPending(null)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {busy ? '写入中…' : '确认写入'}
              </TextButton>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}