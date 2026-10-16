import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppSelector } from '../../store'
import ToolCallBlock from '../../pages/chat/ToolCallBlock'
import ThinkingBlock from '../../pages/chat/ThinkingBlock'
import { useIntegration } from '../useIntegration'
import { asProjectionRecord, isWorkflowChild, projectStatus, projectTaskCounts, recordTaskStatus, stableTaskId } from '../live-sessions/subagentProjection'

type ToolEntry = {
  id: string; type: 'tool'; toolCallId: string; name: string; args: unknown
  output?: { content?: Array<{ type?: string; text?: string }> }
  status: 'running' | 'completed' | 'failed'; createdAt: number
}
type TimelineEntry =
  | { id: string; type: 'user'; text: string; createdAt: number }
  | { id: string; type: 'assistant'; content: Array<{ type: string; text?: string; thinking?: string }>; streaming?: boolean; errorMessage?: string; createdAt: number }
  | ToolEntry

type Conversation = {
  id: string; label: string; status: string; updatedAt: number; availability?: string
  timeline?: TimelineEntry[]; provider?: string; model?: string; error?: string; workflowId?: string
  latestRunStatus?: string; activeRunId?: string; needsAttention?: boolean; stalled?: boolean
  thinkingLevel?: string; resultPreview?: string; resultTruncated?: boolean
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number }
}
type WorkflowTask = { id: string; key?: string; label: string; status: string; sessionId?: string; error?: string; output?: string; resultPreview?: string; resultTruncated?: boolean }
type Workflow = { id: string; label: string; status: string; stages?: Array<{ id: string; label: string; status: string; tasks: WorkflowTask[] }>; error?: string }
type Snapshot = {
  revision: number
  governor?: { active: number; queued: number; activeLimit: number; queueLimit: number }
  runHealth?: { running: number; stalled: number }
  conversations: { items: Conversation[] }
  workflows: { items: Workflow[] }
  lastCommandError?: string
}

function outputText(entry: ToolEntry): string | undefined {
  return entry.output?.content?.filter(item => item.type === 'text').map(item => item.text || '').join('\n')
}

function Timeline({ conversation }: { conversation: Conversation }) {
  if (!conversation.timeline?.length) return <div className="whitespace-pre-wrap break-words p-4 text-sm text-muted">{conversation.resultPreview ?? '此快照未提供结果正文。'}</div>
  return <div className="space-y-3 p-4">
    {conversation.timeline.map(entry => {
      if (entry.type === 'user') return <div key={entry.id} className="ml-auto max-w-[85%] rounded-lg bg-accent-subtle border border-accent px-3 py-2 whitespace-pre-wrap text-sm">{entry.text}</div>
      if (entry.type === 'tool') return <ToolCallBlock key={entry.id} content={`🔧 ${entry.name}`} meta={{ toolName: entry.name, toolCallId: entry.toolCallId, args: JSON.stringify(entry.args ?? {}, null, 2), result: outputText(entry), isError: entry.status === 'failed' }} />
      return <div key={entry.id} className="rounded-lg border border-border bg-card px-3 py-2 space-y-2">
        {entry.content.map((block, index) => block.type === 'thinking' ? <ThinkingBlock key={index} content={block.thinking || ''} /> : block.type === 'text' && block.text ? <div key={index} className="whitespace-pre-wrap text-sm text-text">{block.text}</div> : null)}
        {entry.streaming && <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />}
        {entry.errorMessage && <div className="text-danger text-sm">{entry.errorMessage}</div>}
      </div>
    })}
  </div>
}

function statusLabel(status: string): string {
  return ({ active: '运行中', attention: '需要处理', completed: '已完成', stopped: '已停止', unknown: '状态待确认' })[projectStatus(status)]
}

export default function WorkbenchPanel({ slot, onClose }: { slot: string; onClose: () => void }) {
  const currentSlot = useAppSelector(s => s.dashboard.slots.find(item => item.key === slot))
  const { attached, snapshot, pending, error, send } = useIntegration<Snapshot>(slot, 'subagent-workbench')
  const [view, setView] = useState<'agents' | 'workflows'>('agents')
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null)
  const [selectedWorkflowTask, setSelectedWorkflowTask] = useState<string>()
  const [task, setTask] = useState('')
  const [label, setLabel] = useState('')
  const [executionModel, setExecutionModel] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [workflowText, setWorkflowText] = useState('')
  const [inputError, setInputError] = useState<string>()
  const allConversations = useMemo(() => snapshot?.conversations.items ?? [], [snapshot])
  const workflows = useMemo(() => snapshot?.workflows.items ?? [], [snapshot])
  const groups = useMemo(() => {
    const result: Record<'active' | 'attention' | 'completed' | 'stopped', Conversation[]> = { active: [], attention: [], completed: [], stopped: [] }
    for (const item of allConversations.filter(item => !isWorkflowChild(item))) {
      const status = projectStatus(recordTaskStatus(item))
      result[status === 'unknown' ? 'attention' : status].push(item)
    }
    return result
  }, [allConversations])
  const liveConversation = allConversations.find(item => item.id === selectedAgent)
  const liveWorkflow = workflows.find(item => item.id === selectedWorkflow)
  const retainedConversation = useRef<Conversation>()
  const retainedWorkflow = useRef<Workflow>()
  const conversation = liveConversation || (retainedConversation.current?.id === selectedAgent ? retainedConversation.current : undefined)
  const workflow = liveWorkflow || (retainedWorkflow.current?.id === selectedWorkflow ? retainedWorkflow.current : undefined)
  useEffect(() => {
    if (liveConversation) retainedConversation.current = liveConversation
    if (liveWorkflow) retainedWorkflow.current = liveWorkflow
  }, [liveConversation, liveWorkflow])
  const unavailable = !attached || !liveConversation || ['closed', 'unavailable'].includes(conversation?.availability || '')
  const cwd = currentSlot?.cwd || '/tmp'
  const workflowStages = useMemo(() => workflowText.split(/\n\s*\n/).map((stage, index) => ({
    label: `阶段 ${index + 1}`, tasks: stage.split('\n').map(line => line.trim()).filter(Boolean).map(line => ({ task: line, cwd })),
  })).filter(stage => stage.tasks.length > 0), [workflowText, cwd])

  const submit = async (command: object) => {
    setInputError(undefined)
    const model = executionModel.trim()
    if (model && !/^[^/\s]+\/\S+$/.test(model)) { setInputError('请填写完整的 provider/model，或留空使用执行默认。'); return }
    try {
      const response = asProjectionRecord(await send(command))
      const id = typeof response.sessionId === 'string' ? response.sessionId : typeof response.id === 'string' ? response.id : undefined
      if (id) { setSelectedAgent(id); setView('agents') }
      if (typeof response.workflowId === 'string') { setSelectedWorkflow(response.workflowId); setSelectedWorkflowTask(undefined); setView('workflows') }
      setTask(''); setLabel('')
    } catch (cause) { setInputError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const modelOverride = executionModel.trim() ? { model: executionModel.trim() } : {}

  return <div className="absolute inset-0 z-30 flex flex-col bg-bg">
    <header className="flex flex-wrap items-center gap-2 border-b border-border bg-bg-accent px-3 py-2">
      <h2 className="text-sm font-semibold">子助手工作台</h2><span className="text-xs text-muted">{attached ? '已连接' : '尚未连接'}</span>
      {snapshot?.governor && <span className="text-xs text-muted">执行 {snapshot.governor.active}/{snapshot.governor.activeLimit} · 排队 {snapshot.governor.queued}</span>}
      {snapshot?.runHealth && <span className="text-xs text-muted">待处理 {snapshot.runHealth.stalled}</span>}
      <button type="button" className="ml-auto rounded border border-border px-2 py-1 text-xs" onClick={() => { void send({ type: 'refresh' }).catch(cause => setInputError(String(cause))) }}>刷新</button>
      <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={onClose}>关闭</button>
    </header>
    {!attached && !conversation && !workflow ? <div className="m-auto p-4 text-sm text-muted">工作台未连接。当前会话需加载子助手扩展；完成记录不会因此被当成成功。</div> : <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="max-h-[35vh] shrink-0 overflow-auto border-b border-border md:max-h-none md:w-72 md:border-b-0 md:border-r">
        <div className="flex border-b border-border"><button type="button" className={`flex-1 p-2 text-sm ${view === 'agents' ? 'text-accent' : 'text-muted'}`} onClick={() => setView('agents')}>普通子助手</button><button type="button" className={`flex-1 p-2 text-sm ${view === 'workflows' ? 'text-accent' : 'text-muted'}`} onClick={() => setView('workflows')}>工作流 · {workflows.length}</button></div>
        {view === 'agents' ? <div className="space-y-2 p-2">{(['active', 'attention', 'completed', 'stopped'] as const).map(key => {
          const entries = groups[key]
          if (!entries.length) return null
          const title = key === 'active' ? '运行中' : key === 'attention' ? '需要处理或确认' : key === 'completed' ? '已完成' : '已停止'
          const rows = entries.map(item => <button key={item.id} type="button" className={`w-full rounded px-2 py-2 text-left ${selectedAgent === item.id ? 'bg-accent-subtle text-accent' : 'hover:bg-bg-hover'}`} onClick={() => setSelectedAgent(item.id)}><div className="truncate text-sm">{item.label}</div><div className={`text-xs ${key === 'attention' ? 'text-warn' : 'text-muted'}`}>{statusLabel(recordTaskStatus(item))}{item.error && ' · 有错误'}</div></button>)
          return key === 'completed' || key === 'stopped' ? <details key={key}><summary className="cursor-pointer px-2 py-1 text-xs text-muted">{title} · {entries.length}</summary>{rows}</details> : <section key={key}><div className="px-2 py-1 text-xs text-muted">{title} · {entries.length}</div>{rows}</section>
        })}{Object.values(groups).every(items => !items.length) && <p className="p-2 text-xs text-muted">暂无普通子助手；工作流任务请到工作流查看。</p>}</div> : <div className="space-y-1 p-2">{workflows.map(item => <button key={item.id} type="button" className={`w-full rounded px-2 py-2 text-left ${selectedWorkflow === item.id ? 'bg-accent-subtle text-accent' : 'hover:bg-bg-hover'}`} onClick={() => { setSelectedWorkflow(item.id); setSelectedWorkflowTask(undefined) }}><div className="truncate text-sm">{item.label}</div><div className="text-xs text-muted">{statusLabel(item.status)}</div></button>)}{!workflows.length && <p className="p-2 text-xs text-muted">暂无工作流。</p>}</div>}
        <div className="space-y-2 border-t border-border p-3">
          <label className="block text-xs text-muted">执行模型（留空使用执行默认，不继承主助手）<input aria-label="执行模型" value={executionModel} onChange={e => setExecutionModel(e.target.value)} className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5" placeholder="provider/model" /></label>
          <input aria-label="任务名称" className="w-full rounded border border-border bg-bg px-2 py-1.5 text-xs" placeholder="任务名称（可选）" value={label} onChange={e => setLabel(e.target.value)} />
          {view === 'agents' ? <><textarea aria-label="子助手任务" className="min-h-20 w-full rounded border border-border bg-bg px-2 py-1.5 text-sm" placeholder="填写目标、允许路径和验收要求" value={task} onChange={e => setTask(e.target.value)} /><button type="button" disabled={!attached || !!pending || !task.trim()} className="w-full rounded bg-accent px-2 py-1.5 text-sm text-accent-fg disabled:opacity-40" onClick={() => { void submit({ type: 'start-agent', task: task.trim(), label: label.trim() || undefined, cwd, ...modelOverride }) }}>开始子任务</button></> : <><textarea aria-label="工作流任务" className="min-h-24 w-full rounded border border-border bg-bg px-2 py-1.5 text-sm" placeholder="每行一个并行任务，空行分隔阶段" value={workflowText} onChange={e => setWorkflowText(e.target.value)} /><button type="button" disabled={!attached || !!pending || !workflowStages.length} className="w-full rounded bg-accent px-2 py-1.5 text-sm text-accent-fg disabled:opacity-40" onClick={() => { void submit({ type: 'start-workflow', label: label.trim() || undefined, cwd, stages: workflowStages, ...modelOverride }) }}>开始工作流</button></>}
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {view === 'agents' && conversation ? <>
          <div className="flex flex-wrap items-start gap-2 border-b border-border p-3"><div className="min-w-0 flex-1"><div className="break-words font-medium">{conversation.label}</div><div className="break-words text-xs text-muted">{statusLabel(recordTaskStatus(conversation))}{conversation.model && ` · ${conversation.provider ? `${conversation.provider}/` : ''}${conversation.model}`}{conversation.thinkingLevel && ` · 思考等级：${conversation.thinkingLevel}`}</div><div className="text-xs text-muted">{conversation.usage?.input !== undefined && `输入 ${conversation.usage.input} `}{conversation.usage?.output !== undefined && `输出 ${conversation.usage.output} `}{conversation.usage?.cacheRead !== undefined && `缓存读取 ${conversation.usage.cacheRead} `}{conversation.usage?.cacheWrite !== undefined && `缓存写入 ${conversation.usage.cacheWrite} `}{conversation.usage?.cost !== undefined && `估算费用 ${conversation.usage.cost.toFixed(4)}`}</div>{conversation.error && <p role="alert" className="whitespace-pre-wrap text-xs text-danger">{conversation.error}</p>}{unavailable && <p className="text-xs text-warn">当前会话不可用，保留已读取记录；继续执行需新建任务。</p>}</div><button type="button" disabled={!!pending || unavailable} className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40" onClick={() => { void send({ type: 'interrupt-agent', sessionId: conversation.id }).catch(cause => setInputError(String(cause))) }}>停止执行</button></div>
          <div className="min-h-0 flex-1 overflow-auto"><Timeline conversation={conversation} />{conversation.resultTruncated && <p className="p-3 text-xs text-warn">这里只提供结果摘要，完整结果仍保留。</p>}</div>
          <div className="flex gap-2 border-t border-border p-3"><input aria-label="继续追问" disabled={unavailable} className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1.5 text-sm" placeholder="继续追问此子助手" value={followUp} onChange={e => setFollowUp(e.target.value)} /><button type="button" disabled={!!pending || !followUp.trim() || unavailable} className="rounded border border-border px-3 py-1 text-xs disabled:opacity-40" onClick={() => { void send({ type: 'send-agent', sessionId: conversation.id, text: followUp.trim() }).then(() => setFollowUp('')).catch(cause => setInputError(String(cause))) }}>发送</button></div>
        </> : view === 'workflows' && workflow ? <>
          <div className="border-b border-border p-3"><h3 className="break-words font-medium">{workflow.label}</h3><div className="text-xs text-muted">{statusLabel(workflow.status)}{(!attached || !liveWorkflow) && ' · 保留已读取快照'}</div></div>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">{!workflow.stages?.length && <p className="text-xs text-muted">尚无任务信息。</p>}{workflow.stages?.map((stage, index) => {
            const counts = projectTaskCounts(stage.tasks)
            const stageKey = stage.id || `stage-${index}`
            return <details key={stageKey} open={projectStatus(stage.status) !== 'completed' && projectStatus(stage.status) !== 'stopped' || counts.failed > 0 || counts.attention > 0} className="rounded border border-border bg-card">
              <summary className="cursor-pointer px-3 py-2 text-sm">{stage.label} · {counts.hasProgress ? `完成 ${counts.completed}/${counts.total}` : '尚无任务信息'}{counts.failed > 0 && ` · 失败 ${counts.failed}`}{counts.skipped > 0 && ` · 跳过 ${counts.skipped}`}{counts.attention > 0 && ` · 待处理 ${counts.attention}`}</summary>
              <div className="space-y-2 border-t border-border p-3">{stage.tasks.map((item, taskIndex) => {
                const id = `${stageKey}:${stableTaskId(item, taskIndex)}`
                return <div key={id}><button type="button" className="w-full rounded border border-border px-2 py-2 text-left text-xs hover:border-accent" onClick={() => setSelectedWorkflowTask(id)}>{item.label} · {statusLabel(item.status)}</button>{selectedWorkflowTask === id && <div aria-label="工作流任务结果" className="mt-2 space-y-1 rounded bg-bg p-2 text-xs">{item.error && <p role="alert" className="text-danger">{item.error}</p>}<pre className="whitespace-pre-wrap break-words">{item.output ?? item.resultPreview ?? '此快照未提供结果正文；连接断开不等于删除结果。'}</pre>{item.resultTruncated && <p className="text-warn">这里只展示摘要。</p>}{item.sessionId && allConversations.some(agent => agent.id === item.sessionId) && <button type="button" className="text-accent" onClick={() => { setSelectedAgent(item.sessionId!); setView('agents') }}>查看子助手记录</button>}</div>}</div>
              })}</div>
            </details>
          })}{workflow.error && <p role="alert" className="text-sm text-danger">{workflow.error}</p>}</div>
        </> : <p className="m-auto p-4 text-sm text-muted">选择一项任务查看结果。</p>}
      </main>
    </div>}
    {(inputError || error || snapshot?.lastCommandError) && <div role="alert" className="border-t border-danger bg-danger-subtle px-4 py-2 text-sm text-danger">{inputError || error || snapshot?.lastCommandError}</div>}
  </div>
}
