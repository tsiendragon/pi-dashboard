import { useState } from 'react'
import type { LiveSessionSummary } from '@shared/live-sessions'
import MarkdownRenderer from '../../components/MarkdownRenderer'
import type { WorkflowRecord } from './LiveWorkflowProgressCard'
import { asProjectionRecord, isCollapsedByDefault, projectStatus, projectTaskCounts, stableTaskId, workflowTaskList } from './subagentProjection'
import { linkedWorkflowSessions, workflowTaskSession } from './workflowSessions'

interface LiveWorkflowPanelProps {
  workflow: WorkflowRecord
  sessions: LiveSessionSummary[]
  onClose: () => void
  onOpenSubagent: (processInstanceId: string) => void
}

function records(value: unknown): WorkflowRecord[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as WorkflowRecord[] : []
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function statusLabel(status: string): string {
  if (status === 'running' || status === 'in_progress' || status === 'active') return '工作中'
  if (status === 'completed' || status === 'succeeded' || status === 'done') return '已完成'
  if (status === 'failed' || status === 'error') return '失败'
  if (status === 'cancelled' || status === 'interrupted' || status === 'stopped') return '已停止'
  if (status === 'skipped') return '已跳过'
  if (status === 'paused') return '已暂停'
  if (status === 'blocked' || status === 'waiting_approval') return '需要处理'
  if (status === 'queued' || status === 'pending') return '等待执行'
  return '状态待确认'
}

function statusIcon(status: string): string {
  const projected = projectStatus(status)
  if (projected === 'active') return '⏺'
  if (projected === 'completed') return '✓'
  if (projected === 'attention') return '!'
  if (projected === 'stopped') return '⊘'
  return '○'
}

function statusClass(status: string): string {
  const projected = projectStatus(status)
  if (projected === 'active') return 'text-accent'
  if (projected === 'completed') return 'text-ok'
  if (projected === 'attention') return 'text-danger'
  return 'text-muted'
}

export default function LiveWorkflowPanel({ workflow, sessions, onClose, onOpenSubagent }: LiveWorkflowPanelProps) {
  const [selectedTask, setSelectedTask] = useState<string>()
  const stages = records(workflow.stages)
  const tasks = workflowTaskList(workflow)
  const counts = projectTaskCounts(tasks)
  const linkedSessions = linkedWorkflowSessions(workflow, sessions)
  const doneTasks = counts.completed
  const workflowStatus = text(workflow.status)
  const error = text(workflow.error)
  return <aside className="fixed inset-y-0 right-0 z-40 flex w-[min(680px,94vw)] flex-col border-l border-accent bg-bg shadow-2xl shadow-black/40">
    <header className="shrink-0 border-b border-border bg-card px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className={`text-sm ${statusClass(workflowStatus)}`}>{statusIcon(workflowStatus)}</span><span className="rounded bg-accent-subtle px-1.5 py-0.5 text-2xs text-accent">工作流</span><h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-strong">{text(workflow.label, text(workflow.id, '未命名工作流'))}</h2><span className={`text-2xs ${statusClass(workflowStatus)}`}>{statusLabel(workflowStatus)}</span></div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-2xs text-muted"><span>{text(workflow.id)}</span><span>{tasks.length > 0 ? `完成 ${doneTasks} / ${tasks.length}` : '尚无任务信息'}</span>{counts.failed > 0 && <span className="text-danger">失败 {counts.failed}</span>}{counts.attention > 0 && <span className="text-warn">待处理 {counts.attention}</span>}{counts.skipped > 0 && <span>跳过 {counts.skipped}</span>}{typeof workflow.updatedAt === 'number' && <span>{new Date(workflow.updatedAt).toLocaleString()}</span>}</div>
        </div>
        <button type="button" onClick={onClose} className="rounded border border-border bg-bg px-2 py-1 text-sm leading-none text-muted hover:border-accent hover:text-accent" title="返回主 Agent">×</button>
      </div>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3">
      <section className="rounded-lg border border-border bg-card p-3">
        <div className="mb-2 flex items-center justify-between text-2xs font-medium text-text-strong"><span>阶段进度</span><span className="text-muted">{stages.length} 个阶段 · {tasks.length} 个任务</span></div>
        <div className="space-y-2">
          {stages.length === 0 && <div className="text-xs text-muted">工作流尚未提供阶段信息。</div>}
          {stages.map((stage, index) => {
            const stageTasks = records(stage.tasks)
            const stageDone = stageTasks.filter(task => ['completed', 'succeeded', 'done'].includes(text(task.status))).length
            const status = text(stage.status)
            const stageCounts = projectTaskCounts(stageTasks)
            return <details key={String(stage.id || index)} open={!isCollapsedByDefault(status) || stageCounts.failed > 0} className="rounded border border-border bg-bg">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-2 text-xs"><span className={statusClass(status)}>{statusIcon(status)}</span><span className="min-w-0 flex-1 truncate text-text-strong">{text(stage.label, text(stage.id, `阶段 ${index + 1}`))}</span><span className={`text-2xs ${statusClass(status)}`}>{statusLabel(status)}</span>{stageTasks.length > 0 && <span className="text-2xs text-muted">{stageDone}/{stageTasks.length}</span>}</summary>
              <div className="border-t border-border px-2 py-1.5 space-y-1">
                {stageTasks.map((task, taskIndex) => {
                  const taskStatus = text(task.status)
                  const linked = workflowTaskSession(task, sessions)
                  const taskKey = `${String(stage.id || index)}:${stableTaskId(task, taskIndex)}`
                  const result = asProjectionRecord(task.result)
                  const output = typeof task.output === 'string' ? task.output : typeof task.resultPreview === 'string' ? task.resultPreview : typeof result.output === 'string' ? result.output : undefined
                  const projected = projectStatus(taskStatus)
                  return <div key={stableTaskId(task, taskIndex)} className={`rounded px-1 py-1 text-2xs ${projected === 'attention' ? 'border border-danger bg-danger-subtle' : ''}`}>
                    <div className="flex items-start gap-2">
                      <span className={statusClass(taskStatus)}>{statusIcon(taskStatus)}</span>
                      <button type="button" className="min-w-0 flex-1 break-words text-left text-text hover:text-accent" onClick={() => setSelectedTask(taskKey)}>{text(task.label, text(task.key, '任务'))}</button>
                      {linked && <button type="button" onClick={() => onOpenSubagent(linked.processInstanceId)} className="shrink-0 rounded border border-accent px-1.5 py-0.5 text-2xs text-accent hover:bg-accent-subtle">实时详情</button>}
                    </div>
                    {text(task.error) && <div className="mt-0.5 whitespace-pre-wrap text-danger">{text(task.error)}</div>}
                    {selectedTask === taskKey && <div aria-label="任务结果" className="mt-2 rounded border border-border bg-card p-2">
                      <div className="mb-1 text-muted">任务记录 · {statusLabel(taskStatus)}{!linked && ' · 当前无实时连接'}</div>
                      {typeof task.model === 'string' && <div className="mb-1 break-all text-muted">模型：{task.model}</div>}
                      {output !== undefined ? <MarkdownRenderer content={output || '任务未返回正文。'} /> : <p className="text-muted">此快照未提供结果正文；可查看任务错误或已保存产物，不会把连接断开当成成功。</p>}
                      {task.resultTruncated === true && <p className="text-warn">这里只展示摘要，完整结果仍保留。</p>}
                    </div>}
                  </div>
                })}
              </div>
            </details>
          })}
        </div>
      </section>
      {linkedSessions.length > 0 && <section className="rounded-lg border border-border bg-card p-3"><div className="mb-2 text-2xs font-medium text-text-strong">关联子助手 · {linkedSessions.length}</div><div className="space-y-1.5">{linkedSessions.map(session => <button key={session.processInstanceId} type="button" onClick={() => onOpenSubagent(session.processInstanceId)} className="flex w-full items-center gap-2 rounded border border-border bg-bg px-2 py-1.5 text-left hover:border-accent"><span className={`h-1.5 w-1.5 rounded-full ${session.status === 'running' ? 'bg-accent animate-pulse' : 'bg-muted'}`} /><span className="min-w-0 flex-1 truncate text-2xs text-text-strong">{session.sessionName || `PID ${session.pid}`}</span><span className="text-2xs text-muted">{session.status}</span></button>)}</div></section>}
      {error && <section className="rounded-lg border border-danger bg-danger-subtle p-3"><div className="mb-1 text-2xs font-medium text-danger">失败原因</div><MarkdownRenderer content={error} /></section>}
    </div>
    <footer className="shrink-0 border-t border-border bg-card px-4 py-2 text-2xs text-muted">工作流详情来自当前会话快照；实时详情来自已连接子助手的记录</footer>
  </aside>
}
