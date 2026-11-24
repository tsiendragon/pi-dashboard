/**
 * Read/write Pi's `models.json` provider entries from Settings.
 *
 * This is deliberately a narrow credential surface:
 * - responses never contain API keys, only whether a key exists and its source;
 * - writes require the same browser auth as other machine-changing routes;
 * - every write is backed up and atomically renamed;
 * - keys written here live in models.json (mode 0600), matching Pi's own
 *   `apiKey` field. Subscription/OAuth credentials stay in auth.json and are
 *   only reported as a status, never edited by this route.
 */
import type { Express, Request, Response } from 'express'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import os from 'os'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { requireBrowserAuth } from './require-browser-auth.js'
import { settingsStore } from '../settings-store.js'

type JsonRecord = Record<string, unknown>

export interface ModelConfigRouteOptions {
  app: Express
  auth?: LiveSessionBrowserAuth
}

const ALLOWED_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'openai-codex-responses',
])
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/
const MAX_MODELS = 100

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || join(os.homedir(), '.pi', 'agent')
}

function modelsPath(): string { return join(agentDir(), 'models.json') }
function authPath(): string { return join(agentDir(), 'auth.json') }

function object(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
}

function readJson(path: string): JsonRecord {
  try {
    return object(JSON.parse(readFileSync(path, 'utf-8'))) ?? {}
  } catch {
    return {}
  }
}

function readModelFile(): { file: JsonRecord; providers: JsonRecord } {
  const file = readJson(modelsPath())
  const providers = object(file.providers) ?? {}
  return { file: { ...file, providers }, providers: { ...providers } }
}

function keyInfo(provider: JsonRecord | undefined, auth: JsonRecord | undefined): { hasKey: boolean; keySource: string } {
  const key = provider?.apiKey
  if (typeof key === 'string' && key.trim()) {
    return { hasKey: true, keySource: key.trim().startsWith('$') ? 'env' : 'stored' }
  }
  if (key !== undefined) return { hasKey: true, keySource: 'configured' }
  if (auth && (typeof auth.key === 'string' || typeof auth.access === 'string' || typeof auth.refresh === 'string')) {
    return { hasKey: true, keySource: auth.type === 'oauth' || typeof auth.access === 'string' ? 'pi-oauth' : 'pi-auth' }
  }
  return { hasKey: false, keySource: 'none' }
}

function publicModel(value: unknown): JsonRecord | undefined {
  const model = object(value)
  if (!model || typeof model.id !== 'string' || !MODEL_ID_RE.test(model.id)) return undefined
  const result: JsonRecord = { id: model.id }
  for (const key of ['name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'thinkingLevelMap', 'compat']) {
    if (model[key] !== undefined) result[key] = model[key]
  }
  return result
}

function publicProvider(id: string, provider: JsonRecord, auth: JsonRecord | undefined): JsonRecord {
  const result: JsonRecord = {
    id,
    api: typeof provider.api === 'string' ? provider.api : '',
    baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
    ...keyInfo(provider, auth),
    models: Array.isArray(provider.models) ? provider.models.map(publicModel).filter(Boolean) : [],
  }
  if (provider.apiKey === undefined && auth) result.piAuth = true
  return result
}

function validateProvider(id: string, body: JsonRecord): { value?: JsonRecord; error?: string } {
  if (!ID_RE.test(id)) return { error: 'Provider ID 只能包含小写字母、数字、点、下划线和连字符' }
  const api = typeof body.api === 'string' ? body.api.trim() : ''
  if (!ALLOWED_APIS.has(api)) return { error: '不支持的 API 类型' }
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
  let parsed: URL
  try { parsed = new URL(baseUrl) } catch { return { error: 'Base URL 无效' } }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: 'Base URL 必须是 HTTP(S)' }
  if (parsed.username || parsed.password) return { error: 'Base URL 不能包含凭据' }
  const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (key.length > 8192 || /[\u0000-\u001f\u007f]/.test(key)) return { error: 'API Key 格式无效' }
  if (!Array.isArray(body.models)) return { error: 'models 必须是数组' }
  if (body.models.length > MAX_MODELS) return { error: `最多 ${MAX_MODELS} 个模型` }
  const models: JsonRecord[] = []
  for (const raw of body.models) {
    const model = object(raw)
    const modelId = typeof model?.id === 'string' ? model.id.trim() : ''
    if (!model || !MODEL_ID_RE.test(modelId)) return { error: `模型 ID 无效：${modelId || '（空）'}` }
    const next: JsonRecord = { ...model, id: modelId }
    if (typeof next.name === 'string') next.name = next.name.trim().slice(0, 200)
    for (const field of ['contextWindow', 'maxTokens']) {
      if (next[field] !== undefined) {
        const number = Number(next[field])
        if (!Number.isInteger(number) || number <= 0) return { error: `模型 ${modelId} 的 ${field} 必须是正整数` }
        next[field] = number
      }
    }
    if (next.reasoning !== undefined) next.reasoning = next.reasoning === true
    if (next.input !== undefined) {
      if (!Array.isArray(next.input) || next.input.some(item => item !== 'text' && item !== 'image')) {
        return { error: `模型 ${modelId} 的 input 只能是 text/image` }
      }
    }
    models.push(next)
  }
  return { value: { api, baseUrl: parsed.toString().replace(/\/$/, ''), ...(key ? { apiKey: key } : {}), models } }
}

function backupModels(): string | null {
  const source = modelsPath()
  const dir = join(agentDir(), 'backups')
  const target = join(dir, `models-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  try {
    mkdirSync(dir, { recursive: true })
    if (existsSync(source)) copyFileSync(source, target)
    else writeFileSync(target, '{}\n', { mode: 0o600 })
    return target
  } catch {
    return null
  }
}

function writeModels(file: JsonRecord): void {
  const path = modelsPath()
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  renameSync(temp, path)
}

function mergeModel(existing: unknown, incoming: JsonRecord): JsonRecord {
  const previous = object(existing) ?? {}
  const next: JsonRecord = { ...previous, ...incoming }
  // Preserve adapter-specific fields when the mobile form only knows the basics.
  for (const key of ['compat', 'thinkingLevelMap', 'headers', 'inputLimits']) {
    if (incoming[key] === undefined && previous[key] !== undefined) next[key] = previous[key]
  }
  return next
}

export function registerModelConfigRoutes({ app, auth }: ModelConfigRouteOptions): void {
  if (!auth) return
  app.get('/api/model-config/providers', requireBrowserAuth(auth), (_req: Request, res: Response) => {
    const { providers } = readModelFile()
    const authFile = readJson(authPath())
    const authProviders = object(authFile) ?? {}
    const output: JsonRecord[] = []
    const seen = new Set<string>()
    for (const [id, value] of Object.entries(providers)) {
      const provider = object(value)
      if (!provider || !ID_RE.test(id)) continue
      seen.add(id)
      output.push(publicProvider(id, provider, object(authProviders[id])))
    }
    // Subscription/auth-only providers are useful status rows; they have no
    // editable models.json provider yet, so do not invent models for them.
    for (const [id, value] of Object.entries(authProviders)) {
      if (seen.has(id) || !ID_RE.test(id)) continue
      const authValue = object(value)
      if (!authValue) continue
      output.push({
        id,
        api: '',
        baseUrl: '',
        ...keyInfo(undefined, authValue),
        models: [],
        piAuth: true,
      })
    }
    output.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    res.setHeader('Cache-Control', 'no-store')
    res.json({ providers: output })
  })

  app.put('/api/model-config/providers/:id', requireBrowserAuth(auth), async (req: Request, res: Response) => {
    const id = String(req.params.id)
    const checked = validateProvider(id, object(req.body) ?? {})
    if (checked.error || !checked.value) return res.status(400).json({ error: checked.error || '配置无效' })
    try {
      const { file, providers } = readModelFile()
      const previous = object(providers[id])
      const incoming = checked.value
      const key = typeof incoming.apiKey === 'string' ? incoming.apiKey : undefined
      const existingModels = Array.isArray(previous?.models) ? previous.models : []
      const mergedModels = (incoming.models as JsonRecord[]).map(model =>
        mergeModel(existingModels.find(item => object(item)?.id === model.id), model))
      const nextProvider: JsonRecord = {
        ...(previous ?? {}),
        api: incoming.api,
        baseUrl: incoming.baseUrl,
        ...(key ? { apiKey: key } : {}),
        models: mergedModels,
      }
      // An empty key means "keep the saved key". Never erase a credential by accident.
      if (key === '' && previous?.apiKey !== undefined) nextProvider.apiKey = previous.apiKey
      providers[id] = nextProvider
      const backup = backupModels()
      if (!backup) return res.status(500).json({ error: '无法备份 models.json，未写入模型配置' })
      writeModels({ ...file, providers })

      let allowlistChanged = false
      try {
        const settings = settingsStore.read()
        const enabled = Array.isArray(settings.enabledModels) ? settings.enabledModels.filter((v): v is string => typeof v === 'string') : []
        if (enabled.length > 0) {
          const additions = mergedModels
            .map(model => `${id}/${String((model as JsonRecord).id)}`)
            .filter(pattern => !enabled.some(existing => existing === pattern || existing === `${id}/*`))
          if (additions.length) {
            await settingsStore.mutate((current, save) => {
              save({ ...current, enabledModels: [...enabled, ...additions] })
            })
            allowlistChanged = true
          }
        }
      } catch { /* models.json is saved; the UI can still ask for a reload */ }
      res.json({ provider: publicProvider(id, nextProvider, object(readJson(authPath())[id])), allowlistChanged, requiresSessionRestart: true })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : '保存模型配置失败' })
    }
  })
}
