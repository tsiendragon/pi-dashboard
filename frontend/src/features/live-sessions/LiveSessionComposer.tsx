import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { LIVE_SESSION_MAX_IMAGES, type LiveSessionImage, type LiveSessionModelOption, type LiveSessionStatus } from '@shared/live-sessions'
import { buildQuoteReplyMessage, selectionLabel, type QuotedText } from '../../utils/reviewComments'
import { LIVE_SESSION_SLASH_MENU, LIVE_SESSION_TUI_ONLY, type LiveSessionSlashItem } from './liveSessionCommands'
import { MaterialIcon } from '../../components/MaterialIcon'
import { loadTtsSettings, subscribeTtsSettings } from '../voice/ttsSettings'
import { useVoiceInput } from '../voice/useVoiceInput'
import { clipboardFiles, pastedFileRef, splitFilesByKind } from '../../utils/clipboardFiles'
import { resolveFileRef, uploadAttachedFiles, withAttachedFile, type AttachedFile } from '../../utils/attachmentIntake'
import { formatBytes, imageBudgetForCount, prepareImageForAttach, type PreparedImage } from '../../utils/imageResize'

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
  /** Owning live session id — keeps an unsent draft scoped to one session. */
  sessionKey?: string
  /** Thinking level (effort) the session currently runs at, e.g. `medium`. */
  currentThinkingLevel?: string
  /** Change the session's thinking level (effort) — pi's `/effort` command. */
  onSelectThinkingLevel?: (level: string) => Promise<void>
  /** Interrupt the running turn (claims the lease first). Omit to hide the control. */
  onInterrupt?: () => void
  /** An interrupt is in flight. */
  interrupting?: boolean
  onSubmit: (text: string, deliverAs?: 'steer' | 'followUp', images?: LiveSessionImage[]) => Promise<void>
  /** Quoted sentences from the transcript, sent together with the next message. */
  quotes?: QuotedText[]
  onRemoveQuote?: (id: string) => void
  onClearQuotes?: () => void
}

type PendingImage = LiveSessionImage & PreparedImage

/** Downscale oversized pastes instead of rejecting them (see utils/imageResize). */
async function readImage(file: File, budgetBytes: number): Promise<PendingImage> {
  const prepared = await prepareImageForAttach(file, budgetBytes)
  return { type: 'image', ...prepared }
}

interface ComposerDraft {
  text: string
  images: PendingImage[]
  files: AttachedFile[]
  deliverAs: 'steer' | 'followUp'
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

/** Compact context size for the model picker: 1M / 262K / 128K. */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

function AgentActivityBar({ activity }: { activity?: LiveSessionActivity }) {
  if (!activity || activity.label === '等待输入') return null
  const reconnecting = activity.label === '重连中'
  return (
    <div className={`flex min-h-7 items-center gap-2 bg-card px-3 py-1 text-2xs ${activityTextClass(activity.tone)}`} role="status" aria-live="polite" aria-label={`Agent 状态：${activity.label}`}>
      {reconnecting
        ? <span aria-hidden="true">◐</span>
        : <span className="typing-dots shrink-0" aria-hidden="true"><span /><span /><span /></span>}
      <span className="min-w-0 truncate">{activity.label}</span>
      {activity.label === '思考中' && <ThinkingElapsed startedAt={activity.thinkingStartedAt} />}
    </div>
  )
}

export default function LiveSessionComposer({ status, activity, disabled, models = [], currentModel, modelsLoading = false, onLoadModels, onSelectModel, cwd, sessionKey, currentThinkingLevel, onSelectThinkingLevel, onInterrupt, interrupting = false, onSubmit, quotes, onRemoveQuote, onClearQuotes }: LiveSessionComposerProps) {
  const [text, setText] = useState('')
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
  const [imageError, setImageError] = useState<string>()
  const [fileError, setFileError] = useState<string>()
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const [deliverAs, setDeliverAs] = useState<'steer' | 'followUp'>('followUp')
  const [sending, setSending] = useState(false)
  const [resizingImages, setResizingImages] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  const [modelCursor, setModelCursor] = useState(0)
  const [action, setAction] = useState<'model' | 'effort' | undefined>()
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashSelected, setSlashSelected] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const selectedModelRef = useRef<HTMLButtonElement>(null)

  // Per-session draft: the composer is reused across live sessions, so an unsent
  // draft must be stashed under the previous session and restored for the next one.
  const draftsRef = useRef<Map<string, ComposerDraft>>(new Map())
  const activeDraftRef = useRef<ComposerDraft>({ text: '', images: [], files: [], deliverAs: 'followUp' })
  const composerKeyRef = useRef(sessionKey)
  useEffect(() => {
    activeDraftRef.current = { text, images: pendingImages, files: pendingFiles, deliverAs }
  })
  useEffect(() => {
    const previousKey = composerKeyRef.current
    if (!sessionKey || sessionKey === previousKey) return
    if (previousKey) draftsRef.current.set(previousKey, activeDraftRef.current)
    const saved = draftsRef.current.get(sessionKey)
    setText(saved?.text ?? '')
    setPendingImages(saved?.images ?? [])
    setPendingFiles(saved?.files ?? [])
    setDeliverAs(saved?.deliverAs ?? 'followUp')
    setImageError(undefined)
    setFileError(undefined)
    setSlashDismissed(false)
    composerKeyRef.current = sessionKey
  }, [sessionKey])

  // Voice input (speech-to-text). Language follows Settings → Voice unless set.
  const [voiceSettings, setVoiceSettings] = useState(loadTtsSettings)
  useEffect(() => subscribeTtsSettings(() => setVoiceSettings(loadTtsSettings())), [])
  const voiceInput = useVoiceInput({
    language: voiceSettings.sttLanguage,
    onTranscript: text => { setText(text); setSlashDismissed(false) },
  })

  const intakeImages = (files: File[]): void => {
    if (files.length === 0) return
    const room = LIVE_SESSION_MAX_IMAGES - pendingImages.length
    if (room <= 0) {
      setImageError(`最多同时发送 ${LIVE_SESSION_MAX_IMAGES} 张图片`)
      return
    }
    const incoming = files.slice(0, room)
    const budget = imageBudgetForCount(pendingImages.length + incoming.length)
    setResizingImages(true)
    void Promise.all(incoming.map(file => readImage(file, budget))).then(images => {
      setImageError(undefined)
      setPendingImages(previous => [...previous, ...images].slice(0, LIVE_SESSION_MAX_IMAGES))
    }).catch(error => setImageError(error instanceof Error ? error.message : '图片读取失败'))
      .finally(() => setResizingImages(false))
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
    const quotePrefix = buildQuoteReplyMessage(quotes ?? [])
    const typed = [filePrefix, quotePrefix, text.trim()].filter(Boolean).join('\n\n')
    const value = typed || (pendingImages.length > 0 ? '请分析这张图片。' : '')
    if (!value || sending || disabled) return
    const images = pendingImages.map(image => ({ type: image.type, data: image.data, mimeType: image.mimeType }))
    setSending(true)
    try {
      if (images.length > 0) await onSubmit(value, status === 'running' ? deliverAs : undefined, images)
      else await onSubmit(value, status === 'running' ? deliverAs : undefined)
      setText('')
      setPendingImages([])
      setPendingFiles([])
      onClearQuotes?.()
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

  // Thinking levels (effort) the current model can run at; empty hides the row.
  const effortLevels = useMemo(() => {
    const option = models.find(model => model.provider === currentModel?.provider && model.id === currentModel?.id)
    return option?.thinkingLevels ?? []
  }, [models, currentModel])

  // Model picker: filterable, provider-grouped, and drivable from the keyboard.
  const pickerModels = useMemo(() => {
    const needle = modelQuery.trim().toLowerCase()
    if (!needle) return models
    return models.filter(model => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle))
  }, [models, modelQuery])

  const pickerGroups = useMemo(() => {
    const groups = new Map<string, { model: LiveSessionModelOption; index: number }[]>()
    pickerModels.forEach((model, index) => {
      const bucket = groups.get(model.provider) ?? []
      bucket.push({ model, index })
      groups.set(model.provider, bucket)
    })
    return [...groups.entries()]
  }, [pickerModels])

  const chooseModel = (model: LiveSessionModelOption): void => {
    setModelOpen(false)
    if (!onSelectModel) return
    setAction('model')
    void onSelectModel(model).finally(() => setAction(undefined))
  }

  // Opening the picker starts a fresh search and puts the cursor on the model in use.
  useEffect(() => {
    if (!modelOpen) return
    setModelQuery('')
    const index = models.findIndex(model => model.provider === currentModel?.provider && model.id === currentModel?.id)
    setModelCursor(index >= 0 ? index : 0)
    const frame = requestAnimationFrame(() => {
      // jsdom has no scrollIntoView; a real browser does.
      const node = selectedModelRef.current
      if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
    // Reopening resets the picker; the model list arriving mid-open must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelOpen])

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
        {(quotes?.length ?? 0) > 0 && <div className="mb-2 flex flex-wrap gap-2" aria-label="待发送引用">
          {(quotes ?? []).map(quote => <div key={quote.id} className="flex min-w-0 items-center gap-1.5 rounded-md border border-accent/40 bg-accent-subtle px-2 py-1 text-2xs text-text">
            <span aria-hidden="true">↩</span>
            <span className="max-w-72 truncate" title={quote.text}>{quote.text}</span>
            <span className="shrink-0 text-muted">{selectionLabel(quote.role)}</span>
            <button type="button" onClick={() => onRemoveQuote?.(quote.id)} className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-none bg-danger text-2xs text-danger-fg opacity-60 transition-opacity hover:opacity-100" aria-label={`移除引用：${quote.text.slice(0, 24)}`}>×</button>
          </div>)}
        </div>}
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
            {image.resized && <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-2xs text-white" title={`原图 ${formatBytes(image.originalBytes ?? 0)} 过大，已自动压缩到 ${image.width}×${image.height}（约 ${formatBytes(Math.round((image.bytes ?? 0) * 0.75))}）`}>已压缩</span>}
            <button type="button" onClick={() => setPendingImages(previous => previous.filter((_, itemIndex) => itemIndex !== index))} className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-none bg-danger text-2xs text-danger-fg opacity-60 transition-opacity hover:opacity-100" aria-label={`移除第 ${index + 1} 张图片`}>×</button>
          </div>)}
        </div>}
        {resizingImages && <div className="mb-2 flex items-center gap-1.5 text-2xs text-muted" role="status"><MaterialIcon name="sync" spin className="h-3.5 w-3.5" />图片过大，正在压缩…</div>}
        {imageError && <div className="mb-2 text-2xs text-danger" role="alert">{imageError}</div>}
        {voiceInput.transcribing && <div className="mb-2 flex items-center gap-1.5 text-2xs text-accent" role="status"><MaterialIcon name="sync" spin className="h-3.5 w-3.5" />正在识别语音…</div>}
        {voiceInput.error && <div className="mb-2 flex items-center gap-2 text-2xs text-danger" role="alert">
          <span className="min-w-0 flex-1">{voiceInput.error}</span>
          <button type="button" onClick={voiceInput.clearError} className="shrink-0 rounded border border-border bg-bg px-1.5 py-0.5 text-muted">关闭</button>
        </div>}
        <div className="flex items-end gap-1 rounded-xl border border-border bg-bg-elevated px-2 py-1 transition-[border-color,box-shadow] has-[:focus-visible]:border-accent has-[:focus-visible]:shadow-[0_0_0_3px_var(--accent-subtle)]">
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
          placeholder={(quotes?.length ?? 0) > 0 ? '针对引用的说明…' : pendingFiles.length > 0 ? '补充文件说明，或直接发送…' : pendingImages.length > 0 ? '补充图片说明，或直接发送…' : '发送到运行中的 Pi…'}
          className="min-h-9 flex-1 resize-none border-none bg-transparent px-2 py-2 text-sm text-text outline-none [&:focus-visible]:outline-none placeholder:text-muted disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || sending || uploadingFiles}
          aria-label="选择文件"
          title="选择文件（会上传到 Pi 所在主机，再把路径发给 Pi）"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-none bg-transparent text-muted transition hover:bg-bg-hover hover:text-text disabled:opacity-40"
        >
          {uploadingFiles ? <MaterialIcon name="sync" spin className="h-4 w-4" /> : <MaterialIcon name="attach_file" className="h-4 w-4" />}
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
        <button
          type="button"
          onClick={() => { setSlashDismissed(false); voiceInput.toggle() }}
          disabled={disabled || sending || voiceInput.transcribing}
          aria-pressed={voiceInput.listening}
          aria-label={voiceInput.listening ? '停止录音并识别' : '开始语音输入'}
          title={voiceInput.supported
            ? (voiceInput.listening ? '正在录音…点一下结束并识别' : '语音输入：点一下开始录音，再点一下结束并识别')
            : '当前浏览器不支持录音（需要支持 MediaRecorder 的浏览器）'}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-none transition disabled:opacity-40 ${voiceInput.listening
            ? 'bg-danger text-danger-fg animate-pulse'
            : voiceInput.supported
              ? 'bg-transparent text-muted hover:bg-bg-hover hover:text-text'
              : 'bg-transparent text-muted opacity-50'}`}
        >
          {voiceInput.transcribing
            ? <MaterialIcon name="sync" spin className="h-4 w-4" />
            : <MaterialIcon name={voiceInput.listening ? 'stop' : 'mic'} className="h-4 w-4" />}
        </button>
        {status === 'running' && (
          <select value={deliverAs} onChange={event => setDeliverAs(event.target.value as 'steer' | 'followUp')} className="h-9 rounded-full border-none bg-transparent px-2 text-2xs text-muted transition hover:bg-bg-hover hover:text-text">
            <option value="followUp">追加</option>
            <option value="steer">插话（改方向）</option>
          </select>
        )}
        <div className="relative">
          <button type="button" onClick={() => { void toggleModels() }} disabled={sending || !!action || disabled} className="flex h-9 max-w-56 items-center gap-1.5 rounded-full border-none bg-transparent px-2 text-2xs text-muted transition hover:bg-bg-hover hover:text-text disabled:opacity-50" title="切换当前模型">
            <MaterialIcon name="tune" className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{currentModel ? currentModel.id : '模型'}{currentThinkingLevel ? ` · ${currentThinkingLevel}` : ''}</span>
            <MaterialIcon name="keyboard_arrow_up" className="h-3.5 w-3.5 shrink-0" />
          </button>
          {modelOpen && <div className="absolute bottom-full right-0 z-50 mb-2 flex max-h-[min(28rem,70vh)] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden overscroll-contain rounded-xl border border-border bg-card shadow-xl">
            {effortLevels.length > 0 && <div className="border-b border-border px-3 py-2">
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-2xs font-semibold text-muted">思考强度（effort）</span>
                <span className="font-mono text-2xs text-muted/70">{currentThinkingLevel ?? '未知'}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {effortLevels.map(level => {
                  const active = level === currentThinkingLevel
                  return <button
                    key={level}
                    type="button"
                    aria-pressed={active}
                    disabled={!!action || sending || disabled}
                    onClick={() => { if (active || !onSelectThinkingLevel) return; setAction('effort'); void onSelectThinkingLevel(level).finally(() => setAction(undefined)) }}
                    title={active ? `当前思考强度：${level}` : `把思考强度设为 ${level}`}
                    className={`rounded-md border px-2 py-0.5 font-mono text-2xs transition disabled:opacity-50 ${active ? 'border-accent bg-accent-subtle text-accent' : 'border-border bg-bg text-muted hover:border-accent hover:text-accent'}`}
                  >{level}</button>
                })}
              </div>
            </div>}
            <div className="border-b border-border p-2">
              <input
                autoFocus
                value={modelQuery}
                onChange={event => { setModelQuery(event.target.value); setModelCursor(0) }}
                onKeyDown={event => {
                  if (event.key === 'Escape') { event.stopPropagation(); setModelOpen(false); return }
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    if (pickerModels.length === 0) return
                    setModelCursor(current => (current + (event.key === 'ArrowDown' ? 1 : pickerModels.length - 1)) % pickerModels.length)
                    return
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    const model = pickerModels[modelCursor]
                    if (model) chooseModel(model)
                  }
                }}
                placeholder="搜索模型或 provider…"
                aria-label="搜索模型"
                className="w-full rounded-md border border-border bg-bg px-2 py-1 text-xs text-text outline-none placeholder:text-muted/70 focus:border-accent"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {modelsLoading && <div className="px-2 py-3 text-xs text-muted">读取模型列表…</div>}
              {!modelsLoading && models.length === 0 && <div className="px-2 py-3 text-xs text-muted">当前没有可用模型。</div>}
              {!modelsLoading && models.length > 0 && pickerModels.length === 0 && <div className="px-2 py-3 text-xs text-muted">没有匹配「{modelQuery}」的模型。</div>}
              {!modelsLoading && pickerGroups.map(([provider, items]) => (
                <div key={provider} className="mb-1 last:mb-0">
                  <div className="px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-muted/60">{provider}</div>
                  {items.map(({ model, index }) => {
                    const selected = currentModel?.provider === model.provider && currentModel.id === model.id
                    return <button
                      key={`${model.provider}/${model.id}`}
                      ref={selected ? selectedModelRef : undefined}
                      type="button"
                      onMouseEnter={() => setModelCursor(index)}
                      onClick={() => chooseModel(model)}
                      title={`${model.provider}/${model.id}`}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition ${selected ? 'bg-accent-subtle' : index === modelCursor ? 'bg-bg-hover' : ''}`}
                    >
                      <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[9px] leading-none ${selected ? 'border-accent bg-accent text-accent-fg' : 'border-border text-transparent'}`}>✓</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className={`truncate text-xs font-medium ${selected ? 'text-accent' : 'text-text-strong'}`}>{model.name}</span>
                          {model.thinkingLevels.length > 0 && <span className="shrink-0 rounded bg-bg px-1 font-mono text-2xs text-muted/80" title={`支持的思考档位：${model.thinkingLevels.join(' / ')}`}>{model.thinkingLevels.join(' · ')}</span>}
                        </span>
                        <span className="block truncate font-mono text-2xs text-muted">{model.provider}/{model.id}</span>
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-2xs text-muted" title={`context ${model.contextWindow.toLocaleString()} tokens`}>{formatContextWindow(model.contextWindow)}</span>
                    </button>
                  })}
                </div>
              ))}
            </div>
          </div>}
        </div>
        <button type="button" onClick={() => void submit()} disabled={(!text.trim() && pendingImages.length === 0 && pendingFiles.length === 0 && (quotes?.length ?? 0) === 0) || sending || !!action || disabled} aria-label="发送" title="发送（Enter）" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-none bg-accent text-accent-fg transition disabled:opacity-40">
          {sending ? <MaterialIcon name="sync" spin className="h-4 w-4" /> : <MaterialIcon name="send" className="h-4 w-4" />}
        </button>
        {/* Interrupt lives next to send: it is the one control you reach for while
            the agent is working, and it used to be two clicks away in the header. */}
        {status === 'running' && onInterrupt && (
          <button
            type="button"
            onClick={() => onInterrupt()}
            disabled={interrupting}
            aria-label="中止当前回合"
            title="中止当前回合：Pi 会停下来，已完成的步骤保留（不是可恢复的暂停）"
            className="flex h-9 shrink-0 items-center gap-1 rounded-full border border-danger bg-danger-subtle px-3 text-body-s text-danger transition hover:bg-danger hover:text-danger-fg disabled:opacity-50 sm:px-3.5"
          >
            <MaterialIcon name={interrupting ? 'sync' : 'pause'} spin={interrupting} className="h-4 w-4" />
            <span className="hidden sm:inline">{interrupting ? '中止中…' : '中止'}</span>
          </button>
        )}
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
