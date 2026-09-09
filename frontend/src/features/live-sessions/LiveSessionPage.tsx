import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { LiveSessionSummary } from '@shared/live-sessions'
import MarkdownRenderer from '../../components/MarkdownRenderer'
import { detectFileType, usePanelState } from '../../hooks/usePanelState'
import { useAppDispatch, useAppSelector } from '../../store'
import { resolvePath } from '../../utils/resolvePath'
import {
  authenticated,
  liveSessionOwned,
  liveSessionReleased,
  liveSessionSnapshot,
  liveSessionUserMessageAdded,
  liveSessionUserMessageRemoved,
  selectLiveSession,
  setLiveSessionError,
} from '../../store/liveSessionsSlice'
import { liveSessionApi, LiveSessionApiError } from './api'
import LiveSessionComposer from './LiveSessionComposer'
import LiveSessionFeatures from './LiveSessionFeatures'
import { buildSessionTitles, buildSubagentStatuses } from './sessionTitle'
import { displayWorktreePath } from '../../utils/displayPath'
import LiveSessionsList from './LiveSessionsList'
import { useLiveSessionsRuntime } from './useLiveSessions'

const DocumentPanel = lazy(() => import('../../components/DocumentPanel'))

function errorMessage(error: unknown): string {
  if (error instanceof LiveSessionApiError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (!part || typeof part !== 'object') return ''
    const record = part as Record<string, unknown>
    return record.type === 'text' && typeof record.text === 'string' ? record.text : record.type === 'image' ? '[image]' : ''
  }).filter(Boolean).join('\n')
}

function messageFromEntry(entry: unknown): { role: string; text: string; content: unknown; channel?: string; toolName?: string; toolCallId?: string; isError?: boolean } | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  let message: Record<string, unknown> | undefined
  let channel: string | undefined
  if (record.type === 'message' && record.message && typeof record.message === 'object') message = record.message as Record<string, unknown>
  if ((record.type === 'message_end' || record.type === 'message_update') && record.data && typeof record.data === 'object') {
    const data = record.data as Record<string, unknown>
    if (data.message && typeof data.message === 'object') message = data.message as Record<string, unknown>
    if (typeof data.channel === 'string') channel = data.channel
  }
  if (!message || typeof message.role !== 'string') return undefined
  const text = textContent(message.content)
  if (message.role !== 'assistant' && !text) return undefined
  return {
    role: message.role,
    text,
    content: message.content,
    ...(channel ? { channel } : {}),
    ...(typeof message.toolName === 'string' ? { toolName: message.toolName } : {}),
    ...(typeof message.toolCallId === 'string' ? { toolCallId: message.toolCallId } : {}),
    ...(typeof message.isError === 'boolean' ? { isError: message.isError } : {}),
  }
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function entryTimestampMs(entry: unknown): number | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined
  const nestedMessage = data?.message && typeof data.message === 'object' && !Array.isArray(data.message) ? data.message as Record<string, unknown> : undefined
  const message = record.message && typeof record.message === 'object' && !Array.isArray(record.message) ? record.message as Record<string, unknown> : undefined
  return timestampValue(message?.timestamp) ?? timestampValue(nestedMessage?.timestamp) ?? timestampValue(record.timestamp) ?? timestampValue(data?.timestamp)
}

function entryTimestamp(entry: unknown): string | undefined {
  const value = entryTimestampMs(entry)
  if (value === undefined) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function shortToolId(value?: string): string {
  return value ? `#${value.length > 12 ? value.slice(0, 8) : value}` : ''
}

const CHANNEL_LABELS: Record<string, string> = { web: 'web', terminal: '终端', chatapp: '聊天' }
function channelLabel(channel?: string): string {
  return channel ? (CHANNEL_LABELS[channel] || channel) : ''
}

function collectLiveFeatures(entries: unknown[]): Record<string, unknown> {
  const features: Record<string, unknown> = {}
  const scheduleTasks = new Map<string, Record<string, unknown>>()
  const subagents = new Map<string, Record<string, unknown>>()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined
    if (record.type === 'live_feature_snapshot' && typeof data?.feature === 'string') {
      features[data.feature] = data.snapshot
      continue
    }
    const message = record.type === 'message' && record.message && typeof record.message === 'object'
      ? record.message as Record<string, unknown> : undefined
    if (message?.role !== 'toolResult' || typeof message.toolName !== 'string') continue
    const details = message.details && typeof message.details === 'object' && !Array.isArray(message.details) ? message.details as Record<string, unknown> : undefined
    if (message.toolName === 'schedule' && details) {
      if (Array.isArray(details.tasks)) {
        scheduleTasks.clear()
        for (const task of details.tasks) if (task && typeof task === 'object' && !Array.isArray(task) && typeof (task as Record<string, unknown>).id === 'string') scheduleTasks.set((task as Record<string, unknown>).id as string, task as Record<string, unknown>)
      }
      const task = details.task && typeof details.task === 'object' && !Array.isArray(details.task) ? details.task as Record<string, unknown> : undefined
      if (task && typeof task.id === 'string') scheduleTasks.set(task.id, task)
      if (details.cancelled === true && typeof details.id === 'string') scheduleTasks.delete(details.id)
    }
    if (message.toolName.startsWith('subagent_') && details) {
      const id = typeof details.workId === 'string' ? details.workId : typeof details.workflowId === 'string' ? details.workflowId : undefined
      if (id) subagents.set(id, { id, label: details.label || id, status: details.status || 'recorded' })
    }
  }
  if (!features.schedule && scheduleTasks.size) features.schedule = { tasks: [...scheduleTasks.values()] }
  if (!features['subagent-workflow'] && subagents.size) features['subagent-workflow'] = { conversations: { items: [...subagents.values()] }, workflows: { items: [] } }
  return features
}

function CollapsibleMarkdown({ content, onFileOpen }: { content: string; onFileOpen: (path: string) => void }) {
  const lines = content.split('\n')
  const previewLines = 12
  const previewChars = 1_600
  const long = lines.length > previewLines || content.length > previewChars
  const [collapsed, setCollapsed] = useState(long)
  const visible = collapsed ? lines.slice(0, previewLines).join('\n').slice(0, previewChars) : content
  return (
    <div>
      <div className={`text-[13px] leading-5 [&_h1]:mb-1 [&_h1]:mt-2 [&_h1]:text-base [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:text-sm [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-sm [&_li]:text-[13px] [&_li]:leading-5 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1 ${collapsed ? 'relative max-h-[220px] overflow-hidden' : ''}`}>
        <MarkdownRenderer content={visible} onFileOpen={onFileOpen} />
        {collapsed && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" />}
      </div>
      {long && (
        <button type="button" onClick={() => setCollapsed(value => !value)} className="mt-2 text-xs text-accent bg-transparent border-none cursor-pointer hover:underline">
          {collapsed ? `展开全部（${lines.length} 行）` : '收起长内容'}
        </button>
      )}
    </div>
  )
}

function contentParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  return content.filter((part): part is Record<string, unknown> => !!part && typeof part === 'object' && !Array.isArray(part))
}

function ToolResultCard({ text, toolName, toolCallId, isError, timestamp }: { text: string; toolName?: string; toolCallId?: string; isError?: boolean; timestamp?: string }) {
  const lines = text.split('\n')
  const previewLines = 6
  const previewChars = 900
  const long = lines.length > previewLines || text.length > previewChars
  const [expanded, setExpanded] = useState(!long)
  const visible = expanded || !long ? text : lines.slice(0, previewLines).join('\n').slice(0, previewChars)
  return (
    <article className="w-fit max-w-full overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-bg-elevated px-2 py-1">
        <span className={`min-w-0 truncate text-[10px] font-semibold uppercase tracking-wide ${isError ? 'text-danger' : 'text-muted'}`}>
          Tool result{toolName ? ` · ${toolName}` : ''} {shortToolId(toolCallId)}{isError ? ' · error' : ''}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[10px] text-muted"><time>{timestamp || '—'}</time><span>{lines.length} 行</span></span>
      </div>
      <div className={expanded ? 'max-h-[320px] overflow-auto' : 'relative max-h-[170px] overflow-hidden'}>
        <pre className="m-0 whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[10px] leading-4 text-text">{visible}</pre>
        {!expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent" />}
      </div>
      {long && <button type="button" onClick={() => setExpanded(value => !value)} className="border-t border-border bg-transparent px-2 py-1 text-[10px] text-accent hover:underline">
        {expanded ? '收起' : `展开（${lines.length} 行）`}
      </button>}
    </article>
  )
}

type ToolState = {
  toolCallId: string
  toolName?: string
  called: boolean
  started: boolean
  ended: boolean
  command?: string
  partialText?: string
  result?: { text: string; toolName?: string; isError?: boolean; timestamp?: string }
}

type ToolStateMap = Map<string, ToolState>

function partialText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const record = value as Record<string, unknown>
  return textContent(record.content) || (typeof record.text === 'string' ? record.text : '')
}

function collectToolStates(entries: unknown[]): ToolStateMap {
  const states: ToolStateMap = new Map()
  const ensure = (toolCallId: string): ToolState => {
    const existing = states.get(toolCallId)
    if (existing) return existing
    const created: ToolState = { toolCallId, called: false, started: false, ended: false }
    states.set(toolCallId, created)
    return created
  }
  for (const entry of entries) {
    const message = messageFromEntry(entry)
    if (message?.role === 'assistant') {
      for (const part of contentParts(message.content)) {
        if (part.type !== 'toolCall' || typeof part.id !== 'string') continue
        const state = ensure(part.id)
        state.called = true
        if (typeof part.name === 'string') state.toolName = part.name
        const argumentsValue = part.arguments
        if (argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
          const argumentsRecord = argumentsValue as Record<string, unknown>
          if (typeof argumentsRecord.command === 'string') state.command = argumentsRecord.command
        }
      }
    }
    if (message?.role === 'toolResult' && message.toolCallId) {
      const state = ensure(message.toolCallId)
      state.result = { text: message.text, toolName: message.toolName, isError: message.isError, timestamp: entryTimestamp(entry) }
      if (message.toolName) state.toolName = message.toolName
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (!record.type || !String(record.type).startsWith('tool_execution_')) continue
    const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : record
    if (typeof data.toolCallId !== 'string') continue
    const state = ensure(data.toolCallId)
    if (typeof data.toolName === 'string') state.toolName = data.toolName
    if (record.type === 'tool_execution_start' || record.type === 'tool_execution_update') state.started = true
    if (record.type === 'tool_execution_end') state.ended = true
    if (record.type === 'tool_execution_update') state.partialText = partialText(data.partialResult)
  }
  return states
}

type AgentState = {
  label: string
  tone: 'muted' | 'accent' | 'ok' | 'danger'
  activeTools: string[]
  doneTools: number
  thinkingStartedAt?: number
}

function deriveAgentState(status: string | undefined, entries: unknown[], toolStates: ToolStateMap): AgentState {
  const states = [...toolStates.values()]
  const active = states.filter(state => !state.result && !state.ended && (state.started || state.called))
  const running = active.filter(state => state.started)
  const toolNames = (running.length ? running : active).map(state => state.toolName || 'tool')
  const doneTools = states.filter(state => !!state.result || state.ended).length
  let observedStatus = status
  for (let index = entries.length - 1; index >= 0; index--) {
    const candidate = entries[index]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const type = typeof (candidate as Record<string, unknown>).type === 'string' ? (candidate as Record<string, unknown>).type : ''
    if (type === 'agent_start') { observedStatus = 'running'; break }
    if (type === 'agent_settled') { observedStatus = 'idle'; break }
  }
  if (observedStatus === 'reconnecting') return { label: '重连中', tone: 'danger', activeTools: toolNames, doneTools }
  if (observedStatus !== 'running') return { label: '等待输入', tone: 'muted', activeTools: [], doneTools }
  if (running.length) return { label: `执行工具 · ${toolNames.slice(0, 2).join('、')}${toolNames.length > 2 ? ` 等 ${toolNames.length} 个` : ''}`, tone: 'accent', activeTools: toolNames, doneTools }
  if (active.length) return { label: `准备工具 · ${toolNames.slice(0, 2).join('、')}`, tone: 'accent', activeTools: toolNames, doneTools }

  let latestAssistant: Record<string, unknown> | undefined
  let latestAssistantEntry: unknown
  for (let index = entries.length - 1; index >= 0; index--) {
    const candidate = messageFromEntry(entries[index])
    if (candidate?.role === 'assistant') {
      latestAssistant = candidate.content && typeof candidate.content === 'object' ? candidate as unknown as Record<string, unknown> : undefined
      latestAssistantEntry = entries[index]
      break
    }
  }
  const content = latestAssistant?.content
  const parts = contentParts(content)
  if (parts.some(part => part.type === 'thinking')) return { label: '思考中', tone: 'accent', activeTools: [], doneTools, thinkingStartedAt: entryTimestampMs(latestAssistantEntry) }
  if (parts.some(part => part.type === 'text')) return { label: '生成回复', tone: 'accent', activeTools: [], doneTools }
  return { label: '工作中', tone: 'accent', activeTools: [], doneTools }
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

function ThinkingElapsed({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === undefined) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === undefined ? null : <span className="ml-1 font-mono text-[10px]">· {formatElapsed(now - startedAt)}</span>
}

function formatStatusTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '…'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return String(Math.round(value))
}

function formatSessionElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}h${pad(minutes)}m` : `${minutes}m${pad(remainder)}s`
}

function SessionElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return <span title="Pi session 已运行时间">◷ {formatSessionElapsed(now - startedAt)}</span>
}

function TuiLikeStatus({ summary }: { summary: LiveSessionSummary }) {
  const usage = summary.contextUsage
  const percent = usage?.percent !== null && usage?.percent !== undefined && Number.isFinite(usage.percent) ? Math.max(0, Math.min(100, usage.percent)) : undefined
  const filled = percent === undefined ? 0 : Math.round(percent / 100 * 12)
  const bar = `${'█'.repeat(filled)}${'░'.repeat(12 - filled)}│`
  return <span className="flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-[10px] text-muted" title="上下文占用和 session 运行时间">
    <span className={percent !== undefined && percent >= 85 ? 'text-warn' : 'text-muted'}>{bar}</span>
    <span>{formatStatusTokens(usage?.tokens)}/{formatStatusTokens(usage?.contextWindow)}</span>
    {percent !== undefined && <span>{Math.round(percent)}%</span>}
    <span>· {summary.mode.toUpperCase()}</span>
    <SessionElapsed startedAt={summary.startedAt} />
  </span>
}

function ToolCallCard({ name, toolCallId, argsText, state }: { name: string; toolCallId?: string; argsText: string; state?: ToolState }) {
  const result = state?.result
  return (
    <article className="w-fit max-w-full overflow-hidden rounded-md border border-border bg-bg-elevated">
      <details>
        <summary className="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] font-semibold text-text-strong">
          <span className="truncate">调用工具：{name} {shortToolId(toolCallId)}</span>
          <span className={`shrink-0 text-[10px] font-normal ${result?.isError ? 'text-danger' : result ? 'text-ok' : state?.partialText ? 'text-accent' : 'text-muted'}`}>
            {result?.isError ? '失败' : result ? '完成' : state?.ended ? '处理中' : state?.started || state?.partialText ? '运行中' : '等待执行'}
          </span>
        </summary>
        {argsText && <pre className="m-0 max-h-[12rem] max-w-full overflow-auto whitespace-pre-wrap break-words border-t border-border px-2 py-1.5 font-mono text-[10px] leading-4 text-muted">{argsText.slice(0, 100_000)}</pre>}
      </details>
      {!result && state?.partialText && <div className="border-t border-border px-2.5 py-2"><div className="mb-1 text-[10px] text-accent">实时输出</div><pre className="m-0 max-h-[150px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-text">{state.partialText}</pre></div>}
      {result && <ToolResultCard text={result.text} toolName={result.toolName || name} toolCallId={toolCallId} isError={result.isError} timestamp={result.timestamp} />}
    </article>
  )
}

type MonitoredCommand = {
  key: string
  kind: 'foreground' | 'background'
  label: string
  detail: string
  command: string
  output: string
}

function compactCommand(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 72)
}

function LiveCommandBar({ toolStates, features }: { toolStates: ToolStateMap; features: Record<string, unknown> }) {
  const [selectedKey, setSelectedKey] = useState<string>()
  const commands = useMemo<MonitoredCommand[]>(() => {
    const result: MonitoredCommand[] = []
    for (const state of toolStates.values()) {
      if (!state.started || state.ended || state.result) continue
      const command = state.command || state.toolName || 'tool'
      result.push({
        key: `foreground:${state.toolCallId}`,
        kind: 'foreground',
        label: compactCommand(command),
        detail: `${state.toolName || 'tool'} ${shortToolId(state.toolCallId)}`,
        command,
        output: state.partialText || '等待输出…',
      })
    }
    const background = features['background-commands']
    const backgroundRecord = background && typeof background === 'object' && !Array.isArray(background) ? background as Record<string, unknown> : undefined
    const tasks = Array.isArray(backgroundRecord?.tasks) ? backgroundRecord.tasks : []
    for (const value of tasks) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const task = value as Record<string, unknown>
      const status = typeof task.status === 'string' ? task.status : 'unknown'
      if (status !== 'running' && status !== 'starting' && status !== 'queued') continue
      const taskId = typeof task.taskId === 'string' ? task.taskId : typeof task.id === 'string' ? task.id : 'background'
      const command = typeof task.command === 'string' ? task.command : typeof task.title === 'string' ? task.title : '后台命令'
      result.push({
        key: `background:${taskId}`,
        kind: 'background',
        label: compactCommand(command),
        detail: `${typeof task.title === 'string' ? task.title : '后台命令'} · ${taskId}`,
        command,
        output: typeof task.outputTail === 'string' && task.outputTail ? task.outputTail : '等待输出…',
      })
    }
    return result
  }, [features, toolStates])

  if (commands.length === 0) return null
  const selected = commands.find(command => command.key === selectedKey)
  return <>
    <div className="shrink-0 border-t border-border bg-bg px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-[10px] font-medium text-accent">运行中</span>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {commands.map(command => <button key={command.key} type="button" aria-expanded={selected?.key === command.key} onClick={() => setSelectedKey(command.key)} className="max-w-[min(320px,60vw)] shrink-0 truncate rounded border border-border bg-card px-2 py-1 text-left text-[10px] text-muted hover:border-accent/40 hover:text-accent" title={`${command.detail}\n${command.command}`}>
            <span className="mr-1 text-accent">●</span>{command.kind === 'background' ? '后台' : '前台'} · {command.label}
          </button>)}
        </div>
      </div>
    </div>
    {selected && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 p-4" role="presentation" onClick={() => setSelectedKey(undefined)}>
      <section className="w-full max-w-4xl overflow-hidden rounded-lg border border-border bg-card shadow-2xl" role="dialog" aria-modal="true" aria-label={`${selected.kind === 'background' ? '后台' : '前台'}命令输出`} onClick={event => event.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-border bg-bg-elevated px-3 py-2">
          <div className="min-w-0 flex-1"><div className="text-xs font-semibold text-text-strong">{selected.kind === 'background' ? '后台命令' : '前台命令'} · {selected.detail}</div><div className="mt-0.5 truncate font-mono text-[11px] text-muted" title={selected.command}>{selected.command}</div></div>
          <button type="button" onClick={() => setSelectedKey(undefined)} className="shrink-0 rounded border border-border bg-bg px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent">关闭</button>
        </header>
        <pre className="m-0 max-h-[65vh] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-text">{selected.output}</pre>
      </section>
    </div>}
  </>
}

function MessageContent({ content, onFileOpen, toolStates }: { content: unknown; onFileOpen: (path: string) => void; toolStates?: ToolStateMap }) {
  const parts = contentParts(content)
  if (parts.length === 0) return null
  return (
    <div className="space-y-1 text-[13px] leading-5 [&_h1]:mb-1 [&_h1]:mt-2 [&_h1]:text-base [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:text-sm [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-sm [&_li]:text-[13px] [&_li]:leading-5 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1">
      {parts.map((part, index) => {
        switch (part.type) {
          case 'thinking': {
            const thinking = typeof part.thinking === 'string' ? part.thinking : ''
            return (
              <details key={index} className="rounded-md border border-border border-l-[3px] border-l-[#a78bfa] bg-bg-elevated">
                <summary className="px-2 py-1 cursor-pointer text-[11px] text-muted font-mono hover:text-text">思考过程（{thinking.length.toLocaleString()} chars）</summary>
                <pre className="px-2 pb-2 text-[11px] text-muted leading-4 whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto font-body">{thinking}</pre>
              </details>
            )
          }
          case 'text': {
            const text = typeof part.text === 'string' ? part.text : ''
            return text ? <CollapsibleMarkdown key={index} content={text} onFileOpen={onFileOpen} /> : null
          }
          case 'toolCall': {
            const name = typeof part.name === 'string' ? part.name : 'tool'
            const toolArgs = part.arguments
            let argsText = ''
            if (typeof toolArgs === 'string') argsText = toolArgs
            else if (toolArgs !== undefined && toolArgs !== null) { try { argsText = JSON.stringify(toolArgs, null, 2) } catch { argsText = String(toolArgs) } }
            const toolCallId = typeof part.id === 'string' ? part.id : undefined
            return <ToolCallCard key={index} name={name} toolCallId={toolCallId} argsText={argsText} state={toolCallId ? toolStates?.get(toolCallId) : undefined} />
          }
          case 'image':
            return <div key={index} className="text-xs text-muted italic">[image]</div>
          default:
            return null
        }
      })}
    </div>
  )
}

function TimelineEntry({ entry, onFileOpen, toolStates }: { entry: unknown; onFileOpen: (path: string) => void; toolStates: ToolStateMap }) {
  const timestamp = entryTimestamp(entry)
  const entryRecord = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined
  const eventData = entryRecord?.data && typeof entryRecord.data === 'object' && !Array.isArray(entryRecord.data)
    ? entryRecord.data as Record<string, unknown> : undefined
  const eventMessage = eventData?.message && typeof eventData.message === 'object' && !Array.isArray(eventData.message)
    ? eventData.message as Record<string, unknown> : undefined
  const snapshotMessage = entryRecord?.message && typeof entryRecord.message === 'object' && !Array.isArray(entryRecord.message)
    ? entryRecord.message as Record<string, unknown> : undefined
  const rawMessage = eventMessage || snapshotMessage
  if (rawMessage?.role === 'custom' && (rawMessage.display === false || rawMessage.customType === 'goal-context')) return null
  if (entryRecord?.type === 'custom_message') {
    const customData = eventData || entryRecord
    if (customData.customType === 'goal-context' || customData.display === false) return null
  }
  const message = messageFromEntry(entry)
  if (message) {
    if (message.role === 'toolResult') {
      if (message.toolCallId && toolStates.get(message.toolCallId)?.called) return null
      return <ToolResultCard text={message.text} toolName={message.toolName} toolCallId={message.toolCallId} isError={message.isError} timestamp={timestamp} />
    }
    const assistant = message.role === 'assistant'
    const user = message.role === 'user'
    return (
      <article className={`rounded-lg border ${user ? 'ml-4 w-fit max-w-[78%] self-end border-[#bfdbfe] bg-[#eff6ff] p-1.5 shadow-sm md:ml-10 md:max-w-[70%]' : assistant ? 'w-fit max-w-[96%] border-[#bfdbfe] bg-[#eff6ff] p-1.5' : 'border-accent/25 bg-accent-subtle p-2.5'}`}>
        <div className={`mb-1 flex items-center justify-between gap-2 px-1 text-[10px] uppercase tracking-wide text-slate-500 ${user ? 'text-right' : ''}`}>
          <span>
            {message.role}
            {message.channel && <span className="ml-2 normal-case text-blue-600">来自 {channelLabel(message.channel)}</span>}
          </span>
          <time className="shrink-0 normal-case text-[10px] font-normal text-slate-400">{timestamp || '—'}</time>
        </div>
        <div className="rounded-md border border-[#dbeafe] bg-white px-2 py-1.5 text-slate-900 [&_h1]:text-slate-900 [&_h2]:text-slate-900 [&_h3]:text-slate-900 [&_p]:text-slate-900 [&_strong]:text-slate-900">
          {assistant
            ? <MessageContent content={message.content} onFileOpen={onFileOpen} toolStates={toolStates} />
            : <CollapsibleMarkdown content={message.text} onFileOpen={onFileOpen} />}
        </div>
      </article>
    )
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const record = entry as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : 'event'
  if (type === 'message_start' || type === 'live_feature_snapshot' || type === 'agent_start' || type === 'agent_end' || type === 'agent_settled' || type === 'turn_start' || type === 'turn_end') return null
  if (type === 'tool_execution_update') {
    const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : record
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined
    if (toolCallId && toolStates.get(toolCallId)?.called) return null
    const text = partialText(data.partialResult)
    return text ? <ToolResultCard text={text} toolName={typeof data.toolName === 'string' ? data.toolName : 'tool'} toolCallId={toolCallId} timestamp={timestamp} /> : null
  }
  if (type.startsWith('tool_execution_')) {
    const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : record
    const toolName = typeof data.toolName === 'string' ? data.toolName : 'tool'
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined
    if (type === 'tool_execution_start' && toolCallId && toolStates.get(toolCallId)?.called) return null
    if (type === 'tool_execution_end') {
      if (toolCallId && toolStates.get(toolCallId)?.result) return null
      const isError = data.isError === true || data.isError === 'true'
      return <div className={`flex items-center gap-2 border-l-2 px-2 py-1 text-[11px] ${isError ? 'border-danger text-danger' : 'border-ok text-muted'}`}>
        <span>{isError ? '✕' : '✓'}</span><span>{toolName}</span><span className="font-mono text-muted">{shortToolId(toolCallId)}</span><span>{isError ? '失败' : '完成'}</span>
      </div>
    }
    const payload = data.input ?? data.args ?? data.command ?? data
    const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined
    const command = typeof data.command === 'string' ? data.command : typeof payloadRecord?.command === 'string' ? payloadRecord.command : undefined
    const text = command ?? (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2))
    const language = command || /^(?:bash|shell)$/i.test(toolName) ? 'bash' : 'json'
    return (
      <details className="rounded-lg border border-border bg-bg-elevated">
        <summary className="px-2.5 py-1.5 cursor-pointer text-[11px] font-semibold text-text-strong">
          调用工具：{toolName} {shortToolId(toolCallId)}
        </summary>
        <div className="px-2.5 pb-2.5 max-h-[20rem] overflow-auto">
          <MarkdownRenderer content={`\`\`\`${language}\n${text.slice(0, 100_000)}\n\`\`\``} onFileOpen={onFileOpen} />
        </div>
      </details>
    )
  }
  if (type === 'custom_message') {
    return <details className="rounded-lg border border-border bg-card"><summary className="px-3 py-2 cursor-pointer text-xs text-text">custom message</summary><pre className="p-3 pt-1 text-xs text-text whitespace-pre-wrap">{JSON.stringify(record.data, null, 2).slice(0, 100_000)}</pre></details>
  }
  return <div className="text-[11px] text-muted border-l-2 border-border pl-3 py-1">{type.split('_').join(' ')}</div>
}

export function AuthPanel({ onAuthenticated }: { onAuthenticated: (browserClientId: string) => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    if (!token.trim()) return
    setBusy(true); setError(undefined)
    try {
      const result = await liveSessionApi.authenticate(token.trim())
      onAuthenticated(result.browserClientId)
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy(false) }
  }
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-lg">
        <h1 className="text-lg font-semibold text-text-strong">Live Pi Session 认证</h1>
        <p className="mt-2 text-sm text-muted">输入本机控制 token 后才能读取或接管正在运行的 Pi session。</p>
        <code className="block mt-3 p-2 rounded bg-bg text-xs text-text break-all">~/.pi/agent/run/pi-dashboard/live-control-token</code>
        <input type="password" value={token} onChange={event => setToken(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void submit() }} className="mt-4 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent" placeholder="64 位控制 token" />
        {error && <div className="mt-2 text-xs text-danger">{error}</div>}
        <button type="button" disabled={!token.trim() || busy} onClick={() => void submit()} className="mt-4 w-full rounded-lg bg-accent text-white py-2 border-none disabled:opacity-50">{busy ? '验证中…' : '验证'}</button>
      </div>
    </div>
  )
}

export default function LiveSessionPage() {
  const { processInstanceId } = useParams<{ processInstanceId?: string }>()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { refresh } = useLiveSessionsRuntime()
  const state = useAppSelector(root => root.liveSessions)
  const sessions = useMemo(() => Object.values(state.sessions).sort((a, b) => b.lastActivityAt - a.lastActivityAt), [state.sessions])
  const sessionTitles = useMemo(() => buildSessionTitles(state.sessions, state.details), [state.sessions, state.details])
  const subagentStatuses = useMemo(() => buildSubagentStatuses(state.details), [state.details])
  const activeId = processInstanceId || state.activeId
  const summary = activeId ? state.sessions[activeId] : undefined
  const detail = activeId ? state.details[activeId] : undefined
  const ownedLeaseId = activeId ? state.ownedLeases[activeId] : undefined
  const features = useMemo(() => collectLiveFeatures(detail?.entries || []), [detail?.entries])
  const toolStates = useMemo(() => collectToolStates(detail?.entries || []), [detail?.entries])
  const agentState = useMemo(() => deriveAgentState(summary?.status, detail?.entries || [], toolStates), [summary?.status, detail?.entries, toolStates])
  const [busy, setBusy] = useState(false)
  const [sessionSidebarVisible, setSessionSidebarVisible] = useState(() => typeof window === 'undefined' || localStorage.getItem('live-session-sidebar') !== 'hidden')
  const timelineEnd = useRef<HTMLDivElement>(null)
  const panel = usePanelState()

  const handleFileOpen = useCallback(async (rawPath: string) => {
    const filePath = resolvePath(rawPath, summary?.canonicalCwd)
    try {
      const fileType = detectFileType(filePath)
      let content = ''
      if (fileType === 'text' || fileType === 'html') {
        const response = await fetch('/api/file-read?path=' + encodeURIComponent(filePath))
        content = response.ok ? await response.text() : `_Error ${response.status}: file not found_`
      }
      panel.openPanel(filePath, content)
    } catch {
      panel.openPanel(filePath, '_Error reading file_')
    }
  }, [panel.openPanel, summary?.canonicalCwd])

  const handleFileSave = useCallback(async (filePath: string, content: string) => {
    const response = await fetch('/api/file-write', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    })
    if (!response.ok) throw new Error(`Save failed: ${response.status}`)
    panel.setDirty(false)
  }, [panel.setDirty])

  useEffect(() => {
    if (activeId) dispatch(selectLiveSession(activeId))
    else if (sessions[0]) navigate(`/live-sessions/${encodeURIComponent(sessions[0].processInstanceId)}`, { replace: true })
  }, [activeId, dispatch, navigate, sessions])

  useEffect(() => {
    if (!activeId || detail || state.auth !== 'authenticated') return
    liveSessionApi.detail(activeId).then(value => dispatch(liveSessionSnapshot(value))).catch(error => dispatch(setLiveSessionError(errorMessage(error))))
  }, [activeId, detail, dispatch, state.auth])

  useEffect(() => { timelineEnd.current?.scrollIntoView({ block: 'end' }) }, [detail?.entries.length])

  useEffect(() => {
    if (!activeId || !ownedLeaseId) return
    const timer = setInterval(() => {
      liveSessionApi.renew(activeId, ownedLeaseId).then(({ result }) => {
        dispatch(liveSessionOwned({ processInstanceId: activeId, leaseId: result.leaseId || ownedLeaseId, expiresAt: result.expiresAt }))
      }).catch(error => {
        dispatch(liveSessionReleased(activeId))
        dispatch(setLiveSessionError(errorMessage(error)))
      })
    }, 10_000)
    return () => clearInterval(timer)
  }, [activeId, dispatch, ownedLeaseId])

  const claim = async (): Promise<string> => {
    if (!activeId) throw new Error('没有选中的 Live Session')
    if (ownedLeaseId) return ownedLeaseId
    const { result } = await liveSessionApi.claim(activeId)
    if (!result.leaseId) throw new Error('接管响应缺少 leaseId')
    dispatch(liveSessionOwned({ processInstanceId: activeId, leaseId: result.leaseId, expiresAt: result.expiresAt }))
    return result.leaseId
  }

  const perform = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); dispatch(setLiveSessionError(undefined))
    try { await operation() } catch (error) { dispatch(setLiveSessionError(errorMessage(error))); throw error }
    finally { setBusy(false) }
  }

  const release = () => perform(async () => {
    if (!activeId || !ownedLeaseId) return
    await liveSessionApi.release(activeId, ownedLeaseId)
    dispatch(liveSessionReleased(activeId))
  })
  const abort = () => perform(async () => {
    if (!activeId) return
    const leaseId = await claim()
    await liveSessionApi.command(activeId, { type: 'abort', leaseId })
  })
  const controlBtw = (type: 'open' | 'close') => perform(async () => {
    if (!activeId) return
    const leaseId = await claim()
    await liveSessionApi.command(activeId, { type: 'feature_command', leaseId, feature: 'btw', command: { type } })
  })

  const submit = (text: string, deliverAs?: 'steer' | 'followUp') => perform(async () => {
    if (!activeId) return
    const processInstanceId = activeId
    const localId = `dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`
    dispatch(liveSessionUserMessageAdded({ processInstanceId, localId, text }))
    try {
      await liveSessionApi.command(processInstanceId, { type: 'prompt', text, channel: 'web', ...(deliverAs ? { deliverAs } : {}), expandPromptTemplates: false })
    } catch (error) {
      dispatch(liveSessionUserMessageRemoved({ processInstanceId, localId }))
      throw error
    }
  })

  if (state.auth === 'checking') return <div className="flex-1 flex items-center justify-center text-muted">检查 Live Session 认证…</div>
  if (state.auth === 'required') return <AuthPanel onAuthenticated={browserClientId => { dispatch(authenticated({ browserClientId })); void refresh() }} />

  const toggleSessionSidebar = (): void => {
    setSessionSidebarVisible(value => {
      const next = !value
      localStorage.setItem('live-session-sidebar', next ? 'visible' : 'hidden')
      return next
    })
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
      {sessionSidebarVisible && <LiveSessionsList sessions={sessions} sessionTitles={sessionTitles} subagentStatuses={subagentStatuses} activeId={activeId} onRefresh={refresh} onSelect={id => navigate(`/live-sessions/${encodeURIComponent(id)}`)} />}
      <main className="min-w-0 flex-1 flex flex-col bg-bg">
        <div className="flex h-8 min-w-0 items-center justify-between gap-2 border-b border-border bg-card/60 px-2 text-[10px] text-muted">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <button type="button" onClick={toggleSessionSidebar} className="shrink-0 rounded border border-border bg-bg px-2 py-0.5 text-[10px] text-muted hover:border-accent hover:text-accent" title={sessionSidebarVisible ? '隐藏 Session 列表' : '显示 Session 列表'}>
              {sessionSidebarVisible ? '隐藏列表' : '显示列表'}
            </button>
            <span className="shrink-0">{state.wsConnected ? '● 实时连接' : '◐ 正在重连'}</span>
            {summary && <>
              <span className={`shrink-0 ${agentState.tone === 'danger' ? 'text-danger' : agentState.tone === 'accent' ? 'text-accent' : agentState.tone === 'ok' ? 'text-ok' : 'text-muted'}`} title={`Agent 状态：${agentState.label}`}>
                ● {agentState.label}{agentState.label === '思考中' && <ThinkingElapsed startedAt={agentState.thinkingStartedAt} />}
              </span>
              {(agentState.activeTools.length > 0 || agentState.doneTools > 0) && <span className="shrink-0 text-[10px] text-muted" title={`运行中工具：${agentState.activeTools.join('、') || '无'}；已完成工具：${agentState.doneTools}个`}>
                工具 {agentState.activeTools.length} 运行 · {agentState.doneTools} 完成
              </span>}
            </>}
            {summary && <TuiLikeStatus summary={summary} />}
            {summary && <span className="min-w-0 flex-1 truncate" title={`${summary.sessionName || `Pi ${summary.pid}`} · ${summary.canonicalCwd} · ${summary.model ? `${summary.model.provider}/${summary.model.id}` : 'model unavailable'} · ${summary.thinkingLevel || ''}`}>
              {summary.sessionName || `Pi ${summary.pid}`} · {displayWorktreePath(summary.canonicalCwd)} · {summary.model ? `${summary.model.provider}/${summary.model.id}` : 'model unavailable'}{summary.thinkingLevel ? ` · ${summary.thinkingLevel}` : ''}
            </span>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {summary?.status === 'running' && ownedLeaseId && <button type="button" disabled={busy} onClick={() => { void abort().catch(() => {}) }} className="rounded border border-danger/40 bg-danger-subtle px-2 py-0.5 text-[10px] text-danger disabled:opacity-50">中止</button>}
            {summary && (ownedLeaseId ? <button type="button" disabled={busy} onClick={() => { void release().catch(() => {}) }} className="rounded border border-border bg-bg px-2 py-0.5 text-[10px] text-muted disabled:opacity-50">释放控制</button> : <button type="button" disabled={busy || summary.status === 'reconnecting'} onClick={() => { void perform(async () => { await claim() }).catch(() => {}) }} className="rounded border border-accent bg-accent px-2 py-0.5 text-[10px] text-white disabled:opacity-50">取得控制</button>)}
            <button type="button" onClick={() => void refresh()} className="rounded border border-border bg-bg px-2 py-0.5 text-[10px] text-muted hover:border-accent hover:text-accent">刷新</button>
          </div>
        </div>
        {state.error && <div className="px-4 py-2 bg-danger-subtle text-danger text-xs border-b border-danger/20">{state.error}</div>}
        {!summary || !detail ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted">选择一个正在运行的 Pi session。</div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex flex-1 flex-col overflow-y-auto p-3 space-y-2">
                  {detail.entries.length === 0 && <div className="text-sm text-muted text-center py-10">该 session 暂无可显示消息。</div>}
                  {detail.entries.map((entry, index) => <TimelineEntry key={`${index}-${typeof entry === 'object' && entry ? String((entry as Record<string, unknown>).type || '') : ''}`} entry={entry} onFileOpen={path => { void handleFileOpen(path) }} toolStates={toolStates} />)}
                  <div ref={timelineEnd} />
                </div>
                <LiveCommandBar toolStates={toolStates} features={features} />
                <LiveSessionComposer
                  status={summary.status}
                  disabled={busy || summary.status === 'reconnecting'}
                  onSubmit={submit}
                />
              </div>
              <LiveSessionFeatures
                features={features}
                busy={busy}
                onOpenBtw={() => { void controlBtw('open').catch(() => {}) }}
                onCloseBtw={() => { void controlBtw('close').catch(() => {}) }}
              />
            </div>
          </>
        )}
      </main>
      {panel.isOpen && (
        <Suspense fallback={<div className="w-[480px] border-l border-border flex items-center justify-center text-sm text-muted">加载文件…</div>}>
        <DocumentPanel
          filePath={panel.filePath}
          content={panel.content}
          onContentChange={content => { panel.setContent(content); panel.setDirty(true) }}
          onSave={handleFileSave}
          onClose={panel.closePanel}
          dirty={panel.dirty}
          versions={panel.versions}
          selectedVersion={panel.selectedVersion}
          conflictContent={panel.conflictContent}
          onSelectVersion={panel.selectVersion}
          onResolveConflict={panel.resolveConflict}
          diffMode={panel.diffMode}
          onToggleDiff={panel.toggleDiffMode}
          comments={panel.comments}
          onAddComment={() => {}}
          onEditComment={() => {}}
          onDeleteComment={() => {}}
        />
        </Suspense>
      )}
    </div>
  )
}
