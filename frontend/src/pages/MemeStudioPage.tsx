import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { authHeader } from '../api/auth'
import { PageHeader } from '../components/ui'
import MaterialIcon from '../components/MaterialIcon'

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
interface GeneratedImage {
  image: string
  provider: ProviderId
  model: string
}
interface Candidate extends GeneratedImage { prompt: string; createdAt: number }
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024
const STYLES = ['自由发挥', '猫猫表情', '手绘简笔画', '可爱贴纸', '夸张搞笑', '像素风']
const controlClass = 'w-full min-w-0 rounded-md border border-border bg-bg-elevated px-3 py-2 text-text text-sm focus-ring'
const secondaryButtonClass = 'shrink-0 rounded-md border border-border px-2.5 py-1 text-sm text-muted hover:bg-bg-hover hover:text-text focus-ring disabled:opacity-40'

async function request<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: { ...authHeader(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => { throw new Error(body ? '网络连接中断，图片服务可能仍在处理，请勿连续重试。' : '无法读取服务列表，请检查网络后重试。') })
  if (response.status === 401) throw new Error('请先到在线会话页完成浏览器认证，再回到这里刷新服务列表。')
  if (response.status === 403) throw new Error('当前浏览器没有操作权限，请检查访问地址和浏览器认证。')
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(data?.error || `请求失败（${response.status}），请稍后再试。`)
  }
  return response.json() as Promise<T>
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
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [selected, setSelected] = useState(0)
  const [imageFailed, setImageFailed] = useState(false)
  const inFlight = useRef(false)
  const uploadSequence = useRef(0)
  const current = candidates[selected]
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

  useEffect(() => { void loadProviders() }, [loadProviders])
  useEffect(() => { setImageFailed(false) }, [current?.image])
  useEffect(() => {
    if (!supportsReference) {
      ++uploadSequence.current
      setReferenceImage(null)
      setReading(false)
    }
  }, [supportsReference])

  async function chooseReference(file: File | undefined) {
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
      if (sequence === uploadSequence.current) setReferenceImage({ dataUrl, name: file.name })
    } catch (err) {
      if (sequence === uploadSequence.current) setError(err instanceof Error ? err.message : '读取参考图失败。')
    } finally {
      if (sequence === uploadSequence.current) setReading(false)
    }
  }

  async function generate(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current || loading || serviceError || reading || !prompt.trim() || !modelReady || !modeSupported) return
    inFlight.current = true
    setGenerating(true)
    setError('')
    try {
      const result = await request<GeneratedImage>('/api/memes/generate', {
        provider,
        ...(selectedModel ? { model: selectedModel.id } : {}),
        prompt: prompt.trim(),
        ...(style !== STYLES[0] ? { style } : {}),
        ...(referenceImage ? { referenceImage: referenceImage.dataUrl } : {}),
      })
      setCandidates(previous => [{ ...result, prompt: prompt.trim(), createdAt: Date.now() }, ...previous].slice(0, 3))
      setSelected(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败。请检查网络；服务可能仍在处理，勿连续重试。')
    } finally {
      inFlight.current = false
      setGenerating(false)
    }
  }

  const unavailable = !loading && !serviceError && !providers.some(item => item.configured)
  const downloadable = current?.image.startsWith('data:image/')
  const downloadExtension = current?.image.startsWith('data:image/jpeg;') ? 'jpg' : current?.image.startsWith('data:image/webp;') ? 'webp' : 'png'

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title="表情包工坊" subtitle="说说你想表达什么，生成一张自己的聊天表情。" />
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 pb-8 pt-2 md:px-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <section className="min-w-0" aria-labelledby="meme-form-title">
          <h1 id="meme-form-title" className="mb-4 text-base font-semibold text-text-strong">创作要求</h1>
          {serviceError && (
            <div role="alert" className="mb-4 rounded-md border border-danger bg-danger-subtle p-3 text-sm text-danger break-words">
              <p>{serviceError}</p>
              <Link to="/live-sessions" className="mt-2 inline-block underline focus-ring">前往在线会话页</Link>
            </div>
          )}
          {unavailable && (
            <div role="status" className="mb-4 rounded-md border border-border bg-bg-elevated p-3 text-sm text-muted">
              暂无可用的图片服务。请在后台配置 DashScope 密钥，或 Azure 图片服务地址和密钥，再由服务管理员重启。配置说明见 guide/config.md。
            </div>
          )}
          <form onSubmit={event => { void generate(event) }}>
            <fieldset disabled={generating || reading} className="min-w-0 space-y-5">
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="meme-provider" className="text-sm font-medium">图片服务</label>
                  <button type="button" className={secondaryButtonClass} onClick={() => { void loadProviders() }} disabled={loading}>刷新服务列表</button>
                </div>
                <select id="meme-provider" className={controlClass} value={provider} disabled={loading || !providers.some(item => item.configured)} onChange={event => { setProvider(event.target.value as ProviderId); setModelId('') }}>
                  {!provider && <option value="">{loading ? '正在读取服务…' : '暂无可用服务'}</option>}
                  {providers.map(item => <option key={item.id} value={item.id} disabled={!item.configured}>{item.label}{!item.configured ? ' · 未配置' : ''}</option>)}
                </select>
                {modelList && <div className="mt-4">
                  <label htmlFor="meme-model" className="mb-2 block text-sm font-medium">图片模型</label>
                  <select id="meme-model" className={controlClass} value={selectedModel?.id || ''} disabled={loading || !modelReady} onChange={event => { setModelId(event.target.value); setError('') }}>
                    {!selectedModel && <option value="">暂无已配置模型</option>}
                    {modelList.map(item => <option key={item.id} value={item.id} disabled={!item.configured}>{item.label}{!item.configured ? ' · 未配置' : `${item.modes.includes('it2i') ? ' · 文字/参考图' : ' · 仅接入文字'}${item.verification.t2i.status === 'passed' ? ' · 已出图' : item.verification.t2i.status === 'failed' ? ' · 上次失败' : ' · 未实测'}`}</option>)}
                  </select>
                </div>}
                {selectedProvider && <p className="mt-1.5 text-xs text-muted break-all">模型：{selectedModel?.id || (referenceImage ? selectedProvider.editModel : selectedProvider.model)}</p>}
                {selectedModel && <div aria-label="模式与实测" className="mt-2 space-y-1 text-xs text-muted break-words">
                  <p>文字生成图片：{selectedModel.modes.includes('t2i') ? checkText(selectedModel.verification.t2i) : '本页未接入'}</p>
                  <p>参考图加文字生成图片：{supportsReference ? checkText(selectedModel.verification.it2i) : '本页未接入'}</p>
                  {selectedModel.note && <p>{selectedModel.note}</p>}
                  <p>实测只确认接口返回了图片，不保证每次的画面和文字效果。</p>
                </div>}
                {selectedProvider && <div className="mt-3 rounded-md border border-border bg-bg-elevated p-3 text-xs text-muted" aria-label="费用参考">
                  <p className="mb-1 font-medium text-text">费用参考{price && !price.verified ? ' · 单价待核实' : ''}</p>
                  <p className="break-words">{price?.summary || '当前模型价格待核实，生成仍可能收费。'}</p>
                  {price && <>
                    <p className="mt-1 break-words">{price.scope}</p>
                    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1"><a href={price.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline focus-ring">官方价格说明</a><span>核对日期：{price.checkedAt}</span></p>
                  </>}
                </div>}
              </div>
              <div>
                <label htmlFor="meme-prompt" className="mb-2 block text-sm font-medium">想做什么表情？</label>
                <textarea id="meme-prompt" className={`${controlClass} resize-y`} rows={5} maxLength={2000} required value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="例如：一只困得睁不开眼的橘猫抱着咖啡，配字「再睡五分钟」" aria-describedby="meme-prompt-hint" />
                <p id="meme-prompt-hint" className="mt-1 text-xs text-muted">最多 2000 字。需要文字时请写出原句；生成后请检查错字。</p>
              </div>
              <div>
                <label htmlFor="meme-style" className="mb-2 block text-sm font-medium">画风</label>
                <select id="meme-style" className={controlClass} value={style} onChange={event => setStyle(event.target.value)}>
                  {STYLES.map(item => <option key={item}>{item}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="meme-reference" className="mb-2 block text-sm font-medium">参考图 <span className="font-normal text-muted">（可选）</span></label>
                <input id="meme-reference" type="file" accept="image/png,image/jpeg,image/webp" disabled={!supportsReference || !modelReady} className={`${controlClass} text-xs file:mr-2 file:rounded file:border-0 file:bg-bg-hover file:px-2 file:py-1 file:text-text`} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void chooseReference(file) }} aria-describedby="meme-reference-hint" />
                <p id="meme-reference-hint" className="mt-1.5 text-xs text-muted">{supportsReference ? 'PNG、JPEG 或 WebP，最多 8 MiB。图片和描述会发送给所选服务，请勿上传敏感照片。' : '当前模型接口未接入参考图。请直接输入文字，或换一个支持参考图的模型；切换到本模型时会移除已选参考图。'}</p>
                {reading && <p role="status" className="mt-2 text-sm text-muted">正在读取参考图…</p>}
                {referenceImage && (
                  <div className="mt-3 flex min-w-0 items-center gap-3 rounded-md border border-border p-2">
                    <img src={referenceImage.dataUrl} alt="已选择的参考图" className="h-16 w-16 shrink-0 rounded object-contain bg-bg-elevated" />
                    <span className="min-w-0 flex-1 break-all text-xs text-muted">{referenceImage.name}</span>
                    <button type="button" className={secondaryButtonClass} onClick={() => { ++uploadSequence.current; setReferenceImage(null) }}>移除</button>
                  </div>
                )}
              </div>
              <button type="submit" disabled={loading || !!serviceError || !modelReady || !modeSupported || !prompt.trim() || generating || reading} className="w-full rounded-md bg-accent px-4 py-2.5 font-semibold text-accent-fg hover:bg-accent-hover focus-ring disabled:cursor-not-allowed disabled:opacity-40">
                {generating ? '正在生成…' : candidates.length ? '再生成一张' : '生成一张'}
              </button>
            </fieldset>
          </form>
          <p className="mt-2 text-xs text-muted">每次点击生成一张，可能产生服务费用，不会自动重试。生成可能需要几分钟，超时后请勿连续重试。</p>
          {error && <p role="alert" className="mt-4 rounded-md border border-danger bg-danger-subtle p-3 text-sm text-danger break-words">{error}</p>}
        </section>

        <section className="min-w-0 border-t border-border pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0" aria-labelledby="meme-result-title" aria-busy={generating}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 id="meme-result-title" className="text-base font-semibold text-text-strong">生成结果</h2>
            <span className="text-xs text-muted">本页保留最近 3 张，离开或刷新后清空</span>
          </div>
          {generating && <p role="status" className="mb-3 rounded-md border border-border bg-bg-elevated p-3 text-sm text-muted">正在画图，请稍候。离开页面可能丢失结果，但不会取消服务计费。</p>}
          {current ? (
            <>
              <div className="flex aspect-square max-h-[60vh] w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-bg-elevated">
                <img src={current.image} alt={`生成的表情包：${current.prompt}`} referrerPolicy="no-referrer" className="h-full w-full object-contain" onError={() => setImageFailed(true)} />
              </div>
              {imageFailed && <p role="alert" className="mt-2 text-sm text-danger">图片加载失败，临时链接可能已过期。可尝试打开原图，或重新生成。</p>}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <span className="min-w-0 break-all text-xs text-muted">{current.provider === 'azure' ? 'Azure' : 'DashScope'} · {current.model}</span>
                <a href={current.image} {...(downloadable ? { download: `meme-${current.createdAt}.${downloadExtension}` } : { target: '_blank', rel: 'noopener noreferrer' })} referrerPolicy="no-referrer" className="rounded-md border border-border px-3 py-2 text-sm text-text hover:bg-bg-hover focus-ring">
                  {downloadable ? '下载图片' : '打开原图保存'}
                </a>
              </div>
              {!downloadable && <p className="mt-2 text-xs text-muted">服务返回的是临时图片链接，请打开后保存，避免过期丢失。</p>}
              <p className="mt-3 break-words text-sm text-muted">{current.prompt}</p>
              {candidates.length > 1 && <div className="mt-5 flex flex-wrap gap-2" aria-label="本页最近生成的图片">
                {candidates.map((item, index) => <button key={item.createdAt} type="button" aria-label={`查看第 ${index + 1} 张表情包`} aria-pressed={selected === index} onClick={() => setSelected(index)} className={`h-16 w-16 overflow-hidden rounded-md border-2 focus-ring ${selected === index ? 'border-accent' : 'border-border'}`}><img src={item.image} alt="" referrerPolicy="no-referrer" className="h-full w-full object-contain bg-bg-elevated" /></button>)}
              </div>}
            </>
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-bg-elevated px-6 py-12 text-center">
              <MaterialIcon name="palette" className="h-10 w-10 text-muted" />
              <p className="text-sm font-medium text-text">你的第一张表情包会出现在这里</p>
              <p className="max-w-xs text-sm text-muted">先写下想表达的心情，再点击「生成一张」。上传参考图可以借用人物或宠物的形象。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
