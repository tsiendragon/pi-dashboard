import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { LIVE_SESSION_MAX_IMAGE_BYTES, LIVE_SESSION_MAX_IMAGES, type LiveSessionImage, type LiveSessionModelOption, type LiveSessionStatus } from '@shared/live-sessions'
import { LIVE_SESSION_SLASH_MENU, LIVE_SESSION_TUI_ONLY, type LiveSessionSlashItem } from './liveSessionCommands'
import { clipboardFiles, pastedFileRef, splitFilesByKind } from '../../utils/clipboardFiles'
import { resolveFileRef, uploadAttachedFiles, withAttachedFile, type AttachedFile } from '../../utils/attachmentIntake'

export interface LiveSessionActivity {
  label: string
  tone: 'muted' | 'accent' | 'ok' | 'danger'
  thinkingStartedAt?: number
}

interface LiveSessionComposerProps {
  status: LiveSessionStatus
  activity?: LiveSessionActivity
  disabled?: boolean
  models?: LiveSessionModelOption[]
  currentModel?: { provider: string; id: string }
  modelsLoading?: boolean
  onLoadModels?: () => Promise<void>
  onSelectModel?: (model: LiveSessionModelOption) => Promise<void>
  /** Workspace cwd — used to resolve a pasted file name/path into a real file. */
  cwd?: string
  onSubmit: (text: string, deliverAs?: 'steer' | 'followUp', images?: LiveSessionImage[]) => Promise<void>
}

type PendingImage = LiveSessionImage & { preview: string }

function readImage(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      const comma = dataUrl.indexOf(',')
      const data = comma >= 0 ? dataUrl.slice(comma + 1) : ''
      if (!data) { reject(new Error('图片数据为空')); return }
      resolve({ type: 'image', data, mimeType: file.type, preview: dataUrl })
    }
    reader.readAsDataURL(file)
  })
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function ThinkingElapsed({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === undefined) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === undefined ? null : <span className="font-mono text-2xs text-muted">· {formatElapsed(now - startedAt)}</span>
}

function activityTextClass(tone: LiveSessionActivity['tone']): string {
  if (tone === 'danger') return 'text-danger'
  if (tone === 'accent') return 'text-accent'
  if (tone === 'ok') return 'text-ok'
  return 'text-muted'
}

function AgentActivityBar({ activity }: { activity?: LiveSessionActivity }) {
  if (!activity || activity.label === '等待输入') return null
  const reconnecting = activity.label === '重连中'
  return (
    <div className={`flex min-h-7 items-center gap-2 bg-card/60 px-3 py-1 text-2xs ${activityTextClass(activity.tone)}`} role="status" aria-live="polite" aria-label={`Agent 状态：${activity.label}`}>
      {reconnecting
        ? <span aria-hidden="true">◐</span>
        : <span className="typing-dots shrink-0" aria-hidden="true"><span /><span /><span /></span>}
      <span className="min-w-0 truncate">{activity.label}</span>
      {activity.label === '思考中' && <ThinkingElapsed startedAt={activity.thinkingStartedAt} />}
    </div>
  )
}

export default function LiveSessionComposer({ status, activity, disabled, models = [], currentModel, modelsLoading = false, onLoadModels, onSelectModel, cwd, onSubmit }: LiveSessionComposerProps) {
  const [text, setText] = useState('')
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
  const [fileError, setFileError] = useState<string>()
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const [imageError, setImageError] = useState<string>()
  const [deliverAs, setDeliverAs] = useState<'steer' | 'followUp'>('followUp')
  const [sending, setSending] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [action, setAction] = useState<'model' | undefined>()
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashSelected, setSlashSelected] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const intakeImages = (files: File[]): void => {
    if (files.length === 0) return
    if (pendingImages.length >= LIVE_SESSION_MAX_IMAGES) {
      setImageError(`最多同时发送 ${LIVE_SESSION_MAX_IMAGES} 张图片`)
      return
    }
    void Promise.all(files.slice(0, LIVE_SESSION_MAX_IMAGES - pendingImages.length).map(readImage)).then(images => {
      const oversized = images.find(image => image.data.length > LIVE_SESSION_MAX_IMAGE_BYTES)
      if (oversized) {
        setImageError('图片过大，请粘贴较小的图片后重试（单张不超过 3 MiB）')
        return
      }
      setImageError(undefined)
      setPendingImages(previous => [...previous, ...images].slice(0, LIVE_SESSION_MAX_IMAGES))
    }).catch(error => setImageError(error instanceof Error ? error.message : '图片读取失败'))
  }

  /**
   * Upload files to the dashboard host so the message can carry their paths.
   * Files cannot ride along inside the live-session protocol — only paths can.
   */
  const intakeFiles = (files: File[]): void => {
    if (files.length === 0) return
    setUploadingFiles(true)
    void uploadAttachedFiles(files)
      .then(attached => {
        setFileError(undefined)
        setPendingFiles(previous => attached.reduce(withAttachedFile, previous))
      })
      .catch(() => setFileError('文件上传失败，请重试，或把文件拖到输入框。'))
      .finally(() => setUploadingFiles(false))
  }

  const intakeCandidateFiles = (files: File[]): void => {
    const { images, documents } = splitFilesByKind(files)
    intakeImages(images)
    intakeFiles(documents)
  }

  /** Restore the text the browser would have pasted when nothing resolved. */
  const insertPastedText = (value: string, start: number, end: number): void => {
    if (!value) return
    setText(previous => previous.slice(0, start) + value + previous.slice(end))
    const caret = start + value.length
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) el.setSelectionRange(caret, caret)
    })
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const data = event.clipboardData
    const pastedFiles = clipboardFiles(data)
    if (pastedFiles.length > 0) {
      event.preventDefault()
      intakeCandidateFiles(pastedFiles)
      return
    }

    // Some platforms (macOS browsers most notably) put a copied file on the
    // clipboard as text only — a `file://` URL or the bare file name. Attach it
    // when it exists on the host; otherwise paste the text and say why.
    const pastedText = data.getData('text/plain') ?? ''
    const candidate = pastedFileRef({ uriList: data.getData('text/uri-list'), text: pastedText })
    if (!candidate) return

    const start = inputRef.current?.selectionStart ?? 0
    const end = inputRef.current?.selectionEnd ?? start
    event.preventDefault()
    void resolveFileRef(candidate, cwd).then(resolved => {
      if (resolved) {
        setFileError(undefined)
        setPendingFiles(previous => withAttachedFile(previous, resolved))
        return
      }
      insertPastedText(pastedText.trim() ? pastedText : candidate, start, end)
      const name = candidate.split('/').pop() || candidate
      setFileError(`没能把「${name}」当作附件：剪贴板里只有文件名/路径文本，而 Pi 所在主机上找不到这个文件。请把文件拖到输入框里。`)
    })
  }

  const isFileDrag = (event: React.DragEvent): boolean => Array.from(event.dataTransfer.types).includes('Files')
  const handleDragOver = (event: React.DragEvent): void => {
    if (!isFileDrag(event) || disabled) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const handleDrop = (event: React.DragEvent): void => {
    if (!isFileDrag(event) || disabled) return
    event.preventDefault()
    intakeCandidateFiles(Array.from(event.dataTransfer.files))
  }

  const submit = async (): Promise<void> => {
    const filePrefix = pendingFiles.map(file => file.path).join('\n')
    const typed = [filePrefix, text.trim()].filter(Boolean).join('\n\n')
    const value = typed || (pendingImages.length > 0 ? '请分析这张图片。' : '')
    if (!value || sending || disabled) return
    const images = pendingImages.map(({ preview: _preview, ...image }) => image)
    setSending(true)
    try {
      if (images.length > 0) await onSubmit(value, status === 'running' ? deliverAs : undefined, images)
      else await onSubmit(value, status === 'running' ? deliverAs : undefined)
      setText('')
      setPendingImages([])
      setPendingFiles([])
      setImageError(undefined)
      setFileError(undefined)
    } catch {
      // The page keeps the detailed error; preserve the draft for retry.
    } finally {
      setSending(false)
    }
  }

  const toggleModels = async (): Promise<void> => {
    if (action || disabled) return
    const next = !modelOpen
    setModelOpen(next)
    if (next && models.length === 0 && onLoadModels) {
      setAction('model')
      try { await onLoadModels() } catch {
        // The parent operation reports the actionable error in the session banner.
      } finally { setAction(undefined) }
    }
  }

  const slashQuery = useMemo(() => {
    const match = text.match(/^\/([a-z-]*)$/)
    return match ? (match[1] ?? '') : null
  }, [text])

  const slashMatches = useMemo(() => {
    if (slashQuery === null) return []
    return LIVE_SESSION_SLASH_MENU.filter(item => item.command.slice(1).startsWith(slashQuery))
  }, [slashQuery])

  const slashTuiMatches = useMemo(() => {
    if (slashQuery === null) return []
    return LIVE_SESSION_TUI_ONLY.filter(item => item.command.slice(1).startsWith(slashQuery))
  }, [slashQuery])

  const slashVisible = slashQuery !== null && !slashDismissed && (slashMatches.length > 0 || slashTuiMatches.length > 0)

  useEffect(() => { setSlashSelected(0) }, [slashQuery])

  const applySlashSelect = useCallback((item: LiveSessionSlashItem) => {
    setText(item.insert)
    setSlashDismissed(true)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) { el.focus(); const end = el.value.length; el.setSelectionRange(end, end) }
    })
  }, [])

  useEffect(() => {
    if (!slashVisible) return
    const onKey = (event: KeyboardEvent) => {
      if (slashMatches.length > 0) {
        if (event.key === 'ArrowDown') { event.preventDefault(); setSlashSelected(i => (i + 1) % slashMatches.length); return }
        if (event.key === 'ArrowUp') { event.preventDefault(); setSlashSelected(i => (i - 1 + slashMatches.length) % slashMatches.length); return }
        if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); applySlashSelect(slashMatches[slashSelected >= slashMatches.length ? 0 : slashSelected]); return }
      }
      if (event.key === 'Escape') { event.preventDefault(); setSlashDismissed(true); inputRef.current?.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [slashVisible, slashMatches, slashSelected, applySlashSelect])

  return (
    <>
      <AgentActivityBar activity={activity} />
      <div className="border-t border-border bg-card p-2" onDragOver={handleDragOver} onDrop={handleDrop}>
        {pendingFiles.length > 0 && <div className="mb-2 flex flex-wrap gap-2" aria-label="待发送文件">
          {pendingFiles.map((file, index) => <div key={`${file.path}-${index}`} className="group flex items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1 text-2xs text-text">
            <span aria-hidden="true">📄</span>
            <span className="max-w-52 truncate" title={file.path}>{file.name}</span>
            <button type="button" onClick={() => setPendingFiles(previous => previous.filter((_, itemIndex) => itemIndex !== index))} className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-none bg-danger text-2xs text-danger-fg opacity-60 transition-opacity hover:opacity-100" aria-label={`移除文件 ${file.name}`}>×</button>
          </div>)}
        </div>}
        {uploadingFiles && <div className="mb-2 text-2xs text-muted" role="status">文件上传中…</div>}
        {fileError && <div className="mb-2 text-2xs text-danger" role="alert">{fileError}</div>}
        {pendingImages.length > 0 && <div className="mb-2 flex flex-wrap gap-2" aria-label="待发送图片">
          {pendingImages.map((image, index) => <div key={`${image.mimeType}-${index}`} className="group relative">
            <img src={image.preview} alt={`待发送图片 ${index + 1}`} className="h-16 max-w-28 rounded-md border border-border object-cover" />
            <button type="button" onClick={() => setPendingImages(previous => previous.filter((_, itemIndex) => itemIndex !== index))} className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-none bg-danger text-2xs text-danger-fg opacity-60 transition-opacity hover:opacity-100" aria-label={`移除第 ${index + 1} 张图片`}>×</button>
          </div>)}
        </div>}
        {imageError && <div className="mb-2 text-2xs text-danger" role="alert">{imageError}</div>}
        <div className="flex gap-2 items-end">
        <textarea
          ref={inputRef}
          value={text}
          onChange={event => { setText(event.target.value); setSlashDismissed(false) }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.defaultPrevented && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
          disabled={disabled}
          maxLength={128 * 1024}
          rows={1}
          onPaste={handlePaste}
          placeholder={pendingFiles.length > 0 ? '补充文件说明，或直接发送…' : pendingImages.length > 0 ? '补充图片说明，或直接发送…' : '发送到运行中的 Pi…'}
          className="min-h-9 flex-1 resize-none rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm text-text shadow-inner outline-none focus-ring disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || sending || uploadingFiles}
          aria-label="选择文件"
          title="选择文件（会上传到 Pi 所在主机，再把路径发给 Pi）"
          className="h-8 w-8 shrink-0 rounded-lg border border-border bg-bg text-sm text-muted transition hover:border-accent hover:text-accent disabled:opacity-40"
        >
          {uploadingFiles ? '⏳' : '📎'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={event => {
            intakeCandidateFiles(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
        {status === 'running' && (
          <select value={deliverAs} onChange={event => setDeliverAs(event.target.value as 'steer' | 'followUp')} className="h-8 rounded-lg border border-border bg-bg px-2 text-2xs text-text">
            <option value="followUp">追加</option>
            <option value="steer">插话（改方向）</option>
          </select>
        )}
        <div className="relative">
          <button type="button" onClick={() => { void toggleModels() }} disabled={sending || !!action || disabled} className="h-8 max-w-48 truncate rounded-lg border border-border bg-bg px-2 text-2xs text-muted hover:border-accent hover:text-accent disabled:opacity-50" title="切换当前模型">
            {currentModel ? `模型 · ${currentModel.id}` : '模型'}
          </button>
          {modelOpen && <div className="absolute bottom-full right-0 z-50 mb-2 max-h-72 w-[min(360px,calc(100vw-2rem))] overflow-auto rounded-lg border border-border bg-card p-2 shadow-xl">
            <div className="mb-1 px-1 text-2xs font-semibold text-muted">当前 Pi 可用模型</div>
            {modelsLoading && <div className="px-2 py-3 text-xs text-muted">读取模型列表…</div>}
            {!modelsLoading && models.length === 0 && <div className="px-2 py-3 text-xs text-muted">当前没有可用模型。</div>}
            {!modelsLoading && models.map(model => {
              const selected = currentModel?.provider === model.provider && currentModel.id === model.id
              return <button key={`${model.provider}/${model.id}`} type="button" onClick={() => { setModelOpen(false); if (onSelectModel) { setAction('model'); void onSelectModel(model).finally(() => setAction(undefined)) } }} className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-bg-hover ${selected ? 'bg-accent-subtle' : ''}`}>
                <span className={`mt-0.5 text-xs ${selected ? 'text-accent' : 'text-muted'}`}>{selected ? '✓' : '○'}</span>
                <span className="min-w-0 flex-1"><span className="block truncate font-mono text-2xs text-text-strong">{model.provider}/{model.id}</span><span className="block truncate text-2xs text-muted">{model.name} · context {model.contextWindow.toLocaleString()}</span></span>
              </button>
            })}
          </div>}
        </div>
        <button type="button" onClick={() => void submit()} disabled={(!text.trim() && pendingImages.length === 0 && pendingFiles.length === 0) || sending || !!action || disabled} className="h-8 px-3 rounded-lg bg-accent text-accent-fg border-none text-xs disabled:opacity-50">
          {sending ? '发送中…' : '发送'}
        </button>
        </div>
      </div>
      {slashVisible && inputRef.current && createPortal((() => {
        const rect = inputRef.current!.getBoundingClientRect()
        const rows = slashMatches.length + slashTuiMatches.length
        const menuHeight = Math.min(rows * 38 + 8, 400)
        const top = rect.top - menuHeight - 4 > 0 ? rect.top - menuHeight - 4 : rect.bottom + 4
        return (
          <div className="fixed z-[9999] overflow-y-auto rounded-lg border border-border bg-card py-1 shadow-lg animate-slide-up" style={{ top, left: rect.left, width: Math.min(rect.width, 440), maxHeight: 400 }}>
            {slashMatches.map((item, index) => (
              <button key={item.command} type="button" onMouseEnter={() => setSlashSelected(index)} onMouseDown={event => { event.preventDefault(); applySlashSelect(item) }} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${index === slashSelected ? 'bg-accent-subtle' : 'hover:bg-bg-hover'}`}>
                <span className="shrink-0 font-mono text-body-s font-semibold text-accent">{item.command}</span>
                <span className="min-w-0 flex-1 truncate text-meta text-text">{item.description}</span>
                {item.kind === 'lease' && <span className="shrink-0 rounded-full bg-warn-subtle px-1.5 py-0.5 text-2xs font-semibold text-warn">需控制</span>}
              </button>
            ))}
            {slashTuiMatches.length > 0 && slashMatches.length > 0 && <div className="my-1 border-t border-border" />}
            {slashTuiMatches.map(item => (
              <div key={item.command} className="flex items-center gap-2 px-3 py-1.5 opacity-60">
                <span className="shrink-0 font-mono text-body-s font-semibold text-muted">{item.command}</span>
                <span className="min-w-0 flex-1 truncate text-meta text-muted">{item.description}</span>
                <span className="shrink-0 rounded-full bg-bg-elevated px-1.5 py-0.5 text-2xs font-semibold text-muted">仅 TUI</span>
              </div>
            ))}
          </div>
        )
      })(), document.body)}
    </>
  )
}
