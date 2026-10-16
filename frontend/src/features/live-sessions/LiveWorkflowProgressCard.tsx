import type { LiveSessionSummary } from '@shared/live-sessions'
import { projectStatus, projectTaskCounts, workflowTaskList } from './subagentProjection'
import { linkedWorkflowSessions } from './workflowSessions'

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
  return ({ active: '工作中', attention: '需处理', completed: '已完成', stopped: '已停止', unknown: '未知' })[projectStatus(status)]
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

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value
}

export default function LiveWorkflowProgressCard({ workflow, sessions, onOpen }: LiveWorkflowProgressCardProps) {
  const stages = records(workflow.stages)
  const tasks = workflowTaskList(workflow)
  const counts = projectTaskCounts(tasks)
  const doneTasks = counts.completed
  const totalTasks = counts.total
  const workflowStatus = stringValue(workflow.status)
  const currentStageIndex = typeof workflow.currentStage === 'number' ? workflow.currentStage : stages.findIndex(stage => ['running', 'in_progress', 'active'].includes(stringValue(stage.status)))
  const currentStage = currentStageIndex >= 0 ? stages[currentStageIndex] : undefined
  const linkedSessions = linkedWorkflowSessions(workflow, sessions)
  const progress = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0
  const terminal = ['completed', 'succeeded', 'done', 'failed', 'error', 'cancelled', 'interrupted'].includes(workflowStatus)

  return <button type="button" onClick={() => onOpen(workflow)} className="w-full rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-colors hover:border-accent hover:bg-accent-subtle">
    <div className="flex items-start gap-2">
      <span className={`mt-0.5 text-sm ${statusClass(workflowStatus)} ${workflowStatus === 'running' || workflowStatus === 'in_progress' ? 'animate-pulse' : ''}`}>{statusIcon(workflowStatus)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <strong className="min-w-0 flex-1 truncate text-xs text-text-strong">工作流 · {stringValue(workflow.label, stringValue(workflow.id, '未命名'))}</strong>
          <span className={`shrink-0 text-2xs ${statusClass(workflowStatus)}`}>{statusLabel(workflowStatus)}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted">
          <span>{totalTasks > 0 ? `完成 ${doneTasks} / ${totalTasks} 个任务` : '尚无任务信息'}</span>
          {counts.failed > 0 && <span className="text-danger">失败 {counts.failed}</span>}
          {counts.attention > 0 && <span className="text-warn">待处理 {counts.attention}</span>}
          {counts.skipped > 0 && <span>跳过 {counts.skipped}</span>}
          {currentStage && <span>当前：{stringValue(currentStage.label, stringValue(currentStage.id, '阶段'))}</span>}
          {linkedSessions.length > 0 && <span>{linkedSessions.length} 个子助手</span>}
          {workflow.id !== undefined && <span className="font-mono">{shortId(String(workflow.id))}</span>}
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg">
          <div className={`h-full rounded-full ${workflowStatus === 'failed' || workflowStatus === 'error' ? 'bg-danger' : workflowStatus === 'cancelled' || workflowStatus === 'interrupted' ? 'bg-muted' : 'bg-accent'}`} style={{ width: `${progress}%` }} />
        </div>
        {!terminal && stages.length > 0 && <div className="mt-2 space-y-1">
          {stages.slice(0, 4).map((stage, index) => {
            const status = stringValue(stage.status)
            const stageCounts = projectTaskCounts(records(stage.tasks))
            return <div key={String(stage.id || stage.label || index)} className="rounded border border-border px-2 py-1"><div className="flex items-center gap-1.5 text-2xs text-muted"><span className={statusClass(status)}>{statusIcon(status)}</span><span className="min-w-0 flex-1 truncate">{stringValue(stage.label, String(stage.id || '阶段'))}</span>{stageCounts.total > 0 && <span>{stageCounts.completed}/{stageCounts.total}</span>}</div>{stageCounts.failed > 0 && <div className="mt-1 text-danger">失败 {stageCounts.failed} 个</div>}</div>
          })}
          {stages.length > 4 && <div className="text-2xs text-muted opacity-70">还有 {stages.length - 4} 个阶段 · 点击查看详情</div>}
        </div>}
      </div>
      <span className="shrink-0 text-xs text-muted">›</span>
    </div>
  </button>
}
