import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import MemeStudioPage from '../pages/MemeStudioPage'

const IMAGE = 'data:image/png;base64,iVBORw0KGgo='
const OUTPUT_DIR = '~/.pi/dashboard/memes'
const providers = [
  { id: 'dashscope', label: 'DashScope', configured: true, model: 'qwen-image-max', editModel: 'qwen-image-edit' },
  { id: 'azure', label: 'Azure', configured: false, model: 'gpt-image-1', editModel: 'gpt-image-1' },
]
const fetchMock = vi.fn<typeof fetch>()
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }) }
function renderPage() { return render(<MemoryRouter><MemeStudioPage /></MemoryRouter>) }
async function ready() { await waitFor(() => expect(screen.getByLabelText('图片服务')).toHaveValue('dashscope')) }
function enterPrompt() { fireEvent.change(screen.getByLabelText('想做什么表情？'), { target: { value: '困困的猫' } }) }
function paidCalls() { return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST') }
function requests(urlPart: string) { return fetchMock.mock.calls.filter(([url]) => String(url).startsWith(urlPart)) }

interface Job {
  id: string; status: 'running' | 'done' | 'failed'; provider: string; model: string; mode: string
  prompt: string; style: string; createdAt: number
  finishedAt?: number; elapsedMs?: number; mime?: string; file?: string; error?: string
  note?: string; imageUrl?: string; remoteUrl?: string
}
function job(overrides: Partial<Job> = {}): Job {
  const id = overrides.id ?? 'm1abc-abcd1234'
  return {
    id,
    status: 'done',
    provider: 'dashscope',
    model: 'qwen-image-max',
    mode: 't2i',
    prompt: '困困的猫',
    style: '自由发挥',
    createdAt: 1_760_000_000_000,
    finishedAt: 1_760_000_012_000,
    elapsedMs: 12_000,
    mime: 'image/png',
    file: `${id}.png`,
    imageUrl: `/api/memes/images/${id}`,
    ...overrides,
  }
}

interface ApiOptions {
  providers?: unknown
  jobs?: Job[] | (() => Job[])
  post?: (body: Record<string, unknown>) => Response | Promise<Response>
}
function mockApi(options: ApiOptions = {}) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.startsWith('/api/memes/generate')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return options.post ? options.post(body) : json({
        job: job({
          provider: String(body.provider),
          model: String(body.model ?? 'qwen-image-max'),
          prompt: String(body.prompt),
          mode: body.referenceImage ? 'it2i' : 't2i',
        }),
      }, 202)
    }
    if (url.startsWith('/api/memes/jobs')) {
      const list = typeof options.jobs === 'function' ? options.jobs() : options.jobs ?? []
      return json({ jobs: list, outputDir: OUTPUT_DIR })
    }
    return json({ providers: options.providers ?? providers })
  })
}

function pngFile(name = 'cat.png') {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  mockApi()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function selectableModel(id: string, reference = true) {
  const price = { summary: `价格说明：${id}`, scope: '以实际账单为准', sourceUrl: 'https://example.com/pricing', checkedAt: '2026-10-18', verified: false }
  return { id, label: id, configured: true, modes: reference ? ['t2i', 'it2i'] : ['t2i'], pricing: { generation: price, editing: { ...price, summary: `参考图价格：${id}` } }, verification: { t2i: { status: 'passed', checkedAt: '2026-10-18', elapsedSeconds: 12 }, it2i: { status: 'failed', checkedAt: '2026-10-18', message: '当前资源请求失败' } } }
}
function selectableProviders() {
  return [
    { ...providers[0], defaultModel: 'qwen-image-3.0', models: [selectableModel('qwen-image-3.0'), selectableModel('qwen-image-3.0-pro'), selectableModel('z-image-turbo', false)] },
    { ...providers[1], configured: true, defaultModel: 'gpt-image-2.5-flare', models: [selectableModel('gpt-image-2.5-flare'), selectableModel('FLUX.2-pro'), selectableModel('FLUX-1.1-pro', false)] },
  ]
}

describe('MemeStudioPage', () => {
  it('exposes FLUX 2 reference upload and sends it, while FLUX 1.1 remains text-only', async () => {
    mockApi({ providers: selectableProviders() })
    renderPage()
    await ready()
    fireEvent.change(screen.getByLabelText('图片服务'), { target: { value: 'azure' } })
    fireEvent.change(screen.getByLabelText('图片模型'), { target: { value: 'FLUX.2-pro' } })
    expect(screen.getByLabelText(/参考图/)).toBeEnabled()
    fireEvent.change(screen.getByLabelText(/参考图/), { target: { files: [pngFile()] } })
    await screen.findByAltText('已选择的参考图')
    enterPrompt()
    fireEvent.click(screen.getByRole('button', { name: '生成一张' }))
    await screen.findByRole('link', { name: '下载图片' })
    expect(JSON.parse(paidCalls()[0]![1]!.body as string)).toMatchObject({ provider: 'azure', model: 'FLUX.2-pro', referenceImage: IMAGE })
    fireEvent.change(screen.getByLabelText('图片模型'), { target: { value: 'FLUX-1.1-pro' } })
    await waitFor(() => expect(screen.queryByAltText('已选择的参考图')).not.toBeInTheDocument())
    expect(screen.getByLabelText(/参考图/)).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '再生成一张' }))
    await waitFor(() => expect(paidCalls()).toHaveLength(2))
    expect(JSON.parse(paidCalls()[1]![1]!.body as string)).toEqual({ provider: 'azure', model: 'FLUX-1.1-pro', prompt: '困困的猫' })
  })

  it('selects a registered model directly, clears unsupported reference and transmits the chosen ID', async () => {
    mockApi({ providers: selectableProviders() })
    renderPage()
    await ready()
    expect(screen.getByLabelText('图片模型')).toHaveValue('qwen-image-3.0')
    expect(screen.getByLabelText('模式与实测')).toHaveTextContent('接口出图已验证')
    expect(screen.getByLabelText('模式与实测')).toHaveTextContent('上次实测失败')
    fireEvent.change(screen.getByLabelText(/参考图/), { target: { files: [pngFile()] } })
    await screen.findByAltText('已选择的参考图')
    expect(screen.getByLabelText('费用参考')).toHaveTextContent('参考图价格：qwen-image-3.0')
    fireEvent.change(screen.getByLabelText('图片模型'), { target: { value: 'z-image-turbo' } })
    await waitFor(() => expect(screen.queryByAltText('已选择的参考图')).not.toBeInTheDocument())
    expect(screen.getByLabelText(/参考图/)).toBeDisabled()
    expect(screen.getByLabelText('模式与实测')).toHaveTextContent('参考图加文字生成图片：本页未接入')
    expect(screen.getByLabelText('费用参考')).toHaveTextContent('价格说明：z-image-turbo')
    expect(paidCalls()).toHaveLength(0)
    enterPrompt()
    fireEvent.click(screen.getByRole('button', { name: '生成一张' }))
    await screen.findByRole('link', { name: '下载图片' })
    expect(JSON.parse(paidCalls()[0]![1]!.body as string)).toEqual({ provider: 'dashscope', model: 'z-image-turbo', prompt: '困困的猫' })
  })

  it('switches provider without submitting a model from the old provider', async () => {
    mockApi({ providers: selectableProviders() })
    renderPage()
    await ready()
    fireEvent.change(screen.getByLabelText('图片模型'), { target: { value: 'qwen-image-3.0-pro' } })
    fireEvent.change(screen.getByLabelText('图片服务'), { target: { value: 'azure' } })
    expect(screen.getByLabelText('图片模型')).toHaveValue('gpt-image-2.5-flare')
    expect(screen.getByLabelText('费用参考')).toHaveTextContent('价格说明：gpt-image-2.5-flare')
    enterPrompt()
    fireEvent.click(screen.getByRole('button', { name: '生成一张' }))
    await screen.findByRole('link', { name: '下载图片' })
    expect(JSON.parse(paidCalls()[0]![1]!.body as string)).toMatchObject({ provider: 'azure', model: 'gpt-image-2.5-flare' })
  })

  it('sends a reference with the selected image-capable model, not a hidden edit model', async () => {
    mockApi({ providers: selectableProviders() })
    renderPage()
    await ready()
    fireEvent.change(screen.getByLabelText('图片模型'), { target: { value: 'qwen-image-3.0-pro' } })
    fireEvent.change(screen.getByLabelText(/参考图/), { target: { files: [pngFile()] } })
    await screen.findByAltText('已选择的参考图')
    enterPrompt()
    fireEvent.click(screen.getByRole('button', { name: '生成一张' }))
    await screen.findByRole('link', { name: '下载图片' })
    expect(JSON.parse(paidCalls()[0]![1]!.body as string)).toMatchObject({ provider: 'dashscope', model: 'qwen-image-3.0-pro', referenceImage: IMAGE })
  })

  it('shows sourced generation and reference prices, but never guesses an Azure amount', async () => {
    const generation = { summary: 'US$0.030/张输出', scope: '新加坡标准价，1K/2K 输出，以账单为准。', verified: true, sourceUrl: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', checkedAt: '2026-10-18' }
    const editing = { ...generation, summary: 'US$0.033/次：1 张参考图和 1 张输出。' }
    const azurePrice = { ...generation, summary: '当前资源单价未核实，不显示猜测金额。', verified: false, sourceUrl: 'https://azure.microsoft.com/en-us/pricing/details/azure-openai/' }
    mockApi({ providers: [
      { ...providers[0], model: 'qwen-image-3.0', editModel: 'qwen-image-3.0', pricing: { generation, editing } },
      { ...providers[1], configured: true, pricing: { generation: azurePrice, editing: azurePrice } },
    ] })
    renderPage()
    await ready()
    expect(screen.getByLabelText('费用参考')).toHaveTextContent('US$0.030')
    expect(screen.getByRole('link', { name: '官方价格说明' })).toHaveAttribute('href', generation.sourceUrl)
    fireEvent.change(screen.getByLabelText(/参考图/), { target: { files: [pngFile()] } })
    await screen.findByAltText('已选择的参考图')
    expect(screen.getByLabelText('费用参考')).toHaveTextContent('US$0.033')
    fireEvent.change(screen.getByLabelText('图片服务'), { target: { value: 'azure' } })
    expect(screen.getByLabelText('费用参考')).toHaveTextContent('单价待核实')
    expect(screen.getByLabelText('费用参考')).not.toHaveTextContent('US$0.030')
    expect(paidCalls()).toHaveLength(0)
  })

  it('shows empty state and selects only a configured provider', async () => {
    renderPage()
    await ready()
    expect(screen.getByText('还没有生成过表情')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Azure · 未配置' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '生成一张' })).toBeDisabled()
    expect(paidCalls()).toHaveLength(0)
  })

  it('explains missing configuration without allowing generation', async () => {
    mockApi({ providers: providers.map(item => ({ ...item, configured: false })) })
    renderPage()
    expect(await screen.findByText(/暂无可用的图片服务/)).toBeInTheDocument()
    expect(screen.getByLabelText('图片服务')).toBeDisabled()
    enterPrompt()
    expect(screen.getByRole('button', { name: '生成一张' })).toBeDisabled()
  })

  it('shows a clear authentication instruction and link', async () => {
    fetchMock.mockResolvedValue(json({ error: 'authentication_required' }, 401))
    renderPage()
    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent('完成浏览器认证')
    expect(screen.getByRole('link', { name: '前往在线会话页' })).toHaveAttribute('href', '/live-sessions')
    expect(paidCalls()).toHaveLength(0)
  })

  it('submits one job with a chosen style and saves the stored file', async () => {
    renderPage()
    await ready()
    enterPrompt()
    fireEvent.click(screen.getByRole('radio', { name: '像素风' }))
    expect(screen.getByRole('radio', { name: '像素风' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '生成一张' }))
    const save = await screen.findByRole('link', { name: '下载图片' })
    expect(save).toHaveAttribute('href', '/api/memes/images/m1abc-abcd1234?download=1')
    expect(save.getAttribute('download')).toMatch(/\.png$/)
    expect(paidCalls()).toHaveLength(1)
    const init = paidCalls()[0]![1]!
    expect(init.credentials).toBe('same-origin')
    expect(JSON.parse(init.body as string)).toEqual({ provider: 'dashscope', prompt: '困困的猫', style: '像素风' })
    expect(screen.getByRole('button', { name: '再生成一张' })).toBeEnabled()
    expect(requests('/api/memes/jobs')).toHaveLength(1)
  })

  it('shows the save location and every past record on load', async () => {
    const older = job({ id: 'm1aaa-11112222', prompt: '开心的狗', imageUrl: '/api/memes/images/m1aaa-11112222' })
    const newer = job({ id: 'm1bbb-33334444', prompt: '困困的猫', imageUrl: '/api/memes/images/m1bbb-33334444' })
    mockApi({ jobs: [newer, older] })
    renderPage()
    expect(await screen.findByAltText('生成的表情包：困困的猫')).toBeInTheDocument()
    expect(screen.getByText(/共 2 条记录/)).toBeInTheDocument()
    expect(screen.getByText(OUTPUT_DIR, { selector: 'code' })).toBeInTheDocument()
    expect(screen.getByLabelText('全部生成历史').children).toHaveLength(2)
    expect(screen.getByRole('button', { name: /查看 .* 的记录：困困的猫/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /查看 .* 的记录：开心的狗/ }))
    expect(await screen.findByAltText('生成的表情包：开心的狗')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '下载图片' })).toHaveAttribute('href', '/api/memes/images/m1aaa-11112222?download=1')
  })

  it('keeps a running job on screen and picks up the finished result from the server', async () => {
    let finished = false
    let posted = false
    const running = job({ status: 'running', imageUrl: undefined, mime: undefined, file: undefined, finishedAt: undefined, elapsedMs: undefined })
    const done = job()
    mockApi({
      jobs: () => !posted ? [] : finished ? [done] : [running],
      post: () => { posted = true; return json({ job: running }, 202) },
    })
    renderPage()
    await ready()
    enterPrompt()
    fireEvent.click(screen.getByRole('button', { name: '生成一张' }))
    expect(await screen.findByText(/后台正在生成/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /正在生成/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /正在生成/ }))
    expect(paidCalls()).toHaveLength(1)
    expect(screen.getAllByText(/生成中/).length).toBeGreaterThan(0)
    finished = true
    fireEvent.click(screen.getByRole('button', { name: '刷新记录' }))
    expect(await screen.findByRole('link', { name: '下载图片' })).toBeInTheDocument()
    expect(screen.getByAltText('生成的表情包：困困的猫')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '再生成一张' })).toBeEnabled()
  })

  it('explains failed jobs from the history without retrying them', async () => {
    const failed = job({ status: 'failed', imageUrl: undefined, mime: undefined, file: undefined, error: '图片服务额度不足，请稍后再试。' })
    mockApi({ jobs: [failed] })
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('额度不足')
    expect(screen.queryByRole('link', { name: '下载图片' })).not.toBeInTheDocument()
    expect(paidCalls()).toHaveLength(0)
  })

  it('does not accidentally submit when refreshing providers', async () => {
    renderPage()
    await ready()
    enterPrompt()
    fireEvent.click(screen.getByRole('button', { name: '刷新服务列表' }))
    await waitFor(() => expect(requests('/api/memes/providers')).toHaveLength(2))
    expect(paidCalls()).toHaveLength(0)
  })

  it('uploads a reference, uses the selected edit path, and removes it without generating', async () => {
    renderPage()
    await ready()
    fireEvent.change(screen.getByLabelText(/参考图/), { target: { files: [pngFile()] } })
    expect(await screen.findByAltText('已选择的参考图')).toHaveAttribute('src', IMAGE)
    expect(screen.getByText('模型：qwen-image-edit')).toBeInTheDocument()
    enterPrompt()
    fireEvent.click(screen.getByRole('button', { name: '生成一张' }))
    await screen.findByRole('link', { name: '下载图片' })
    expect(JSON.parse(paidCalls()[0]![1]!.body as string).referenceImage).toBe(IMAGE)
    fireEvent.click(screen.getByRole('button', { name: /移除/ }))
    expect(screen.queryByAltText('已选择的参考图')).not.toBeInTheDocument()
    expect(paidCalls()).toHaveLength(1)
    expect(screen.getByText('模型：qwen-image-max')).toBeInTheDocument()
  })

  it('fills the prompt from an example chip and can reuse a past description', async () => {
    const older = job({ id: 'm1aaa-11112222', prompt: '开心的狗', style: '夸张搞笑', imageUrl: '/api/memes/images/m1aaa-11112222' })
    mockApi({ jobs: [older] })
    renderPage()
    expect(await screen.findByAltText('生成的表情包：开心的狗')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '用这条描述再生成' }))
    expect(screen.getByLabelText('想做什么表情？')).toHaveValue('开心的狗')
    expect(screen.getByRole('radio', { name: '夸张搞笑' })).toBeChecked()
    expect(paidCalls()).toHaveLength(0)
  })

  it('copies the save path so the files can be found in a terminal', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mockApi({ jobs: [job()] })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '复制保存路径' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(OUTPUT_DIR))
    expect(screen.getByRole('button', { name: '复制保存路径' })).toHaveTextContent('已复制')
  })

  it('offers example prompts in the empty state instead of a blank page', async () => {
    renderPage()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: /使用示例：.*再睡五分钟/ }))
    expect(screen.getByLabelText('想做什么表情？')).toHaveValue('一只困得睁不开眼的橘猫抱着咖啡，配字「再睡五分钟」')
    expect(paidCalls()).toHaveLength(0)
  })

  it('accepts a pasted clipboard image as the reference image', async () => {
    renderPage()
    await ready()
    enterPrompt()
    const file = pngFile('screenshot.png')
    await act(async () => {
      const event = new Event('paste', { bubbles: true })
      Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }], files: [file] } })
      document.dispatchEvent(event)
    })
    expect(await screen.findByAltText('已选择的参考图')).toHaveAttribute('src', IMAGE)
    expect(screen.getByText('剪贴板图片')).toBeInTheDocument()
    expect(screen.getByText('模型：qwen-image-edit')).toBeInTheDocument()
    expect(paidCalls()).toHaveLength(0)
  })

  it('ignores pasted text so the prompt can still be typed normally', async () => {
    renderPage()
    await ready()
    await act(async () => {
      const event = new Event('paste', { bubbles: true })
      Object.defineProperty(event, 'clipboardData', { value: { items: [], files: [] } })
      document.dispatchEvent(event)
    })
    expect(screen.queryByAltText('已选择的参考图')).not.toBeInTheDocument()
  })

  it('rejects unsupported uploads before calling the provider', async () => {
    renderPage()
    await ready()
    const file = new File(['<svg/>'], 'cat.svg', { type: 'image/svg+xml' })
    fireEvent.change(screen.getByLabelText(/参考图/), { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('只支持 PNG、JPEG 或 WebP')
    expect(paidCalls()).toHaveLength(0)
  })

  it('shows provider errors without automatically retrying', async () => {
    mockApi({ post: () => json({ error: '图片服务额度不足，请稍后再试。' }, 502) })
    renderPage()
    await ready()
    enterPrompt()
    fireEvent.click(screen.getByRole('button', { name: '生成一张' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('额度不足')
    expect(paidCalls()).toHaveLength(1)
    expect(screen.getByRole('button', { name: '生成一张' })).toBeEnabled()
  })

  it('offers an honest open-and-save action for temporary remote images', async () => {
    mockApi({ jobs: [job({ imageUrl: undefined, mime: undefined, file: undefined, remoteUrl: 'https://images.example.com/cat.png' })] })
    renderPage()
    const save = await screen.findByRole('link', { name: '打开原图保存' })
    expect(save).toHaveAttribute('target', '_blank')
    expect(save).toHaveAttribute('rel', 'noopener noreferrer')
    expect(save).not.toHaveAttribute('download')
    fireEvent.error(screen.getByAltText('生成的表情包：困困的猫'))
    expect(await screen.findByRole('alert')).toHaveTextContent('临时链接可能已过期')
    expect(paidCalls()).toHaveLength(0)
  })
})