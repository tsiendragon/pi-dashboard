/**
 * Persistent meme jobs: one small JSON index plus one image file per generation.
 *
 * Generation runs in the server process instead of inside the browser request, so leaving the
 * page does not cancel a paid call and coming back shows whatever finished in the meantime.
 * Results land on disk under `MEME_OUTPUT_DIR` (default `~/.pi/dashboard/memes`).
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { MemeMode } from './meme-models.js'
import {
  decodeBase64, imageMime, MemeError, MEME_MAX_OUTPUT_BYTES, runPreparedMeme,
  type MemeProvider, type PreparedMeme,
} from './memes.js'

export const MEME_HISTORY_LIMIT = 500
const INDEX_FILE = 'jobs.json'
const ID_RE = /^m[a-z0-9]+-[a-f0-9]{8}$/
const STALE_ERROR = '服务进程在执行这次生成时退出，图片可能已收费；请到服务商账单核对。'

export type MemeJobStatus = 'running' | 'done' | 'failed'

export interface MemeJobRecord {
  id: string
  status: MemeJobStatus
  provider: MemeProvider
  model: string
  mode: MemeMode
  prompt: string
  style: string
  createdAt: number
  finishedAt?: number
  elapsedMs?: number
  /** File name inside the output directory; absent when only the provider link survived. */
  file?: string
  mime?: string
  bytes?: number
  remoteUrl?: string
  error?: string
  note?: string
}

export interface MemeJobView extends MemeJobRecord {
  /** Authenticated same-origin URL for the saved file. */
  imageUrl?: string
}

interface MemeStore {
  dir: string
  jobs: MemeJobRecord[]
}

const stores = new Map<string, MemeStore>()

export function memeOutputDir(): string {
  const configured = process.env.MEME_OUTPUT_DIR?.trim()
  if (!configured) return join(homedir(), '.pi', 'dashboard', 'memes')
  return resolve(configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured)
}

/** Shows the home directory as `~` so the path is readable in the UI. */
export function displayMemeDir(dir: string): string {
  const home = homedir()
  return dir === home ? '~' : dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir
}

function indexFile(dir: string): string {
  return join(dir, INDEX_FILE)
}

function isJobRecord(value: unknown): value is MemeJobRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const job = value as Record<string, unknown>
  return ID_RE.test(String(job.id))
    && ['running', 'done', 'failed'].includes(String(job.status))
    && ['dashscope', 'azure'].includes(String(job.provider))
    && typeof job.model === 'string'
    && typeof job.prompt === 'string'
    && Number.isFinite(job.createdAt)
}

function readJobs(dir: string): MemeJobRecord[] {
  let raw: string
  try {
    raw = readFileSync(indexFile(dir), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Keep the damaged index for inspection instead of silently overwriting history.
    try { renameSync(indexFile(dir), join(dir, `jobs.corrupt-${Date.now()}.json`)) } catch { /* ignore */ }
    return []
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { jobs?: unknown } | null)?.jobs
  return Array.isArray(list) ? list.filter(isJobRecord).slice(0, MEME_HISTORY_LIMIT) : []
}

function persist(store: MemeStore): void {
  const target = indexFile(store.dir)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(store.dir, { recursive: true })
    writeFileSync(temporary, JSON.stringify({ version: 1, jobs: store.jobs }), 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    // A failed index write must not cancel a paid generation; the image file already exists.
    console.error('[memes] 无法写入表情包历史索引', error)
  }
}

function store(dir: string): MemeStore {
  const cached = stores.get(dir)
  if (cached) return cached
  mkdirSync(dir, { recursive: true })
  let recovered = false
  const jobs = readJobs(dir).map(job => {
    if (job.status !== 'running') return job
    recovered = true
    return { ...job, status: 'failed' as const, finishedAt: Date.now(), error: STALE_ERROR }
  })
  const created: MemeStore = { dir, jobs }
  stores.set(dir, created)
  if (recovered) persist(created)
  return created
}

/** Drops the in-memory cache; used by tests that point `MEME_OUTPUT_DIR` at a temp folder. */
export function resetMemeJobCache(): void {
  stores.clear()
}

function update(storeRef: MemeStore, id: string, patch: Partial<MemeJobRecord>): MemeJobRecord | undefined {
  const job = storeRef.jobs.find(item => item.id === id)
  if (!job) return undefined
  Object.assign(job, patch)
  persist(storeRef)
  return job
}

export function memeJobView(job: MemeJobRecord): MemeJobView {
  return { ...job, ...(job.file ? { imageUrl: `/api/memes/images/${job.id}` } : {}) }
}

export function listMemeJobs(limit = 100): { jobs: MemeJobView[]; outputDir: string } {
  const dir = memeOutputDir()
  const count = Math.min(Math.max(Math.trunc(limit) || 100, 1), MEME_HISTORY_LIMIT)
  return { jobs: store(dir).jobs.slice(0, count).map(memeJobView), outputDir: displayMemeDir(dir) }
}

export function getMemeJob(id: string): MemeJobRecord | null {
  if (!ID_RE.test(id)) return null
  return store(memeOutputDir()).jobs.find(job => job.id === id) ?? null
}

export function activeMemeJob(): MemeJobRecord | null {
  return store(memeOutputDir()).jobs.find(job => job.status === 'running') ?? null
}

/** Persists the job as `running` and starts the paid call in the background. */
export function startMemeJob(prepared: PreparedMeme): MemeJobRecord {
  const state = store(memeOutputDir())
  const running = state.jobs.find(job => job.status === 'running')
  if (running) throw new MemeError('上一张图片还在生成，请等它完成；历史记录里会保留结果。', 429)
  const job: MemeJobRecord = {
    id: `m${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
    status: 'running',
    provider: prepared.provider,
    model: prepared.model,
    mode: prepared.mode,
    prompt: prepared.prompt,
    style: prepared.style,
    createdAt: Date.now(),
  }
  state.jobs.unshift(job)
  if (state.jobs.length > MEME_HISTORY_LIMIT) state.jobs.length = MEME_HISTORY_LIMIT
  persist(state)
  void finishJob(state, job.id, prepared)
  return job
}

async function finishJob(state: MemeStore, id: string, prepared: PreparedMeme): Promise<void> {
  const startedAt = Date.now()
  try {
    const result = await runPreparedMeme(prepared)
    const saved = await saveImage(state.dir, id, result.image, prepared.endpoint)
    update(state, id, {
      status: 'done',
      finishedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      ...saved,
    })
  } catch (error) {
    if (!(error instanceof MemeError)) console.error('[memes] Unexpected image generation failure')
    update(state, id, {
      status: 'failed',
      finishedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      error: error instanceof MemeError ? error.message : '生成失败，请稍后重试。',
    })
  }
}

function dataUrlParts(image: string): { base64: string; mime: string } | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/.exec(image)
  return match ? { mime: match[1]!, base64: match[2]! } : null
}

/** True when the URL lives on the configured provider's own domain (or one of its subdomains). */
function providerHostAllowed(target: URL, endpoint: string): boolean {
  let endpointHost: string
  try {
    endpointHost = new URL(endpoint).hostname.toLowerCase()
  } catch {
    return false
  }
  const host = target.hostname.toLowerCase()
  if (host === endpointHost) return true
  const base = endpointHost.split('.').slice(-2).join('.')
  return base.includes('.') && host.endsWith(`.${base}`)
}

async function downloadProviderImage(url: string, endpoint: string, fetchImpl: typeof fetch = fetch) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) return null
  if (parsed.port && parsed.port !== '443') return null
  if (!providerHostAllowed(parsed, endpoint)) return null
  try {
    const response = await fetchImpl(parsed.toString(), { redirect: 'error', signal: AbortSignal.timeout(60_000) })
    if (!response.ok) return null
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MEME_MAX_OUTPUT_BYTES) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > MEME_MAX_OUTPUT_BYTES) return null
    const mime = imageMime(bytes)
    return mime ? { bytes, mime } : null
  } catch {
    return null
  }
}

async function saveImage(dir: string, id: string, image: string, endpoint: string) {
  let bytes: Buffer
  let mime: string
  const inline = dataUrlParts(image)
  if (inline) {
    bytes = decodeBase64(inline.base64, MEME_MAX_OUTPUT_BYTES)
    const detected = imageMime(bytes)
    if (!detected || detected !== inline.mime) throw new MemeError('图片服务返回了不支持的图片格式。', 502)
    mime = detected
  } else {
    const downloaded = await downloadProviderImage(image, endpoint)
    if (!downloaded) {
      return { remoteUrl: image, note: '只保留了服务商临时链接，未能写入本机；链接过期后将无法查看。' }
    }
    bytes = downloaded.bytes
    mime = downloaded.mime
  }
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]!
  const file = `${id}.${extension}`
  await writeFile(join(dir, file), bytes)
  return { file, mime, bytes: bytes.length }
}

/** Absolute path of a saved image, or null when the id is unknown or the file is gone. */
export function memeImageFile(id: string): { path: string; mime: string; bytes: number } | null {
  if (!ID_RE.test(id)) return null
  const state = store(memeOutputDir())
  const job = state.jobs.find(item => item.id === id)
  if (!job?.file || !job.mime) return null
  if (basename(job.file) !== job.file) return null
  const path = join(state.dir, job.file)
  try {
    const stat = statSync(path)
    return stat.isFile() ? { path, mime: job.mime, bytes: stat.size } : null
  } catch {
    return null
  }
}