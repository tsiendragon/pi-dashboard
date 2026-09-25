import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import MarkdownRenderer from './MarkdownRenderer'
import InlineComments from './InlineComments'
import type { Comment } from '../hooks/usePanelState'
import { useCommentSelection, type CommentTarget } from '../hooks/useCommentSelection'
import { copyText } from '../utils/clipboard'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('jsx', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('tsx', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('zsh', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)

interface LanguageInfo {
  id: string
  label: string
}

const LANGUAGE_BY_EXTENSION: Record<string, LanguageInfo> = {
  '.json': { id: 'json', label: 'JSON' },
  '.yaml': { id: 'yaml', label: 'YAML' },
  '.yml': { id: 'yaml', label: 'YAML' },
  '.py': { id: 'python', label: 'Python' },
  '.ts': { id: 'typescript', label: 'TypeScript' },
  '.tsx': { id: 'typescript', label: 'TypeScript' },
  '.js': { id: 'javascript', label: 'JavaScript' },
  '.jsx': { id: 'javascript', label: 'JavaScript' },
  '.sh': { id: 'bash', label: 'Bash' },
  '.bash': { id: 'bash', label: 'Bash' },
  '.zsh': { id: 'bash', label: 'Bash' },
}

export function languageForPreview(path: string): LanguageInfo | null {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? LANGUAGE_BY_EXTENSION[path.slice(dot).toLowerCase()] ?? null : null
}

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path)
}

function HighlightedSource({ content, language }: { content: string; language: LanguageInfo | null }) {
  const highlighted = useMemo(() => {
    if (!language || !hljs.getLanguage(language.id)) return null
    try {
      return DOMPurify.sanitize(hljs.highlight(content, { language: language.id }).value)
    } catch {
      return null
    }
  }, [content, language])

  if (highlighted == null) {
    return (
      <pre className="m-0 whitespace-pre-wrap break-words text-body-s leading-relaxed font-mono text-text">
        <code>{content}</code>
      </pre>
    )
  }

  return (
    <pre className="m-0 overflow-auto text-body-s leading-relaxed font-mono">
      <code className={`hljs language-${language?.id}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
    </pre>
  )
}

export interface DocumentPreviewModalProps {
  filePath: string
  content: string
  loading?: boolean
  error?: string | null
  onClose: () => void
  /** Commenting is available when the caller supplies the comment handlers. */
  comments?: Comment[]
  currentVersion?: number
  onAddComment?: (startLine: number, endLine: number, content: string, quote?: string) => void
  onEditComment?: (id: string, content: string) => void
  onDeleteComment?: (id: string) => void
  onReviewComments?: () => void
}

export default function DocumentPreviewModal({ filePath, content, loading = false, error = null, onClose, comments = [], currentVersion, onAddComment, onEditComment, onDeleteComment, onReviewComments }: DocumentPreviewModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const commentsRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [activeInputRange, setActiveInputRange] = useState<CommentTarget | null>(null)
  const markdown = isMarkdownPath(filePath)
  const language = languageForPreview(filePath)
  const label = markdown ? 'Markdown' : language?.label || 'Text'
  const commenting = Boolean(onAddComment) && !loading && !error
  const { contextMenu, clampedMenuStyle, handleContextMenu, closeContextMenu } = useCommentSelection(content)

  const handleAddComment = useCallback((startLine: number, endLine: number, text: string) => {
    onAddComment?.(startLine, endLine, text, activeInputRange?.quote)
    setActiveInputRange(null)
  }, [onAddComment, activeInputRange])

  // The comment input lives at the end of the footer, so reveal it when it opens.
  useEffect(() => {
    const footer = commentsRef.current
    if (activeInputRange && footer) footer.scrollTop = footer.scrollHeight
  }, [activeInputRange])

  const handleCopy = useCallback(async () => {
    if (await copyText(content)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [content])

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 md:p-8" role="dialog" aria-modal="true" aria-label={`Preview ${filePath}`}>
      <button type="button" aria-label="Close document preview" className="absolute inset-0 border-none bg-black/60 cursor-default" onClick={onClose} />
      <section className="relative z-10 flex w-full max-w-5xl max-h-[90vh] flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-2xl" onClick={event => event.stopPropagation()}>
        <header className="flex min-w-0 items-center gap-2 border-b border-border bg-chrome px-3 py-2">
          <span className="shrink-0 text-sm">📄</span>
          <span className="min-w-0 flex-1 truncate text-body-s font-mono font-semibold text-text" title={filePath}>{filePath}</span>
          <span className="shrink-0 rounded border border-border bg-bg-elevated px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-muted">{label}</span>
          <button
            type="button"
            title={`复制 ${filePath} 的内容`}
            aria-label="复制文件内容"
            disabled={loading || !!error}
            onClick={handleCopy}
            className="shrink-0 rounded border border-border bg-transparent px-2 py-1 text-meta text-muted cursor-pointer hover:border-accent hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-default"
          >{copied ? '✓ 已复制' : '📋 复制'}</button>
          <a
            href={`/api/local-file/download?path=${encodeURIComponent(filePath)}`}
            download
            title={`下载 ${filePath}`}
            aria-label="下载文件"
            className="shrink-0 rounded border border-border bg-transparent px-2 py-1 text-meta text-muted no-underline cursor-pointer hover:border-accent hover:text-accent transition-colors"
          >⬇ 下载</a>
          <button ref={closeRef} type="button" aria-label="Close document preview" className="ml-1 shrink-0 rounded border border-border bg-transparent px-2 py-1 text-meta text-muted cursor-pointer hover:border-danger hover:text-danger" onClick={onClose}>✕</button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4" onContextMenu={commenting ? handleContextMenu : undefined}>
          {loading ? (
            <div className="flex min-h-32 items-center justify-center text-sm text-muted">Loading…</div>
          ) : error ? (
            <div className="rounded-md border border-danger bg-danger-subtle px-3 py-2 text-sm text-danger">{error}</div>
          ) : markdown ? (
            <div className="msg-content text-sm leading-relaxed text-text">
              <MarkdownRenderer content={content} />
            </div>
          ) : (
            <div className="rounded-md border border-border bg-bg-elevated p-3">
              <HighlightedSource content={content} language={language} />
            </div>
          )}
        </div>
        {commenting && (activeInputRange || comments.length > 0) && (
          // shrink-0 keeps the comment input at its content height — as a shrinkable
          // flex item inside the auto-height modal it was collapsing to ~25px and
          // scrolling the input out of view. The cap is viewport-relative because a
          // percentage max-height does not resolve against an auto-height parent.
          <div ref={commentsRef} className="shrink-0 max-h-[40vh] overflow-auto border-t border-border px-2 py-1">
            <InlineComments
              comments={comments}
              currentVersion={currentVersion}
              activeInputRange={activeInputRange}
              onAdd={handleAddComment}
              onEdit={(id, text) => onEditComment?.(id, text)}
              onDelete={id => onDeleteComment?.(id)}
              onCancelInput={() => setActiveInputRange(null)}
              onReviewComments={onReviewComments}
            />
          </div>
        )}
        {contextMenu && (
          <div
            className="fixed z-50 min-w-[160px] rounded-md border border-border bg-bg-elevated py-1 shadow-lg"
            style={clampedMenuStyle}
            onMouseDown={event => event.stopPropagation()}
          >
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-1.5 text-left font-body text-body-s text-text hover:bg-bg-hover"
              onClick={() => { setActiveInputRange(contextMenu.target); closeContextMenu() }}
            >💬 Add Comment</button>
          </div>
        )}
      </section>
    </div>
  )
}
