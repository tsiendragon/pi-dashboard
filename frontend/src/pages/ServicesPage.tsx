/**
 * Services page — one row per registered service: is its API answering, where is its page, and
 * (only for local, managed entries) the start/stop/restart buttons.
 *
 * Every action is `POST /api/services/:id/<action>`: the command itself lives in
 * `~/.pi/services.json`, never in this page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader, StatCard } from '../components/ui'

interface ServiceStatus {
  id: string
  status: 'up' | 'down' | 'unknown'
  httpStatus?: number
  latencyMs?: number
  error?: string
  checkedAt: string
}

interface ServiceRow {
  id: string
  label: string
  group?: string
  managed?: boolean
  note?: string
  cwd?: string
  stopPort?: number
  probe?: { url: string; okStatus?: number[]; timeoutMs?: number }
  webui?: string
  webuiPublic?: string
  logPath?: string
  canStart: boolean
  canStop: boolean
  status: ServiceStatus
}

interface ServicesPayload {
  services: ServiceRow[]
  configPath: string
  seeded: boolean
  error?: string
}

type Action = 'start' | 'stop' | 'restart'

const POLL_MS = 4000

const ACTION_LABEL: Record<Action, string> = { start: '启动', stop: '停止', restart: '重启' }

function dotClass(status: ServiceStatus['status']): string {
  if (status === 'up') return 'bg-ok'
  if (status === 'down') return 'bg-danger'
  return 'bg-muted'
}

function statusLabel(status: ServiceStatus['status']): string {
  if (status === 'up') return '在线'
  if (status === 'down') return '离线'
  return '不可探测'
}

function statusTextClass(status: ServiceStatus['status']): string {
  if (status === 'up') return 'text-ok'
  if (status === 'down') return 'text-danger'
  return 'text-muted'
}

function portOf(row: ServiceRow): number | undefined {
  if (row.stopPort) return row.stopPort
  if (!row.probe?.url) return undefined
  try {
    const url = new URL(row.probe.url)
    if (url.port) return Number(url.port)
    return url.protocol === 'https:' ? 443 : 80
  } catch {
    return undefined
  }
}

function clockOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Build the URL the *browser* can open.
 *
 * A registered `127.0.0.1:port` only works on the machine running the dashboard. When this page
 * is itself served through the platform gateway (`<instance>-proxy-7777.<gateway-host>`), swapping
 * the port yields the sibling gateway URL for free — no per-service config needed.
 */
function browserUrl(row: ServiceRow, port: number | undefined): { href?: string; viaGateway: boolean } {
  if (row.webuiPublic) return { href: row.webuiPublic, viaGateway: true }
  if (!row.webui) return { viaGateway: false }
  if (!port) return { href: row.webui, viaGateway: false }
  const match = /^(.*)-proxy-\d+\.(.+)$/.exec(window.location.hostname)
  if (!match) return { href: row.webui, viaGateway: false }
  let pathname = '/'
  try {
    const parsed = new URL(row.webui)
    pathname = parsed.pathname + parsed.search
  } catch {
    /* keep '/' */
  }
  const [, instance, gatewayHost] = match
  return { href: `${window.location.protocol}//${instance}-proxy-${port}.${gatewayHost}${pathname}`, viaGateway: true }
}

function buttonClass(tone: 'plain' | 'danger' = 'plain'): string {
  const base = 'px-2 py-1 rounded border text-2xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
  return tone === 'danger'
    ? `${base} border-border text-muted hover:text-danger hover:border-danger bg-transparent`
    : `${base} border-border text-text bg-bg hover:bg-bg-hover`
}

export default function ServicesPage() {
  const [data, setData] = useState<ServicesPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [logView, setLogView] = useState<{ id: string; label: string; lines: string[]; truncated: boolean; logPath: string; error?: string } | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/services')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as ServicesPayload
      if (!alive.current) return
      setData(payload)
      setError(payload.error ?? null)
    } catch (err) {
      if (!alive.current) return
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    const timer = setInterval(() => {
      if (document.hidden) return
      void refresh()
    }, POLL_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [refresh])

  const runAction = useCallback(async (row: ServiceRow, action: Action) => {
    const key = `${row.id}:${action}`
    setBusy(key)
    setNotice(null)
    try {
      const response = await fetch(`/api/services/${encodeURIComponent(row.id)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; status?: ServiceStatus }
      if (response.status === 401) {
        setNotice({ tone: 'err', text: '需要先在 Live Pi 页面粘贴一次访问令牌完成认证，浏览器拿到 cookie 后这里才能操作。' })
        return
      }
      if (response.status === 403) {
        setNotice({ tone: 'err', text: '当前页面来源不被允许执行该操作。' })
        return
      }
      if (!response.ok || body.ok === false) {
        setNotice({ tone: 'err', text: `${row.label}：${body.error || `操作失败（HTTP ${response.status}）`}` })
      } else {
        setNotice({ tone: 'ok', text: `${row.label}：已${ACTION_LABEL[action]}` })
      }
      if (body.status) {
        setData(prev =>
          prev
            ? { ...prev, services: prev.services.map(item => (item.id === row.id ? { ...item, status: body.status as ServiceStatus } : item)) }
            : prev,
        )
      }
    } catch (err) {
      setNotice({ tone: 'err', text: `${row.label}：${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setBusy(null)
      void refresh()
    }
  }, [refresh])

  const openLogs = useCallback(async (row: ServiceRow) => {
    try {
      const response = await fetch(`/api/services/${encodeURIComponent(row.id)}/logs?lines=200`)
      const body = (await response.json()) as { lines?: string[]; truncated?: boolean; logPath?: string; error?: string }
      setLogView({
        id: row.id,
        label: row.label,
        lines: body.lines ?? [],
        truncated: Boolean(body.truncated),
        logPath: body.logPath ?? row.logPath ?? '',
        ...(body.error ? { error: body.error } : {}),
      })
    } catch (err) {
      setLogView({
        id: row.id,
        label: row.label,
        lines: [],
        truncated: false,
        logPath: row.logPath ?? '',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [])

  const grouped = useMemo(() => {
    const map = new Map<string, ServiceRow[]>()
    for (const row of data?.services ?? []) {
      const key = row.group || '未分组'
      const bucket = map.get(key)
      if (bucket) bucket.push(row)
      else map.set(key, [row])
    }
    return [...map.entries()]
  }, [data])

  const counts = useMemo(() => {
    const rows = data?.services ?? []
    return {
      total: rows.length,
      up: rows.filter(row => row.status.status === 'up').length,
      down: rows.filter(row => row.status.status === 'down').length,
      unknown: rows.filter(row => row.status.status === 'unknown').length,
    }
  }, [data])

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <PageHeader title="服务" subtitle="看每个服务的接口是否在应答；能启停的直接点，只在远端的只给链接。" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        <StatCard label="已登记" value={counts.total} />
        <StatCard label="在线" value={counts.up} colorClass="text-ok" />
        <StatCard label="离线" value={counts.down} colorClass="text-danger" />
        <StatCard label="不可探测" value={counts.unknown} colorClass="text-muted" />
      </div>

      {error && (
        <div className="mb-3 rounded border border-danger bg-danger-subtle px-3 py-2 text-body-s text-danger">
          服务清单读取失败：{error}
          {data && <span className="text-muted">（文件：<code className="font-mono">{data.configPath}</code>）</span>}
        </div>
      )}

      {data?.seeded && (
        <div className="mb-3 rounded border border-border bg-bg-elevated px-3 py-2 text-body-s text-muted">
          已写入默认清单：<code className="font-mono">{data.configPath}</code>，改这个文件就能增删服务（改动即时生效，刷新生效）。
        </div>
      )}

      {notice && (
        <div
          className={`mb-3 rounded px-3 py-2 text-body-s border ${
            notice.tone === 'ok' ? 'border-ok bg-ok-subtle text-ok' : 'border-danger bg-danger-subtle text-danger'
          }`}
        >
          {notice.text}
        </div>
      )}

      {!data && !error && <div className="text-body-s text-muted">加载中…</div>}

      {grouped.map(([group, rows]) => (
        <section key={group} className="mb-5">
          <h2 className="text-body-s font-medium text-muted mb-2">{group}</h2>
          <div className="grid gap-2 md:grid-cols-2">
            {rows.map(row => {
              const port = portOf(row)
              const link = browserUrl(row, port)
              const href = link.href
              return (
                <div key={row.id} className="rounded-lg border border-border bg-bg-elevated p-3 flex flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass(row.status.status)}`} />
                        <span className="text-sm font-medium text-text truncate">{row.label}</span>
                      </div>
                      <div className="text-2xs text-muted font-mono truncate mt-0.5">{row.id}</div>
                    </div>
                    <span className={`text-2xs font-medium shrink-0 ${statusTextClass(row.status.status)}`}>{statusLabel(row.status.status)}</span>
                  </div>

                  {row.note && <p className="text-2xs text-muted mt-2 leading-relaxed">{row.note}</p>}

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted font-mono mt-2">
                    {port && <span>:{port}</span>}
                    {row.status.httpStatus !== undefined && <span>HTTP {row.status.httpStatus}</span>}
                    {row.status.latencyMs !== undefined && <span>{row.status.latencyMs}ms</span>}
                    <span>检查于 {clockOf(row.status.checkedAt)}</span>
                  </div>
                  {row.status.error && row.status.status === 'down' && (
                    <p className="text-2xs text-danger mt-1 break-words">{row.status.error}</p>
                  )}

                  <div className="flex flex-wrap items-center gap-1.5 mt-3">
                    {href && (
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        title={link.viaGateway ? href : `只有本机能打开：${href}（经平台网关访问时无法换算，请手动开隧道）`}
                        className="px-2 py-1 rounded border border-accent text-2xs font-medium text-accent bg-transparent hover:bg-accent-subtle"
                      >
                        打开页面
                      </a>
                    )}
                    {row.canStart && (
                      <button className={buttonClass()} disabled={busy !== null} onClick={() => void runAction(row, 'start')}>
                        {busy === `${row.id}:start` ? '启动中…' : '启动'}
                      </button>
                    )}
                    {row.canStop && (
                      <button className={buttonClass('danger')} disabled={busy !== null} onClick={() => void runAction(row, 'stop')}>
                        {busy === `${row.id}:stop` ? '停止中…' : '停止'}
                      </button>
                    )}
                    {row.canStart && row.canStop && (
                      <button className={buttonClass()} disabled={busy !== null} onClick={() => void runAction(row, 'restart')}>
                        {busy === `${row.id}:restart` ? '重启中…' : '重启'}
                      </button>
                    )}
                    <button className={buttonClass()} onClick={() => void openLogs(row)}>
                      日志
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}

      {data && data.services.length === 0 && !error && (
        <div className="text-body-s text-muted">清单是空的。编辑 <code className="font-mono">{data.configPath}</code> 加一条服务。</div>
      )}

      {logView && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setLogView(null)}>
          <div
            className="w-full max-w-3xl max-h-[80vh] flex flex-col rounded-lg border border-border bg-bg shadow-xl"
            onClick={event => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border">
              <div className="min-w-0">
                <div className="text-sm font-medium text-text truncate">{logView.label} · 日志</div>
                <div className="text-2xs text-muted font-mono truncate">{logView.logPath}</div>
              </div>
              <button className={buttonClass()} onClick={() => setLogView(null)}>
                关闭
              </button>
            </div>
            <pre className="flex-1 overflow-auto px-3 py-2 text-2xs font-mono text-text whitespace-pre-wrap break-words">
              {logView.error
                ? `读取失败：${logView.error}`
                : logView.lines.length
                  ? `${logView.truncated ? '…（只显示结尾部分）\n' : ''}${logView.lines.join('\n')}`
                  : '（空）'}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}