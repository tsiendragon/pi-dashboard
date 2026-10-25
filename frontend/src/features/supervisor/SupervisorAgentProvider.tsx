import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { LIVE_SESSION_MAX_IMAGE_BYTES, LIVE_SESSION_MAX_IMAGES, LIVE_SESSION_MAX_IMAGE_TOTAL_BYTES } from '../../../../shared/src/live-sessions'
import type { SupervisorAttachment } from '../../../../shared/src/supervisor'
import MarkdownRenderer from '../../components/MarkdownRenderer'
import { useAppDispatch, useAppSelector } from '../../store'
import { liveSessionSnapshot } from '../../store/liveSessionsSlice'
import { supervisorApi, errorText, type SupervisorImage } from './api'
import { useSupervisorResource } from './useSupervisorResource'
import { buttonClass, ConfigSummary, missingResources, ObjectLink, SupervisorFailure } from './SupervisorViews'
import { conversationMessages } from './conversation'
import SupervisorNotifications from './SupervisorNotifications'

export interface SupervisorAgentOpenOptions { objectRef?: string; prompt?: string }
interface SupervisorAgentContext { open: (options?: SupervisorAgentOpenOptions) => void }
const AgentContext = createContext<SupervisorAgentContext | null>(null)
export function useSupervisorAgent() {
  const value = useContext(AgentContext)
  if (!value) throw new Error('SupervisorAgentProvider is required')
  return value
}
export function SupervisorAgentProvider({ children }: { children: ReactNode }) {
  const inherited = useContext(AgentContext)
  return inherited ? <>{children}</> : <AgentRoot>{children}</AgentRoot>
}
export function SupervisorAgentButton({ objectRef, prompt, children = '询问主管', className = buttonClass }: SupervisorAgentOpenOptions & { children?: ReactNode; className?: string }) {
  const agent = useSupervisorAgent()
  return <button type="button" className={className} onClick={() => agent.open({ objectRef, prompt })}>{children}</button>
}
export function SupervisorAgentSidebarButton({ className }: { className?: string }) {
  const agent = useContext(AgentContext)
  if (!agent) return null // Native session toolbar also runs independently of the supervisor workspace.
  return <button type="button" aria-label="打开主 Agent" title="打开全局主 Agent 对话" className={className} onClick={() => agent.open()}><svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 shrink-0 fill-none stroke-current" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" /></svg></button>
}
export function SupervisorNotificationsSidebarButton({ className }: { className?: string }) {
  const agent = useContext(AgentContext)
  return agent ? <SupervisorNotifications className={className} openAgent={agent.open} /> : null
}
interface Upload { key: number; file: File; image?: SupervisorImage; attachment?: SupervisorAttachment; error?: string; uploading: boolean }
function imageData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('无法读取图片：' + file.name))
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.readAsDataURL(file)
  })
}
function AgentRoot({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false)
  const [objectRef, setObjectRef] = useState<string>()
  const [draft, setDraft] = useState('')
  const [uploads, setUploads] = useState<Upload[]>([])
  const [pending, setPending] = useState<'starting' | 'sending' | 'clearing'>()
  const [error, setError] = useState<unknown>()
  const [notice, setNotice] = useState('')
  const [startedPid, setStartedPid] = useState<string>()
  const dialog = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const uploadSequence = useRef(0)
  const operationLock = useRef(false)
  const uploadLock = useRef(false)
  const previousFocus = useRef<HTMLElement | null>(null)
  const dispatch = useAppDispatch()
  const state = useSupervisorResource(supervisorApi.state, visible)
  const config = useSupervisorResource(supervisorApi.config, visible, 0)
  const detail = useSupervisorResource(supervisorApi.detail, visible && !!(state.data?.agent.connected || startedPid))
  const pid = detail.data?.summary.processInstanceId || state.data?.agent.processInstanceId || startedPid
  const liveDetail = useAppSelector(store => pid ? store.liveSessions.details[pid] : undefined)
  const liveError = useAppSelector(store => store.liveSessions.error)
  const pendingUi = useAppSelector(store => pid ? store.liveSessions.pendingUi[pid] : undefined)
  const currentDetail = liveDetail || detail.data
  const transcript = conversationMessages(currentDetail?.entries || [])
  const messages = transcript.messages
  const waitingConfirmation = pendingUi !== undefined ? Object.keys(pendingUi).length > 0 : !!detail.data?.pendingUi?.length
  const agentBusy = waitingConfirmation || currentDetail?.summary.status === 'running' || currentDetail?.summary.claim.state === 'claimed'
  const close = useCallback(() => setVisible(false), [])
  const open = useCallback((options: SupervisorAgentOpenOptions = {}) => {
    if (!visible) previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setObjectRef(options.objectRef)
    if (options.prompt) setDraft(current => current && current !== options.prompt ? current + '\n\n' + options.prompt : options.prompt!)
    setVisible(true)
  }, [visible])
  useEffect(() => { if (detail.data && visible) dispatch(liveSessionSnapshot(detail.data)) }, [detail.data, dispatch, visible])
  useEffect(() => {
    if (!visible) return
    composer.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const keydown = (event: KeyboardEvent) => {
      const node = dialog.current
      if (!node) return
      // The existing global extension confirmation is a separate, higher dialog.
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-supervisor-dialog])')) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      if (event.key !== 'Tab') return
      const focusable = Array.from(node.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]'))
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (!first) { event.preventDefault(); node.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      document.body.style.overflow = previousOverflow
      previousFocus.current?.focus()
    }
  }, [visible, close])
  const retry = () => { setError(undefined); state.refresh(); config.refresh(); detail.refresh() }
  const uploadOne = async (item: Upload) => {
    setUploads(current => current.map(upload => upload.key === item.key ? { ...upload, uploading: true, error: undefined } : upload))
    try {
      const data = item.image?.data || await imageData(item.file)
      const image: SupervisorImage = { type: 'image', mimeType: item.file.type, data }
      const attachment = await supervisorApi.upload({ name: item.file.name, mime: image.mimeType, data })
      setUploads(current => current.map(upload => upload.key === item.key ? { ...upload, image, attachment, uploading: false } : upload))
    } catch (failure) {
      setUploads(current => current.map(upload => upload.key === item.key ? { ...upload, error: errorText(failure), uploading: false } : upload))
      setError(failure)
    }
  }
  const uploadFiles = async (files: File[]) => {
    if (uploadLock.current || operationLock.current) return
    const images = files.filter(file => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    if (images.length !== files.length) { setError(new Error('仅接受 PNG、JPEG 或 WebP 截图。')); return }
    if (uploads.length + images.length > LIVE_SESSION_MAX_IMAGES || images.some(file => file.size > LIVE_SESSION_MAX_IMAGE_BYTES) || [...uploads.map(upload => upload.file), ...images].reduce((sum, file) => sum + file.size, 0) > LIVE_SESSION_MAX_IMAGE_TOTAL_BYTES) {
      setError(new Error('最多 4 张图片；单张不超过 3 MB，总计不超过 6 MB。')); return
    }
    uploadLock.current = true
    const items = images.map(file => ({ key: ++uploadSequence.current, file, uploading: true }))
    setUploads(current => [...current, ...items])
    try { for (const item of items) await uploadOne(item) } finally { uploadLock.current = false }
  }
  const enabled = !!state.data?.enabled && !!config.data?.enabled && !state.error && !config.error
  const staleResources = state.data?.agent.resourceState === 'pending'
  // A stale resource fingerprint blocks starting only while the old main session is still running:
  // ending it is a manual user decision, while a dead/never-connected session must not dead-lock the button.
  const oldSessionRunning = !!state.data?.agent.connected
  const canStart = enabled && !missingResources(config.data).length && !pending && !state.loading && !(staleResources && oldSessionRunning)
  const ready = enabled && !state.loading && !!state.data?.agent.connected && state.data.agent.resourceState === 'loaded'
  const start = async () => {
    if (operationLock.current || !canStart) return
    operationLock.current = true; setPending('starting'); setError(undefined); setNotice('')
    try {
      const result = await supervisorApi.start()
      setStartedPid(result.processInstanceId)
      setNotice('启动请求已确认，会话：' + result.sessionId + '；等待资源状态加载完成。')
      state.refresh(); detail.refresh()
    } catch (failure) { setError(failure) }
    finally { operationLock.current = false; setPending(undefined) }
  }
  const clear = async () => {
    if (operationLock.current || !ready || agentBusy) return
    operationLock.current = true; setPending('clearing'); setError(undefined); setNotice('')
    try {
      const result = await supervisorApi.clear()
      setStartedPid(result.processInstanceId)
      setDraft(''); setUploads([])
      setNotice('聊天上下文已清空，主助手已自动重新加载；任务、事件和截图均已保留。')
      state.refresh(); detail.refresh()
    } catch (failure) { setError(failure); state.refresh(); detail.refresh() }
    finally { operationLock.current = false; setPending(undefined) }
  }
  const send = async () => {
    if (operationLock.current || !ready || agentBusy || !draft.trim() || uploads.some(upload => !upload.attachment || upload.uploading)) return
    operationLock.current = true; setPending('sending'); setError(undefined); setNotice('')
    try {
      const result = await supervisorApi.input({ text: draft, objectRef, ...(uploads.length ? { images: uploads.map(upload => upload.image!), attachmentIds: uploads.map(upload => upload.attachment!.id) } : {}) })
      if (result.ok !== true) throw new Error('后端未确认消息已接收。')
      setDraft(''); setUploads([]); setNotice('消息已接收，等待主管回复。')
      detail.refresh(); state.refresh()
    } catch (failure) { setError(failure) }
    finally { operationLock.current = false; setPending(undefined) }
  }
  return <AgentContext.Provider value={{ open }}>{children}{visible && createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-2 sm:p-6">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="supervisor-agent-title" data-supervisor-dialog tabIndex={-1} className="flex w-full max-w-[960px] max-h-[94dvh] flex-col rounded-xl border border-border bg-bg-elevated shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div><h2 id="supervisor-agent-title" className="font-semibold text-lg">工作主管 Agent</h2><p className="text-muted text-body-s">唯一主会话 · {objectRef ? <ObjectLink uid={objectRef} /> : '全局授权范围'}</p></div>
          <button className={buttonClass} onClick={close} aria-label="关闭主管弹窗">关闭</button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
          <p role="status" className="text-body-s">{pending === 'clearing' ? '正在清空并重新加载主助手…' : pending === 'starting' ? '正在启动主管…' : pending === 'sending' ? '正在发送…' : state.loading && !state.data ? '正在获取主管状态…' : state.data ? '资源状态：' + state.data.agent.resourceState + (state.data.agent.connected ? ' · 已连接' : ' · 未连接') : '状态未知'}</p>
          {notice && <p role="status" className="text-muted">{notice}</p>}
          {agentBusy && <p role="status" className="text-muted">{waitingConfirmation ? '主管正在等待全局确认弹窗回答；确认前不能发送新消息。' : currentDetail?.summary.claim.state === 'claimed' ? '主会话正在被用户控制，不抢占控制权。' : '主管正在执行，草稿可以保留，完成后再发送。'}</p>}
          {staleResources && (oldSessionRunning
            ? <p className="text-danger">主 Agent 资源已变更，旧主会话仍在运行。请先结束它再启动，不会自动中断现有会话。</p>
            : <p role="status" className="text-muted">主 Agent 资源已变更，旧主会话已结束（当前未连接）：点“启动”会按新资源启动，不会中断其他会话。</p>)}
          {(!state.data?.enabled || !config.data?.enabled) && <p className="text-muted">主管未启用或配置尚不可用；不会自动开启。</p>}
          <SupervisorFailure error={error || state.error || config.error || detail.error} retry={retry} />
          {state.data?.agent.error && <p role="alert" className="text-danger">{state.data.agent.error}</p>}
          {state.data?.agent.extensionsStale && <p role="status" className="text-muted">扩展代码已更新（主会话仍在用启动时的版本）：现在可继续使用，建议结束后重新启动主会话以加载新代码。</p>}
          {liveError && <p className="text-danger">会话桥：{liveError}</p>}
          <div className="flex flex-wrap gap-2 items-center">
            <button className={buttonClass} disabled={!canStart || ready} onClick={() => void start()}>{pending === 'starting' ? '启动中…' : '启动 / 重试启动'}</button>
            <button className={buttonClass} disabled={!ready || agentBusy || !!pending || !!state.data?.agent.extensionsStale} onClick={() => void clear()}>{pending === 'clearing' ? '清空并重新加载中…' : '清空并重新加载'}</button>
            <span className="text-muted text-body-s">仅清空聊天上下文，保留任务、事件和截图；旧会话仍保留。</span>
            {pid && <Link className="text-accent hover:underline" to={'/live-sessions/' + encodeURIComponent(pid)} onClick={close}>打开主会话</Link>}
          </div>
          <details><summary className="cursor-pointer text-body-s">启动资源与配置（只读）</summary><div className="mt-3"><ConfigSummary config={config.data} /></div></details>
          <section aria-label="主管对话" className="space-y-4">
            {!messages.length && <p className="text-muted">暂无可读取的对话；启动成功后在下方输入。</p>}
            {messages.map(message => <article key={message.id} className="rounded-lg border border-border p-3 space-y-2">
              <h3 className="text-muted text-2xs">{message.role === 'user' ? '你' : message.role === 'assistant' ? '主管' : message.role}</h3>
              {message.text && <MarkdownRenderer content={message.text} />}
              {message.images.map((image, index) => <img key={index} className="max-h-64 max-w-full rounded" alt="对话图片" src={'data:' + image.mimeType + ';base64,' + image.data} />)}
            </article>)}
            {!!transcript.omittedToolResults && <p className="text-muted text-2xs">已略去 {transcript.omittedToolResults} 条工具输出（终端日志、JSON 等）；需要核对完整过程时可打开主会话。</p>}
          </section>
        </div>
        <form className="border-t border-border p-4 space-y-3" onSubmit={event => { event.preventDefault(); void send() }}>
          {!!uploads.length && <ul className="flex flex-wrap gap-2">{uploads.map(upload => <li key={upload.key} className="rounded border border-border p-2 text-body-s max-w-full break-words">
            <span>{upload.file.name} · {upload.uploading ? '上传中…' : upload.attachment ? '已持久保存' : '上传失败'}</span>
            {upload.error && <p role="alert" className="text-danger">{upload.error}</p>}
            {upload.attachment && <a className="ml-2 text-accent" href={supervisorApi.attachmentUrl(upload.attachment.id)} target="_blank" rel="noreferrer">查看原图</a>}
            {upload.error && <button type="button" className={buttonClass} disabled={!!pending || upload.uploading} onClick={() => void uploadOne(upload)}>重试上传</button>}
            <button type="button" className="ml-2 text-muted" disabled={!!pending || upload.uploading} onClick={() => setUploads(current => current.filter(item => item.key !== upload.key))}>移除</button>
          </li>)}</ul>}
          <label htmlFor="supervisor-agent-input" className="sr-only">给主管的消息</label>
          <textarea ref={composer} id="supervisor-agent-input" rows={3} value={draft} disabled={!!pending} onChange={event => setDraft(event.target.value)} onPaste={event => {
            const files = Array.from(event.clipboardData.files)
            if (files.length) { event.preventDefault(); void uploadFiles(files) }
          }} className="w-full rounded-lg border border-border bg-bg p-3 text-body-s focus:outline-none focus:ring-2 focus:ring-accent" placeholder="描述事件、询问分析或请求报告；截图请附文字说明，可直接粘贴…" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className={buttonClass}>上传截图<input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={!!pending || uploads.some(upload => upload.uploading)} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void uploadFiles(files) }} /></label>
            <span className="text-muted text-2xs">附件上传后持久保存；移除仅取消本次发送。</span>
            <button type="submit" className={buttonClass} disabled={!ready || agentBusy || !!pending || !draft.trim() || uploads.some(upload => !upload.attachment || upload.uploading)}>{pending === 'sending' ? '发送中…' : '发送给主管'}</button>
          </div>
        </form>
      </div>
    </div>, document.body)}</AgentContext.Provider>
}
