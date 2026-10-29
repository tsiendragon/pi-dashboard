import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { SupervisorEvent } from '@shared/supervisor.js'
import { errorText, supervisorApi } from '../../features/supervisor/api'
import { EventTimeline } from '../../features/supervisor/EventTimeline'
import { useSupervisorResource } from '../../features/supervisor/useSupervisorResource'
import { SupervisorAgentButton } from '../../features/supervisor/SupervisorAgentProvider'
import { PendingConfirmations } from '../../features/supervisor/PendingConfirmations'
import type { LaneDef, PlanningEntry, SessionRef, TaskFact } from '@shared/tasks.js'
import { COMPLETION_LABEL, JIRA_DOT, JIRA_DRIFT_LABEL, KIND_LABEL, jiraDrift, laneOf, relativeTime, stageLabel, statusChipClass, statusLabel } from './helpers'
import type { Completion, PlanningOverlay } from '@shared/tasks.js'

interface Props {
  supervised?: boolean
  /** Jira 状态是显式刷新（服务端跑 acli）；这里只触发，不轮询。 */
  onRefreshJira?: () => void
  jiraBusy?: boolean
  task: TaskFact
  entry: PlanningEntry | undefined
  sessions: SessionRef[]
  lanes: LaneDef[]
  planning: PlanningOverlay
  authReady: boolean
  liveOptions: Array<{ sessionId: string; processInstanceId: string; title?: string; cwd: string }>
  onClose: () => void
  onUpdate: (uid: string, patch: PlanningEntry) => void
  onEdit: (uid: string, patch: { title?: string; description?: string; status?: string; tags?: string[] }) => void
  onDelete: (uid: string) => void
  onStart: (task: TaskFact) => void
  onOpenSession: (processInstanceId: string) => void
}

const PRIORITIES: Array<{ value: 0 | 1 | 2; label: string; cls: string }> = [
  { value: 0, label: 'P0', cls: 'text-danger' },
  { value: 1, label: 'P1', cls: 'text-warn' },
  { value: 2, label: 'P2', cls: 'text-muted' },
]

const STATUS_ORDER: Completion[] = ['todo', 'doing', 'done', 'paused']

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-body-s">
      <div className="w-20 shrink-0 text-muted">{label}</div>
      <div className="min-w-0 flex-1 text-text break-words">{children}</div>
    </div>
  )
}

export default function TaskDetailPage({ supervised = false, onRefreshJira, jiraBusy = false, task, entry, sessions, lanes, planning, authReady, liveOptions, onClose, onUpdate, onEdit, onDelete, onStart, onOpenSession }: Props) {
  const lane = laneOf(task, lanes, planning)
  const drift = jiraDrift(task)
  const canEdit = task.writable && (!supervised || task.providerId === 'local')
  const [picking, setPicking] = useState(false)
  // The timeline is the first thing to read when a task opens, so it loads on selection and never polls.
  const loadEvents = useCallback(async (signal: AbortSignal) => {
    const result = await supervisorApi.execute<SupervisorEvent[]>({ operation: 'events', args: { objectRef: task.uid, includeChildren: true } }, signal)
    if (!Array.isArray(result)) throw new Error('事件响应不符合契约；没有确认任何事件记录。')
    return result
  }, [task.uid])
  const timeline = useSupervisorResource(loadEvents, authReady, 0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div className="mx-auto max-w-[1200px] space-y-4">
        <div className="rounded-xl border border-border bg-card px-4 py-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-meta text-accent">{task.id}</span>
              <span className={`text-2xs px-1.5 py-0.5 rounded border ${statusChipClass(task)}`}>
                {statusLabel(task)}
              </span>
              {task.completionRaw && (
                <span className="text-2xs text-muted" title="原始状态值">({task.completionRaw})</span>
              )}
              {task.archived && <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-elevated text-muted border border-border">归档</span>}
              {task.jiraUrl && (
                <a
                  href={task.jiraUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-2xs px-1.5 py-0.5 rounded border border-info/40 text-info hover:bg-info/10 inline-flex items-center gap-1"
                  title={task.jiraStatus
                    ? `Jira：${task.jiraStatus.name}${task.jiraStatus.assignee ? ` · ${task.jiraStatus.assignee}` : ''}${task.jiraStatus.readAt ? `（读取于 ${relativeTime(task.jiraStatus.readAt)}）` : ''}`
                    : `在 Jira 打开 ${task.jiraKey}`}
                >
                  {task.jiraStatus && <span className={`w-1.5 h-1.5 rounded-full ${JIRA_DOT[task.jiraStatus.category]}`} />}
                  {task.jiraStatus ? `${task.jiraStatus.name} ↗` : 'Jira ↗'}
                </a>
              )}
              {drift && (
                <span className="text-2xs px-1.5 py-0.5 rounded bg-warn-subtle text-warn border border-warn/40" title={JIRA_DRIFT_LABEL[drift]}>
                  状态不一致
                </span>
              )}
            </div>
            {task.stage && (
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1 w-40 max-w-full overflow-hidden rounded-full bg-bg-hover">
                  <div
                    className={`h-full rounded-full ${task.stage.done === task.stage.total ? 'bg-ok' : 'bg-accent'}`}
                    style={{ width: `${Math.round((task.stage.done / task.stage.total) * 100)}%` }}
                  />
                </div>
                <span className="text-2xs text-muted">
                  阶段 {stageLabel(task)}{task.stage.active ? ` · 当前 ${task.stage.active}` : ''}
                </span>
              </div>
            )}
            {canEdit ? (
              <input
                aria-label="任务标题"
                defaultValue={task.title}
                onBlur={e => { const value = e.target.value.trim(); if (value && value !== task.title) onEdit(task.uid, { title: value }) }}
                className="mt-1 w-full bg-transparent text-lg font-semibold text-text-strong outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-accent/30"
              />
            ) : <div className="text-lg font-semibold text-text-strong mt-1">{task.title}</div>}
          </div>
          <button onClick={onClose} className="shrink-0 px-2 py-1 rounded-md text-body-s text-muted hover:text-text hover:bg-bg-hover border border-border">← 返回任务列表</button>
        </div>

        {/* A pending main-agent write stays on the task it targets, so approving never depends on
            spotting a modal that may have scrolled out of view. */}
        <PendingConfirmations objectRef={task.uid} />
        {supervised && <div className="rounded-xl border border-accent/30 bg-accent-subtle/40 px-4 py-3"><p className="text-body-s text-muted mb-2">本地任务可以直接修改并保存；其他来源的任务仍保持只读。也可以通过主 Agent 记录或修改。</p><SupervisorAgentButton objectRef={task.uid}>通过主 Agent 记录或修改</SupervisorAgentButton></div>}
        <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="min-w-0 rounded-xl border border-border bg-card px-5 py-5 shadow-sm">
            <div className="mb-5 flex items-center gap-3">
              <div>
                <h2 className="text-base font-semibold text-text-strong">任务时间线</h2>
                <p className="mt-1 text-2xs text-muted">按时间查看任务变化和工作记录</p>
              </div>
              <span className="text-2xs text-muted">{timeline.data ? `${timeline.data.length} 条记录` : timeline.loading ? '读取中…' : ''}</span>
              {onRefreshJira && task.jiraUrl && (
                <button
                  type="button"
                  onClick={onRefreshJira}
                  disabled={jiraBusy}
                  className="ml-auto shrink-0 rounded border border-border px-2 py-1 text-2xs text-muted hover:bg-bg-hover disabled:opacity-50"
                  title="用 acli 重新读一次这张单的 Jira 状态"
                >{jiraBusy ? '读取中…' : '刷新 Jira'}</button>
              )}
              <Link to={`/tasks/events?objectRef=${encodeURIComponent(task.uid)}`} onClick={onClose} className={`${onRefreshJira && task.jiraUrl ? '' : 'ml-auto '}shrink-0 text-2xs text-accent hover:underline`}>查看流水账 →</Link>
            </div>
            {timeline.error
              ? <p className="text-2xs text-danger">事件读取失败：{errorText(timeline.error)}</p>
              : timeline.data
                ? <EventTimeline key={task.uid} hideObject events={timeline.data} emptyHint="还没有任务事件。任务背景和目标请写在右侧说明中；进展、决定和反馈会单独记在这里。" />
                : <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-body-s text-muted">{authReady ? '正在读取事件…' : '需要先在 Live Pi 页面完成浏览器认证才能读取事件。'}</p>}
          </section>
          <fieldset disabled={!canEdit} className="min-w-0 space-y-4">
        {task.writable && (
          <section className="rounded-xl border border-border bg-card px-4 py-4 shadow-sm">
            <h2 className="text-meta font-semibold text-text-strong mb-3">任务状态</h2>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="修改任务状态">
              {STATUS_ORDER.map(s => (
                <button
                  key={s}
                  type="button"
                  aria-label={COMPLETION_LABEL[s]}
                  aria-pressed={task.completion === s}
                  onClick={() => task.completion !== s && onEdit(task.uid, { status: s })}
                  className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-left text-body-s font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${task.completion === s ? s === 'done' ? 'border-ok bg-ok-subtle text-ok shadow-sm' : s === 'paused' ? 'border-warn bg-warn-subtle text-warn shadow-sm' : 'border-accent bg-accent-subtle text-accent shadow-sm' : 'border-border bg-card text-muted hover:border-border-strong hover:bg-bg-hover'}`}
                >
                  <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-meta ${task.completion === s ? s === 'done' ? 'bg-ok-subtle text-ok' : s === 'paused' ? 'bg-warn-subtle text-warn' : 'bg-accent-subtle text-accent' : 'bg-bg-elevated text-muted'}`}>
                    {s === 'todo' ? '○' : s === 'doing' ? '◷' : s === 'done' ? '✓' : 'Ⅱ'}
                  </span>
                  {COMPLETION_LABEL[s]}
                </button>
              ))}
            </div>
          </section>
        )}
        {task.writable ? (
          <section className="rounded-xl border border-border bg-card px-4 py-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-meta font-semibold text-text-strong">任务说明</h2>
              <span className="text-2xs text-muted">背景 / 目标 / 做法</span>
            </div>
            <textarea
              aria-label="任务上下文"
              defaultValue={task.description ?? ''}
              onBlur={e => { if ((e.target.value || '') !== (task.description ?? '')) onEdit(task.uid, { description: e.target.value }) }}
              rows={5}
              placeholder="记录任务背景、目标和做法；进展、决定和反馈请记在时间线上。"
              className="w-full resize-y rounded-lg border border-border bg-bg-elevated px-3 py-2.5 text-body-s text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <p className="mt-2 text-2xs leading-relaxed text-muted">这里保存任务上下文，不放按日期追加的事件记录。</p>
            <div className="mt-3 flex items-center gap-2">
              <span className="w-10 shrink-0 text-body-s text-muted">标签</span>
              <input
                key={`${task.uid}:${task.tags.join(',')}`}
                defaultValue={task.tags.join(', ')}
                onBlur={e => {
                  const tags = e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                  if (JSON.stringify(tags) !== JSON.stringify(task.tags)) onEdit(task.uid, { tags })
                }}
                placeholder="逗号分隔，如：urgent, review"
                className="min-w-0 flex-1 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-body-s text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </div>
            <button
              type="button"
              onClick={() => onDelete(task.uid)}
              className="mt-4 rounded-md border border-danger px-2.5 py-1.5 text-2xs text-danger hover:bg-danger-subtle"
            >
              删除任务
            </button>
          </section>
        ) : (
          <div className="rounded-xl border border-border bg-card px-4 py-3 text-2xs text-muted">
            只读来源（{task.sourceLabel}）· 修改请走任务系统
          </div>
        )}

        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <Row label="类型">{KIND_LABEL[task.kind] ?? task.kind}</Row>
          <Row label="来源">{task.sourceLabel}</Row>
          {task.jiraUrl && (
            <Row label="Jira">
              <a href={task.jiraUrl} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline font-mono text-meta" title={`在 Jira 打开 ${task.jiraKey}`}>
                {task.jiraKey} ↗
              </a>
              {task.jiraStatus ? (
                <span className="ml-2 text-meta">
                  <span className={`mr-1 inline-block w-1.5 h-1.5 rounded-full ${JIRA_DOT[task.jiraStatus.category]}`} />
                  {task.jiraStatus.name}
                  {task.jiraStatus.assignee && <span className="text-muted"> · {task.jiraStatus.assignee}</span>}
                  {task.jiraStatus.priority && <span className="text-muted"> · {task.jiraStatus.priority}</span>}
                </span>
              ) : (
                <span className="ml-2 text-2xs text-muted">状态未读取{onRefreshJira ? '（点「刷新 Jira」）' : ''}</span>
              )}
              {task.jiraStatus?.readAt && (
                <div className="mt-0.5 text-2xs text-muted">Jira 状态读取于 {relativeTime(task.jiraStatus.readAt)}</div>
              )}
              {drift && <div className="mt-0.5 text-2xs text-warn">{JIRA_DRIFT_LABEL[drift]}：建议在 Jira 或任务系统里对齐一边</div>}
            </Row>
          )}
          {task.parentTitle && (
            <Row label="所属">
              {task.parentUid
                ? <Link to={`/tasks/${encodeURIComponent(task.parentUid)}`} className="text-accent hover:underline">{task.parentTitle}</Link>
                : task.parentTitle}
            </Row>
          )}
          {task.stage && (
            <Row label="阶段">
              {stageLabel(task)}{task.stage.active ? <span className="ml-1 font-mono text-meta text-muted">· {task.stage.active}</span> : null}
            </Row>
          )}
          {task.path && <Row label="目录"><span className="font-mono text-meta break-all">{task.path}</span></Row>}
          {task.progress && <Row label="进度">{task.progress.done}/{task.progress.total}</Row>}
          {task.updatedAt && <Row label="更新"><span title={task.updatedAt}>{relativeTime(task.updatedAt)}</span></Row>}
        </div>

        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-meta font-medium text-muted">关联会话</div>
            {task.path && (
              <button
                onClick={() => onStart(task)}
                disabled={!authReady}
                title={authReady ? '以任务目录为 cwd 启动 Live Pi 会话' : '请先在 Live Pi 页面完成认证'}
                className="text-2xs px-2 py-1 rounded border border-accent text-accent hover:bg-accent-subtle disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ▶ 起会话
              </button>
            )}
          </div>
          {sessions.length === 0 ? (
            <div className="text-body-s text-muted">暂无（按任务目录 / 标签自动关联）</div>
          ) : (
            <div className="grid gap-1.5">
              {sessions.map(s => {
                const manual = (entry?.sessionIds ?? []).includes(s.sessionId)
                return (
                  <div
                    key={s.sessionId}
                    onClick={() => s.processInstanceId && onOpenSession(s.processInstanceId)}
                    className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-bg-elevated hover:bg-bg-hover border border-border cursor-pointer"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${s.live ? 'bg-ok animate-dot-breathe' : 'bg-muted'}`} />
                    <span className="min-w-0 flex-1 text-body-s text-text truncate">{s.title || s.cwd || s.sessionId}</span>
                    {manual && (
                      <button
                        onClick={e => { e.stopPropagation(); onUpdate(task.uid, { sessionIds: (entry?.sessionIds ?? []).filter(x => x !== s.sessionId) }) }}
                        className="text-2xs text-muted hover:text-danger"
                        title="取消手动关联"
                      >✕</button>
                    )}
                    <span className="text-2xs text-muted">{s.live ? 'live' : 'past'}</span>
                  </div>
                )
              })}
            </div>
          )}

          {task.plannable && (
            <div className="mt-2">
              <button onClick={() => setPicking(v => !v)} className="text-2xs text-accent hover:underline">+ 关联会话</button>
              {picking && (
                <div className="mt-1.5 max-h-40 overflow-y-auto border border-border rounded-md divide-y divide-border">
                  {liveOptions.filter(s => !(entry?.sessionIds ?? []).includes(s.sessionId)).length === 0 ? (
                    <div className="px-2 py-1.5 text-2xs text-muted">没有可关联的会话（需在 Live Pi 认证且有活跃会话）</div>
                  ) : (
                    liveOptions.filter(s => !(entry?.sessionIds ?? []).includes(s.sessionId)).map(s => (
                      <button
                        key={s.sessionId}
                        onClick={() => { onUpdate(task.uid, { sessionIds: [...(entry?.sessionIds ?? []), s.sessionId] }); setPicking(false) }}
                        className="w-full text-left px-2 py-1.5 hover:bg-bg-hover"
                      >
                        <div className="text-body-s text-text truncate">{s.title || s.cwd || s.sessionId}</div>
                        <div className="text-2xs text-muted truncate">{s.cwd}</div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="text-meta font-medium text-muted mb-2">规划 <span className="text-2xs">（仅本页，不改动来源）</span></div>
          {!task.plannable && (
            <div className="text-body-s text-muted mb-2">此条身份不稳定，仅只读展示。</div>
          )}
          <div className={`grid gap-3 ${task.plannable ? '' : 'opacity-50 pointer-events-none'}`}>
            <div className="flex items-center gap-2">
              <span className="text-body-s text-muted w-20">优先级</span>
              {PRIORITIES.map(p => (
                <button
                  key={p.value}
                  onClick={() => onUpdate(task.uid, { priority: entry?.priority === p.value ? undefined : p.value })}
                  className={`px-2 py-1 rounded-md text-body-s border ${entry?.priority === p.value ? `border-accent bg-accent-subtle ${p.cls}` : 'border-border text-muted hover:bg-bg-hover'}`}
                >
                  {p.label}
                </button>
              ))}
              <button
                onClick={() => onUpdate(task.uid, { pinned: !entry?.pinned })}
                className={`ml-auto px-2 py-1 rounded-md text-body-s border ${entry?.pinned ? 'border-accent bg-accent-subtle text-accent' : 'border-border text-muted hover:bg-bg-hover'}`}
              >
                {entry?.pinned ? '★ 已聚焦' : '☆ 聚焦'}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-body-s text-muted w-20">泳道</span>
              <select
                value={entry?.laneOverride ?? lane}
                onChange={e => onUpdate(task.uid, { laneOverride: e.target.value })}
                className="flex-1 bg-bg-elevated border border-border rounded-md px-2 py-1 text-body-s text-text"
              >
                {lanes.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
                <option value="uncategorized">未分类</option>
              </select>
            </div>
            <div>
              <div className="text-body-s text-muted mb-1">备注</div>
              <textarea
                defaultValue={entry?.note ?? ''}
                onBlur={e => { if ((e.target.value || '') !== (entry?.note ?? '')) onUpdate(task.uid, { note: e.target.value }) }}
                rows={3}
                placeholder="记录下一步、阻塞、决策…"
                className="w-full bg-bg-elevated border border-border rounded-md px-2.5 py-2 text-body-s text-text resize-y"
              />
            </div>
          </div>
        </div>
          </fieldset>
        </div>
      </div>
    </>
  )
}
