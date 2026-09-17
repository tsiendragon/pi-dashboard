import type { LiveSessionDetail, LiveSessionSummary } from '@shared/live-sessions'
import MarkdownRenderer from '../../components/MarkdownRenderer'
import { displayWorktreePath } from '../../utils/displayPath'

interface LiveSubagentPanelProps {
  summary: LiveSessionSummary
  detail?: LiveSessionDetail
  loading?: boolean
  onClose: () => void
  onOpenFull: () => void
}

type PanelItem =
  | { kind: 'message'; index: number; role: string; text: string; thinking?: string }
  | { kind: 'tool'; index: number; name: string; output: string; status: string }

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(part => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return ''
    const record = part as Record<string, unknown>
    return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
  }).filter(Boolean).join('\n')
}

function contentOf(value: unknown): { text: string; thinking?: string } {
  if (!Array.isArray(value)) return { text: textOf(value) }
  let text = ''
  let thinking = ''
  for (const part of value) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue
    const record = part as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') text += `${record.text}\n`
    if (record.type === 'thinking' && typeof record.thinking === 'string') thinking += `${record.thinking}\n`
  }
  return { text: text.trim(), ...(thinking.trim() ? { thinking: thinking.trim() } : {}) }
}

function messageFromEntry(entry: unknown): { role: string; text: string; thinking?: string } | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined
  const message = record.message && typeof record.message === 'object' && !Array.isArray(record.message)
    ? record.message as Record<string, unknown>
    : data?.message && typeof data.message === 'object' && !Array.isArray(data.message)
      ? data.message as Record<string, unknown>
      : undefined
  if (!message || typeof message.role !== 'string') return undefined
  const content = contentOf(message.content)
  if (!content.text && !content.thinking) return undefined
  return { role: message.role, ...content }
}

function toolFromEntry(entry: unknown): { name: string; output: string; status: string } | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined
  if (!data || data.type !== 'tool_execution_end') return undefined
  const result = data.result && typeof data.result === 'object' && !Array.isArray(data.result) ? data.result as Record<string, unknown> : data.result
  const resultRecord = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : undefined
  return {
    name: typeof data.toolName === 'string' ? data.toolName : typeof data.tool_name === 'string' ? data.tool_name : '工具',
    output: textOf(resultRecord?.content ?? result ?? data.output),
    status: data.isError === true ? '失败' : '完成',
  }
}

function panelItems(entries: unknown[]): PanelItem[] {
  const lastUpdate = entries.reduce((last, entry, index) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && (entry as Record<string, unknown>).type === 'message_update') return index
    return last
  }, -1)
  const items: PanelItem[] = []
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
    const type = (entry as Record<string, unknown>).type
    if (type === 'message_end' || type === 'message' || (type === 'message_update' && index === lastUpdate)) {
      const message = messageFromEntry(entry)
      if (message) items.push({ kind: 'message', index, ...message })
    } else if (type === 'tool_execution_end') {
      const tool = toolFromEntry(entry)
      if (tool) items.push({ kind: 'tool', index, ...tool })
    }
  })
  return items
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : sessionId
}

function sessionStatusEmoji(status: LiveSessionSummary['status']): string {
  if (status === 'running') return '🔨'
  if (status === 'reconnecting') return '🔄'
  return '💤'
}

function roleLabel(role: string): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return 'Agent'
  if (role === 'toolResult') return '工具结果'
  return role
}

export default function LiveSubagentPanel({ summary, detail, loading = false, onClose, onOpenFull }: LiveSubagentPanelProps) {
  const items = detail ? panelItems(detail.entries) : []
  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-[min(620px,92vw)] flex-col border-l border-accent/30 bg-bg shadow-2xl shadow-black/40">
      <header className="shrink-0 border-b border-border bg-card px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="rounded bg-accent/15 px-1.5 py-0.5 text-2xs text-accent">子 Agent</span>
              <h2 className="truncate text-sm font-semibold text-text-strong" title={summary.sessionName || `PID ${summary.pid}`}>
                {summary.sessionName || `子 Agent · PID ${summary.pid}`}
              </h2>
              <span className="shrink-0 text-2xs" title={`Session 状态：${summary.status === 'running' ? '工作中' : summary.status === 'reconnecting' ? '重连中' : '等待输入'}`}>
                {sessionStatusEmoji(summary.status)} {summary.status === 'running' ? '工作中' : summary.status === 'reconnecting' ? '重连中' : '等待输入'}
              </span>
            </div>
            <div className="mt-1 truncate text-2xs text-muted" title={summary.canonicalCwd}>{displayWorktreePath(summary.canonicalCwd)}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-2xs text-muted/80">
              <span title={`完整 session ID：${summary.sessionId}`}>sid {shortSessionId(summary.sessionId)}</span>
              <span>PID {summary.pid}</span>
              {summary.model && <span>{summary.model.provider}/{summary.model.id}</span>}
              {summary.thinkingLevel && <span>effort {summary.thinkingLevel}</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={onOpenFull} className="rounded border border-border bg-bg px-2 py-1 text-2xs text-muted hover:border-accent hover:text-accent">完整页</button>
            <button type="button" onClick={onClose} className="rounded border border-border bg-bg px-2 py-1 text-sm leading-none text-muted hover:border-danger hover:text-danger" title="返回主 Agent">×</button>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && <div className="flex h-full items-center justify-center text-sm text-muted">加载子 Agent…</div>}
        {!loading && !detail && <div className="flex h-full items-center justify-center text-sm text-muted">暂时无法读取子 Agent 内容。</div>}
        {!loading && detail && items.length === 0 && <div className="flex h-full items-center justify-center text-sm text-muted">该子 Agent 暂无可显示内容。</div>}
        {!loading && detail && items.length > 0 && <div className="space-y-2">
          {items.map(item => item.kind === 'tool' ? (
            <details key={`${item.kind}-${item.index}`} className="rounded border border-border bg-card/70">
              <summary className="cursor-pointer list-none px-2 py-1.5 text-2xs text-muted hover:text-accent">
                <span className="mr-1.5 rounded bg-bg px-1 py-0.5 font-mono text-2xs text-accent">工具</span>
                {item.name} <span className={item.status === '失败' ? 'text-danger' : 'text-muted/60'}>· {item.status}</span>
              </summary>
              {item.output && <pre className="max-h-40 overflow-auto border-t border-border/70 px-2 py-1.5 font-mono text-2xs leading-4 text-muted">{item.output}</pre>}
            </details>
          ) : (
            <article key={`${item.kind}-${item.index}`} className={`rounded border px-2.5 py-2 ${item.role === 'user' ? 'ml-8 border-accent/20 bg-accent-subtle/50' : 'mr-2 border-border bg-card'}`}>
              <div className="mb-1 text-2xs font-medium text-muted">{roleLabel(item.role)}</div>
              {item.thinking && <details className="mb-1 rounded bg-bg/60 px-2 py-1 text-2xs text-muted">
                <summary className="cursor-pointer">思考过程</summary>
                <div className="mt-1 whitespace-pre-wrap leading-4">{item.thinking}</div>
              </details>}
              {item.text && <MarkdownRenderer content={item.text} />}
            </article>
          ))}
        </div>}
      </div>
      <footer className="shrink-0 border-t border-border bg-card px-4 py-2 text-2xs text-muted">当前为主 Agent 内嵌只读视图 · 输入和控制请打开完整页面</footer>
    </aside>
  )
}
