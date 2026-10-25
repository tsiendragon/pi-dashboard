import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { authHeader } from '../api/auth'
import { Badge, PageHeader } from '../components/ui'
import MaterialIcon from '../components/MaterialIcon'
import { clipboardFiles } from '../utils/clipboardFiles'

type ProviderId = 'dashscope' | 'azure'
interface PriceInfo { summary: string; scope: string; sourceUrl: string; checkedAt: string; verified: boolean }
type Mode = 't2i' | 'it2i'
interface ModelCheck { status: 'untested' | 'passed' | 'failed'; checkedAt?: string; elapsedSeconds?: number; httpStatus?: number; message?: string }
interface ImageModel {
  id: string; label: string; modes: Mode[]; configured: boolean; note?: string
  pricing: { generation: PriceInfo; editing: PriceInfo }
  verification: { t2i: ModelCheck; it2i: ModelCheck }
}
function checkText(check?: ModelCheck) {
  if (!check || check.status === 'untested') return '尚未实测'
  return `${check.status === 'passed' ? '接口出图已验证' : '上次实测失败'}${check.checkedAt ? `（${check.checkedAt.slice(0, 10)}）` : ''}${check.elapsedSeconds !== undefined ? `，${check.elapsedSeconds} 秒` : ''}${check.message ? `：${check.message}` : ''}`
}
interface Provider {
  id: ProviderId
  label: string
  configured: boolean
  model: string
  editModel: string
  pricing?: { generation: PriceInfo; editing: PriceInfo }
  defaultModel?: string
  models?: ImageModel[]
}
type JobStatus = 'running' | 'done' | 'failed'
interface MemeJob {
  id: string
  status: JobStatus
  provider: ProviderId
  model: string
  mode: Mode
  prompt: string
  style: string
  createdAt: number
  finishedAt?: number
  elapsedMs?: number
  mime?: string
  bytes?: number
  error?: string
  note?: string
  imageUrl?: string
  remoteUrl?: string
}

const MAX_REFERENCE_BYTES = 8 * 1024 * 1024
const STYLES = ['自由发挥', '猫猫表情', '手绘简笔画', '可爱贴纸', '夸张搞笑', '像素风']
const EXAMPLES = [
  { label: '再睡五分钟', prompt: '一只困得睁不开眼的橘猫抱着咖啡，配字「再睡五分钟」' },
  { label: '下班啦', prompt: '开心到转圈的橘猫，配字「下班啦」' },
  { label: '你说得都对', prompt: '一只摊手的小狗，配字「你说得都对」' },
]
const controlClass = 'w-full min-w-0 rounded-md border border-border bg-bg-elevated px-3 py-2 text-text text-sm transition-colors focus-ring'
const ghostButtonClass = 'inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-meta text-muted transition hover:bg-bg-hover hover:text-text focus-ring disabled:opacity-40'
const chipClass = 'rounded-full border px-3 py-1.5 text-sm transition focus-ring'

async function request<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: { ...authHeader(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => { throw new Error(body ? '网络连接中断；若已提交，后台会继续生成，可稍后刷新历史记录确认。' : '无法读取服务列表，请检查网络后重试。') })
  if (response.status === 401) throw new Error('请先到在线会话页完成浏览器认证，再回到这里刷新。')
  if (response.status === 403) throw new Error('当前浏览器没有操作权限，请检查访问地址和浏览器认证。')
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(data?.error || `请求失败（${response.status}），请稍后再试。`)
  }
  return response.json() as Promise<T>
}

function jobImage(job: MemeJob | undefined): string {
  return job?.imageUrl || job?.remoteUrl || ''
}
function jobTime(createdAt: number): string {
  return new Date(createdAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function jobExtension(job: MemeJob | undefined): string {
  return job?.mime === 'image/jpeg' ? 'jpg' : job?.mime === 'image/webp' ? 'webp' : 'png'
}
function jobSize(job: MemeJob | undefined): string {
  if (!job?.bytes) return ''
  return job.bytes >= 1024 * 1024 ? `${(job.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(job.bytes / 1024))} KB`
}
function jobDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.round((seconds % 3600) / 60)} 分`
}
function statusLabel(status: JobStatus): string {
  return status === 'running' ? '生成中' : status === 'failed' ? '失败' : '已生成'
}

export default function MemeStudioPage() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [provider, setProvider] = useState<ProviderId | ''>('')
  const [modelId, setModelId] = useState('')
  const [loading, setLoading] = useState(true)
  const [serviceError, setServiceError] = useState('')
  const [prompt, setPrompt] = useState('')
  const [style, setStyle] = useState(STYLES[0])
  const [referenceImage, setReferenceImage] = useState<{ dataUrl: string; name: string } | null>(null)
  const [reading, setReading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [jobs, setJobs] = useState<MemeJob[]>([])
  const [outputDir, setOutputDir] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [visibleHistory, setVisibleHistory] = useState(60)
  const [imageFailed, setImageFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [tick, setTick] = useState(() => Date.now())
  const inFlight = useRef(false)
  const uploadSequence = useRef(0)
  const current = jobs.find(job => job.id === selectedId) || jobs[0]
  const runningJob = jobs.find(job => job.status === 'running')
  const running = !!runningJob
  const busy = submitting || running
  const selectedProvider = providers.find(item => item.id === provider)
  const modelList = selectedProvider?.models
  const selectedModel = modelList?.find(item => item.id === modelId && item.configured)
    || modelList?.find(item => item.id === selectedProvider?.defaultModel && item.configured)
    || modelList?.find(item => item.configured)
  const modelReady = modelList ? !!selectedModel?.configured : !!selectedProvider?.configured
  const supportsReference = modelList ? !!selectedModel?.modes.includes('it2i') : true
  const mode: Mode = referenceImage ? 'it2i' : 't2i'
  const modeSupported = modelList ? !!selectedModel?.modes.includes(mode) : true
  const prices = selectedModel?.pricing || selectedProvider?.pricing
  const price = referenceImage ? prices?.editing : prices?.generation
  const currentImage = jobImage(current)
  const downloadable = !!current?.imageUrl
  const downloadHref = current?.imageUrl ? `${current.imageUrl}?download=1` : undefined
  const waitingSeconds = runningJob ? Math.max(1, Math.round((tick - runningJob.createdAt) / 1000)) : 0
  const t2iCheck = selectedModel?.verification.t2i

  const loadProviders = useCallback(async () => {
    setLoading(true)
    setServiceError('')
    try {
      const result = await request<{ providers: Provider[] }>('/api/memes/providers')
      setProviders(result.providers)
      setProvider(previous => result.providers.some(item => item.id === previous && item.configured)
        ? previous : result.providers.find(item => item.configured)?.id || '')
    } catch (err) {
      setServiceError(err instanceof Error ? err.message : '读取服务列表失败，请检查网络后重试。')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      const result = await request<{ jobs: MemeJob[]; outputDir: string }>('/api/memes/jobs?limit=500')
      setJobs(result.jobs)
      setOutputDir(result.outputDir)
      setHistoryError('')
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : '读取历史记录失败，请稍后重试。')
    }
  }, [])

  useEffect(() => { void loadProviders() }, [loadProviders])
  useEffect(() => { void loadHistory() }, [loadHistory])
  useEffect(() => { setImageFailed(false) }, [current?.id])
  useEffect(() => {
    if (!supportsReference) {
      ++uploadSequence.current
      setReferenceImage(null)
      setReading(false)
    }
  }, [supportsReference])
  // Poll only while something is running; the work itself lives in the server process.
  useEffect(() => {
    if (!running && !submitting) return
    const timer = window.setInterval(() => { void loadHistory() }, 2500)
    return () => window.clearInterval(timer)
  }, [running, submitting, loadHistory])
  // Tick once a second so the waiting time on a running job stays honest.
  useEffect(() => {
    if (!running) return
    setTick(Date.now())
    const timer = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  // Coming back to the tab picks up whatever finished while the page was closed.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void loadHistory() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [loadHistory])

  const chooseReference = useCallback(async (file: File | undefined, sourceLabel = '') => {
    if (!file || !supportsReference || !modelReady) return
    const sequence = ++uploadSequence.current
    setError('')
    setReading(false)
    setReferenceImage(null)
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('参考图只支持 PNG、JPEG 或 WebP。')
      return
    }
    if (!file.size || file.size > MAX_REFERENCE_BYTES) {
      setError('参考图不能为空，且不能超过 8 MiB。')
      return
    }
    setReading(true)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取参考图失败。'))
        reader.onerror = () => reject(new Error('读取参考图失败，请重新选择。'))
        reader.readAsDataURL(file)
      })
      if (sequence === uploadSequence.current) setReferenceImage({ dataUrl, name: sourceLabel || file.name || '图片' })
    } catch (err) {
      if (sequence === uploadSequence.current) setError(err instanceof Error ? err.message : '读取参考图失败。')
    } finally {
      if (sequence === uploadSequence.current) setReading(false)
    }
  }, [supportsReference, modelReady])

  // Images copied to the clipboard (screenshot, right-click copy) work as the reference image.
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      if (!supportsReference || !modelReady || busy) return
      const file = clipboardFiles(event.clipboardData).find(item => item.type.startsWith('image/'))
      if (!file) return
      event.preventDefault()
      setImageFailed(false)
      void chooseReference(file, '剪贴板图片')
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [chooseReference, supportsReference, modelReady, busy])

  async function generate(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current || busy || loading || serviceError || reading || !prompt.trim() || !modelReady || !modeSupported) return
    inFlight.current = true
    setSubmitting(true)
    setError('')
    try {
      const result = await request<{ job: MemeJob }>('/api/memes/generate', {
        provider,
        ...(selectedModel ? { model: selectedModel.id } : {}),
        prompt: prompt.trim(),
        ...(style !== STYLES[0] ? { style } : {}),
        ...(referenceImage ? { referenceImage: referenceImage.dataUrl } : {}),
      })
      setJobs(previous => [result.job, ...previous.filter(item => item.id !== result.job.id)])
      setSelectedId(result.job.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败。请检查网络；服务可能仍在处理，勿连续重试。')
      void loadHistory()
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  const reuseJob = useCallback((job: MemeJob) => {
    setPrompt(job.prompt)
    if (STYLES.includes(job.style)) setStyle(job.style)
    const target = providers.find(item => item.id === job.provider && item.configured)
    if (target) {
      setProvider(target.id)
      const match = target.models?.find(item => item.id === job.model && item.configured)
      setModelId(match?.id || '')
    }
    document.getElementById('meme-prompt')?.focus()
  }, [providers])

  const copyOutputDir = useCallback(async () => {
    if (!outputDir || !navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(outputDir)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be blocked outside secure contexts; the path stays selectable.
    }
  }, [outputDir])

  const unavailable = !loading && !serviceError && !providers.some(item => item.configured)
  const canGenerate = !loading && !serviceError && !!modelReady && modeSupported && !!prompt.trim() && !busy && !reading
  const selectedBadge = current
    ? current.status === 'running' ? { variant: 'warn' as const, text: '生成中' }
      : current.status === 'failed' ? { variant: 'err' as const, text: '失败' }
        : { variant: 'ok' as const, text: '已生成' }
    : null

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:overflow-hidden">
      <PageHeader title="表情包工坊" subtitle="说说你想表达什么，生成一张自己的聊天表情。" />
      <div className="mx-auto flex w-full max-w-7xl flex-col px-4 pb-20 md:px-6 lg:min-h-0 lg:flex-1 lg:pb-7">
        <div className="grid grid-cols-1 gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,404px)_minmax(0,1fr)] lg:gap-8">

          {/* ── Left: request form ── */}
          <section className="flex flex-col lg:min-h-0 lg:overflow-hidden" aria-labelledby="meme-form-title">
            <h1 id="meme-form-title" className="mb-3 shrink-0 text-base font-semibold text-text-strong">创作要求</h1>
            {serviceError && (
              <div role="alert" className="mb-3 rounded-lg border border-danger bg-danger-subtle p-3 text-sm text-danger break-words">
                <p>{serviceError}</p>
                <Link to="/live-sessions" className="mt-2 inline-block underline focus-ring">前往在线会话页</Link>
              </div>
            )}
            {unavailable && (
              <div role="status" className="mb-3 rounded-lg border border-border bg-bg-elevated p-3 text-sm text-muted">
                暂无可用的图片服务。请在后台配置 DashScope 密钥，或 Azure 图片服务地址和密钥，再由服务管理员重启。配置说明见 guide/config.md。
              </div>
            )}
            <form onSubmit={event => { void generate(event) }} className="flex min-h-0 flex-col lg:flex-1">
              <fieldset className="min-w-0 space-y-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1.5">
                <div className="grid gap-4">
                  <div>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <label htmlFor="meme-provider" className="text-sm font-medium">图片服务</label>
                      <button type="button" className={ghostButtonClass} onClick={() => { void loadProviders() }} disabled={loading} aria-label="刷新服务列表">
                        <MaterialIcon name="sync" className="h-3.5 w-3.5" />刷新
                      </button>
                    </div>
                    <select id="meme-provider" className={controlClass} value={provider} disabled={loading || !providers.some(item => item.configured)} onChange={event => { setProvider(event.target.value as ProviderId); setModelId('') }}>
                      {!provider && <option value="">{loading ? '正在读取服务…' : '暂无可用服务'}</option>}
                      {providers.map(item => <option key={item.id} value={item.id} disabled={!item.configured}>{item.label}{!item.configured ? ' · 未配置' : ''}</option>)}
                    </select>
                  </div>
                  {modelList && (
                    <div>
                      <label htmlFor="meme-model" className="mb-1.5 block text-sm font-medium">图片模型</label>
                      <select id="meme-model" className={controlClass} value={selectedModel?.id || ''} disabled={loading || !modelReady} onChange={event => { setModelId(event.target.value); setError('') }}>
                        {!selectedModel && <option value="">暂无已配置模型</option>}
                        {modelList.map(item => <option key={item.id} value={item.id} disabled={!item.configured}>{item.label}{!item.configured ? ' · 未配置' : `${item.modes.includes('it2i') ? ' · 文字/参考图' : ' · 仅接入文字'}${item.verification.t2i.status === 'passed' ? ' · 已出图' : item.verification.t2i.status === 'failed' ? ' · 上次失败' : ' · 未实测'}`}</option>)}
                      </select>
                      {selectedModel && <details className="group mt-2 rounded-lg border border-border bg-bg-elevated">
                        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-meta text-muted transition hover:text-text [&::-webkit-details-marker]:hidden">
                          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${t2iCheck?.status === 'passed' ? 'bg-ok' : t2iCheck?.status === 'failed' ? 'bg-danger' : 'bg-muted'}`} />
                          <span className="min-w-0 flex-1 truncate">实测：{t2iCheck?.status === 'passed' ? '接口出图已验证' : t2iCheck?.status === 'failed' ? '上次实测失败' : '尚未实测'}</span>
                          <span className="shrink-0 text-2xs text-muted group-open:hidden">详情</span>
                          <span className="hidden shrink-0 text-2xs text-muted group-open:inline">收起</span>
                        </summary>
                        <div aria-label="模式与实测" className="space-y-1 border-t border-border px-3 py-2 text-2xs text-muted break-words">
                          <p>文字生成图片：{selectedModel.modes.includes('t2i') ? checkText(selectedModel.verification.t2i) : '本页未接入'}</p>
                          <p>参考图加文字生成图片：{supportsReference ? checkText(selectedModel.verification.it2i) : '本页未接入'}</p>
                          {selectedModel.note && <p>{selectedModel.note}</p>}
                          <p>实测只确认接口返回了图片，不保证每次的画面和文字效果。</p>
                        </div>
                      </details>}
                    </div>
                  )}
                </div>

                {selectedProvider && (
                  <p className="-mt-2 break-all font-mono text-2xs text-muted">模型：{selectedModel?.id || (referenceImage ? selectedProvider.editModel : selectedProvider.model)}</p>
                )}

                <div>
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <label htmlFor="meme-prompt" className="text-sm font-medium">想做什么表情？</label>
                    <span className={`text-2xs ${prompt.length > 1900 ? 'text-warn' : 'text-muted'}`}>{prompt.length}/2000</span>
                  </div>
                  <textarea id="meme-prompt" className={`${controlClass} resize-y`} rows={4} maxLength={2000} required value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="例如：一只困得睁不开眼的橘猫抱着咖啡，配字「再睡五分钟」" aria-describedby="meme-prompt-hint" />
                  <p id="meme-prompt-hint" className="mt-1 text-2xs text-muted">需要文字时请写出原句，生成后自己检查错字。</p>
                </div>

                <div>
                  <span id="meme-style-label" className="mb-1.5 block text-sm font-medium">画风</span>
                  <div role="radiogroup" aria-labelledby="meme-style-label" className="flex flex-wrap gap-2">
                    {STYLES.map(item => {
                      const active = style === item
                      return (
                        <label
                          key={item}
                          className={`${chipClass} cursor-pointer focus-within:ring-2 focus-within:ring-[var(--ring)] ${active ? 'border-accent bg-accent-subtle font-medium text-accent' : 'border-border text-muted hover:border-border-strong hover:bg-bg-hover hover:text-text'}`}
                        >
                          <input
                            type="radio"
                            name="meme-style"
                            value={item}
                            checked={active}
                            onChange={() => setStyle(item)}
                            className="sr-only"
                          />
                          {item}
                        </label>
                      )
                    })}
                  </div>
                </div>

                <div>
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">参考图 <span className="font-normal text-muted">（可选）</span></span>
                    <span className="text-2xs text-muted">Ctrl+V / ⌘V 可粘贴</span>
                  </div>
                  <div className={`rounded-lg border border-dashed p-3 transition-colors ${supportsReference && modelReady ? 'border-border bg-bg-elevated hover:border-border-strong' : 'border-border bg-bg-elevated opacity-60'}`}>
                    {referenceImage ? (
                      <div className="flex min-w-0 items-center gap-3">
                        <img src={referenceImage.dataUrl} alt="已选择的参考图" className="h-14 w-14 shrink-0 rounded-md border border-border object-contain bg-bg" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-meta text-text" title={referenceImage.name}>{referenceImage.name}</p>
                          <p className="text-2xs text-muted">将参考图里的主体画进表情</p>
                        </div>
                        <button type="button" className={ghostButtonClass} onClick={() => { ++uploadSequence.current; setReferenceImage(null) }} aria-label="移除参考图">移除</button>
                      </div>
                    ) : (
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-bg text-muted" aria-hidden="true"><MaterialIcon name="attach_file" className="h-5 w-5" /></span>
                        <div className="min-w-0 flex-1">
                          <label htmlFor="meme-reference" className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-meta transition hover:bg-bg-hover hover:text-text focus-within:ring-2 focus-within:ring-[var(--ring)] ${!supportsReference || !modelReady ? 'pointer-events-none text-muted' : 'text-text'}`}>
                            选择图片
                          </label>
                          <p id="meme-reference-hint" className="mt-1 text-2xs text-muted">
                            {supportsReference ? 'PNG / JPEG / WebP，最大 8 MiB；也可直接粘贴截图。图片会发送给所选服务，请勿上传敏感照片。' : '当前模型未接入参考图，换一个标注「文字/参考图」的模型即可。'}
                          </p>
                        </div>
                      </div>
                    )}
                    <input id="meme-reference" type="file" accept="image/png,image/jpeg,image/webp" aria-label="参考图" disabled={!supportsReference || !modelReady} className="sr-only" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void chooseReference(file) }} aria-describedby="meme-reference-hint" />
                    {reading && <p role="status" className="mt-2 text-meta text-muted">正在读取参考图…</p>}
                  </div>
                  {!referenceImage && !supportsReference && <p className="mt-1.5 text-2xs text-muted">切换到本模型时已选的参考图会被清掉。</p>}
                </div>

                {selectedProvider && (
                  <div className="rounded-lg border border-border bg-bg-elevated px-3 py-2.5" aria-label="费用参考">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-meta font-medium text-text">费用参考</p>
                      {price && !price.verified && <Badge variant="warn">单价待核实</Badge>}
                      {price?.verified && <span className="text-2xs text-muted">核对于 {price.checkedAt}</span>}
                    </div>
                    <p className="text-meta text-muted break-words">{price?.summary || '当前模型价格待核实，生成仍可能收费。'}</p>
                    {price && <p className="mt-1 text-2xs text-muted/80 break-words">{price.scope}</p>}
                    {price && <a href={price.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-block text-2xs text-accent underline focus-ring">官方价格说明</a>}
                  </div>
                )}
              </fieldset>

              <div className="sticky bottom-0 z-10 mt-4 border-t border-border bg-bg pb-2 pt-3 sm:pb-1 lg:static lg:border-t-0 lg:bg-transparent lg:pt-3">
                <button type="submit" disabled={!canGenerate} className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-fg transition hover:bg-accent-hover focus-ring disabled:cursor-not-allowed disabled:opacity-40">
                  {busy && <span aria-hidden="true" className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
                  {busy ? (running ? '正在生成…' : '正在提交…') : jobs.length ? '再生成一张' : '生成一张'}
                </button>
                <p className="mt-1.5 hidden text-center text-2xs text-muted sm:block">每次一张，可能产生费用，不会自动重试；提交后由后台继续，离开页面不中断。</p>
              </div>
            </form>
            {error && <p role="alert" className="mt-3 rounded-lg border border-danger bg-danger-subtle p-3 text-sm text-danger break-words">{error}</p>}
          </section>

          {/* ── Right: result + history ── */}
          <section className="flex flex-col gap-4 border-t border-border pt-5 lg:min-h-0 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0" aria-labelledby="meme-result-title" aria-busy={busy}>
            <div className="shrink-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h2 id="meme-result-title" className="text-base font-semibold text-text-strong">生成结果</h2>
                  {selectedBadge && <Badge variant={selectedBadge.variant}>{selectedBadge.text}</Badge>}
                </div>
                <button type="button" className={ghostButtonClass} onClick={() => { void loadHistory() }} aria-label="刷新记录">
                  <MaterialIcon name="sync" className="h-3.5 w-3.5" />刷新
                </button>
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted">
                <span>共 {jobs.length} 条记录</span>
                {outputDir && <>
                  <span aria-hidden="true">·</span>
                  <span>保存在</span>
                  <code className="max-w-[min(100%,320px)] truncate rounded bg-bg-elevated px-1.5 py-0.5 font-mono" title={outputDir}>{outputDir}</code>
                  <button type="button" onClick={() => { void copyOutputDir() }} className="rounded px-1 py-0.5 text-accent underline-offset-2 hover:underline focus-ring" aria-label="复制保存路径">{copied ? '已复制' : '复制'}</button>
                </>}
              </div>
            </div>

            {historyError && <p role="alert" className="rounded-lg border border-danger bg-danger-subtle p-3 text-sm text-danger break-words">{historyError}</p>}
            {runningJob && (
              <p role="status" className="rounded-lg border border-border bg-bg-elevated px-3 py-2 text-meta text-muted">
                后台正在生成{runningJob.prompt ? `「${runningJob.prompt.slice(0, 24)}${runningJob.prompt.length > 24 ? '…' : ''}」` : ''}<span aria-hidden="true">，已等待 {jobDuration(waitingSeconds)}</span>。可以离开本页，回来后结果仍在历史里。
              </p>
            )}

            {!current ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-bg-elevated/60 px-6 py-10 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-full bg-accent-subtle text-accent"><MaterialIcon name="palette" className="h-6 w-6" /></span>
                <div>
                  <p className="text-sm font-medium text-text-strong">还没有生成过表情</p>
                  <p className="mx-auto mt-1 max-w-sm text-meta text-muted">写一句描述就行，也可以先粘贴一张参考图。生成后会自动保存在本机，随时回来都能找到。</p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {EXAMPLES.map(example => (
                    <button key={example.label} type="button" className={`${chipClass} border-border text-meta text-muted hover:border-border-strong hover:bg-bg-hover hover:text-text`} onClick={() => setPrompt(example.prompt)} title={example.prompt} aria-label={`使用示例：${example.prompt}`}>
                      {example.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div className="relative flex min-h-56 flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-bg-elevated p-2 aspect-square lg:aspect-auto">
                  {current.status === 'done' && currentImage ? (
                    <img src={currentImage} alt={`生成的表情包：${current.prompt}`} referrerPolicy="no-referrer" className="max-h-full max-w-full rounded-lg object-contain" onError={() => setImageFailed(true)} />
                  ) : current.status === 'running' ? (
                    <div className="flex flex-col items-center gap-3 text-center" role="status">
                      <span aria-hidden="true" className="h-9 w-9 animate-spin rounded-full border-2 border-border border-t-accent" />
                      <p className="text-sm font-medium text-text">正在生成…</p>
                      <p className="max-w-sm text-meta text-muted">服务端正在画图，可以离开页面；完成后会自动出现在这里。</p>
                      <p className="font-mono text-2xs text-muted">{current.provider === 'azure' ? 'Azure' : 'DashScope'} · {current.model}</p>
                    </div>
                  ) : (
                    <div className="flex max-w-md flex-col items-center gap-2 px-5 text-center">
                      <span className="grid h-10 w-10 place-items-center rounded-full bg-danger-subtle text-danger"><MaterialIcon name="error" className="h-5 w-5" /></span>
                      <p className="text-sm font-medium text-text">这次没有生成成功</p>
                      <p role="alert" className="text-meta text-muted break-words">{current.error || '生成失败，请稍后再试。'}</p>
                      <p className="text-2xs text-muted">{jobTime(current.createdAt)} · {current.provider === 'azure' ? 'Azure' : 'DashScope'} · {current.model}</p>
                    </div>
                  )}
                </div>
                {imageFailed && <p role="alert" className="text-sm text-danger">图片加载失败，临时链接可能已过期。若本次只留下临时链接，请重新生成。</p>}
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <div className="min-w-0 text-2xs text-muted">
                    <span className="font-mono">{current.model}</span>
                    <span aria-hidden="true"> · </span>{current.provider === 'azure' ? 'Azure' : 'DashScope'}
                    {current.createdAt ? <><span aria-hidden="true"> · </span>{jobTime(current.createdAt)}</> : null}
                    {current.elapsedMs !== undefined && <><span aria-hidden="true"> · </span>{Math.max(1, Math.round(current.elapsedMs / 1000))} 秒</>}
                    {jobSize(current) && <><span aria-hidden="true"> · </span>{jobSize(current)}</>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {current.status !== 'running' && (
                      <button type="button" className={ghostButtonClass} onClick={() => reuseJob(current)} aria-label="用这条描述再生成">用这条描述再生成</button>
                    )}
                    {downloadable ? (
                      <a href={downloadHref} download={`meme-${current.id}.${jobExtension(current)}`} className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-meta font-medium text-accent-fg transition hover:bg-accent-hover focus-ring">
                        <MaterialIcon name="check" className="h-3.5 w-3.5" />下载图片
                      </a>
                    ) : current.status === 'done' ? (
                      <a href={current.remoteUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-meta text-text transition hover:bg-bg-hover focus-ring">打开原图保存</a>
                    ) : null}
                  </div>
                </div>
                {(current.note || (!downloadable && current.status === 'done')) && (
                  <p className="text-2xs text-muted">{current.note || '服务只返回了临时图片链接，请打开后保存，过期后将无法查看。'}</p>
                )}
                {current.prompt && <p className="border-l-2 border-border pl-3 text-meta text-muted break-words">{current.prompt}</p>}
              </>
            )}

            {jobs.length > 0 && (
              <div className="shrink-0 border-t border-border pt-3">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-meta font-semibold text-text-strong">历史记录</h3>
                  <span className="text-2xs text-muted">按时间从新到旧 · 点击查看</span>
                </div>
                <div className="flex max-h-52 flex-wrap content-start gap-2 overflow-y-auto" aria-label="全部生成历史">
                  {jobs.slice(0, visibleHistory).map(job => {
                    const active = job.id === current?.id
                    return (
                      <button
                        key={job.id}
                        type="button"
                        onClick={() => setSelectedId(job.id)}
                        aria-label={`查看 ${jobTime(job.createdAt)} 的记录：${job.prompt.slice(0, 24)}`}
                        aria-pressed={active}
                        title={`${jobTime(job.createdAt)} · ${statusLabel(job.status)}\n${job.prompt}`}
                        className={`group flex w-16 shrink-0 flex-col gap-1 rounded-md focus-ring ${active ? 'text-accent' : 'text-muted hover:text-text'}`}
                      >
                        <span className={`relative grid h-16 w-16 place-items-center overflow-hidden rounded-md border-2 bg-bg-elevated transition ${active ? 'border-accent' : 'border-border group-hover:border-border-strong'}`}>
                          {job.status === 'done' && jobImage(job)
                            ? <img src={jobImage(job)} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                            : job.status === 'running'
                              ? <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
                              : <MaterialIcon name="error" className="h-5 w-5 text-danger" />}
                          {job.status === 'failed' && <span className="sr-only">失败</span>}
                        </span>
                        <span className="w-full truncate text-center text-[10px] leading-3 tabular-nums">{jobTime(job.createdAt)}</span>
                      </button>
                    )
                  })}
                </div>
                {jobs.length > visibleHistory && (
                  <button type="button" className={`${ghostButtonClass} mt-2`} onClick={() => setVisibleHistory(count => count + 60)}>
                    加载更早的记录（还有 {jobs.length - visibleHistory} 条）
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}