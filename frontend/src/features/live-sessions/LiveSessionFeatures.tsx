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

const RAIL_ICON = 'h-4 w-4 shrink-0 fill-none stroke-current'
// Same visual language as the left app sidebar: icon + label row, muted by default.
const RAIL_BUTTON = 'relative flex min-h-[30px] w-full shrink-0 items-center gap-2 rounded-md px-2.5 py-1 text-xs font-medium outline-none transition duration-150 focus-visible:ring-2 focus-visible:ring-accent active:scale-[0.98] disabled:opacity-35'
const RAIL_IDLE = 'text-muted hover:bg-bg-hover hover:text-text'
const RAIL_ACTIVE = 'bg-accent-subtle text-text-strong'
const RAIL_DANGER = 'text-danger hover:bg-danger-subtle'

const BTW_STATUS_LABEL: Record<string, string> = {
  closed: '未打开',
  starting: '正在启动',
  ready: '就绪',
  busy: '回答中',
  error: '出错',
}

const FEATURE_LABEL: Record<'btw' | 'schedule' | 'subagent' | 'commands', string> = {
  btw: 'BTW',
  commands: '命令',
  schedule: '调度',
  subagent: '代理',
}

function FeatureIcon({ kind }: { kind: 'btw' | 'schedule' | 'subagent' | 'commands' | 'files' }) {
  if (kind === 'files') return <svg viewBox="0 0 24 24" className={RAIL_ICON} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 6.5A2 2 0 0 1 5.5 4.5h5l2 2h6A2 2 0 0 1 20.5 8.5v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="M3.5 9h17" /></svg>
  if (kind === 'btw') return <svg viewBox="0 0 24 24" className={RAIL_ICON} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v5a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4.1A2.5 2.5 0 0 1 5 11.5z" /><path d="M9 8.5h6M9 11h3" /></svg>
  if (kind === 'schedule') return <svg viewBox="0 0 24 24" className={RAIL_ICON} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2M8 3.5l-1.5 1M16 3.5l1.5 1" /></svg>
  if (kind === 'subagent') return <svg viewBox="0 0 24 24" className={RAIL_ICON} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="7" r="2.5" /><circle cx="18" cy="17" r="2.5" /><path d="m8.3 11 7.4-3M8.3 13l7.4 3" /></svg>
  return <svg viewBox="0 0 24 24" className={RAIL_ICON} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M7 5h10v14H7zM9.5 8h5M9.5 11h5M9.5 14h3" /><path d="M4 8h3M4 12h3M4 16h3" /></svg>
}

function ActionIcon({ kind }: { kind: 'interrupt' | 'goal' | 'compact' | 'reload' | 'clear' }) {
  // Interrupting is "pause the current turn", not "stop the session" — the rails
  // used to draw a stop square here, which read as a different action.
  if (kind === 'interrupt') return <svg viewBox="0 0 24 24" className={RAIL_ICON} strokeWidth={1.8} strokeLinecap="round"><path d="M9.5 7v10M14.5 7v10" /></svg>
  if (kind === 'goal') return <svg viewBox="0 0 24 24" className={RAIL_ICON} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>
  if (kind === 'compact') return <svg viewBox="0 0 24 24" className={RAIL_ICON} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" /></svg>
  if (kind === 'reload') return <svg viewBox="0 0 24 24" className={RAIL_ICON} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4.5V9h-4.5" /></svg>
  return <svg viewBox="0 0 24 24" className={RAIL_ICON} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 7h15" /><path d="M6.5 7l.9 12.1a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7" /><path d="M9.5 7V4.5h5V7M10 11v5M14 11v5" /></svg>
}

function Feature({ title, icon, count, children }: { title: string; icon: 'btw' | 'schedule' | 'subagent' | 'commands'; count?: number; children: React.ReactNode }) {
  return <details className="relative w-full shrink-0">
    <summary className={`${RAIL_BUTTON} cursor-pointer list-none ${RAIL_IDLE}`} title={title} aria-label={title}>
      <FeatureIcon kind={icon} />
      <span className="truncate">{FEATURE_LABEL[icon]}</span>
      {count !== undefined && count > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full bg-accent px-1 text-center text-[9px] font-semibold leading-[15px] text-accent-fg">{count}</span>}
    </summary>
    <div className="absolute right-full top-0 z-40 mr-2 max-h-[70vh] w-[min(560px,calc(100vw-4rem))] overflow-auto rounded-lg border border-border bg-card p-3 shadow-xl">{children}</div>
  </details>
}

function SessionAction({ label, icon, disabled, danger, onClick, title }: { label: string; icon: 'interrupt' | 'goal' | 'compact' | 'reload' | 'clear'; disabled?: boolean; danger?: boolean; onClick: () => void; title?: string }) {
  return <button type="button" onClick={onClick} disabled={disabled} title={title || label} aria-label={title || label} className={`${RAIL_BUTTON} ${danger ? RAIL_DANGER : RAIL_IDLE}`}>
    <ActionIcon kind={icon} />
    <span className="truncate">{label}</span>
  </button>
}

export default function LiveSessionFeatures({ features, busy, cwd, status, compacting = false, onFileOpen, onOpenBtw, onCloseBtw, onBtwSubmit, onBtwAbort, onBtwRefreshParent, onOpenWorkflow, onGoal, onCompact, onClear, clearArmed = false, onReload, onAbort }: {
  features: Record<string, unknown>
  busy?: boolean
  cwd?: string
  status: LiveSessionStatus
  onFileOpen: (path: string) => void
  onOpenBtw: () => void
  onCloseBtw: () => void
  /** Ask the read-only side chat a question. */
  onBtwSubmit: (text: string) => void
  /** Stop the answer currently being generated by the side chat. */
  onBtwAbort: () => void
  /** Re-snapshot the parent session's context into the side chat. */
  onBtwRefreshParent: () => void
  onOpenWorkflow: (workflow: Record<string, unknown>) => void
  onGoal: () => void
  /** True while a requested compaction has not landed on disk yet. */
  compacting?: boolean
  onCompact: () => void
  onClear: () => void
  /** True while 「清空」 waits for the confirming second click. */
  clearArmed?: boolean
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
  const [btwDraft, setBtwDraft] = useState('')
  const btwStatus = String(btw?.status || 'closed')
  const btwOpen = btwStatus === 'ready' || btwStatus === 'busy'
  const btwStarting = btwStatus === 'starting'
  const btwActivity = typeof btw?.activity === 'string' ? btw.activity : ''
  const btwError = typeof btw?.error === 'string' ? btw.error : ''
  const btwLocked = !!busy || btwStarting
  const sendBtw = () => {
    const text = btwDraft.trim()
    if (!text || !btwOpen || btwLocked) return
    setBtwDraft('')
    onBtwSubmit(text)
  }
  const [filesOpen, setFilesOpen] = useState(false)

  return <aside className="relative z-30 flex w-[84px] shrink-0 flex-col items-stretch gap-1.5 overflow-visible border-l border-border bg-card px-1.5 py-2.5">
    <button type="button" onClick={() => setFilesOpen(value => !value)} className={`${RAIL_BUTTON} ${filesOpen ? RAIL_ACTIVE : RAIL_IDLE}`} title="浏览当前工作目录" aria-label="浏览当前工作目录">
      <FeatureIcon kind="files" />
      <span>文件</span>
    </button>
    {filesOpen && <>
      <div className="fixed inset-0 z-30 bg-black/10 backdrop-blur-[1px]" onClick={() => setFilesOpen(false)} aria-hidden="true" />
      <div className="absolute right-full top-2 z-40 mr-3 h-[min(78vh,720px)] w-[min(620px,calc(100vw-3.5rem))] overflow-hidden rounded-xl border border-border bg-card shadow-2xl shadow-black/30 ring-1 ring-white/5">
        <FileBrowser startPath={cwd} onFileOpen={onFileOpen} onClose={() => setFilesOpen(false)} />
      </div>
    </>}

    <div className="flex w-full flex-col items-stretch gap-0.5">
      {status === 'running' && <SessionAction label="中止" icon="interrupt" danger disabled={busy} onClick={onAbort} title="中止当前回合：Pi 会停下来，已完成的步骤保留（不是可恢复的暂停）" />}
      <SessionAction label="目标" icon="goal" disabled={busy || status !== 'idle'} onClick={onGoal} title="查看/管理当前 session 的 /goal 状态" />
      <SessionAction label={compacting ? '压缩中…' : '压缩'} icon="compact" disabled={busy || compacting || status !== 'idle'} onClick={onCompact} title={compacting ? '压缩仍在后台进行，等完成后再试' : '压缩当前会话上下文，释放 token'} />
      <SessionAction label="重载" icon="reload" disabled={busy} onClick={onReload} title="重载扩展 / 技能 / 提示词 / 主题" />
      <SessionAction label={clearArmed ? '确认清空' : '清空'} icon="clear" danger disabled={busy || status !== 'idle'} onClick={onClear} title={clearArmed ? '再点一次确认：旧对话保留在文件中，本页切到新的空会话' : '开始新的空会话（旧对话保留在文件中）'} />
    </div>
    <div className="my-0.5 h-px w-10 self-center rounded-full bg-border" />

    <Feature title="BTW" icon="btw" count={conversation.length}>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">状态：{BTW_STATUS_LABEL[btwStatus] ?? btwStatus}{btwActivity ? ` · ${btwActivity}` : ''}</span>
        <button type="button" disabled={btwLocked} onClick={onBtwRefreshParent} className="ml-auto text-xs text-muted rounded px-2 py-1 hover:bg-bg-hover disabled:opacity-50" title="把主会话当前的上下文重新同步给 BTW">同步上下文</button>
        {btwOpen
          ? <button type="button" disabled={busy} onClick={onCloseBtw} className="text-xs text-muted rounded px-2 py-1 hover:bg-bg-hover disabled:opacity-50">关闭 BTW</button>
          : <button type="button" disabled={btwLocked} onClick={onOpenBtw} className="text-xs text-accent-fg bg-accent rounded px-2 py-1 disabled:opacity-50">{btwStarting ? '正在打开…' : '打开 BTW'}</button>}
      </div>
      {btwError && <div className="mt-2 rounded bg-danger-subtle px-2 py-1 text-xs text-danger" role="alert">BTW 出错：{btwError}</div>}
      {!btwOpen && !btwStarting && !btwError && <div className="mt-2 text-xs text-muted">BTW 未打开：点「打开 BTW」启动一个只读旁聊（不会改动主会话）。</div>}
      {conversation.length === 0 && (btwOpen || btwStarting)
        ? <div className="mt-2 text-xs text-muted">{btwStarting ? 'BTW 正在启动…' : 'BTW 已就绪：直接在下面提问，它只读、不影响主会话。'}</div>
        : conversation.length > 0 && <div className="mt-2 space-y-1.5">
          {conversation.map((entry, index) => <div key={index} className={`rounded px-2.5 py-1.5 text-xs ${entry.role === 'user' ? 'bg-accent-subtle' : 'bg-bg-hover'}`}>
            <div className="mb-1 text-2xs uppercase text-muted">{String(entry.role || 'notice')}</div>
            <MarkdownRenderer content={String(entry.text || '')} />
          </div>)}
        </div>}
      <div className="mt-2 flex items-end gap-1.5">
        <textarea
          value={btwDraft}
          rows={2}
          disabled={!btwOpen || btwLocked}
          onChange={event => setBtwDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendBtw() } }}
          placeholder={btwOpen ? '问 BTW 一个问题（Enter 发送，Shift+Enter 换行）' : '先打开 BTW'}
          aria-label="BTW 提问"
          className="min-h-[40px] flex-1 resize-none rounded-md bg-bg-hover px-2.5 py-1.5 text-xs text-text outline-none placeholder:text-muted disabled:opacity-50"
        />
        {btwStatus === 'busy'
          ? <button type="button" disabled={busy} onClick={onBtwAbort} className="h-[26px] shrink-0 rounded-md bg-danger-subtle px-2.5 text-xs text-danger hover:bg-danger hover:text-danger-fg disabled:opacity-50">中止</button>
          : <button type="button" disabled={!btwOpen || btwLocked || !btwDraft.trim()} onClick={sendBtw} className="h-[26px] shrink-0 rounded-md bg-accent px-2.5 text-xs text-accent-fg disabled:opacity-50">发送</button>}
      </div>
    </Feature>

    <Feature title="后台命令" icon="commands" count={backgroundTasks.length}>
      {backgroundTasks.length === 0 ? <div className="text-xs text-muted">当前没有后台命令。</div> : <div className="space-y-2">
        {backgroundTasks.map(task => {
          const status = String(task.status || 'unknown')
          const output = typeof task.outputTail === 'string' ? task.outputTail : ''
          return <div key={String(task.taskId || task.id)} className="rounded border border-border bg-card p-2">
            <div className="flex items-center gap-2 text-2xs"><span className={status === 'running' ? 'text-accent' : status === 'succeeded' ? 'text-ok' : 'text-muted'}>{status}</span><strong className="min-w-0 truncate">{String(task.title || task.taskId || '')}</strong></div>
            <div className="mt-1 truncate font-mono text-2xs text-muted">{String(task.taskId || '')} · PID {String(task.pid || '—')} · {String(task.outputBytes || 0)} bytes</div>
            {output ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-1.5 font-mono text-2xs leading-4 text-text">{output}</pre> : <div className="mt-1 text-2xs text-muted">等待输出…</div>}
          </div>
        })}
      </div>}
    </Feature>

    <Feature title="Scheduler" icon="schedule" count={tasks.length}>
      {tasks.length === 0 ? <div className="text-xs text-muted">当前 session 没有 schedule。</div> : <div className="space-y-2">
        {tasks.map(task => <div key={String(task.id)} className="rounded border border-border bg-card p-2">
          <div className="flex gap-2 text-xs"><span className="font-mono text-accent">{String(task.id)}</span><strong className="truncate">{String(task.title || '')}</strong></div>
          <div className="mt-1 text-2xs text-muted">下次执行：{typeof task.nextRunAt === 'number' ? new Date(task.nextRunAt).toLocaleString() : '—'}{typeof task.intervalMs === 'number' ? ` · 每 ${Math.round(task.intervalMs / 60_000)} 分钟` : ''}</div>
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
