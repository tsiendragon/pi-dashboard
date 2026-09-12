import { useState, useMemo } from 'react'
import DiffBlock from '../../components/DiffBlock'
import ResizableImage from '../../components/ResizableImage'
import SubagentCard from './SubagentCard'
import ProcessCard from './ProcessCard'
import { useSlotRegistryOrNull } from '../../plugins'
import { forToolName } from '../../plugins/slot-registry'
import { ToolRendererSlot } from '../../plugins/slot-consumers'
import { generateEditDiff, parseEditArgs, parseWriteArgs, langFromPath } from './toolUtils'
import { ToolSummaryLine, type ToolSummaryStatus } from '../../components/ToolSummary'

function truncateSummary(value: string, max = 96): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact
}

function summarizeToolArgs(args?: string): string {
  if (!args) return ''
  try {
    const parsed: unknown = JSON.parse(args)
    if (parsed && typeof parsed === 'object') {
      const object = parsed as Record<string, unknown>
      for (const key of ['path', 'command', 'query', 'url', 'pattern', 'cwd']) {
        if (typeof object[key] === 'string' && object[key].trim()) return truncateSummary(object[key])
      }
    }
  } catch { /* keep a compact raw preview for non-JSON tool arguments */ }
  return truncateSummary(args)
}

function summarizeToolResult(result?: string): string {
  return result ? truncateSummary(result.split('\n')[0]) : ''
}

function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions++
    if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

/** Expandable tool call block with args and result — shows diff view for edit tool, code preview for write */
export default function ToolCallBlock({ content, meta, onFileOpen, slotKey }: { content: string; meta?: Record<string, unknown>; onFileOpen?: (path: string) => void; slotKey?: string }) {
  const toolName = (meta?.toolName as string) || content.replace('🔧 ', '')
  const [expanded, setExpanded] = useState(false)
  const args = meta?.args as string | undefined
  const result = meta?.result as string | undefined
  const partialText = meta?.partialResult as string | undefined
  const partialDetails = meta?.partialDetails as Record<string, unknown> | undefined
  // Re-assemble structured partialResult for plugin tool renderers.
  // (The wire format is flat — text + details — to keep the WS payload
  // small; plugins want { content, details } so they can read details
  // directly without redoing the parse.)
  const partialResult = (partialText || partialDetails)
    ? {
        content: partialText ? [{ type: 'text', text: partialText }] : undefined,
        details: partialDetails,
      }
    : undefined
  const isError = meta?.isError as boolean | undefined
  const timestamp = meta?.timestamp
  const isRunning = !result && !isError
  const summaryStatus: ToolSummaryStatus = isError ? 'error' : result ? 'success' : isRunning ? 'running' : 'pending'
  const hasDetails = !!(args || result || partialText || partialDetails)
  const argsSummary = summarizeToolArgs(args)
  const resultSummary = summarizeToolResult(result || partialText)
  const summaryText = argsSummary || resultSummary
  const statusTone = isError
    ? 'border-danger/45 bg-danger-subtle/15'
    : result
      ? 'border-ok/35 bg-ok-subtle/10'
      : 'border-accent/35 bg-accent-subtle/10'

  const handleDownload = (e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    const url = `/api/local-file/download?path=${encodeURIComponent(path)}`
    const a = document.createElement('a')
    a.href = url
    a.download = path.split('/').pop() || 'file'
    a.click()
  }

  // For edit tool calls, parse args and generate diff
  const editDiff = useMemo(() => {
    if (toolName !== 'edit' || !args) return null
    const parsed = parseEditArgs(args)
    if (!parsed) return null
    return { diff: generateEditDiff(parsed.path, parsed.edits), path: parsed.path }
  }, [toolName, args])
  const editStats = useMemo(() => editDiff ? diffStats(editDiff.diff) : { additions: 0, deletions: 0 }, [editDiff])

  // For write tool calls, parse args to show file content nicely
  const writeInfo = useMemo(() => {
    if (toolName !== 'write' || !args) return null
    return parseWriteArgs(args)
  }, [toolName, args])

  // For read tool calls, parse args and use result as file content
  const readInfo = useMemo(() => {
    if (toolName !== 'read' || !args) return null
    try {
      const parsed = JSON.parse(args)
      if (!parsed.path) return null
      return { path: parsed.path as string, offset: parsed.offset as number | undefined, limit: parsed.limit as number | undefined }
    } catch { return null }
  }, [toolName, args])

  // Edit tool calls default to expanded (showing diff)
  const isEdit = !!editDiff
  const isWrite = !!writeInfo
  const isRead = !!readInfo
  const [editExpanded, setEditExpanded] = useState(false)
  const [writeExpanded, setWriteExpanded] = useState(false)
  const [readExpanded, setReadExpanded] = useState(false)

  // Check if a plugin claims this tool
  const registry = useSlotRegistryOrNull()
  const pluginClaimed = registry ? forToolName(registry.getClaims('tool-renderer'), toolName).length > 0 : false

  // Early returns AFTER all hooks (Rules of Hooks compliance)
  if (toolName === 'subagent') return <SubagentCard meta={meta} />
  if (toolName === 'process') return <ProcessCard meta={meta} />

  // If a plugin claims this tool, render via ToolRendererSlot
  if (pluginClaimed) {
    const toolInput = args ? (() => { try { return JSON.parse(args) } catch { return {} } })() : {}
    return <ToolRendererSlot toolName={toolName} toolInput={toolInput} toolResult={result} partialResult={partialResult} isRunning={isRunning} isError={isError} sessionId={slotKey || ''} />
  }

  if (isEdit) {
    return (
      <div className={`msg-content bg-transparent border border-border/30 md:bg-card md:border-border rounded-md animate-scale-in ${statusTone}`}>
        <button
          className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted font-body bg-transparent border-none text-left hover:text-text transition-colors cursor-pointer"
          onClick={() => setEditExpanded(!editExpanded)}
          aria-expanded={editExpanded}
        >
          <ToolSummaryLine toolName={toolName} args={args} timestamp={timestamp} status={summaryStatus} className="min-w-0 flex-1" />
          {onFileOpen && <button className="text-accent text-[11px] font-medium hover:underline shrink-0 bg-transparent border-none cursor-pointer" onClick={e => { e.stopPropagation(); onFileOpen(editDiff.path) }}>Open</button>}
          <button className="text-muted text-[11px] hover:text-accent shrink-0 bg-transparent border-none cursor-pointer" onClick={e => handleDownload(e, editDiff.path)} title="Download">⬇</button>
        </button>
        <div className="flex items-center gap-1.5 border-t border-border/40 px-2 pb-1 text-[10px] font-mono text-muted/60">
          <span>↳ diff</span>
          <span className="text-diff-add-text">+{editStats.additions}</span>
          <span className="text-diff-del-text">-{editStats.deletions}</span>
          <span>split</span>
          <span className="flex h-1 w-12 overflow-hidden rounded-sm" aria-hidden="true">
            <span className="flex-1 bg-diff-del" />
            <span className="flex-1 bg-diff-add" />
          </span>
        </div>
        {editExpanded && (
          <div className="px-2 pb-2">
            <DiffBlock code={editDiff.diff} complete={true} initialSideBySide />
            {isError && result && (
              <div className="mt-1">
                <pre className="bg-bg-hover rounded-md px-3 py-2 text-[13px] font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto text-danger">{result}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  if (isRead && result && !isError) {
    const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(readInfo.path)
    if (isImage) {
      const imgUrl = `/api/local-file?path=${encodeURIComponent(readInfo.path)}`
      const match = result.match(/!\[image\]\(([^)]+)\)/)
      const src = match ? match[1] : imgUrl
      return (
        <div className={`msg-content bg-transparent border border-border/30 md:bg-card md:border-border rounded-md animate-scale-in ${statusTone}`}>
          <button
            className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted font-body bg-transparent border-none text-left hover:text-text transition-colors cursor-pointer"
            onClick={() => setReadExpanded(!readExpanded)}
            aria-expanded={readExpanded}
          >
            <ToolSummaryLine toolName={toolName} args={args} timestamp={timestamp} status={summaryStatus} className="min-w-0 flex-1" />
            {onFileOpen && <button className="text-accent text-[11px] font-medium hover:underline shrink-0 bg-transparent border-none cursor-pointer" onClick={e => { e.stopPropagation(); onFileOpen(readInfo.path) }}>Open</button>}
            <button className="text-muted text-[11px] hover:text-accent shrink-0 bg-transparent border-none cursor-pointer" onClick={e => handleDownload(e, readInfo.path)} title="Download">⬇</button>
          </button>
          {readExpanded && (
            <div className="px-2 pb-2">
              <ResizableImage src={src} alt={readInfo.path.split('/').pop() || ''} />
            </div>
          )}
        </div>
      )
    }
    const lang = langFromPath(readInfo.path)
    const lineCount = result.split('\n').length
    const rangeLabel = readInfo.offset ? `lines ${readInfo.offset}–${readInfo.offset + (readInfo.limit || lineCount) - 1}` : `${lineCount} lines`
    return (
      <div className={`msg-content bg-transparent border border-border/30 md:bg-card md:border-border rounded-md animate-scale-in ${statusTone}`}>
        <button
          className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted font-body bg-transparent border-none text-left hover:text-text transition-colors cursor-pointer"
          onClick={() => setReadExpanded(!readExpanded)}
          aria-expanded={readExpanded}
        >
          <ToolSummaryLine toolName={toolName} args={args} timestamp={timestamp} status={summaryStatus} className="min-w-0 flex-1" />
          {onFileOpen && <button className="text-accent text-[11px] font-medium hover:underline shrink-0 bg-transparent border-none cursor-pointer" onClick={e => { e.stopPropagation(); onFileOpen(readInfo.path) }}>Open</button>}
          <button className="text-muted text-[11px] hover:text-accent shrink-0 bg-transparent border-none cursor-pointer" onClick={e => handleDownload(e, readInfo.path)} title="Download">⬇</button>
          <span className="text-muted/50 text-[12px] font-normal shrink-0">{rangeLabel}</span>
        </button>
        {readExpanded && (
          <div className="px-2 pb-2">
            <div className="relative group">
              <div className="flex items-center justify-between bg-bg-elevated border border-border rounded-t-md px-3 py-1.5">
                <span className="text-muted text-[12px] font-mono uppercase">{lang || readInfo.path.split('/').pop()}</span>
                <button className="text-muted text-[12px] opacity-40 group-hover:opacity-100 transition-opacity cursor-pointer hover:text-text bg-transparent border-none font-body" onClick={() => navigator.clipboard.writeText(result)}>Copy</button>
              </div>
              <pre className="bg-bg-elevated border border-t-0 border-border rounded-b-md p-3 overflow-x-auto max-h-[400px] overflow-y-auto">
                <code className="text-[13px] font-mono leading-relaxed text-text">{result}</code>
              </pre>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (isWrite) {
    const lang = langFromPath(writeInfo.path)
    const lineCount = writeInfo.content.split('\n').length
    return (
      <div className={`msg-content bg-transparent border border-border/30 md:bg-card md:border-border rounded-md animate-scale-in ${statusTone}`}>
        <button
          className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted font-body bg-transparent border-none text-left hover:text-text transition-colors cursor-pointer"
          onClick={() => setWriteExpanded(!writeExpanded)}
          aria-expanded={writeExpanded}
        >
          <ToolSummaryLine toolName={toolName} args={args} timestamp={timestamp} status={summaryStatus} className="min-w-0 flex-1" />
          {onFileOpen && <button className="text-accent text-[11px] font-medium hover:underline shrink-0 bg-transparent border-none cursor-pointer" onClick={e => { e.stopPropagation(); onFileOpen(writeInfo.path) }}>Open</button>}
          <button className="text-muted text-[11px] hover:text-accent shrink-0 bg-transparent border-none cursor-pointer" onClick={e => handleDownload(e, writeInfo.path)} title="Download">⬇</button>
          <span className="text-muted/50 text-[12px] font-normal shrink-0">{lineCount} lines</span>
        </button>
        {writeExpanded && (
          <div className="px-2 pb-2">
            <div className="relative group">
              <div className="flex items-center justify-between bg-bg-elevated border border-border rounded-t-md px-3 py-1.5">
                <span className="text-muted text-[12px] font-mono uppercase">{lang || writeInfo.path.split('/').pop()}</span>
                <button className="text-muted text-[12px] opacity-40 group-hover:opacity-100 transition-opacity cursor-pointer hover:text-text bg-transparent border-none font-body" onClick={() => navigator.clipboard.writeText(writeInfo.content)}>Copy</button>
              </div>
              <pre className="bg-bg-elevated border border-t-0 border-border rounded-b-md p-3 overflow-x-auto max-h-[400px] overflow-y-auto">
                <code className="text-[13px] font-mono leading-relaxed text-text">{writeInfo.content}</code>
              </pre>
            </div>
            {isError && result && (
              <div className="mt-1">
                <pre className="bg-bg-hover rounded-md px-3 py-2 text-[13px] font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto text-danger">{result}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`pidash-tool-card msg-content bg-transparent border border-border/30 md:bg-card md:border-border rounded-md animate-scale-in ${statusTone} ${hasDetails ? 'cursor-pointer' : ''}`} data-pidash-tool-name={toolName} data-pidash-tool-status={isError ? 'error' : result ? 'ok' : 'running'}>
      <button
        className="w-full min-w-0 flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted font-mono bg-transparent border-none text-left hover:text-text transition-colors"
        onClick={() => hasDetails && setExpanded(!expanded)}
        disabled={!hasDetails}
        aria-expanded={hasDetails ? expanded : undefined}
        title={summaryText || toolName}
      >
        {hasDetails && <span className={`shrink-0 text-[10px] transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>}
        <ToolSummaryLine toolName={toolName} args={args} timestamp={timestamp} status={summaryStatus} className="min-w-0 flex-1" />
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t border-border space-y-2">
          {args && (
            <div>
              <div className="text-[11px] text-muted font-medium uppercase tracking-wider mt-2 mb-1">Arguments</div>
              <pre className="bg-bg-hover rounded-md px-3 py-2 text-[13px] font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto text-text">{args}</pre>
            </div>
          )}
          {result && (
            <div>
              <div className={`text-[11px] font-medium uppercase tracking-wider mt-2 mb-1 ${isError ? 'text-danger' : 'text-muted'}`}>{isError ? 'Error' : 'Result'}</div>
              {/!\[image\]\(/.test(result) ? (
                <div className="space-y-2">
                  {result.split(/\n\n/).map((part, i) => {
                    const imgMatch = part.match(/!\[image\]\(([^)]+)\)/)
                    return imgMatch
                      ? <ResizableImage key={i} src={imgMatch[1]} alt="tool result" />
                      : part.trim() ? <pre key={i} className={`bg-bg-hover rounded-md px-3 py-2 text-[13px] font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto ${isError ? 'text-danger' : 'text-muted'}`}>{part}</pre> : null
                  })}
                </div>
              ) : (
                <pre className={`bg-bg-hover rounded-md px-3 py-2 text-[13px] font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto ${isError ? 'text-danger' : 'text-muted'}`}>{result}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
