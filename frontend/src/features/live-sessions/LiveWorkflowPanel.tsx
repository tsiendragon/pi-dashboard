import type { LiveSessionSummary } from '@shared/live-sessions'
import MarkdownRenderer from '../../components/MarkdownRenderer'
import type { WorkflowRecord } from './LiveWorkflowProgressCard'

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
  if (status === 'cancelled' || status === 'interrupted') return '已取消'
  return status || '等待执行'
}

function statusIcon(status: string): string {
  if (status === 'running' || status === 'in_progress' || status === 'active') return '⏺'
  if (status === 'completed' || status === 'succeeded' || status === 'done') return '✓'
  if (status === 'failed' || status === 'error') return '!'
  if (status === 'cancelled' || status === 'interrupted') return '⊘'
  return '○'
}

function statusClass(status: string): string {
  if (status === 'running' || status === 'in_progress' || status === 'active') return 'text-accent'
  if (status === 'completed' || status === 'succeeded' || status === 'done') return 'text-ok'
  if (status === 'failed' || status === 'error') return 'text-danger'
  return 'text-muted'
}

export default function LiveWorkflowPanel({ workflow, sessions, onClose, onOpenSubagent }: LiveWorkflowPanelProps) {
  const stages = records(workflow.stages)
  const tasks = stages.flatMap(stage => records(stage.tasks))
  const linkedSessionIds = new Set(tasks.map(task => text(task.sessionId)).filter(Boolean))
  const workflowId = text(workflow.id)
  const workflowWorkId = workflowId.startsWith('workflow_') ? workflowId.slice('workflow_'.length) : workflowId
  const linkedSessions = sessions.filter(session => linkedSessionIds.has(session.sessionId) || (!!workflowWorkId && session.subagentWorkId === workflowWorkId))
  const doneTasks = tasks.filter(task => ['completed', 'succeeded', 'done'].includes(text(task.status))).length
  const workflowStatus = text(workflow.status)
  const error = text(workflow.error)
  return <aside className="fixed inset-y-0 right-0 z-40 flex w-[min(680px,94vw)] flex-col border-l border-accent/30 bg-bg shadow-2xl shadow-black/40">
    <header className="shrink-0 border-b border-border bg-card px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className={`text-sm ${statusClass(workflowStatus)}`}>{statusIcon(workflowStatus)}</span><span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">Workflow</span><h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-strong">{text(workflow.label, text(workflow.id, '未命名 Workflow'))}</h2><span className={`text-[10px] ${statusClass(workflowStatus)}`}>{statusLabel(workflowStatus)}</span></div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[9px] text-muted"><span>{text(workflow.id)}</span><span>{doneTasks} / {tasks.length || stages.length} 完成</span>{typeof workflow.updatedAt === 'number' && <span>{new Date(workflow.updatedAt).toLocaleString()}</span>}</div>
        </div>
        <button type="button" onClick={onClose} className="rounded border border-border bg-bg px-2 py-1 text-sm leading-none text-muted hover:border-accent hover:text-accent" title="返回主 Agent">×</button>
      </div>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3">
      <section className="rounded-lg border border-border bg-card p-3">
        <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-text-strong"><span>阶段进度</span><span className="text-muted">{stages.length} 个阶段 · {tasks.length} 个任务</span></div>
        <div className="space-y-2">
          {stages.length === 0 && <div className="text-xs text-muted">Workflow 尚未上报阶段信息。</div>}
          {stages.map((stage, index) => {
            const stageTasks = records(stage.tasks)
            const stageDone = stageTasks.filter(task => ['completed', 'succeeded', 'done'].includes(text(task.status))).length
            const status = text(stage.status)
            return <details key={String(stage.id || index)} open={['running', 'in_progress', 'active', 'failed', 'error'].includes(status)} className="rounded border border-border/70 bg-bg/40">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-2 text-xs"><span className={statusClass(status)}>{statusIcon(status)}</span><span className="min-w-0 flex-1 truncate text-text-strong">{text(stage.label, text(stage.id, `阶段 ${index + 1}`))}</span><span className={`text-[10px] ${statusClass(status)}`}>{statusLabel(status)}</span>{stageTasks.length > 0 && <span className="text-[10px] text-muted">{stageDone}/{stageTasks.length}</span>}</summary>
              <div className="border-t border-border/60 px-2 py-1.5 space-y-1">
                {stageTasks.map((task, taskIndex) => {
                  const taskStatus = text(task.status)
                  const linked = sessions.find(session => session.sessionId === text(task.sessionId))
                  return <div key={String(task.id || task.key || taskIndex)} className="flex items-start gap-2 rounded px-1 py-1 text-[11px] hover:bg-bg-hover"><span className={`mt-0.5 ${statusClass(taskStatus)}`}>{statusIcon(taskStatus)}</span><div className="min-w-0 flex-1"><div className="truncate text-text">{text(task.label, text(task.key, '任务'))}</div>{text(task.error) && <div className="mt-0.5 whitespace-pre-wrap text-[10px] text-danger">{text(task.error)}</div>}</div>{linked && <button type="button" onClick={() => onOpenSubagent(linked.processInstanceId)} className="shrink-0 rounded border border-accent/30 px-1.5 py-0.5 text-[9px] text-accent hover:bg-accent-subtle">打开 Agent</button>}</div>
                })}
              </div>
            </details>
          })}
        </div>
      </section>
      {linkedSessions.length > 0 && <section className="rounded-lg border border-border bg-card p-3"><div className="mb-2 text-[11px] font-medium text-text-strong">关联子 Agent · {linkedSessions.length}</div><div className="space-y-1.5">{linkedSessions.map(session => <button key={session.processInstanceId} type="button" onClick={() => onOpenSubagent(session.processInstanceId)} className="flex w-full items-center gap-2 rounded border border-border/70 bg-bg/40 px-2 py-1.5 text-left hover:border-accent"><span className={`h-1.5 w-1.5 rounded-full ${session.status === 'running' ? 'bg-accent animate-pulse' : 'bg-muted'}`} /><span className="min-w-0 flex-1 truncate text-[11px] text-text-strong">{session.sessionName || `PID ${session.pid}`}</span><span className="text-[10px] text-muted">{session.status}</span></button>)}</div></section>}
      {error && <section className="rounded-lg border border-danger/30 bg-danger-subtle p-3"><div className="mb-1 text-[11px] font-medium text-danger">失败原因</div><MarkdownRenderer content={error} /></section>}
    </div>
    <footer className="shrink-0 border-t border-border bg-card px-4 py-2 text-[10px] text-muted">Workflow 详情来自当前 session 的 feature snapshot · 子 Agent 详情使用 Live Session 事件流</footer>
  </aside>
}
