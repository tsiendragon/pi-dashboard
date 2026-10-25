import { useState } from 'react'
import { ToolSummaryLine } from '../../components/ToolSummary'
import { normalizeToolOutputText } from '../../utils/toolOutputText'

export function shortToolId(value?: string): string {
  return value ? `#${value.length > 12 ? value.slice(0, 8) : value}` : ''
}

/**
 * Folded reader for one tool result.
 *
 * Tool output can be a whole page of text, so the card keeps the one-line
 * summary visible and the body closed until the reader asks for it. The body is
 * the normalized text (serialized envelope unwrapped, escaped line breaks
 * restored) so a machine-shaped result still reads like output instead of one
 * long line of JSON.
 */
export default function ToolResultCard({ text, toolName, toolCallId, command, isError, timestamp, revealOnMount = false }: { text: string; toolName?: string; toolCallId?: string; command?: string; isError?: boolean; timestamp?: string; revealOnMount?: boolean }) {
  const body = normalizeToolOutputText(text)
  const lines = body.split('\n')
  const [expanded, setExpanded] = useState(revealOnMount)
  const statusTone = isError ? 'border-danger/40 border-l-danger' : 'border-border border-l-ok'
  return (
    <article className={`w-full max-w-full overflow-hidden rounded-lg border border-l-2 bg-card ${statusTone}`}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="flex w-full min-w-0 items-center gap-2 border-none bg-transparent px-2.5 py-1.5 text-left hover:bg-bg-hover"
      >
        <ToolSummaryLine toolName={toolName || 'tool'} command={command} timestamp={timestamp} status={isError ? 'error' : 'success'} className="flex-1" />
        <span className="flex shrink-0 items-center gap-2 text-2xs text-muted">
          <span>{lines.length} 行</span>
          <span className="text-accent">{expanded ? '收起' : '展开'}</span>
        </span>
      </button>
      {expanded && (
        <div className="max-h-[320px] overflow-auto border-t border-border bg-bg-elevated/50 px-2.5 py-2">
          {toolCallId && <div className="mb-1 text-2xs text-muted">tool call {shortToolId(toolCallId)}</div>}
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-2xs leading-4 text-text">{body}</pre>
        </div>
      )}
    </article>
  )
}