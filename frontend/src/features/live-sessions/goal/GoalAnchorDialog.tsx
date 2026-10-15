import { useEffect, useRef, type ReactNode } from 'react'
import {
  goalProgressOf,
  goalStaleness,
  GOAL_STALE_MESSAGE_THRESHOLD,
  type GoalAnchor,
  type GoalBlocker,
  type GoalSourceDoc,
  type GoalWorkItem,
} from '@shared/goal-anchor'

/**
 * The task anchor dialog: the goal the session is pursuing, how far along its
 * checklist is, and what is currently in the way.
 *
 * Shared by the live-session page and the session-graph page, so it renders from
 * a value only — it never fetches. Callers own "where the goal came from".
 */

const GOAL_STATUS_LABEL: Record<NonNullable<GoalAnchor['status']>, string> = {
  active: '进行中',
  paused: '已暂停',
  complete: '已完成',
}

const WORK_ITEM_LABEL: Record<NonNullable<GoalWorkItem['state']>, string> = {
  todo: '待做',
  in_progress: '进行中',
  done: '已完成',
  blocked: '受阻',
  deferred: '暂缓',
}

const WORK_ITEM_GLYPH: Record<NonNullable<GoalWorkItem['state']>, string> = {
  todo: '○',
  in_progress: '◐',
  done: '✓',
  blocked: '!',
  deferred: '⏸',
}

/** Tone per work-item state, kept next to the labels so both stay in step. */
const WORK_ITEM_CLASS: Record<NonNullable<GoalWorkItem['state']>, string> = {
  todo: 'bg-bg-hover text-muted',
  in_progress: 'bg-accent-subtle text-accent',
  done: 'bg-ok-subtle text-ok',
  blocked: 'bg-danger-subtle text-danger',
  deferred: 'bg-aim-subtle text-aim',
}

const BLOCKER_OWNER_LABEL: Record<string, string> = {
  agent: 'Agent',
  user: '用户',
  external: '外部',
}

const BLOCKER_KIND_LABEL: Record<string, string> = {
  technical: '技术问题',
  dependency: '依赖',
  external_wait: '等待外部',
  permission_or_credential: '权限或凭证',
  user_decision: '待用户决策',
  policy_or_safety: '策略或安全限制',
  scope_unclear: '范围不明确',
}

const BLOCKER_DISPOSITION_LABEL: Record<string, string> = {
  agent_can_try: 'Agent 可继续尝试',
  needs_user: '需要你协助',
  external_wait: '等待外部处理',
}

const SOURCE_KIND_LABEL: Record<string, string> = {
  prd: '需求文档',
  doc: '文档',
  directory: '目录',
  manual: '手动提供',
}

function Chip({ tone, children }: { tone?: 'ok' | 'accent' | 'warn'; children: ReactNode }) {
  const cls = tone === 'ok'
    ? 'bg-ok-subtle text-ok'
    : tone === 'accent'
      ? 'bg-accent-subtle text-accent'
      : tone === 'warn'
        ? 'bg-warn-subtle text-warn'
        : 'bg-bg-hover text-muted'
  return <span className={`rounded px-2 py-0.5 text-2xs leading-none ${cls}`}>{children}</span>
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-meta font-semibold text-muted">{title}</h3>
      <div className="mt-1">{children}</div>
    </section>
  )
}

function blockerMeta(blocker: GoalBlocker): string {
  const parts = [
    blocker.owner ? `负责人：${BLOCKER_OWNER_LABEL[blocker.owner] ?? blocker.owner}` : undefined,
    blocker.kind ? `类型：${BLOCKER_KIND_LABEL[blocker.kind] ?? blocker.kind}` : undefined,
    blocker.disposition ? `处置：${BLOCKER_DISPOSITION_LABEL[blocker.disposition] ?? blocker.disposition}` : undefined,
  ].filter((part): part is string => !!part)
  return parts.join(' · ')
}

function needsUser(blocker: GoalBlocker): boolean {
  return blocker.disposition === 'needs_user'
}

/** "3 分钟前" is friendlier than a clock time for something the agent refreshes. */
function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return new Date(timestamp).toLocaleString()
}

function updatedLabel(goal: GoalAnchor): string {
  if (goal.updatedAt === undefined) return '会话记录里没有时间戳'
  return `${relativeTime(goal.updatedAt)}（工作项已 ${goal.messagesSinceUpdate} 条对话记录未更新）`
}

export interface GoalAnchorDialogProps {
  goal: GoalAnchor | null
  /** False while the session timeline has not loaded, so we can tell it apart from "no goal". */
  loaded?: boolean
  /** `snapshot` = the session already ended; write actions are hidden. */
  mode?: 'live' | 'snapshot'
  /**
   * Set when the source file was oversized and only its tail was read. The
   * newest goal state is what we show, so the anchor is still right — the flag
   * only says older history was not scanned.
   */
  partial?: boolean
  /** Disables the sync action while a command is in flight. */
  busy?: boolean
  onClose: () => void
  /** Live sessions: ask the agent to refresh the checklist. */
  onSync?: () => void
  /** Ended sessions: continue the work in a new session rooted at the same cwd. */
  onResume?: () => void
}

export default function GoalAnchorDialog({ goal, loaded = true, mode = 'live', partial = false, busy = false, onClose, onSync, onResume }: GoalAnchorDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    dialogRef.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const progress = goalProgressOf(goal)
  const staleness = goalStaleness(goal)
  const staleText = staleness === 'complete_with_open_items'
    ? `目标已标记「${goal?.status ? GOAL_STATUS_LABEL[goal.status] : '已完成'}」，但 ${(progress?.total ?? 0) - (progress?.done ?? 0)} 个工作项还没勾选 —— 这份清单可能过期。`
    : staleness === 'no_recent_update'
      ? `工作项已 ${GOAL_STALE_MESSAGE_THRESHOLD} 条以上对话记录没有更新 —— 这份清单可能过期。`
      : ''

  /* Blockers the user must act on come first: they are the only ones that block us. */
  const blockers = goal ? [...goal.blockers].sort((a, b) => Number(needsUser(b)) - Number(needsUser(a))) : []

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="goal-anchor-dialog-title"
        onClick={event => event.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl outline-none"
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <h2 id="goal-anchor-dialog-title" className="text-sm font-semibold">任务锚点</h2>
          {goal?.status && <Chip tone={goal.status === 'complete' ? 'ok' : 'accent'}>{`目标：${GOAL_STATUS_LABEL[goal.status]}`}</Chip>}
          {progress && progress.total > 0 && (
            <Chip tone={progress.done === progress.total ? 'ok' : 'accent'}>{`${progress.done}/${progress.total} 完成`}</Chip>
          )}
          {progress && progress.needsUser > 0 && <Chip tone="warn">{`${progress.needsUser} 项需要你处理`}</Chip>}
          {mode === 'snapshot' && <Chip>只读快照</Chip>}
          <button type="button" onClick={onClose} aria-label="关闭任务锚点弹窗" className="ml-auto rounded px-2 py-1 text-2xs text-muted hover:bg-bg-hover hover:text-text">关闭</button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {!loaded
            ? <div role="status" className="text-body-s text-muted">正在读取任务锚点…</div>
            : !goal
              ? <div className="rounded-lg border border-dashed border-border-strong bg-bg-elevated p-4">
                <h4 className="text-body-s font-semibold text-text-strong">这条会话还没有设目标</h4>
                <p className="mt-1 text-2xs text-muted-strong">
                  没有目标，就没有能扛住长时间对话的锚：会话跑长之后容易忘记还剩哪些事、你最初提的要求是什么。
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-2xs text-muted-strong">
                  <li>设了目标后，目标原文和工作项清单会在每轮对话前重新放进上下文，压缩上下文之后也不会丢。</li>
                  <li>你可以自己敲 <code className="font-mono">/goal</code>，也可以让 agent 从这条会话开头的需求里草拟一份。</li>
                </ul>
              </div>
              : <>
                {staleText && (
                  <div role="status" className="flex items-start gap-2 rounded border border-warn bg-warn-subtle px-3 py-2 text-2xs text-warn">
                    <span aria-hidden="true" className="font-bold">⚠</span>
                    <div>
                      <span className="font-bold">这份清单可能过期</span>：{staleText}
                    </div>
                    {mode === 'live' && onSync && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={onSync}
                        className="ml-auto shrink-0 rounded border border-warn px-2 py-1 text-2xs text-warn disabled:opacity-50"
                      >让 agent 同步清单</button>
                    )}
                  </div>
                )}

                {mode === 'snapshot' && (
                  <div className="rounded border border-accent bg-accent-subtle px-3 py-2 text-2xs text-accent">
                    <span className="font-bold">会话已结束</span>：这里是结束时的清单快照，只读。
                    {partial ? '（会话文件很大，只扫描了尾部，更早的历史没有读取）' : ''}
                  </div>
                )}

                <Section title="目标">
                  <p className="whitespace-pre-wrap break-words text-body-s text-text">{goal.objective}</p>
                  <p className="mt-1 text-2xs text-muted">原文保留，不做摘要、不改写。</p>
                </Section>

                {progress && progress.total > 0 && (
                  <Section title={`工作项（${progress.done}/${progress.total} 完成）`}>
                    <ul className="space-y-1.5">
                      {goal.workItems.map(item => {
                        const state = item.state ?? 'todo'
                        return (
                          <li key={item.id} className="flex items-start gap-2 rounded border border-border bg-card px-2.5 py-2">
                            <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-2xs font-bold ${WORK_ITEM_CLASS[state]}`} aria-hidden="true">{WORK_ITEM_GLYPH[state]}</span>
                            <div className="min-w-0 flex-1">
                              <div className={`text-meta ${state === 'done' ? 'text-muted line-through' : 'text-text'}`}>{item.title}</div>
                              {item.dependsOn.length > 0 && (
                                <div className="mt-0.5 text-2xs text-muted">{`依赖：${item.dependsOn.join('、')}`}</div>
                              )}
                            </div>
                            <span className={`shrink-0 rounded px-2 py-0.5 text-2xs leading-none ${WORK_ITEM_CLASS[state]}`}>{WORK_ITEM_LABEL[state]}</span>
                          </li>
                        )
                      })}
                    </ul>
                  </Section>
                )}

                {(goal.progress.current || goal.progress.lastSummary) && (
                  <Section title="当前在哪一步">
                    <p className="whitespace-pre-wrap break-words text-body-s text-text">{goal.progress.current || '—'}</p>
                    {goal.progress.lastSummary && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-2xs text-muted">{`上一轮小结：${goal.progress.lastSummary}`}</p>
                    )}
                  </Section>
                )}

                <Section title={progress && progress.needsUser > 0 ? `阻塞项（${progress.needsUser} 项需要你处理）` : '阻塞项'}>
                  {blockers.length === 0
                    ? <p className="text-2xs text-muted">暂无未解决阻塞项。</p>
                    : <ul className="space-y-2">
                      {blockers.map((blocker, index) => (
                        <li
                          key={`${blocker.title}-${index}`}
                          className={`rounded border bg-bg-hover/50 px-3 py-2 ${needsUser(blocker) ? 'border-warn border-l-4' : 'border-border'}`}
                        >
                          <div className="text-meta font-medium">{blocker.title}</div>
                          {blocker.reason && <p className="mt-1 whitespace-pre-wrap break-words text-2xs text-muted">{blocker.reason}</p>}
                          {blocker.proposedResolution && (
                            <p className="mt-1 whitespace-pre-wrap break-words text-2xs text-text">
                              <span className="text-muted">建议处理：</span>{blocker.proposedResolution}
                            </p>
                          )}
                          {blockerMeta(blocker) && <p className="mt-1 text-2xs text-muted">{blockerMeta(blocker)}</p>}
                        </li>
                      ))}
                    </ul>}
                </Section>

                <details className="rounded border border-border px-3 py-2">
                  <summary className="cursor-pointer text-2xs font-medium">更多详情（验收标准 / 约束 / 来源文档）</summary>
                  <div className="mt-3 space-y-4">
                    <Section title="验收标准">
                      {goal.acceptanceCriteria.length === 0
                        ? <p className="text-2xs text-muted">暂无验收标准</p>
                        : <ol className="list-decimal space-y-1 pl-5 text-2xs text-muted-strong">
                          {goal.acceptanceCriteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}
                        </ol>}
                      <p className="mt-1 text-2xs text-muted">验收标准没有单条勾选状态，这里只读展示，不伪造完成度。</p>
                    </Section>
                    <Section title="约束">
                      {goal.constraints.length === 0
                        ? <p className="text-2xs text-muted">暂无约束</p>
                        : <ul className="list-disc space-y-1 pl-5 text-2xs text-muted-strong">
                          {goal.constraints.map((constraint, index) => <li key={`${index}-${constraint}`}>{constraint}</li>)}
                        </ul>}
                    </Section>
                    <Section title="来源文档">
                      {goal.sourceDocs.length === 0
                        ? <p className="text-2xs text-muted">暂无来源文档</p>
                        : <ul className="space-y-1.5">
                          {goal.sourceDocs.map((source: GoalSourceDoc, index: number) => (
                            <li key={`${source.path ?? source.brief}-${index}`} className="rounded bg-bg-hover/50 px-2 py-1.5">
                              <div className="flex flex-wrap items-baseline gap-2">
                                {source.kind && <span className="rounded border border-border px-1.5 text-2xs text-muted">{SOURCE_KIND_LABEL[source.kind] ?? source.kind}</span>}
                                {source.path && <span className="break-all font-mono text-2xs text-muted-strong">{source.path}</span>}
                              </div>
                              {source.brief && <div className="mt-0.5 text-2xs">{source.brief}</div>}
                            </li>
                          ))}
                        </ul>}
                    </Section>
                  </div>
                </details>
              </>}
        </div>

        {goal && (
          <footer className="flex items-center gap-3 border-t border-border bg-bg-elevated px-4 py-2 text-2xs text-muted">
            <span className="min-w-0 truncate">{`更新于 ${updatedLabel(goal)}`}</span>
            <span className="ml-auto flex shrink-0 gap-2">
              {mode === 'live'
                ? onSync && <button type="button" disabled={busy} onClick={onSync} className="rounded border border-border bg-card px-2.5 py-1 text-2xs text-text hover:border-accent hover:text-accent disabled:opacity-50">让 agent 同步清单</button>
                : onResume && <button type="button" onClick={onResume} className="rounded border border-border bg-card px-2.5 py-1 text-2xs text-text hover:border-accent hover:text-accent">在新会话里继续</button>}
            </span>
          </footer>
        )}
      </section>
    </div>
  )
}