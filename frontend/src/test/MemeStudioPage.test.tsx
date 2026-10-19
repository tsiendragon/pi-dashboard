import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import MemeStudioPage from '../pages/MemeStudioPage'

const IMAGE = 'data:image/png;base64,iVBORw0KGgo='
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

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (_url, init) => init?.method === 'POST'
    ? json({ image: IMAGE, provider: 'dashscope', model: 'qwen-image-max' })
    : json({ providers }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function selectableModel(id: string, reference = true) {
  const price = { summary: `价格说明：${id}`, scope: '以实际账单为准', sourceUrl: 'https://example.com/pricing', checkedAt: '2026-10-18', verified: false }
  return { id, label: id, configured: true, modes: reference ? ['t2i', 'it2i'] : ['t2i'], pricing: { generation: price, editing: { ...price, summary: `参考图价格：${id}` } }, verification: { t2i: { status: 'passed', checkedAt: '2026-10-18', elapsedSeconds: 12 }, it2i: { status: 'failed', checkedAt: '2026-10-18', message: '当前资源请求失败' } } }
}
function mockSelectableProviders() {
  const list = [
    { ...providers[0], defaultModel: 'qwen-image-3.0', models: [selectableModel('qwen-image-3.0'), selectableModel('qwen-image-3.0-pro'), selectableModel('z-image-turbo', false)] },
    { ...providers[1], configured: true, defaultModel: 'gpt-image-2.5-flare', models: [selectableModel('gpt-image-2.5-flare'), selectableModel('FLUX.2-pro'), selectableModel('FLUX-1.1-pro', false)] },
  ]
  fetchMock.mockImplementation(async (_url, init) => init?.method === 'POST'
    ? json({ image: IMAGE, provider: JSON.parse(init.body as string).provider, model: JSON.parse(init.body as string).model })
    : json({ providers: list }))
}

describe('MemeStudioPage', () => {
  it('exposes FLUX 2 reference upload and sends it, while FLUX 1.1 remains text-only', async () => {
    mockSelectableProviders()
    renderPage()
    await ready()
    fireEvent.change(screen.getByLabelText('图片服务'), { target: { value: 'azure' } })
    fireEvent.change(screen.getByLabelText('图片模型'), { target: { value: 'FLUX.2-pro' } })
    expect(screen.getByLabelText(/参考图/)).toBeEnabled()
    const file = new File([new Uint8Array([137,80,78,71,13,10,26,10])], 'cat.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/参考图/), { target: { files: [file] } })
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
    mockSelectableProviders()
    renderPage()
    await ready()
    expect(screen.getByLabelText('图片模型')).toHaveValue('qwen-image-3.0')
    expect(screen.getByLabelText('模式与实测')).toHaveTextContent('接口出图已验证')
    expect(screen.getByLabelText('模式与实测')).toHaveTextContent('上次实测失败')
    const file = new File([new Uint8Array([137,80,78,71,13,10,26,10])], 'cat.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/参考图/), { target: { files: [file] } })
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
    mockSelectableProviders()
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
    mockSelectableProviders()
    renderPage()
    await ready()
    fireEvent.change(screen.getByLabelText('图片模型'), { target: { value: 'qwen-image-3.0-pro' } })
    const file = new File([new Uint8Array([137,80,78,71,13,10,26,10])], 'cat.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/参考图/), { target: { files: [file] } })
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
    fetchMock.mockResolvedValue(json({ providers: [
      { ...providers[0], model: 'qwen-image-3.0', editModel: 'qwen-image-3.0', pricing: { generation, editing } },
      { ...providers[1], configured: true, pricing: { generation: azurePrice, editing: azurePrice } },
    ] }))
    renderPage()
    await ready()
    expect(screen.getByLabelText('费用参考')).toHaveTextContent('US$0.030')
    expect(screen.getByRole('link', { name: '官方价格说明' })).toHaveAttribute('href', generation.sourceUrl)
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'cat.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/参考图/), { target: { files: [file] } })
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
    expect(screen.getByText('你的第一张表情包会出现在这里')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Azure · 未配置' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '生成一张' })).toBeDisabled()
    expect(paidCalls()).toHaveLength(0)
  })

  it('explains missing configuration without allowing generation', async () => {
    fetchMock.mockResolvedValue(json({ providers: providers.map(item => ({ ...item, configured: false })) }))
    renderPage()
    expect(await screen.findByText(/暂无可用的图片服务/)).toBeInTheDocument()
    expect(screen.getByLabelText('图片服务')).toBeDisabled()
    enterPrompt()
    expect(screen.getByRole('button', { name: '生成一张' })).toBeDisabled()
  })

  it('shows a clear authentication instruction and link', async () => {
    fetchMock.mockResolvedValue(json({ error: 'authentication_required' }, 401))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('完成浏览器认证')
    expect(screen.getByRole('link', { name: '前往在线会话页' })).toHaveAttribute('href', '/live-sessions')
    expect(paidCalls()).toHaveLength(0)
  })

  it('generates one image with a chosen style and provides saving', async () => {
    renderPage()
    await ready()
    enterPrompt()
    fireEvent.change(screen.getByLabelText('画风'), { target: { value: '像素风' } })
    fireEvent.click(screen.getByRole('button', { name: '生成一张' }))
    expect(await screen.findByRole('link', { name: '下载图片' })).toHaveAttribute('href', IMAGE)
    expect(screen.getByRole('link', { name: '下载图片' }).getAttribute('download')).toMatch(/\.png$/)
    expect(paidCalls()).toHaveLength(1)
    const init = paidCalls()[0]![1]!
    expect(init.credentials).toBe('same-origin')
    expect(JSON.parse(init.body as string)).toEqual({ provider: 'dashscope', prompt: '困困的猫', style: '像素风' })
    expect(screen.getByRole('button', { name: '再生成一张' })).toBeEnabled()
    expect(screen.getByText(/本页保留最近 3 张/)).toBeInTheDocument()
  })

  it('does not accidentally submit when refreshing providers', async () => {
    renderPage()
    await ready()
    enterPrompt()
    fireEvent.click(screen.getByRole('button', { name: '刷新服务列表' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(paidCalls()).toHaveLength(0)
  })

  it('uploads a reference, uses edit model, and removes it without generating', async () => {
    renderPage()
    await ready()
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'cat.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/参考图/), { target: { files: [file] } })
    expect(await screen.findByAltText('已选择的参考图')).toHaveAttribute('src', IMAGE)
    expect(screen.getByText('模型：qwen-image-edit')).toBeInTheDocument()
    enterPrompt()
    fireEvent.click(screen.getByRole('button', { name: '生成一张' }))
    await screen.findByRole('link', { name: '下载图片' })
    expect(JSON.parse(paidCalls()[0]![1]!.body as string).referenceImage).toBe(IMAGE)
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(screen.queryByAltText('已选择的参考图')).not.toBeInTheDocument()
    expect(paidCalls()).toHaveLength(1)
    expect(screen.getByText('模型：qwen-image-max')).toBeInTheDocument()
  })

  it('rejects unsupported uploads before calling the provider', async () => {
    renderPage()
    await ready()
    const file = new File(['<svg/>'], 'cat.svg', { type: 'image/svg+xml' })
    fireEvent.change(screen.getByLabelText(/参考图/), { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('只支持 PNG、JPEG 或 WebP')
    expect(paidCalls()).toHaveLength(0)
  })

  it('disables repeated generation while waiting for the provider', async () => {
    let finish!: (value: Response) => void
    fetchMock.mockImplementation(async (_url, init) => init?.method === 'POST'
      ? new Promise<Response>(resolve => { finish = resolve }) : json({ providers }))
    renderPage()
    await ready()
    enterPrompt()
    fireEvent.click(screen.getByRole('button', { name: '生成一张' }))
    expect(await screen.findByRole('button', { name: '正在生成…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '正在生成…' }))
    expect(paidCalls()).toHaveLength(1)
    await act(async () => { finish(json({ image: IMAGE, provider: 'dashscope', model: 'qwen-image-max' })) })
    expect(await screen.findByRole('link', { name: '下载图片' })).toBeInTheDocument()
  })

  it('shows provider errors without automatically retrying', async () => {
    fetchMock.mockImplementation(async (_url, init) => init?.method === 'POST'
      ? json({ error: '图片服务额度不足，请稍后再试。' }, 502) : json({ providers }))
    renderPage()
    await ready()
    enterPrompt()
    fireEvent.click(screen.getByRole('button', { name: '生成一张' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('额度不足')
    expect(paidCalls()).toHaveLength(1)
    expect(screen.getByRole('button', { name: '生成一张' })).toBeEnabled()
  })

  it('offers an honest open-and-save action for temporary remote images', async () => {
    fetchMock.mockImplementation(async (_url, init) => init?.method === 'POST'
      ? json({ image: 'https://images.example.com/cat.png', provider: 'dashscope', model: 'qwen-image-max' }) : json({ providers }))
    renderPage()
    await ready()
    enterPrompt()
    fireEvent.click(screen.getByRole('button', { name: '生成一张' }))
    const save = await screen.findByRole('link', { name: '打开原图保存' })
    expect(save).toHaveAttribute('target', '_blank')
    expect(save).toHaveAttribute('rel', 'noopener noreferrer')
    expect(save).not.toHaveAttribute('download')
    fireEvent.error(screen.getByAltText('生成的表情包：困困的猫'))
    expect(screen.getByRole('alert')).toHaveTextContent('临时链接可能已过期')
  })
})
