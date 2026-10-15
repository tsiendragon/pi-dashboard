import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { SupervisorEvent, SupervisorSession } from '../../../../shared/src/supervisor'
import MarkdownRenderer from '../../components/MarkdownRenderer'
import { supervisorApi } from './api'
import { ObjectLink, timeText } from './SupervisorViews'

/**
 * Vertical-axis event timeline shared by the ledger page and the task drawer.
 *
 * One node per day, one dot per event: the collapsed row is a summary that can be read at a glance, the
 * expanded row keeps every field the old flat card had (including screenshots). Records without a usable
 * time are grouped under an explicit "时间未知" node rather than dropped: no time never means "did not happen".
 */
export interface TimelineTask { uid: string; title: string }

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function eventTime(event: SupervisorEvent): number {
  const raw = event.occurredAt || event.recordedAt
  const time = raw ? new Date(raw).getTime() : Number.NaN
  return Number.isNaN(time) ? 0 : time
}

/** Local calendar day key, or `''` when the record has no usable time at all. */
export function dayKeyOf(event: SupervisorEvent): string {
  const time = eventTime(event)
  if (!time) return ''
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function clockOf(event: SupervisorEvent): string {
  const time = eventTime(event)
  if (!time) return '时间未知'
  const date = new Date(time)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  // Without an occurrence time the axis shows the recording time, labelled so it cannot be read as "happened then".
  return event.occurredAt ? clock : '记 ' + clock
}

/** Markdown-ish description flattened into one readable line for the collapsed row. */
export function plainSummary(event: SupervisorEvent, max = 150): string {
  const text = (event.description || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*`_|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text
}

export interface TimelineDay { key: string; label: string; weekday: string; items: SupervisorEvent[] }

/** Newest day first (oldest→newest when `order` is `'asc'`); records without a time come last. */
export function groupByDay(events: readonly SupervisorEvent[], order: 'desc' | 'asc' = 'desc'): TimelineDay[] {
  const sorted = [...events].sort((left, right) => order === 'desc' ? eventTime(right) - eventTime(left) : eventTime(left) - eventTime(right))
  const days = new Map<string, SupervisorEvent[]>()
  for (const event of sorted) {
    const key = dayKeyOf(event)
    const bucket = days.get(key)
    if (bucket) bucket.push(event)
    else days.set(key, [event])
  }
  const groups = [...days.entries()].map(([key, items]) => {
    if (!key) return { key, label: '时间未知', weekday: '未记录发生时间，不代表没有发生', items }
    const date = new Date(eventTime(items[0]))
    return { key, label: `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`, weekday: WEEKDAYS[date.getDay()], items }
  })
  return groups.sort((left, right) => {
    if (!left.key) return 1
    if (!right.key) return -1
    return order === 'desc' ? right.key.localeCompare(left.key) : left.key.localeCompare(right.key)
  })
}

const TYPE_DOT: Record<string, string> = {
  decision: 'bg-info', progress: 'bg-accent', blocked: 'bg-warn', result: 'bg-ok', reply: 'bg-aim', resumed: 'bg-aim', suggestion: 'bg-clarify',
}
const TYPE_BADGE: Record<string, string> = {
  decision: 'text-info bg-accent-subtle', progress: 'text-accent bg-accent-subtle', blocked: 'text-warn bg-warn-subtle',
  result: 'text-ok bg-ok-subtle', reply: 'text-aim bg-aim-subtle', resumed: 'text-aim bg-aim-subtle', suggestion: 'text-clarify bg-clarify-subtle',
}
const SOURCE_LABEL: Record<string, string> = {
  user: '用户本人提供', relay: '用户转述合作方（未独立核实）', agent: '主 Agent 观察或建议',
}
/** Days older than the newest one collapse by default once the timeline gets long. */
export const FOLD_THRESHOLD = 12

export function EventAttachment({ id, large = false }: { id: string; large?: boolean }) {
  const [failed, setFailed] = useState(false)
  const url = supervisorApi.attachmentUrl(id)
  return <figure className="space-y-1">
    <a className="text-accent text-body-s break-all" href={url} target="_blank" rel="noreferrer">附件 {id}</a>
    {failed
      ? <p className="text-danger text-body-s">图片预览不可用或需要重新认证；请打开附件检查。</p>
      : <a href={url} target="_blank" rel="noreferrer"><img loading="lazy" src={url} alt={'事件图片 ' + id} onError={() => setFailed(true)} className={(large ? 'max-h-64' : 'max-h-40') + ' max-w-full rounded border border-border'} /></a>}
  </figure>
}

function Thumbnail({ id }: { id: string }) {
  const [failed, setFailed] = useState(false)
  const url = supervisorApi.attachmentUrl(id)
  if (failed) return <span className="text-2xs text-danger">图片不可用，展开后点附件检查。</span>
  return <a href={url} target="_blank" rel="noreferrer"><img loading="lazy" src={url} alt={'事件图片 ' + id} onError={() => setFailed(true)} className="h-[50px] w-[74px] rounded border border-border object-cover" /></a>
}

function EventRow({ event, tasks, sessions, compact, hideObject, open, onToggle }: {
  event: SupervisorEvent; tasks: TimelineTask[]; sessions: SupervisorSession[]; compact: boolean; hideObject: boolean; open: boolean; onToggle: () => void
}) {
  const sourceSession = sessions.find(session => session.sessionId === event.source.sessionId)
  const title = event.title || event.objectSnapshot?.title || '（无标题记录）'
  const summary = plainSummary(event) || '（该记录没有描述文本）'
  const bodyId = `timeline-body-${event.id}`
  return <article className="relative rounded-lg border border-border bg-card shadow-sm" data-open={open}>
    {/* The per-event dot sits on the day axis. */}
    <span aria-hidden className={'absolute -left-[15px] top-[18px] h-2 w-2 rounded-full ' + (TYPE_DOT[event.type] || 'bg-border-strong')} />
    <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle} className="w-full text-left p-3 flex items-start gap-2.5">
      <span className="w-10 shrink-0 pt-0.5 font-mono text-2xs text-muted">{clockOf(event)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-body-s font-semibold text-text-strong">{title}</span>
          <span className={'rounded-full px-1.5 py-0.5 text-2xs font-semibold ' + (TYPE_BADGE[event.type] || 'text-muted bg-bg-elevated border border-border')}>{event.type}</span>
          {event.stage && <span className="text-2xs text-muted">阶段 {event.stage}</span>}
        </span>
        {!open && <>
          <span className="mt-1 block text-body-s text-muted-strong">{summary}</span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {!!event.participants.length && <span className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted">参与人：{event.participants.join('、')}</span>}
            {event.recorder && <span className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted">记录人：{event.recorder}</span>}
            <span className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted">{SOURCE_LABEL[event.source.kind] ?? event.source.kind}</span>
            {event.version > 1 && <span className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted">版本 {event.version}</span>}
          </span>
          {!!event.attachmentIds.length && <span className="mt-2 flex flex-wrap gap-1.5">{event.attachmentIds.slice(0, 1).map(id => <Thumbnail key={id} id={id} />)}</span>}
        </>}
      </span>
      <span className="shrink-0 pt-0.5 text-2xs text-muted">{open ? '收起' : '展开'}</span>
    </button>
    {open && <div id={bodyId} className="space-y-3 border-t border-dashed border-border p-3">
      {!compact && !hideObject && <ObjectLink uid={event.objectRef} title={tasks.find(task => task.uid === event.objectRef)?.title || event.objectSnapshot?.title} />}
      <p className="text-muted text-body-s">类型：{event.type}{event.stage && ' · 阶段：' + event.stage} · 版本 {event.version}</p>
      <div className="text-body-s space-y-1">
        <p>发生时间：{timeText(event.occurredAt)}</p>
        <p>记录时间：{timeText(event.recordedAt)}</p>
        <p>参与人：{event.participants.join('、') || '未知'}</p>
        <p>记录人：{event.recorder || '历史记录未提供'}</p>
        <p>来源：{SOURCE_LABEL[event.source.kind] ?? event.source.kind}{event.source.messageRef && ' · 消息 ' + event.source.messageRef}</p>
        {event.source.sessionId && (sourceSession
          ? <Link className="text-accent" to={'/live-sessions/' + encodeURIComponent(sourceSession.processInstanceId)}>来源会话 {event.source.sessionId}</Link>
          : <p className="text-muted break-all">来源会话 {event.source.sessionId}（进程映射未知）</p>)}
        {event.waitingFor && <p>在等：{event.waitingFor}</p>}
      </div>
      <MarkdownRenderer content={event.description} />
      {event.originalReply && <details><summary className="cursor-pointer">原始回复</summary><div className="pt-2"><MarkdownRenderer content={event.originalReply} /></div></details>}
      {event.nextStep && <div><h4 className="text-body-s font-medium">下一步</h4><MarkdownRenderer content={event.nextStep} /></div>}
      {!!event.attachmentIds.length && <div className="flex flex-wrap gap-3">{event.attachmentIds.slice(0, 4).map(id => <EventAttachment key={id} id={id} large />)}</div>}
      {!!event.revisions.length && <details><summary className="cursor-pointer">修订历史（{event.revisions.length}）</summary><ul className="space-y-2 pt-2">{event.revisions.map((revision, index) => <li key={index} className="text-body-s"><p>版本 {revision.version} · {revision.actor} · {timeText(revision.at)}</p><pre className="overflow-auto rounded bg-bg p-2 text-2xs">{JSON.stringify(revision.previous, null, 2)}</pre></li>)}</ul></details>}
      <p className="text-muted text-2xs break-all">事件 {event.id} · 请求 {event.requestId}</p>
    </div>}
  </article>
}

export function EventTimeline({ events, tasks = [], sessions = [], compact = false, hideObject = false, order = 'desc', emptyHint }: {
  events: readonly SupervisorEvent[]; tasks?: TimelineTask[]; sessions?: SupervisorSession[]; compact?: boolean
  hideObject?: boolean; order?: 'desc' | 'asc'; emptyHint?: string
}) {
  const days = useMemo(() => groupByDay(events, order), [events, order])
  // Two defaults matter: a long history starts folded (only the newest day open), a short one starts fully
  // visible — and the newest record starts expanded. They are derived, not initialised, because the page
  // renders this component before events arrive; a user toggle then overrides the default until remount.
  const defaults = useMemo(() => {
    const keys = days.filter(day => day.key).map(day => day.key)
    const newestKey = order === 'desc' ? days[0]?.key : days[days.length - 1]?.key
    const folded = events.length > FOLD_THRESHOLD && keys.length > 1 ? new Set(keys.filter(key => key !== newestKey)) : new Set<string>()
    const newest = [...events].sort((left, right) => eventTime(right) - eventTime(left))[0]
    return { folded, open: new Set<string>(newest ? [newest.id] : []) }
  }, [days, events, order])
  const [foldOverride, setFoldOverride] = useState<Set<string> | null>(null)
  const [openOverride, setOpenOverride] = useState<Set<string> | null>(null)
  const collapsedDays = foldOverride ?? defaults.folded
  const openIds = openOverride ?? defaults.open
  const toggleDay = (key: string) => setFoldOverride(current => { const next = new Set(current ?? defaults.folded); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const toggleEvent = (id: string) => setOpenOverride(current => { const next = new Set(current ?? defaults.open); if (next.has(id)) next.delete(id); else next.add(id); return next })

  if (!events.length) return <p className="text-muted">{emptyHint || '没有返回事件；不代表没有发生工作。'}</p>
  const folded = days.filter(day => collapsedDays.has(day.key)).length
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2 text-2xs text-muted">
      <span>{days.length} 天 · {events.length} 条{order === 'desc' ? '（新 → 旧）' : '（旧 → 新）'}</span>
      {days.length > 1 && <>
        <button type="button" className="text-accent hover:underline" onClick={() => setFoldOverride(new Set())}>展开全部日期</button>
        <button type="button" className="text-accent hover:underline" onClick={() => setFoldOverride(new Set(days.map(day => day.key)))}>收起全部日期</button>
      </>}
      {folded > 0 && <span>已折叠 {folded} 天；点日期展开。</span>}
    </div>
    <ol aria-label="事件时间线" className="space-y-1">
      {days.map(day => {
        const collapsed = collapsedDays.has(day.key)
        return <li key={day.key || 'unknown'} className={compact ? 'grid grid-cols-[18px_1fr] items-start' : 'grid grid-cols-[96px_20px_1fr] items-start sm:grid-cols-[104px_20px_1fr]'}>
          {compact
            ? <span aria-hidden className="relative block self-stretch"><span className="absolute left-[7px] top-2 bottom-0 w-0.5 bg-border-strong opacity-60" /><span className={'absolute left-[3px] top-2 h-2.5 w-2.5 rounded-full border-2 border-accent bg-card' + (collapsed ? '' : '')} /></span>
            : <button type="button" aria-expanded={!collapsed} onClick={() => toggleDay(day.key)} className="pt-3 pr-2 text-right hover:text-accent">
                <span className="block text-body-s font-semibold text-text-strong">{day.label}</span>
                <span className="block text-2xs text-muted">{day.weekday} · {day.items.length} 条</span>
              </button>}
          {!compact && <span aria-hidden className="relative block self-stretch"><span className="absolute left-[7px] top-0 bottom-0 w-0.5 bg-border-strong opacity-60" /><span className="absolute left-[3px] top-3.5 h-3 w-3 rounded-full border-2 border-accent bg-card" /></span>}
          <div className="min-w-0 py-1.5 space-y-2.5">
            {compact && <button type="button" aria-expanded={!collapsed} onClick={() => toggleDay(day.key)} className="block text-left text-2xs text-muted hover:text-accent">
              <span className="font-semibold text-text-strong">{day.label}</span> · {day.weekday} · {day.items.length} 条 {collapsed ? '（已折叠，点开）' : ''}
            </button>}
            {collapsed
              ? <p className="text-2xs text-muted">该日 {day.items.length} 条记录已折叠：{day.items.slice(0, 3).map(item => item.title).join('、')}{day.items.length > 3 ? '…' : ''}</p>
              : day.items.map(event => <EventRow key={event.id} event={event} tasks={tasks} sessions={sessions} compact={compact} hideObject={hideObject} open={openIds.has(event.id)} onToggle={() => toggleEvent(event.id)} />)}
          </div>
        </li>
      })}
    </ol>
    <p className="text-2xs text-muted">点日期折叠整天，点标题展开单条记录（含图片）。没有时间的记录列在最后，不会被当作没发生。</p>
  </div>
}