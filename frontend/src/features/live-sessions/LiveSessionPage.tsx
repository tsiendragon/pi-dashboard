import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { BtwFeatureCommand, LiveSessionDetail, LiveSessionImage, LiveSessionModelOption, LiveSessionSummary } from '@shared/live-sessions'
import MarkdownRenderer from '../../components/MarkdownRenderer'
import MaterialIcon from '../../components/MaterialIcon'
import DocumentPreviewModal from '../../components/DocumentPreviewModal'
import ReviewCommentsDialog from '../../components/ReviewCommentsDialog'
import ExtensionUiModal from '../../components/ExtensionUiModal'
import ErrorBoundary from '../../components/ErrorBoundary'
import ToolCallBlock from '../../pages/chat/ToolCallBlock'
import { ToolSummaryLine, type ToolSummaryStatus } from '../../components/ToolSummary'
import { detectFileType, usePanelState, type Comment } from '../../hooks/usePanelState'
import { useDocumentComments } from '../../hooks/useDocumentComments'
import { loadFileComments, saveFileComments } from '../../api/fileComments'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useArmedConfirm } from '../../hooks/useArmedConfirm'
import { clampPercent, contextBarCells, contextTriggerPercent } from './contextStatusBar'
import { clearCommandAvailable, contextViewAvailable } from './liveSessionCommands'
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
import LiveCommandChips, { RUNNING_COMMAND_TASK, backgroundTasks, collectCommandChips } from './LiveCommandChips'
import ActivityTimeline, { type ActivityCommand, type ActivityImage, type ActivityNote, type ActivityReply, type ActivityStep, type LiveActivity } from './ActivityTimeline'
import FullContentModal from '../../components/FullContentModal'
import LineIcon from '../../components/LineIcon'
import { SelectionQuoteMenu, QuoteCommentPopover } from '../../components/SelectionQuoteMenu'
import { useChatQuoteSelection, type SelectionTarget } from '../../hooks/useChatQuoteSelection'
import { CHAT_REVIEW_INTRO, commentReviewItems, quoteOrCommentKind, quotedSnippets, selectionLabel, type FollowUpKind, type QuotedText, type ReviewItem } from '../../utils/reviewComments'

/** One review round: what the comments point at and how to clear them after sending. */
interface ReviewRequest {
  kind: 'panel' | 'preview' | 'chat'
  label: string
  items: ReviewItem[]
  intro?: string
}

/**
 * Sent when the user asks the agent to re-check its own checklist. Kept short and
 * read-only in intent: the agent reports truth, it does not get to rewrite the
 * objective or the acceptance criteria (the goal extension blocks that anyway).
 */
const GOAL_SYNC_REQUEST = '请对照本会话最初的需求，把「任务锚点」里的工作项状态更新为真实进度（已完成 / 进行中 / 未开始），并补齐或关闭已经变化的阻塞项。不要改动目标原文和验收标准。'
import { watchCompaction } from './compactionWatch'
import LiveSessionFeatures from './LiveSessionFeatures'
import { sessionGoalFromEntries, type SessionGoalSummary, type SessionGoalWorkItem } from './sessionGoal'
import LiveSubagentPanel from './LiveSubagentPanel'
import LiveSubagentStrip from './LiveSubagentStrip'
import LiveSubagentRecordPanel from './LiveSubagentRecordPanel'
import { projectSubagentSessions } from './subagentSessions'
import type { ProjectionRecord } from './subagentProjection'
import ToolResultCard, { shortToolId } from './ToolResultCard'
import LiveWorkflowPanel from './LiveWorkflowPanel'
import LiveWorkflowProgressCard, { type WorkflowRecord } from './LiveWorkflowProgressCard'
import { loadTtsSettings, saveTtsSettings, subscribeTtsSettings, type TtsSettings } from '../voice/ttsSettings'
import { useVoiceOutput } from '../voice/useVoiceOutput'
import { INITIAL_TURN_SPEECH_GATE, advanceTurnSpeech, takePendingSpeech, type TurnSpeechGate } from '../voice/turnSpeech'
import { buildSessionTitles, buildSubagentStatuses } from './sessionTitle'
import { displayWorktreePath } from '../../utils/displayPath'
import { copyText } from '../../utils/clipboard'
import LiveSessionsList from './LiveSessionsList'
import ContextInspector from './ContextInspector'
import { PendingDeliveryBar, pendingDeliveries, pendingDeliveryLabel, pendingDeliveryOf, pendingDeliveryTitle, queuedDeliveryFor } from './pendingDelivery'
import { forkLiveSessionAtStep } from './forkPlacement'
import { useLiveSessionsRefresh } from './LiveSessionsRuntime'

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

function userActivityInput(content: unknown, fallbackText: string): { title: string; images: ActivityImage[] } {
  const textParts: string[] = []
  const images: ActivityImage[] = []
  if (typeof content === 'string') textParts.push(content)
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue
      const record = part as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') textParts.push(record.text)
      if (record.type !== 'image' || typeof record.data !== 'string' || !record.data) continue
      const mimeType = typeof record.mimeType === 'string' ? record.mimeType : ''
      if (mimeType.startsWith('image/')) images.push({ data: record.data, mimeType })
    }
  }
  const text = shortTarget(textParts.join('\n'), 150)
  return {
    title: text || (images.length > 0 ? `用户发送了 ${images.length} 张图片` : shortTarget(fallbackText, 150) || fallbackText),
    images,
  }
}

function editableTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const textParts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined
    const record = part as Record<string, unknown>
    if (record.type !== 'text' || typeof record.text !== 'string') return undefined
    textParts.push(record.text)
  }
  return textParts.join('\n')
}

function messageFromEntry(entry: unknown): { role: string; text: string; content: unknown; channel?: string; toolName?: string; toolCallId?: string; isError?: boolean; providerError?: string } | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  let message: Record<string, unknown> | undefined
  let channel: string | undefined
  if (record.type === 'message' && record.message && typeof record.message === 'object') message = record.message as Record<string, unknown>
  if (record.type === 'message_end' || record.type === 'message_update') {
    const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? record.data as Record<string, unknown> : record
    const rawMessage = data.message && typeof data.message === 'object' ? data.message : record.message
    if (rawMessage && typeof rawMessage === 'object' && !Array.isArray(rawMessage)) message = rawMessage as Record<string, unknown>
    if (typeof data.channel === 'string') channel = data.channel
  }
  if (!message || typeof message.role !== 'string') return undefined
  const text = textContent(message.content)
  if (message.role !== 'assistant' && !text) return undefined
  const rawProviderError = typeof message.errorMessage === 'string' ? message.errorMessage : ''
  const providerError = rawProviderError.trim()
    ? rawProviderError
    : message.stopReason === 'error' ? '模型请求失败，但未提供错误详情。' : undefined
  return {
    role: message.role,
    text,
    content: message.content,
    ...(channel ? { channel } : {}),
    ...(typeof message.toolName === 'string' ? { toolName: message.toolName } : {}),
    ...(typeof message.toolCallId === 'string' ? { toolCallId: message.toolCallId } : {}),
    ...(typeof message.isError === 'boolean' ? { isError: message.isError } : {}),
    ...(providerError ? { providerError } : {}),
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

/**
 * Message id behind a transcript entry, for entries that have no session-entry id yet.
 *
 * A streaming assistant message keeps the same message id from `message_start` through
 * `message_end`, so it can anchor render identity before the entry id arrives.
 */
function entryMessageId(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined
  const message = data?.message && typeof data.message === 'object' && !Array.isArray(data.message)
    ? data.message as Record<string, unknown>
    : record.message && typeof record.message === 'object' && !Array.isArray(record.message)
      ? record.message as Record<string, unknown>
      : undefined
  return typeof message?.id === 'string' && message.id ? message.id : undefined
}

/**
 * Stable identity for one rendered timeline row.
 *
 * Array position is not an identity: the store folds stream placeholders away
 * (`message_update` -> `message_end`, tool start/update -> end) and trims the oldest
 * entries on very long sessions, so an index shifts under the reader. Remounting on
 * that shift silently collapsed whatever had been unfolded, so rows are keyed by the
 * record they carry (session entry id, then message id, then tool call id).
 */
export function entryAnchorKey(entry: unknown, index: number): string {
  const entryId = entryIdOf(entry)
  if (entryId) return `entry:${entryId}`
  const messageId = entryMessageId(entry)
  if (messageId) return `message:${messageId}`
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>
    const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined
    const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId
      : typeof data?.toolCallId === 'string' ? data.toolCallId
        : typeof data?.tool_call_id === 'string' ? data.tool_call_id : undefined
    if (toolCallId) return `tool:${toolCallId}:${String(record.type ?? '')}`
    return `pos:${index}:${String(record.type ?? '')}`
  }
  return `pos:${index}`
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
    <div className="overflow-hidden rounded-lg border border-dashed border-border bg-bg-elevated/60">
      <button
        type="button"
        aria-expanded={open}
        title={open ? '收起思考过程' : '展开思考过程'}
        onClick={() => setOpen(value => !value)}
        className="group/think flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left text-2xs text-muted transition-colors hover:text-text"
      >
        <LineIcon name="chevronDown" className={`h-3.5 w-3.5 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
        <span className="shrink-0 font-medium text-muted-strong">思考过程</span>
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 font-mono text-2xs text-muted">{text.length.toLocaleString()} 字</span>
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
  /** Tool call/result/execution rows folded away. */
  tools: number
  /** Thinking entries folded away. */
  thinking: number
  /** Extension telemetry rows (`custom` entries, mostly thinking-duration ticks). */
  other: number
}

/**
 * Group live entries into timeline items.
 *
 * @param auxiliary when false, thinking and raw tool/script execution are left
 *                  out of the message timeline; the activity timeline is rendered
 *                  instead. Entries that would render nothing are dropped.
 */
export function groupLiveToolEntries(
  entries: unknown[],
  auxiliary = true,
): { items: LiveTimelineItem[]; hidden: LiveTimelineHidden } {
  const hidden: LiveTimelineHidden = { tools: 0, thinking: 0, other: 0 }
  const result: LiveTimelineItem[] = []
  const toolStates = collectToolStates(entries)
  const renderedRunCodes = new Set<string>()
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
        // Keep the parent call as the render anchor; its result is already in
        // toolStates. A result-only anchor is suppressed by TimelineEntry.
        entry: existing.toolName === 'run_code' && existing.source === 'call' ? existing.entry : item.entry,
        index: existing.toolName === 'run_code' && existing.source === 'call' ? existing.index : item.index,
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
      // Tool execution lifecycle events are rendered as cards by TimelineEntry,
      // but carry no readable message body. Keep them out of compact reading too.
      if (typeof record?.type === 'string' && record.type.startsWith('tool_execution_')) {
        hidden.tools += 1
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

    const message = messageFromEntry(entry)
    const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined
    const data = record?.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : record
    const toolCallId = message?.toolCallId ?? (typeof data?.toolCallId === 'string' ? data.toolCallId : typeof data?.tool_call_id === 'string' ? data.tool_call_id : undefined)
    const state = toolCallId ? toolStates.get(toolCallId) : undefined
    if (state?.parentToolCallId) return
    if (state?.toolName === 'run_code' && state.called && typeof record?.type === 'string' && record.type.startsWith('tool_execution_')) return
    if (state?.nestedTools?.length && !state.called) {
      if (renderedRunCodes.has(state.toolCallId)) return
      renderedRunCodes.add(state.toolCallId)
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

export type ToolState = {
  toolCallId: string
  toolName?: string
  called: boolean
  started: boolean
  ended: boolean
  abandoned: boolean
  isError?: boolean
  errorText?: string
  command?: string
  argsText?: string
  timestamp?: string
  /** Epoch ms of the first call/start event, and of the terminal event — drives command chips. */
  startedAtMs?: number
  endedAtMs?: number
  parentToolCallId?: string
  nestedTools?: ToolState[]
  partialText?: string
  executionResult?: string
  result?: { text: string; toolName?: string; isError?: boolean; timestamp?: string }
}

export type ToolStateMap = Map<string, ToolState>

function partialText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const record = value as Record<string, unknown>
  return textContent(record.content) || (typeof record.text === 'string' ? record.text : '')
}

function toolTerminalMessage(state?: ToolState): string | undefined {
  if (!state || state.result) return undefined
  if (state.abandoned) return state.errorText || '未收到工具完成结果；该调用已停止显示为运行中。'
  if (state.ended) return state.errorText || (state.isError ? '工具执行失败，但没有返回结果文本。' : '工具已结束，但没有返回结果文本。')
  return undefined
}

export function collectToolStates(entries: unknown[]): ToolStateMap {
  const states: ToolStateMap = new Map()
  const ensure = (toolCallId: string): ToolState => {
    const existing = states.get(toolCallId)
    if (existing) return existing
    const created: ToolState = { toolCallId, called: false, started: false, ended: false, abandoned: false }
    states.set(toolCallId, created)
    return created
  }
  for (const entry of entries) {
    const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined
    if (record?.type === 'compaction_end' || record?.type === 'agent_settled') {
      for (const state of states.values()) {
        if (!state.result && !state.ended && (state.started || state.called)) state.abandoned = true
      }
      continue
    }

    const message = messageFromEntry(entry)
    if (message?.role === 'assistant') {
      for (const part of contentParts(message.content)) {
        if (part.type !== 'toolCall' || typeof part.id !== 'string') continue
        const state = ensure(part.id)
        state.called = true
        if (typeof part.name === 'string') state.toolName = part.name
        const argumentsValue = part.arguments
        state.argsText = typeof argumentsValue === 'string' ? argumentsValue : JSON.stringify(argumentsValue ?? {})
        state.timestamp = entryTimestamp(entry)
        state.startedAtMs ??= entryTimestampMs(entry)
        if (argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
          const argumentsRecord = argumentsValue as Record<string, unknown>
          if (typeof argumentsRecord.command === 'string') state.command = argumentsRecord.command
        }
      }
    }
    if (message?.role === 'toolResult' && message.toolCallId) {
      const state = ensure(message.toolCallId)
      state.result = { text: message.text, toolName: message.toolName, isError: message.isError, timestamp: entryTimestamp(entry) }
      state.endedAtMs ??= entryTimestampMs(entry)
      state.abandoned = false
      state.isError = message.isError === true
      if (message.toolName) state.toolName = message.toolName
    }
    if (!record || typeof record.type !== 'string' || !record.type.startsWith('tool_execution_')) continue
    const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : record
    if (typeof data.toolCallId !== 'string') continue
    const state = ensure(data.toolCallId)
    if (typeof data.toolName === 'string') state.toolName = data.toolName
    if (data.args !== undefined) state.argsText = typeof data.args === 'string' ? data.args : JSON.stringify(data.args)
    state.timestamp ||= entryTimestamp(entry)
    if (record.type === 'tool_execution_start' || record.type === 'tool_execution_update') {
      if (record.type === 'tool_execution_start') state.startedAtMs = entryTimestampMs(entry) ?? state.startedAtMs
      state.started = true
      state.abandoned = false
    }
    if (record.type === 'tool_execution_end') {
      state.endedAtMs = entryTimestampMs(entry) ?? state.endedAtMs
      state.ended = true
      state.abandoned = false
      state.isError = data.isError === true || data.isError === 'true'
      state.executionResult = partialText(data.result)
      // `result` 是工具的正常输出（成功时同样有），不能当错误文本，否则弹层里
      // 「错误」永远等于输出全文；pi 的 tool_execution_end 只有 `error` 是错误通道。
      if (typeof data.error === 'string' && data.error) state.errorText = data.error
    }
    if (record.type === 'tool_execution_update') state.partialText = partialText(data.partialResult)
  }
  // Code Mode emits internal calls as <parent>:code:<sequence>. Do not infer
  // ownership from position: the recorded parent must be a run_code call.
  for (const state of states.values()) {
    const parentId = /^(.*):code:\d+$/.exec(state.toolCallId)?.[1]
    const parent = parentId ? states.get(parentId) : undefined
    if (parent?.toolName !== 'run_code') continue
    state.parentToolCallId = parent.toolCallId
    if (!parent.nestedTools) parent.nestedTools = []
    parent.nestedTools.push(state)
  }
  return states
}

type ActivityCandidate = {
  key: string
  index: number
  toolName: string
  toolCallId?: string
  argsText?: string
  detail?: string
  isError?: boolean
  ended?: boolean
  started?: boolean
}

function objectArgs(value?: string): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function shortTarget(value: unknown, max = 42): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const normalized = value.split('\n').join(' ').split('\t').join(' ').replace(/ {2,}/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

/** 命令简介：去掉无信息量的 `cd xxx &&` 前缀，压成一行并截断，让用户扫一眼就知道在跑什么。 */
function commandHint(command?: string): string | undefined {
  if (!command) return undefined
  const stripped = command.trim().replace(/^cd\s+[^&|;]+?\s*&&\s*/, '')
  if (!stripped) return undefined
  const compact = compactCommand(stripped)
  return stripped.length > compact.length ? `${compact}…` : compact
}

function activityAction(toolName: string, argsText?: string, detail?: string): { label: string; detail?: string; path?: string; isTest: boolean; isShell?: boolean } {
  const name = toolName.toLowerCase().replace(/[_-]+/g, ' ')
  const args = objectArgs(argsText)
  const pathValue = typeof args.path === 'string' ? args.path : typeof args.filePath === 'string' ? args.filePath : typeof args.file_path === 'string' ? args.file_path : undefined
  const file = pathValue?.split('/').filter(Boolean).pop()
  const extension = file?.split('.').pop()?.toLowerCase()
  const codeFile = ['c', 'cc', 'cpp', 'cs', 'go', 'java', 'js', 'jsx', 'mjs', 'py', 'rb', 'rs', 'ts', 'tsx', 'vue', 'svelte'].includes(extension || '')
  const normalizedPath = (pathValue || '').toLowerCase()
  const testFile = /(?:^|[._-])(?:test|spec)(?:[._-]|$)/i.test(file || '') || normalizedPath.includes('/test/') || normalizedPath.includes('/tests/') || (file || '').toLowerCase().startsWith('test_')
  const command = typeof args.command === 'string' ? args.command : detail || ''
  const normalizedCommand = command.toLowerCase()
  const query = typeof args.query === 'string' ? args.query : typeof args.pattern === 'string' ? args.pattern : undefined

  if (/^(?:edit|write|apply patch|patch|replace)$/.test(name)) {
    return { label: testFile ? '编写回归测试' : codeFile ? '修改代码' : '修改文件', ...(file ? { detail: file } : {}), ...(pathValue ? { path: pathValue } : {}), isTest: false }
  }
  if (/^(?:read|open|view|list files?)$/.test(name)) {
    return { label: testFile ? '检查测试用例' : codeFile ? '检查代码逻辑' : '读取文件', ...(file ? { detail: file } : {}), ...(pathValue ? { path: pathValue } : {}), isTest: false }
  }
  if (/web|browser|knowledge|fetch url/.test(name)) {
    return { label: '查找资料', ...(query ? { detail: shortTarget(query) } : {}), isTest: false }
  }
  if (/search|grep|ripgrep|find files?/.test(name)) {
    return { label: '搜索代码或文件', ...(query ? { detail: shortTarget(query) } : {}), isTest: false }
  }
  const shellLike = name === 'bash' || name === 'shell' || name === 'sh'
  if (shellLike || typeof args.command === 'string') {
    const hint = commandHint(command)
    // 摘要标签告诉你「在做什么」，命令简介告诉你「具体跑的是哪条命令」。
    const withHint = (label: string) => ({ label, ...(hint ? { detail: hint } : {}), isTest: false, isShell: true })
    const testRunners = ['npm run test', 'npm test', 'pnpm test', 'yarn test', 'pytest', 'vitest', 'jest', 'mocha', 'cargo test']
    const commandTokens = normalizedCommand.split(' ').filter(Boolean)
    const runner = testRunners.find(value => normalizedCommand.includes(value))
      || (['npm', 'pnpm', 'yarn'].includes(commandTokens[0] || '') && commandTokens.includes('test') ? 'test' : undefined)
    if (runner) return { label: '运行回归测试', ...(hint ? { detail: hint } : { detail: runner }), isTest: true, isShell: true }
    if (['tsc', 'typecheck', 'mypy', 'pyright'].some(value => normalizedCommand.includes(value))) return withHint('运行类型检查')
    if (['eslint', 'ruff', 'flake8', 'pylint'].some(value => normalizedCommand.includes(value))) return withHint('运行代码检查')
    if (['build', 'vite build', 'webpack', 'rollup'].some(value => normalizedCommand.includes(value))) return withHint('构建项目')
    if (['rg ', 'grep ', 'find ', 'fd '].some(value => normalizedCommand.includes(value))) return withHint('搜索代码或文件')
    if (['git status', 'git diff', 'git log', 'git show'].some(value => normalizedCommand.includes(value))) return withHint('检查代码变更')
    if (['python', 'node ', 'ruby '].some(value => normalizedCommand.includes(value))) return withHint('运行脚本')
    return withHint('执行命令')
  }
  return { label: '调用外部工具', isTest: false }
}

const textOf = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
const numberOf = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** `background-commands` 快照按 toolCallId 建索引：认出「已经在后台」的那条命令。 */
function backgroundTaskMap(features?: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  if (!features) return map
  for (const task of backgroundTasks(features)) {
    const id = textOf(task.toolCallId)
    if (id) map.set(id, task)
  }
  return map
}

/**
 * 命令类步骤的完整信息：活动视图里的 chip、详情弹层、以及「转后台」都靠它。
 * 状态优先取工具事件（更及时），快照补齐目录 / 退出码 / 是否已在后台。
 */
function activityCommand(command: string | undefined, toolCallId: string | undefined, state: ToolState | undefined, task?: Record<string, unknown>): ActivityCommand | undefined {
  const text = command?.trim()
  if (!text) return undefined
  const startedAt = state?.startedAtMs ?? numberOf(task?.startedAt)
  const endedAt = state?.endedAtMs ?? numberOf(task?.endedAt)
  const output = state?.result?.text || state?.partialText || textOf(task?.outputTail)
  const exitCode = typeof task?.exitCode === 'number' || typeof task?.exitCode === 'string' ? task.exitCode as number | string : undefined
  const error = state?.errorText || textOf(task?.error)
  // 快照里 mode 为 foreground 的是前台镜像，同一进程已经转走或本来就是后台才算后台任务。
  const background = Boolean(task) && task?.mode !== 'foreground'
  return {
    command: text,
    ...(toolCallId ? { toolCallId } : {}),
    ...(textOf(task?.cwd) ? { cwd: textOf(task?.cwd) as string } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(output ? { output } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(error ? { error } : {}),
    ...(background ? { background } : {}),
  }
}

function passingTestCount(text: string): string | undefined {
  const matches = [...text.matchAll(/Tests? +[0-9]+ +passed/gi)]
  const count = matches[matches.length - 1]?.[0].match(/[0-9]+/)?.[0]
  return count ? `${count} 项通过` : undefined
}

function collectLiveActivityEvidence(entries: unknown[], features?: Record<string, unknown>): ActivityStep[] {
  const candidates = new Map<string, ActivityCandidate>()
  const states = collectToolStates(entries)
  // 没显式给快照时自己从条目里取：调用方（含测试）不必先拼一遍 features。
  const tasks = backgroundTaskMap(features ?? collectLiveFeatures(entries))

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    for (const item of liveToolItems(index, entry)) {
      const key = item.toolCallId || item.key
      const existing = candidates.get(key)
      if (item.source === 'call') {
        if (existing) {
          existing.argsText ||= item.argsText
          existing.detail ||= item.detail
          continue
        }
        candidates.set(key, {
          key,
          index,
          toolName: item.toolName,
          ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
          ...(item.argsText ? { argsText: item.argsText } : {}),
          ...(item.detail ? { detail: item.detail } : {}),
        })
      } else if (existing) {
        existing.isError = item.isError || existing.isError
      } else {
        candidates.set(key, {
          key,
          index,
          toolName: item.toolName,
          ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
          isError: item.isError,
        })
      }
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.type !== 'string' || !record.type.startsWith('tool_execution_')) continue
    const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : record
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined
    if (!toolCallId && record.type === 'tool_execution_update') continue
    const key = toolCallId || `event:${index}`
    const existing = candidates.get(key)
    const payload = data.input ?? data.args
    const argsText = typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object'
        ? JSON.stringify(payload)
        : typeof data.command === 'string' ? JSON.stringify({ command: data.command }) : undefined
    const detail = typeof data.command === 'string' ? data.command : undefined
    if (existing) {
      existing.argsText ||= argsText
      existing.detail ||= detail
      existing.isError = data.isError === true || data.isError === 'true' || existing.isError
      existing.ended ||= record.type === 'tool_execution_end'
      existing.started ||= record.type === 'tool_execution_start' || record.type === 'tool_execution_update'
    } else {
      candidates.set(key, {
        key,
        index,
        toolName: typeof data.toolName === 'string' ? data.toolName : 'tool',
        ...(toolCallId ? { toolCallId } : {}),
        ...(argsText ? { argsText } : {}),
        ...(detail ? { detail } : {}),
        isError: data.isError === true || data.isError === 'true',
        ended: record.type === 'tool_execution_end',
        started: record.type === 'tool_execution_start' || record.type === 'tool_execution_update',
      })
    }
  }

  return [...candidates.values()]
    .sort((left, right) => left.index - right.index)
    .map(candidate => {
      const state = candidate.toolCallId ? states.get(candidate.toolCallId) : undefined
      const task = candidate.toolCallId ? tasks.get(candidate.toolCallId) : undefined
      // 有些命令只有后台快照、没有工具事件；这种“还在跑”不能算未完成。
      const taskRunning = typeof task?.status === 'string' && RUNNING_COMMAND_TASK.has(task.status)
      const isError = candidate.isError || state?.result?.isError === true || state?.isError === true || state?.abandoned === true
      const status: ActivityStep['status'] = isError
        ? 'error'
        : state?.result || state?.ended || candidate.ended
          ? 'done'
          : state?.started || candidate.started || taskRunning
            ? 'running'
            : 'pending'
      const rawCommand = candidate.detail || state?.command
      const action = activityAction(candidate.toolName, candidate.argsText, rawCommand)
      const testCount = action.isTest && status === 'done' ? passingTestCount(state?.result?.text || '') : undefined
      const command = action.isShell ? activityCommand(rawCommand, candidate.toolCallId, state, candidate.toolCallId ? tasks.get(candidate.toolCallId) : undefined) : undefined
      return {
        id: candidate.key,
        label: action.label,
        detail: [action.detail, testCount].filter(Boolean).join(' · ') || undefined,
        ...(action.path ? { path: action.path } : {}),
        ...(command ? { command } : {}),
        status,
        entryIndex: candidate.index,
      }
    })
}

export function buildLiveActivityEvidence(entries: unknown[], features?: Record<string, unknown>): ActivityStep[] {
  return collectLiveActivityEvidence(entries, features).slice(-6)
}

function entryChannel(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined
  const message = record.message && typeof record.message === 'object' && !Array.isArray(record.message)
    ? record.message as Record<string, unknown>
    : data?.message && typeof data.message === 'object' && !Array.isArray(data.message)
      ? data.message as Record<string, unknown>
      : undefined
  return typeof data?.channel === 'string' ? data.channel : typeof message?.channel === 'string' ? message.channel : typeof record.channel === 'string' ? record.channel : undefined
}

export function currentActivityDescription(entries: unknown[], goal: SessionGoalSummary | null): { title: string; sourceLabel: string; lastSummary?: string } {
  if (goal?.progress.current) return { title: goal.progress.current, sourceLabel: 'Agent 阶段报告', ...(goal.progress.lastSummary ? { lastSummary: goal.progress.lastSummary } : {}) }

  let latestUserIndex = -1
  entries.forEach((entry, index) => {
    if (messageFromEntry(entry)?.role === 'user') latestUserIndex = index
  })
  for (let index = entries.length - 1; index > latestUserIndex; index -= 1) {
    const message = messageFromEntry(entries[index])
    if (message?.role !== 'assistant' || entryChannel(entries[index]) !== 'commentary' || !message.text) continue
    return { title: shortTarget(message.text, 150) || message.text, sourceLabel: 'Agent 进度说明' }
  }

  const currentWorkItem = goal?.workItems.find(item => item.state === 'in_progress')
  if (currentWorkItem) return { title: currentWorkItem.title, sourceLabel: '当前工作项', ...(currentWorkItem.description ? { lastSummary: currentWorkItem.description } : {}) }
  if (goal?.objective && goal.status !== 'complete') return { title: goal.objective, sourceLabel: '任务目标', ...(goal.progress.lastSummary ? { lastSummary: goal.progress.lastSummary } : {}) }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = messageFromEntry(entries[index])
    if (message?.role === 'user' && message.text) return { title: shortTarget(message.text, 150) || message.text, sourceLabel: '最近用户请求' }
  }
  return { title: '等待 Agent 报告当前工作事项', sourceLabel: '等待进度' }
}

type ActivityReport = {
  title: string
  sourceLabel: string
  index: number
  lastSummary?: string
  completed?: boolean
  /** 计划要点（如 goal 工作项），展示在用户请求下方而不混进实际步骤。 */
  planItems?: ActivityStep[]
  /** Agent 对需求的理解与计划（动手之前的说明），不放回复区。 */
  planLines?: string[]
  images?: ActivityImage[]
}

/** 把 goal 工作项映射成计划要点，保留其真实状态。 */
function goalPlanItems(workItems: readonly SessionGoalWorkItem[], index: number): ActivityStep[] {
  return workItems.flatMap(item => {
    const label = shortTarget(item.title, 150)
    if (!label) return []
    const status: ActivityStep['status'] = item.state === 'done'
      ? 'done'
      : item.state === 'in_progress'
        ? 'running'
        : item.state === 'blocked' ? 'blocked' : 'pending'
    const detail = shortTarget(item.description, 180)
    return [{
      id: `goal-work:${item.id}`,
      label,
      ...(detail ? { detail } : {}),
      status,
      entryIndex: index,
    }]
  })
}

function goalActivityReport(entry: unknown, index: number): ActivityReport | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  if (record.type !== 'custom' || record.customType !== 'goal-state') return undefined
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined
  const state = data?.state && typeof data.state === 'object' && !Array.isArray(data.state) ? data.state as Record<string, unknown> : undefined
  const progress = state?.progress && typeof state.progress === 'object' && !Array.isArray(state.progress) ? state.progress as Record<string, unknown> : undefined
  const title = shortTarget(progress?.current, 150) ?? ''
  const lastSummary = shortTarget(progress?.lastSummary, 180)
  const workItems = (Array.isArray(state?.workItems) ? state.workItems : []).flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const item = value as Record<string, unknown>
    const label = shortTarget(item.title, 150)
    if (!label) return []
    return [{
      id: typeof item.id === 'string' ? item.id : label,
      title: label,
      ...(shortTarget(item.description, 180) ? { description: shortTarget(item.description, 180) } : {}),
      ...(typeof item.state === 'string' ? { state: item.state as SessionGoalWorkItem['state'] } : {}),
      dependsOn: [],
    }]
  })
  const planItems = goalPlanItems(workItems, index)
  // 目标收尾或只有清单、没有「当前正在做」时，工作项仍然是该活动的计划要点 ——
  // 只是没有可以当标题的句子，交给调用方沿用当前活动标题。
  if (!title && !lastSummary && planItems.length === 0) return undefined
  return {
    // 被快照钉住带到末尾的状态是「当前状态」而不是新阶段：只补充计划/小结，不开新活动。
    title: record.pinned === true ? '' : title,
    sourceLabel: 'Agent 阶段报告',
    index,
    ...(lastSummary ? { lastSummary } : {}),
    ...(planItems.length ? { planItems } : {}),
    ...(state?.status === 'complete' ? { completed: true } : {}),
  }
}

export function buildLiveActivities(entries: unknown[], sessionStatus: string, goal: SessionGoalSummary | null, features?: Record<string, unknown>): LiveActivity[] {
  const evidenceByIndex = new Map<number, ActivityStep[]>()
  for (const step of collectLiveActivityEvidence(entries, features)) {
    const existing = evidenceByIndex.get(step.entryIndex) || []
    existing.push(step)
    evidenceByIndex.set(step.entryIndex, existing)
  }

  const activities: LiveActivity[] = []
  const settled = new Set<string>()
  let current: LiveActivity | undefined
  let pendingCommentary: ActivityReport | undefined
  // Pi 正在干活时发来的输入只是排队：它不属于新活动，后续步骤也仍然属于旧活动。
  let agentBusy = false
  // 历史会话没有 agent_start：工具消息也能说明当前工作尚未结束。
  let assistantWorking = false
  // 上一个回合真正结束的位置：它之后的 agent 文字已经是新排队输入的答复。
  let lastSettledIndex = -1
  const queuedInputs: Array<{ text: string; index: number; deliverAs?: string }> = []
  const queuedUserImages = new Map<number, ActivityImage[]>()
  const queueInput = (activity: LiveActivity | undefined, text: string, index: number, deliverAs?: string): void => {
    if (!activity) return
    const queued = activity.queuedInputs || []
    if (!queued.includes(text)) activity.queuedInputs = [...queued, text]
    if (!queuedInputs.some(item => item.text === text)) queuedInputs.push({ text, index, ...(deliverAs ? { deliverAs } : {}) })
  }
  const dropQueuedInput = (text: string): void => {
    for (const activity of activities) {
      if (!activity.queuedInputs?.includes(text)) continue
      activity.queuedInputs = activity.queuedInputs.filter(item => item !== text)
    }
  }
  /**
   * 引用 / 批注是对已经做完那件事的追问。
   *
   * 把它当新用户请求另开一个活动，会把同一件事拆成两段，前因后果说不清；
   * 所以并入它指向的那个活动（原文找不到时并入当前活动），接下来的执行也留在这里。
   */
  const attachFollowUp = (activity: LiveActivity, text: string, index: number, kind: FollowUpKind, queued: boolean): void => {
    const list = activity.followUps || []
    if (list.some(item => item.entryIndex === index)) return
    const anchor = entryIdOf(entries[index]) ?? entryMessageId(entries[index])
    activity.followUps = [...list, { id: `follow-up-${anchor ?? index}`, kind, text, entryIndex: index, ...(queued ? { queued: true } : {}) }]
  }
  /** 引用/批注指向的活动：拿引文去活动的计划与回复里找，找不到就不自带归属。 */
  const quoteOwner = (text: string): LiveActivity | undefined => {
    const flat = (value: string): string => value.replace(/\s+/g, ' ').trim()
    for (const snippet of quotedSnippets(text)) {
      // 引文是长度截断过的片段，去掉省略号再比。
      // 下限按字符数算（中文一句话只有十来个字），太短的片段容易误命中，不作线索。
      const needle = flat(snippet).replace(/…$/, '')
      if (needle.length < 8) continue
      for (let index = activities.length - 1; index >= 0; index -= 1) {
        const notes = [...(activities[index].plan?.lines || []), ...activities[index].replies, ...(activities[index].followUps || [])]
        if (notes.some(note => flat(note.text).includes(needle))) return activities[index]
      }
    }
    return undefined
  }
  const mergePlan = (activity: LiveActivity, report: ActivityReport): void => {
    const hasPlan = (report.planLines?.length || 0) > 0 || (report.planItems?.length || 0) > 0
    if (!hasPlan) return
    const plan = activity.plan || { lines: [], items: [] }
    // 标题已经就是这句话时不再重复一遍。
    const entryId = entryIdOf(entries[report.index])
    for (const line of report.planLines || []) {
      if (line === activity.title || plan.lines.some(note => note.text === line)) continue
      plan.lines.push({ text: line, entryIndex: report.index, related: [], ...(entryId ? { entryId } : {}) })
    }
    for (const item of report.planItems || []) {
      const existingIndex = plan.items.findIndex(candidate => candidate.id === item.id)
      if (existingIndex >= 0) plan.items[existingIndex] = { ...item, entryIndex: plan.items[existingIndex].entryIndex }
      else plan.items.push(item)
    }
    plan.items.sort((left, right) => left.entryIndex - right.entryIndex)
    activity.plan = plan
  }
  const startActivity = (report: ActivityReport): LiveActivity => {
    // The activity id carries the reader's unfold state. Anchor it to the entry that
    // started the activity, so a rebuilt snapshot (or a trimmed head) that shifts
    // every index does not make the whole timeline look like new cards.
    const anchor = entryIdOf(entries[report.index]) ?? entryMessageId(entries[report.index])
    const baseId = anchor ? `activity-${anchor}` : `activity-${report.index}-${activities.length}`
    const activity: LiveActivity = {
      id: activities.some(item => item.id === baseId) ? `${baseId}-${activities.length}` : baseId,
      title: report.title,
      sourceLabel: report.sourceLabel,
      status: 'pending',
      steps: [],
      replies: [],
      ...(report.images?.length ? { images: report.images } : {}),
      ...(entryTimestamp(entries[report.index]) ? { startedAt: entryTimestamp(entries[report.index]) } : {}),
      ...(report.lastSummary ? { lastSummary: report.lastSummary } : {}),
    }
    mergePlan(activity, report)
    activities.push(activity)
    current = activity
    return activity
  }
  const updateActivity = (activity: LiveActivity, report: ActivityReport): LiveActivity => {
    // 报告可以不带标题（例如只有工作项、没有「当前正在做」）；那就不动现有标题。
    if (report.title) activity.title = report.title
    activity.sourceLabel = report.sourceLabel
    activity.startedAt ||= entryTimestamp(entries[report.index])
    if (report.lastSummary) activity.lastSummary = report.lastSummary
    mergePlan(activity, report)
    return activity
  }
  const ensureFallbackActivity = (index: number): LiveActivity => current || startActivity({
    title: '正在处理会话任务',
    sourceLabel: '执行记录',
    index,
  })
  /**
   * 占位活动只装「还归不到请求头上」的执行记录，没有真实请求标题。
   *
   * 它不是正在进行的请求，所以新请求不能被它当成「排队输入」吞进去：`agent_start` /
   * `turn_start` 常常比用户消息先到一步，照旧判断会把用户请求挂成排队输入，等工作跑完
   * 才在下一个回合边界另开活动，留下一条孤零零的「正在处理会话任务」。
   */
  const isPlaceholderActivity = (activity: LiveActivity | undefined): boolean => !!activity
    && activity.title === '正在处理会话任务'
    && activity.sourceLabel === '执行记录'
  const startUserActivity = (report: ActivityReport): LiveActivity => {
    const fallback = current
    const hasPlan = (fallback?.plan?.lines.length || 0) > 0 || (fallback?.plan?.items.length || 0) > 0
    if (fallback?.title === '正在处理会话任务'
      && fallback.sourceLabel === '执行记录'
      && fallback.replies.length === 0
      && !fallback.lastSummary
      && !hasPlan
      && !(fallback.followUps?.length)
      && !(fallback.queuedInputs?.length)) {
      fallback.title = report.title
      fallback.sourceLabel = report.sourceLabel
      fallback.startedAt ||= entryTimestamp(entries[report.index])
      if (report.images?.length) fallback.images = [...(fallback.images || []), ...report.images]
      settled.delete(fallback.id)
      mergePlan(fallback, report)
      current = fallback
      return fallback
    }
    // 占位活动装的是新请求到来前已经跑完的执行记录；结束信号（agent_settled）只打给当前活动，
    // 新请求另立活动后它永远等不到结算、会一直挂「未完成」，这里直接补结算。
    if (fallback?.title === '正在处理会话任务' && fallback.sourceLabel === '执行记录') settled.add(fallback.id)
    return startActivity(report)
  }
  // Agent 正文（进度说明与最终回复）跟着它所属的活动走；重复的流式片段只留一条。
  const attachReply = (activity: LiveActivity, text: string, kind: ActivityReply['kind'], index: number): void => {
    const previous = activity.replies[activity.replies.length - 1]
    if (previous && previous.text === text) return
    const entryId = entryIdOf(entries[index])
    // Reply ids are unfold-state keys too; keep them on the message, not its position.
    const anchor = entryId ?? entryMessageId(entries[index])
    activity.replies.push({ id: anchor ? `reply-${anchor}` : `reply-${index}-${activity.replies.length}`, text, kind, entryIndex: index, related: [], ...(entryId ? { entryId } : {}) })
  }
  // 动手之前（还没有任何步骤）的说明是 agent 的理解与计划，不再当回复展示。
  const rememberPlan = (activity: LiveActivity, text: string, index: number): void => {
    if (text === activity.title) return
    const plan = activity.plan || { lines: [], items: [] }
    if (plan.lines.some(note => note.text === text)) return
    const entryId = entryIdOf(entries[index])
    plan.lines.push({ text, entryIndex: index, related: [], ...(entryId ? { entryId } : {}) })
    activity.plan = plan
  }
  // 没能开新活动的进度说明，归到当前活动的回复区，避免正文丢失。
  const flushCommentaryAsReply = (report: ActivityReport): void => {
    if (!current) return
    for (const line of report.planLines || []) attachReply(current, line, 'commentary', report.index)
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined
    const message = messageFromEntry(entry)
    const userInput = message?.role === 'user' && message.text ? userActivityInput(message.content, message.text) : undefined
    const goalReport = goalActivityReport(entry, index)

    const queuedDelivery = pendingDeliveryOf(entry)
    // 引用 / 批注是追问，不是新请求：并入所属活动，别把工作切成两段。
    const followUpKind = message?.role === 'user' && message.text ? quoteOrCommentKind(message.text) : undefined
    if (message?.role === 'user' && message.text && followUpKind) {
      if (pendingCommentary && current) current.lastSummary = pendingCommentary.title
      pendingCommentary = undefined
      // 执行中的引用是补充当前要求，不应把整段后续工作搬回被引用的旧活动。
      // 空闲后重新追问旧回复，才按引用内容找回原活动。
      const target = (current && (agentBusy || assistantWorking) ? current : quoteOwner(message.text))
        || current || ensureFallbackActivity(index)
      attachFollowUp(target, message.text, index, followUpKind, Boolean(queuedDelivery || agentBusy))
      if (userInput?.images.length) target.images = [...(target.images || []), ...userInput.images]
      // 后续执行也要留在同一个活动里，否则等于又拆开了。
      current = target
    } else if (message?.role === 'user' && message.text && (queuedDelivery || agentBusy) && !!current && !isPlaceholderActivity(current)) {
      // 排队输入：先挂在当前活动上，等 Pi 真正接手（下一次 agent_start）再单独成活动。
      if (pendingCommentary && current) current.lastSummary = pendingCommentary.title
      pendingCommentary = undefined
      if (userInput?.images.length) {
        if (queuedDelivery?.deliverAs === 'steer') {
          const target = current || ensureFallbackActivity(index)
          target.images = [...(target.images || []), ...userInput.images]
        } else queuedUserImages.set(index, userInput.images)
      }
      queueInput(current || ensureFallbackActivity(index), userInput?.title || message.text, index, queuedDelivery?.deliverAs)
    } else if (message?.role === 'user' && message.text) {
      if (pendingCommentary) {
        flushCommentaryAsReply(pendingCommentary)
        if (current) current.lastSummary = pendingCommentary.title
      }
      pendingCommentary = undefined
      startUserActivity({
        title: userInput?.title || shortTarget(message.text, 150) || message.text,
        sourceLabel: '用户请求',
        index,
        ...(userInput?.images.length ? { images: userInput.images } : {}),
      })
    } else if (goalReport) {
      if (pendingCommentary) flushCommentaryAsReply(pendingCommentary)
      pendingCommentary = undefined
      // 目标状态只带来工作项时，挂到当前活动上；别为它单开一个没有标题的活动。
      if (!goalReport.title) updateActivity(current || ensureFallbackActivity(index), goalReport)
      else if (!current) startActivity(goalReport)
      else if (current.title === goalReport.title) updateActivity(current, goalReport)
      else if (current.steps.length === 0) updateActivity(current, goalReport)
      else {
        startActivity(goalReport)
      }
      if (goalReport.completed && current) settled.add(current.id)
    } else if (message?.role === 'assistant' && entryChannel(entry) === 'commentary' && message.text) {
      const report: ActivityReport = {
        title: shortTarget(message.text, 150) || message.text,
        sourceLabel: 'Agent 进度说明',
        index,
        planLines: [message.text],
      }
      if (!current) startActivity(report)
      else if (current.steps.length === 0) rememberPlan(current, message.text, index)
      else if (current.title !== report.title) pendingCommentary = report
      else attachReply(current, message.text, 'commentary', index)
    } else if (message?.role === 'assistant' && message.text && (entryChannel(entry) === undefined || entryChannel(entry) === 'final')) {
      const activity = current || startActivity({ title: shortTarget(message.text, 150) || message.text, sourceLabel: 'Agent 回复', index })
      // 夹在工具调用里的文字只是过程中的说明，不算最终回复。
      const intermediate = contentParts(message.content).some(part => part.type === 'thinking' || part.type === 'toolCall')
      attachReply(activity, message.text, intermediate ? 'commentary' : 'final', index)
    }

    const steps = evidenceByIndex.get(index) || []
    if (steps.length > 0) {
      if (pendingCommentary && current && pendingCommentary.title !== current.title) {
        startActivity(pendingCommentary)
      } else if (pendingCommentary && current) {
        flushCommentaryAsReply(pendingCommentary)
        if (pendingCommentary.lastSummary) current.lastSummary = pendingCommentary.lastSummary
      }
      pendingCommentary = undefined
      const activity = ensureFallbackActivity(index)
      activity.steps.push(...steps)
    }

    const channel = entryChannel(entry)
    const hasHiddenOrToolParts = message?.role === 'assistant' && contentParts(message.content).some(part => part.type === 'thinking' || part.type === 'toolCall')
    if (message?.role === 'assistant' && hasHiddenOrToolParts) assistantWorking = true
    if (current && message?.role === 'assistant' && message.text && (channel === undefined || channel === 'final') && !hasHiddenOrToolParts) {
      assistantWorking = false
      settled.add(current.id)
    }

    if (record?.type === 'agent_start' || record?.type === 'turn_start') {
      agentBusy = true
      if (current) settled.delete(current.id)
      // Pi 开始处理回合：追问里「排队中」的标记可以收了。
      for (const activity of activities) {
        for (const item of activity.followUps || []) {
          if (item.queued && item.entryIndex < index) delete item.queued
        }
      }
      // 新回合开始了：Pi 接下来处理的就是排队中的那条输入（插话除外，它属于当前活动）。
      const promotedIndex = queuedInputs.findIndex(item => item.deliverAs !== 'steer')
      if (promotedIndex >= 0) {
        const [promoted] = queuedInputs.splice(promotedIndex, 1)
        if (promoted) {
          dropQueuedInput(promoted.text)
          const images = queuedUserImages.get(promoted.index)
          queuedUserImages.delete(promoted.index)
          const started = startUserActivity({ title: shortTarget(promoted.text, 150) || promoted.text, sourceLabel: '用户请求', index: promoted.index, ...(images?.length ? { images } : {}) })
          // Pi 接手前，agent 已经为这条排队输入写下的计划与回复要跟着搬进新活动，
          // 否则它们会被留在上一个活动里（用户看到的错位就是这里）。
          const boundary = Math.max(promoted.index, lastSettledIndex)
          for (const activity of activities) {
            if (activity.id === started.id) continue
            const movedReplies = activity.replies.filter(reply => reply.entryIndex > boundary)
            if (movedReplies.length === 0) continue
            activity.replies = activity.replies.filter(reply => reply.entryIndex <= boundary)
            started.replies.push(...movedReplies)
            started.replies.sort((left, right) => left.entryIndex - right.entryIndex)
            const movedPlan = (activity.plan?.lines || []).filter(line => line.entryIndex > boundary)
            if (movedPlan.length > 0 && activity.plan) {
              activity.plan.lines = activity.plan.lines.filter(line => line.entryIndex <= boundary)
              const plan = started.plan || { lines: [], items: [] }
              plan.lines.push(...movedPlan)
              plan.lines.sort((left, right) => left.entryIndex - right.entryIndex)
              started.plan = plan
            }
          }
        }
      }
    } else if (record?.type === 'agent_settled') {
      agentBusy = false
      assistantWorking = false
      lastSettledIndex = index
      if (current) settled.add(current.id)
    } else if (record?.type === 'custom' && record.customType === 'goal-state') {
      const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined
      const state = data?.state && typeof data.state === 'object' && !Array.isArray(data.state) ? data.state as Record<string, unknown> : undefined
      if (state?.status === 'complete' && current) settled.add(current.id)
    }
  }

  if (pendingCommentary && current) {
    flushCommentaryAsReply(pendingCommentary)
    current.lastSummary = pendingCommentary.title
  }
  if (activities.length === 0 && goal) {
    const fallback = currentActivityDescription(entries, goal)
    const fallbackIndex = Math.max(0, entries.length - 1)
    const activity = startActivity({
      ...fallback,
      index: fallbackIndex,
      ...(goal.workItems.length ? { planItems: goalPlanItems(goal.workItems, fallbackIndex) } : {}),
    })
    if (goal.status === 'complete') settled.add(activity.id)
  }

  // 每条说明（计划与回复）带上紧随其后真实发生的动作，让“Docs 同步：”这类短句能说清到底动了什么。
  for (const activity of activities) {
    const notes: ActivityNote[] = [...(activity.plan?.lines || []), ...activity.replies]
      .sort((left, right) => left.entryIndex - right.entryIndex)
    notes.forEach((note, noteIndex) => {
      const until = notes[noteIndex + 1]?.entryIndex ?? Number.POSITIVE_INFINITY
      const related: string[] = []
      for (const step of activity.steps) {
        if (step.entryIndex <= note.entryIndex || step.entryIndex >= until) continue
        const value = step.detail ? `${step.label}：${step.detail}` : step.label
        if (!related.includes(value)) related.push(value)
        if (related.length >= 4) break
      }
      note.related = related
    })
  }

  for (const activity of activities) {
    const planItems = activity.plan?.items || []
    const hasPendingWork = activity.steps.some(step => step.status === 'pending' || step.status === 'blocked')
      || planItems.some(item => item.status === 'pending' || item.status === 'blocked')
    const hasRunning = activity.steps.some(step => step.status === 'running') || planItems.some(item => item.status === 'running')
    const sessionActive = sessionStatus === 'running' || sessionStatus === 'reconnecting'
    if (hasRunning && sessionActive) activity.status = 'running'
    else if (activity === current && sessionActive) activity.status = 'running'
    // 会话都停了、步骤还停在“运行中”：那是被打断，不是还在跑。
    else if (hasRunning) activity.status = 'incomplete'
    else if (hasPendingWork) activity.status = 'incomplete'
    else if (activity.steps.length === 0 && !settled.has(activity.id)) activity.status = 'pending'
    // 单步报错（命令退出码非 0、工具被中断）只标红那一步，不等于这件事没做完：
    // 会话停下、已经被新活动接替、或拿到了收尾信号，都说明这一轮已经结束。
    else activity.status = 'done'
  }
  return activities
}

export type AgentState = {
  label: string
  tone: 'muted' | 'accent' | 'ok' | 'danger'
  activeTools: string[]
  doneTools: number
  thinkingStartedAt?: number
}

export function deriveAgentState(status: string | undefined, entries: unknown[], toolStates: ToolStateMap, compacting = false): AgentState {
  const states = [...toolStates.values()]
  const active = states.filter(state => !state.result && !state.ended && !state.abandoned && (state.started || state.called))
  const running = active.filter(state => state.started)
  const toolNames = (running.length ? running : active).map(state => state.toolName || 'tool')
  const doneTools = states.filter(state => !!state.result || state.ended || state.abandoned).length
  let observedStatus = status
  for (let index = entries.length - 1; index >= 0; index--) {
    const candidate = entries[index]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const type = typeof (candidate as Record<string, unknown>).type === 'string' ? (candidate as Record<string, unknown>).type : ''
    if (type === 'agent_start') { observedStatus = 'running'; break }
    if (type === 'agent_settled') { observedStatus = 'idle'; break }
  }
  if (observedStatus === 'reconnecting') return { label: '重连中', tone: 'danger', activeTools: toolNames, doneTools }
  // A compaction is not an agent run: no tools, no messages of its own, and pi
  // reports it as “not idle” exactly like a running turn. Say what it really is.
  if (compacting) return { label: '压缩上下文', tone: 'accent', activeTools: [], doneTools }
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
  // `startedAt` is the Pi PROCESS start reported by the bridge, so spell that out:
  // “147h46m” is otherwise read as “this conversation”, which after a /clear or a
  // resume is wrong on purpose (the process outlives the session file).
  const elapsed = formatSessionElapsed(now - startedAt)
  return <span title={`本会话的 Pi 进程启动于 ${new Date(startedAt).toLocaleString()}，已运行 ${elapsed}`}>◷ 运行 {elapsed}</span>
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

/**
 * Status-line context bar. The marker position and the whole cell model live in
 * `contextStatusBar.ts`, so the bar is drawn from the SAME trigger the compaction
 * policy uses (and can be unit-tested without rendering this page).
 */
function TuiLikeStatus({ summary }: { summary: LiveSessionSummary }) {
  const usage = summary.contextUsage
  const percent = clampPercent(usage?.percent)
  const trigger = contextTriggerPercent(summary)
  const cells = contextBarCells(percent, trigger)
  const atTrigger = trigger !== undefined && percent !== undefined && percent >= trigger
  const title = summary.compact?.enabled && trigger !== undefined
    ? `上下文占用和 session 运行时间 · 自动压缩触发点 ${formatStatusTokens(summary.compact.triggerTokens)} / ${formatStatusTokens(usage?.contextWindow)}（${summary.compact.candidates.map(candidate => candidate.source).join(' / ') || 'policy'}）`
    : '上下文占用和 session 运行时间 · 自动压缩触发点未知'
  return <span className="flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-2xs text-muted" title={title}>
    {summary.compacting && <span className="text-accent" title="上下文正在压缩：期间发送的消息会排队，压缩完成后自动发送">⟳ 压缩中</span>}
    <span className={percent !== undefined && percent >= 85 ? 'text-warn' : 'text-muted'}>
      {cells.map((cell, index) => cell.threshold
        ? <span key={index} className={atTrigger ? 'text-danger' : 'text-warn'}>{cell.char}</span>
        : cell.char)}
    </span>
    <span>{formatStatusTokens(usage?.tokens)}/{formatStatusTokens(usage?.contextWindow)}</span>
    {percent !== undefined && <span>{Math.round(percent)}%</span>}
    <span>· {summary.mode.toUpperCase()}</span>
    <SessionElapsed startedAt={summary.startedAt} />
  </span>
}

export function RunCodeToolCard({ state }: { state: ToolState }) {
  const [expanded, setExpanded] = useState(true)
  const steps = state.nestedTools ?? []
  const isError = state.result?.isError === true || state.isError === true || state.abandoned
  const status: ToolSummaryStatus = isError ? 'error' : state.result || state.ended ? 'success' : state.started ? 'running' : 'pending'
  const description = objectArgs(state.argsText).description
  const summary = typeof description === 'string' ? description : `${steps.length} 个内部步骤`
  const output = state.result?.text ?? state.executionResult ?? state.partialText ?? toolTerminalMessage(state)
  const tone = isError ? 'border-danger' : status === 'success' ? 'border-ok' : status === 'running' ? 'border-accent' : 'border-border'
  return (
    <article aria-label="Run Code 及内部步骤" className={`w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-l-2 bg-card ${tone}`}>
      <button type="button" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'} Run Code 内部步骤`} onClick={() => setExpanded(value => !value)} className="flex w-full min-w-0 items-center gap-2 border-none bg-transparent px-2.5 py-1.5 text-left hover:bg-bg-hover">
        <span aria-hidden="true" className="shrink-0 text-2xs text-muted">{expanded ? '▾' : '▸'}</span>
        <ToolSummaryLine toolName="run_code" command={summary} timestamp={state.timestamp} status={status} className="flex-1" />
        <span className="shrink-0 text-2xs text-muted">{steps.length} 步</span>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-border px-2 py-2 sm:px-3">
          <ol aria-label="内部工具步骤" className="m-0 list-none space-y-1.5 border-l border-border p-0 pl-2 sm:pl-3">
            {steps.map(step => {
              const result = step.result ?? (step.ended && step.executionResult !== undefined ? { text: step.executionResult, toolName: step.toolName, isError: step.isError, timestamp: step.timestamp } : undefined)
              return <li key={step.toolCallId} className="min-w-0">
                <ToolCallCard name={step.toolName || 'tool'} toolCallId={step.toolCallId} argsText={step.argsText || ''} timestamp={step.timestamp} state={{ ...step, result }} />
              </li>
            })}
          </ol>
          <details className="min-w-0 text-2xs text-muted">
            <summary className="cursor-pointer py-1 hover:text-text">查看代码和汇总结果</summary>
            <div className="space-y-2 pt-1">
              {state.argsText && <pre className="m-0 max-h-[12rem] overflow-auto whitespace-pre-wrap break-words rounded bg-bg-hover p-2 font-mono">{state.argsText}</pre>}
              {output !== undefined && <pre role={isError ? 'alert' : undefined} className="m-0 max-h-[20rem] overflow-auto whitespace-pre-wrap break-words rounded bg-bg-hover p-2 font-mono text-text">{output}</pre>}
            </div>
          </details>
        </div>
      )}
    </article>
  )
}

function ToolCallCard({ name, toolCallId, argsText, timestamp, state }: { name: string; toolCallId?: string; argsText: string; timestamp?: string; state?: ToolState }) {
  if (state?.nestedTools?.length) return <RunCodeToolCard state={state} />
  const result = state?.result
  const terminalMessage = toolTerminalMessage(state)
  const isError = result?.isError === true || state?.isError === true || state?.abandoned === true
  const status: ToolSummaryStatus = isError ? 'error' : result || state?.ended ? 'success' : state?.started || state?.partialText ? 'running' : 'pending'
  const statusTone = status === 'error'
    ? 'border-danger/40 border-l-danger bg-danger-subtle'
    : status === 'success'
      ? 'border-border border-l-ok bg-card'
      : status === 'running'
        ? 'border-accent/40 border-l-accent bg-card'
        : 'border-border bg-card'
  return (
    <article className={`w-full max-w-full overflow-hidden rounded-lg border border-l-2 ${statusTone}`}>
      <details>
        <summary className="flex min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-hover">
          <ToolSummaryLine toolName={name} args={argsText} timestamp={result?.timestamp || timestamp} status={status} className="flex-1" />
        </summary>
        <div className="space-y-2 border-t border-border px-3 pb-3">
          {toolCallId && <div className="pt-2 text-2xs text-muted">tool call {shortToolId(toolCallId)}</div>}
          {argsText && <pre className="m-0 max-h-[12rem] max-w-full overflow-auto whitespace-pre-wrap break-words rounded bg-bg-hover px-2 py-1.5 font-mono text-2xs leading-4 text-muted">{argsText.slice(0, 100_000)}</pre>}
          {terminalMessage && !result && <div role={isError ? 'alert' : 'status'} className={`rounded px-2 py-1 text-2xs ${isError ? 'bg-danger-subtle text-danger' : 'bg-bg-hover text-muted'}`}>{terminalMessage}</div>}
          {!result && state?.partialText && (
            <pre className="m-0 max-h-[150px] overflow-auto whitespace-pre-wrap break-words rounded bg-bg-hover px-2 py-1.5 font-mono text-2xs leading-4 text-text">{state.partialText}</pre>
          )}
          {result && <ToolResultCard text={result.text} toolName={result.toolName || name} toolCallId={toolCallId} command={state?.command} isError={result.isError} timestamp={result.timestamp} revealOnMount />}
        </div>
      </details>
    </article>
  )
}

/**
 * Start of the latest round: the newest user message's timestamp (Pi-host clock).
 *
 * A prompt this browser just sent is shown as a local placeholder with no timestamp
 * until Pi echoes it back. Falling back to the browser clock would compare across
 * hosts, so the boundary becomes “just after everything seen so far” instead — the
 * previous round's finished commands disappear immediately, new ones still qualify.
 */
export function latestUserMessageAt(entries: unknown[], features: Record<string, unknown>): number | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (messageFromEntry(entries[index])?.role !== 'user') continue
    const at = entryTimestampMs(entries[index])
    if (at !== undefined) return at
    let latest: number | undefined
    const bump = (value: unknown) => { if (typeof value === 'number' && Number.isFinite(value) && (latest === undefined || value > latest)) latest = value }
    for (const entry of entries) bump(entryTimestampMs(entry))
    const background = features['background-commands']
    const tasks = background && typeof background === 'object' && !Array.isArray(background) ? (background as Record<string, unknown>).tasks : undefined
    if (Array.isArray(tasks)) for (const task of tasks) if (task && typeof task === 'object') { bump((task as Record<string, unknown>).startedAt); bump((task as Record<string, unknown>).endedAt) }
    return latest === undefined ? undefined : latest + 1
  }
  return undefined
}

function compactCommand(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 72)
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
                meta={{ toolName: name, toolCallId, args: argsText, result: state?.result?.text ?? toolTerminalMessage(state), isError: state?.result?.isError === true || state?.isError === true || state?.abandoned === true, timestamp: state?.result?.timestamp || timestamp }}
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

export function ProviderErrorNotice({ title, message }: { title: string; message: string }) {
  return (
    <div role="alert" className="my-2 rounded-md border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger">
      <div className="mb-1 font-semibold">{title}</div>
      <pre className="m-0 max-h-[20rem] overflow-auto whitespace-pre-wrap break-words font-mono text-2xs">{message}</pre>
    </div>
  )
}

export const TimelineEntry = memo(function TimelineEntry({
  entry, onFileOpen, toolStates, auxiliary = true, onForkAt, forkingEntryId,
  onDiscardAfter, discardingEntryId, onWithdrawMessage, latestUserMessageId, rewindingEntryId,
  discardDisabled, onReadStart, compacting = false,
}: {
  entry: unknown
  onFileOpen: (path: string) => void
  toolStates: ToolStateMap
  auxiliary?: boolean
  onForkAt?: (entryId: string) => void
  forkingEntryId?: string
  onDiscardAfter?: (entryId: string) => void
  discardingEntryId?: string
  onWithdrawMessage?: (entryId: string, editText?: string) => void
  latestUserMessageId?: string
  rewindingEntryId?: string
  discardDisabled?: boolean
  onReadStart?: () => void
  /** True while a compaction runs: a queued bubble waits for that, not for a turn. */
  compacting?: boolean
}) {
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
      const state = message.toolCallId ? toolStates.get(message.toolCallId) : undefined
      if (state?.called) return null
      if (state?.nestedTools?.length) return <RunCodeToolCard state={state} />
      return <ToolResultCard text={message.text} toolName={message.toolName} toolCallId={message.toolCallId} command={message.toolCallId ? toolStates.get(message.toolCallId)?.command : undefined} isError={message.isError} timestamp={timestamp} />
    }
    const assistant = message.role === 'assistant'
    const user = message.role === 'user'
    const forkEntryId = user || assistant ? entryIdOf(entry) : undefined
    const discardEntryId = user ? entryIdOf(entry) : undefined
    const canWithdraw = user && discardEntryId === latestUserMessageId && !!onWithdrawMessage
    const editableText = user ? editableTextContent(message.content) : undefined
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
        ? 'ml-4 w-fit max-w-[min(560px,85%)] self-end rounded-xl rounded-br-sm border border-aim/20 bg-aim-subtle px-3.5 py-2 text-body-s md:ml-10'
        : assistant
          ? 'w-full max-w-[90%] rounded-lg border border-border bg-card px-3.5 py-2.5'
          : 'w-fit max-w-[90%] rounded-lg bg-bg-elevated px-2.5 py-2'}`}>
        <div className={`mb-1 flex items-center gap-2 text-2xs text-muted ${user ? 'justify-end' : ''}`}>
          <span className="min-w-0 truncate">
            <span className={`font-semibold ${user ? 'text-aim' : assistant ? 'text-accent' : 'text-muted-strong'}`}>{user ? '你' : assistant ? 'Pi' : message.role}</span>
            {message.channel && <span className="ml-2 normal-case text-accent">来自 {channelLabel(message.channel)}</span>}
            {pending && <span className="ml-2 normal-case text-warn" title={pendingDeliveryTitle(pending)}>{pendingDeliveryLabel(pending, { compacting })}</span>}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {forkEntryId && onForkAt && (
              <button
                type="button"
                disabled={!!forkingEntryId}
                onClick={() => onForkAt(forkEntryId)}
                title="从这一步分叉出一个新的独立会话（原会话继续运行，新会话继承任务分组并排在旁边）"
                className="cursor-pointer rounded-full px-1.5 py-px normal-case text-2xs text-muted opacity-60 transition-opacity hover:bg-bg-hover hover:text-accent focus-visible:opacity-100 disabled:opacity-50 md:opacity-0 md:group-hover/msg:opacity-100"
              ><span className="inline-flex items-center gap-1"><LineIcon name="flow" className="h-3 w-3" />{forkingEntryId === forkEntryId ? '分叉中…' : '从此分叉'}</span></button>
            )}
            {canWithdraw && discardEntryId && onWithdrawMessage && (
              <>
                <button
                  type="button"
                  disabled={discardDisabled || !!rewindingEntryId}
                  onClick={() => onWithdrawMessage(discardEntryId)}
                  title="撤回这条输入及其后续记录；不会撤销已经执行的工具或外部操作"
                  className="cursor-pointer rounded-full px-1.5 py-px normal-case text-2xs text-warn opacity-70 transition-opacity hover:bg-warn-subtle focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 md:opacity-0 md:group-hover/msg:opacity-100"
                ><span className="inline-flex items-center gap-1"><LineIcon name="undo" className="h-3 w-3" />{rewindingEntryId === discardEntryId ? '撤回中…' : '撤回'}</span></button>
                {editableText !== undefined && (
                  <button
                    type="button"
                    disabled={discardDisabled || !!rewindingEntryId}
                    onClick={() => onWithdrawMessage(discardEntryId, editableText)}
                    title="先撤回这条输入及后续记录，再把文本放入输入框供你修改；不会自动发送"
                    className="cursor-pointer rounded-full px-1.5 py-px normal-case text-2xs text-accent opacity-70 transition-opacity hover:bg-accent-subtle focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 md:opacity-0 md:group-hover/msg:opacity-100"
                  >编辑</button>
                )}
              </>
            )}
            {discardEntryId && onDiscardAfter && (
              <button
                type="button"
                disabled={discardDisabled || !!discardingEntryId}
                onClick={() => onDiscardAfter(discardEntryId)}
                title="永久删除这条用户输入之后的会话记录；该输入保留，原会话会重启"
                className="cursor-pointer rounded-full px-1.5 py-px normal-case text-2xs text-danger opacity-70 transition-opacity hover:bg-danger-subtle focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 md:opacity-0 md:group-hover/msg:opacity-100"
              ><span className="inline-flex items-center gap-1"><LineIcon name="trash" className="h-3 w-3" />{discardingEntryId === discardEntryId ? '处理中…' : '丢弃后续'}</span></button>
            )}
            <time className="shrink-0 font-mono text-2xs font-normal text-muted">{timestamp || '—'}</time>
          </span>
        </div>
        {message.providerError && <ProviderErrorNotice title="⚠️ 模型请求失败" message={message.providerError} />}
        {assistant
          ? <MessageContent content={message.content} onFileOpen={onFileOpen} toolStates={toolStates} timestamp={timestamp} auxiliary={auxiliary} onReadStart={onReadStart} />
          : <MessageContent content={message.content} onFileOpen={onFileOpen} toolStates={toolStates} timestamp={timestamp} auxiliary={auxiliary} showRaw={false} onReadStart={onReadStart} />}
      </article>
    )
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const record = entry as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : 'event'
  const payload = eventData || record
  if (type === 'auto_retry_start' && typeof payload.errorMessage === 'string' && payload.errorMessage.trim()) {
    const attempt = typeof payload.attempt === 'number' ? payload.attempt : undefined
    const maxAttempts = typeof payload.maxAttempts === 'number' ? payload.maxAttempts : undefined
    const attemptLabel = attempt && maxAttempts ? `（${attempt}/${maxAttempts}）` : ''
    return <ProviderErrorNotice title={`⚠️ 自动重试${attemptLabel}：请求失败`} message={payload.errorMessage} />
  }
  if (type === 'auto_retry_end' && payload.success === false) {
    const attempt = typeof payload.attempt === 'number' ? `（第 ${payload.attempt} 次）` : ''
    const finalError = typeof payload.finalError === 'string' && payload.finalError.trim()
      ? payload.finalError : '自动重试失败，但未提供错误详情。'
    return <ProviderErrorNotice title={`⚠️ 自动重试最终失败${attempt}`} message={finalError} />
  }
  if (type === 'message_start' || type === 'live_feature_snapshot' || type === 'agent_start' || type === 'agent_end' || type === 'agent_settled' || type === 'turn_start' || type === 'turn_end' || type === 'claim_changed') return null
  if (type === 'tool_execution_update') {
    const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : record
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined
    const state = toolCallId ? toolStates.get(toolCallId) : undefined
    if (state?.called) return null
    if (state?.nestedTools?.length) return <RunCodeToolCard state={state} />
    const text = partialText(data.partialResult)
    return text ? <ToolResultCard text={text} toolName={typeof data.toolName === 'string' ? data.toolName : 'tool'} toolCallId={toolCallId} command={typeof data.command === 'string' ? data.command : undefined} timestamp={timestamp} /> : null
  }
  if (type.startsWith('tool_execution_')) {
    const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : record
    const toolName = typeof data.toolName === 'string' ? data.toolName : 'tool'
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined
    const state = toolCallId ? toolStates.get(toolCallId) : undefined
    if (state?.nestedTools?.length) return state.called ? null : <RunCodeToolCard state={state} />
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
  // 目标进度由「目标」面板展示；在对话里再摊一份原始 JSON 只会是噪声。
  if (record.customType === 'goal-state') return null
  return <div className="text-2xs text-muted border-l-2 border-border pl-3 py-1">{type.split('_').join(' ')}</div>
})

const LiveToolGroup = memo(function LiveToolGroup({ items, thinking, onFileOpen, toolStates, onReadStart }: { items: LiveToolItem[]; thinking: { index: number; entry: unknown }[]; onFileOpen: (path: string) => void; toolStates: ToolStateMap; onReadStart?: () => void }) {
  const stateFor = (item: LiveToolItem) => item.toolCallId ? toolStates.get(item.toolCallId) : undefined
  const itemHasError = (item: LiveToolItem) => item.isError || stateFor(item)?.result?.isError === true || stateFor(item)?.isError === true || stateFor(item)?.abandoned === true
  const itemIsDone = (item: LiveToolItem) => item.resultText !== undefined || !!stateFor(item)?.result || !!stateFor(item)?.ended || !!stateFor(item)?.abandoned || itemHasError(item)
  const done = items.filter(itemIsDone).length
  const errors = items.filter(itemHasError).length
  const running = done < items.length
  // Open work in flight automatically: a running command is the thing the user
  // came to watch, and it used to hide behind three nested clicks.
  const [expanded, setExpanded] = useState(() => items.length === 1 || running)
  const names = new Map<string, number>()
  for (const item of items) names.set(item.toolName, (names.get(item.toolName) || 0) + 1)
  const nameSummary = [...names.entries()].map(([name, count]) => count > 1 ? `${name}×${count}` : name).join(', ')
  const progress = errors > 0 ? `${done} 完成 · ${errors} 失败` : done === items.length ? `${done} 完成` : `${done} 完成 · ${items.length - done} 运行中`
  const tone = errors > 0 ? 'bg-danger-subtle' : 'bg-card hover:bg-bg-hover'
  const bar = errors > 0 ? 'border-danger/40' : done === items.length ? 'border-border' : 'border-accent/40'
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
        className={`group/tools flex w-full min-w-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-2xs transition-colors ${bar} ${tone}`}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}${running ? ' animate-pulse' : ''}`} />
        <LineIcon name="tool" className="h-3.5 w-3.5 text-muted" />
        <span className="shrink-0 font-body font-medium text-text-strong">工具组：{progress}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{nameSummary}</span>
        <LineIcon name="chevronDown" className={`h-3.5 w-3.5 text-muted transition-transform group-hover/tools:text-text ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="ml-2 mt-1.5 border-l border-border/70 pl-2 animate-fade-in">
          <div className="space-y-0.5">
            {items.map(item => {
              const active = selectedKey === item.key
              const state = stateFor(item)
              const isError = itemHasError(item)
              const resultText = item.resultText ?? state?.result?.text
              const terminalMessage = resultText === undefined ? toolTerminalMessage(state) : undefined
              const status: ToolSummaryStatus = isError ? 'error' : resultText !== undefined || state?.ended ? 'success' : 'running'
              if (state?.nestedTools?.length) return <RunCodeToolCard key={item.key} state={state} />
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
                        ? <ToolCallBlock content={`🔧 ${item.toolName}`} meta={{ toolName: item.toolName, toolCallId: item.toolCallId, args: item.argsText, result: resultText ?? terminalMessage, isError, timestamp: item.timestamp }} onFileOpen={onFileOpen} defaultExpanded />
                        : resultText !== undefined || terminalMessage
                          ? <ToolResultCard text={resultText ?? terminalMessage ?? ''} toolName={item.toolName} toolCallId={item.toolCallId} command={item.detail} isError={isError} timestamp={item.timestamp} revealOnMount />
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

/**
 * 时间线默认视图：主 Agent 会话（role `main`）默认活动视图——只留关键节点与回复，
 * 中间的工具/终端输出按需再看；其他会话沿用旧默认（宽屏看完整对话，窄屏看活动）。
 * 用户一旦自己切过视图，浏览器里的偏好优先（见 LiveSessionPage）。
 */
export function defaultAuxiliaryView(role: string | undefined, compactViewport: boolean): boolean {
  return !(role === 'main') && !compactViewport
}

/**
 * 时间线视图偏好存这个键。`-v2` 有意弃用旧键：旧值是在「桌面默认完整对话」下的
 * 一次手动切换，沿用它会把这个改动要离开的视图固定在读者面前。
 */
const AUXILIARY_STORAGE_KEY = 'live-session-auxiliary-v2'

export default function LiveSessionPage() {
  const { processInstanceId } = useParams<{ processInstanceId?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  // Set by the session-graph page (`?node=<entryId>`) so the graph → session
  // jump can be finished here with the same `/ls-navigate` bridge command.
  const graphNodeId = searchParams.get('node')
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { refresh } = useLiveSessionsRefresh()
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
  // `detail.goal` is the server-cached anchor: it still resolves after a long
  // session pushed its `goal-state` entry out of the entries window. Older
  // servers only ship entries, so fall back to parsing those.
  const sessionGoalSummary = useMemo(
    () => detail?.goal ?? sessionGoalFromEntries(detail?.entries || []),
    [detail?.goal, detail?.entries],
  )
  const compactViewport = useMediaQuery('(max-width: 767px)')
  /**
   * Show thinking + raw tool/script execution in the transcript. Activity view
   * replaces those low-level rows with time-ordered task and step summaries.
   */
  const [auxiliary, setAuxiliary] = useState<boolean>(() => {
    const stored = localStorage.getItem(AUXILIARY_STORAGE_KEY)
    if (stored === 'show') return true
    if (stored === 'hide') return false
    return defaultAuxiliaryView(summary?.role, compactViewport)
  })
  const toggleAuxiliary = useCallback(() => {
    setAuxiliary(value => {
      const next = !value
      localStorage.setItem(AUXILIARY_STORAGE_KEY, next ? 'show' : 'hide')
      return next
    })
  }, [])

  /**
   * 主 Agent 会话默认用活动视图：只留关键节点与回复，中间的工具/终端输出按需再看。
   * 只有用户还没手动切过（浏览器里没有存过偏好）时才套用默认；切过一次之后就尊重那个选择。
   */
  useEffect(() => {
    if (localStorage.getItem(AUXILIARY_STORAGE_KEY)) return
    setAuxiliary(defaultAuxiliaryView(summary?.role, compactViewport))
  }, [activeId, summary?.role, compactViewport])

  const timeline = useMemo(() => groupLiveToolEntries(detail?.entries || [], auxiliary), [detail?.entries, auxiliary])
  /** Prompts this browser sent that Pi has not picked up yet (追加/插话 while a turn runs). */
  const pendingMessages = useMemo(() => pendingDeliveries(detail?.entries || []), [detail?.entries])
  const timelineItems = timeline.items
  const latestUserMessageId = useMemo(() => {
    const entries = detail?.entries || []
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (messageFromEntry(entries[index])?.role === 'user') return entryIdOf(entries[index])
    }
    return undefined
  }, [detail?.entries])
  // Latest round = everything after the newest user message; finished commands
  // from earlier rounds are dropped so the chip row stays short.
  const latestUserAt = useMemo(() => latestUserMessageAt(detail?.entries || [], features), [detail?.entries, features])
  const commandChips = useMemo(() => collectCommandChips(toolStates.values(), features, latestUserAt), [toolStates, features, latestUserAt])
  const agentState = useMemo(() => deriveAgentState(summary?.status, detail?.entries || [], toolStates, !!summary?.compacting), [summary?.status, summary?.compacting, detail?.entries, toolStates])
  const activityStatus = summary?.status === 'reconnecting'
    ? 'reconnecting'
    : summary?.status === 'running' || agentState.tone === 'accent'
      ? 'running'
      : sessionGoalSummary?.status === 'complete'
        ? 'complete'
        : sessionGoalSummary?.status === 'paused' ? 'paused' : 'idle'
  const activities = useMemo(() => buildLiveActivities(detail?.entries || [], activityStatus, sessionGoalSummary, features), [detail?.entries, activityStatus, sessionGoalSummary, features])
  const [busy, setBusy] = useState(false)
  const [commandNotice, setCommandNotice] = useState<string>()
  /** Same guard for closing the file panel while it has unsaved edits. */
  const panelCloseConfirm = useArmedConfirm()
  /** True from the moment /compact is accepted until its entry lands on disk. */
  const [compacting, setCompacting] = useState(false)
  /** True while either this browser's /compact or an automatic compaction runs. */
  const compactingNow = compacting || !!summary?.compacting
  const compactionAbort = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => compactionAbort.current?.abort(), [])
  /** entryId of the bubble whose 「从此分叉」 request is in flight. */
  const [forkingEntryId, setForkingEntryId] = useState<string>()
  const [discardingEntryId, setDiscardingEntryId] = useState<string>()
  const [rewindingEntryId, setRewindingEntryId] = useState<string>()
  const [composerHasDraft, setComposerHasDraft] = useState(false)
  const [rewoundDraft, setRewoundDraft] = useState<{ id: string; text: string }>()
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
  const discardAfterEntry = useCallback(async (entryId: string) => {
    if (!activeId || busy || summary?.status === 'running' || summary?.status === 'reconnecting') return
    const confirmed = window.confirm('将永久删除所选用户输入之后的会话记录（包括其生成的回复和后续分支），并重启原会话。所选输入会保留；此操作不可撤销。继续？')
    if (!confirmed) return
    setDiscardingEntryId(entryId)
    setForkNotice(undefined)
    try {
      const result = await liveSessionApi.discardAfter(activeId, entryId)
      if (!result.processInstanceId) throw new Error('Pi 已重启，但没有返回新的会话进程标识')
      let refreshError: unknown
      try {
        await refresh()
      } catch (reason) {
        refreshError = reason
      }
      setForkNotice(refreshError
        ? `已完成截断并重启，但会话列表刷新失败：${refreshError instanceof Error ? refreshError.message : String(refreshError)}`
        : `已永久删除 ${result.deletedEntries} 条后续记录，原会话已恢复到所选输入。`)
      navigate(`/live-sessions/${encodeURIComponent(result.processInstanceId)}`)
    } catch (reason) {
      setForkNotice(`丢弃失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setDiscardingEntryId(undefined)
    }
  }, [activeId, busy, navigate, refresh, summary?.status])
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
  const rewindLatestUserMessage = useCallback(async (entryId: string, initialText?: string) => {
    if (!activeId || busy || summary?.status === 'running' || summary?.status === 'reconnecting') return
    let editedText: string | undefined
    if (initialText !== undefined) {
      const proposed = window.prompt('编辑撤回消息的文本。操作完成后会放入输入框，不会自动发送。', initialText)
      if (proposed === null) return
      editedText = proposed
      if ((composerHasDraft || quotes.length > 0) && !window.confirm('当前输入框有未发送内容或引用；继续会用撤回消息覆盖输入框草稿并清除引用。继续吗？')) return
    }
    const scope = editedText === undefined ? '撤回这条用户输入及其所有后续回复和记录' : '撤回这条用户输入及其所有后续回复和记录，并将修改后的文本放入输入框'
    if (!window.confirm(`${scope}。原会话会重启；已经执行的工具、文件修改或外部操作不会被撤销。此操作不可撤销。继续？`)) return
    setRewindingEntryId(entryId)
    setForkNotice(undefined)
    try {
      const result = await liveSessionApi.withdrawMessage(activeId, entryId)
      if (!result.processInstanceId) throw new Error('Pi 已重启，但没有返回新的会话进程标识')
      let refreshError: unknown
      try {
        await refresh()
      } catch (reason) {
        refreshError = reason
      }
      if (editedText !== undefined) {
        setRewoundDraft({ id: `${entryId}-${Date.now()}`, text: editedText })
        setQuotes([])
      }
      const outcome = editedText === undefined
        ? `已撤回，共删除 ${result.removedEntries} 条会话记录。`
        : `已撤回，共删除 ${result.removedEntries} 条记录；修改后的文本已放入输入框，请检查后手动发送。`
      setForkNotice(refreshError
        ? `${outcome} 但会话列表刷新失败：${refreshError instanceof Error ? refreshError.message : String(refreshError)}`
        : outcome)
      navigate(`/live-sessions/${encodeURIComponent(result.processInstanceId)}`)
    } catch (reason) {
      setForkNotice(`撤回失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setRewindingEntryId(undefined)
    }
  }, [activeId, busy, composerHasDraft, navigate, quotes.length, refresh, summary?.status])
  const markRewoundDraftApplied = useCallback((id: string) => {
    setRewoundDraft(current => current?.id === id ? undefined : current)
  }, [])
  const [commentTarget, setCommentTarget] = useState<SelectionTarget | null>(null)
  const [chatComments, setChatComments] = useState<ReviewItem[]>([])
  const [focusedSubagentId, setFocusedSubagentId] = useState<string>()
  const [focusedSubagentRecord, setFocusedSubagentRecord] = useState<ProjectionRecord>()
  const retainedSubagent = useRef<LiveSessionSummary>()
  const retainedSubagentDetail = useRef<LiveSessionDetail>()
  const [focusedWorkflow, setFocusedWorkflow] = useState<WorkflowRecord>()
  /** Subagent strip: pending two-step close confirm, in-flight closes, last result. */
  const [childCloseConfirm, setChildCloseConfirm] = useState<string>()
  const [closingChildIds, setClosingChildIds] = useState<string[]>([])
  const [childCloseNotice, setChildCloseNotice] = useState<string>()
  const [subagentLoading, setSubagentLoading] = useState(false)
  const [availableModels, setAvailableModels] = useState<LiveSessionModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  /** 上下文检查器窗口：看这个会话实际发给模型的内容。 */
  const [contextOpen, setContextOpen] = useState(false)

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

  const connectedSubagent = useMemo(() => sessions.find(session => session.processInstanceId === focusedSubagentId), [focusedSubagentId, sessions])
  const connectedSubagentDetail = focusedSubagentId ? state.details[focusedSubagentId] : undefined
  const focusedSubagent = connectedSubagent || (retainedSubagent.current?.processInstanceId === focusedSubagentId ? retainedSubagent.current : undefined)
  const focusedSubagentDetail = connectedSubagentDetail || (retainedSubagentDetail.current?.summary.processInstanceId === focusedSubagentId ? retainedSubagentDetail.current : undefined)
  useEffect(() => {
    if (connectedSubagent) retainedSubagent.current = connectedSubagent
    if (connectedSubagentDetail) retainedSubagentDetail.current = connectedSubagentDetail
  }, [connectedSubagent, connectedSubagentDetail])
  const workflowItems = useMemo(() => {
    const feature = features['subagent-workflow']
    if (!feature || typeof feature !== 'object' || Array.isArray(feature)) return []
    const workflows = (feature as Record<string, unknown>).workflows
    if (!workflows || typeof workflows !== 'object' || Array.isArray(workflows)) return []
    const items = (workflows as Record<string, unknown>).items
    return Array.isArray(items) ? items.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as WorkflowRecord[] : []
  }, [features])
  const childSessions = useMemo(() => summary ? sessions.filter(session => session.parentSessionId === summary.sessionId) : [], [sessions, summary])
  const childTaskStatuses = useMemo(() => buildSubagentStatuses(state.details), [state.details])
  const childItems = useMemo(() => projectSubagentSessions(childSessions, features['subagent-workflow'], childTaskStatuses), [childSessions, features, childTaskStatuses])
  useEffect(() => {
    if (typeof focusedWorkflow?.id !== 'string') return
    const latest = workflowItems.find(item => item.id === focusedWorkflow.id)
    if (latest && latest !== focusedWorkflow) setFocusedWorkflow(latest)
  }, [focusedWorkflow, workflowItems])
  useEffect(() => {
    const id = typeof focusedSubagentRecord?.id === 'string' ? focusedSubagentRecord.id
      : typeof focusedSubagentRecord?.workId === 'string' ? focusedSubagentRecord.workId : undefined
    if (!id) return
    const latest = childItems.find(item => item.record?.id === id || item.record?.workId === id)?.record
    if (latest && latest !== focusedSubagentRecord) setFocusedSubagentRecord(latest)
  }, [childItems, focusedSubagentRecord])

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
    // Binary artifacts stay on the full document panel; HTML goes to the
    // preview modal, which renders the page (JS/images/videos).
    const fileType = detectFileType(filePath)
    if (fileType !== 'text' && fileType !== 'html') {
      setDocumentPreview(null)
      void handleFileOpen(rawPath)
      return
    }

    setDocumentPreview({ filePath, content: '', loading: true, error: null })
    try {
      const response = await fetch('/api/file-read?path=' + encodeURIComponent(filePath))
      if (!response.ok) throw new Error(response.status === 413 ? '文件过大，不在页面中预览，请点右上角「下载」' : `Unable to read file (${response.status})`)
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
    if (!focusedSubagentId || !connectedSubagent || state.auth !== 'authenticated') return
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
  }, [connectedSubagent, dispatch, focusedSubagentDetail, focusedSubagentId, state.auth])

  useEffect(() => {
    setFocusedSubagentId(undefined)
    setFocusedSubagentRecord(undefined)
    retainedSubagent.current = undefined
    retainedSubagentDetail.current = undefined
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
  /**
   * Ask the agent to re-read its own checklist against what actually happened.
   * The anchor is reactive, so this only nudges the agent — it never edits state.
   */
  const syncGoalChecklist = () => perform(async () => {
    if (!activeId) return
    await liveSessionApi.command(activeId, { type: 'input', text: GOAL_SYNC_REQUEST, channel: 'web' })
    setCommandNotice('已请求 agent 对照原始需求核对任务锚点的工作项状态')
  })
  const clearSession = () => perform(async () => {
    if (!activeId) return
    // `/clear` is a REGISTERED extension command (`session-aliases.ts`: wait for idle,
    // then `newSession()`), which is why it works from a text prompt at all — pi only
    // executes registered commands there, and hands everything else starting with `/`
    // to the model. It also means no lease is needed: that handler has no lease gate.
    await liveSessionApi.command(activeId, { type: 'input', text: '/clear', channel: 'web' })
    setAvailableModels([])
    // Give the click visible feedback: the page only switches once Pi reports the
    // new session. On a working session `/clear` first waits for the turn to end, so
    // say that instead of pretending it is instant.
    setCommandNotice(summary?.status === 'idle'
      ? '已请求清空会话——新会话就绪后本页会自动切过去'
      : '已请求清空会话：等这一轮结束后会自动切到新的空会话')
  })
  /**
   * 「清空」used to be gated on `window.confirm`, and browsers answer that with a
   * silent `false` when dialogs are suppressed ("prevent additional dialogs",
   * unfocused tab, stricter WebViews) — the click then did nothing at all and
   * left no trace. Arm on the first click, act on the second, like the sidebar's
   * destructive actions; the arm expires on its own.
   */
  /**
   * One click clears.
   *
   * The old two-step arm existed only because `window.confirm` is answered with a
   * silent `false` when a browser suppresses dialogs — but an arm is its own trap
   * (a 5s window, a banner that outlives it, and the press vanishing whenever the
   * session happened to be busy). The action is recoverable by design, so the click
   * goes straight through and the notice says what happened.
   */
  const handleClear = () => {
    // `/clear` is not pi's own command: it comes from an extension, so a session can
    // genuinely not have it. Say so instead of sending text the model would answer.
    if (!clearCommandAvailable(summary?.capabilities)) {
      setCommandNotice('该会话没有可用的「清空」命令（`/clear` 未注册）：通常是扩展没加载成功。先试「重载」加载最新扩展，仍不行就检查扩展配置。')
      return
    }
    void clearSession().catch(() => { /* perform() already surfaced the error */ })
  }

  /**
   * Header shortcuts: Alt+R refreshes, Alt+C starts a fresh session. Plain
   * letters belong to the composer and Ctrl/Cmd+R is the browser's reload, so
   * Alt combos are the only safe lane; typing in any field skips them.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      // macOS turns Option+letter into special characters (®/ç), so match the
      // physical key (code) rather than the produced character (key).
      if (event.code === 'KeyR') { event.preventDefault(); refreshNow() }
      else if (event.code === 'KeyC') { event.preventDefault(); handleClear() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  /** ✕ / Esc / the dimmed backdrop all land here, so the unsaved-edit guard lives
   *  in one place and can render its confirming state on the panel. */
  const requestPanelClose = useCallback(() => {
    if (panel.dirty && !panelCloseConfirm.confirm()) return
    panel.closePanel()
  }, [panel.dirty, panel.closePanel, panelCloseConfirm.confirm])
  useEffect(() => { panelCloseConfirm.disarm() }, [panelCloseConfirm.disarm, panel.filePath, panel.isOpen])
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
    // `/clear` = 开新会话（旧对话留在文件中）。它由 `session-aliases.ts` 注册，因此可以
    // 走 input 文本流；上游那句「TUI 内置命令无法通过文本流触发」不适用于它。
    if (trimmed === '/clear') {
      if (!clearCommandAvailable(summary?.capabilities)) {
        setCommandNotice('该会话没有可用的「清空」命令（`/clear` 未注册）：通常是扩展没加载成功，先试「重载」；这条文本没有发出去，避免被当普通提示词回答。')
        return
      }
      await liveSessionApi.command(processInstanceId, { type: 'input', text: '/clear', channel: 'web' })
      setCommandNotice('已请求清空会话——新会话就绪后本页会自动切过去')
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
    const queuedDelivery = queuedDeliveryFor({ status: summary?.status, ...(deliverAs ? { deliverAs } : {}), text, compacting: !!summary?.compacting })
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
    <div className="relative flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
      {sessionSidebarVisible && <LiveSessionsList sessions={sessions} sessionTitles={sessionTitles} subagentStatuses={subagentStatuses} activeId={activeId} onRefresh={refresh} pendingUiCounts={pendingUiCounts} onSelect={id => navigate(`/live-sessions/${encodeURIComponent(id)}`)} />}
      {/* 右栏（LiveSessionFeatures）放在下面那一行里当普通列，不覆盖 main。
          以前它用绝对定位盖在页面右侧全高，会从最顶端把标题栏的右端和白底横线截掉，
          看起来像被切开；改成并排后，标题栏横跨整宽，下面才是「内容 + 右栏」两列。 */}
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
            {summary && ownedLeaseId && <button type="button" disabled={busy} onClick={() => { void release().catch(() => {}) }} className="rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted disabled:opacity-50">释放控制</button>}
            <button type="button" onClick={() => navigate(summary?.sessionFile ? `/live-sessions/graph?file=${encodeURIComponent(summary.sessionFile)}` : '/live-sessions/graph')} className="rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted hover:border-accent hover:text-accent" title="在会话家族图谱中查看该会话">◈ 在图谱中查看</button>
            {/* 只读探查：旧会话（Pi 还在跑旧扩展）也保留入口，点开后会直接说明去重载，
                而不是把这个功能藏起来让人找不到。 */}
            {activeId && (
              <button type="button" onClick={() => setContextOpen(true)} className="rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted hover:border-accent hover:text-accent" title="看这个会话实际发给模型的内容：系统提示、工具定义、消息序列，以及各自的大小">◲ 上下文</button>
            )}
            <button type="button" onClick={toggleAuxiliary} className={`shrink-0 rounded border px-2 py-0.5 text-2xs ${auxiliary ? 'border-border bg-bg text-muted hover:border-accent hover:text-accent' : 'border-accent bg-accent-subtle text-accent'}`} title={auxiliary ? '切换到按活动分组的时间线' : '切回完整对话与工具记录'}>
              {auxiliary ? '活动视图' : '👁 完整对话'}
            </button>
            <button type="button" onClick={toggleVoice} className={`flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-2xs ${tts.enabled ? 'border-accent bg-accent-subtle text-accent' : 'border-border bg-bg text-muted hover:border-accent hover:text-accent'}`} title={tts.enabled ? '语音输出已开启：Pi 回复结束会自动朗读（点击关闭；模型/音色见 设置 → Voice）' : '语音输出已关闭（点击开启；模型/音色见 设置 → Voice）'}>
              <MaterialIcon name={tts.enabled ? 'volume_up' : 'volume_off'} className="h-3.5 w-3.5" />语音输出
            </button>
            {speaking && <button type="button" onClick={stopSpeaking} className="flex shrink-0 items-center gap-1 rounded border border-warn bg-warn-subtle px-2 py-0.5 text-2xs text-warn" title="停止朗读"><MaterialIcon name="stop" className="h-3 w-3" />停止朗读</button>}
            {activeId && <button type="button" disabled={busy} onClick={handleClear} className="rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted hover:border-accent hover:text-accent disabled:opacity-50" title="开始新的空会话（旧对话保留在文件中；快捷键 Alt+C）">清空</button>}
            <button type="button" onClick={refreshNow} className="rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted hover:border-accent hover:text-accent" title="重新拉取会话列表和当前对话内容（快捷键 Alt+R）">刷新</button>
          </div>
        </div>
        <LiveSubagentStrip
          items={childItems.map(item => ({ ...item, label: item.session ? sessionTitles[item.session.processInstanceId] || item.label : item.label }))}
          focusedId={childItems.find(item => item.session?.processInstanceId === focusedSubagentId)?.id || (typeof focusedSubagentRecord?.workId === 'string' ? focusedSubagentRecord.workId : typeof focusedSubagentRecord?.id === 'string' ? focusedSubagentRecord.id : undefined)}
          confirmCloseId={childCloseConfirm}
          closingIds={closingChildIds}
          onFocus={item => {
            setChildCloseConfirm(undefined)
            setFocusedWorkflow(undefined)
            if (item.session) {
              setFocusedSubagentRecord(undefined)
              setFocusedSubagentId(item.session.processInstanceId)
            } else if (item.record) {
              setFocusedSubagentId(undefined)
              setFocusedSubagentRecord(item.record)
            }
          }}
          onStop={item => { if (item.session) void closeChildSession(item.session) }}
        />
        {state.error && <div className="px-4 py-2 bg-danger-subtle text-danger text-xs border-b border-danger">{state.error}</div>}
        {voiceError && <div className="flex items-center gap-2 border-b border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">
          <span className="min-w-0 flex-1 truncate" title={voiceError}>语音输出：{voiceError}</span>
          <button type="button" onClick={clearVoiceError} className="shrink-0 rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted">关闭</button>
        </div>}
        {commandNotice && !state.error && <div className="flex items-center gap-1.5 px-4 py-2 bg-accent-subtle text-accent text-xs border-b border-accent" role="status">{compactingNow && <MaterialIcon name="sync" spin className="h-3.5 w-3.5 shrink-0" />}{commandNotice}</div>}
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
                  {/* 活动视图与完整对话都占满时间线列，宽屏下不再留出两侧空白。 */}
                  <div ref={timelineContentRef} className={auxiliary ? 'flex flex-col space-y-3' : 'w-full space-y-3'}>
                    {workflowItems.map(workflow => <LiveWorkflowProgressCard key={String(workflow.id)} workflow={workflow} sessions={sessions} onOpen={workflowValue => { setFocusedSubagentId(undefined); setFocusedSubagentRecord(undefined); setFocusedWorkflow(workflowValue) }} />)}
                    {auxiliary
                      ? detail.entries.length === 0 && workflowItems.length === 0
                        ? <div className="py-10 text-center text-sm text-muted">该 session 暂无可显示消息。</div>
                        : timelineItems.map(item => item.type === 'toolGroup'
                          ? <LiveToolGroup key={`tool-group-${item.items.map(tool => tool.key).join('|')}`} items={item.items} thinking={item.thinking} onFileOpen={openTimelineFile} toolStates={toolStates} onReadStart={pauseTimelineFollow} />
                          : <TimelineEntry
                            key={entryAnchorKey(item.entry, item.index)}
                            entry={item.entry} onFileOpen={openTimelineFile} toolStates={toolStates} auxiliary={auxiliary}
                            onForkAt={forkAtEntry} forkingEntryId={forkingEntryId}
                            onDiscardAfter={discardAfterEntry} discardingEntryId={discardingEntryId}
                            onWithdrawMessage={rewindLatestUserMessage} latestUserMessageId={latestUserMessageId}
                            rewindingEntryId={rewindingEntryId}
                            discardDisabled={busy || summary?.status === 'running' || summary?.status === 'reconnecting' || !!discardingEntryId || !!rewindingEntryId}
                            onReadStart={pauseTimelineFollow}
                            compacting={!!summary.compacting}
                          />)
                      : <ActivityTimeline activities={activities} onFileOpen={openTimelineFile} onMoveToBackground={moveToBackground} />}
                  </div>
                </div>
                {summary.compacting && <div role="status" aria-label="上下文压缩中" className="flex items-center gap-2 border-t border-border bg-accent-subtle px-3 py-1 text-2xs text-accent">
                  <MaterialIcon name="sync" spin className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">压缩期间发送的消息会排队，压缩完成后自动发送</span>
                </div>}
                <PendingDeliveryBar deliveries={pendingMessages} compacting={!!summary.compacting} />
                <LiveSessionComposer
                  sessionKey={summary.sessionId}
                  restoreDraft={rewoundDraft}
                  onRestoreDraftApplied={markRewoundDraftApplied}
                  onDraftStateChange={setComposerHasDraft}
                  status={summary.status}
                  activity={agentState}
                  activityExtra={auxiliary && commandChips.length > 0 ? <LiveCommandChips chips={commandChips} onMoveToBackground={moveToBackground} /> : undefined}
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
              <div className="flex min-h-0 shrink-0 items-stretch">
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
                  onOpenWorkflow={workflow => { setFocusedSubagentId(undefined); setFocusedSubagentRecord(undefined); setFocusedWorkflow(workflow) }}
                  goal={sessionGoalSummary}
                  goalLoaded={detail !== undefined}
                  goalBusy={busy}
                  onGoalSync={() => { void syncGoalChecklist().catch(() => {}) }}
                  compacting={compactingNow}
                  onCompact={() => { void compact().catch(() => {}) }}
                  onClear={handleClear}
                  onReload={() => { void reload().catch(() => {}) }}
                  onAbort={() => { void abort().catch(() => {}) }}
                  onSendPrompt={text => { void submit(text) }}
                />
              </div>
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
          onClick={requestPanelClose}
        />
        <ErrorBoundary
          key={`panel:${panel.filePath}`}
          fallback={<div className="fixed inset-3 z-[60] flex flex-col items-center justify-center gap-3 rounded-xl border border-danger bg-bg p-6 text-center shadow-2xl md:inset-8"><div className="text-sm text-danger">文件渲染失败</div><div className="max-w-full truncate text-xs text-muted" title={panel.filePath}>{panel.filePath}</div><div className="flex items-center gap-2"><a href={`/api/local-file/download?path=${encodeURIComponent(panel.filePath)}`} download className="rounded border border-accent px-3 py-1 text-xs text-accent no-underline hover:bg-accent hover:text-accent-fg">下载原文件</a><button type="button" onClick={() => window.location.reload()} className="rounded border border-border px-3 py-1 text-xs text-muted hover:border-accent hover:text-accent">重新加载</button><button type="button" onClick={requestPanelClose} className="rounded border border-border px-3 py-1 text-xs text-muted hover:border-accent hover:text-accent">关闭</button></div></div>}
        >
          <Suspense fallback={<div className="fixed inset-3 z-50 flex items-center justify-center rounded-xl border border-border bg-bg text-sm text-muted md:inset-8">加载文件…</div>}>
          <DocumentPanel
            presentation="modal"
            filePath={panel.filePath}
            content={panel.content}
            onContentChange={content => { panel.setContent(content); panel.setDirty(true) }}
            onSave={handleFileSave}
            onClose={requestPanelClose}
            closeArmed={panelCloseConfirm.armed}
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
            setFocusedSubagentRecord(undefined)
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
          disconnected={!connectedSubagent}
          onOpenFull={connectedSubagent ? () => navigate(`/live-sessions/${encodeURIComponent(focusedSubagent.processInstanceId)}`) : undefined}
        />
      )}
      {focusedSubagentRecord && <LiveSubagentRecordPanel record={focusedSubagentRecord} onClose={() => setFocusedSubagentRecord(undefined)} />}
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
      {contextOpen && activeId && (
        <ErrorBoundary key={`context:${activeId}`}>
          <ContextInspector
            processInstanceId={activeId}
            sessionLabel={summary?.sessionName || (summary ? `Pi ${summary.pid}` : undefined)}
            capable={contextViewAvailable(summary?.capabilities)}
            onClose={() => setContextOpen(false)}
          />
        </ErrorBoundary>
      )}
      <ExtensionUiModal />
    </div>
  )
}
