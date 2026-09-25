import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { BtwFeatureCommand, LiveSessionImage, LiveSessionModelOption, LiveSessionSummary } from '@shared/live-sessions'
import MarkdownRenderer from '../../components/MarkdownRenderer'
import MaterialIcon from '../../components/MaterialIcon'
import DocumentPreviewModal from '../../components/DocumentPreviewModal'
import ReviewCommentsDialog from '../../components/ReviewCommentsDialog'
import ExtensionUiModal from '../../components/ExtensionUiModal'
import ErrorBoundary from '../../components/ErrorBoundary'
import ToolCallBlock from '../../pages/chat/ToolCallBlock'
import { ToolSummaryLine, type ToolSummaryStatus } from '../../components/ToolSummary'
import WorkingHammerIcon from '../../components/WorkingHammerIcon'
import { detectFileType, usePanelState, type Comment } from '../../hooks/usePanelState'
import { useDocumentComments } from '../../hooks/useDocumentComments'
import { loadFileComments, saveFileComments } from '../../api/fileComments'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useAppDispatch, useAppSelector } from '../../store'
import { resolvePath } from '../../utils/resolvePath'
import {
  authenticated,
  liveSessionOwned,
  liveSessionReleased,
  liveSessionSnapshot,
  liveSessionUserMessageAdded,
  liveSessionUserMessageAcknowledged,
  liveSessionUserMessageRemoved,
  selectLiveSession,
  setLiveSessionError,
  dismissSessionNotifications,
} from '../../store/liveSessionsSlice'
import { liveSessionApi, LiveSessionApiError } from './api'
import LiveSessionComposer from './LiveSessionComposer'
import FullContentModal from '../../components/FullContentModal'
import { SelectionQuoteMenu, QuoteCommentPopover } from '../../components/SelectionQuoteMenu'
import { useChatQuoteSelection, type SelectionTarget } from '../../hooks/useChatQuoteSelection'
import { commentReviewItems, selectionLabel, type QuotedText, type ReviewItem } from '../../utils/reviewComments'

/** One review round: what the comments point at and how to clear them after sending. */
interface ReviewRequest {
  kind: 'panel' | 'preview' | 'chat'
  label: string
  items: ReviewItem[]
  intro?: string
}

/** Opening line used when the comments target the conversation itself. */
const CHAT_REVIEW_INTRO = 'Please review and address these comments about the quoted parts of our conversation:'
import { watchCompaction } from './compactionWatch'
import LiveSessionFeatures from './LiveSessionFeatures'
import LiveSubagentPanel from './LiveSubagentPanel'
import LiveWorkflowPanel from './LiveWorkflowPanel'
import LiveWorkflowProgressCard, { type WorkflowRecord } from './LiveWorkflowProgressCard'
import { loadTtsSettings, saveTtsSettings, subscribeTtsSettings, type TtsSettings } from '../voice/ttsSettings'
import { useVoiceOutput } from '../voice/useVoiceOutput'
import { INITIAL_TURN_SPEECH_GATE, advanceTurnSpeech, takePendingSpeech, type TurnSpeechGate } from '../voice/turnSpeech'
import { buildSessionTitles, buildSubagentStatuses } from './sessionTitle'
import { displayWorktreePath } from '../../utils/displayPath'
import { copyText } from '../../utils/clipboard'
import LiveSessionsList from './LiveSessionsList'
import { PendingDeliveryBar, pendingDeliveries, pendingDeliveryLabel, pendingDeliveryOf, pendingDeliveryTitle, queuedDeliveryFor } from './pendingDelivery'
import { forkLiveSessionAtStep } from './forkPlacement'
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

/**
 * Session-entry id behind a transcript entry, when it is known.
 *
 * Snapshot entries are projected from the session file and carry the entry id as
 * `id`; live `message_end` events get theirs folded in from the bridge's
 * follow-up `message_entry` (see `liveSessionsSlice.appendEvent`). Tool calls,
 * thinking and telemetry have no entry id and therefore offer no per-step action.
 */
function entryIdOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  if (record.type === 'message' && typeof record.id === 'string') return record.id
  if (record.type !== 'message_end') return undefined
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data as Record<string, unknown> : undefined
  return typeof data?.entryId === 'string' ? data.entryId : undefined
}

/** Last assistant reply text in the transcript, or '' when there is none. */
export function lastAssistantSpeechText(entries: unknown[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = messageFromEntry(entries[index])
    if (message?.role === 'assistant' && message.text) return message.text
  }
  return ''
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

/** Collapsed reasoning card: one tinted row that unfolds the raw trace. */
function LiveThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="overflow-hidden rounded-md border-l-2 border-l-aim bg-bg-hover">
      <button
        type="button"
        aria-expanded={open}
        title={open ? '收起思考过程' : '展开思考过程'}
        onClick={() => setOpen(value => !value)}
        className="group/think flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left text-2xs text-muted transition-colors hover:text-text"
      >
        <MaterialIcon name="expand_more" className={`h-3.5 w-3.5 shrink-0 text-aim transition-transform ${open ? 'rotate-180' : ''}`} />
        <span className="shrink-0 font-semibold text-text-strong">思考过程</span>
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 font-mono text-2xs text-muted">{text.length.toLocaleString()} chars</span>
      </button>
      {open && <pre className="m-0 max-h-[340px] overflow-y-auto whitespace-pre-wrap break-words px-2.5 pb-2.5 font-body text-2xs leading-5 text-muted">{text}</pre>}
    </div>
  )
}

export function CollapsibleMarkdown({ content, onFileOpen, showRaw = true, onReadStart }: { content: string; onFileOpen: (path: string) => void; showRaw?: boolean; onReadStart?: () => void }) {
  const lines = content.split('\n')
  const previewLines = 12
  const previewChars = 1_600
  const long = lines.length > previewLines || content.length > previewChars
  // `reading` = the pop-out window, `expanded` = unfolded in place. Both are kept
  // here so the reader can pick either, and both pause the timeline's follow-the-tail
  // behaviour (see onReadStart) so new content cannot yank the page away mid-read.
  const [reading, setReading] = useState<{ role?: string } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)
  const anchorYRef = useRef<number | null>(null)
  const visible = long && !expanded ? lines.slice(0, previewLines).join('\n').slice(0, previewChars) : content

  /**
   * Unfolding inserts lines ABOVE these buttons, which used to push the answer the
   * reader was looking at off the screen. Keep the buttons at the same viewport
   * position instead: the new lines then appear exactly where the reader stopped.
   */
  useLayoutEffect(() => {
    const anchor = anchorYRef.current
    anchorYRef.current = null
    if (anchor === null) return
    const node = actionsRef.current
    const container = node?.closest<HTMLElement>('[data-timeline-scroll]')
    if (!node || !container) return
    const delta = node.getBoundingClientRect().top - anchor
    if (delta !== 0) container.scrollTop += delta
  }, [expanded])

  const toggleExpanded = (): void => {
    anchorYRef.current = actionsRef.current?.getBoundingClientRect().top ?? null
    setExpanded(value => !value)
    onReadStart?.()
  }

  const openWindow = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const role = event.currentTarget.closest('[data-msg-anchor]')?.getAttribute('data-msg-role') ?? undefined
    setReading(role ? { role } : {})
    onReadStart?.()
  }

  return (
    <div>
      <div className={`text-body-s leading-5 [&_h1]:mb-1 [&_h1]:mt-2 [&_h1]:text-base [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:text-sm [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-sm [&_li]:text-body-s [&_li]:leading-5 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1 ${long && !expanded ? 'relative max-h-[220px] overflow-hidden' : ''}`}>
        <MarkdownRenderer content={visible} onFileOpen={onFileOpen} showRaw={showRaw} />
        {long && !expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" />}
      </div>
      {long && (
        <div ref={actionsRef} className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={toggleExpanded}
            title={expanded ? '把长回答收回预览' : '在对话里就地展开（不跳页，继续往下读）'}
            className="cursor-pointer border-none bg-transparent text-xs text-accent hover:underline"
          >
            {expanded ? '收起' : `展开全部（${lines.length} 行）`}
          </button>
          <button
            type="button"
            onClick={openWindow}
            title="在独立窗口里读（可选中文字引用 / 批注给 Agent）"
            className="cursor-pointer border-none bg-transparent text-xs text-muted hover:text-accent hover:underline"
          >
            弹窗阅读
          </button>
        </div>
      )}
      {reading && <FullContentModal content={content} meta={`${lines.length} 行`} onFileOpen={onFileOpen} showRaw={showRaw} anchorRole={reading.role} onClose={() => setReading(null)} />}
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

/**
 * Compact-reading filter: drop the entries that carry no readable body text.
 * Used when the transcript hides thinking + tool/script output.
 */
function hasReadableBody(entry: unknown): boolean {
  const message = messageFromEntry(entry)
  if (!message) return true
  if (message.role === 'toolResult') return false
  const parts = contentParts(message.content)
  return parts.some(part =>
    (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0)
    || part.type === 'image',
  )
}

/**
 * Rebuild a tool-free copy of an assistant message.
 *
 * A message that emits several tool calls is folded into one tool group, and the
 * group renders only the tool rows — so the prose and thinking the model emitted
 * alongside those calls would vanish from the transcript. Keeping a body-only
 * copy lets "显示全部" render that text as its own entry.
 */
function assistantBodyEntry(entry: unknown): unknown | undefined {
  const message = messageFromEntry(entry)
  if (message?.role !== 'assistant') return undefined
  const body = contentParts(message.content).filter(part => part.type !== 'toolCall')
  if (body.length === 0) return undefined
  const record = entry as Record<string, unknown>
  const nested = record.message && typeof record.message === 'object' && !Array.isArray(record.message)
    ? record.message as Record<string, unknown> : undefined
  if (nested) return { ...record, message: { ...nested, content: body } }
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data as Record<string, unknown> : undefined
  const nestedMessage = data?.message && typeof data.message === 'object' && !Array.isArray(data.message)
    ? data.message as Record<string, unknown> : undefined
  if (nestedMessage) return { ...record, data: { ...data, message: { ...nestedMessage, content: body } } }
  return undefined
}

export interface LiveTimelineHidden {
  /** Tool call/result rows folded away. */
  tools: number
  /** Thinking entries folded away. */
  thinking: number
  /** Extension telemetry rows (`custom` entries, mostly thinking-duration ticks). */
  other: number
}

/**
 * Group live entries into timeline items.
 *
 * @param auxiliary when false, thinking and tool/script execution are left out
 *                  entirely (they are not even rendered as collapsed one-liners),
 *                  so the reader sees the agent's reply body plus user turns.
 *                  Entries that would render nothing are dropped, not blanked.
 */
export function groupLiveToolEntries(
  entries: unknown[],
  auxiliary = true,
): { items: LiveTimelineItem[]; hidden: LiveTimelineHidden } {
  const hidden: LiveTimelineHidden = { tools: 0, thinking: 0, other: 0 }
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
    // Compact reading: nothing auxiliary is rendered — not even a collapsed
    // one-liner — so the reader sees the reply body and the user turns.
    if (!auxiliary) {
      const message = messageFromEntry(entry)
      const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined
      // Extension telemetry (`custom` entries) is pure noise while reading: e.g. one
      // real session had 434 `compact-thinking-duration` rows against 1008 messages.
      if (record?.type === 'custom') {
        hidden.other += 1
        return
      }
      const parts = contentParts(message?.content)
      const thinkingParts = parts.filter(part => part.type === 'thinking').length
      const toolParts = parts.filter(part => part.type === 'toolCall').length
      hidden.thinking += thinkingParts > 0 ? thinkingParts : (thinkingText(entry) !== undefined ? 1 : 0)
      hidden.tools += toolParts > 0
        ? toolParts
        : (message?.role === 'toolResult' ? 1 : liveToolItems(index, entry).length)
      // Entries that would render nothing are dropped rather than blanked.
      if (message?.role === 'toolResult' || !hasReadableBody(entry)) return
      if (current.length > 0 || pendingThinking.length > 0) flush()
      result.push({ type: 'entry', index, entry })
      return
    }

    const tools = liveToolItems(index, entry)
    if (tools.length > 0) {
      const calls = tools.filter(item => item.source === 'call')
      if (calls.length > 0) {
        // A new assistant message starts a new tool boundary. Only multiple
        // calls emitted in that same message are eligible for a tool group.
        if (current.length > 0 || pendingThinking.length > 0) flush()
        current = []
        currentBatch = calls.length > 1 || calls.some(item => item.batch === true)
        // A tool group renders tool rows only, so a batched assistant message
        // would lose the reply text it emitted with the calls — re-emit that
        // body (thinking + text, tool calls stripped) as its own entry.
        if (currentBatch) {
          const body = assistantBodyEntry(entry)
          if (body) result.push({ type: 'entry', index, entry: body })
        }
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
  return { items: result, hidden }
}

function ToolResultCard({ text, toolName, toolCallId, command, isError, timestamp, revealOnMount = false }: { text: string; toolName?: string; toolCallId?: string; command?: string; isError?: boolean; timestamp?: string; revealOnMount?: boolean }) {
  const lines = text.split('\n')
  const [expanded, setExpanded] = useState(revealOnMount)
  const statusTone = isError ? 'border-danger bg-danger-subtle' : 'border-ok bg-ok-subtle'
  return (
    <article className={`w-full max-w-full overflow-hidden rounded-md border bg-card ${statusTone}`}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="flex w-full min-w-0 items-center gap-2 border-none bg-bg-elevated px-2 py-1.5 text-left hover:bg-bg-hover"
      >
        <ToolSummaryLine toolName={toolName || 'tool'} command={command} timestamp={timestamp} status={isError ? 'error' : 'success'} className="flex-1" />
        <span className="flex shrink-0 items-center gap-2 text-2xs text-muted">
          <span>{lines.length} 行</span>
          <span className="text-accent">{expanded ? '收起' : '展开'}</span>
        </span>
      </button>
      {expanded && (
        <div className="max-h-[320px] overflow-auto border-t border-border px-2 py-1.5">
          {toolCallId && <div className="mb-1 text-2xs text-muted">tool call {shortToolId(toolCallId)}</div>}
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-2xs leading-4 text-text">{text}</pre>
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

/**
 * Project directory chip: the header shows a shortened label, and a click opens the
 * full path (with copy) instead of letting a long path eat the whole row.
 */
function CwdChip({ path }: { path: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  useEffect(() => { if (!open) setCopied(false) }, [open])
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    // Capture phase + stopPropagation, like the dialogs in this repo: Escape
    // closes this popover instead of reaching the global “关闭 / 停止” shortcut.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])
  return <span ref={rootRef} className="relative shrink-0">
    <button
      type="button"
      onClick={() => setOpen(value => !value)}
      aria-expanded={open}
      title={`项目目录：${path}（点击查看完整路径）`}
      className={`flex max-w-[14rem] items-center gap-1 rounded border px-2 py-0.5 text-2xs ${open ? 'border-accent bg-accent-subtle text-accent' : 'border-border bg-bg text-muted hover:border-accent hover:text-accent'}`}
    >
      <span className="truncate font-mono">{displayWorktreePath(path)}</span>
    </button>
    {open && <div className="absolute left-0 top-full z-[60] mt-1 w-max max-w-[min(80vw,44rem)] rounded-lg border border-border bg-card p-2 shadow-xl">
      <div className="mb-1 text-2xs font-semibold text-muted">项目目录</div>
      <div className="mb-2 whitespace-normal break-all font-mono text-2xs text-text-strong">{path}</div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => { void copyText(path).then(ok => setCopied(ok)) }} className="rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted hover:border-accent hover:text-accent">{copied ? '已复制' : '复制路径'}</button>
        <button type="button" onClick={() => setOpen(false)} className="rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted hover:border-accent hover:text-accent">关闭</button>
      </div>
    </div>}
  </span>
}

function TuiLikeStatus({ summary }: { summary: LiveSessionSummary }) {
  const usage = summary.contextUsage
  const percent = usage?.percent !== null && usage?.percent !== undefined && Number.isFinite(usage.percent) ? Math.max(0, Math.min(100, usage.percent)) : undefined
  const filled = percent === undefined ? 0 : Math.round(percent / 100 * 12)
  const bar = `${'█'.repeat(filled)}${'░'.repeat(12 - filled)}│`
  return <span className="flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-2xs text-muted" title="上下文占用和 session 运行时间">
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
    ? 'border-danger bg-danger-subtle'
    : status === 'success'
      ? 'border-ok bg-ok-subtle'
      : status === 'running'
        ? 'border-accent bg-accent-subtle'
        : 'border-border'
  return (
    <article className={`w-full max-w-full overflow-hidden rounded-md border bg-bg-elevated ${statusTone}`}>
      <details>
        <summary className="flex min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover">
          <ToolSummaryLine toolName={name} args={argsText} timestamp={result?.timestamp || timestamp} status={status} className="flex-1" />
        </summary>
        <div className="space-y-2 border-t border-border px-3 pb-3">
          {toolCallId && <div className="pt-2 text-2xs text-muted">tool call {shortToolId(toolCallId)}</div>}
          {argsText && <pre className="m-0 max-h-[12rem] max-w-full overflow-auto whitespace-pre-wrap break-words rounded bg-bg-hover px-2 py-1.5 font-mono text-2xs leading-4 text-muted">{argsText.slice(0, 100_000)}</pre>}
          {!result && state?.partialText && (
            <pre className="m-0 max-h-[150px] overflow-auto whitespace-pre-wrap break-words rounded bg-bg-hover px-2 py-1.5 font-mono text-2xs leading-4 text-text">{state.partialText}</pre>
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
  toolCallId?: string
}

function compactCommand(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 72)
}

function LiveCommandBar({ toolStates, features, onMoveToBackground }: { toolStates: ToolStateMap; features: Record<string, unknown>; onMoveToBackground?: (toolCallId: string) => void }) {
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
        toolCallId: state.toolCallId,
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
        <span className="shrink-0 text-2xs font-medium text-accent">运行中</span>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {commands.map(command => {
            const handoffToolCallId = command.kind === 'foreground' && onMoveToBackground ? command.toolCallId : undefined
            return <div key={command.key} className="flex max-w-[min(360px,64vw)] shrink-0 items-center rounded border border-border bg-card hover:border-accent">
              <button type="button" aria-expanded={selected?.key === command.key} onClick={() => setSelectedKey(command.key)} className="min-w-0 flex-1 truncate px-2 py-1 text-left text-2xs text-muted hover:text-accent" title={`${command.detail}\n${command.command}`}>
                <span className="mr-1 text-accent">●</span>{command.kind === 'background' ? '后台' : '前台'} · {command.label}
              </button>
              {handoffToolCallId && <button type="button" onClick={() => onMoveToBackground?.(handoffToolCallId)} className="mr-1 shrink-0 rounded border border-border px-1.5 py-0.5 text-2xs text-accent hover:border-accent hover:bg-accent-subtle" title="转后台：进程不重启，agent 立即继续，命令继续在后台运行" aria-label={`把「${command.label}」转入后台`}>转后台</button>}
            </div>
          })}
        </div>
      </div>
    </div>
    {selected && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 p-4" role="presentation" onClick={() => setSelectedKey(undefined)}>
      <section className="w-full max-w-4xl overflow-hidden rounded-lg border border-border bg-card shadow-2xl" role="dialog" aria-modal="true" aria-label={`${selected.kind === 'background' ? '后台' : '前台'}命令输出`} onClick={event => event.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-border bg-bg-elevated px-3 py-2">
          <div className="min-w-0 flex-1"><div className="text-xs font-semibold text-text-strong">{selected.kind === 'background' ? '后台命令' : '前台命令'} · {selected.detail}</div><div className="mt-0.5 truncate font-mono text-2xs text-muted" title={selected.command}>{selected.command}</div></div>
          <button type="button" onClick={() => setSelectedKey(undefined)} className="shrink-0 rounded border border-border bg-bg px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent">关闭</button>
        </header>
        <pre className="m-0 max-h-[65vh] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-text">{selected.output}</pre>
      </section>
    </div>}
  </>
}

/**
 * React keys for message parts.
 *
 * They used to be the part's index, so a streaming update that re-orders parts —
 * or the 精简阅读 toggle, which filters parts out — remounted every collapsible
 * below it and silently collapsed whatever the reader had unfolded. Deriving the
 * key from the part's own content keeps the state on the same part, and an
 * occurrence counter keeps duplicates unique.
 */
export function stablePartKeys(parts: Array<Record<string, unknown>>): string[] {
  const seen = new Map<string, number>()
  return parts.map(part => {
    const type = typeof part.type === 'string' ? part.type : 'part'
    const seed = type === 'text' ? String(part.text ?? '') : type === 'thinking' ? String(part.thinking ?? '') : type
    const base = `${type}:${seed.slice(0, 32)}`
    const occurrence = seen.get(base) ?? 0
    seen.set(base, occurrence + 1)
    return `${base}#${occurrence}`
  })
}

function MessageContent({ content, onFileOpen, toolStates, timestamp, auxiliary = true, showRaw = true, onReadStart }: { content: unknown; onFileOpen: (path: string) => void; toolStates?: ToolStateMap; timestamp?: string; auxiliary?: boolean; showRaw?: boolean; onReadStart?: () => void }) {
  const allParts = mergeThinkingParts(contentParts(content))
  // Compact reading hides thinking and tool/script output even inside a message
  // that also carries the reply text.
  const parts = auxiliary ? allParts : allParts.filter(part => part.type !== 'thinking' && part.type !== 'toolCall')
  const partKeys = stablePartKeys(parts)
  if (parts.length === 0) return null
  return (
    <div className="space-y-1 text-body-s leading-5 [&_h1]:mb-1 [&_h1]:mt-2 [&_h1]:text-base [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:text-sm [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-sm [&_li]:text-body-s [&_li]:leading-5 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1">
      {parts.map((part, index) => {
        switch (part.type) {
          case 'thinking': {
            const thinking = typeof part.thinking === 'string' ? part.thinking : ''
            const hasContent = thinking.trim().length > 0
            const emptyCount = typeof part.emptyThinkingCount === 'number' ? part.emptyThinkingCount : 1
            if (!hasContent) {
              return <div key={partKeys[index]} className="inline-flex w-fit items-center rounded-full bg-aim-subtle px-2 py-0.5 text-meta leading-none text-muted" title={`连续收到 ${emptyCount} 个空思考片段`} role="status" aria-label={`连续收到 ${emptyCount} 个空思考片段`}>{emptyThinkingLabel(emptyCount)}</div>
            }
            return <LiveThinkingBlock key={partKeys[index]} text={thinking} />
          }
          case 'text': {
            const text = typeof part.text === 'string' ? part.text : ''
            return text ? <CollapsibleMarkdown key={partKeys[index]} content={text} onFileOpen={onFileOpen} showRaw={showRaw} onReadStart={onReadStart} /> : null
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

const TimelineEntry = memo(function TimelineEntry({ entry, onFileOpen, toolStates, auxiliary = true, onForkAt, forkingEntryId, onReadStart }: { entry: unknown; onFileOpen: (path: string) => void; toolStates: ToolStateMap; auxiliary?: boolean; onForkAt?: (entryId: string) => void; forkingEntryId?: string; onReadStart?: () => void }) {
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
    const forkEntryId = user || assistant ? entryIdOf(entry) : undefined
    // A prompt this browser just sent may still be sitting in Pi's queue; until Pi
    // echoes it back, say so instead of looking like a handled message.
    const pending = user ? pendingDeliveryOf(entry) : undefined
    return (
      // Assistant prose carries no box: the transcript stays calm and the only
      // filled surface is the user's own bubble; tool/thinking parts keep their cards.
      <article
        data-msg-anchor=""
        data-msg-role={message.role}
        className={`group/msg ${user
        ? 'ml-4 w-fit max-w-[min(560px,85%)] self-end rounded-xl bg-accent-subtle px-3 py-2 shadow-sm md:ml-10'
        : assistant
          ? 'w-full max-w-[90%]'
          : 'w-fit max-w-[90%] rounded-lg bg-bg-elevated px-2.5 py-2'}`}>
        <div className={`mb-1 flex items-center gap-2 text-2xs uppercase tracking-wide text-muted-strong ${user ? 'justify-end' : ''}`}>
          <span className="min-w-0 truncate">
            {message.role}
            {message.channel && <span className="ml-2 normal-case text-accent">来自 {channelLabel(message.channel)}</span>}
            {pending && <span className="ml-2 normal-case text-warn" title={pendingDeliveryTitle(pending)}>{pendingDeliveryLabel(pending)}</span>}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {forkEntryId && onForkAt && (
              <button
                type="button"
                disabled={!!forkingEntryId}
                onClick={() => onForkAt(forkEntryId)}
                title="从这一步分叉出一个新的独立会话（原会话继续运行，新会话继承任务分组并排在旁边）"
                className="cursor-pointer rounded-full px-1.5 py-px normal-case text-2xs text-muted opacity-60 transition-opacity hover:bg-bg-hover hover:text-accent focus-visible:opacity-100 disabled:opacity-50 md:opacity-0 md:group-hover/msg:opacity-100"
              >{forkingEntryId === forkEntryId ? '分叉中…' : '⑂ 从此分叉'}</button>
            )}
            <time className="shrink-0 font-mono normal-case text-2xs font-normal text-muted-strong">{timestamp || '—'}</time>
          </span>
        </div>
        {assistant
          ? <MessageContent content={message.content} onFileOpen={onFileOpen} toolStates={toolStates} timestamp={timestamp} auxiliary={auxiliary} onReadStart={onReadStart} />
          : <MessageContent content={message.content} onFileOpen={onFileOpen} toolStates={toolStates} timestamp={timestamp} auxiliary={auxiliary} showRaw={false} onReadStart={onReadStart} />}
      </article>
    )
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const record = entry as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : 'event'
  if (type === 'message_start' || type === 'live_feature_snapshot' || type === 'agent_start' || type === 'agent_end' || type === 'agent_settled' || type === 'turn_start' || type === 'turn_end' || type === 'claim_changed') return null
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
          {toolCallId && <div className="border-t border-border px-2.5 py-2 text-2xs text-muted">tool call {shortToolId(toolCallId)}</div>}
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
  return <div className="text-2xs text-muted border-l-2 border-border pl-3 py-1">{type.split('_').join(' ')}</div>
})

const LiveToolGroup = memo(function LiveToolGroup({ items, thinking, onFileOpen, toolStates, onReadStart }: { items: LiveToolItem[]; thinking: { index: number; entry: unknown }[]; onFileOpen: (path: string) => void; toolStates: ToolStateMap; onReadStart?: () => void }) {
  const done = items.filter(item => item.resultText !== undefined || item.isError).length
  const errors = items.filter(item => item.isError).length
  const running = done < items.length
  // Open work in flight automatically: a running command is the thing the user
  // came to watch, and it used to hide behind three nested clicks.
  const [expanded, setExpanded] = useState(() => items.length === 1 || running)
  const names = new Map<string, number>()
  for (const item of items) names.set(item.toolName, (names.get(item.toolName) || 0) + 1)
  const nameSummary = [...names.entries()].map(([name, count]) => count > 1 ? `${name}×${count}` : name).join(', ')
  const progress = errors > 0 ? `${done} 完成 · ${errors} 失败` : done === items.length ? `${done} 完成` : `${done} 完成 · ${items.length - done} 运行中`
  const tone = errors > 0 ? 'bg-danger-subtle' : 'bg-bg-hover'
  const bar = errors > 0 ? 'border-l-danger' : done === items.length ? 'border-l-ok' : 'border-l-accent'
  const dot = errors > 0
    ? 'bg-danger shadow-[0_0_0_3px_var(--danger-subtle)]'
    : done === items.length
      ? 'bg-ok shadow-[0_0_0_3px_var(--ok-subtle)]'
      : 'bg-accent shadow-[0_0_0_3px_var(--accent-subtle)]'
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  return (
    <section className="font-mono">
      <button
        type="button"
        aria-expanded={expanded}
        title={expanded ? '收起工具明细' : '展开工具明细'}
        onClick={() => { setExpanded(value => !value); setSelectedKey(null) }}
        className={`group/tools flex w-full min-w-0 items-center gap-2 rounded-md border-l-2 px-2.5 py-1.5 text-left text-2xs transition-colors ${bar} ${tone}`}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}${running ? ' animate-pulse' : ''}`} />
        <span className="shrink-0 font-semibold text-text-strong">工具组：{progress}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{nameSummary}</span>
        <MaterialIcon name="expand_more" className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform group-hover/tools:text-text ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="ml-2 mt-1.5 border-l border-border/70 pl-2 animate-fade-in">
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
                    className={`flex w-full min-w-0 rounded-md px-1.5 py-1 text-left text-2xs transition-colors hover:bg-bg-hover ${active ? 'bg-bg-hover' : ''}`}
                  >
                    <ToolSummaryLine toolName={item.toolName} args={item.argsText} command={item.argsText ? undefined : item.detail} timestamp={item.timestamp} status={status} className="flex-1" />
                  </button>
                  {active && (
                    <div className="mb-1.5 ml-3.5 mt-1">
                      {item.argsText
                        ? <ToolCallBlock content={`🔧 ${item.toolName}`} meta={{ toolName: item.toolName, toolCallId: item.toolCallId, args: item.argsText, result: item.resultText, isError: item.isError, timestamp: item.timestamp }} onFileOpen={onFileOpen} defaultExpanded />
                        : item.resultText !== undefined
                          ? <ToolResultCard text={item.resultText} toolName={item.toolName} toolCallId={item.toolCallId} command={item.detail} isError={item.isError} timestamp={item.timestamp} revealOnMount />
                          : <TimelineEntry entry={item.entry} onFileOpen={onFileOpen} toolStates={toolStates} onReadStart={onReadStart} />}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {thinking.length > 0 && (
            <div className="mt-2 space-y-1 border-t border-border pt-1">
              {thinking.map(item => <TimelineEntry key={item.index} entry={item.entry} onFileOpen={onFileOpen} toolStates={toolStates} onReadStart={onReadStart} />)}
            </div>
          )}
        </div>
      )}
    </section>
  )
})

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
        <button type="button" disabled={!token.trim() || busy} onClick={() => void submit()} className="mt-4 w-full rounded-lg bg-accent text-accent-fg py-2 border-none disabled:opacity-50">{busy ? '验证中…' : '验证'}</button>
      </div>
    </div>
  )
}

export default function LiveSessionPage() {
  const { processInstanceId } = useParams<{ processInstanceId?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  // Set by the session-graph page (`?node=<entryId>`) so the graph → session
  // jump can be finished here with the same `/ls-navigate` bridge command.
  const graphNodeId = searchParams.get('node')
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { refresh } = useLiveSessionsRuntime()
  const state = useAppSelector(root => root.liveSessions)
  const sessions = useMemo(() => Object.values(state.sessions), [state.sessions])
  // Sessions whose agent is blocked on an unanswered extension dialog.
  const pendingUiCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const [id, bucket] of Object.entries(state.pendingUi)) {
      const size = Object.keys(bucket ?? {}).length
      if (size > 0) counts[id] = size
    }
    return counts
  }, [state.pendingUi])
  const sessionTitles = useMemo(() => buildSessionTitles(state.sessions, state.details), [state.sessions, state.details])
  const subagentStatuses = useMemo(() => buildSubagentStatuses(state.details), [state.details])
  const activeId = processInstanceId || state.activeId
  const summary = activeId ? state.sessions[activeId] : undefined
  const detail = activeId ? state.details[activeId] : undefined
  const ownedLeaseId = activeId ? state.ownedLeases[activeId] : undefined
  // The graph page's write actions ride the `/ls-navigate` extension command.
  // An old bridge does not register it, and pi would then submit the text as a
  // normal prompt, so only offer the action when the bridge advertises support.
  const treeCapable = activeId ? state.sessions[activeId]?.capabilities?.includes('session_tree') === true : false
  const notifications = activeId ? state.notifications[activeId] ?? [] : []
  const features = useMemo(() => collectLiveFeatures(detail?.entries || []), [detail?.entries])
  const toolStates = useMemo(() => collectToolStates(detail?.entries || []), [detail?.entries])
  const compactViewport = useMediaQuery('(max-width: 767px)')
  /**
   * Show thinking + tool/script execution in the transcript. Defaults to OFF on a
   * phone (the reply body is what matters there) and ON elsewhere; an explicit
   * toggle is remembered in localStorage.
   */
  const [auxiliary, setAuxiliary] = useState<boolean>(() => {
    const stored = localStorage.getItem('live-session-auxiliary')
    if (stored === 'show') return true
    if (stored === 'hide') return false
    return !compactViewport
  })
  const toggleAuxiliary = useCallback(() => {
    setAuxiliary(value => {
      const next = !value
      localStorage.setItem('live-session-auxiliary', next ? 'show' : 'hide')
      return next
    })
  }, [])

  const timeline = useMemo(() => groupLiveToolEntries(detail?.entries || [], auxiliary), [detail?.entries, auxiliary])
  /** Prompts this browser sent that Pi has not picked up yet (追加/插话 while a turn runs). */
  const pendingMessages = useMemo(() => pendingDeliveries(detail?.entries || []), [detail?.entries])
  const timelineItems = timeline.items
  const agentState = useMemo(() => deriveAgentState(summary?.status, detail?.entries || [], toolStates), [summary?.status, detail?.entries, toolStates])
  const [busy, setBusy] = useState(false)
  const [commandNotice, setCommandNotice] = useState<string>()
  /** True while 「清空」 waits for the confirming second click (see handleClear). */
  const [clearArmed, setClearArmed] = useState(false)
  /** True from the moment /compact is accepted until its entry lands on disk. */
  const [compacting, setCompacting] = useState(false)
  const compactionAbort = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => compactionAbort.current?.abort(), [])
  /** entryId of the bubble whose 「从此分叉」 request is in flight. */
  const [forkingEntryId, setForkingEntryId] = useState<string>()
  const [forkNotice, setForkNotice] = useState<string>()

  /**
   * Fork from one transcript step: extract the root→entry branch into a new
   * session file, start a Pi on it, land it beside its parent, and follow it.
   * Mirrors the graph's per-node fork but keeps the source session running.
   */
  const forkAtEntry = useCallback(async (entryId: string) => {
    if (!activeId) return
    const parent = state.sessions[activeId]
    if (!parent) return
    setForkingEntryId(entryId)
    setForkNotice(undefined)
    try {
      const forked = await forkLiveSessionAtStep({ source: parent, entryId, sessions: Object.values(state.sessions) })
      await refresh()
      setForkNotice(`已从该步分叉出新会话 · ${forked.sessionId.slice(0, 8)}`)
      navigate(`/live-sessions/${encodeURIComponent(forked.processInstanceId)}`)
    } catch (reason) {
      setForkNotice(`分叉失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setForkingEntryId(undefined)
    }
  }, [activeId, navigate, refresh, state.sessions])
  const [sessionSidebarVisible, setSessionSidebarVisible] = useState(() => typeof window === 'undefined' || localStorage.getItem('live-session-sidebar') !== 'hidden')
  const timelineScrollRef = useRef<HTMLDivElement>(null)
  const timelineContentRef = useRef<HTMLDivElement>(null)
  // Whether the timeline is pinned to the newest message. Flipped to false when
  // the user scrolls up to read history, so streaming updates never yank them.
  const timelineAtBottom = useRef(true)
  const panel = usePanelState()
  const [documentPreview, setDocumentPreview] = useState<{ filePath: string; content: string; loading: boolean; error: string | null } | null>(null)
  // Comments on the full-screen preview live in the same sidecar as the side panel.
  const previewComments = useDocumentComments(documentPreview?.filePath ?? null)
  // Review comments are queued here and only sent after the user confirms in the dialog.
  const [reviewDraft, setReviewDraft] = useState<ReviewRequest | null>(null)
  // Quoted sentences picked in the transcript (A) and comments collected on them (B).
  const quoteSelection = useChatQuoteSelection()
  const [quotes, setQuotes] = useState<QuotedText[]>([])
  const [commentTarget, setCommentTarget] = useState<SelectionTarget | null>(null)
  const [chatComments, setChatComments] = useState<ReviewItem[]>([])
  const [focusedSubagentId, setFocusedSubagentId] = useState<string>()
  const [focusedWorkflow, setFocusedWorkflow] = useState<WorkflowRecord>()
  /** Subagent strip: pending two-step close confirm, in-flight closes, last result. */
  const [childCloseConfirm, setChildCloseConfirm] = useState<string>()
  const [closingChildIds, setClosingChildIds] = useState<string[]>([])
  const [childCloseNotice, setChildCloseNotice] = useState<string>()
  const [subagentLoading, setSubagentLoading] = useState(false)
  const [availableModels, setAvailableModels] = useState<LiveSessionModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)

  // ── Voice output (TTS) ───────────────────────────────────────────────────
  // Settings (model / voice / language) live in Settings → Voice; the toggle
  // here just flips `enabled` so it stays consistent with the persisted config.
  const [tts, setTts] = useState<TtsSettings>(loadTtsSettings)
  const { speak: speakReply, stop: stopSpeaking, speaking, error: voiceError, clearError: clearVoiceError } = useVoiceOutput()
  useEffect(() => subscribeTtsSettings(() => setTts(loadTtsSettings())), [])

  // A finished turn is busy → idle (see turnSpeech.ts: the raw session status
  // stays 'running' for tmux sessions even while idle between turns).
  const agentBusy = agentState.label !== '等待输入' && agentState.label !== '重连中'
  const gateRef = useRef<TurnSpeechGate>(INITIAL_TURN_SPEECH_GATE)
  const lastSpokenRef = useRef('')

  useEffect(() => {
    // Skip the transcript scan on ordinary idle updates; text is only needed
    // while the agent is busy (baseline), a finished turn awaits reading, or
    // the turn is ending right now (busy → idle in this very update).
    const gate = gateRef.current
    const needsText = agentBusy || gate.pending || gate.previousBusy === true
    const spoken = needsText ? lastAssistantSpeechText(detail?.entries || []) : ''
    gateRef.current = advanceTurnSpeech(gateRef.current, agentBusy, spoken)
    const decision = takePendingSpeech(gateRef.current, agentBusy, tts.enabled, spoken, lastSpokenRef.current)
    gateRef.current = decision.gate
    if (!decision.speak) return
    lastSpokenRef.current = decision.speak
    void speakReply(decision.speak, tts)
  }, [agentBusy, detail?.entries, tts, speakReply])

  const toggleVoice = useCallback(() => {
    setTts(current => {
      const next = { ...current, enabled: !current.enabled }
      saveTtsSettings(next)
      if (!next.enabled) stopSpeaking()
      return next
    })
  }, [stopSpeaking])

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

  /**
   * Close one subagent from the strip.
   *
   * Deliberately two-step: ending an agent is irreversible, so the first click
   * only arms the button. The backend refuses anything that is not a subagent
   * session, and drops the row by itself once the process exits.
   */
  const closeChildSession = useCallback(async (child: LiveSessionSummary) => {
    if (childCloseConfirm !== child.processInstanceId) {
      setChildCloseConfirm(child.processInstanceId)
      return
    }
    setChildCloseConfirm(undefined)
    setChildCloseNotice(undefined)
    setClosingChildIds(ids => ids.includes(child.processInstanceId) ? ids : [...ids, child.processInstanceId])
    try {
      const result = await liveSessionApi.closeSession(child.processInstanceId)
      setChildCloseNotice(result.alreadyGone
        ? `子 Agent ${child.sessionId.slice(0, 8)}… 的进程早已退出，等待列表刷新`
        : `已请求关闭子 Agent ${child.sessionId.slice(0, 8)}…（进程退出后会自动从这里移除）`)
      if (focusedSubagentId === child.processInstanceId) setFocusedSubagentId(undefined)
      void refresh()
    } catch (error) {
      setClosingChildIds(ids => ids.filter(id => id !== child.processInstanceId))
      dispatch(setLiveSessionError(errorMessage(error)))
    }
  }, [childCloseConfirm, dispatch, focusedSubagentId, refresh])

  // Clear the arm/close flags as soon as the session really leaves the strip.
  useEffect(() => {
    const live = new Set(childSessions.map(child => child.processInstanceId))
    setClosingChildIds(ids => ids.some(id => !live.has(id)) ? ids.filter(id => live.has(id)) : ids)
    setChildCloseConfirm(current => (current && !live.has(current) ? undefined : current))
  }, [childSessions])
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
      void loadFileComments(filePath).then(loaded => panel.setComments(loaded))
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

  // Stable callback for the timeline rows: keeps the memoized TimelineEntry /
  // LiveToolGroup from re-rendering just because the page re-rendered.
  const openTimelineFile = useCallback((path: string) => { void handleDocumentLink(path) }, [handleDocumentLink])

  const handleFileSave = useCallback(async (filePath: string, content: string) => {
    const response = await fetch('/api/file-write', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    })
    if (!response.ok) throw new Error(`Save failed: ${response.status}`)
    panel.setDirty(false)
  }, [panel.setDirty])

  const saveComments = useCallback((comments: Comment[]) => {
    if (!panel.filePath) return
    panel.setComments(comments)
    void saveFileComments(panel.filePath, comments).catch(error => console.warn('[file-comments] save failed', error))
  }, [panel.filePath, panel.setComments])

  const appendPanelComment = useCallback((startLine: number, endLine: number, content: string, quote?: string) => {
    const comment: Comment = {
      id: crypto.randomUUID(),
      startLine, endLine, content,
      ...(quote ? { quote } : {}),
      version: panel.versions.length > 0 ? panel.versions[panel.versions.length - 1].version : 1,
      createdAt: new Date().toISOString(),
    }
    saveComments([...panel.comments, comment])
  }, [panel.versions, panel.comments, saveComments])

  const editPanelComment = useCallback((id: string, content: string) => {
    saveComments(panel.comments.map(c => c.id === id ? { ...c, content } : c))
  }, [panel.comments, saveComments])

  const deletePanelComment = useCallback((id: string) => {
    saveComments(panel.comments.filter(c => c.id !== id))
  }, [panel.comments, saveComments])

  const handlePanelReview = useCallback(() => {
    if (!panel.filePath || panel.comments.length === 0) return
    setReviewDraft({ kind: 'panel', label: panel.filePath, items: commentReviewItems(panel.comments) })
  }, [panel.filePath, panel.comments])

  const handlePreviewReview = useCallback(() => {
    const filePath = documentPreview?.filePath
    if (!filePath || previewComments.comments.length === 0) return
    setReviewDraft({ kind: 'preview', label: filePath, items: commentReviewItems(previewComments.comments) })
  }, [documentPreview?.filePath, previewComments.comments])

  /**
   * Manual refresh: list metadata + the active transcript. The transcript fetch
   * heals anything the live stream could not deliver, so the button actually
   * refreshes what the user is looking at (it used to refresh only the list).
   */
  const refreshNow = useCallback(() => {
    void refresh()
    if (!activeId) return
    liveSessionApi.detail(activeId)
      .then(value => dispatch(liveSessionSnapshot(value)))
      .catch(error => dispatch(setLiveSessionError(errorMessage(error))))
  }, [activeId, dispatch, refresh])

  useEffect(() => {
    if (activeId) dispatch(selectLiveSession(activeId))
    else if (sessions[0]) navigate(`/live-sessions/${encodeURIComponent(sessions[0].processInstanceId)}`, { replace: true })
  }, [activeId, dispatch, navigate, sessions])

  const scrollTimelineToBottom = useCallback(() => {
    const el = timelineScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  /**
   * Keep following the newest message while pinned — including layout that
   * settles after the first paint (images, mermaid, lazy panels). One rAF is
   * not enough for late layout, so re-pin once after the frame committed; the
   * ResizeObserver below covers anything that grows later still.
   */
  const pinTimelineToBottom = useCallback(() => {
    if (!timelineAtBottom.current) return
    scrollTimelineToBottom()
    requestAnimationFrame(() => {
      if (timelineAtBottom.current) scrollTimelineToBottom()
    })
  }, [scrollTimelineToBottom])

  /**
   * Reading a long block means the timeline must stop chasing the newest message:
   * while pinned, every content growth (including unfolding) re-scrolls to the
   * bottom and pulls the reader away from what they just opened.
   */
  const pauseTimelineFollow = useCallback(() => {
    timelineAtBottom.current = false
  }, [])

  const handleTimelineScroll = useCallback(() => {
    const el = timelineScrollRef.current
    if (!el) return
    timelineAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  // Follow content growth while pinned. Depends on the entries array itself, not
  // its length: streaming `message_update` / `tool_execution_update` events replace
  // the last entry in place, so the length alone would miss every later chunk.
  useEffect(() => {
    pinTimelineToBottom()
  }, [detail?.entries, pinTimelineToBottom])

  const timelineReady = Boolean(summary && detail)
  // A freshly mounted timeline (session switch, reconnect re-render) starts at
  // scrollTop 0; reset the pin and jump to the newest message.
  useLayoutEffect(() => {
    if (!timelineReady) return
    timelineAtBottom.current = true
    pinTimelineToBottom()
  }, [timelineReady, pinTimelineToBottom])

  // Switching between two already-loaded sessions reuses the same scroll
  // container, so reset the pin for the newly selected session and re-pin after
  // the switch renders.
  useLayoutEffect(() => {
    timelineAtBottom.current = true
    pinTimelineToBottom()
  }, [activeId, pinTimelineToBottom])

  // Async content (images, mermaid diagrams, lazy-rendered panels) keeps
  // growing the transcript after the scroll effects above ran. While pinned,
  // re-pin on every content height change so the view never drifts into older
  // messages; while the user reads history the observer does nothing.
  useEffect(() => {
    if (!timelineReady) return
    const content = timelineContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (timelineAtBottom.current) scrollTimelineToBottom()
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [timelineReady, scrollTimelineToBottom])

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
  // pi's `/effort` extension command sets the thinking level; it rides the same
  // input channel as `/goal` and `/ls-*` (no protocol change needed).
  const selectThinkingLevel = (level: string) => perform(async () => {
    if (!activeId) return
    await liveSessionApi.command(activeId, { type: 'input', text: `/effort ${level}`, channel: 'web' })
  })
  const compact = () => perform(async () => {
    if (!activeId) return
    const leaseId = await claim()
    const sessionFile = summary?.sessionFile
    // Snapshot the marker list BEFORE asking for compaction: everything that
    // appears afterwards is evidence that this request really finished.
    const baseline = sessionFile
      ? await liveSessionApi.compactions(sessionFile)
        .then(snapshot => ({ now: snapshot.now, count: snapshot.compactions.length }))
        .catch(() => undefined)
      : undefined
    await liveSessionApi.command(activeId, { type: 'compact', leaseId })
    // The ack only means "compaction started" — `ctx.compact()` is fire-and-forget
    // agent-side, so keep the user informed until the entry lands on disk.
    setCompacting(true)
    setCommandNotice('正在压缩上下文…（命令已下发，压缩在后台进行中）')
    compactionAbort.current?.abort()
    const controller = new AbortController()
    compactionAbort.current = controller
    void watchCompaction({
      sessionFile,
      baseline,
      fetchSnapshot: liveSessionApi.compactions,
      signal: controller.signal,
    }).then(result => {
      if (controller.signal.aborted) return
      setCompacting(false)
      if (result.status === 'completed') {
        const tokens = result.mark?.tokensBefore
        setCommandNotice(tokens ? `上下文压缩完成（压缩前 ${tokens.toLocaleString()} tokens）` : '上下文压缩完成')
        return
      }
      if (result.status === 'timeout') {
        setCommandNotice('压缩尚未结束：后台可能仍在处理，稍后可看上下文 token 数是否下降')
        return
      }
      if (result.status === 'unavailable') {
        setCommandNotice('已下发压缩；该会话未提供完成信号，请稍后看上下文 token 数是否下降')
      }
    })
  })
  const goal = () => perform(async () => {
    if (!activeId) return
    await liveSessionApi.command(activeId, { type: 'input', text: '/goal', channel: 'web' })
  })
  const clearSession = () => perform(async () => {
    if (!activeId) return
    await liveSessionApi.command(activeId, { type: 'input', text: '/clear', channel: 'web' })
    setAvailableModels([])
    // Give the click visible feedback: the page only switches once Pi reports the
    // new session, which is a few seconds later.
    setCommandNotice('已请求清空会话（/clear）——新会话就绪后本页会自动切过去')
  })
  /**
   * 「清空」used to be gated on `window.confirm`, and browsers answer that with a
   * silent `false` when dialogs are suppressed ("prevent additional dialogs",
   * unfocused tab, stricter WebViews) — the click then did nothing at all and
   * left no trace. Arm on the first click, act on the second, like the sidebar's
   * destructive actions; the arm expires on its own.
   */
  const handleClear = () => {
    if (!clearArmed) {
      setClearArmed(true)
      setCommandNotice('再点一次「清空」确认：当前对话会保留在文件中，本页将切到新的空会话')
      return
    }
    setClearArmed(false)
    void clearSession().catch(() => { /* perform() already surfaced the error */ })
  }
  useEffect(() => {
    if (!clearArmed) return
    const timer = window.setTimeout(() => setClearArmed(false), 5000)
    return () => window.clearTimeout(timer)
  }, [clearArmed])
  const abort = () => perform(async () => {
    if (!activeId) return
    const leaseId = await claim()
    await liveSessionApi.command(activeId, { type: 'abort', leaseId })
  })
  const reload = () => perform(async () => {
    if (!activeId) return
    await liveSessionApi.command(activeId, { type: 'reload' })
    setCommandNotice('已触发重载，Web 端将短暂重连')
  })
  // Session-tree navigation requested from the graph page: the bridge exposes
  // `/ls-navigate` as an extension command, so this rides the plain input
  // channel (no protocol change).
  const navigateToNode = (nodeId: string) => perform(async () => {
    if (!activeId) return
    const suffix = ownedLeaseId ? ` ${ownedLeaseId}` : ''
    await liveSessionApi.command(activeId, { type: 'input', text: `/ls-navigate ${nodeId}${suffix}`, channel: 'web' })
    setCommandNotice(`已请求切换到节点 ${nodeId}`)
  })
  /**
   * BTW rides the lease-gated `feature_command` channel. The side chat's adapter
   * accepts open/close/submit/abort/refresh-parent, so the panel can actually be
   * used here instead of only being opened and closed.
   */
  const btwCommand = (command: BtwFeatureCommand) => perform(async () => {
    if (!activeId) return
    const leaseId = await claim()
    await liveSessionApi.command(activeId, { type: 'feature_command', leaseId, feature: 'btw', command })
  })

  const moveToBackground = (toolCallId: string) => perform(async () => {
    if (!activeId) return
    const leaseId = await claim()
    await liveSessionApi.command(activeId, { type: 'feature_command', leaseId, feature: 'background-commands', command: { type: 'background', toolCallId } })
    setCommandNotice('已把前台命令转入后台，进程继续运行')
  })

  const submit = (text: string, deliverAs?: 'steer' | 'followUp', images?: LiveSessionImage[]) => perform(async () => {
    if (!activeId) return
    const processInstanceId = activeId
    const trimmed = text.trim()

    // TUI 内置命令在 input 文本流里不会被 dispatch（sendUserMessage 只处理扩展命令/skill/模板），
    // 必须在这里翻译成结构化命令，才能与 TUI 行为一致。
    if (trimmed === '/reload') {
      await liveSessionApi.command(processInstanceId, { type: 'reload' })
      setCommandNotice('已触发重载，Web 端将短暂重连')
      return
    }
    if (trimmed === '/compact') {
      const leaseId = await claim()
      await liveSessionApi.command(processInstanceId, { type: 'compact', leaseId })
      setCommandNotice('上下文压缩完成')
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
    // Pi 正在工作时这条消息只是被排队（追加等本轮结束 / 插话等下个工具调用），
    // 直到 Pi 回显这条 user 消息前都还没被真正处理；记住交付方式，气泡才能显示排队状态
    // （判定规则见 pendingDelivery.queuedDeliveryFor）。
    const queuedDelivery = queuedDeliveryFor({ status: summary?.status, ...(deliverAs ? { deliverAs } : {}), text })
    dispatch(liveSessionUserMessageAdded({
      processInstanceId, localId, text, ...(images?.length ? { images } : {}), ...(queuedDelivery ? { deliverAs: queuedDelivery } : {}),
    }))
    try {
      await liveSessionApi.command(processInstanceId, { type: 'input', text, channel: 'web', ...(images?.length ? { images } : {}), ...(deliverAs ? { deliverAs } : {}) })
      // 桥已接受（accepted: true）：从“发送中”变成“已排队，等 Pi 取走”。
      if (queuedDelivery) dispatch(liveSessionUserMessageAcknowledged({ processInstanceId, localId }))
    } catch (error) {
      dispatch(liveSessionUserMessageRemoved({ processInstanceId, localId }))
      throw error
    }
  })

  /** Sends the reviewed comments as one prompt, then drops only those comments. */
  const handleReviewSend = useCallback((message: string, sentIds: string[]) => {
    if (!reviewDraft) return
    void submit(message).catch(() => {})
    if (reviewDraft.kind === 'panel') saveComments(panel.comments.filter(c => !sentIds.includes(c.id)))
    else if (reviewDraft.kind === 'preview') previewComments.removeComments(sentIds)
    else setChatComments(previous => previous.filter(item => !sentIds.includes(item.id)))
    setReviewDraft(null)
  }, [reviewDraft, submit, saveComments, panel.comments, previewComments])

  // Quotes and collected comments belong to one session; a switch starts clean.
  useEffect(() => {
    setQuotes([])
    setChatComments([])
    setCommentTarget(null)
    setClearArmed(false)
  }, [activeId])

  /** A: keep the selected sentence as a chip above the composer. */
  const addQuote = useCallback((target: SelectionTarget) => {
    setQuotes(previous => previous.some(quote => quote.text === target.text)
      ? previous
      : [...previous, { id: target.id, text: target.text, ...(target.role ? { role: target.role } : {}), ...(target.entryId ? { entryId: target.entryId } : {}) }])
    quoteSelection.clear()
  }, [quoteSelection])

  /** B: collect a comment on the selected sentence without sending yet. */
  const addChatComment = useCallback((content: string) => {
    if (!commentTarget) return
    setChatComments(previous => [...previous, {
      id: crypto.randomUUID(),
      label: selectionLabel(commentTarget.role),
      quote: commentTarget.text,
      content,
    }])
    setCommentTarget(null)
    quoteSelection.clear()
  }, [commentTarget, quoteSelection])

  const handleChatCommentsReview = useCallback(() => {
    if (chatComments.length === 0) return
    setReviewDraft({ kind: 'chat', label: '上面的会话', items: chatComments, intro: CHAT_REVIEW_INTRO })
  }, [chatComments])

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
      {sessionSidebarVisible && <LiveSessionsList sessions={sessions} sessionTitles={sessionTitles} subagentStatuses={subagentStatuses} activeId={activeId} onRefresh={refresh} pendingUiCounts={pendingUiCounts} onSelect={id => navigate(`/live-sessions/${encodeURIComponent(id)}`)} />}
      <main className="min-w-0 flex-1 flex flex-col bg-bg">
        <div className="flex h-8 min-w-0 items-center justify-between gap-2 border-b border-border bg-card px-2 text-2xs text-muted">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {summary?.parentSessionId && <button type="button" onClick={() => parentSession ? navigate(`/live-sessions/${encodeURIComponent(parentSession.processInstanceId)}`) : navigate('/live-sessions/gallery')} className="shrink-0 rounded border border-accent bg-accent-subtle px-2 py-0.5 text-2xs text-accent hover:border-accent">← 返回主 Agent</button>}
            <button type="button" onClick={toggleSessionSidebar} className="shrink-0 rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted hover:border-accent hover:text-accent" title={sessionSidebarVisible ? '隐藏 Session 列表' : '显示 Session 列表'}>
              {sessionSidebarVisible ? '隐藏列表' : '显示列表'}
            </button>
            {!state.wsConnected && <span className="shrink-0 text-warn" title="浏览器与 Dashboard 服务端的实时连接已断开，正在自动重连（此时页面不会再收到新的会话事件）">◐ 正在重连</span>}
            {summary && <CwdChip path={summary.canonicalCwd} />}
            {summary && <TuiLikeStatus summary={summary} />}
            {summary && <span className="min-w-0 flex-1 truncate" title={`${summary.sessionName || `Pi ${summary.pid}`} · ${summary.canonicalCwd} · ${summary.model ? `${summary.model.provider}/${summary.model.id}` : 'model unavailable'} · ${summary.thinkingLevel || ''}`}>
              {summary.sessionName || `Pi ${summary.pid}`}{summary.model ? ` · ${summary.model.provider}/${summary.model.id}` : ''}{summary.thinkingLevel ? ` · ${summary.thinkingLevel}` : ''}
            </span>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {summary && (ownedLeaseId ? <button type="button" disabled={busy} onClick={() => { void release().catch(() => {}) }} className="rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted disabled:opacity-50">释放控制</button> : <button type="button" disabled={busy || summary.status === 'reconnecting'} onClick={() => { void perform(async () => { await claim() }).catch(() => {}) }} className="rounded border border-accent bg-accent px-2 py-0.5 text-2xs text-accent-fg disabled:opacity-50">取得控制</button>)}
            <button type="button" onClick={() => navigate(summary?.sessionFile ? `/live-sessions/graph?file=${encodeURIComponent(summary.sessionFile)}` : '/live-sessions/graph')} className="rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted hover:border-accent hover:text-accent" title="在会话家族图谱中查看该会话">◈ 在图谱中查看</button>
            <button type="button" onClick={toggleAuxiliary} className={`shrink-0 rounded border px-2 py-0.5 text-2xs ${auxiliary ? 'border-border bg-bg text-muted hover:border-accent hover:text-accent' : 'border-accent bg-accent-subtle text-accent'}`} title={auxiliary ? '当前显示思路与工具/脚本执行；点一下切换为精简阅读' : '精简阅读：只留正文（思路与工具/脚本已隐去）'}>
              {auxiliary ? '👁 显示全部' : ' 精简阅读'}
            </button>
            <button type="button" onClick={toggleVoice} className={`flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-2xs ${tts.enabled ? 'border-accent bg-accent-subtle text-accent' : 'border-border bg-bg text-muted hover:border-accent hover:text-accent'}`} title={tts.enabled ? '语音输出已开启：Pi 回复结束会自动朗读（点击关闭；模型/音色见 设置 → Voice）' : '语音输出已关闭（点击开启；模型/音色见 设置 → Voice）'}>
              <MaterialIcon name={tts.enabled ? 'volume_up' : 'volume_off'} className="h-3.5 w-3.5" />语音输出
            </button>
            {speaking && <button type="button" onClick={stopSpeaking} className="flex shrink-0 items-center gap-1 rounded border border-warn bg-warn-subtle px-2 py-0.5 text-2xs text-warn" title="停止朗读"><MaterialIcon name="stop" className="h-3 w-3" />停止朗读</button>}
            <button type="button" onClick={refreshNow} className="rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted hover:border-accent hover:text-accent">刷新</button>
          </div>
        </div>
        {childSessions.length > 0 && <div className="shrink-0 border-b border-border bg-card px-3 py-2">
          <div className="mb-1 text-2xs font-medium text-muted">子 Agent · {childSessions.length}</div>
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {childSessions.map(child => {
              const title = sessionTitles[child.processInstanceId] || child.sessionName || `子 Agent · PID ${child.pid}`
              const focused = focusedSubagentId === child.processInstanceId
              const confirmingClose = childCloseConfirm === child.processInstanceId
              const closing = closingChildIds.includes(child.processInstanceId)
              return <div key={child.processInstanceId} className="group relative min-w-[150px] max-w-[220px]">
                <button type="button" onClick={() => { setChildCloseConfirm(undefined); setFocusedSubagentId(child.processInstanceId) }} className={`w-full rounded border px-2 py-1.5 text-left transition-colors ${focused ? 'border-accent bg-accent-subtle' : 'border-border bg-card hover:border-accent'} ${closing ? 'opacity-50' : ''}`} title={`打开子 Agent：${title}`}>
                  <div className="flex items-center gap-1.5"><span className="shrink-0 text-meta leading-none" aria-label={`Session 状态：${child.status === 'running' ? '工作中' : child.status === 'reconnecting' ? '重连中' : '等待输入'}`}>{child.status === 'running' ? <WorkingHammerIcon /> : child.status === 'reconnecting' ? '🔄' : '💤'}</span><span className="min-w-0 flex-1 truncate text-2xs font-medium text-text-strong">{title}</span><span className="text-2xs text-muted">{closing ? '关闭中…' : child.status === 'running' ? '工作中' : child.status === 'reconnecting' ? '重连中' : '等待'}</span></div>
                  <div className="mt-0.5 truncate font-mono text-2xs text-muted">sid {child.sessionId.slice(0, 8)}… · PID {child.pid}</div>
                </button>
                {/* Sibling of the card: a nested button would reset the card's own click. */}
                <button
                  type="button"
                  disabled={closing}
                  onClick={event => { event.stopPropagation(); void closeChildSession(child) }}
                  title={confirmingClose ? '再点一次确认关闭该子 Agent' : '关闭该子 Agent（结束它的 Pi 进程）'}
                  aria-label={confirmingClose ? `确认关闭子 Agent ${title}` : `关闭子 Agent ${title}`}
                  className={`absolute -right-1 -top-1 rounded-full border px-1 text-2xs leading-[16px] transition-opacity disabled:opacity-60 ${confirmingClose ? 'border-danger bg-danger text-danger-fg opacity-100' : 'border-border bg-card text-muted opacity-0 group-hover:opacity-100 hover:border-danger hover:text-danger focus-visible:opacity-100'}`}
                >{confirmingClose ? '确认' : closing ? '…' : '×'}</button>
              </div>
            })}
          </div>
        </div>}
        {state.error && <div className="px-4 py-2 bg-danger-subtle text-danger text-xs border-b border-danger">{state.error}</div>}
        {voiceError && <div className="flex items-center gap-2 border-b border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">
          <span className="min-w-0 flex-1 truncate" title={voiceError}>语音输出：{voiceError}</span>
          <button type="button" onClick={clearVoiceError} className="shrink-0 rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted">关闭</button>
        </div>}
        {commandNotice && !state.error && <div className="flex items-center gap-1.5 px-4 py-2 bg-accent-subtle text-accent text-xs border-b border-accent" role="status">{compacting && <MaterialIcon name="sync" spin className="h-3.5 w-3.5 shrink-0" />}{commandNotice}</div>}
        {forkNotice && <div className="px-4 py-2 bg-accent-subtle text-accent text-xs border-b border-accent">{forkNotice}</div>}
        {childCloseNotice && <div className="px-4 py-2 bg-accent-subtle text-accent text-xs border-b border-accent" role="status">{childCloseNotice}</div>}
        {graphNodeId && <div className="flex items-center gap-2 border-b border-accent bg-accent-subtle px-4 py-2 text-xs text-accent">
          <span className="min-w-0 flex-1 truncate">已从图谱定位到节点 <span className="font-mono">{graphNodeId}</span></span>
          {treeCapable ? (
            <button type="button" disabled={busy || !activeId} onClick={() => void navigateToNode(graphNodeId).catch(() => {})} className="shrink-0 rounded border border-accent bg-accent px-2 py-0.5 text-2xs text-accent-fg disabled:opacity-40">切到此处</button>
          ) : (
            <span className="shrink-0 text-2xs text-muted">当前扩展版本不支持，请先 /reload</span>
          )}
          <button type="button" onClick={() => { const next = new URLSearchParams(searchParams); next.delete('node'); setSearchParams(next, { replace: true }) }} className="shrink-0 rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted hover:border-accent">关闭</button>
        </div>}
        {activeId && notifications.length > 0 && <div className="shrink-0 border-b border-border bg-bg-elevated px-3 py-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-2xs font-medium text-muted">扩展通知 · {notifications.length}</span>
            <button type="button" onClick={() => dispatch(dismissSessionNotifications(activeId))} className="rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted hover:border-accent hover:text-accent">全部清除</button>
          </div>
          <div className="max-h-[180px] space-y-1 overflow-y-auto">
            {notifications.map((note, index) => <pre key={index} className={`m-0 whitespace-pre-wrap break-words rounded border px-2 py-1 font-mono text-2xs leading-4 ${note.notifyType === 'error' ? 'border-danger bg-danger-subtle text-danger' : note.notifyType === 'warning' ? 'border-warn bg-warn-subtle text-warn' : 'border-border bg-card text-text'}`}>{note.message}</pre>)}
          </div>
        </div>}
        {!summary || !detail ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted">选择一个正在运行的 Pi session。</div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                <div ref={timelineScrollRef} onScroll={handleTimelineScroll} data-timeline-scroll="" className="flex flex-1 flex-col overflow-y-auto p-3">
                <div ref={timelineContentRef} className="flex flex-col space-y-3">
                  {workflowItems.map(workflow => <LiveWorkflowProgressCard key={String(workflow.id)} workflow={workflow} sessions={sessions} onOpen={workflowValue => { setFocusedSubagentId(undefined); setFocusedWorkflow(workflowValue) }} />)}
                  {detail.entries.length === 0 && workflowItems.length === 0 && <div className="text-sm text-muted text-center py-10">该 session 暂无可显示消息。</div>}
                  {!auxiliary && (timeline.hidden.tools > 0 || timeline.hidden.thinking > 0 || timeline.hidden.other > 0) ? (
                    <div className="flex items-center gap-2 rounded-md border border-border bg-bg-elevated px-3 py-2 text-2xs text-muted">
                      <span className="min-w-0 flex-1">
                        精简阅读：已隐去思路 {timeline.hidden.thinking} 片段 · 工具/脚本 {timeline.hidden.tools} 处 · 遥测 {timeline.hidden.other} 条
                      </span>
                      <button
                        type="button"
                        onClick={toggleAuxiliary}
                        className="shrink-0 cursor-pointer rounded border border-border bg-card px-2 py-0.5 text-2xs text-muted transition-colors hover:border-accent hover:text-accent"
                      >显示思路与工具</button>
                    </div>
                  ) : null}
                  {timelineItems.map(item => item.type === 'toolGroup'
                    ? <LiveToolGroup key={`tool-group-${item.items[0]?.index ?? 0}`} items={item.items} thinking={item.thinking} onFileOpen={openTimelineFile} toolStates={toolStates} onReadStart={pauseTimelineFollow} />
                    : <TimelineEntry key={`${item.index}-${typeof item.entry === 'object' && item.entry ? String((item.entry as Record<string, unknown>).type || '') : ''}`} entry={item.entry} onFileOpen={openTimelineFile} toolStates={toolStates} auxiliary={auxiliary} onForkAt={forkAtEntry} forkingEntryId={forkingEntryId} onReadStart={pauseTimelineFollow} />
                  )}
                </div>
                </div>
                <LiveCommandBar toolStates={toolStates} features={features} onMoveToBackground={moveToBackground} />
                <PendingDeliveryBar deliveries={pendingMessages} />
                <LiveSessionComposer
                  sessionKey={activeId}
                  status={summary.status}
                  activity={agentState}
                  disabled={busy || summary.status === 'reconnecting'}
                  models={availableModels}
                  currentModel={summary.model}
                  modelsLoading={modelsLoading}
                  onLoadModels={loadModels}
                  onSelectModel={selectModel}
                  currentThinkingLevel={summary.thinkingLevel}
                  onSelectThinkingLevel={selectThinkingLevel}
                  cwd={summary.canonicalCwd}
                  onInterrupt={() => { void abort().catch(() => {}) }}
                  interrupting={busy}
                  onSubmit={submit}
                  quotes={quotes}
                  onRemoveQuote={id => setQuotes(previous => previous.filter(quote => quote.id !== id))}
                  onClearQuotes={() => setQuotes([])}
                />
                {chatComments.length > 0 && <div className="flex flex-wrap items-center gap-2 border-t border-border bg-chrome px-2 py-1 text-2xs text-muted" role="status">
                  <span>💬 {chatComments.length} 条批注待发送</span>
                  <span className="min-w-0 flex-1 truncate" title={chatComments.map(item => item.quote ?? '').join(' / ')}>{chatComments.map(item => item.quote ?? '').join(' / ')}</span>
                  <button type="button" onClick={() => setChatComments([])} className="shrink-0 rounded border border-border px-2 py-0.5 text-muted hover:border-danger hover:text-danger">清空</button>
                  <button type="button" onClick={handleChatCommentsReview} className="shrink-0 rounded border border-accent px-2 py-0.5 text-accent hover:bg-accent-subtle">发送批注</button>
                </div>}
              </div>
              <LiveSessionFeatures
                features={features}
                busy={busy}
                cwd={summary.canonicalCwd}
                status={summary.status}
                onFileOpen={path => { void handleFileOpen(path) }}
                onOpenBtw={() => { void btwCommand({ type: 'open' }).catch(() => {}) }}
                onCloseBtw={() => { void btwCommand({ type: 'close' }).catch(() => {}) }}
                onBtwSubmit={text => { void btwCommand({ type: 'submit', text }).catch(() => {}) }}
                onBtwAbort={() => { void btwCommand({ type: 'abort' }).catch(() => {}) }}
                onBtwRefreshParent={() => { void btwCommand({ type: 'refresh-parent' }).catch(() => {}) }}
                onOpenWorkflow={workflow => { setFocusedSubagentId(undefined); setFocusedWorkflow(workflow) }}
                onGoal={() => { void goal().catch(() => {}) }}
                compacting={compacting}
                onCompact={() => { void compact().catch(() => {}) }}
                onClear={handleClear}
                clearArmed={clearArmed}
                onReload={() => { void reload().catch(() => {}) }}
                onAbort={() => { void abort().catch(() => {}) }}
              />
            </div>
          </>
        )}
      </main>
      {panel.isOpen && <>
        {/* Clicking the dimmed area closes the panel. Without this the backdrop
            swallowed every click on the composer (批注清空 / 发送 were dead). */}
        <div
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
          aria-hidden="true"
          onClick={() => { if (panel.dirty && !window.confirm('文件有未保存修改，仍然关闭？')) return; panel.closePanel() }}
        />
        <ErrorBoundary
          key={`panel:${panel.filePath}`}
          fallback={<div className="fixed inset-3 z-[60] flex flex-col items-center justify-center gap-3 rounded-xl border border-danger bg-bg p-6 text-center shadow-2xl md:inset-8"><div className="text-sm text-danger">文件渲染失败</div><div className="max-w-full truncate text-xs text-muted" title={panel.filePath}>{panel.filePath}</div><div className="flex items-center gap-2"><a href={`/api/local-file/download?path=${encodeURIComponent(panel.filePath)}`} download className="rounded border border-accent px-3 py-1 text-xs text-accent no-underline hover:bg-accent hover:text-accent-fg">下载原文件</a><button type="button" onClick={() => window.location.reload()} className="rounded border border-border px-3 py-1 text-xs text-muted hover:border-accent hover:text-accent">重新加载</button><button type="button" onClick={panel.closePanel} className="rounded border border-border px-3 py-1 text-xs text-muted hover:border-accent hover:text-accent">关闭</button></div></div>}
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
            onAddComment={appendPanelComment}
            onEditComment={editPanelComment}
            onDeleteComment={deletePanelComment}
            onReviewComments={handlePanelReview}
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
            comments={previewComments.comments}
            onAddComment={previewComments.addComment}
            onEditComment={previewComments.editComment}
            onDeleteComment={previewComments.deleteComment}
            onReviewComments={handlePreviewReview}
          />
        </ErrorBoundary>
      )}
      {reviewDraft && (
        <ErrorBoundary key={`review:${reviewDraft.label}`}>
          <ReviewCommentsDialog
            target={reviewDraft.label}
            items={reviewDraft.items}
            intro={reviewDraft.intro}
            onCancel={() => setReviewDraft(null)}
            onSend={handleReviewSend}
          />
        </ErrorBoundary>
      )}
      {quoteSelection.selection && !commentTarget && (
        <SelectionQuoteMenu
          target={quoteSelection.selection}
          onQuote={addQuote}
          onComment={target => setCommentTarget(target)}
        />
      )}
      {commentTarget && (
        <QuoteCommentPopover
          target={commentTarget}
          onSave={addChatComment}
          onCancel={() => { setCommentTarget(null); quoteSelection.clear() }}
        />
      )}
      <ExtensionUiModal />
    </div>
  )
}
