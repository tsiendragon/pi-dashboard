import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { agentDir } from './env-file.js'
import { dateInTimezone } from './usage-ledger.js'
import type { ChurnDay, ChurnReport, ChurnTotals } from '../shared/src/churn.js'

/** Extensions counted as code; everything else lands in the docs/data bucket. */
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.swift', '.scala', '.rb', '.php', '.lua', '.pl',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.m', '.mm',
  '.sh', '.bash', '.zsh', '.sql', '.css', '.scss', '.less', '.html', '.htm',
  '.vue', '.svelte', '.ipynb', '.proto', '.graphql', '.ex', '.exs',
])

const TOOL_CALL_MARKER = '"name":"edit"'
const TOOL_CALL_MARKER_ALT = '"name":"write"'

interface MutableDay extends ChurnTotals {
  /** YYYY-MM-DD bucket key. */
  date: string
  paths: Set<string>
}

interface FileChurn {
  size: number
  mtimeMs: number
  timezone: string
  days: Map<string, MutableDay>
}

export interface CodeChurnOptions {
  /** Root holding one directory per project with `*.jsonl` session files. */
  sessionsRoot?: string
  timezone?: string
}

function defaultTimezone(): string {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function lineCount(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) return 0
  let lines = 1
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1
  }
  return lines
}

function isCodePath(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase())
}

function emptyDay(): Omit<MutableDay, 'date'> {
  return {
    added: 0,
    removed: 0,
    codeAdded: 0,
    codeRemoved: 0,
    docAdded: 0,
    docRemoved: 0,
    calls: 0,
    files: 0,
    paths: new Set<string>(),
  }
}

function totalsOf(day: MutableDay): ChurnTotals {
  return {
    added: day.added,
    removed: day.removed,
    codeAdded: day.codeAdded,
    codeRemoved: day.codeRemoved,
    docAdded: day.docAdded,
    docRemoved: day.docRemoved,
    calls: day.calls,
    files: day.paths.size,
  }
}

function validMonth(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  return !!match && Number(match[2]) >= 1 && Number(match[2]) <= 12
}

function monthBounds(month: string): { start: number; end: number } {
  const [year, value] = month.split('-').map(Number)
  const start = new Date(year, value - 1, 1).getTime()
  const end = new Date(year, value, 1).getTime()
  // Session files are filtered by mtime; a file touched on the first day of the
  // next month can still hold entries from this one, so keep one day of slack.
  return { start: start - 86_400_000, end: end + 86_400_000 }
}

function timestampOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Counts the lines agents add or rewrite through `edit`/`write` tool calls,
 * grouped per day. Session files are the source of truth so the numbers match
 * what was actually written, including work that never reached a commit.
 */
export class CodeChurnLedger {
  readonly sessionsRoot: string
  readonly timezone: string
  private readonly files = new Map<string, FileChurn>()
  private readonly refreshing = new Map<string, Promise<void>>()
  private startPromise?: Promise<void>

  constructor(options: CodeChurnOptions = {}) {
    this.sessionsRoot = options.sessionsRoot
      ?? process.env.PI_DASH_SESSIONS_DIR?.trim()
      ?? join(agentDir(), 'sessions')
    this.timezone = options.timezone ?? defaultTimezone()
  }

  /** Scans the current month once in the background so the first page load is warm. */
  start(): Promise<void> {
    if (!this.startPromise) {
      const now = new Date()
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      this.startPromise = this.refresh(month, this.timezone).catch(() => undefined)
    }
    return this.startPromise
  }

  async getReport(month: string, timezone = this.timezone): Promise<ChurnReport> {
    if (!validMonth(month)) throw new Error('month must use YYYY-MM format')
    const key = `${month}|${timezone}`
    const pending = this.refreshing.get(key)
    if (!pending) void this.refresh(month, timezone).catch(() => undefined)
    return this.buildReport(month, timezone, this.refreshing.has(key))
  }

  private buildReport(month: string, timezone: string, scanning: boolean): ChurnReport {
    const merged = new Map<string, MutableDay>()
    let filesScanned = 0
    for (const entry of this.files.values()) {
      if (entry.timezone !== timezone) continue
      filesScanned += 1
      for (const [date, day] of entry.days) {
        if (!date.startsWith(`${month}-`)) continue
        const target = merged.get(date) ?? { ...emptyDay(), date }
        target.added += day.added
        target.removed += day.removed
        target.codeAdded += day.codeAdded
        target.codeRemoved += day.codeRemoved
        target.docAdded += day.docAdded
        target.docRemoved += day.docRemoved
        target.calls += day.calls
        for (const path of day.paths) target.paths.add(path)
        merged.set(date, target)
      }
    }
    const [year, value] = month.split('-').map(Number)
    const dayCount = new Date(year, value, 0).getDate()
    const days: ChurnDay[] = []
    const total: ChurnTotals = {
      added: 0, removed: 0, codeAdded: 0, codeRemoved: 0, docAdded: 0, docRemoved: 0, calls: 0, files: 0,
    }
    const allPaths = new Set<string>()
    for (let dayIndex = 1; dayIndex <= dayCount; dayIndex += 1) {
      const date = `${month}-${String(dayIndex).padStart(2, '0')}`
      const day = merged.get(date) ?? { ...emptyDay(), date }
      days.push({ date, ...totalsOf(day) })
      total.added += day.added
      total.removed += day.removed
      total.codeAdded += day.codeAdded
      total.codeRemoved += day.codeRemoved
      total.docAdded += day.docAdded
      total.docRemoved += day.docRemoved
      total.calls += day.calls
      for (const path of day.paths) allPaths.add(path)
    }
    total.files = allPaths.size
    return { month, timezone, scanning, filesScanned, days, total }
  }

  private async refresh(month: string, timezone: string): Promise<void> {
    const key = `${month}|${timezone}`
    const existing = this.refreshing.get(key)
    if (existing) return existing
    const run = this.refreshNow(month, timezone).finally(() => {
      if (this.refreshing.get(key) === run) this.refreshing.delete(key)
    })
    this.refreshing.set(key, run)
    return run
  }

  private async refreshNow(month: string, timezone: string): Promise<void> {
    const { start, end } = monthBounds(month)
    const seen = new Set<string>()
    let projectDirectories: string[]
    try {
      projectDirectories = (await readdir(this.sessionsRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => join(this.sessionsRoot, entry.name))
    } catch {
      return
    }
    for (const directory of projectDirectories) {
      let names: string[]
      try {
        names = await readdir(directory)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const path = join(directory, name)
        let stats
        try {
          stats = await stat(path)
        } catch {
          continue
        }
        if (stats.mtimeMs < start || stats.mtimeMs > end) continue
        seen.add(path)
        const cached = this.files.get(path)
        if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.timezone === timezone) continue
        try {
          this.files.set(path, await this.parseFile(path, timezone, stats.size, stats.mtimeMs))
        } catch {
          continue
        }
      }
    }
    for (const path of [...this.files.keys()]) {
      if (this.files.get(path)?.timezone !== timezone) continue
      if (!seen.has(path)) this.files.delete(path)
    }
  }

  private async parseFile(path: string, timezone: string, size: number, mtimeMs: number): Promise<FileChurn> {
    const days = new Map<string, MutableDay>()
    // A rewrite replaces the whole file, so compare with the last rewritten
    // length instead of counting the entire content as new every time.
    const rewrittenLines = new Map<string, number>()
    const bucket = (date: string): MutableDay => {
      const day = days.get(date) ?? { ...emptyDay(), date }
      days.set(date, day)
      return day
    }
    const input = createReadStream(path, { encoding: 'utf8' })
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (!line.includes(TOOL_CALL_MARKER) && !line.includes(TOOL_CALL_MARKER_ALT)) continue
        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const message = entry.message as Record<string, unknown> | undefined
        if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue
        const at = timestampOf(message.timestamp) ?? timestampOf(entry.timestamp) ?? Date.now()
        const date = dateInTimezone(at, timezone)
        for (const value of message.content as unknown[]) {
          if (!value || typeof value !== 'object') continue
          const call = value as Record<string, unknown>
          if (call.type !== 'toolCall') continue
          const name = call.name
          const args = (call.arguments ?? {}) as Record<string, unknown>
          const filePath = typeof args.path === 'string' ? args.path : ''
          let added = 0
          let removed = 0
          if (name === 'edit' && Array.isArray(args.edits)) {
            for (const rawEdit of args.edits) {
              if (!rawEdit || typeof rawEdit !== 'object') continue
              const edit = rawEdit as Record<string, unknown>
              added += lineCount(edit.newText)
              removed += lineCount(edit.oldText)
            }
          } else if (name === 'write' && typeof args.content === 'string') {
            const total = lineCount(args.content)
            const previous = rewrittenLines.get(filePath)
            rewrittenLines.set(filePath, total)
            added = previous === undefined ? total : Math.max(0, total - previous)
            removed = previous === undefined ? 0 : Math.max(0, previous - total)
          } else {
            continue
          }
          if (added === 0 && removed === 0) continue
          const day = bucket(date)
          day.added += added
          day.removed += removed
          day.calls += 1
          if (filePath) day.paths.add(filePath)
          if (isCodePath(filePath)) {
            day.codeAdded += added
            day.codeRemoved += removed
          } else {
            day.docAdded += added
            day.docRemoved += removed
          }
        }
      }
    } finally {
      lines.close()
      input.destroy()
    }
    return { size, mtimeMs, timezone, days }
  }
}