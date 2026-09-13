import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { LiveSessionImage, LiveSessionModelOption, LiveSessionSummary } from '@shared/live-sessions'
import MarkdownRenderer from '../../components/MarkdownRenderer'
import DocumentPreviewModal from '../../components/DocumentPreviewModal'
import ErrorBoundary from '../../components/ErrorBoundary'
import ToolCallBlock from '../../pages/chat/ToolCallBlock'
import { ToolSummaryLine, type ToolSummaryStatus } from '../../components/ToolSummary'
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
import LiveSubagentPanel from './LiveSubagentPanel'
import LiveWorkflowPanel from './LiveWorkflowPanel'
import LiveWorkflowProgressCard, { type WorkflowRecord } from './LiveWorkflowProgressCard'
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

const CHANNEL_LABELS: Record<string, string> = { web: 'web', terminal: '终端', chatapp: '聊天', mobile: '手机' }
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

function CollapsibleMarkdown({ content, onFileOpen, showRaw = true }: { content: string; onFileOpen: (path: string) => void; showRaw?: boolean }) {
  const lines = content.split('\n')
  const previewLines = 12
  const previewChars = 1_600
  const long = lines.length > previewLines || content.length > previewChars
  const [collapsed, setCollapsed] = useState(long)
  const visible = collapsed ? lines.slice(0, previewLines).join('\n').slice(0, previewChars) : content
  return (
    <div>
      <div className={`text-[13px] leading-5 [&_h1]:mb-1 [&_h1]:mt-2 [&_h1]:text-base [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:text-sm [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-sm [&_li]:text-[13px] [&_li]:leading-5 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1 ${collapsed ? 'relative max-h-[220px] overflow-hidden' : ''}`}>
        <MarkdownRenderer content={visible} onFileOpen={onFileOpen} showRaw={showRaw} />
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

export function mergeThinkingParts(parts: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = []
  for (const part of parts) {
    if (part.type !== 'thinking') {
      merged.push(part)
      continue
    }
    const text = typeof part.thinking === 'string' ? part.thinking : ''
    const isEmpty = text.trim().length === 0
    const previous = merged[merged.length - 1]
    if (previous?.type === 'thinking') {
      const previousText = typeof previous.thinking === 'string' ? previous.thinking : ''
      const emptyCount = (typeof previous.emptyThinkingCount === 'number' ? previous.emptyThinkingCount : 0) + (isEmpty ? 1 : 0)
      merged[merged.length - 1] = {
        ...previous,
        thinking: previousText && text ? `${previousText}\n${text}` : previousText + text,
        ...(emptyCount > 0 ? { emptyThinkingCount: emptyCount } : {}),
      }
    } else {
      merged.push({ ...part, thinking: text, ...(isEmpty ? { emptyThinkingCount: 1 } : {}) })
    }
  }
  return merged
}

export function emptyThinkingLabel(count: number): string {
  const normalized = Math.max(1, Math.floor(count))
  const visible = Math.min(6, normalized)
  return `${'🤔'.repeat(visible)}${normalized > visible ? ` ×${normalized}` : ''}`
}

type LiveToolItem = {
  key: string
  index: number
  entry: unknown
  toolName: string
  toolCallId?: string
  argsText?: string
  detail?: string
  resultText?: string
  isError?: boolean
  timestamp?: string
  source: 'call' | 'result'
  batchId?: string
  batch?: boolean
}

type LiveTimelineItem =
  | { type: 'entry'; index: number; entry: unknown }
  | { type: 'toolGroup'; items: LiveToolItem[]; thinking: { index: number; entry: unknown }[] }

function toolCallDetail(part: Record<string, unknown>): string | undefined {
  const args = part.arguments
  if (typeof args === 'string') return compactCommand(args)
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  if (typeof record.path === 'string') return compactCommand(record.path)
  if (typeof record.command === 'string') return compactCommand(record.command)
  if (typeof record.query === 'string') return compactCommand(record.query)
  return undefined
}

function liveToolItems(index: number, entry: unknown): LiveToolItem[] {
  const message = messageFromEntry(entry)
  if (message?.role === 'toolResult') {
    return [{
      key: `result:${message.toolCallId || index}`,
      index,
      entry,
      toolName: message.toolName || 'tool',
      toolCallId: message.toolCallId,
      resultText: message.text,
      isError: message.isError,
      timestamp: entryTimestamp(entry),
      detail: message.text.split('\\n')[0],
      source: 'result',
    }]
  }
  if (message?.role !== 'assistant') return []
  const parts = contentParts(message.content).filter(value => value.type === 'toolCall')
  if (parts.length === 0) return []
  const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined
  const batchId = typeof record?.id === 'string' ? record.id : `entry:${index}`
  const isBatch = parts.length > 1
  return parts.map((part, partIndex) => ({
    key: `call:${typeof part.id === 'string' ? part.id : `${index}:${partIndex}`}`,
    index,
    entry,
    toolName: typeof part.name === 'string' ? part.name : 'tool',
    toolCallId: typeof part.id === 'string' ? part.id : undefined,
    argsText: typeof part.arguments === 'string'
      ? part.arguments
      : part.arguments && typeof part.arguments === 'object'
        ? JSON.stringify(part.arguments, null, 2)
        : undefined,
    detail: toolCallDetail(part),
    timestamp: entryTimestamp(entry),
    source: 'call' as const,
    batchId,
    batch: isBatch,
  }))
}

function thinkingText(entry: unknown): string | undefined {
  const message = messageFromEntry(entry)
  if (message?.role !== 'assistant') return undefined
  const parts = contentParts(message.content)
  if (parts.length === 0 || !parts.every(part => part.type === 'thinking')) return undefined
  return parts.map(part => typeof part.thinking === 'string' ? part.thinking : '').join('\\n')
}

export function groupLiveToolEntries(entries: unknown[]): LiveTimelineItem[] {
  const result: LiveTimelineItem[] = []
  let current: LiveToolItem[] = []
  let currentBatch = false
  let pendingThinking: { index: number; entry: unknown }[] = []

  const addTool = (item: LiveToolItem): void => {
    const existingIndex = item.toolCallId
      ? current.findIndex(existing => existing.toolCallId === item.toolCallId)
      : -1
    if (existingIndex >= 0) {
      const existing = current[existingIndex]
      current[existingIndex] = {
        ...existing,
        ...item,
        key: existing.key,
        argsText: item.argsText || existing.argsText,
        detail: item.detail || existing.detail,
        source: existing.source,
        batchId: existing.batchId,
        batch: existing.batch,
      }
      return
    }
    current.push(item)
  }

  const flush = (): void => {
    if (currentBatch && current.length > 1) {
      result.push({ type: 'toolGroup', items: current, thinking: pendingThinking })
    } else {
      for (const item of current) result.push({ type: 'entry', index: item.index, entry: item.entry })
      for (const thinking of pendingThinking) result.push({ type: 'entry', ...thinking })
    }
    current = []
    currentBatch = false
    pendingThinking = []
  }

  entries.forEach((entry, index) => {
    const tools = liveToolItems(index, entry)
    if (tools.length > 0) {
      const calls = tools.filter(item => item.source === 'call')
      if (calls.length > 0) {
        // A new assistant message starts a new tool boundary. Only multiple
        // calls emitted in that same message are eligible for a tool group.
        if (current.length > 0 || pendingThinking.length > 0) flush()
        current = []
        currentBatch = calls.length > 1 || calls.some(item => item.batch === true)
        for (const item of calls) addTool(item)
      } else if (current.length === 0) {
        current = tools
      } else if (currentBatch || tools.some(item => item.toolCallId && current.some(existing => existing.toolCallId === item.toolCallId))) {
        for (const item of tools) addTool(item)
      } else {
        flush()
        current = tools
      }
      return
    }

    const thinking = thinkingText(entry)
    if (currentBatch && current.length > 0 && thinking !== undefined) {
      if (thinking.trim()) pendingThinking.push({ index, entry })
      return
    }
    if (current.length > 0 || pendingThinking.length > 0) flush()
    if (thinking === undefined || thinking.trim()) result.push({ type: 'entry', index, entry })
  })

  if (current.length > 0 || pendingThinking.length > 0) flush()
  return result
}

function ToolResultCard({ text, toolName, toolCallId, command, isError, timestamp, revealOnMount = false }: { text: string; toolName?: string; toolCallId?: string; command?: string; isError?: boolean; timestamp?: string; revealOnMount?: boolean }) {
  const lines = text.split('\n')
  const [expanded, setExpanded] = useState(revealOnMount)
  const statusTone = isError ? 'border-danger/45 bg-danger-subtle/15' : 'border-ok/35 bg-ok-subtle/10'
  return (
    <article className={`w-full max-w-full overflow-hidden rounded-md border bg-card ${statusTone}`}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="flex w-full min-w-0 items-center gap-2 border-none bg-bg-elevated px-2 py-1.5 text-left hover:bg-bg-hover"
      >
        <ToolSummaryLine toolName={toolName || 'tool'} command={command} timestamp={timestamp} status={isError ? 'error' : 'success'} className="flex-1" />
        <span className="flex shrink-0 items-center gap-2 text-[10px] text-muted">
          <span>{lines.length} 行</span>
          <span className="text-accent">{expanded ? '收起' : '展开'}</span>
        </span>
      </button>
      {expanded && (
        <div className="max-h-[320px] overflow-auto border-t border-border px-2 py-1.5">
          {toolCallId && <div className="mb-1 text-[10px] text-muted">tool call {shortToolId(toolCallId)}</div>}
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-text">{text}</pre>
        </div>
      )}
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

function ToolCallCard({ name, toolCallId, argsText, timestamp, state }: { name: string; toolCallId?: string; argsText: string; timestamp?: string; state?: ToolState }) {
  const result = state?.result
  const status: ToolSummaryStatus = result?.isError ? 'error' : result || state?.ended ? 'success' : state?.started || state?.partialText ? 'running' : 'pending'
  const statusTone = status === 'error'
    ? 'border-danger/45 bg-danger-subtle/15'
    : status === 'success'
      ? 'border-ok/35 bg-ok-subtle/10'
      : status === 'running'
        ? 'border-accent/35 bg-accent-subtle/10'
        : 'border-border'
  return (
    <article className={`w-full max-w-full overflow-hidden rounded-md border bg-bg-elevated ${statusTone}`}>
      <details>
        <summary className="flex min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover">
          <ToolSummaryLine toolName={name} args={argsText} timestamp={result?.timestamp || timestamp} status={status} className="flex-1" />
        </summary>
        <div className="space-y-2 border-t border-border px-3 pb-3">
          {toolCallId && <div className="pt-2 text-[10px] text-muted">tool call {shortToolId(toolCallId)}</div>}
          {argsText && <pre className="m-0 max-h-[12rem] max-w-full overflow-auto whitespace-pre-wrap break-words rounded bg-bg-hover px-2 py-1.5 font-mono text-[10px] leading-4 text-muted">{argsText.slice(0, 100_000)}</pre>}
          {!result && state?.partialText && (
            <pre className="m-0 max-h-[150px] overflow-auto whitespace-pre-wrap break-words rounded bg-bg-hover px-2 py-1.5 font-mono text-[11px] leading-4 text-text">{state.partialText}</pre>
          )}
          {result && <ToolResultCard text={result.text} toolName={result.toolName || name} toolCallId={toolCallId} command={state?.command} isError={result.isError} timestamp={result.timestamp} revealOnMount />}
        </div>
      </details>
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

function MessageContent({ content, onFileOpen, toolStates, timestamp, showRaw = true }: { content: unknown; onFileOpen: (path: string) => void; toolStates?: ToolStateMap; timestamp?: string; showRaw?: boolean }) {
  const parts = mergeThinkingParts(contentParts(content))
  if (parts.length === 0) return null
  return (
    <div className="space-y-1 text-[13px] leading-5 [&_h1]:mb-1 [&_h1]:mt-2 [&_h1]:text-base [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:text-sm [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-sm [&_li]:text-[13px] [&_li]:leading-5 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1">
      {parts.map((part, index) => {
        switch (part.type) {
          case 'thinking': {
            const thinking = typeof part.thinking === 'string' ? part.thinking : ''
            const hasContent = thinking.trim().length > 0
            const emptyCount = typeof part.emptyThinkingCount === 'number' ? part.emptyThinkingCount : 1
            if (!hasContent) {
              return <div key={index} className="px-1 py-0.5 text-sm leading-none" title={`连续收到 ${emptyCount} 个空思考片段`} role="status" aria-label={`连续收到 ${emptyCount} 个空思考片段`}>{emptyThinkingLabel(emptyCount)}</div>
            }
            return (
              <details key={index} className="rounded-md border border-border border-l-[3px] border-l-[#a78bfa] bg-bg-elevated">
                <summary className="px-2 py-1 cursor-pointer text-[11px] text-muted font-mono hover:text-text">思考过程（{thinking.length.toLocaleString()} chars）</summary>
                <pre className="px-2 pb-2 text-[11px] text-muted leading-4 whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto font-body">{thinking}</pre>
              </details>
            )
          }
          case 'text': {
            const text = typeof part.text === 'string' ? part.text : ''
            return text ? <CollapsibleMarkdown key={index} content={text} onFileOpen={onFileOpen} showRaw={showRaw} /> : null
          }
          case 'toolCall': {
            const name = typeof part.name === 'string' ? part.name : 'tool'
            const toolArgs = part.arguments
            let argsText = ''
            if (typeof toolArgs === 'string') argsText = toolArgs
            else if (toolArgs !== undefined && toolArgs !== null) { try { argsText = JSON.stringify(toolArgs, null, 2) } catch { argsText = String(toolArgs) } }
            const toolCallId = typeof part.id === 'string' ? part.id : undefined
            const state = toolCallId ? toolStates?.get(toolCallId) : undefined
            if (name === 'edit' || name === 'write' || name === 'read') {
              return <ToolCallBlock
                key={index}
                content={`🔧 ${name}`}
                meta={{ toolName: name, toolCallId, args: argsText, result: state?.result?.text, isError: state?.result?.isError, timestamp: state?.result?.timestamp || timestamp }}
                onFileOpen={onFileOpen}
              />
            }
            return <ToolCallCard key={index} name={name} toolCallId={toolCallId} argsText={argsText} timestamp={timestamp} state={state} />
          }
          case 'image': {
            const data = typeof part.data === 'string' ? part.data : ''
            const mimeType = typeof part.mimeType === 'string' ? part.mimeType : ''
            return data && mimeType.startsWith('image/')
              ? <img key={index} src={`data:${mimeType};base64,${data}`} alt="用户发送的图片" className="my-1 max-h-[420px] max-w-full rounded-md border border-border object-contain" />
              : <div key={index} className="text-xs text-muted italic">[图片不可预览]</div>
          }
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
      return <ToolResultCard text={message.text} toolName={message.toolName} toolCallId={message.toolCallId} command={message.toolCallId ? toolStates.get(message.toolCallId)?.command : undefined} isError={message.isError} timestamp={timestamp} />
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
            ? <MessageContent content={message.content} onFileOpen={onFileOpen} toolStates={toolStates} timestamp={timestamp} />
            : <MessageContent content={message.content} onFileOpen={onFileOpen} toolStates={toolStates} timestamp={timestamp} showRaw={false} />}
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
    return text ? <ToolResultCard text={text} toolName={typeof data.toolName === 'string' ? data.toolName : 'tool'} toolCallId={toolCallId} command={typeof data.command === 'string' ? data.command : undefined} timestamp={timestamp} /> : null
  }
  if (type.startsWith('tool_execution_')) {
    const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : record
    const toolName = typeof data.toolName === 'string' ? data.toolName : 'tool'
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined
    if (type === 'tool_execution_start' && toolCallId && toolStates.get(toolCallId)?.called) return null
    if (type === 'tool_execution_end') {
      if (toolCallId && toolStates.get(toolCallId)?.result) return null
      const isError = data.isError === true || data.isError === 'true'
      return (
        <details className="w-full rounded-md border border-border bg-bg-elevated">
          <summary className="flex min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover">
            <ToolSummaryLine toolName={toolName} command={typeof data.command === 'string' ? data.command : undefined} timestamp={timestamp} status={isError ? 'error' : 'success'} className="flex-1" />
          </summary>
          {toolCallId && <div className="border-t border-border px-2.5 py-2 text-[10px] text-muted">tool call {shortToolId(toolCallId)}</div>}
        </details>
      )
    }
    const payload = data.input ?? data.args ?? data.command ?? data
    const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined
    const command = typeof data.command === 'string' ? data.command : typeof payloadRecord?.command === 'string' ? payloadRecord.command : undefined
    const text = command ?? (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2))
    const language = command || /^(?:bash|shell)$/i.test(toolName) ? 'bash' : 'json'
    return (
      <details className="w-full rounded-md border border-border bg-bg-elevated">
        <summary className="flex min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover">
          <ToolSummaryLine toolName={toolName} command={command} timestamp={timestamp} status="running" className="flex-1" />
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

function LiveToolGroup({ items, thinking, onFileOpen, toolStates }: { items: LiveToolItem[]; thinking: { index: number; entry: unknown }[]; onFileOpen: (path: string) => void; toolStates: ToolStateMap }) {
  const [expanded, setExpanded] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const done = items.filter(item => item.resultText !== undefined || item.isError).length
  const errors = items.filter(item => item.isError).length
  const names = new Map<string, number>()
  for (const item of items) names.set(item.toolName, (names.get(item.toolName) || 0) + 1)
  const nameSummary = [...names.entries()].map(([name, count]) => count > 1 ? `${name}×${count}` : name).join(', ')
  const progress = errors > 0 ? `${done} done · ${errors} failed` : done === items.length ? `${done} done` : `${done} done · ${items.length - done} running`
  const tone = errors > 0 ? 'border-danger/40 bg-danger-subtle/10' : done === items.length ? 'border-ok/35 bg-ok-subtle/10' : 'border-accent/35 bg-accent-subtle/10'

  return (
    <section className="font-mono">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => { setExpanded(value => !value); setSelectedKey(null) }}
        className={`flex w-full min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px] transition-all hover:border-border-strong ${tone}`}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${errors > 0 ? 'bg-danger' : done === items.length ? 'bg-ok' : 'bg-accent'}`} />
        <span className="shrink-0 font-semibold text-text-strong">Multiple Tools: {progress}</span>
        <span className="shrink-0 text-muted/60">•</span>
        <span className="min-w-0 flex-1 truncate text-muted">{nameSummary}</span>
        <span className="shrink-0 text-muted/50">• 点击展开</span>
      </button>
      {expanded && (
        <div className="mt-1 ml-1 border-l border-border/70 pl-2">
          <div className="space-y-0.5">
            {items.map(item => {
              const active = selectedKey === item.key
              const status: ToolSummaryStatus = item.isError ? 'error' : item.resultText !== undefined ? 'success' : 'running'
              return (
                <div key={item.key}>
                  <button
                    type="button"
                    aria-expanded={active}
                    onClick={() => setSelectedKey(active ? null : item.key)}
                    className={`flex w-full min-w-0 rounded px-1 py-0.5 text-left text-[11px] transition-colors hover:bg-bg-hover ${active ? 'bg-bg-hover' : ''}`}
                  >
                    <ToolSummaryLine toolName={item.toolName} args={item.argsText} command={item.argsText ? undefined : item.detail} timestamp={item.timestamp} status={status} className="flex-1" />
                  </button>
                  {active && (
                    <div className="ml-4 mt-0.5 mb-1">
                      {item.argsText
                        ? <ToolCallBlock content={`🔧 ${item.toolName}`} meta={{ toolName: item.toolName, toolCallId: item.toolCallId, args: item.argsText, result: item.resultText, isError: item.isError, timestamp: item.timestamp }} onFileOpen={onFileOpen} />
                        : item.resultText !== undefined
                          ? <ToolResultCard text={item.resultText} toolName={item.toolName} toolCallId={item.toolCallId} command={item.detail} isError={item.isError} timestamp={item.timestamp} revealOnMount />
                          : <TimelineEntry entry={item.entry} onFileOpen={onFileOpen} toolStates={toolStates} />}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {thinking.length > 0 && (
            <div className="mt-2 space-y-1 border-t border-border/50 pt-1">
              {thinking.map(item => <TimelineEntry key={item.index} entry={item.entry} onFileOpen={onFileOpen} toolStates={toolStates} />)}
            </div>
          )}
        </div>
      )}
    </section>
  )
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
  const sessions = useMemo(() => Object.values(state.sessions), [state.sessions])
  const sessionTitles = useMemo(() => buildSessionTitles(state.sessions, state.details), [state.sessions, state.details])
  const subagentStatuses = useMemo(() => buildSubagentStatuses(state.details), [state.details])
  const activeId = processInstanceId || state.activeId
  const summary = activeId ? state.sessions[activeId] : undefined
  const detail = activeId ? state.details[activeId] : undefined
  const ownedLeaseId = activeId ? state.ownedLeases[activeId] : undefined
  const features = useMemo(() => collectLiveFeatures(detail?.entries || []), [detail?.entries])
  const toolStates = useMemo(() => collectToolStates(detail?.entries || []), [detail?.entries])
  const timelineItems = useMemo(() => groupLiveToolEntries(detail?.entries || []), [detail?.entries])
  const agentState = useMemo(() => deriveAgentState(summary?.status, detail?.entries || [], toolStates), [summary?.status, detail?.entries, toolStates])
  const [busy, setBusy] = useState(false)
  const [commandNotice, setCommandNotice] = useState<string>()
  const [sessionSidebarVisible, setSessionSidebarVisible] = useState(() => typeof window === 'undefined' || localStorage.getItem('live-session-sidebar') !== 'hidden')
  const timelineEnd = useRef<HTMLDivElement>(null)
  const panel = usePanelState()
  const [documentPreview, setDocumentPreview] = useState<{ filePath: string; content: string; loading: boolean; error: string | null } | null>(null)
  const [focusedSubagentId, setFocusedSubagentId] = useState<string>()
  const [focusedWorkflow, setFocusedWorkflow] = useState<WorkflowRecord>()
  const [subagentLoading, setSubagentLoading] = useState(false)
  const [availableModels, setAvailableModels] = useState<LiveSessionModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const focusedSubagent = useMemo(() => sessions.find(session => session.processInstanceId === focusedSubagentId), [focusedSubagentId, sessions])
  const focusedSubagentDetail = focusedSubagentId ? state.details[focusedSubagentId] : undefined
  const workflowItems = useMemo(() => {
    const feature = features['subagent-workflow']
    if (!feature || typeof feature !== 'object' || Array.isArray(feature)) return []
    const workflows = (feature as Record<string, unknown>).workflows
    if (!workflows || typeof workflows !== 'object' || Array.isArray(workflows)) return []
    const items = (workflows as Record<string, unknown>).items
    return Array.isArray(items) ? items.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as WorkflowRecord[] : []
  }, [features])
  const childSessions = useMemo(() => summary ? sessions.filter(session => session.parentSessionId === summary.sessionId) : [], [sessions, summary])
  const parentSession = useMemo(() => summary?.parentSessionId ? sessions.find(session => session.sessionId === summary.parentSessionId) : undefined, [sessions, summary])

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

  const handleDocumentLink = useCallback(async (rawPath: string) => {
    const filePath = resolvePath(rawPath, summary?.canonicalCwd)
    if (detectFileType(filePath) !== 'text') {
      setDocumentPreview(null)
      void handleFileOpen(rawPath)
      return
    }

    setDocumentPreview({ filePath, content: '', loading: true, error: null })
    try {
      const response = await fetch('/api/file-read?path=' + encodeURIComponent(filePath))
      if (!response.ok) throw new Error(`Unable to read file (${response.status})`)
      const content = await response.text()
      setDocumentPreview(current => current?.filePath === filePath
        ? { filePath, content, loading: false, error: null }
        : current)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to read file'
      setDocumentPreview(current => current?.filePath === filePath
        ? { filePath, content: '', loading: false, error: message }
        : current)
    }
  }, [handleFileOpen, summary?.canonicalCwd])

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

  useEffect(() => { timelineEnd.current?.scrollIntoView({ block: 'end' }) }, [detail?.entries.length])

  useEffect(() => {
    if (!focusedSubagentId || state.auth !== 'authenticated') return
    if (focusedSubagentDetail) {
      setSubagentLoading(false)
      return
    }
    let cancelled = false
    setSubagentLoading(true)
    liveSessionApi.detail(focusedSubagentId).then(value => {
      if (!cancelled) dispatch(liveSessionSnapshot(value))
    }).catch(error => {
      if (!cancelled) dispatch(setLiveSessionError(errorMessage(error)))
    }).finally(() => {
      if (!cancelled) setSubagentLoading(false)
    })
    return () => { cancelled = true }
  }, [dispatch, focusedSubagentDetail, focusedSubagentId, state.auth])

  useEffect(() => {
    if (focusedSubagentId && !focusedSubagent) setFocusedSubagentId(undefined)
  }, [focusedSubagent, focusedSubagentId])

  useEffect(() => {
    setFocusedSubagentId(undefined)
    setFocusedWorkflow(undefined)
    setAvailableModels([])
  }, [activeId])

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
    setBusy(true); setCommandNotice(undefined); dispatch(setLiveSessionError(undefined))
    try { await operation() } catch (error) { dispatch(setLiveSessionError(errorMessage(error))); throw error }
    finally { setBusy(false) }
  }

  const release = () => perform(async () => {
    if (!activeId || !ownedLeaseId) return
    await liveSessionApi.release(activeId, ownedLeaseId)
    dispatch(liveSessionReleased(activeId))
  })
  const loadModels = () => perform(async () => {
    if (!activeId) return
    setModelsLoading(true)
    try { setAvailableModels(await liveSessionApi.models(activeId)) }
    finally { setModelsLoading(false) }
  })
  const selectModel = (model: LiveSessionModelOption) => perform(async () => {
    if (!activeId) return
    await liveSessionApi.command(activeId, { type: 'set_model', provider: model.provider, modelId: model.id })
  })
  const compact = () => perform(async () => {
    if (!activeId) return
    const leaseId = await claim()
    await liveSessionApi.command(activeId, { type: 'compact', leaseId })
  })
  const goal = () => perform(async () => {
    if (!activeId) return
    await liveSessionApi.command(activeId, { type: 'input', text: '/goal', channel: 'web' })
  })
  const clearSession = () => perform(async () => {
    if (!activeId) return
    await liveSessionApi.command(activeId, { type: 'input', text: '/clear', channel: 'web' })
    setAvailableModels([])
  })
  const abort = () => perform(async () => {
    if (!activeId) return
    const leaseId = await claim()
    await liveSessionApi.command(activeId, { type: 'abort', leaseId })
  })
  const reload = () => perform(async () => {
    if (!activeId) return
    await liveSessionApi.command(activeId, { type: 'reload' })
  })
  const controlBtw = (type: 'open' | 'close') => perform(async () => {
    if (!activeId) return
    const leaseId = await claim()
    await liveSessionApi.command(activeId, { type: 'feature_command', leaseId, feature: 'btw', command: { type } })
  })

  const submit = (text: string, deliverAs?: 'steer' | 'followUp', images?: LiveSessionImage[]) => perform(async () => {
    if (!activeId) return
    const processInstanceId = activeId
    const trimmed = text.trim()

    // TUI 内置命令在 input 文本流里不会被 dispatch（sendUserMessage 只处理扩展命令/skill/模板），
    // 必须在这里翻译成结构化命令，才能与 TUI 行为一致。
    if (trimmed === '/reload') {
      await liveSessionApi.command(processInstanceId, { type: 'reload' })
      return
    }
    if (trimmed === '/compact') {
      const leaseId = await claim()
      await liveSessionApi.command(processInstanceId, { type: 'compact', leaseId })
      return
    }
    if (trimmed === '/abort') {
      const leaseId = await claim()
      await liveSessionApi.command(processInstanceId, { type: 'abort', leaseId })
      return
    }
    const modelMatch = trimmed.match(/^\/model[ \t]+([^ \t/]+)\/(.+)$/)
    if (modelMatch) {
      await liveSessionApi.command(processInstanceId, { type: 'set_model', provider: modelMatch[1], modelId: modelMatch[2].trim() })
      return
    }
    const nameMatch = trimmed.match(/^\/name[ \t]+(.+)$/)
    if (nameMatch) {
      await liveSessionApi.command(processInstanceId, { type: 'set_session_name', name: nameMatch[1].trim() })
      return
    }

    // 普通消息、扩展命令（/clear /goal /effort）、skill 命令都走 input 文本流
    const localId = `dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`
    dispatch(liveSessionUserMessageAdded({ processInstanceId, localId, text, ...(images?.length ? { images } : {}) }))
    try {
      await liveSessionApi.command(processInstanceId, { type: 'input', text, channel: 'web', ...(images?.length ? { images } : {}), ...(deliverAs ? { deliverAs } : {}) })
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
            {summary?.parentSessionId && <button type="button" onClick={() => parentSession ? navigate(`/live-sessions/${encodeURIComponent(parentSession.processInstanceId)}`) : navigate('/live-sessions/gallery')} className="shrink-0 rounded border border-accent/40 bg-accent-subtle px-2 py-0.5 text-[10px] text-accent hover:border-accent">← 返回主 Agent</button>}
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
        {childSessions.length > 0 && <div className="shrink-0 border-b border-border bg-card/30 px-3 py-2">
          <div className="mb-1 text-[10px] font-medium text-muted">子 Agent · {childSessions.length}</div>
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {childSessions.map(child => {
              const title = sessionTitles[child.processInstanceId] || child.sessionName || `子 Agent · PID ${child.pid}`
              const focused = focusedSubagentId === child.processInstanceId
              return <button key={child.processInstanceId} type="button" onClick={() => setFocusedSubagentId(child.processInstanceId)} className={`min-w-[150px] max-w-[220px] rounded border px-2 py-1.5 text-left transition-colors ${focused ? 'border-accent bg-accent-subtle' : 'border-border bg-card hover:border-accent/60'}`} title={`打开子 Agent：${title}`}>
                <div className="flex items-center gap-1.5"><span className="shrink-0 text-[12px] leading-none" aria-label={`Session 状态：${child.status === 'running' ? '工作中' : child.status === 'reconnecting' ? '重连中' : '等待输入'}`}>{child.status === 'running' ? '🔨' : child.status === 'reconnecting' ? '🔄' : '💤'}</span><span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text-strong">{title}</span><span className="text-[9px] text-muted">{child.status === 'running' ? '工作中' : child.status === 'reconnecting' ? '重连中' : '等待'}</span></div>
                <div className="mt-0.5 truncate font-mono text-[9px] text-muted">sid {child.sessionId.slice(0, 8)}… · PID {child.pid}</div>
              </button>
            })}
          </div>
        </div>}
        {state.error && <div className="px-4 py-2 bg-danger-subtle text-danger text-xs border-b border-danger/20">{state.error}</div>}
        {commandNotice && !state.error && <div className="px-4 py-2 bg-accent-subtle text-accent text-xs border-b border-accent/20">{commandNotice}</div>}
        {!summary || !detail ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted">选择一个正在运行的 Pi session。</div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex flex-1 flex-col overflow-y-auto p-3 space-y-2">
                  {workflowItems.map(workflow => <LiveWorkflowProgressCard key={String(workflow.id)} workflow={workflow} sessions={sessions} onOpen={workflowValue => { setFocusedSubagentId(undefined); setFocusedWorkflow(workflowValue) }} />)}
                  {detail.entries.length === 0 && workflowItems.length === 0 && <div className="text-sm text-muted text-center py-10">该 session 暂无可显示消息。</div>}
                  {timelineItems.map(item => item.type === 'toolGroup'
                    ? <LiveToolGroup key={`tool-group-${item.items[0]?.index ?? 0}`} items={item.items} thinking={item.thinking} onFileOpen={path => { void handleDocumentLink(path) }} toolStates={toolStates} />
                    : <TimelineEntry key={`${item.index}-${typeof item.entry === 'object' && item.entry ? String((item.entry as Record<string, unknown>).type || '') : ''}`} entry={item.entry} onFileOpen={path => { void handleDocumentLink(path) }} toolStates={toolStates} />
                  )}
                  <div ref={timelineEnd} />
                </div>
                <LiveCommandBar toolStates={toolStates} features={features} />
                <LiveSessionComposer
                  status={summary.status}
                  activity={agentState}
                  disabled={busy || summary.status === 'reconnecting'}
                  models={availableModels}
                  currentModel={summary.model}
                  modelsLoading={modelsLoading}
                  onLoadModels={loadModels}
                  onSelectModel={selectModel}
                  onSubmit={submit}
                />
              </div>
              <LiveSessionFeatures
                features={features}
                busy={busy}
                cwd={summary.canonicalCwd}
                status={summary.status}
                onFileOpen={path => { void handleFileOpen(path) }}
                onOpenBtw={() => { void controlBtw('open').catch(() => {}) }}
                onCloseBtw={() => { void controlBtw('close').catch(() => {}) }}
                onOpenWorkflow={workflow => { setFocusedSubagentId(undefined); setFocusedWorkflow(workflow) }}
                onGoal={() => { void goal().catch(() => {}) }}
                onCompact={() => { void compact().catch(() => {}) }}
                onClear={() => { if (window.confirm('开始新的 Pi session？当前对话不会删除，但当前页面会切换到新的空 session。')) void clearSession().catch(() => {}) }}
                onReload={() => { void reload().catch(() => {}) }}
                onAbort={() => { void abort().catch(() => {}) }}
              />
            </div>
          </>
        )}
      </main>
      {panel.isOpen && <>
        <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" aria-hidden="true" />
        <ErrorBoundary
          key={`panel:${panel.filePath}`}
          fallback={<div className="fixed inset-3 z-[60] flex flex-col items-center justify-center gap-3 rounded-xl border border-danger/40 bg-bg p-6 text-center shadow-2xl md:inset-8"><div className="text-sm text-danger">文件渲染失败</div><div className="max-w-full truncate text-xs text-muted" title={panel.filePath}>{panel.filePath}</div><button type="button" onClick={panel.closePanel} className="rounded border border-border px-3 py-1 text-xs text-muted hover:border-accent hover:text-accent">关闭</button></div>}
        >
          <Suspense fallback={<div className="fixed inset-3 z-50 flex items-center justify-center rounded-xl border border-border bg-bg text-sm text-muted md:inset-8">加载文件…</div>}>
          <DocumentPanel
            presentation="modal"
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
        </ErrorBoundary>
      </>}
      {focusedWorkflow && (
        <LiveWorkflowPanel
          workflow={focusedWorkflow}
          sessions={sessions}
          onClose={() => setFocusedWorkflow(undefined)}
          onOpenSubagent={processId => {
            setFocusedWorkflow(undefined)
            setFocusedSubagentId(processId)
          }}
        />
      )}
      {focusedSubagent && (
        <LiveSubagentPanel
          summary={focusedSubagent}
          detail={focusedSubagentDetail}
          loading={subagentLoading}
          onClose={() => setFocusedSubagentId(undefined)}
          onOpenFull={() => navigate(`/live-sessions/${encodeURIComponent(focusedSubagent.processInstanceId)}`)}
        />
      )}
      {documentPreview && (
        <ErrorBoundary key={`preview:${documentPreview.filePath}`}>
          <DocumentPreviewModal
            filePath={documentPreview.filePath}
            content={documentPreview.content}
            loading={documentPreview.loading}
            error={documentPreview.error}
            onClose={() => setDocumentPreview(null)}
          />
        </ErrorBoundary>
      )}
    </div>
  )
}
