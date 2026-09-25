import { useState, useMemo, memo } from 'react'
import type { ChatMessage } from '../../types'
import { ToolSummaryLine, type ToolSummaryStatus } from '../../components/ToolSummary'

interface ToolGroupProps {
  tools: { index: number; message: ChatMessage }[]
  renderTool: (i: number, m: ChatMessage) => React.ReactNode
}

const UNGROUPED_TOOL_NAMES = new Set(['subagent', 'process', 'ensemble_spawn', 'ensemble_send'])

/** TUI-like summary for a consecutive batch of tool calls. */
const ToolGroup = memo(function ToolGroup({ tools, renderTool }: ToolGroupProps) {
  const [expanded, setExpanded] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)

  const summary = useMemo(() => {
    const names = new Map<string, number>()
    let errors = 0
    let completed = 0
    const files: string[] = []
    for (const { message: m } of tools) {
      const name = (m.meta?.toolName as string) || m.content.replace('🔧 ', '')
      names.set(name, (names.get(name) || 0) + 1)
      if (typeof m.meta?.result === 'string' || m.meta?.isError) completed++
      if (m.meta?.isError) errors++
      if (m.meta?.args && (name === 'edit' || name === 'write' || name === 'read')) {
        try {
          const parsed = JSON.parse(m.meta.args as string)
          if (typeof parsed.path === 'string' && parsed.path) {
            const short = parsed.path.split('/').pop() || parsed.path
            if (!files.includes(short)) files.push(short)
          }
        } catch { /* ignore */ }
      }
    }
    return { names, errors, completed, total: tools.length, files }
  }, [tools])

  if (tools.length <= 1) {
    return <>{tools.map(t => renderTool(t.index, t.message))}</>
  }

  const nameStr = Array.from(summary.names.entries())
    .map(([name, count]) => count > 1 ? `${name}×${count}` : name)
    .join(', ')
  const progress = summary.completed === summary.total
    ? `${summary.total} 完成`
    : `${summary.completed} 完成 · ${summary.total - summary.completed} 运行中`
  const groupTone = summary.errors > 0
    ? 'border-danger bg-danger-subtle'
    : summary.completed === summary.total
      ? 'border-ok bg-ok-subtle'
      : 'border-accent bg-accent-subtle'

  return (
    <div className="animate-scale-in font-mono">
      <button
        className={`w-full min-w-0 flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-2xs transition cursor-pointer hover:border-border-strong ${groupTone}`}
        onClick={() => { setExpanded(value => !value); setSelectedIndex(null) }}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse tool calls' : 'Expand tool calls'}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${summary.errors > 0 ? 'bg-danger' : summary.completed === summary.total ? 'bg-ok' : 'bg-accent'}`} />
        <span className="shrink-0 font-semibold text-text-strong">工具组：{progress}</span>
        <span className="shrink-0 text-muted opacity-60">•</span>
        <span className="min-w-0 flex-1 truncate text-muted">{nameStr}</span>
        <span className="shrink-0 text-muted opacity-50">• 点击展开</span>
      </button>
      {expanded && (
        <div className="mt-1 ml-1 border-l border-border pl-2">
          <div className="space-y-0.5">
            {tools.map(tool => {
              const message = tool.message
              const toolName = (message.meta?.toolName as string) || message.content.replace('🔧 ', '')
              const args = typeof message.meta?.args === 'string' ? message.meta.args : undefined
              const status: ToolSummaryStatus = message.meta?.isError ? 'error' : typeof message.meta?.result === 'string' ? 'success' : 'running'
              const active = selectedIndex === tool.index
              return (
                <div key={tool.index}>
                  <button
                    type="button"
                    className={`flex w-full min-w-0 items-center rounded px-1 py-0.5 text-left text-2xs transition-colors hover:bg-bg-hover ${active ? 'bg-bg-hover' : ''}`}
                    onClick={() => setSelectedIndex(active ? null : tool.index)}
                    aria-expanded={active}
                  >
                    <ToolSummaryLine toolName={toolName} args={args} timestamp={message.ts} status={status} className="flex-1" />
                  </button>
                  {active && <div className="ml-4 mt-0.5 mb-1">{renderTool(tool.index, message)}</div>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
})

export default ToolGroup

/**
 * Group consecutive tool messages into ToolGroup clusters.
 * Returns an array of { type: 'single', index, message } | { type: 'group', tools }.
 */
export function groupToolMessages(messages: ChatMessage[]): ({ type: 'single'; index: number; message: ChatMessage } | { type: 'group'; tools: { index: number; message: ChatMessage }[] })[] {
  const result: ({ type: 'single'; index: number; message: ChatMessage } | { type: 'group'; tools: { index: number; message: ChatMessage }[] })[] = []
  let currentGroup: { index: number; message: ChatMessage }[] = []
  let pendingThinking: { index: number; message: ChatMessage }[] = []

  const flush = () => {
    if (currentGroup.length > 2) {
      result.push({ type: 'group', tools: currentGroup })
    } else {
      for (const tool of currentGroup) result.push({ type: 'single', ...tool })
    }
    currentGroup = []
    // Keep meaningful thinking visible, but place it after the completed tool batch.
    for (const thinking of pendingThinking) result.push({ type: 'single', ...thinking })
    pendingThinking = []
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === 'tool') {
      const toolName = (message.meta?.toolName as string) || ''
      if (UNGROUPED_TOOL_NAMES.has(toolName)) {
        if (currentGroup.length > 0 || pendingThinking.length > 0) flush()
        result.push({ type: 'single', index: i, message })
      } else {
        currentGroup.push({ index: i, message })
      }
      continue
    }

    if (message.role === 'thinking') {
      // Empty thinking frames are transport noise. Meaningful thinking between
      // tool calls belongs to the same turn and must not split its tool batch.
      if (!message.content.trim()) continue
      if (currentGroup.length > 0) {
        pendingThinking.push({ index: i, message })
        continue
      }
    }

    if (currentGroup.length > 0 || pendingThinking.length > 0) flush()
    result.push({ type: 'single', index: i, message })
  }

  if (currentGroup.length > 0 || pendingThinking.length > 0) flush()
  return result
}
