import { useEffect, useMemo, useState } from 'react'

/**
 * Running-command chips shown on the right of the composer's activity row.
 *
 * Sources:
 * - foreground tool calls that carry a shell `command` (from the transcript's tool states);
 * - the `background-commands` feature snapshot, which also mirrors foreground bash
 *   runs (`mode: 'foreground'` + `toolCallId`) with cwd / start time / output tail.
 *
 * Visibility rule (keeps the row short): anything still running is always shown;
 * finished commands are only shown when they belong to the latest round, i.e. they
 * started (foreground) or ended (background) after the latest user message.
 */

export type CommandChipState = 'running' | 'done' | 'failed'

export interface CommandChip {
  key: string
  kind: 'foreground' | 'background'
  state: CommandChipState
  label: string
  command: string
  cwd?: string
  startedAt?: number
  endedAt?: number
  output: string
  taskId?: string
  toolCallId?: string
  error?: string
}

export interface ForegroundToolInput {
  toolCallId: string
  toolName?: string
  command?: string
  started: boolean
  called: boolean
  ended: boolean
  abandoned: boolean
  isError?: boolean
  partialText?: string
  executionResult?: string
  errorText?: string
  result?: { text: string; isError?: boolean }
  startedAtMs?: number
  endedAtMs?: number
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

const RUNNING_TASK = new Set(['running', 'starting', 'queued'])

export function collectCommandChips(tools: Iterable<ForegroundToolInput>, features: Record<string, unknown>, latestUserAt?: number): CommandChip[] {
  const chips: CommandChip[] = []
  const tasks = (Array.isArray(record(features['background-commands'])?.tasks) ? record(features['background-commands'])!.tasks as unknown[] : [])
    .map(record).filter((task): task is RecordValue => !!task)
  const mirrored = new Set(tasks.map(task => str(task.toolCallId)).filter((id): id is string => !!id))
  const inRound = (at?: number) => latestUserAt === undefined || (at !== undefined && at >= latestUserAt)

  for (const tool of tools) {
    if (!tool.command || mirrored.has(tool.toolCallId)) continue
    const running = (tool.started || tool.called) && !tool.ended && !tool.abandoned && !tool.result
    if (!running && !inRound(tool.startedAtMs)) continue
    if (!running && !tool.started && !tool.result && !tool.ended) continue
    const failed = !running && (tool.abandoned || tool.isError === true || tool.result?.isError === true)
    chips.push({
      key: `tool:${tool.toolCallId}`,
      kind: 'foreground',
      state: running ? 'running' : failed ? 'failed' : 'done',
      label: compact(tool.command),
      command: tool.command,
      startedAt: tool.startedAtMs,
      endedAt: running ? undefined : tool.endedAtMs,
      output: tool.partialText || tool.result?.text || tool.executionResult || '',
      toolCallId: tool.toolCallId,
      error: failed ? tool.errorText : undefined,
    })
  }

  for (const task of tasks) {
    const status = str(task.status) || 'unknown'
    const running = RUNNING_TASK.has(status)
    const endedAt = num(task.endedAt)
    if (!running && !inRound(endedAt ?? num(task.startedAt))) continue
    const exitCode = task.exitCode
    const failed = !running && (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'killed' || (typeof exitCode === 'number' && exitCode !== 0) || !!str(task.error))
    const taskId = str(task.taskId) || str(task.id) || 'background'
    const command = str(task.command) || str(task.title) || '后台命令'
    const foreground = task.mode === 'foreground' && running
    chips.push({
      key: `task:${taskId}`,
      kind: foreground ? 'foreground' : 'background',
      state: running ? 'running' : failed ? 'failed' : 'done',
      label: compact(str(task.title) && task.title !== command ? String(task.title) : command),
      command,
      cwd: str(task.cwd),
      startedAt: num(task.startedAt),
      endedAt,
      output: (str(task.outputTail) || '') + (task.outputTruncated === true ? '\n… 仅显示末尾输出' : ''),
      taskId,
      toolCallId: str(task.toolCallId),
      error: failed ? (str(task.error) || str(task.exitReason) || (typeof exitCode === 'number' ? `退出码 ${exitCode}` : undefined)) : undefined,
    })
  }

  const rank = (chip: CommandChip) => (chip.state === 'running' ? 0 : 2) + (chip.kind === 'foreground' ? 0 : 1)
  return chips.sort((a, b) => rank(a) - rank(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

export function formatCommandElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  if (seconds < 60) return `${seconds}秒`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
  return `${Math.floor(seconds / 3_600)}时${Math.floor((seconds % 3_600) / 60)}分`
}

function tagText(chip: CommandChip): string {
  if (chip.state === 'done') return '已完成'
  if (chip.state === 'failed') return '失败'
  return chip.kind === 'foreground' ? '前台' : '后台'
}

function tagClass(chip: CommandChip): string {
  if (chip.state === 'done') return 'bg-ok-subtle text-ok'
  if (chip.state === 'failed') return 'bg-danger-subtle text-danger'
  return chip.kind === 'foreground' ? 'bg-accent-subtle text-accent' : 'bg-warn-subtle text-warn'
}

function elapsedOf(chip: CommandChip, now: number): string | undefined {
  if (chip.startedAt === undefined) return undefined
  return formatCommandElapsed((chip.endedAt ?? now) - chip.startedAt)
}

export default function LiveCommandChips({ chips, onMoveToBackground }: { chips: CommandChip[]; onMoveToBackground?: (toolCallId: string) => Promise<void> | void }) {
  const [selectedKey, setSelectedKey] = useState<string>()
  const [now, setNow] = useState(() => Date.now())
  const [moving, setMoving] = useState<string>()
  const anyRunning = chips.some(chip => chip.state === 'running')
  useEffect(() => {
    if (!anyRunning) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [anyRunning])
  const selected = useMemo(() => chips.find(chip => chip.key === selectedKey), [chips, selectedKey])
  useEffect(() => {
    if (!selected) return undefined
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedKey(undefined) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selected])

  if (chips.length === 0) return null
  const canMove = (chip: CommandChip) => chip.kind === 'foreground' && chip.state === 'running' && !!chip.toolCallId && !!onMoveToBackground
  const moveSelected = async (chip: CommandChip) => {
    if (!chip.toolCallId || !onMoveToBackground) return
    setMoving(chip.key)
    try { await onMoveToBackground(chip.toolCallId) } finally { setMoving(undefined) }
  }

  return <>
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="list" aria-label="本轮命令">
      {chips.map(chip => {
        const elapsed = elapsedOf(chip, now)
        return <button
          key={chip.key}
          type="button"
          role="listitem"
          onClick={() => setSelectedKey(chip.key)}
          aria-label={`${tagText(chip)}命令：${chip.label}`}
          title={chip.command}
          className={`flex max-w-[min(280px,60vw)] shrink-0 items-center gap-1.5 rounded-full border border-border bg-bg px-2 py-0.5 text-2xs text-text hover:border-accent hover:bg-accent-subtle ${chip.state === 'running' ? '' : 'opacity-60'}`}
        >
          <span className={`shrink-0 rounded px-1.5 ${tagClass(chip)}`}>{tagText(chip)}</span>
          <span className="min-w-0 truncate font-mono">{chip.label}</span>
          {elapsed && <span className="shrink-0 text-muted">{elapsed}</span>}
        </button>
      })}
    </div>
    {selected && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 p-4" role="presentation" onClick={() => setSelectedKey(undefined)}>
      <section className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl" role="dialog" aria-modal="true" aria-label="命令详情" onClick={event => event.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-border bg-bg-elevated px-3 py-2">
          <span className={`shrink-0 rounded px-1.5 text-2xs ${tagClass(selected)}`}>{tagText(selected)}</span>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text-strong">{selected.kind === 'foreground' ? '前台命令' : '后台命令'}{selected.taskId ? ` · ${selected.taskId}` : ''}</span>
          <button type="button" onClick={() => setSelectedKey(undefined)} className="shrink-0 rounded border border-border bg-bg px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent">关闭</button>
        </header>
        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 px-3 py-2 text-xs">
          <dt className="text-muted">命令</dt><dd className="m-0 whitespace-pre-wrap break-all font-mono text-text">{selected.command}</dd>
          {selected.cwd && <><dt className="text-muted">目录</dt><dd className="m-0 break-all font-mono text-text">{selected.cwd}</dd></>}
          {elapsedOf(selected, now) && <><dt className="text-muted">{selected.state === 'running' ? '已运行' : '耗时'}</dt><dd className="m-0 text-text">{elapsedOf(selected, now)}</dd></>}
          {selected.error && <><dt className="text-muted">错误</dt><dd className="m-0 whitespace-pre-wrap break-all text-danger">{selected.error}</dd></>}
        </dl>
        <pre className="m-0 min-h-24 flex-1 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-bg p-3 font-mono text-xs leading-5 text-text">{selected.output || (selected.state === 'running' ? '等待输出…' : '（无输出）')}</pre>
        {canMove(selected) && <footer className="flex items-center gap-3 border-t border-border px-3 py-2">
          <span className="min-w-0 flex-1 text-2xs text-muted">转到后台后命令继续运行、不重启，Pi 不再等它，可以接着做别的；结束时会通知 Pi。</span>
          <button type="button" disabled={moving === selected.key} onClick={() => { void moveSelected(selected) }} className="shrink-0 rounded border border-accent bg-accent px-3 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50">{moving === selected.key ? '转移中…' : '转到后台'}</button>
        </footer>}
      </section>
    </div>}
  </>
}
