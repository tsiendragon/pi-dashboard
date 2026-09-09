import { useMemo, useState } from 'react'
import { useAppSelector } from '../../store'
import ToolCallBlock from '../../pages/chat/ToolCallBlock'
import ThinkingBlock from '../../pages/chat/ThinkingBlock'
import { useIntegration } from '../useIntegration'

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
  usage?: { input: number; output: number; cost: number }
}
type WorkflowTask = { id: string; label: string; status: string; sessionId?: string; error?: string }
type Workflow = { id: string; label: string; status: string; currentStage?: number; stages?: Array<{ id: string; label: string; status: string; tasks: WorkflowTask[] }>; error?: string }
type Snapshot = {
  revision: number
  governor: { active: number; queued: number; activeLimit: number; queueLimit: number }
  runHealth: { running: number; stalled: number }
  conversations: { items: Conversation[] }
  workflows: { items: Workflow[] }
  lastCommandError?: string
}

function outputText(entry: ToolEntry): string | undefined {
  return entry.output?.content?.filter(item => item.type === 'text').map(item => item.text || '').join('\n')
}

function Timeline({ conversation }: { conversation: Conversation }) {
  if (!conversation.timeline?.length) return <div className="text-muted text-sm p-4">No transcript yet.</div>
  return <div className="space-y-3 p-4">
    {conversation.timeline.map(entry => {
      if (entry.type === 'user') return <div key={entry.id} className="ml-auto max-w-[85%] rounded-lg bg-accent/15 border border-accent/20 px-3 py-2 whitespace-pre-wrap text-sm">{entry.text}</div>
      if (entry.type === 'tool') {
        return <ToolCallBlock
          key={entry.id}
          content={`🔧 ${entry.name}`}
          meta={{
            toolName: entry.name,
            toolCallId: entry.toolCallId,
            args: JSON.stringify(entry.args ?? {}, null, 2),
            result: outputText(entry),
            isError: entry.status === 'failed',
          }}
        />
      }
      return <div key={entry.id} className="rounded-lg border border-border bg-card px-3 py-2 space-y-2">
        {entry.content.map((block, index) => block.type === 'thinking'
          ? <ThinkingBlock key={index} content={block.thinking || ''} />
          : block.type === 'text' && block.text
            ? <div key={index} className="whitespace-pre-wrap text-sm text-text">{block.text}</div>
            : null)}
        {entry.streaming && <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />}
        {entry.errorMessage && <div className="text-danger text-sm">{entry.errorMessage}</div>}
      </div>
    })}
  </div>
}

export default function WorkbenchPanel({ slot, onClose }: { slot: string; onClose: () => void }) {
  const currentSlot = useAppSelector(s => s.dashboard.slots.find(item => item.key === slot))
  const { attached, snapshot, pending, error, send } = useIntegration<Snapshot>(slot, 'subagent-workbench')
  const [view, setView] = useState<'agents' | 'workflows'>('agents')
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null)
  const [task, setTask] = useState('')
  const [label, setLabel] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [workflowText, setWorkflowText] = useState('')

  const conversations = snapshot?.conversations.items ?? []
  const workflows = snapshot?.workflows.items ?? []
  const conversation = conversations.find(item => item.id === selectedAgent) ?? conversations[0]
  const workflow = workflows.find(item => item.id === selectedWorkflow) ?? workflows[0]
  const cwd = currentSlot?.cwd || '/tmp'

  const workflowStages = useMemo(() => workflowText
    .split(/\n\s*\n/)
    .map((stage, stageIndex) => ({
      label: `Stage ${stageIndex + 1}`,
      tasks: stage.split('\n').map(line => line.trim()).filter(Boolean).map(line => ({ task: line, cwd })),
    }))
    .filter(stage => stage.tasks.length > 0), [workflowText, cwd])

  const startAgent = async () => {
    if (!task.trim()) return
    await send({ type: 'start-agent', task: task.trim(), label: label.trim() || undefined, cwd, model: currentSlot?.model })
    setTask(''); setLabel('')
  }
  const startWorkflow = async () => {
    if (!workflowStages.length) return
    await send({ type: 'start-workflow', label: label.trim() || undefined, cwd, model: currentSlot?.model, stages: workflowStages })
    setWorkflowText(''); setLabel(''); setView('workflows')
  }

  return <div className="fixed inset-0 z-50 bg-bg flex flex-col">
    <header className="flex items-center gap-3 px-4 py-3 border-b border-border bg-chrome">
      <button className="text-muted hover:text-text" onClick={onClose}>← Chat</button>
      <strong className="text-text">Subagent Workbench</strong>
      {snapshot && <span className="text-xs text-muted">active {snapshot.governor.active}/{snapshot.governor.activeLimit} · queued {snapshot.governor.queued} · stalled {snapshot.runHealth.stalled}</span>}
      {pending > 0 && <span className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />}
      <button className="ml-auto text-xs text-muted hover:text-text" onClick={() => send({ type: 'refresh' })}>Refresh</button>
      <button className="text-muted hover:text-text" onClick={onClose}>✕</button>
    </header>

    {!attached ? <div className="m-auto max-w-lg text-center space-y-2"><div className="text-lg text-text">Workbench is starting or unavailable</div><div className="text-sm text-muted">The active Pi slot must load the pi-subagent-workbench extension.</div></div> :
    <div className="flex flex-1 min-h-0">
      <aside className="w-72 border-r border-border bg-chrome flex flex-col min-h-0">
        <div className="grid grid-cols-2 border-b border-border">
          <button className={`py-2 text-sm ${view === 'agents' ? 'text-accent bg-accent/10' : 'text-muted'}`} onClick={() => setView('agents')}>Agents ({conversations.length})</button>
          <button className={`py-2 text-sm ${view === 'workflows' ? 'text-accent bg-accent/10' : 'text-muted'}`} onClick={() => setView('workflows')}>Workflows ({workflows.length})</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {view === 'agents' ? conversations.map(item => <button key={item.id} onClick={() => setSelectedAgent(item.id)} className={`w-full text-left p-2 rounded border ${conversation?.id === item.id ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-bg-hover'}`}>
            <div className="text-sm text-text truncate">{item.label}</div><div className="text-xs text-muted">{item.status} · {item.model || 'default'}</div>
          </button>) : workflows.map(item => <button key={item.id} onClick={() => setSelectedWorkflow(item.id)} className={`w-full text-left p-2 rounded border ${workflow?.id === item.id ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-bg-hover'}`}>
            <div className="text-sm text-text truncate">{item.label}</div><div className="text-xs text-muted">{item.status}</div>
          </button>)}
        </div>
        <div className="border-t border-border p-3 space-y-2">
          <input className="w-full bg-bg border border-border rounded px-2 py-1.5 text-sm" placeholder="Optional label" value={label} onChange={e => setLabel(e.target.value)} />
          {view === 'agents' ? <>
            <textarea className="w-full bg-bg border border-border rounded px-2 py-1.5 text-sm min-h-20" placeholder="Bounded subagent task" value={task} onChange={e => setTask(e.target.value)} />
            <button className="w-full bg-accent text-white rounded py-1.5 disabled:opacity-40" disabled={!task.trim() || pending > 0} onClick={() => void startAgent()}>Start Agent</button>
          </> : <>
            <textarea className="w-full bg-bg border border-border rounded px-2 py-1.5 text-sm min-h-28" placeholder={'One task per line (parallel)\n\nBlank line starts next stage'} value={workflowText} onChange={e => setWorkflowText(e.target.value)} />
            <button className="w-full bg-accent text-white rounded py-1.5 disabled:opacity-40" disabled={!workflowStages.length || pending > 0} onClick={() => void startWorkflow()}>Start Workflow</button>
          </>}
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        {view === 'agents' && conversation ? <>
          <div className="px-4 py-2 border-b border-border flex items-center gap-3">
            <div><div className="font-semibold text-text">{conversation.label}</div><div className="text-xs text-muted">{conversation.id} · {conversation.status} · {conversation.provider || ''}/{conversation.model || ''}</div></div>
            {(conversation.status === 'running' || conversation.status === 'queued') && <button className="ml-auto text-xs text-danger border border-danger/40 rounded px-2 py-1" onClick={() => void send({ type: 'interrupt-agent', sessionId: conversation.id })}>Interrupt</button>}
          </div>
          <div className="flex-1 overflow-y-auto"><Timeline conversation={conversation} /></div>
          {!conversation.workflowId && <div className="border-t border-border p-3 flex gap-2"><input className="flex-1 bg-bg border border-border rounded px-3 py-2 text-sm" placeholder="Follow up with this agent" value={followUp} onChange={e => setFollowUp(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && followUp.trim()) { void send({ type: 'send-agent', sessionId: conversation.id, message: followUp.trim() }); setFollowUp('') } }} /><button className="bg-accent text-white rounded px-4" onClick={() => { if (followUp.trim()) { void send({ type: 'send-agent', sessionId: conversation.id, message: followUp.trim() }); setFollowUp('') } }}>Send</button></div>}
        </> : view === 'workflows' && workflow ? <div className="p-5 overflow-y-auto space-y-4">
          <div className="flex items-center"><div><h2 className="text-lg font-semibold">{workflow.label}</h2><div className="text-sm text-muted">{workflow.id} · {workflow.status}</div></div>{workflow.status === 'running' && <button className="ml-auto text-danger border border-danger/40 rounded px-3 py-1" onClick={() => void send({ type: 'interrupt-workflow', workflowId: workflow.id })}>Interrupt workflow</button>}</div>
          {workflow.stages?.map((stage, index) => <section key={stage.id} className="border border-border rounded-lg overflow-hidden"><div className="bg-chrome px-3 py-2 font-medium">{index + 1}. {stage.label} <span className="text-xs text-muted">· {stage.status}</span></div><div className="p-2 space-y-1">{stage.tasks.map(item => <button key={item.id} disabled={!item.sessionId} onClick={() => { if (item.sessionId) { setSelectedAgent(item.sessionId); setView('agents') } }} className="w-full text-left rounded p-2 hover:bg-bg-hover disabled:cursor-default"><span className="text-sm">{item.label}</span><span className="text-xs text-muted ml-2">{item.status}</span>{item.error && <div className="text-xs text-danger">{item.error}</div>}</button>)}</div></section>)}
        </div> : <div className="m-auto text-muted">No {view} yet.</div>}
      </main>
    </div>}
    {(error || snapshot?.lastCommandError) && <div className="px-4 py-2 text-sm text-danger border-t border-danger/30 bg-danger/5">{error || snapshot?.lastCommandError}</div>}
  </div>
}
