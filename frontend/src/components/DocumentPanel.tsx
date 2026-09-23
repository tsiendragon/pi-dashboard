import { memo, useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense, type ChangeEvent } from 'react'
import TextRenderer, { CommentInput } from './renderers/TextRenderer'
import DiffView from './DiffView'
import { detectFileType, type Comment } from '../hooks/usePanelState'
import { useCommentSelection } from '../hooks/useCommentSelection'
import { copyText } from '../utils/clipboard'

const PdfRenderer = lazy(() => import('./renderers/PdfRenderer'))
const DocxRenderer = lazy(() => import('./renderers/DocxRenderer'))
const SpreadsheetRenderer = lazy(() => import('./renderers/SpreadsheetRenderer'))
const ImageRenderer = lazy(() => import('./renderers/ImageRenderer'))
const HtmlRenderer = lazy(() => import('./renderers/HtmlRenderer'))

const LOADING_FALLBACK = <div className="flex items-center justify-center h-full text-muted text-sm">Loading...</div>

interface VersionMeta { version: number; timestamp: string; size: number }

interface Props {
  filePath: string
  content: string
  onContentChange: (c: string) => void
  onSave: (filePath: string, content: string) => Promise<void>
  onClose: () => void
  dirty: boolean
  versions: VersionMeta[]
  selectedVersion: number | null
  conflictContent: string | null
  onSelectVersion: (v: number | null) => void
  onResolveConflict: (action: 'reload' | 'keep' | 'diff') => void
  diffMode: boolean
  onToggleDiff: () => void
  comments: Comment[]
  onAddComment: (startLine: number, endLine: number, content: string, quote?: string) => void
  onEditComment: (id: string, content: string) => void
  onDeleteComment: (id: string) => void
  onReviewComments?: () => void
  presentation?: 'side' | 'modal'
}

export default memo(function DocumentPanel({ filePath, content, onContentChange, onSave, onClose, dirty, versions, selectedVersion, conflictContent, onSelectVersion, onResolveConflict, diffMode, onToggleDiff, comments, onAddComment, onEditComment, onDeleteComment, onReviewComments, presentation = 'side' }: Props) {
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [lineNums, setLineNums] = useState(true)
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('mc-docpanel-width')
    const n = saved ? parseInt(saved, 10) : NaN
    return !isNaN(n) && n >= 300 ? n : 480
  })
  const [activeInputRange, setActiveInputRange] = useState<{ start: number; end: number; quote?: string } | null>(null)
  const fileName = filePath.split('/').pop() || filePath
  const ref = useRef<HTMLDivElement>(null)
  const isOldVersion = selectedVersion !== null
  const fileType = detectFileType(filePath)
  const isModal = presentation === 'modal'
  // html is NOT binary — it keeps Save, the Preview/Source toggle, versions,
  // and Source-mode commenting enabled.
  const isBinary = fileType !== 'text' && fileType !== 'html'

  // Cheap rolling hash of content — bumps the iframe key on live-reload so the
  // artifact's scripts reliably re-execute when the file changes on disk.
  const htmlReloadKey = useMemo(() => {
    if (fileType !== 'html') return 0
    let h = 5381
    for (let i = 0; i < content.length; i++) h = ((h << 5) + h + content.charCodeAt(i)) | 0
    return h
  }, [fileType, content])

  const handleSave = useCallback(async () => {
    setSaving(true); setSaveError(null)
    try { await onSave(filePath, content) }
    catch (err) { setSaveError(err instanceof Error ? err.message : 'Save failed') }
    finally { setSaving(false) }
  }, [filePath, content, onSave])

  const handleSaveRef = useRef(handleSave)
  useEffect(() => { handleSaveRef.current = handleSave }, [handleSave])

  const guardedClose = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    onClose()
  }, [dirty, onClose])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') guardedClose()
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && mode === 'edit' && dirty) { e.preventDefault(); handleSaveRef.current() }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [guardedClose, mode, dirty])

  const handleChange = useCallback((v: string) => { onContentChange(v) }, [onContentChange])

  // Right-click selection → comment target (line range + quoted sentence).
  const { contextMenu, clampedMenuStyle, targetFromText, handleContextMenu, closeContextMenu } = useCommentSelection(content)

  // HTML preview: an in-frame selection arrives (via postMessage bridge) as text.
  // Reverse-map it and open the same floating comment input the Source path uses.
  const handleIframeSelect = useCallback((text: string) => {
    setActiveInputRange(targetFromText(text))
  }, [targetFromText])

  const filteredComments = useMemo(() => {
    // When viewing a specific historical version, filter to that version's comments.
    // When viewing the current (live) version, show all comments regardless of version
    // to prevent them from disappearing when the file is modified and version increments.
    if (selectedVersion !== null) return comments.filter(c => c.version === selectedVersion)
    return comments
  }, [comments, selectedVersion])

  const handleVersionChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value
    onSelectVersion(val === 'current' ? null : Number(val))
  }, [onSelectVersion])

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent) => { setWidth(Math.max(300, Math.min(startW + (startX - ev.clientX), window.innerWidth * 0.8))) }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); setWidth(w => { localStorage.setItem('mc-docpanel-width', String(w)); return w }) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [width])

  return (
    <div ref={ref} className={isModal ? 'fixed inset-3 z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-2xl shadow-black/40 md:inset-8' : 'fixed inset-0 z-30 flex flex-col bg-bg md:relative md:inset-auto md:z-auto md:border-l md:border-border'} style={!isModal && typeof window !== 'undefined' && window.innerWidth >= 768 ? { width, minWidth: 300 } : undefined}>
      <div className={`${isModal ? 'hidden' : 'hidden md:flex'} absolute left-[-2px] top-0 bottom-0 w-[5px] cursor-col-resize z-20 group/drag items-center justify-center`} onMouseDown={onDragStart}>
        <div className="w-[2px] h-full bg-transparent group-hover/drag:bg-accent group-active/drag:bg-accent-hover transition-colors duration-200" />
      </div>
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-chrome">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-body-s font-mono font-semibold text-text truncate" title={filePath}>{fileName}</span>
          {versions.length > 0 && (
            <select aria-label="version" className="text-2xs bg-bg border border-border rounded px-1 py-0.5 text-muted" value={selectedVersion ?? 'current'} onChange={handleVersionChange}>
              {versions.map(v => <option key={v.version} value={v.version}>v{v.version}</option>)}
              <option value="current">Current</option>
            </select>
          )}
          {isOldVersion && <span className="text-2xs text-warning font-medium">Read-only</span>}
        </div>
        <div className="flex gap-1.5 shrink-0">
          {mode === 'edit' && (
            <button className={`px-2 py-1 rounded-md text-meta font-medium border cursor-pointer transition ${lineNums ? 'border-accent text-accent bg-accent-subtle' : 'border-border text-muted hover:text-text'}`} onClick={() => setLineNums(!lineNums)} title="Toggle line numbers">#</button>
          )}
          {!isBinary && (['preview', 'edit'] as const).map(m => (
            <button key={m} className={`px-2 py-1 rounded-md text-meta font-medium border cursor-pointer transition ${mode === m ? 'border-accent text-accent bg-accent-subtle' : 'border-border text-muted hover:text-text hover:border-border-strong'}`} onClick={() => setMode(m)}>{m === 'edit' ? (fileType === 'html' ? 'Source' : 'Edit') : 'Preview'}</button>
          ))}
          {!isBinary && versions.length > 0 && (
            <button className={`px-2 py-1 rounded-md text-meta font-medium border cursor-pointer transition ${diffMode ? 'border-accent text-accent bg-accent-subtle' : 'border-border text-muted hover:text-text hover:border-border-strong'}`} onClick={onToggleDiff} aria-label="Diff">Diff</button>
          )}
          {!isBinary && <button className={`px-2 py-1 rounded-md text-meta font-medium border transition disabled:opacity-40 ${dirty ? 'border-accent text-accent-fg bg-accent cursor-pointer hover:bg-accent-hover' : 'border-border text-muted cursor-default'}`} disabled={saving || !dirty} onClick={handleSave}>{saving ? 'Saving…' : 'Save'}</button>}
          {!isBinary && (
            <button className="px-2 py-1 rounded-md text-meta text-muted border border-border hover:text-accent hover:border-accent transition cursor-pointer" title="复制文件内容" aria-label="复制文件内容" onClick={async () => { if (await copyText(content)) { setCopied(true); setTimeout(() => setCopied(false), 1500) } }}>{copied ? '✓' : '📋'}</button>
          )}
          <a href={`/api/local-file/download?path=${encodeURIComponent(filePath)}`} download={fileName} className="px-2 py-1 rounded-md text-meta text-muted border border-border hover:text-accent hover:border-accent transition cursor-pointer no-underline" title="Download">⬇</a>
          <button className="px-2 py-1 rounded-md text-meta text-muted border border-border hover:text-danger hover:border-danger transition cursor-pointer" onClick={guardedClose}>✕</button>
        </div>
      </div>
      {saveError && <div className="px-3 py-1 text-2xs text-danger bg-bg-elevated border-b border-border">{saveError}</div>}
      {!isBinary && conflictContent != null && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-warning/10 text-warning text-meta">
          <span className="font-medium">File changed on disk</span>
          <div className="flex gap-1 ml-auto">
            <button className="px-2 py-0.5 rounded border border-warning/40 hover:bg-warning/20 cursor-pointer" onClick={() => onResolveConflict('reload')}>Reload</button>
            <button className="px-2 py-0.5 rounded border border-warning/40 hover:bg-warning/20 cursor-pointer" onClick={() => onResolveConflict('keep')}>Keep Mine</button>
            <button className="px-2 py-0.5 rounded border border-warning/40 hover:bg-warning/20 cursor-pointer" onClick={() => onResolveConflict('diff')}>Show Diff</button>
          </div>
        </div>
      )}
      <div className="flex-1 overflow-hidden p-4" onContextMenu={!diffMode && !isBinary ? handleContextMenu : undefined}>
        {diffMode ? (
          <DiffView oldContent={conflictContent ?? ''} newContent={content} oldLabel={conflictContent != null ? 'Disk' : 'Previous'} newLabel="Current" onClose={onToggleDiff} />
        ) : fileType === 'pdf' ? (
          <Suspense fallback={LOADING_FALLBACK}><PdfRenderer filePath={filePath} /></Suspense>
        ) : fileType === 'docx' ? (
          <Suspense fallback={LOADING_FALLBACK}><DocxRenderer filePath={filePath} /></Suspense>
        ) : fileType === 'spreadsheet' ? (
          <Suspense fallback={LOADING_FALLBACK}><SpreadsheetRenderer filePath={filePath} /></Suspense>
        ) : fileType === 'image' ? (
          <Suspense fallback={LOADING_FALLBACK}><ImageRenderer filePath={filePath} /></Suspense>
        ) : fileType === 'html' && mode === 'preview' ? (
          <Suspense fallback={LOADING_FALLBACK}><HtmlRenderer content={content} onSelect={handleIframeSelect} reloadKey={htmlReloadKey} /></Suspense>
        ) : (
          <TextRenderer
            content={content}
            filePath={filePath}
            mode={isBinary ? 'preview' : mode}
            lineNums={lineNums}
            onChange={handleChange}
            readOnly={isOldVersion || isBinary}
            comments={filteredComments}
            onEditComment={onEditComment}
            onDeleteComment={onDeleteComment}
          />
        )}
      </div>
      {/* Review Comments button — visible when comments exist */}
      {filteredComments.length > 0 && !diffMode && onReviewComments && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border bg-chrome text-2xs text-muted">
          <span>💬 {filteredComments.length} comment{filteredComments.length !== 1 ? 's' : ''}</span>
          <button className="px-2 py-0.5 rounded border border-accent text-accent text-2xs cursor-pointer hover:bg-accent-subtle ml-auto" onClick={onReviewComments}>Review Comments</button>
        </div>
      )}
      {/* Floating comment input triggered by right-click → Add Comment */}
      {activeInputRange && !diffMode && (
        <div className="border-t border-border">
          <CommentInput
            range={activeInputRange}
            quote={activeInputRange.quote}
            onSave={text => { onAddComment(activeInputRange.start, activeInputRange.end, text, activeInputRange.quote); setActiveInputRange(null) }}
            onCancel={() => setActiveInputRange(null)}
          />
        </div>
      )}
      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-bg-elevated border border-border rounded-md shadow-lg py-1 min-w-[160px]"
          style={clampedMenuStyle}
          onMouseDown={e => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-body-s text-text hover:bg-bg-hover cursor-pointer bg-transparent border-none font-body flex items-center gap-2"
            onClick={() => { setActiveInputRange(contextMenu.target); closeContextMenu() }}
          >💬 Add Comment</button>
        </div>
      )}
      <div className="px-3 py-1.5 border-t border-border text-2xs text-muted font-mono truncate" title={filePath}>{filePath}</div>
    </div>
  )
})
