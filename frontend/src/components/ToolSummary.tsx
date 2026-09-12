export type ToolSummaryStatus = 'pending' | 'running' | 'success' | 'error'

function timestampValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function formatToolTimestamp(value: unknown): string {
  const numeric = timestampValue(value)
  if (numeric === undefined) return ''
  const date = new Date(numeric)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  const hour24 = date.getHours()
  const period = hour24 >= 12 ? 'pm' : 'am'
  const hour12 = hour24 % 12 || 12
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hour12}:${pad(date.getMinutes())}${period}`
}

function compact(value: string, max = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

function displayToolName(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}

function parsedArguments(args?: string): Record<string, unknown> | undefined {
  if (!args) return undefined
  try {
    const value: unknown = JSON.parse(args)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function commandLabel(command: string): string {
  return compact(command.split(/\s+/).slice(0, 2).join(' '), 42)
}

function prefixedCommand(toolName: string, value: string): string {
  const normalizedName = toolName.trim()
  if (!normalizedName) return value
  const firstWord = value.split(/\s+/, 1)[0]?.toLowerCase()
  if (firstWord === normalizedName.toLowerCase()) return value
  return `${normalizedName} ${value}`
}

export function summarizeToolCommand(toolName: string, args?: string, commandOverride?: string): { label: string; command: string } {
  const normalizedName = toolName.trim() || 'tool'
  const lowerName = normalizedName.toLowerCase()
  const parsed = parsedArguments(args)
  const explicitCommand = commandOverride?.replace(/\s+/g, ' ').trim()
  const argumentCommand = typeof parsed?.command === 'string' ? parsed.command.trim() : ''
  const path = typeof parsed?.path === 'string' ? parsed.path.trim() : ''
  const query = typeof parsed?.query === 'string' ? parsed.query.trim() : ''
  const url = typeof parsed?.url === 'string' ? parsed.url.trim() : ''
  const pattern = typeof parsed?.pattern === 'string' ? parsed.pattern.trim() : ''

  let command = explicitCommand || argumentCommand
  if (!command && path) {
    const range = typeof parsed?.offset === 'number' || typeof parsed?.limit === 'number'
      ? ` offset=${parsed?.offset ?? 0} limit=${parsed?.limit ?? '—'}`
      : ''
    command = `${lowerName} ${path}${range}`
  }
  if (!command && query) command = prefixedCommand(normalizedName, query)
  if (!command && url) command = prefixedCommand(normalizedName, url)
  if (!command && pattern) command = prefixedCommand(normalizedName, pattern)
  if (!command && args) command = compact(args)
  if (!command) command = lowerName

  const shellLike = lowerName === 'bash' || lowerName === 'shell' || lowerName === 'sh'
  const label = shellLike || command.toLowerCase().startsWith(`${lowerName} `)
    ? commandLabel(command)
    : displayToolName(normalizedName)
  return { label, command: compact(command) }
}

const STATUS_META: Record<ToolSummaryStatus, { icon: string; className: string; label: string }> = {
  pending: { icon: '○', className: 'text-muted', label: '等待执行' },
  running: { icon: '●', className: 'text-accent', label: '运行中' },
  success: { icon: '✓', className: 'text-ok', label: '成功' },
  error: { icon: '✗', className: 'text-danger', label: '失败' },
}

export function ToolSummaryLine({
  toolName,
  args,
  command,
  timestamp,
  status,
  className = '',
}: {
  toolName: string
  args?: string
  command?: string
  timestamp?: unknown
  status: ToolSummaryStatus
  className?: string
}) {
  const summary = summarizeToolCommand(toolName, args, command)
  const meta = STATUS_META[status]
  const formattedTimestamp = formatToolTimestamp(timestamp)
  return (
    <span className={`flex min-w-0 items-center gap-1.5 font-mono text-[11px] ${className}`} title={`${summary.command}${formattedTimestamp ? ` · ${formattedTimestamp}` : ''}`}>
      <span className="shrink-0 text-border" aria-hidden="true">│</span>
      <span className={`shrink-0 font-semibold ${meta.className}`} aria-label={meta.label}>{meta.icon}</span>
      <span className="shrink-0 font-semibold text-text-strong">{summary.label}</span>
      {formattedTimestamp && <time className="shrink-0 text-[10px] font-normal text-muted" dateTime={new Date(timestampValue(timestamp) || 0).toISOString()}>{formattedTimestamp}</time>}
      <span className="min-w-0 flex-1 truncate text-muted" title={summary.command}>{summary.command}</span>
    </span>
  )
}
