import { useEffect, useRef, useState } from 'react'
import type { LiveSessionStatus } from '@shared/live-sessions'
import type { SessionGoalSummary } from './sessionGoal'
import { goalProgressOf } from './sessionGoal'
import GoalAnchorDialog from './goal/GoalAnchorDialog'
import MarkdownRenderer from '../../components/MarkdownRenderer'
import FileBrowser from '../../components/FileBrowser'
import LineIcon, { type LineIconName } from '../../components/LineIcon'
import { SupervisorNotificationsSidebarButton } from '../supervisor/SupervisorAgentProvider'
import { isCollapsedByDefault, projectStatus, projectSubagentSnapshot, stableTaskId, textValue } from './subagentProjection'

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
}

const RAIL_BUTTON = 'group relative flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] outline-none transition duration-150 focus-visible:ring-2 focus-visible:ring-accent active:scale-[0.96] disabled:opacity-35'
const RAIL_IDLE = 'text-muted hover:bg-bg-hover hover:text-text'
const RAIL_ACTIVE = 'bg-accent-subtle text-accent'
const RAIL_DANGER = 'text-muted hover:bg-danger-subtle hover:text-danger'
const RAIL_NUM = 'absolute right-0 top-0 min-w-[14px] rounded-full border border-card bg-accent px-[3px] text-center font-mono text-2xs font-semibold leading-[12px] text-accent-fg'

const BTW_STATUS_LABEL: Record<string, string> = {
  closed: '未打开',
  starting: '正在启动',
  ready: '就绪',
  busy: '回答中',
  error: '出错',
}

/** Side-chat transcript roles, in the same words the terminal panel uses. */
const BTW_ROLE_LABEL: Record<string, string> = { user: '你', assistant: 'BTW', notice: '提示' }

const FEATURE_LABEL: Record<'btw' | 'schedule' | 'subagent' | 'commands' | 'prompts', string> = {
  btw: 'BTW',
  commands: '命令',
  schedule: '调度',
  subagent: '代理',
  prompts: '快捷',
}

/** One-tap quick prompts: long, frequently typed instructions sent to the session. */
const QUICK_PROMPTS: { id: string; label: string; text: string; icon: LineIconName; tone: string }[] = [
  { id: 'handoff', label: '交接存档', text: '帮我把目前的进展更新到相关的任务文档里（按 session-handoff 流程写一份交接摘要），我接下来要 clear context，会用新的 session 接着工作。', icon: 'send', tone: 'text-accent' },
  { id: 'wrap-up', label: '收尾自查 + 提交', text: '把这次会话的所有改动自 review 一遍：确认只包含本任务需要的文件、没有误伤无关改动，按 git 规范 commit（一次一个逻辑改动），然后告诉我提交了什么、还有什么没验证。', icon: 'checkCircle', tone: 'text-ok' },
  { id: 'commit-remote', label: '提交并同步远端', text: '把 pi-tsien-extension 和 pi-dashboard 两个仓库本地的改动都 commit：先各自检查 origin 有没有新提交，有就先 pull，再把本地改动 rebase 到远端之上；遇到 conflict 逐个分析，确认现有功能不会被破坏，最后告诉我每个仓库提交了什么、rebase 结果，以及冲突是怎么解决的。', icon: 'code', tone: 'text-accent' },
  { id: 'continue', label: '新 session 接续', text: '我要在这个目录接着上一个 session 工作：先读任务文档（目标、当前状态、下一步），告诉我你理解到的进展和待办，确认无误后继续。', icon: 'repeat', tone: 'text-warn' },
  { id: 'acceptance', label: '验收前完整检查', text: '这个任务准备验收了：对照验收标准逐条过一遍，该跑的测试/检查都跑掉，没验证的明确列出来，不要凭感觉说完成。', icon: 'search', tone: 'text-accent' },
  { id: 'report', label: '日报/周报素材', text: '汇总我最近在这个项目做了什么：完成了什么、卡在哪、下一步计划，用能直接贴进汇报的格式。', icon: 'edit', tone: 'text-ok' },
]

type FeatureKind = 'btw' | 'schedule' | 'subagent' | 'commands' | 'prompts'
const FEATURE_ICON: Record<FeatureKind, LineIconName> = { prompts: 'bolt', btw: 'bubble', schedule: 'clock', subagent: 'flow', commands: 'terminal' }
const ACTION_ICON = { interrupt: 'stop', goal: 'target', compact: 'compress', reload: 'refresh', clear: 'trash' } as const satisfies Record<string, LineIconName>

function Feature({ title, icon, count, children }: { title: string; icon: FeatureKind; count?: number; children: React.ReactNode }) {
  return <details className="group relative w-full shrink-0 [&>summary::-webkit-details-marker]:hidden">
    <summary className={`${RAIL_BUTTON} mx-auto cursor-pointer list-none ${RAIL_IDLE} group-open:bg-accent-subtle group-open:text-accent`} title={`${title}（${FEATURE_LABEL[icon]}）`} aria-label={title}>
      <LineIcon name={FEATURE_ICON[icon]} className="h-[18px] w-[18px]" />
      {count !== undefined && count > 0 && <span className={RAIL_NUM}>{count}</span>}
    </summary>
    <div className="absolute right-full top-0 z-40 mr-2 flex max-h-[70vh] w-[min(560px,calc(100vw-4rem))] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border py-0 pl-3.5 pr-2">
        <LineIcon name={FEATURE_ICON[icon]} className="h-4 w-4 text-accent" />
        <span className="flex-1 truncate text-body-s font-semibold text-text-strong">{title}</span>
        <button type="button" title="收起" aria-label={`收起${title}`} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-bg-hover hover:text-text" onClick={event => event.currentTarget.closest('details')?.removeAttribute('open')}>
          <LineIcon name="chevronRight" className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </div>
  </details>
}

/** Same dot language as the live-session status dots. */
const ACTION_DOT_CLASS: Record<'ok' | 'accent' | 'warn', string> = { ok: 'bg-ok', accent: 'bg-accent', warn: 'bg-warn' }

function SessionAction({ label, icon, disabled, danger, onClick, title, badge, dot, goalState }: { label: string; icon: keyof typeof ACTION_ICON; disabled?: boolean; danger?: boolean; onClick: () => void; title?: string; badge?: { text: string; tone: 'ok' | 'accent' | 'warn' }; dot?: { tone: 'ok' | 'accent' | 'warn'; pulse?: boolean; hint: string }; goalState?: 'active' | 'paused' | 'complete' }) {
  const badgeClass = badge?.tone === 'ok' ? 'bg-ok-subtle text-ok' : badge?.tone === 'warn' ? 'bg-warn-subtle text-warn' : 'bg-accent-subtle text-accent'
  const tip = title || label
  return <button type="button" onClick={onClick} disabled={disabled} title={tip === label ? label : `${label}：${tip}`} aria-label={tip} data-goal-state={goalState} className={`${RAIL_BUTTON} mx-auto ${danger ? RAIL_DANGER : RAIL_IDLE}`}>
    <LineIcon name={ACTION_ICON[icon]} className="h-[18px] w-[18px]" />
    {dot && <span className={`absolute right-[5px] top-[5px] h-[7px] w-[7px] rounded-full border-[1.5px] border-card ${ACTION_DOT_CLASS[dot.tone]} ${dot.pulse ? 'animate-pulse' : ''}`} title={dot.hint} aria-hidden="true" />}
    {badge && <span className={`absolute -right-1 -top-1 rounded-full px-1 font-mono text-2xs font-semibold leading-[14px] ${badgeClass}`}>{badge.text}</span>}
  </button>
}

export default function LiveSessionFeatures({ features, busy, cwd, status, compacting = false, onFileOpen, onOpenBtw, onCloseBtw, onBtwSubmit, onBtwAbort, onBtwRefreshParent, onOpenWorkflow, goal, goalLoaded = true, onGoalSync, goalBusy = false, onCompact, onClear, onReload, onAbort, onSendPrompt }: {
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
  /** Current goal anchor for this session, reactive from its own timeline. */
  goal?: SessionGoalSummary | null
  /** False while the session timeline has not loaded yet. */
  goalLoaded?: boolean
  /** Ask the agent to refresh the checklist (live sessions only). */
  onGoalSync?: () => void
  goalBusy?: boolean
  /** True while a requested compaction has not landed on disk yet. */
  compacting?: boolean
  onCompact: () => void
  onClear: () => void
  onReload: () => void
  onAbort: () => void
  /** Send one of the quick prompts to the session as a normal user message. */
  onSendPrompt: (text: string) => void
}) {
  const btw = record(features.btw)
  const schedule = record(features.schedule)
  const background = record(features['background-commands'])
  const subagent = record(features['subagent-workflow'])
  const projectedSubagents = projectSubagentSnapshot({ conversations: subagent?.conversations, workflows: subagent?.workflows }, 'live-session')
  const conversations = projectedSubagents.topLevelConversations
  const workflows = projectedSubagents.workflows
  const projectionStatus = (value: unknown) => ({ active: '工作中', attention: '需处理', completed: '已完成', stopped: '已停止', unknown: '未知' })[projectStatus(value)]
  const tasks = Array.isArray(schedule?.tasks) ? schedule.tasks.map(record).filter((task): task is RecordValue => !!task) : []
  const backgroundTasks = Array.isArray(background?.tasks) ? background.tasks.map(record).filter((task): task is RecordValue => !!task) : []
  const conversation = Array.isArray(btw?.conversation) ? btw.conversation.map(record).filter((entry): entry is RecordValue => !!entry) : []
  const [btwDraft, setBtwDraft] = useState('')
  const [btwNotice, setBtwNotice] = useState('')
  const btwStatus = String(btw?.status || 'closed')
  const btwOpen = btwStatus === 'ready' || btwStatus === 'busy'
  const btwStarting = btwStatus === 'starting'
  const btwBusy = btwStatus === 'busy'
  const btwActivity = typeof btw?.activity === 'string' ? btw.activity : ''
  const btwError = typeof btw?.error === 'string' ? btw.error : ''
  const btwModel = typeof btw?.model === 'string' ? btw.model : ''
  const btwParentMessages = Number(btw?.parentMessageCount || 0)
  /* Asking is possible while the main session works: the side chat runs in its own
     session, so the only things that gate the composer are its own startup and its
     own answer in flight. */
  const btwLocked = btwStarting
  const canSendBtw = !!btwDraft.trim() && btwOpen && !btwLocked && !btwBusy
  const sendBtw = () => {
    const text = btwDraft.trim()
    if (!text || !btwOpen || btwLocked) return
    if (btwBusy) {
      setBtwNotice('BTW 正在回答：先「中止」或等它答完再问下一句')
      return
    }
    setBtwDraft('')
    onBtwSubmit(text)
  }
  const copyBtwAnswer = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setBtwNotice('已复制这个回答的原文')
    } catch {
      setBtwNotice('浏览器拒绝了复制，请手动选中文本复制')
    }
  }
  useEffect(() => {
    if (!btwNotice) return
    const timer = window.setTimeout(() => setBtwNotice(''), 3000)
    return () => window.clearTimeout(timer)
  }, [btwNotice])
  /* Follow the newest exchange, but never yank the view while the user reads back. */
  const btwTranscript = useRef<HTMLDivElement | null>(null)
  const btwPinned = useRef(true)
  useEffect(() => {
    const node = btwTranscript.current
    if (!node || !btwPinned.current) return
    node.scrollTop = node.scrollHeight
  }, [conversation.length, btwActivity])
  const [filesOpen, setFilesOpen] = useState(false)
  const [goalOpen, setGoalOpen] = useState(false)
  const goalProgress = goalProgressOf(goal)
  /* The goal keeps working in the background (the extension re-queues it on an
     interval), so its rail button carries the state: an active goal pulses,
     paused/complete hold still. A goal without checklist items still shows up —
     otherwise the button looks dead while the loop is actually driving the session. */
  const goalStatusLabel = goalProgress?.status === 'active' ? '进行中' : goalProgress?.status === 'paused' ? '已暂停' : goalProgress?.status === 'complete' ? '已完成' : undefined
  const goalTitle = goalProgress
    ? [
      `任务锚点：${goalStatusLabel ?? (goalProgress.total > 0 ? `${goalProgress.done}/${goalProgress.total} 完成` : '已设置')}`,
      goalStatusLabel && goalProgress.total > 0 ? `${goalProgress.done}/${goalProgress.total} 完成` : undefined,
      goalProgress.needsUser > 0 ? `${goalProgress.needsUser} 项需要你处理` : undefined,
      goalProgress.stale ? '清单可能过期' : undefined,
    ].filter((part): part is string => !!part).join('｜')
    : '查看当前 session 的目标、工作项和阻塞项'
  const goalDot = goalProgress?.status === 'active'
    ? { tone: 'accent' as const, pulse: true, hint: '目标进行中：会话运行时会按间隔自动继续推进' }
    : goalProgress?.status === 'paused'
      ? { tone: 'warn' as const, pulse: false, hint: '目标已暂停：不会自动继续推进' }
      : goalProgress?.status === 'complete'
        ? { tone: 'ok' as const, pulse: false, hint: '目标已完成' }
        : undefined
  const goalBadge = goalProgress && goalProgress.total > 0
    ? {
      text: `${goalProgress.done}/${goalProgress.total}`,
      tone: goalProgress.needsUser > 0 || goalProgress.stale || goalProgress.status === 'paused'
        ? 'warn' as const
        : goalProgress.done === goalProgress.total ? 'ok' as const : 'accent' as const,
    }
    : goalProgress?.status === 'active' || goalProgress?.status === 'paused' || goalProgress?.status === 'complete'
      ? { text: goalStatusLabel as string, tone: goalProgress.status === 'paused' ? 'warn' as const : goalProgress.status === 'complete' ? 'ok' as const : 'accent' as const }
      : undefined

  return <aside className="relative z-30 flex w-12 shrink-0 flex-col items-center gap-0.5 overflow-visible border-l border-border bg-card py-2">
    {/* 会话操作 */}
      <SessionAction
        label="目标"
        icon="goal"
        disabled={busy || status === 'reconnecting'}
        onClick={() => setGoalOpen(true)}
        title={goalTitle}
        badge={goalBadge}
        dot={goalDot}
        goalState={goalProgress?.status}
      />
      <SessionAction label={compacting ? '压缩中…' : '压缩'} icon="compact" disabled={busy || compacting || status !== 'idle'} onClick={onCompact} title={compacting ? '压缩仍在后台进行，等完成后再试' : '压缩当前会话上下文，释放 token'} />
      <SessionAction label="重载" icon="reload" disabled={busy} onClick={onReload} title="重载扩展 / 技能 / 提示词 / 主题" />
    <div className="my-1.5 h-px w-5 bg-border" />

    {/* 工具面板 */}
    {/* The main Agent entry already lives in the navigation sidebar; do not repeat it in this rail. */}
    <SupervisorNotificationsSidebarButton className={`${RAIL_BUTTON} ${RAIL_IDLE}`} />
    <button type="button" onClick={() => setFilesOpen(value => !value)} className={`${RAIL_BUTTON} mx-auto ${filesOpen ? RAIL_ACTIVE : RAIL_IDLE}`} title="文件：浏览当前工作目录" aria-label="浏览当前工作目录">
      <LineIcon name="folder" className="h-[18px] w-[18px]" />
    </button>
    {filesOpen && <>
      <div className="fixed inset-0 z-30 bg-black/10 backdrop-blur-[1px]" onClick={() => setFilesOpen(false)} aria-hidden="true" />
      <div className="absolute right-full top-2 z-40 mr-3 h-[min(78vh,720px)] w-[min(620px,calc(100vw-3.5rem))] overflow-hidden rounded-xl border border-border bg-card shadow-2xl shadow-black/30 ring-1 ring-white/5">
        <FileBrowser startPath={cwd} onFileOpen={onFileOpen} onClose={() => setFilesOpen(false)} />
      </div>
    </>}

    <Feature title="快捷短语" icon="prompts">
      <div className="space-y-2">
        {QUICK_PROMPTS.map(p => (
          <button
            key={p.id}
            type="button"
            disabled={busy}
            title={p.text}
            className="flex w-full items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition hover:border-accent hover:bg-bg-hover disabled:opacity-50"
            onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onSendPrompt(p.text) }}
          >
            <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-hover ${p.tone}`}><LineIcon name={p.icon} className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body-s font-semibold text-text-strong">{p.label}</span>
              <span className="mt-0.5 line-clamp-2 block text-meta text-muted">{p.text}</span>
            </span>
          </button>
        ))}
        <div className="px-1 pt-1 text-2xs text-muted">点一条即作为你的消息发送给当前会话。</div>
      </div>
    </Feature>

    <Feature title="BTW" icon="btw" count={conversation.length}>
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          {btwBusy && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden="true" />}
          <span className="truncate">状态：{BTW_STATUS_LABEL[btwStatus] ?? btwStatus}{btwActivity ? ` · ${btwActivity}` : ''}</span>
        </span>
        <button type="button" disabled={btwStarting} onClick={onBtwRefreshParent} className="ml-auto shrink-0 text-xs text-muted rounded px-2 py-1 hover:bg-bg-hover disabled:opacity-50" title="立刻把主会话当前的上下文重新同步给 BTW（每次提问前也会自动同步）">同步上下文</button>
        {btwOpen
          ? <button type="button" onClick={onCloseBtw} className="shrink-0 text-xs text-muted rounded px-2 py-1 hover:bg-bg-hover">关闭 BTW</button>
          : <button type="button" disabled={btwStarting} onClick={onOpenBtw} className="shrink-0 text-xs text-accent-fg bg-accent rounded px-2 py-1 disabled:opacity-50">{btwStarting ? '正在打开…' : '打开 BTW'}</button>}
      </div>
      <div className="mt-1 truncate text-2xs text-muted" title={btwModel ? `只读旁聊 · ${btwModel}` : '只读旁聊'}>
        只读 · {btwModel || '模型未启动'}{btwParentMessages > 0 ? ` · 已同步主上下文 ${btwParentMessages} 条` : ''} · 每次提问前自动同步
      </div>
      {btwError && <div className="mt-2 rounded bg-danger-subtle px-2 py-1 text-xs text-danger" role="alert">BTW 出错：{btwError}</div>}
      {btwNotice && <div className="mt-1 text-2xs text-muted" role="status">{btwNotice}</div>}
      {!btwOpen && !btwStarting && !btwError && <div className="mt-2 text-xs text-muted">
        {conversation.length > 0
          ? `已保留 ${conversation.length} 条记录：在下面接着问，或点「打开 BTW」把面板打开。`
          : 'BTW 未打开：在下面输入问题发送即可启动一个只读旁聊（不会改动主会话）。'}
      </div>}
      {conversation.length === 0 && (btwOpen || btwStarting)
        ? <div className="mt-2 text-xs text-muted">{btwStarting ? 'BTW 正在启动…' : 'BTW 已就绪：直接在下面提问，它只读、不影响主会话。'}</div>
        : conversation.length > 0 && <div
          ref={btwTranscript}
          onScroll={event => {
            const node = event.currentTarget
            btwPinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60
          }}
          className="mt-2 max-h-[40vh] space-y-1.5 overflow-y-auto overscroll-contain pr-1"
          aria-label="BTW 对话记录"
        >
          {conversation.map((entry, index) => {
            const role = String(entry.role || 'notice')
            const text = String(entry.text || '')
            const streaming = btwBusy && index === conversation.length - 1 && role === 'assistant' && !text
            return <div key={index} className={`rounded px-2.5 py-1.5 text-xs ${role === 'user' ? 'bg-accent-subtle' : role === 'notice' ? 'bg-warn-subtle' : 'bg-bg-hover'}`}>
              <div className="mb-1 flex items-center gap-2 text-2xs text-muted">
                <span className={role === 'notice' ? 'text-warn' : ''}>{BTW_ROLE_LABEL[role] ?? role}</span>
                {role === 'assistant' && text && <button type="button" onClick={() => void copyBtwAnswer(text)} className="ml-auto rounded px-1 hover:bg-bg hover:text-text" title="复制这个回答的原文" aria-label="复制 BTW 这个回答">复制</button>}
              </div>
              {streaming ? <span className="text-muted">正在生成…</span> : <MarkdownRenderer content={text} />}
            </div>
          })}
        </div>}
      <div className="mt-2 flex items-end gap-1.5">
        <textarea
          value={btwDraft}
          rows={2}
          disabled={!btwOpen || btwStarting}
          onChange={event => setBtwDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendBtw() } }}
          placeholder={btwBusy ? 'BTW 正在回答；可先点「中止」' : btwStarting ? '正在启动只读旁聊…' : '问 BTW 一个问题（Enter 发送，Shift+Enter 换行）'}
          aria-label="BTW 提问"
          className="min-h-[40px] flex-1 resize-none rounded-md bg-bg-hover px-2.5 py-1.5 text-xs text-text outline-none placeholder:text-muted disabled:opacity-50"
        />
        {btwBusy
          ? <button type="button" onClick={onBtwAbort} className="h-[26px] shrink-0 rounded-md bg-danger-subtle px-2.5 text-xs text-danger hover:bg-danger hover:text-danger-fg">中止</button>
          : <button type="button" disabled={!canSendBtw} onClick={sendBtw} className="h-[26px] shrink-0 rounded-md bg-accent px-2.5 text-xs text-accent-fg disabled:opacity-50">发送</button>}
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
        {workflows.map((item, index) => { const status = projectStatus(item.status); return <details key={stableTaskId(item, index)} open={!isCollapsedByDefault(item.status) || status === 'attention'} className={`rounded border ${status === 'attention' ? 'border-danger bg-danger-subtle' : 'border-border bg-card'}`}><summary className="cursor-pointer list-none p-2 text-xs"><span className="font-mono text-accent">workflow</span> · {textValue(item.label, textValue(item.id, '未命名'))}<span className={`float-right ${status === 'attention' ? 'text-danger' : 'text-muted'}`}>{projectionStatus(item.status)}</span></summary><button type="button" onClick={() => onOpenWorkflow(item)} className="border-t border-border px-2 py-1.5 text-2xs text-accent hover:underline">打开 Workflow 详情</button></details> })}
        {conversations.map((item, index) => { const status = projectStatus(item.status); return <div key={stableTaskId(item, index)} className={`rounded border p-2 text-xs ${status === 'attention' ? 'border-danger bg-danger-subtle text-danger' : 'border-border bg-card'}`}><span className="font-mono text-accent">subagent</span> · {textValue(item.label, textValue(item.id, '未命名'))}<span className="float-right">{projectionStatus(item.status)}</span></div> })}
      </div>}
    </Feature>

    <div className="flex-1" />
      {/* Enabled while the session works: `/clear` waits for idle itself, and the old
          `status !== 'idle'` gate is what made a click vanish without a word. */}
      {/* One click acts: the two-step arm was only a workaround for browsers that
          swallow `window.confirm`, and it caused its own failures (a 5s window, a
          banner that outlived it, a press that vanished while the session was busy).
          The action is recoverable — the old conversation stays in its file. */}
      {status === 'running' && <SessionAction label="中止" icon="interrupt" danger disabled={busy} onClick={onAbort} title="中止当前回合：Pi 会停下来，已完成的步骤保留（不是可恢复的暂停）" />}
      <SessionAction label="清空" icon="clear" danger disabled={busy} onClick={onClear} title={status !== 'idle' ? '点击即开始新的空会话（会等这一轮结束后自动切换；旧对话保留在文件中）' : '点击即开始新的空会话（旧对话保留在文件中）'} />

    {goalOpen && <GoalAnchorDialog
      goal={goal ?? null}
      loaded={goalLoaded}
      mode="live"
      busy={goalBusy}
      onClose={() => setGoalOpen(false)}
      {...(onGoalSync ? { onSync: onGoalSync } : {})}
    />}
  </aside>
}
