import { useEffect, useMemo, useState } from 'react'
import CommandDetailDialog from './CommandDetailDialog'

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

/** 快照里这些状态都算“还在跑”。 */
export const RUNNING_COMMAND_TASK = new Set(['running', 'starting', 'queued'])

/** `background-commands` 快照里的任务列表；活动视图也要用它认“这条已经在后台了”。 */
export function backgroundTasks(features: Record<string, unknown>): RecordValue[] {
  const tasks = record(features['background-commands'])?.tasks
  return Array.isArray(tasks) ? tasks.map(record).filter((task): task is RecordValue => !!task) : []
}

export function collectCommandChips(tools: Iterable<ForegroundToolInput>, features: Record<string, unknown>, latestUserAt?: number): CommandChip[] {
  const chips: CommandChip[] = []
  const tasks = backgroundTasks(features)
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
    const running = RUNNING_COMMAND_TASK.has(status)
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
  const anyRunning = chips.some(chip => chip.state === 'running')
  useEffect(() => {
    if (!anyRunning) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [anyRunning])
  const selected = useMemo(() => chips.find(chip => chip.key === selectedKey), [chips, selectedKey])

  if (chips.length === 0) return null
  const canMove = (chip: CommandChip) => chip.kind === 'foreground' && chip.state === 'running' && !!chip.toolCallId && !!onMoveToBackground

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
    {selected && <CommandDetailDialog
      detail={{
        tag: { text: tagText(selected), className: tagClass(selected) },
        title: `${selected.kind === 'foreground' ? '前台命令' : '后台命令'}${selected.taskId ? ` · ${selected.taskId}` : ''}`,
        command: selected.command,
        ...(selected.cwd ? { cwd: selected.cwd } : {}),
        timeLabel: selected.state === 'running' ? '已运行' : '耗时',
        ...(elapsedOf(selected, now) ? { time: elapsedOf(selected, now) as string } : {}),
        ...(selected.error ? { error: selected.error } : {}),
        output: selected.output,
        running: selected.state === 'running',
        ...(canMove(selected) ? { onMoveToBackground: () => onMoveToBackground?.(selected.toolCallId as string) } : {}),
      }}
      onClose={() => setSelectedKey(undefined)}
    />}
  </>
}
