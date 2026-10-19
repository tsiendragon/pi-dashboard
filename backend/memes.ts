/** Image requests follow Toolkit's Qwen, Azure GPT Image, FLUX and MAI wire formats. */
import { findMemeModel, MEME_MODELS, modelVerification, type MemeAdapter } from './meme-models.js'
export type MemeProvider = 'dashscope' | 'azure'

export class MemeError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message)
    this.name = 'MemeError'
  }
}

export const MEME_MAX_REFERENCE_BYTES = 8 * 1024 * 1024
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024

function config() {
  return {
    dashscope: {
      key: process.env.DASHSCOPE_API_KEY?.trim() || '',
      endpoint: process.env.DASHSCOPE_IMAGE_ENDPOINT?.trim()
        || 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      model: process.env.DASHSCOPE_IMAGE_MODEL?.trim() || 'qwen-image-3.0',
      editModel: process.env.DASHSCOPE_IMAGE_EDIT_MODEL?.trim() || 'qwen-image-3.0',
    },
    azure: {
      key: process.env.AZURE_OPENAI_IMAGE_API_KEY?.trim() || '',
      endpoint: process.env.AZURE_OPENAI_IMAGE_ENDPOINT?.trim() || '',
      model: process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT?.trim() || 'gpt-image-2.5-sunburst',
      version: process.env.AZURE_OPENAI_IMAGE_API_VERSION?.trim() || '2025-04-01-preview',
      auth: process.env.AZURE_OPENAI_IMAGE_AUTH?.trim() || 'bearer',
      fluxEndpoint: process.env.AZURE_FLUX2_ENDPOINT?.trim() || '',
      fluxKey: process.env.AZURE_FLUX2_API_KEY?.trim() || '',
      maiEndpoint: process.env.AZURE_MAI_IMAGE_ENDPOINT?.trim() || '',
      maiKey: process.env.AZURE_MAI_IMAGE_API_KEY?.trim() || '',
    },
  }
}

function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

function pricing(provider: MemeProvider, model: string, endpoint: string, withReference: boolean) {
  const sourceUrl = provider === 'dashscope'
    ? 'https://www.alibabacloud.com/help/en/model-studio/model-pricing'
    : 'https://azure.microsoft.com/en-us/pricing/details/azure-openai/'
  let singapore = false
  if (validEndpoint(endpoint)) {
    const host = new URL(endpoint).hostname
    singapore = host === 'dashscope-intl.aliyuncs.com' || host.endsWith('.ap-southeast-1.maas.aliyuncs.com')
  }
  const summaries: Record<string, string> = {
    'qwen-image-3.0': withReference ? 'US$0.033/次：1 张参考图 US$0.003 + 1 张输出 US$0.030。' : 'US$0.030/张输出；本次不含参考图费用。',
    'qwen-image-3.0-pro': withReference ? '1K 输出 US$0.043/次，2K 输出 US$0.078/次，均含 1 张参考图 US$0.003。' : '1K 输出 US$0.040/张，2K 输出 US$0.075/张。',
    'qwen-image-2.0': 'US$0.035/张输出，文字生成和参考图编辑同价。',
    'qwen-image-2.0-pro': 'US$0.075/张输出，文字生成和参考图编辑同价。',
    'z-image-turbo': 'US$0.015～0.030/张；是否开启提示词改写会影响单价。',
  }
  const summary = provider === 'dashscope' && singapore ? summaries[model] : undefined
  return {
    summary: summary || (provider === 'azure'
      ? '按文字、参考图和输出图片的用量计费；当前资源单价未核实，不显示猜测金额。'
      : '当前模型或地域的单价未核实，不显示猜测金额。'),
    scope: summary ? '新加坡标准价；Qwen 3 系列限 1K/2K 输出，不含折扣、免费额度和税费，以实际账单为准。' : '以服务所在地域、部署和实际账单为准。',
    sourceUrl,
    checkedAt: '2026-10-19',
    verified: !!summary,
  }
}

function connection(adapter: MemeAdapter, settings: ReturnType<typeof config>) {
  if (adapter === 'dashscope') return { endpoint: settings.dashscope.endpoint, key: settings.dashscope.key, auth: 'bearer' }
  const cfg = settings.azure
  const host = cfg.endpoint.replace(/\/$/, '').replace('.cognitiveservices.azure.com', '.services.ai.azure.com')
  if (adapter === 'flux11') return { endpoint: host ? `${host}/providers/blackforestlabs/v1/flux-pro-1.1?api-version=preview` : '', key: cfg.key, auth: 'bearer' }
  if (adapter === 'flux2') return { endpoint: cfg.fluxEndpoint || (host ? `${host}/providers/blackforestlabs/v1/flux-2-pro?api-version=preview` : ''), key: cfg.fluxKey || cfg.key, auth: 'bearer' }
  if (adapter === 'mai') return { endpoint: cfg.maiEndpoint ? `${cfg.maiEndpoint.replace(/\/$/, '')}/mai/v1/images/generations?api-version=preview` : host ? `${host}/mai/v1/images/generations?api-version=preview` : '', key: cfg.maiKey || cfg.key, auth: 'api-key' }
  return { endpoint: cfg.endpoint, key: cfg.key, auth: cfg.auth }
}

function configured(value: ReturnType<typeof connection>) {
  return !!value.key && validEndpoint(value.endpoint) && ['bearer', 'api-key'].includes(value.auth)
}

export function memeProviders() {
  const settings = config()
  const { dashscope, azure } = settings
  const descriptors = MEME_MODELS.map(model => {
    const target = connection(model.adapter, settings)
    return {
      id: model.id, label: model.label, provider: model.provider, modes: model.modes, note: model.note,
      configured: configured(target),
      pricing: { generation: pricing(model.provider, model.id, target.endpoint, false), editing: model.modes.includes('it2i') ? pricing(model.provider, model.id, target.endpoint, true) : { ...pricing(model.provider, model.id, target.endpoint, true), summary: '本页未接入参考图，不提供此模式报价。', verified: false } },
      verification: modelVerification(model.provider, model.id, target.endpoint),
    }
  })
  const dashModels = descriptors.filter(model => model.provider === 'dashscope')
  const azureModels = descriptors.filter(model => model.provider === 'azure')
  return [
    {
      id: 'dashscope' as const, label: 'DashScope', configured: dashModels.some(model => model.configured), model: dashscope.model, editModel: dashscope.editModel,
      defaultModel: findMemeModel('dashscope', dashscope.model)?.id || 'qwen-image-3.0', models: dashModels,
      pricing: { generation: pricing('dashscope', dashscope.model, dashscope.endpoint, false), editing: pricing('dashscope', dashscope.editModel, dashscope.endpoint, true) },
    },
    {
      id: 'azure' as const, label: 'Azure', configured: azureModels.some(model => model.configured), model: azure.model, editModel: azure.model,
      defaultModel: findMemeModel('azure', azure.model)?.id || 'gpt-image-2.5-sunburst', models: azureModels,
      pricing: { generation: pricing('azure', azure.model, azure.endpoint, false), editing: pricing('azure', azure.model, azure.endpoint, true) },
    },
  ]
}

function decodeBase64(value: string, limit: number): Buffer {
  if (value.length > Math.ceil(limit / 3) * 4) throw new MemeError('图片太大，请换一张较小的图片。')
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new MemeError('图片编码无效，请重新选择图片。')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > limit || bytes.toString('base64') !== value) throw new MemeError('图片编码无效或超过大小限制。')
  return bytes
}

function imageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

function reference(value: unknown): { dataUrl: string; bytes: Buffer; mime: string } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new MemeError('参考图格式无效。')
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]*)$/.exec(value)
  if (!match) throw new MemeError('参考图只支持 PNG、JPEG 或 WebP。')
  const bytes = decodeBase64(match[2]!, MEME_MAX_REFERENCE_BYTES)
  if (imageMime(bytes) !== match[1]) throw new MemeError('图片内容与文件类型不符。')
  return { dataUrl: value, bytes, mime: match[1]! }
}

function field(value: unknown, name: string, max: number, required = false): string {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) {
    throw new MemeError(`${name}${required ? '不能为空，且' : ''}最多 ${max} 字。`)
  }
  return value.trim()
}

interface ProviderResponse {
  data?: { b64_json?: string; url?: string }[]
  output?: { choices?: { message?: { content?: { image?: string }[] } }[] }
}

export async function generateMeme(input: unknown, fetchImpl: typeof fetch = fetch) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MemeError('请求格式无效。')
  const body = input as Record<string, unknown>
  if (body.provider !== 'azure' && body.provider !== 'dashscope') throw new MemeError('请选择有效的图片服务。')
  const provider = body.provider
  const explicitModel = body.model === undefined ? undefined : typeof body.model === 'string' ? findMemeModel(provider, body.model) : undefined
  if (body.model !== undefined && !explicitModel) throw new MemeError('请选择此服务下已登记的模型。')
  const prompt = field(body.prompt, '描述', 2000, true)
  const style = field(body.style, '风格', 100)
  const image = reference(body.referenceImage)
  const settings = config()
  const model = explicitModel?.id || (provider === 'dashscope' ? image ? settings.dashscope.editModel : settings.dashscope.model : settings.azure.model)
  const definition = explicitModel || findMemeModel(provider, model)
  const mode = image ? 'it2i' : 't2i'
  if (definition && !definition.modes.includes(mode)) throw new MemeError('当前模型接口未接入参考图模式，请移除参考图或换一个模型。')
  const adapter = definition?.adapter || (provider === 'dashscope' ? 'dashscope' : 'openai')
  const target = connection(adapter, settings)
  if (!configured(target)) throw new MemeError('图片服务未配置，请检查后台密钥和服务地址。', 503)
  const instruction = adapter === 'flux11' || adapter === 'flux2'
    ? `Create a chat sticker with a clear subject, expressive face and simple composition. ${style ? `Style: ${style}. ` : ''}${image ? 'Preserve the subject in the reference image. ' : ''}User request: ${prompt}`
    : `请创作一张适合聊天使用的表情包：主体清楚，表情鲜明，构图简洁。${style ? `画风：${style}。` : ''}${image ? '参考上传图片中的主体形象。' : ''}\n用户要求：${prompt}`
  let endpoint: string
  let init: RequestInit
  if (adapter === 'dashscope') {
    endpoint = target.endpoint
    init = {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: { messages: [{ role: 'user', content: [...(image ? [{ image: image.dataUrl }] : []), { text: instruction }] }] },
        parameters: model === 'z-image-turbo' ? { size: '1024*1024', n: 1 } : { watermark: false, negative_prompt: '', n: 1 },
      }),
    }
  } else {
    const cfg = settings.azure
    const headers: Record<string, string> = target.auth === 'api-key' ? { 'api-key': target.key } : { Authorization: `Bearer ${target.key}` }
    if (adapter === 'flux11' || adapter === 'flux2' || adapter === 'mai') {
      endpoint = target.endpoint
      const parameters = adapter === 'mai'
        ? { n: 1 }
        : { num_images: 1, output_format: 'jpeg', ...(image ? { input_image: image.bytes.toString('base64') } : {}) }
      init = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt: instruction, width: 1024, height: 1024, ...parameters }) }
    } else {
      const url = new URL(`${target.endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(model)}/images/${image ? 'edits' : 'generations'}`)
      url.searchParams.set('api-version', cfg.version)
      endpoint = url.toString()
      const parameters = { prompt: instruction, size: '1024x1024', ...(adapter === 'openai' ? { quality: 'medium' } : {}), n: 1 }
      if (adapter === 'flux-kontext') {
        init = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...parameters, ...(image ? { image: image.bytes.toString('base64') } : {}) }) }
      } else if (image) {
        const form = new FormData()
        const extension = image.mime === 'image/jpeg' ? 'jpg' : image.mime.split('/')[1]
        form.set('image', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), `reference.${extension}`)
        for (const [key, value] of Object.entries(parameters)) form.set(key, String(value))
        init = { method: 'POST', headers, body: form }
      } else {
        init = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(parameters) }
      }
    }
  }
  let response: Response
  try {
    response = await fetchImpl(endpoint, { ...init, redirect: 'error', signal: AbortSignal.timeout(180_000) })
  } catch (error) {
    const timedOut = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
    throw new MemeError(timedOut ? '生成超时；服务可能仍在处理，请勿连续重试。' : '无法连接图片服务，请检查后台配置。', timedOut ? 504 : 502)
  }
  if (!response.ok) {
    // Do not return upstream bodies: gateways may include credentials or signed URLs.
    throw new MemeError(`图片服务未能完成请求（${response.status}），请检查模型配置、额度或内容要求。`, 502)
  }
  let result: ProviderResponse
  try {
    result = await response.json() as ProviderResponse
  } catch {
    throw new MemeError('图片服务返回了无法读取的结果。', 502)
  }
  const item = result?.data?.[0]
  if (provider === 'azure' && item?.b64_json) {
    let bytes: Buffer
    try {
      bytes = decodeBase64(item.b64_json, MAX_OUTPUT_BYTES)
    } catch {
      throw new MemeError('图片服务返回的图片编码无效或超过 20 MiB。', 502)
    }
    const mime = imageMime(bytes)
    if (!mime) throw new MemeError('图片服务返回了不支持的图片格式。', 502)
    return { image: `data:${mime};base64,${item.b64_json}`, provider, model }
  }
  const imageUrl = provider === 'azure' ? item?.url : result?.output?.choices?.[0]?.message?.content?.find(part => part.image)?.image
  if (typeof imageUrl !== 'string' || !validEndpoint(imageUrl)) throw new MemeError('图片服务没有返回有效图片。', 502)
  // Provider URLs are returned, not fetched by this server (no arbitrary URL proxy).
  return { image: imageUrl, provider, model }
}
