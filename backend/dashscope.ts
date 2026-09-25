/**
 * Shared DashScope (Aliyun Model Studio) endpoint + credential resolution,
 * used by both the TTS and ASR adapters.
 */
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DEFAULT_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com'

/** Multimodal generation endpoint: TTS synthesis and ASR transcription both live here. */
export const DASHSCOPE_MULTIMODAL_PATH = '/api/v1/services/aigc/multimodal-generation/generation'
export const DASHSCOPE_REQUEST_TIMEOUT_MS = 120_000

/** `https://host/compatible-mode/v1` → `https://host` */
function stripCompatSuffix(baseUrl: string): string {
  return baseUrl.replace(/\/compatible-mode\/v\d+\/?$/, '').replace(/\/+$/, '')
}

let cachedBaseUrl: string | undefined

/**
 * Region resolution, most explicit first: env override → the DashScope base URL
 * the pi models config already points `DASHSCOPE_API_KEY` at → vendor default.
 * Auto-detection keeps the key and the endpoint in the same region.
 */
export function resolveDashscopeBaseUrl(): string {
  const explicit = process.env.DASHSCOPE_TTS_BASE_URL || process.env.DASHSCOPE_BASE_URL
  if (explicit?.trim()) return stripCompatSuffix(explicit.trim())
  if (cachedBaseUrl) return cachedBaseUrl
  try {
    const modelsPath = join(homedir(), '.pi', 'agent', 'models.json')
    if (existsSync(modelsPath)) {
      const parsed = JSON.parse(readFileSync(modelsPath, 'utf-8')) as {
        providers?: Record<string, { baseUrl?: unknown }>
      }
      const baseUrl = parsed.providers?.dashscope?.baseUrl
      if (typeof baseUrl === 'string' && baseUrl.trim()) {
        cachedBaseUrl = stripCompatSuffix(baseUrl.trim())
        return cachedBaseUrl
      }
    }
  } catch (error) {
    console.warn('[dashscope] Failed to read dashscope baseUrl from models.json:', error)
  }
  cachedBaseUrl = DEFAULT_DASHSCOPE_BASE_URL
  return cachedBaseUrl
}

export function dashscopeApiKey(): string | undefined {
  return process.env.DASHSCOPE_API_KEY?.trim() || undefined
}