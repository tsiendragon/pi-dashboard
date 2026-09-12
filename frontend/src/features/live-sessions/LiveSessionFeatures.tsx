import { useState } from 'react'
import type { LiveSessionStatus } from '@shared/live-sessions'
import MarkdownRenderer from '../../components/MarkdownRenderer'
import FileBrowser from '../../components/FileBrowser'

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
}

function items(value: unknown, key: string): RecordValue[] {
  const container = record(value)
  const list = Array.isArray(container?.[key]) ? container?.[key] : []
  return (list as unknown[]).map(record).filter((item): item is RecordValue => !!item)
}

function FeatureIcon({ kind }: { kind: 'btw' | 'schedule' | 'subagent' | 'commands' | 'files' }) {
  if (kind === 'files') return <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 6.5A2 2 0 0 1 5.5 4.5h5l2 2h6A2 2 0 0 1 20.5 8.5v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="M3.5 9h17" /></svg>
  if (kind === 'btw') return <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v5a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4.1A2.5 2.5 0 0 1 5 11.5z" /><path d="M9 8.5h6M9 11h3" /></svg>
  if (kind === 'schedule') return <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2M8 3.5l-1.5 1M16 3.5l1.5 1" /></svg>
  if (kind === 'subagent') return <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="7" r="2.5" /><circle cx="18" cy="17" r="2.5" /><path d="m8.3 11 7.4-3M8.3 13l7.4 3" /></svg>
  return <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 5h10v14H7zM9.5 8h5M9.5 11h5M9.5 14h3" /><path d="M4 8h3M4 12h3M4 16h3" /></svg>
}

function Feature({ title, icon, count, children }: { title: string; icon: 'btw' | 'schedule' | 'subagent' | 'commands'; count?: number; children: React.ReactNode }) {
  return <details className="relative w-11 shrink-0">
    <summary className="flex min-h-12 cursor-pointer list-none flex-col items-center justify-center gap-1 rounded-md border border-border bg-card px-1 py-1.5 text-center text-[10px] font-semibold text-text-strong shadow-sm transition-colors hover:border-accent hover:bg-accent-subtle" title={title} aria-label={title}>
      <FeatureIcon kind={icon} />
      {count !== undefined && <span className="rounded-full bg-bg px-1.5 py-0.5 text-[9px] font-medium leading-none text-muted">{count}</span>}
    </summary>
    <div className="absolute right-full top-0 z-40 mr-2 max-h-[70vh] w-[min(560px,calc(100vw-4rem))] overflow-auto rounded-lg border border-border bg-card p-3 shadow-xl">{children}</div>
  </details>
}

function SessionAction({ label, disabled, danger, onClick, title }: { label: string; disabled?: boolean; danger?: boolean; onClick: () => void; title?: string }) {
  return <button type="button" onClick={onClick} disabled={disabled} title={title || label} aria-label={title || label} className={`flex min-h-11 w-11 shrink-0 items-center justify-center rounded-lg border px-1 py-1.5 text-center text-[10px] font-semibold shadow-sm transition-all disabled:opacity-40 ${danger ? 'border-danger/40 bg-danger-subtle text-danger hover:border-danger' : 'border-border bg-card text-text-strong hover:border-accent/70 hover:bg-accent-subtle'}`}>
    {label}
  </button>
}

export default function LiveSessionFeatures({ features, busy, cwd, status, onFileOpen, onOpenBtw, onCloseBtw, onOpenWorkflow, onCompact, onClear, onReload, onAbort }: {
  features: Record<string, unknown>
  busy?: boolean
  cwd?: string
  status: LiveSessionStatus
  onFileOpen: (path: string) => void
  onOpenBtw: () => void
  onCloseBtw: () => void
  onOpenWorkflow: (workflow: Record<string, unknown>) => void
  onCompact: () => void
  onClear: () => void
  onReload: () => void
  onAbort: () => void
}) {
  const btw = record(features.btw)
  const schedule = record(features.schedule)
  const background = record(features['background-commands'])
  const subagent = record(features['subagent-workflow'])
  const conversations = items(subagent?.conversations, 'items')
  const workflows = items(subagent?.workflows, 'items')
  const tasks = Array.isArray(schedule?.tasks) ? schedule.tasks.map(record).filter((task): task is RecordValue => !!task) : []
  const backgroundTasks = Array.isArray(background?.tasks) ? background.tasks.map(record).filter((task): task is RecordValue => !!task) : []
  const conversation = Array.isArray(btw?.conversation) ? btw.conversation.map(record).filter((entry): entry is RecordValue => !!entry) : []
  const [filesOpen, setFilesOpen] = useState(false)

  return <aside className="relative z-30 flex w-14 shrink-0 flex-col items-center gap-2 overflow-visible border-l border-border bg-card/60 px-1.5 py-2">
    <button type="button" onClick={() => setFilesOpen(value => !value)} className={`group flex min-h-12 w-11 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border px-1 py-1.5 text-center text-[10px] font-semibold shadow-sm transition-all ${filesOpen ? 'border-accent bg-accent-subtle text-accent shadow-accent/10' : 'border-border bg-card text-text-strong hover:-translate-x-0.5 hover:border-accent/70 hover:bg-accent-subtle'}`} title="浏览当前工作目录" aria-label="浏览当前工作目录">
      <span className={`rounded-md p-1 transition-colors ${filesOpen ? 'bg-accent/15' : 'bg-bg group-hover:bg-accent/10'}`}><FeatureIcon kind="files" /></span>
      <span>文件</span>
    </button>
    {filesOpen && <>
      <div className="fixed inset-0 z-30 bg-black/10 backdrop-blur-[1px]" onClick={() => setFilesOpen(false)} aria-hidden="true" />
      <div className="absolute right-full top-2 z-40 mr-3 h-[min(78vh,720px)] w-[min(620px,calc(100vw-3.5rem))] overflow-hidden rounded-xl border border-border/80 bg-card shadow-2xl shadow-black/30 ring-1 ring-white/5">
        <FileBrowser startPath={cwd} onFileOpen={onFileOpen} onClose={() => setFilesOpen(false)} />
      </div>
    </>}

    <div className="flex flex-col items-center gap-1.5">
      {status === 'running' && <SessionAction label="停止" danger disabled={busy} onClick={onAbort} title="中止当前正在执行的 agent 回答" />}
      <SessionAction label="压缩" disabled={busy || status !== 'idle'} onClick={onCompact} title="压缩当前会话上下文，释放 token" />
      <SessionAction label="重载" disabled={busy} onClick={onReload} title="重载扩展 / 技能 / 提示词 / 主题" />
      <SessionAction label="清空" danger disabled={busy || status !== 'idle'} onClick={onClear} title="开始新的空会话（旧对话保留在文件中）" />
    </div>
    <div className="my-1 h-px w-8 bg-border" />

    <Feature title="BTW" icon="btw" count={conversation.length}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-muted">状态：{String(btw?.status || 'closed')}</span>
        {btw?.status === 'ready' || btw?.status === 'busy'
          ? <button type="button" disabled={busy} onClick={onCloseBtw} className="ml-auto text-xs text-muted border border-border rounded px-2 py-1 disabled:opacity-50">关闭 BTW</button>
          : <button type="button" disabled={busy || btw?.status === 'starting'} onClick={onOpenBtw} className="ml-auto text-xs text-white bg-accent rounded px-2 py-1 disabled:opacity-50">{btw?.status === 'starting' ? '正在打开…' : '打开 BTW'}</button>}
      </div>
      {!btw || btw.status === 'closed' || conversation.length === 0 ? <div className="text-xs text-muted">BTW 暂无对话；可直接从这里打开。</div> : <div className="space-y-2">
        {conversation.map((entry, index) => <div key={index} className={`rounded border p-2 text-xs ${entry.role === 'user' ? 'border-accent/30 bg-accent/10' : 'border-border bg-card'}`}>
          <div className="mb-1 text-[10px] uppercase text-muted">{String(entry.role || 'notice')}</div>
          <MarkdownRenderer content={String(entry.text || '')} />
        </div>)}
      </div>}
    </Feature>

    <Feature title="后台命令" icon="commands" count={backgroundTasks.length}>
      {backgroundTasks.length === 0 ? <div className="text-xs text-muted">当前没有后台命令。</div> : <div className="space-y-2">
        {backgroundTasks.map(task => {
          const status = String(task.status || 'unknown')
          const output = typeof task.outputTail === 'string' ? task.outputTail : ''
          return <div key={String(task.taskId || task.id)} className="rounded border border-border bg-card p-2">
            <div className="flex items-center gap-2 text-[11px]"><span className={status === 'running' ? 'text-accent' : status === 'succeeded' ? 'text-ok' : 'text-muted'}>{status}</span><strong className="min-w-0 truncate">{String(task.title || task.taskId || '')}</strong></div>
            <div className="mt-1 truncate font-mono text-[10px] text-muted">{String(task.taskId || '')} · PID {String(task.pid || '—')} · {String(task.outputBytes || 0)} bytes</div>
            {output ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-1.5 font-mono text-[10px] leading-4 text-text">{output}</pre> : <div className="mt-1 text-[10px] text-muted">等待输出…</div>}
          </div>
        })}
      </div>}
    </Feature>

    <Feature title="Scheduler" icon="schedule" count={tasks.length}>
      {tasks.length === 0 ? <div className="text-xs text-muted">当前 session 没有 schedule。</div> : <div className="space-y-2">
        {tasks.map(task => <div key={String(task.id)} className="rounded border border-border bg-card p-2">
          <div className="flex gap-2 text-xs"><span className="font-mono text-accent">{String(task.id)}</span><strong className="truncate">{String(task.title || '')}</strong></div>
          <div className="mt-1 text-[11px] text-muted">下次执行：{typeof task.nextRunAt === 'number' ? new Date(task.nextRunAt).toLocaleString() : '—'}{typeof task.intervalMs === 'number' ? ` · 每 ${Math.round(task.intervalMs / 60_000)} 分钟` : ''}</div>
          <div className="mt-1 text-xs whitespace-pre-wrap">{String(task.instruction || '')}</div>
        </div>)}
      </div>}
    </Feature>

    <Feature title="Subagent / Workflow" icon="subagent" count={conversations.length + workflows.length}>
      {conversations.length + workflows.length === 0 ? <div className="text-xs text-muted">当前没有 Subagent 或 Workflow 记录。</div> : <div className="space-y-2">
        {workflows.map(item => <button type="button" key={String(item.id)} onClick={() => onOpenWorkflow(item)} className="w-full rounded border border-border bg-card p-2 text-left text-xs hover:border-accent"><span className="font-mono text-accent">workflow</span> · {String(item.label || item.id)}<span className="float-right text-muted">{String(item.status || '')}</span></button>)}
        {conversations.map(item => <div key={String(item.id)} className="rounded border border-border bg-card p-2 text-xs"><span className="font-mono text-accent">subagent</span> · {String(item.label || item.id)}<span className="float-right text-muted">{String(item.status || '')}</span></div>)}
      </div>}
    </Feature>
  </aside>
}
