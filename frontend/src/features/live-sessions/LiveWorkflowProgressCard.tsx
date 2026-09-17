import type { LiveSessionSummary } from '@shared/live-sessions'

export type WorkflowRecord = Record<string, unknown>

interface LiveWorkflowProgressCardProps {
  workflow: WorkflowRecord
  sessions: LiveSessionSummary[]
  onOpen: (workflow: WorkflowRecord) => void
}

function records(value: unknown): WorkflowRecord[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as WorkflowRecord[] : []
}

function stringValue(value: unknown, fallback = ''): string {
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

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value
}

export default function LiveWorkflowProgressCard({ workflow, sessions, onOpen }: LiveWorkflowProgressCardProps) {
  const stages = records(workflow.stages)
  const tasks = stages.flatMap(stage => records(stage.tasks))
  const doneTasks = tasks.filter(task => ['completed', 'succeeded', 'done'].includes(stringValue(task.status))).length
  const totalTasks = tasks.length
  const workflowStatus = stringValue(workflow.status)
  const currentStageIndex = typeof workflow.currentStage === 'number' ? workflow.currentStage : stages.findIndex(stage => ['running', 'in_progress', 'active'].includes(stringValue(stage.status)))
  const currentStage = currentStageIndex >= 0 ? stages[currentStageIndex] : undefined
  const linkedSessionIds = new Set(tasks.map(task => stringValue(task.sessionId)).filter(Boolean))
  const workflowId = stringValue(workflow.id)
  const workflowWorkId = workflowId.startsWith('workflow_') ? workflowId.slice('workflow_'.length) : workflowId
  const linkedSessions = sessions.filter(session => linkedSessionIds.has(session.sessionId) || (!!workflowWorkId && session.subagentWorkId === workflowWorkId))
  const progress = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : stages.length > 0 ? Math.round(stages.filter(stage => ['completed', 'succeeded', 'done'].includes(stringValue(stage.status))).length / stages.length * 100) : 0
  const terminal = ['completed', 'succeeded', 'done', 'failed', 'error', 'cancelled', 'interrupted'].includes(workflowStatus)

  return <button type="button" onClick={() => onOpen(workflow)} className="w-full rounded-lg border border-border bg-card/70 p-3 text-left shadow-sm transition-colors hover:border-accent/60 hover:bg-accent-subtle/30">
    <div className="flex items-start gap-2">
      <span className={`mt-0.5 text-sm ${statusClass(workflowStatus)} ${workflowStatus === 'running' || workflowStatus === 'in_progress' ? 'animate-pulse' : ''}`}>{statusIcon(workflowStatus)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <strong className="min-w-0 flex-1 truncate text-xs text-text-strong">Workflow · {stringValue(workflow.label, stringValue(workflow.id, '未命名'))}</strong>
          <span className={`shrink-0 text-2xs ${statusClass(workflowStatus)}`}>{statusLabel(workflowStatus)}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted">
          <span>{totalTasks > 0 ? `${doneTasks} / ${totalTasks} 个任务` : `${stages.length} 个阶段`}</span>
          {currentStage && <span>当前：{stringValue(currentStage.label, stringValue(currentStage.id, '阶段'))}</span>}
          {linkedSessions.length > 0 && <span>{linkedSessions.length} 个子 Agent</span>}
          {workflow.id !== undefined && <span className="font-mono">{shortId(String(workflow.id))}</span>}
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg">
          <div className={`h-full rounded-full ${workflowStatus === 'failed' || workflowStatus === 'error' ? 'bg-danger' : workflowStatus === 'cancelled' || workflowStatus === 'interrupted' ? 'bg-muted' : 'bg-accent'}`} style={{ width: `${progress}%` }} />
        </div>
        {!terminal && stages.length > 0 && <div className="mt-2 space-y-1">
          {stages.slice(0, 4).map(stage => {
            const status = stringValue(stage.status)
            return <div key={String(stage.id || stage.label)} className="flex items-center gap-1.5 text-2xs text-muted"><span className={statusClass(status)}>{statusIcon(status)}</span><span className="truncate">{stringValue(stage.label, String(stage.id || '阶段'))}</span></div>
          })}
          {stages.length > 4 && <div className="text-2xs text-muted/70">还有 {stages.length - 4} 个阶段 · 点击查看详情</div>}
        </div>}
      </div>
      <span className="shrink-0 text-xs text-muted">›</span>
    </div>
  </button>
}
