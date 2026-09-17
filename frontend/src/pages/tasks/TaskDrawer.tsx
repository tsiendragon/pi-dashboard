import { useEffect, useState, type ReactNode } from 'react'
import type { LaneDef, PlanningEntry, SessionRef, TaskFact } from '@shared/tasks.js'
import { COMPLETION_LABEL, KIND_LABEL, laneOf, statusChipClass, statusLabel } from './helpers'
import type { Completion, PlanningOverlay } from '@shared/tasks.js'

interface Props {
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

export default function TaskDrawer({ task, entry, sessions, lanes, planning, authReady, liveOptions, onClose, onUpdate, onEdit, onDelete, onStart, onOpenSession }: Props) {
  const lane = laneOf(task, lanes, planning)
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div className="fixed inset-0 z-40 bg-bg/60 backdrop-blur-[1px]" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 h-full w-full max-w-[440px] overflow-y-auto bg-card border-l border-border shadow-xl animate-slide-in-right">
        <div className="sticky top-0 bg-card/95 backdrop-blur border-b border-border px-4 py-3 flex items-start gap-3">
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
            </div>
            <div className="text-body-s font-semibold text-text-strong mt-1">{task.title}</div>
          </div>
          <button onClick={onClose} className="shrink-0 w-7 h-7 grid place-items-center rounded-md text-muted hover:text-text hover:bg-bg-hover" aria-label="Close">✕</button>
        </div>

        {task.writable ? (
          <div className="px-4 py-3 border-b border-border">
            <div className="text-meta font-medium text-muted mb-2">内容</div>
            <div className="grid gap-2">
              <input
                defaultValue={task.title}
                onBlur={e => { const v = e.target.value.trim(); if (v && v !== task.title) onEdit(task.uid, { title: v }) }}
                className="w-full bg-bg-elevated border border-border rounded-md px-2.5 py-2 text-body-s text-text"
                placeholder="标题"
              />
              <textarea
                defaultValue={task.description ?? ''}
                onBlur={e => { if ((e.target.value || '') !== (task.description ?? '')) onEdit(task.uid, { description: e.target.value }) }}
                rows={3}
                placeholder="说明 / 等谁 / 下一步…"
                className="w-full bg-bg-elevated border border-border rounded-md px-2.5 py-2 text-body-s text-text resize-y"
              />
              <div className="flex items-center gap-2">
                <span className="text-body-s text-muted w-20 shrink-0">标签</span>
                <input
                  key={`${task.uid}:${task.tags.join(',')}`}
                  defaultValue={task.tags.join(', ')}
                  onBlur={e => {
                    const tags = e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                    if (JSON.stringify(tags) !== JSON.stringify(task.tags)) onEdit(task.uid, { tags })
                  }}
                  placeholder="逗号分隔，如：urgent, review"
                  className="flex-1 bg-bg-elevated border border-border rounded-md px-2.5 py-1.5 text-body-s text-text"
                />
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {STATUS_ORDER.map(s => (
                  <button
                    key={s}
                    onClick={() => task.completion !== s && onEdit(task.uid, { status: s })}
                    className={`px-2 py-1 rounded-md text-2xs border ${task.completion === s ? 'border-accent/40 bg-accent-subtle text-accent' : 'border-border text-muted hover:bg-bg-hover'}`}
                  >
                    {COMPLETION_LABEL[s]}
                  </button>
                ))}
                <button
                  onClick={() => onDelete(task.uid)}
                  className="ml-auto px-2 py-1 rounded-md text-2xs border border-danger/30 text-danger hover:bg-danger-subtle"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="px-4 py-2.5 border-b border-border text-2xs text-muted">
            只读来源（{task.sourceLabel}）· 修改请走 task-pilot
          </div>
        )}

        <div className="px-4 py-3">
          <Row label="类型">{KIND_LABEL[task.kind] ?? task.kind}</Row>
          <Row label="来源">{task.sourceLabel}</Row>
          {task.parentTitle && <Row label="所属">{task.parentTitle}</Row>}
          {task.path && <Row label="目录"><span className="font-mono text-meta break-all">{task.path}</span></Row>}
          {task.tags.length > 0 && <Row label="标签">{task.tags.join(' · ')}</Row>}
          {task.progress && <Row label="进度">{task.progress.done}/{task.progress.total}</Row>}
        </div>

        <div className="px-4 py-3 border-t border-border">
          <div className="flex items-center justify-between mb-2">
            <div className="text-meta font-medium text-muted">关联会话</div>
            {task.path && (
              <button
                onClick={() => onStart(task)}
                disabled={!authReady}
                title={authReady ? '以任务目录为 cwd 启动 Live Pi 会话' : '请先在 Live Pi 页面完成认证'}
                className="text-2xs px-2 py-1 rounded border border-accent/30 text-accent hover:bg-accent-subtle disabled:opacity-40 disabled:cursor-not-allowed"
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

        <div className="px-4 py-3 border-t border-border">
          <div className="text-meta font-medium text-muted mb-2">规划 <span className="text-2xs">（仅本面板，不改动来源）</span></div>
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
                  className={`px-2 py-1 rounded-md text-body-s border ${entry?.priority === p.value ? `border-accent/40 bg-accent-subtle ${p.cls}` : 'border-border text-muted hover:bg-bg-hover'}`}
                >
                  {p.label}
                </button>
              ))}
              <button
                onClick={() => onUpdate(task.uid, { pinned: !entry?.pinned })}
                className={`ml-auto px-2 py-1 rounded-md text-body-s border ${entry?.pinned ? 'border-accent/40 bg-accent-subtle text-accent' : 'border-border text-muted hover:bg-bg-hover'}`}
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
      </aside>
    </>
  )
}
