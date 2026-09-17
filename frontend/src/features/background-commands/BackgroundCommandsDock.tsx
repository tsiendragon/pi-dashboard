import { useEffect, useState } from 'react'
import { useIntegration } from '../useIntegration'

type Task = {
  taskId: string; title: string; status: string; command: string; cwd: string
  pid?: number; startedAt: number; endedAt?: number; exitCode?: number | null
  exitReason?: string; outputBytes: number; outputFile: string; outputTail: string
  outputTruncated?: boolean; error?: string
}
type Snapshot = { revision: number; tasks: Task[] }

function elapsed(task: Task, now: number): string {
  const seconds = Math.max(0, Math.floor(((task.endedAt ?? now) - task.startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

export default function BackgroundCommandsDock({ slot }: { slot: string }) {
  const { snapshot, send } = useIntegration<Snapshot>(slot, 'background-commands')
  const [selected, setSelected] = useState<string | null>(null)
  const [minimized, setMinimized] = useState(false)
  const [now, setNow] = useState(Date.now())
  const tasks = snapshot?.tasks ?? []
  const task = tasks.find(item => item.taskId === selected) ?? tasks[tasks.length - 1]

  useEffect(() => {
    if (!tasks.some(item => item.status === 'running' || item.status === 'starting')) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [tasks])

  if (!tasks.length) return null
  const active = tasks.filter(item => item.status === 'running' || item.status === 'starting').length

  return <div className="fixed z-40 bottom-24 right-4 w-[min(520px,calc(100vw-2rem))] max-h-[55vh] bg-card border border-border rounded-lg shadow-2xl overflow-hidden flex flex-col">
    <button className="flex items-center gap-2 px-3 py-2 bg-chrome border-b border-border text-left" onClick={() => setMinimized(value => !value)}>
      {active > 0 ? <span className="w-2.5 h-2.5 border-2 border-accent border-t-transparent rounded-full animate-spin" /> : <span className="text-ok">✓</span>}
      <span className="text-sm font-semibold">Background commands</span>
      <span className="text-xs text-muted">{active} active · {tasks.length} retained</span>
      <span className="ml-auto text-muted">{minimized ? '▲' : '▼'}</span>
    </button>
    {!minimized && <>
      <div className="flex gap-1 p-2 overflow-x-auto border-b border-border">
        {tasks.map(item => <button key={item.taskId} onClick={() => setSelected(item.taskId)} className={`shrink-0 rounded px-2 py-1 text-xs border ${task?.taskId === item.taskId ? 'border-accent text-accent bg-accent/10' : 'border-border text-muted'}`}>{item.title}</button>)}
      </div>
      {task && <div className="min-h-0 flex flex-col">
        <div className="px-3 py-2 border-b border-border">
          <div className="flex items-center gap-2"><span className="font-mono text-xs text-accent">{task.taskId}</span><span className="text-xs text-muted">{task.status} · {elapsed(task, now)}{task.pid ? ` · pid ${task.pid}` : ''}</span>{(task.status === 'running' || task.status === 'starting') && <button className="ml-auto text-xs text-danger border border-danger/40 rounded px-2 py-0.5" onClick={() => void send({ type: 'cancel', taskId: task.taskId })}>Cancel</button>}</div>
          <div className="text-xs text-text mt-1 font-mono break-all">{task.command}</div>
          <div className="text-2xs text-muted truncate mt-1">{task.cwd} · {task.outputBytes.toLocaleString()} bytes</div>
        </div>
        <pre className="p-3 bg-bg text-xs font-mono whitespace-pre-wrap break-all overflow-y-auto max-h-64 min-h-24">{task.outputTail || '(waiting for output…)'}{task.outputTruncated ? '\n… tail truncated' : ''}</pre>
        {(task.error || task.exitReason) && <div className="px-3 py-1.5 text-xs text-danger border-t border-border">{task.error || `${task.exitReason}${task.exitCode != null ? ` · exit ${task.exitCode}` : ''}`}</div>}
      </div>}
    </>}
  </div>
}
