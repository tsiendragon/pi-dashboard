import { useState } from 'react'
import MarkdownRenderer from '../../components/MarkdownRenderer'

export type ActivityStepStatus = 'pending' | 'running' | 'done' | 'error' | 'blocked'
export type ActivityStatus = 'pending' | 'running' | 'done' | 'incomplete'

export interface ActivityStep {
  id: string
  label: string
  detail?: string
  /** 详情对应的真实文件路径，用于在 Dashboard 里点开看内容。 */
  path?: string
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

/** 引用 / 批注是对已经做完那件事的追问：并入所属活动，不另开一个活动。 */
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
function RelatedNote({ related }: { related: string[] }) {
  if (related.length === 0) return null
  return <div className="mt-1 text-2xs text-muted" title={related.join('、')}>接着做了：{related.join('、')}</div>
}

function StepList({ steps, numbered, className, onFileOpen }: { steps: ActivityStep[]; numbered: boolean; className: string; onFileOpen?: (path: string) => void }) {
  return <ol className={className}>
    {steps.map((step, stepIndex) => {
      const stepStatus = STEP_STATUS[step.status]
      return (
        <li key={step.id} className="flex min-w-0 items-start gap-2 text-2xs">
          {numbered && <span className="w-4 shrink-0 text-right font-mono text-muted">{stepIndex + 1}</span>}
          <span className={`mt-px shrink-0 font-semibold ${stepStatus.className}`} aria-label={stepStatus.label}>{stepStatus.icon}</span>
          <span className={`shrink-0 ${stepStatus.className}`}>{stepStatus.label}</span>
          {/* 文件名紧跟操作，不再被推到行尾；有路径时可直接点开。 */}
          <span className="min-w-0 truncate text-text" title={step.detail ? `${step.label} · ${step.detail}` : step.label}>{step.label}</span>
          {step.detail && (step.path && onFileOpen
            ? <button
              type="button"
              onClick={() => onFileOpen(step.path as string)}
              className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-accent hover:underline"
              title={`在 Dashboard 里打开 ${step.path}`}
            >{step.detail}</button>
            : <span className="min-w-0 truncate text-muted" title={step.detail}>{step.detail}</span>)}
          <span className="min-w-0 flex-1" />
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

function ActivityReplyBody({ reply, onFileOpen }: { reply: ActivityReply; onFileOpen?: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const lines = reply.text.split('\n')
  const previewLines = 12
  const previewChars = 1_200
  const long = lines.length > previewLines || reply.text.length > previewChars
  const visible = long && !expanded ? lines.slice(0, previewLines).join('\n').slice(0, previewChars) : reply.text
  return (
    <div className="min-w-0">
      <QuoteAnchor entryId={reply.entryId} className={`min-w-0 text-body-s leading-5 text-text [&_h1]:my-1 [&_h1]:text-base [&_h2]:my-1 [&_h2]:text-sm [&_h3]:my-1 [&_h3]:text-sm [&_li]:text-body-s [&_li]:leading-5 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1 ${long && !expanded ? 'relative max-h-[200px] overflow-hidden' : ''}`}>
        <MarkdownRenderer content={visible} onFileOpen={onFileOpen} />
        {long && !expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-bg to-transparent" />}
      </QuoteAnchor>
      {long && <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-2xs text-accent hover:underline"
      >{expanded ? '收起正文' : `展开全部正文（${lines.length} 行）`}</button>}
    </div>
  )
}

export default function ActivityTimeline({ activities, onFileOpen }: { activities: LiveActivity[]; onFileOpen?: (path: string) => void }) {
  const [expandedActivities, setExpandedActivities] = useState<Record<string, boolean>>({})
  const [expandedFollowUps, setExpandedFollowUps] = useState<Record<string, boolean>>({})

  return (
    <section className="space-y-3" aria-label="会话活动时间线">
      {activities.length === 0
        ? <p className="py-10 text-center text-sm text-muted">暂无可归纳的活动。</p>
        : activities.map((activity, activityIndex) => {
          const activityStatus = ACTIVITY_STATUS[activity.status]
          const expanded = expandedActivities[activity.id] === true
          const visibleSteps = expanded ? activity.steps : activity.steps.slice(0, 5)
          const hiddenSteps = Math.max(0, activity.steps.length - visibleSteps.length)
          return (
            <article key={activity.id} className="rounded-md border border-border bg-card px-3 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-xs font-semibold text-accent">活动 {activityIndex + 1}</span>
                {activity.startedAt && <time className="shrink-0 text-2xs text-muted">{activity.startedAt}</time>}
                <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${activityStatus.className}`}>{activityStatus.label}</span>
              </div>
              <h2 className="mt-1 truncate text-body-s font-semibold leading-5 text-text-strong" title={activity.title}>{activity.title}</h2>
              <div className="mt-0.5 flex min-w-0 items-center gap-2 text-2xs text-muted">
                <span className="shrink-0">{activity.sourceLabel}</span>
                {activity.lastSummary && <span className="truncate" title={activity.lastSummary}>· {activity.lastSummary}</span>}
              </div>
              {(activity.images?.length || 0) > 0 && <div className="mt-2 flex flex-wrap gap-2" aria-label="用户发送的图片">
                {activity.images!.map((image, imageIndex) => <img
                  key={`${activity.id}-image-${imageIndex}`}
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={`用户发送的图片 ${imageIndex + 1}`}
                  loading="lazy"
                  className="h-20 w-28 rounded border border-border bg-bg-elevated object-contain"
                />)}
              </div>}
              {(activity.queuedInputs?.length || 0) > 0 && <div className="mt-1 flex min-w-0 items-start gap-1.5 text-2xs text-muted">
                <span className="shrink-0 font-semibold text-warn">排队中的输入</span>
                <span className="min-w-0 truncate" title={activity.queuedInputs?.join(' / ')}>· {activity.queuedInputs?.join(' / ')}（等 Pi 接手后单独成为一个活动）</span>
              </div>}

              {activity.steps.length === 0
                ? <p className="mt-2 text-2xs text-muted">尚无可确认的执行步骤</p>
                : <StepList steps={visibleSteps} numbered className="ml-1 mt-2 space-y-2 border-l border-border pl-3" onFileOpen={onFileOpen} />}
                {activity.steps.length > 5 && <button
                  type="button"
                  onClick={() => setExpandedActivities(previous => ({ ...previous, [activity.id]: !expanded }))}
                  className="ml-8 mt-2 cursor-pointer border-0 bg-transparent p-0 text-2xs text-accent hover:underline"
                >{expanded ? '收起步骤' : `展开其余 ${hiddenSteps} 项`}</button>}

              {(activity.followUps?.length || 0) > 0 && <div className="ml-1 mt-3 space-y-1.5 border-l border-border pl-3">
                <div className="text-2xs font-semibold text-muted">
                  引用 / 批注追问{activity.followUps!.length > 1 ? ` · ${activity.followUps!.length} 条` : ''}
                  <span className="ml-1 font-normal">（并入本活动，不另开一个）</span>
                </div>
                {activity.followUps!.map(item => (
                  <div key={item.id} className="rounded border border-border bg-bg-elevated px-2.5 py-1.5">
                    <div className="flex min-w-0 items-center gap-2 text-2xs text-muted">
                      <span className="shrink-0 rounded bg-accent-subtle px-1.5 text-accent">{FOLLOW_UP_KIND[item.kind]}</span>
                      {item.queued && <span className="shrink-0 text-warn">排队中，等 Pi 接手</span>}
                      <span className="ml-auto shrink-0 font-mono">{item.text.length.toLocaleString()} 字符</span>
                    </div>
                    <p className={`mt-1 whitespace-pre-wrap break-words text-2xs leading-5 text-text ${expandedFollowUps[item.id] ? '' : 'line-clamp-3'}`} title={item.text}>{item.text}</p>
                    {followUpIsLong(item.text) && <button
                      type="button"
                      aria-expanded={expandedFollowUps[item.id] === true}
                      aria-label={expandedFollowUps[item.id] ? `收起${FOLLOW_UP_KIND[item.kind]}追问` : `展开${FOLLOW_UP_KIND[item.kind]}追问全文`}
                      onClick={() => setExpandedFollowUps(previous => ({ ...previous, [item.id]: previous[item.id] !== true }))}
                      className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-2xs text-accent hover:underline"
                    >{expandedFollowUps[item.id] ? '收起' : '展开全文'}</button>}
                  </div>
                ))}
              </div>}

              {activity.plan && (planLines(activity.plan).length > 0 || activity.plan.items.length > 0) && <div className="mt-2 rounded-md border border-accent/30 bg-accent-subtle/30 px-2.5 py-2">
                <div className="text-2xs font-semibold text-accent">Agent 计划</div>
                {planLines(activity.plan).map((line, lineIndex) => (
                  <div key={`plan-line-${lineIndex}`}>
                    <QuoteAnchor entryId={line.entryId} className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-2xs leading-5 text-text">
                      <span title={line.text}>{line.text}</span>
                    </QuoteAnchor>
                    <RelatedNote related={line.related} />
                  </div>
                ))}
                {activity.plan.items.length > 0 && <StepList steps={activity.plan.items} numbered={false} className="mt-1.5 space-y-1" onFileOpen={onFileOpen} />}
              </div>}

              {activity.replies.length > 0 && <div className="ml-1 mt-3 space-y-2 border-l border-border pl-3">
                <div className="text-2xs font-semibold text-muted">Agent 回复{activity.replies.length > 1 ? ` · ${activity.replies.length} 条` : ''}</div>
                {activity.replies.map(reply => (
                  <div key={reply.id} className="rounded border border-border bg-bg px-2.5 py-2">
                    <div className="flex items-center gap-2 text-2xs text-muted">
                      <span className="shrink-0">{REPLY_KIND[reply.kind]}</span>
                      <span className="ml-auto shrink-0 font-mono">{reply.text.length.toLocaleString()} 字符</span>
                    </div>
                    <RelatedNote related={reply.related} />
                    <div className="mt-1"><ActivityReplyBody reply={reply} onFileOpen={onFileOpen} /></div>
                  </div>
                ))}
              </div>}
            </article>
          )
        })}
    </section>
  )
}
