import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  LiveSessionContextCategory,
  LiveSessionContextItem,
  LiveSessionContextView,
} from '@shared/live-sessions'
import { liveSessionApi, LiveSessionApiError } from './api'
import MaterialIcon from '../../components/MaterialIcon'

/**
 * 上下文检查器：把「这次到底给模型发了什么」摊开给人看。
 *
 * 数据来自 bridge 的 `get_context`：优先用 `before_provider_request` 落盘的真实请求
 * 载荷，没有时给一份近似重建，并在界面上如实标注两者的区别（`provider_request` /
 * `reconstructed`），不把重建结果说成事实。
 *
 * 它的用途是定位 context 里的大块头（系统提示里的项目说明、工具定义、某几条工具结果），
 * 所以每一行都带真实字符数和估算 token，并且能按大小排序、搜索、展开原文。
 */

interface ContextInspectorProps {
  processInstanceId: string
  /** 会话标题，用于窗口标题里认人。 */
  sessionLabel?: string
  /**
   * 该会话的 bridge 是否声明了 `context_view`。
   *
   * 为 false 时不发请求，直接告诉用户去重载：正在跑的 Pi 会话是启动时加载的旧扩展，
   * 重启 dashboard 不会换掉它，而失败原因要让人一眼看懂。
   */
  capable?: boolean
  onClose: () => void
}

type Tab = 'overview' | 'system' | 'tools' | 'messages' | 'request'

const CATEGORY_LABEL: Record<LiveSessionContextCategory, string> = {
  system: '系统提示',
  tools: '工具定义',
  user: '用户消息',
  assistant: '模型回复',
  tool_call: '工具调用',
  tool_result: '工具结果',
  reasoning: '思考过程',
  other: '其他',
}

const CATEGORY_COLOR: Record<LiveSessionContextCategory, string> = {
  system: 'var(--accent)',
  tools: 'var(--info)',
  user: 'var(--ok)',
  assistant: 'var(--muted-strong)',
  tool_call: 'var(--warn)',
  tool_result: 'var(--danger)',
  reasoning: 'var(--aim)',
  other: 'var(--border-strong)',
}

/** 消息里默认只显示这么多字符，展开后显示完整（bridge 已按上限截断）。 */
const MESSAGE_COLLAPSED_CHARS = 600

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function fmtChars(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return String(n)
}

function fmtTime(at: number | undefined): string {
  if (!at) return '—'
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

function pct(part: number, whole: number): string {
  if (!whole) return '0%'
  const value = (part / whole) * 100
  return value >= 10 ? `${value.toFixed(0)}%` : `${value.toFixed(1)}%`
}

/** 复制给 agent / 同事看的纯文本报告：只放结论和最大的几块，不放全文。 */
function buildReport(view: LiveSessionContextView, sessionLabel: string): string {
  const lines: string[] = []
  lines.push(`# 上下文检查：${sessionLabel}`)
  lines.push('')
  lines.push(`- 数据来源：${view.source === 'provider_request' ? `真实请求载荷（${fmtTime(view.capturedAt)} 抓取）` : '近似重建（本进程还没有发出过请求）'}`)
  lines.push(`- 请求格式：${view.format}${view.model ? ` · ${view.model.provider}/${view.model.id}` : ''}`)
  lines.push(`- 估算总计：${fmtTokens(view.totals.tokens)} tokens（约 ${fmtChars(view.totals.chars)} 字符）`)
  if (view.contextUsage) {
    lines.push(`- pi 上报：${view.contextUsage.tokens != null ? fmtTokens(view.contextUsage.tokens) : '—'} / ${fmtTokens(view.contextUsage.contextWindow)}（${view.contextUsage.percent != null ? `${view.contextUsage.percent.toFixed(1)}%` : '—'}）`)
  }
  if (view.truncated) lines.push('- 注意：内容过大，部分正文已在返回时截断，字符数仍是真实值')
  lines.push('')
  lines.push('## 按类别')
  const categories = Object.entries(view.totals.byCategory).sort((a, b) => b[1] - a[1]) as [LiveSessionContextCategory, number][]
  for (const [category, tokens] of categories) {
    if (!tokens) continue
    lines.push(`- ${CATEGORY_LABEL[category]}：${fmtTokens(tokens)} tokens（${pct(tokens, view.totals.tokens)}）`)
  }
  lines.push('')
  lines.push('## 系统提示里的大块头')
  for (const part of view.systemParts.slice(0, 10)) {
    lines.push(`- ${part.label}：${fmtChars(part.chars)}（${fmtTokens(part.tokens)} tokens${part.count ? `，${part.count} 项` : ''}）`)
  }
  lines.push('')
  lines.push('## 工具定义')
  for (const tool of [...view.tools].sort((a, b) => b.tokens - a.tokens).slice(0, 10)) {
    lines.push(`- ${tool.name}：${fmtTokens(tool.tokens)} tokens（描述 ${fmtChars(tool.descriptionChars)} + 参数 ${fmtChars(tool.parametersChars)}）`)
  }
  lines.push('')
  lines.push('## 最大的消息')
  const biggest = view.messages.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 15)
  for (const message of biggest) {
    lines.push(`- #${message.index} ${message.label}（${CATEGORY_LABEL[message.category]}）：${fmtTokens(message.tokens)} tokens / ${fmtChars(message.chars)} 字符${message.images ? `，${message.images} 张图` : ''}${message.truncated ? '（已截断）' : ''}`)
  }
  return lines.join('\n')
}

function CategoryBar({ view }: { view: LiveSessionContextView }) {
  const entries = (Object.entries(view.totals.byCategory) as [LiveSessionContextCategory, number][])
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1])
  if (!entries.length) return null
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-sm bg-bg-elevated" role="img" aria-label="上下文构成">
      {entries.map(([category, tokens]) => (
        <div
          key={category}
          style={{ width: `${(tokens / view.totals.tokens) * 100}%`, backgroundColor: CATEGORY_COLOR[category] }}
          title={`${CATEGORY_LABEL[category]} ${fmtTokens(tokens)} tokens（${pct(tokens, view.totals.tokens)}）`}
        />
      ))}
    </div>
  )
}

function MessageRow({ message, query }: { message: LiveSessionContextItem; query: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = message.text.length > MESSAGE_COLLAPSED_CHARS
  const text = expanded || !long ? message.text : message.text.slice(0, MESSAGE_COLLAPSED_CHARS)

  return (
    <li className="rounded-md border border-border bg-bg px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2 text-2xs">
        <span className="shrink-0 font-mono text-muted">#{message.index}</span>
        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: CATEGORY_COLOR[message.category] }} />
        <span className="min-w-0 flex-1 truncate text-text-strong" title={`${message.label} · ${message.role}`}>{message.label}</span>
        {message.images ? <span className="shrink-0 text-muted" title={`${message.images} 张图片（按每张约 1000 tokens 估算）`}>🖼{message.images}</span> : null}
        <span className="shrink-0 font-mono text-muted" title="估算 token / 真实字符数">{fmtTokens(message.tokens)} tok · {fmtChars(message.chars)}</span>
        {message.truncated && <span className="shrink-0 rounded border border-warn px-1 text-warn" title="内容过长，返回时已截断；字符数是真实值">截断</span>}
      </div>
      {message.text
        ? (
          <pre className="mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-words font-mono text-2xs text-text">
            <HighlightedText text={text} query={query} />
            {long && !expanded ? '…' : ''}
          </pre>
        )
        : <div className="mt-1 text-2xs italic text-muted">（无可读文本）</div>}
      {long && (
        <button
          type="button"
          className="mt-1 rounded border border-border px-1.5 py-0.5 text-2xs text-muted hover:border-accent hover:text-accent"
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? '收起' : `展开全文（${fmtChars(message.chars)}）`}
        </button>
      )}
    </li>
  )
}

/** 把命中的搜索词标出来，免得在大段文本里找不到位置。 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const needle = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let index = text.toLowerCase().indexOf(needle)
  let key = 0
  while (index >= 0 && parts.length < 400) {
    parts.push(text.slice(cursor, index))
    parts.push(<mark key={key++} className="rounded-sm bg-warn-subtle text-warn">{text.slice(index, index + needle.length)}</mark>)
    cursor = index + needle.length
    index = text.toLowerCase().indexOf(needle, cursor)
  }
  parts.push(text.slice(cursor))
  return <>{parts}</>
}

export default function ContextInspector({ processInstanceId, sessionLabel, capable = true, onClose }: ContextInspectorProps) {
  const [view, setView] = useState<LiveSessionContextView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<Tab>('overview')
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  const load = useCallback(async () => {
    if (!capable) return
    setLoading(true)
    setError(null)
    try {
      setView(await liveSessionApi.contextView(processInstanceId))
    } catch (err) {
      // 老版本 bridge 不认识这条命令：直说怎么修，而不是显示“加载失败”。
      const unsupported = err instanceof LiveSessionApiError && /unsupported_command|not supported/i.test(`${err.code} ${err.message}`)
      setError(unsupported
        ? '这个会话的 Pi 里没有加载最新版 live-session 扩展，取不到上下文视图。先在会话里执行「重载」让 Pi 重新加载扩展，再打开本窗口。'
        : err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [processInstanceId, capable])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const previous = document.activeElement
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [onClose])

  const filteredMessages = useMemo(() => {
    if (!view) return []
    const needle = query.trim().toLowerCase()
    if (!needle) return view.messages
    return view.messages.filter(message =>
      message.text.toLowerCase().includes(needle)
      || message.label.toLowerCase().includes(needle)
      || message.role.toLowerCase().includes(needle))
  }, [view, query])

  const copyReport = useCallback(async () => {
    if (!view) return
    try {
      await navigator.clipboard.writeText(buildReport(view, sessionLabel || processInstanceId))
      setNotice('已复制报告（结论 + 大块头清单，不含正文）')
    } catch {
      setNotice('浏览器拒绝了复制，请手动选中文本复制')
    }
  }, [view, sessionLabel, processInstanceId])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const tabs: Array<{ id: Tab; label: string }> = view
    ? [
        { id: 'overview', label: '总览' },
        { id: 'system', label: `系统提示 ${fmtChars(view.system.chars)}` },
        { id: 'tools', label: `工具 ${view.tools.length}` },
        { id: 'messages', label: `消息 ${view.messages.length}` },
        { id: 'request', label: '请求字段' },
      ]
    : []

  return createPortal(
    <div className="fixed inset-0 z-[72] flex items-center justify-center bg-black/35 p-4" role="presentation" onClick={onClose}>
      <section
        className="flex max-h-[90vh] w-full max-w-[min(1240px,96vw)] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="上下文检查"
        onClick={event => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-border bg-bg-elevated px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-body-s font-semibold text-text-strong">
              <MaterialIcon name="tune" className="h-4 w-4 text-accent" />
              上下文检查
              {view?.source === 'provider_request'
                ? <span className="rounded border border-ok px-1 text-2xs text-ok" title="这是最近一次真正发给模型的请求载荷">真实请求</span>
                : view
                  ? <span className="rounded border border-warn px-1 text-2xs text-warn" title="这个会话还没有发出过请求，下面的内容是近似重建：扩展的 context 变换与逐回合的系统提示改动没有算进去">近似重建</span>
                  : null}
            </div>
            <div className="mt-0.5 truncate text-2xs text-muted" title={sessionLabel}>
              {sessionLabel ? `${sessionLabel} · ` : ''}
              {view
                ? `${view.format}${view.model ? ` · ${view.model.provider}/${view.model.id}` : ''} · ${view.source === 'provider_request' ? `${fmtTime(view.capturedAt)} 抓取` : `${fmtTime(view.generatedAt)} 生成`}`
                : processInstanceId}
            </div>
          </div>
          {notice && <span className="shrink-0 text-2xs text-ok">{notice}</span>}
          <button
            type="button"
            onClick={() => { void copyReport() }}
            disabled={!view}
            className="shrink-0 rounded border border-border bg-bg px-2 py-1 text-2xs text-muted hover:border-accent hover:text-accent disabled:opacity-40"
            title="复制一份文字报告：数据来源、各类别占比、系统提示大块头、最大的消息（不含正文）"
          >复制报告</button>
          <button
            type="button"
            onClick={() => { void load() }}
            disabled={loading || !capable}
            className="shrink-0 rounded border border-border bg-bg px-2 py-1 text-2xs text-muted hover:border-accent hover:text-accent disabled:opacity-40"
          >{loading ? '读取中…' : '刷新'}</button>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 cursor-pointer rounded border border-border bg-bg px-2 py-1 text-2xs text-muted hover:border-accent hover:text-accent"
          >关闭</button>
        </header>

        {!capable
          ? (
            <div className="space-y-2 px-3 py-6 text-body-s text-warn">
              <p>这个会话里的 Pi 还在跑旧版 live-session 扩展，拿不到它的上下文（重启 dashboard 不会换掉已经跑着的 Pi 进程）。</p>
              <p className="text-muted">
                在该会话里点一下顶部工具栏的「重载」（或在终端里执行 <code className="font-mono">/reload</code>），等它重连后重新打开本窗口即可；
                新开的会话从第一次就是新版，不用重载。
              </p>
            </div>
          )
          : error
            ? <div className="px-3 py-6 text-body-s text-warn">{error}</div>
            : !view
              ? <div className="px-3 py-6 text-body-s text-muted">正在读取上下文…</div>
              : (
                <>
                <nav className="flex shrink-0 items-center gap-1 border-b border-border bg-bg px-2 py-1">
                  {tabs.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTab(item.id)}
                      className={`rounded px-2 py-0.5 text-2xs ${tab === item.id ? 'bg-accent-subtle text-accent' : 'text-muted hover:text-text'}`}
                    >{item.label}</button>
                  ))}
                  {tab === 'messages' && (
                    <input
                      value={query}
                      onChange={event => setQuery(event.target.value)}
                      placeholder="在消息正文里搜索…"
                      className="ml-auto w-[240px] rounded border border-border bg-bg px-2 py-0.5 text-2xs text-text"
                    />
                  )}
                </nav>

                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                  {tab === 'overview' && (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <CategoryBar view={view} />
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted">
                          {(Object.entries(view.totals.byCategory) as [LiveSessionContextCategory, number][])
                            .filter(([, tokens]) => tokens > 0)
                            .sort((a, b) => b[1] - a[1])
                            .map(([category, tokens]) => (
                              <span key={category} className="flex items-center gap-1">
                                <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: CATEGORY_COLOR[category] }} />
                                {CATEGORY_LABEL[category]}
                                <span className="font-mono text-text">{fmtTokens(tokens)}</span>
                                <span className="font-mono">({pct(tokens, view.totals.tokens)})</span>
                              </span>
                            ))}
                        </div>
                      </div>

                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-2xs md:grid-cols-4">
                        <div><dt className="text-muted">估算总计</dt><dd className="font-mono text-text-strong">{fmtTokens(view.totals.tokens)} tokens</dd></div>
                        <div><dt className="text-muted">正文字符</dt><dd className="font-mono text-text-strong">{fmtChars(view.totals.chars)}</dd></div>
                        <div>
                          <dt className="text-muted">pi 上报占用</dt>
                          <dd className="font-mono text-text-strong" title="pi 按上一次响应的 usage 计算，和上面的估算会有差距">
                            {view.contextUsage?.tokens != null ? `${fmtTokens(view.contextUsage.tokens)} / ${fmtTokens(view.contextUsage.contextWindow)}` : '—'}
                          </dd>
                        </div>
                        <div><dt className="text-muted">图片 / 工具</dt><dd className="font-mono text-text-strong">{view.messages.reduce((sum, message) => sum + (message.images || 0), 0)} / {view.tools.length}</dd></div>
                      </dl>

                      <div className="rounded-md border border-border bg-bg p-2 text-2xs leading-relaxed text-muted">
                        {view.source === 'provider_request'
                          ? '这是最近一次真实请求的内容：系统提示、工具定义、消息序列都按 provider 线格式解析。token 数是按「ASCII 4 字符≈1 token、中日韩 1 字符≈1 token」估算的，用来比较各块大小，不是精确计费值。'
                          : '这个会话还没有发出过请求，下面是按当前系统提示、已启用工具和会话分支重建的近似视图（扩展的 context 变换与逐回合改动没有算进去）。发出一次消息后再打开，就能看到真实载荷。'}
                        {view.truncated && ' 部分正文因体积过大在返回时被截断，字符数仍是真实值；需要精确排查某一条时可先压缩上下文。'}
                        {view.version === undefined && ' 这份数据来自旧版扩展，部分字段可能缺失（不代表为空）；重载该会话后重新打开即可看到完整版本。'}
                      </div>

                      <div>
                        <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">最大的 10 条消息</div>
                        <ol className="space-y-1">
                          {view.messages.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 10).map(message => (
                            <li key={message.index} className="flex items-center gap-2 text-2xs">
                              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: CATEGORY_COLOR[message.category] }} />
                              <span className="w-[54px] shrink-0 font-mono text-muted">#{message.index}</span>
                              <span className="min-w-0 flex-1 truncate text-text">{message.label}</span>
                              {message.images ? <span className="shrink-0 text-muted">🖼{message.images}</span> : null}
                              <span className="shrink-0 font-mono text-muted">{fmtTokens(message.tokens)} tok · {fmtChars(message.chars)}</span>
                              <button
                                type="button"
                                className="shrink-0 rounded border border-border px-1 text-2xs text-muted hover:border-accent hover:text-accent"
                                onClick={() => { setTab('messages'); setQuery(''); window.setTimeout(() => { document.getElementById(`ctx-msg-${message.index}`)?.scrollIntoView({ block: 'center' }) }, 0) }}
                              >查看</button>
                            </li>
                          ))}
                        </ol>
                      </div>
                    </div>
                  )}

                  {tab === 'system' && (
                    <div className="space-y-2">
                      <div className="text-2xs text-muted">
                        系统提示共 {fmtChars(view.system.chars)}（估算 {fmtTokens(view.system.tokens)} tokens）。下面按 pi 的标记拆出各块，最大的一块通常最值得优化。
                      </div>
                      {view.systemParts.length === 0 && (
                        <div className="rounded border border-border bg-bg px-2 py-1 text-2xs text-warn">
                          {view.version === undefined
                            ? '这个会话的扩展是旧版本，拆不出内容块；重载该会话后再看。'
                            : '这段系统提示里没有项目说明文件 / 技能清单 / 准则等标记块，全部算在「基础提示」之外无处可拆。'}
                        </div>
                      )}
                      <table className="w-full text-2xs">
                        <thead className="text-muted">
                          <tr>
                            <th className="w-[45%] text-left font-normal">内容块</th>
                            <th className="text-left font-normal">字符</th>
                            <th className="text-left font-normal">估算 tokens</th>
                            <th className="text-left font-normal">占比</th>
                          </tr>
                        </thead>
                        <tbody className="font-mono">
                          {view.systemParts.map((part, index) => (
                            <tr key={`${part.kind}-${index}`} className="border-t border-border">
                              <td className="py-1 pr-2 font-body text-text" title={part.label}>
                                {part.label}{part.count ? `（${part.count} 项）` : ''}
                              </td>
                              <td className="py-1">{fmtChars(part.chars)}</td>
                              <td className="py-1">{fmtTokens(part.tokens)}</td>
                              <td className="py-1">{pct(part.chars, view.system.chars)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <pre className="max-h-[46vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg p-2 font-mono text-2xs text-text">
                        <HighlightedText text={view.system.text} query={query} />
                      </pre>
                    </div>
                  )}

                  {tab === 'tools' && (
                    <div className="space-y-1">
                      <div className="text-2xs text-muted">
                        启用中的工具定义（名称 + 描述 + 参数 schema）会整段进入每一次请求。定义越啰嗦，每次都要多付。
                      </div>
                      {view.tools.length === 0
                        ? <div className="text-2xs italic text-muted">没有工具定义</div>
                        : view.tools.slice().sort((a, b) => b.tokens - a.tokens).map(tool => (
                          <details key={tool.name} className="rounded-md border border-border bg-bg px-2 py-1">
                            <summary className="cursor-pointer text-2xs">
                              <span className="font-mono text-text-strong">{tool.name}</span>
                              <span className="ml-2 text-muted">{fmtTokens(tool.tokens)} tok · 描述 {fmtChars(tool.descriptionChars)} · 参数 {fmtChars(tool.parametersChars)}</span>
                              {tool.truncated && <span className="ml-2 rounded border border-warn px-1 text-warn">截断</span>}
                            </summary>
                            {tool.description && <div className="mt-1 whitespace-pre-wrap text-2xs text-text">{tool.description}</div>}
                            <pre className="mt-1 max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-mono text-2xs text-muted">{tool.parameters}</pre>
                          </details>
                        ))}
                    </div>
                  )}

                  {tab === 'messages' && (
                    <ul className="space-y-1.5">
                      {filteredMessages.length === 0
                        ? <li className="text-2xs italic text-muted">{query ? '没有匹配的消息' : '没有消息'}</li>
                        : filteredMessages.map(message => (
                          <div key={message.index} id={`ctx-msg-${message.index}`}>
                            <MessageRow message={message} query={query} />
                          </div>
                        ))}
                    </ul>
                  )}

                  {tab === 'request' && (
                    <div className="space-y-2">
                      <div className="text-2xs text-muted">请求里除内容之外的字段（模型、推理强度、工具选择等），照原样展示。</div>
                      <table className="w-full text-2xs">
                        <tbody className="font-mono">
                          {Object.entries(view.settings).map(([key, value]) => (
                            <tr key={key} className="border-t border-border align-top">
                              <td className="w-[26%] py-1 pr-2 text-text">{key}</td>
                              <td className="py-1 whitespace-pre-wrap break-words text-muted">{value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
      </section>
    </div>,
    document.body,
  )
}