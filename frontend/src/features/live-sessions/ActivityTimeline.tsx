import { useState } from 'react'
import FullContentModal from '../../components/FullContentModal'
import MarkdownRenderer from '../../components/MarkdownRenderer'
import LineIcon from '../../components/LineIcon'
import CommandDetailDialog, { type CommandDetail } from './CommandDetailDialog'
import { formatCommandElapsed } from './LiveCommandChips'

export type ActivityStepStatus = 'pending' | 'running' | 'done' | 'error' | 'blocked'
export type ActivityStatus = 'pending' | 'running' | 'done' | 'incomplete'

/** 命令类步骤的完整信息：展开详情、以及前台运行中的「转后台」都要用。 */
export interface ActivityCommand {
  command: string
  /** 前台工具调用 id；有它才能转后台。 */
  toolCallId?: string
  cwd?: string
  startedAt?: number
  endedAt?: number
  output?: string
  exitCode?: number | string
  error?: string
  /** 已由后台任务接管（快照里存在且不是前台镜像）。 */
  background?: boolean
}

export interface ActivityStep {
  id: string
  label: string
  detail?: string
  /** 详情对应的真实文件路径，用于在 Dashboard 里点开看内容。 */
  path?: string
  /** 命令类步骤的具体命令；有它就把 detail 换成可点的命令 chip。 */
  command?: ActivityCommand
  status: ActivityStepStatus
  entryIndex: number
}

export type ActivityReplyKind = 'commentary' | 'final'

/** One visible agent output attached to an activity (never hidden thinking). */
export interface ActivityReply extends ActivityNote {
  id: string
  kind: ActivityReplyKind
}

/** 一条 agent 说明（计划或回复），带紧随其后的真实动作。 */
export interface ActivityNote {
  text: string
  entryIndex: number
  related: string[]
  /** 会话条目 id；选中引用 / 批注时用来标明出处。 */
  entryId?: string
}

/** 用户请求之后、动手之前，agent 给出的理解与计划。 */
export interface ActivityPlan {
  lines: ActivityNote[]
  items: ActivityStep[]
}

/** 引用 / 批注并入所属活动：执行中补充当前要求，空闲后追问引用的旧活动。 */
export interface ActivityFollowUp {
  id: string
  kind: 'quote' | 'comment'
  text: string
  entryIndex: number
  /** 已发出但还没被 Pi 接手。 */
  queued?: boolean
}

export interface ActivityImage {
  data: string
  mimeType: string
}

export interface LiveActivity {
  id: string
  title: string
  sourceLabel: string
  startedAt?: string
  lastSummary?: string
  status: ActivityStatus
  plan?: ActivityPlan
  steps: ActivityStep[]
  replies: ActivityReply[]
  /** 用户随请求发送的图片，用于在活动中显示小预览。 */
  images?: ActivityImage[]
  /** 已发出但还没被 Pi 接手的输入；不算新活动，只挂在当前活动上。 */
  queuedInputs?: string[]
  /** 引用 / 批注追问，按发生顺序并入本活动。 */
  followUps?: ActivityFollowUp[]
}

const REPLY_KIND: Record<ActivityReplyKind, string> = {
  commentary: '进度说明',
  final: '回复正文',
}

const FOLLOW_UP_KIND: Record<ActivityFollowUp['kind'], string> = {
  quote: '引用回复',
  comment: '批注',
}

/** 追问正文超过三行就值得单独展开看，不必只靠悬停提示。 */
function followUpIsLong(text: string): boolean {
  return text.split('\n').length > 3 || text.length > 240
}

const ACTIVITY_STATUS: Record<ActivityStatus, { label: string; className: string }> = {
  pending: { label: '未完成', className: 'bg-bg-elevated text-muted' },
  running: { label: '进行中', className: 'bg-accent-subtle text-accent' },
  done: { label: '已完成', className: 'bg-ok-subtle text-ok' },
  incomplete: { label: '未完成', className: 'bg-warn-subtle text-warn' },
}

const STEP_STATUS: Record<ActivityStepStatus, { icon: string; label: string; className: string }> = {
  pending: { icon: '○', label: '未完成', className: 'text-muted' },
  running: { icon: '●', label: '进行中', className: 'text-accent' },
  done: { icon: '✓', label: '已完成', className: 'text-ok' },
  error: { icon: '!', label: '失败', className: 'text-danger' },
  blocked: { icon: '!', label: '受阻', className: 'text-warn' },
}

function planLines(plan: ActivityPlan): ActivityNote[] {
  return plan.lines.filter(line => line.text.trim().length > 0)
}

/** “接着做了：…”——把简短标题补成具体动作，避免用户看不懂在干什么。 */
function RelatedNote({ related, inline }: { related: string[]; inline?: boolean }) {
  if (related.length === 0) return null
  // 紧凑模式：跟「进度说明」挤在同一行，行尾省略，不再单独占一行。
  if (inline) return <span className="min-w-0 truncate font-normal" title={related.join('、')}>接着做了：{related.join('、')}</span>
  return <div className="mt-0.5 text-2xs text-muted" title={related.join('、')}>接着做了：{related.join('、')}</div>
}

/** 步骤带 path 时，按步骤名区分读 / 写（path 只在读文件、改文件两类工具上设置）。 */
const WRITE_STEP_LABELS = new Set(['修改文件', '修改代码', '编写回归测试'])
const READ_STEP_LABELS = new Set(['读取文件', '检查代码逻辑', '检查测试用例'])

function fileAccess(step: ActivityStep): 'read' | 'write' | null {
  if (WRITE_STEP_LABELS.has(step.label)) return 'write'
  if (READ_STEP_LABELS.has(step.label)) return 'read'
  return null
}

function StepIcon({ status }: { status: ActivityStepStatus }) {
  const label = STEP_STATUS[status].label
  if (status === 'done') return <span aria-label={label} className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-ok-subtle text-ok"><LineIcon name="check" className="h-2.5 w-2.5" strokeWidth={2.4} /></span>
  if (status === 'running') return <span aria-label={label} className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />
  if (status === 'error' || status === 'blocked') return <span aria-label={label} className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-2xs font-semibold ${status === 'error' ? 'bg-danger-subtle text-danger' : 'bg-warn-subtle text-warn'}`}>!</span>
  return <span aria-label={label} className="h-4 w-4 shrink-0 rounded-full border-[1.5px] border-border-strong" />
}

function FileChip({ step, onFileOpen }: { step: ActivityStep; onFileOpen: (path: string) => void }) {
  const access = fileAccess(step)
  const path = step.path as string
  return <button
    type="button"
    onClick={() => onFileOpen(path)}
    title={`点击查看 ${path}`}
    className="inline-flex min-w-0 max-w-[320px] cursor-pointer items-center gap-1 rounded border border-border bg-card py-px pl-0.5 pr-1.5 font-mono text-2xs text-muted-strong hover:border-accent hover:text-accent"
  >
    {access && <span className={`shrink-0 rounded-sm px-1 font-body text-[10px] leading-[14px] ${access === 'write' ? 'bg-clarify-subtle text-clarify' : 'bg-ok-subtle text-ok'}`}>{access === 'write' ? '写' : '读'}</span>}
    {!access && <LineIcon name="file" className="h-3 w-3" />}
    {/* 长路径保留结尾（文件名最重要）。 */}
    <span className="min-w-0 truncate [direction:rtl]">{step.detail || path}</span>
  </button>
}

/** 命令压成一行：真实命令经常是多行脚本。 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** 命令块：一条长一点的 chip，点开看全文 / 目录 / 输出。 */
function CommandChip({ step, onOpen }: { step: ActivityStep; onOpen: (step: ActivityStep) => void }) {
  const command = step.command as ActivityCommand
  return <button
    type="button"
    onClick={() => onOpen(step)}
    aria-label={`查看命令详情：${oneLine(command.command)}`}
    title={command.command}
    className="flex min-h-5 min-w-[15rem] max-w-[26rem] flex-1 cursor-pointer items-center gap-1 rounded-md border border-border-strong bg-bg-elevated py-px pl-1.5 pr-1 font-mono text-2xs text-muted-strong hover:border-accent hover:bg-accent-subtle hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
  >
    <span className="min-w-0 flex-1 truncate text-left">{oneLine(command.command)}</span>
    <LineIcon name="chevronRight" className="h-2.5 w-2.5 shrink-0 opacity-50" />
  </button>
}

function StepList({ steps, numbered, className, onFileOpen, onCommandOpen, onMoveToBackground, canMove }: {
  steps: ActivityStep[]
  numbered: boolean
  className: string
  onFileOpen?: (path: string) => void
  onCommandOpen: (step: ActivityStep) => void
  onMoveToBackground?: (toolCallId: string) => void
  canMove?: (step: ActivityStep) => boolean
}) {
  return <ol className={className}>
    {steps.map((step, stepIndex) => {
      const stepStatus = STEP_STATUS[step.status]
      const chip = Boolean(step.path && onFileOpen)
      const command = step.command
      const movable = command?.toolCallId && canMove?.(step) && onMoveToBackground
      return (
        <li key={step.id} className="rounded-sm px-1.5 py-0.5 hover:bg-bg-hover">
          <div className="flex min-w-0 items-start gap-x-2 text-meta">
            {numbered && <span className="w-4 shrink-0 pt-0.5 text-right font-mono text-2xs text-muted">{stepIndex + 1}</span>}
            <span className="flex shrink-0 pt-0.5"><StepIcon status={step.status} /></span>
            {/* 标签和命令自成一组：窗口窄时命令掉到第二行，状态和按钮始终留在第一行右侧。 */}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`min-w-0 shrink-0 truncate ${step.status === 'running' ? 'font-medium text-text-strong' : 'text-text'}`} title={step.detail ? `${step.label} · ${step.detail}` : step.label}>{step.label}</span>
              {command
                // 命令类步骤用可点 chip：长命令也能点开看全文，不用挤在行里。
                ? <CommandChip step={step} onOpen={onCommandOpen} />
                : step.detail && !chip && <span className="max-w-[52%] min-w-0 truncate rounded bg-bg-elevated px-1.5 font-mono text-2xs text-muted-strong" title={step.detail}>{step.detail}</span>}
            </div>
            <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
              <span className={`shrink-0 text-2xs ${stepStatus.className}`}>{step.status === 'done' ? '' : stepStatus.label}</span>
              {command?.background && step.status === 'running' && <span className="shrink-0 text-2xs text-muted">已在后台</span>}
              {movable
                ? <button type="button" onClick={() => onMoveToBackground?.(command.toolCallId as string)} title="转到后台后命令继续运行，Pi 不再等它" className="shrink-0 rounded-full border border-border-strong bg-bg-elevated px-2 text-2xs leading-[18px] text-muted-strong hover:border-accent hover:bg-accent-subtle hover:text-accent">转后台</button>
                : null}
            </div>
          </div>
          {chip && <div className={`mt-0.5 flex flex-wrap gap-1 ${numbered ? 'ml-12' : 'ml-6'}`}><FileChip step={step} onFileOpen={onFileOpen as (path: string) => void} /></div>}
        </li>
      )
    })}
  </ol>
}

/**
 * 引用 / 批注靠 `data-msg-anchor` + `data-msg-role` 找到可引用的原文，
 * 活动视图里的正文也必须带上这两个标记，否则选中文字后不会出现「引用 / 批注」。
 */
function QuoteAnchor({ entryId, className, children }: { entryId?: string; className: string; children: React.ReactNode }) {
  return <div className={className} data-msg-anchor="" data-msg-role="assistant" data-msg-id={entryId}>{children}</div>
}

/** 正文超过这个量就值得单独展开，不必整块铺满一屏。 */
/** 这些来源的活动标题就是用户原话，用强调色和 Agent 内容区分。 */
const USER_SOURCES = new Set(['用户请求', '最近用户请求'])

const REPLY_PREVIEW_LINES = 12
const REPLY_PREVIEW_CHARS = 1_200

function replyLineCount(reply: ActivityReply): number {
  return reply.text.split('\n').length
}

function replyIsLong(reply: ActivityReply): boolean {
  return replyLineCount(reply) > REPLY_PREVIEW_LINES || reply.text.length > REPLY_PREVIEW_CHARS
}

function ActivityReplyBody({ reply, onFileOpen, expanded }: { reply: ActivityReply; onFileOpen?: (path: string) => void; expanded: boolean }) {
  const lines = reply.text.split('\n')
  const long = replyIsLong(reply)
  const visible = long && !expanded ? lines.slice(0, REPLY_PREVIEW_LINES).join('\n').slice(0, REPLY_PREVIEW_CHARS) : reply.text
  return (
    <QuoteAnchor entryId={reply.entryId} className={`min-w-0 text-xs text-text [&_h1]:my-1 [&_h1]:text-sm [&_h2]:my-1 [&_h2]:text-xs [&_h3]:my-1 [&_h3]:text-xs [&_li]:text-xs [&_li]:leading-[17px] [&_ol]:my-0.5 [&_p]:my-0.5 [&_p]:text-xs [&_p]:leading-[17px] [&_code]:text-[11px] [&_ul]:my-0.5 ${long && !expanded ? 'relative max-h-[180px] overflow-hidden' : ''}`}>
      {/* 活动视图里不提供 raw 切换：那一行只占高度，正文本身已经是可读的。 */}
      <MarkdownRenderer content={visible} onFileOpen={onFileOpen} showRaw={false} />
      {long && !expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-bg to-transparent" />}
    </QuoteAnchor>
  )
}

/** 只有标题、没有任何内容的活动（例如反复的「继续目标」），连续出现时合并成一行。 */
function isBareActivity(activity: LiveActivity): boolean {
  return activity.status !== 'running'
    && activity.steps.length === 0
    && activity.replies.length === 0
    && !(activity.followUps?.length)
    && !(activity.images?.length)
    && !(activity.queuedInputs?.length)
    && !activity.plan
}

type TimelineRow =
  | { kind: 'activity'; activity: LiveActivity; index: number }
  | { kind: 'group'; key: string; items: Array<{ activity: LiveActivity; index: number }> }

/** 展开分组后多出来的「收起这 N 条」行。 */
type TimelineDisplayRow = TimelineRow | { kind: 'collapse'; key: string; count: number }

export function groupActivities(activities: LiveActivity[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  let run: Array<{ activity: LiveActivity; index: number }> = []
  const flush = () => {
    if (run.length >= 2) rows.push({ kind: 'group', key: `group-${run[0]!.activity.id}`, items: run })
    else for (const item of run) rows.push({ kind: 'activity', ...item })
    run = []
  }
  activities.forEach((activity, index) => {
    if (isBareActivity(activity) && (run.length === 0 || run[0]!.activity.title === activity.title)) {
      run.push({ activity, index })
      return
    }
    flush()
    if (isBareActivity(activity)) run.push({ activity, index })
    else rows.push({ kind: 'activity', activity, index })
  })
  flush()
  return rows
}

/** 时间线左侧的状态圆点。 */
function TimelineDot({ status }: { status: ActivityStatus }) {
  const tone = status === 'done'
    ? 'border-ok bg-ok'
    : status === 'running'
      ? 'border-accent bg-card shadow-[0_0_0_4px_var(--accent-subtle)]'
      : 'border-dashed border-border-strong bg-card'
  return <span aria-hidden="true" className={`absolute -left-[22px] top-3 h-3 w-3 rounded-full border-2 ${tone}`} />
}

/** 「12:03:19」比完整日期更好扫读；完整时间放在悬停提示里。 */
function shortTime(value?: string): string {
  if (!value) return ''
  const match = /(\d{1,2}:\d{2})(:\d{2})?\s*$/.exec(value)
  return match ? match[1]! : value
}

function sourceChip(sourceLabel: string): { className: string; icon?: 'clock' } {
  if (USER_SOURCES.has(sourceLabel)) return { className: 'bg-aim-subtle text-aim' }
  if (sourceLabel.includes('定时')) return { className: 'bg-clarify-subtle text-clarify', icon: 'clock' }
  return { className: 'bg-bg-elevated text-muted-strong' }
}

export default function ActivityTimeline({ activities, onFileOpen, onMoveToBackground }: {
  activities: LiveActivity[]
  onFileOpen?: (path: string) => void
  /** 把前台运行的命令转到后台；没有它就不显示「转后台」。 */
  onMoveToBackground?: (toolCallId: string) => Promise<void> | void
}) {
  const [commandStep, setCommandStep] = useState<ActivityStep>()
  const [movedTools, setMovedTools] = useState<Record<string, boolean>>({})
  const [expandedActivities, setExpandedActivities] = useState<Record<string, boolean>>({})
  const [expandedFollowUps, setExpandedFollowUps] = useState<Record<string, boolean>>({})
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({})
  const [readingReply, setReadingReply] = useState<ActivityReply | null>(null)
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  /** 前台 + 还在跑 + 没被转到后台，才给按钮；转完乐观地先收起按钮。 */
  const canMoveToBackground = (step: ActivityStep): boolean => {
    const command = step.command
    return Boolean(onMoveToBackground && command?.toolCallId && step.status === 'running' && !command.background && !movedTools[command.toolCallId])
  }
  const moveToBackground = (toolCallId: string): void => {
    setMovedTools(previous => ({ ...previous, [toolCallId]: true }))
    void Promise.resolve(onMoveToBackground?.(toolCallId)).catch(() => {
      setMovedTools(previous => {
        const next = { ...previous }
        delete next[toolCallId]
        return next
      })
    })
  }

  const commandDetail = (step: ActivityStep): CommandDetail | undefined => {
    const command = step.command
    if (!command) return undefined
    const running = step.status === 'running'
    const elapsed = command.startedAt === undefined
      ? undefined
      : formatCommandElapsed((command.endedAt ?? Date.now()) - command.startedAt)
    const tag = step.status === 'error'
      ? { text: '失败', className: 'bg-danger-subtle text-danger' }
      : command.background || movedTools[command.toolCallId || '']
        ? { text: '后台命令', className: 'bg-warn-subtle text-warn' }
        : running
          ? { text: '前台运行中', className: 'bg-accent-subtle text-accent' }
          : { text: '已完成', className: 'bg-ok-subtle text-ok' }
    return {
      tag,
      title: `${step.label} · ${command.background || movedTools[command.toolCallId || ''] ? '后台命令' : running ? '前台命令' : '已结束'}`,
      command: command.command,
      ...(command.cwd ? { cwd: command.cwd } : {}),
      ...(elapsed ? { time: elapsed, timeLabel: running && command.endedAt === undefined ? '已运行' : '耗时' } : {}),
      ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
      ...(command.error ? { error: command.error } : {}),
      output: command.output,
      running,
      ...(canMoveToBackground(step) && command.toolCallId ? { onMoveToBackground: () => moveToBackground(command.toolCallId as string) } : {}),
    }
  }

  return (
    <section className="relative space-y-2.5 pl-[26px] before:absolute before:bottom-2 before:left-[9px] before:top-2 before:w-0.5 before:rounded-full before:bg-border" aria-label="会话活动时间线">
      {activities.length === 0
        ? <p className="py-10 text-center text-body-s text-muted">暂无可归纳的活动。</p>
        : groupActivities(activities).flatMap((row): TimelineDisplayRow[] => {
          if (row.kind === 'activity') return [row]
          if (openGroups[row.key]) return [
            { kind: 'collapse', key: row.key, count: row.items.length },
            ...row.items.map(item => ({ kind: 'activity' as const, ...item })),
          ]
          return [row]
        }).map(row => {
          if (row.kind === 'collapse') return (
            <div key={`${row.key}-collapse`} className="relative">
              <button type="button" onClick={() => setOpenGroups(previous => ({ ...previous, [row.key]: false }))} className="cursor-pointer border-0 bg-transparent p-0 text-2xs text-accent hover:underline">收起这 {row.count} 条</button>
            </div>
          )
          if (row.kind === 'group') {
            const first = row.items[0]!.activity
            const times = row.items.map(item => shortTime(item.activity.startedAt)).filter(Boolean)
            return (
              <div key={row.key} className="relative" data-activity-group="">
                <TimelineDot status="pending" />
                <button
                  type="button"
                  onClick={() => setOpenGroups(previous => ({ ...previous, [row.key]: true }))}
                  className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-dashed border-border-strong bg-transparent px-3.5 py-1.5 text-left text-meta text-muted hover:bg-card"
                >
                  <LineIcon name="repeat" className="h-3.5 w-3.5" />
                  <span className="shrink-0 font-medium text-muted-strong">{first.title} × {row.items.length}</span>
                  {times.length > 0 && <span className="min-w-0 truncate font-mono text-2xs" title={row.items.map(item => item.activity.startedAt).join('\n')}>{times.join(' · ')}</span>}
                  <span className="hidden shrink-0 sm:inline">均无可确认的执行步骤</span>
                  <span className="ml-auto shrink-0 text-accent">展开</span>
                </button>
              </div>
            )
          }
          const { activity, index: activityIndex } = row
          const activityStatus = ACTIVITY_STATUS[activity.status]
          const source = sourceChip(activity.sourceLabel)
          const doneSteps = activity.steps.filter(step => step.status === 'done').length
          const expanded = expandedActivities[activity.id] === true
          const visibleSteps = expanded ? activity.steps : activity.steps.slice(0, 5)
          const hiddenSteps = Math.max(0, activity.steps.length - visibleSteps.length)
          // 回复与追问按真实发生顺序排在同一条时间线上，避免「先回再引」看起来像「先引再回」。
          const followUps = activity.followUps || []
          const timeline: Array<{ key: string; entryIndex: number; reply?: ActivityReply; followUp?: ActivityFollowUp }> = [
            ...followUps.map(item => ({ key: `follow-up-${item.id}`, entryIndex: item.entryIndex, followUp: item })),
            ...activity.replies.map(reply => ({ key: `reply-${reply.id}`, entryIndex: reply.entryIndex, reply })),
          ].sort((left, right) => left.entryIndex - right.entryIndex)
          const replyCount = activity.replies.length
          const followUpCount = followUps.length
          const timelineLabel = replyCount > 0
            ? `Agent 回复${replyCount > 1 ? ` · ${replyCount} 条` : ''}`
            : `引用 / 批注追问${followUpCount > 1 ? ` · ${followUpCount} 条` : ''}`
          const timelineExtra = replyCount > 0 && followUpCount > 0
            ? `引用 / 批注追问${followUpCount > 1 ? ` · ${followUpCount} 条` : ''}（并入本活动，不另开一个）`
            : replyCount === 0 && followUpCount > 0 ? '（并入本活动，不另开一个）' : undefined
          return (
            <div key={activity.id} className="relative">
            <TimelineDot status={activity.status} />
            <article className={`rounded-lg border bg-card px-3.5 py-2.5 ${activity.status === 'running' ? 'border-accent/40' : 'border-border'}`}>
              <div className="flex min-w-0 items-center gap-2 text-2xs text-muted">
                <span className="shrink-0 font-mono font-semibold">#{activityIndex + 1}</span>
                <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 leading-[18px] ${source.className}`}>{source.icon && <LineIcon name={source.icon} className="h-3 w-3" />}{activity.sourceLabel}</span>
                {activity.startedAt && <time className="shrink-0 font-mono" title={activity.startedAt}>{shortTime(activity.startedAt)}</time>}
                <span className={`ml-auto shrink-0 rounded-full px-2 leading-[18px] font-medium ${activityStatus.className}`}><span>{activityStatus.label}</span>{activity.steps.length > 0 && <span className="font-mono"> · {doneSteps}/{activity.steps.length}</span>}</span>
              </div>
              <h2 className={`mt-1 truncate text-title font-semibold ${USER_SOURCES.has(activity.sourceLabel) ? 'text-aim' : 'text-text-strong'}`} title={activity.title}>{activity.title}</h2>
              {activity.lastSummary && <div className="mt-0.5 truncate text-meta text-muted" title={activity.lastSummary}>{activity.lastSummary}</div>}
              {(activity.images?.length || 0) > 0 && <div className="mt-1.5 flex flex-wrap gap-2" aria-label="用户发送的图片">
                {activity.images!.map((image, imageIndex) => {
                  const src = `data:${image.mimeType};base64,${image.data}`
                  const alt = `用户发送的图片 ${imageIndex + 1}`
                  return <button
                    key={`${activity.id}-image-${imageIndex}`}
                    type="button"
                    title="点击查看原图"
                    onClick={() => setPreviewImage({ src, alt })}
                    className="cursor-zoom-in border-0 bg-transparent p-0"
                  ><img src={src} alt={alt} loading="lazy" className="h-20 w-28 rounded border border-border bg-bg-elevated object-contain" /></button>
                })}
              </div>}
              {(activity.queuedInputs?.length || 0) > 0 && <div className="mt-1 flex min-w-0 items-start gap-1.5 text-2xs text-muted">
                <span className="shrink-0 font-semibold text-warn">排队中的输入</span>
                <span className="min-w-0 truncate" title={activity.queuedInputs?.join(' / ')}>· {activity.queuedInputs?.join(' / ')}（等 Pi 接手后单独成为一个活动）</span>
              </div>}

              {activity.steps.length === 0
                ? <p className="mt-1 text-meta text-muted">尚无可确认的执行步骤</p>
                : <StepList steps={visibleSteps} numbered={false} className="-mx-1.5 mt-1.5 space-y-px" onFileOpen={onFileOpen} onCommandOpen={setCommandStep} onMoveToBackground={moveToBackground} canMove={canMoveToBackground} />}
                {activity.status === 'running' && activity.steps.length > 0 && <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-bg-elevated"><i className="block h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round(doneSteps / activity.steps.length * 100)}%` }} /></div>}
                {activity.steps.length > 5 && <button
                  type="button"
                  onClick={() => setExpandedActivities(previous => ({ ...previous, [activity.id]: !expanded }))}
                  className="ml-6 mt-1 cursor-pointer border-0 bg-transparent p-0 text-2xs text-accent hover:underline"
                >{expanded ? '收起步骤' : `展开其余 ${hiddenSteps} 项`}</button>}

              {activity.plan && (planLines(activity.plan).length > 0 || activity.plan.items.length > 0) && <div className="mt-1.5 rounded-md border border-accent/30 bg-accent-subtle/30 px-2 py-1.5">
                <div className="text-2xs font-semibold text-accent">Agent 计划</div>
                {planLines(activity.plan).map((line, lineIndex) => (
                  <div key={`plan-line-${lineIndex}`}>
                    <QuoteAnchor entryId={line.entryId} className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-2xs leading-5 text-text">
                      <span title={line.text}>{line.text}</span>
                    </QuoteAnchor>
                    <RelatedNote related={line.related} />
                  </div>
                ))}
                {activity.plan.items.length > 0 && <StepList steps={activity.plan.items} numbered={false} className="mt-1 space-y-1" onFileOpen={onFileOpen} onCommandOpen={setCommandStep} onMoveToBackground={moveToBackground} canMove={canMoveToBackground} />}
              </div>}

              {timeline.length > 0 && <div className="mt-2 space-y-1 border-t border-border/70 pt-1.5">
                <div className="mb-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-2xs font-semibold text-muted">
                  <span>{timelineLabel}</span>
                  {timelineExtra && <span className="font-normal">· {timelineExtra}</span>}
                  <span className="ml-auto shrink-0 font-normal text-muted">按发生顺序</span>
                </div>
                {timeline.map(entry => {
                  if (entry.reply) {
                    const reply = entry.reply
                    const open = expandedReplies[reply.id] === true
                    const long = replyIsLong(reply)
                    return (
                      <div key={entry.key} className="rounded-md px-1.5 py-0.5 hover:bg-bg-hover">
                        <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted">
                          <span className="shrink-0">{REPLY_KIND[reply.kind]}</span>
                          <RelatedNote inline related={reply.related} />
                          <span className="ml-auto flex shrink-0 items-center gap-1.5">
                            {long && <button
                              type="button"
                              aria-expanded={open}
                              onClick={() => setExpandedReplies(previous => ({ ...previous, [reply.id]: previous[reply.id] !== true }))}
                              className="cursor-pointer border-0 bg-transparent p-0 text-2xs text-accent hover:underline"
                            >{open ? '收起正文' : `展开全部正文（${replyLineCount(reply)} 行）`}</button>}
                            {long && <button
                              type="button"
                              onClick={() => setReadingReply(reply)}
                              title="在独立窗口里读（可选中文字引用 / 批注给 Agent）"
                              className="cursor-pointer border-0 bg-transparent p-0 text-2xs text-muted hover:text-accent hover:underline"
                            >弹窗阅读</button>}
                            <span className="font-mono">{reply.text.length.toLocaleString()} 字符</span>
                          </span>
                        </div>
                        <ActivityReplyBody reply={reply} expanded={open} onFileOpen={onFileOpen} />
                      </div>
                    )
                  }
                  const followUp = entry.followUp
                  if (!followUp) return null
                  const followUpOpen = expandedFollowUps[followUp.id] === true
                  return (
                    <div key={entry.key} className="rounded-sm border border-border bg-bg-elevated px-2 py-0.5">
                      <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted">
                        <span className="shrink-0 rounded bg-accent-subtle px-1.5 text-accent">{FOLLOW_UP_KIND[followUp.kind]}</span>
                        {followUp.queued && <span className="shrink-0 text-warn">排队中，等 Pi 接手</span>}
                        <span className="ml-auto shrink-0 font-mono">{followUp.text.length.toLocaleString()} 字符</span>
                      </div>
                      <p className={`mt-0.5 whitespace-pre-wrap break-words text-2xs text-accent ${followUpOpen ? '' : 'line-clamp-3'}`} title={followUp.text}>{followUp.text}</p>
                      {followUpIsLong(followUp.text) && <button
                        type="button"
                        aria-expanded={followUpOpen}
                        aria-label={followUpOpen ? `收起${FOLLOW_UP_KIND[followUp.kind]}追问` : `展开${FOLLOW_UP_KIND[followUp.kind]}追问全文`}
                        onClick={() => setExpandedFollowUps(previous => ({ ...previous, [followUp.id]: previous[followUp.id] !== true }))}
                        className="mt-0.5 cursor-pointer border-0 bg-transparent p-0 text-2xs text-accent hover:underline"
                      >{followUpOpen ? '收起' : '展开全文'}</button>}
                    </div>
                  )
                })}
              </div>}
            </article>
            </div>
          )
        })}
      {commandStep && (() => {
        const detail = commandDetail(commandStep)
        return detail ? <CommandDetailDialog detail={detail} onClose={() => setCommandStep(undefined)} /> : null
      })()}
      {readingReply && <FullContentModal content={readingReply.text} meta={`${replyLineCount(readingReply)} 行`} onFileOpen={onFileOpen} showRaw={false} onClose={() => setReadingReply(null)} />}
      {previewImage && <div
        role="dialog"
        aria-modal="true"
        aria-label="图片原图预览"
        onClick={() => setPreviewImage(null)}
        onKeyDown={event => { if (event.key === 'Escape') setPreviewImage(null) }}
        tabIndex={-1}
        ref={node => node?.focus()}
        className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-4"
      >
        <img src={previewImage.src} alt={previewImage.alt} className="max-h-full max-w-full object-contain" />
      </div>}
    </section>
  )
}
