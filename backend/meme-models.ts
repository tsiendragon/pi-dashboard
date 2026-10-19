import { createHash } from 'node:crypto'
import { memeModelChecks } from './meme-model-checks.js'

export type MemeMode = 't2i' | 'it2i'
export type MemeAdapter = 'dashscope' | 'openai' | 'flux-kontext' | 'flux2' | 'flux11' | 'mai'
export interface MemeModel {
  id: string
  label: string
  provider: 'dashscope' | 'azure'
  adapter: MemeAdapter
  modes: readonly MemeMode[]
  note?: string
}
const both: readonly MemeMode[] = ['t2i', 'it2i']
const textOnly: readonly MemeMode[] = ['t2i']
export const MEME_MODELS: readonly MemeModel[] = [
  { provider: 'dashscope', id: 'qwen-image-3.0', label: 'Qwen Image 3.0', adapter: 'dashscope', modes: both },
  { provider: 'dashscope', id: 'qwen-image-3.0-pro', label: 'Qwen Image 3.0 Pro', adapter: 'dashscope', modes: both },
  { provider: 'dashscope', id: 'qwen-image-2.0', label: 'Qwen Image 2.0', adapter: 'dashscope', modes: both },
  { provider: 'dashscope', id: 'qwen-image-2.0-pro', label: 'Qwen Image 2.0 Pro', adapter: 'dashscope', modes: both },
  { provider: 'dashscope', id: 'z-image-turbo', label: 'Z-Image Turbo', adapter: 'dashscope', modes: textOnly, note: '此型号仅接入文字生成，不接受参考图。' },
  { provider: 'azure', id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', adapter: 'openai', modes: both },
  { provider: 'azure', id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', adapter: 'openai', modes: both },
  { provider: 'azure', id: 'gpt-image-2', label: 'GPT Image 2', adapter: 'openai', modes: both },
  { provider: 'azure', id: 'gpt-image-1.5', label: 'GPT Image 1.5', adapter: 'openai', modes: both },
  { provider: 'azure', id: 'FLUX.1-Kontext-pro', label: 'FLUX.1 Kontext Pro', adapter: 'flux-kontext', modes: both },
  { provider: 'azure', id: 'FLUX-1.1-pro', label: 'FLUX 1.1 Pro', adapter: 'flux11', modes: textOnly, note: '文字生成已用英文描述实测；建议使用英文描述，未验证中文效果。' },
  { provider: 'azure', id: 'FLUX.2-pro', label: 'FLUX.2 Pro', adapter: 'flux2', modes: both, note: '文字与参考图模式均已实测；参考图编辑使用英文描述，建议使用英文描述。' },
  { provider: 'azure', id: 'MAI-Image-2e', label: 'MAI Image 2e', adapter: 'mai', modes: textOnly, note: '本页依据 Toolkit 当前接口仅接入文字生成；尚未接入参考图模式。' },
]

export function findMemeModel(provider: string, modelId: string) {
  return MEME_MODELS.find(model => model.provider === provider && model.id === modelId)
}

export function resourceFingerprint(endpoint: string) {
  try { return createHash('sha256').update(new URL(endpoint).host.toLowerCase()).digest('hex') } catch { return '' }
}

export function modelVerification(provider: string, modelId: string, endpoint: string) {
  const result = memeModelChecks[`${provider}/${modelId}`]
  const fingerprint = resourceFingerprint(endpoint)
  const check = (mode: MemeMode) => {
    const value = result?.[mode]
    if (!value || !fingerprint || value.resourceFingerprint !== fingerprint) return { status: 'untested' as const }
    const { resourceFingerprint: _privateScope, ...publicCheck } = value
    return publicCheck
  }
  return { t2i: check('t2i'), it2i: check('it2i') }
}
