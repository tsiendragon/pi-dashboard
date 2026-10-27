/**
 * Service registry behind the Services page (`/services`).
 *
 * Why a file instead of code: every machine runs a different set of local services, with
 * different paths, ports and stop scripts. The registry makes that data, so adding the next
 * service means editing `~/.pi/services.json`, not this repo.
 *
 * Security boundary: the browser only ever sends an `id`. Commands come from this file, are
 * spawned directly (no shell), and are never echoed back. Any id that is not registered is
 * rejected before it can touch a process.
 */
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const SERVICES_CONFIG_PATH = join(homedir(), '.pi', 'services.json')
export const SERVICES_LOG_DIR = join(homedir(), '.pi', 'logs', 'services')

export interface ServiceProbeSpec {
  url: string
  /** HTTP statuses that count as healthy. Defaults to every 2xx/3xx. */
  okStatus?: number[]
  timeoutMs?: number
}

export interface ServiceEntry {
  id: string
  label: string
  group?: string
  /** false = read-only row: shows status and links, no start/stop/restart. */
  managed?: boolean
  note?: string
  cwd?: string
  /** argv form, executed without a shell. */
  start?: string[]
  stop?: string[]
  env?: Record<string, string>
  /** Port whose listener is signalled when `stop` is missing or does not free it. */
  stopPort?: number
  /** How long a start may take before it reports failure. Defaults to 15s; slow Python/NFS services need more. */
  startTimeoutMs?: number
  probe?: ServiceProbeSpec
  /** Reachable from the machine running the dashboard. */
  webui?: string
  /** Reachable from the user's browser (platform gateway). Preferred when present. */
  webuiPublic?: string
  log?: string
}

export interface ServiceStatus {
  id: string
  status: 'up' | 'down' | 'unknown'
  httpStatus?: number
  latencyMs?: number
  error?: string
  checkedAt: string
}

export interface ServiceRow extends ServiceEntry {
  status: ServiceStatus
  logPath?: string
  canStart: boolean
  canStop: boolean
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Seeded on first run. Paths/ports below were verified on this machine; `managed: false`
 * rows are links + probes only, because the dashboard cannot restart them in place.
 */
const DEFAULT_SERVICES: ServiceEntry[] = [
  {
    id: 'pi-dashboard',
    label: 'pi-dashboard（本页）',
    group: '本机',
    managed: false,
    note: '重启会断开当前所有会话，请回终端执行 ./run.sh。',
    cwd: '/home/you/repos/pi-dashboard',
    probe: { url: 'http://127.0.0.1:7777/api/status' },
    webui: 'http://127.0.0.1:7777/',
  },
  {
    id: 'presentation-center',
    label: 'Presentation Center',
    group: '本机',
    cwd: '/home/you/repos/presentation-center',
    start: ['bash', 'scripts/start.sh'],
    stop: ['bash', 'scripts/stop.sh'],
    probe: { url: 'http://127.0.0.1:8765/health' },
    webui: 'http://127.0.0.1:8765/',
    log: '/tmp/pc.log',
  },
  {
    id: 'llm-bot',
    label: 'EagleEye LLM Bot 看板',
    group: '本机',
    note: '需要 .env 里的 BOT_DASHBOARD_TOKEN 才能启动。',
    cwd: '/home/you/repos/llm-bot',
    start: ['bash', 'run.sh', 'web', 'start'],
    stop: ['bash', 'run.sh', 'web', 'stop'],
    probe: { url: 'http://127.0.0.1:8777/' },
    webui: 'http://127.0.0.1:8777/',
  },
  {
    id: 'xdoc-monitor',
    label: 'XDoc Monitor',
    group: '本机',
    note: '默认只监听本机，浏览器直连需要另开隧道；没有 stop 脚本，停止时按端口结束进程。',
    cwd: '/home/you/repos/xdoc-monitor',
    start: ['bash', 'scripts/serve.sh'],
    env: { PORT: '8914', RELOAD: '0' },
    probe: { url: 'http://127.0.0.1:8914/' },
    webui: 'http://127.0.0.1:8914/',
  },
  {
    id: 'sekret',
    label: 'Sekret 凭证库',
    group: '本机',
    // Its own WebUI (`sekret local ui`). No login and it binds 0.0.0.0 in the upstream CLI,
    // so the note tells the user to stop it when done rather than leaving it up.
    note: '自带 WebUI，但没有登录验证且监听 0.0.0.0；解锁需要本机 SSH 私钥，用完请停止。',
    start: ['/home/you/envs/conda/envs/train/bin/sekret', 'local', 'ui', '--user', 'tsien', '--port', '8015'],
    // Cold imports of fastapi/pydantic from the shared NFS take ~20s on this machine.
    startTimeoutMs: 60000,
    probe: { url: 'http://127.0.0.1:8015/' },
    webui: 'http://127.0.0.1:8015/',
  },
  {
    id: 'datahub',
    label: 'DataHub',
    group: '远端（只读）',
    managed: false,
    note: '在服务主机上运行，本页只能看隧道是否通。',
    probe: { url: 'http://127.0.0.1:18000/health', timeoutMs: 3000 },
    webui: 'http://127.0.0.1:18000/',
  },
  {
    id: 'model-center',
    label: 'ModelCenter',
    group: '远端（只读）',
    managed: false,
    note: '在服务主机上运行，本页只能看隧道是否通。',
    probe: { url: 'http://127.0.0.1:18081/health', timeoutMs: 3000 },
    webui: 'http://127.0.0.1:18081/',
  },
  {
    id: 'cardlib',
    label: 'CardLib',
    group: '远端（只读）',
    managed: false,
    note: '在服务主机上运行，本页只能看隧道是否通。',
    probe: { url: 'http://127.0.0.1:18777/api/official-tables', timeoutMs: 5000 },
    webui: 'http://127.0.0.1:18777/',
  },
]

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')

/** Returns a human-readable problem, or null when the entry is usable. */
export function validateServiceEntry(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'entry must be an object'
  const entry = raw as Record<string, unknown>
  if (typeof entry['id'] !== 'string' || !ID_RE.test(entry['id'])) return `invalid id: ${String(entry['id'])}`
  if (typeof entry['label'] !== 'string' || !entry['label'].trim()) return `missing label for ${entry['id']}`
  for (const key of ['group', 'note', 'cwd', 'webui', 'webuiPublic', 'log'] as const) {
    if (entry[key] !== undefined && typeof entry[key] !== 'string') return `${key} must be a string (${entry['id']})`
  }
  for (const key of ['start', 'stop'] as const) {
    if (entry[key] !== undefined && !isStringArray(entry[key])) return `${key} must be a non-empty string array (${entry['id']})`
  }
  if (entry['managed'] !== undefined && typeof entry['managed'] !== 'boolean') return `managed must be a boolean (${entry['id']})`
  if (entry['stopPort'] !== undefined && (!Number.isInteger(entry['stopPort']) || (entry['stopPort'] as number) < 1 || (entry['stopPort'] as number) > 65535)) {
    return `stopPort must be a port number (${entry['id']})`
  }
  if (entry['startTimeoutMs'] !== undefined && (!Number.isInteger(entry['startTimeoutMs']) || (entry['startTimeoutMs'] as number) < 1000)) {
    return `startTimeoutMs must be an integer >= 1000 (${entry['id']})`
  }
  if (entry['env'] !== undefined) {
    const env = entry['env']
    if (!env || typeof env !== 'object' || Array.isArray(env)) return `env must be an object (${entry['id']})`
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value !== 'string') return `env.${key} must be a string (${entry['id']})`
    }
  }
  if (entry['probe'] !== undefined) {
    const probe = entry['probe'] as Record<string, unknown> | null
    if (!probe || typeof probe !== 'object' || typeof probe['url'] !== 'string') return `probe.url is required (${entry['id']})`
    if (!/^https?:\/\//.test(probe['url'] as string)) return `probe.url must be http(s) (${entry['id']})`
    const ok = probe['okStatus']
    if (ok !== undefined && (!Array.isArray(ok) || !ok.every(code => Number.isInteger(code)))) return `probe.okStatus must be numbers (${entry['id']})`
    if (probe['timeoutMs'] !== undefined && !Number.isInteger(probe['timeoutMs'])) return `probe.timeoutMs must be an integer (${entry['id']})`
  }
  return null
}

export function parseServiceConfig(raw: unknown): ServiceEntry[] {
  const list = (raw as { services?: unknown })?.services
  if (!Array.isArray(list)) throw new Error('services.json must contain a "services" array')
  const seen = new Set<string>()
  const entries: ServiceEntry[] = []
  list.forEach((item, index) => {
    const problem = validateServiceEntry(item)
    if (problem) throw new Error(`services[${index}]: ${problem}`)
    const entry = item as ServiceEntry
    if (seen.has(entry.id)) throw new Error(`duplicate service id: ${entry.id}`)
    seen.add(entry.id)
    entries.push(entry)
  })
  return entries
}

export interface LoadedServices {
  entries: ServiceEntry[]
  configPath: string
  /** True when the file was just written from the built-in defaults. */
  seeded: boolean
  error?: string
}

/**
 * Reads the registry, seeding the file from defaults the first time so the user has something
 * to edit. A malformed file is reported, never silently replaced.
 */
export function loadServices(configPath: string = SERVICES_CONFIG_PATH): LoadedServices {
  if (!existsSync(configPath)) {
    const body = { version: 1, services: DEFAULT_SERVICES }
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify(body, null, 2) + '\n', 'utf-8')
    return { entries: DEFAULT_SERVICES, configPath, seeded: true }
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    return { entries: parseServiceConfig(parsed), configPath, seeded: false }
  } catch (error) {
    // Fail closed with an empty list: a broken registry must not fall back to "run anything".
    return { entries: [], configPath, seeded: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const nowIso = () => new Date().toISOString()

/** URL probe only — the body is discarded so a big page cannot slow the status loop. */
export async function probeUrl(spec: ServiceProbeSpec): Promise<ServiceStatus> {
  const started = Date.now()
  const timeoutMs = spec.timeoutMs ?? 4000
  const okStatus = spec.okStatus
  try {
    const response = await fetch(spec.url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    void response.body?.cancel().catch(() => {})
    const latencyMs = Date.now() - started
    const healthy = okStatus ? okStatus.includes(response.status) : response.status >= 200 && response.status < 400
    return {
      id: '',
      status: healthy ? 'up' : 'down',
      httpStatus: response.status,
      latencyMs,
      ...(healthy ? {} : { error: `HTTP ${response.status}` }),
      checkedAt: nowIso(),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { id: '', status: 'down', latencyMs: Date.now() - started, error: message, checkedAt: nowIso() }
  }
}

async function probeEntry(entry: ServiceEntry): Promise<ServiceStatus> {
  if (!entry.probe) return { id: entry.id, status: 'unknown', checkedAt: nowIso() }
  const status = await probeUrl(entry.probe)
  return { ...status, id: entry.id }
}

/** Local IPv4/IPv6 listeners for `port`, resolved through /proc (no lsof dependency). */
export function findListeningPids(port: number): number[] {
  const inodes = new Set<string>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    for (const line of raw.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10) continue
      if (cols[3] !== '0A') continue // TCP_LISTEN
      const localPort = parseInt(cols[1].split(':')[1], 16)
      if (localPort === port) inodes.add(cols[9])
    }
  }
  if (!inodes.size) return []
  const pids = new Set<number>()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    let fds: string[]
    try {
      fds = readdirSync(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      let link: string
      try {
        link = readlinkSync(`/proc/${pid}/fd/${fd}`)
      } catch {
        continue
      }
      const match = /^socket:\[(\d+)\]$/.exec(link)
      if (match && inodes.has(match[1])) {
        pids.add(pid)
        break
      }
    }
  }
  return [...pids]
}

function portFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.port) return Number(parsed.port)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return undefined
  }
}

export function resolveLogPath(entry: ServiceEntry): string {
  return entry.log || join(SERVICES_LOG_DIR, `${entry.id}.log`)
}

function tail(path: string, maxLines: number): { lines: string[]; truncated: boolean } {
  const stats = statSync(path)
  const window = Math.min(stats.size, 256 * 1024)
  const buffer = Buffer.alloc(window)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, window, stats.size - window)
  } finally {
    closeSync(fd)
  }
  const lines = buffer.toString('utf-8').split('\n')
  // A mid-file window starts mid-line; drop that fragment instead of showing garbage.
  if (stats.size > window) lines.shift()
  return { lines: lines.slice(-maxLines), truncated: stats.size > window }
}

export function readServiceLog(entry: ServiceEntry, maxLines = 120): { lines: string[]; truncated: boolean; logPath: string; error?: string } {
  const logPath = resolveLogPath(entry)
  if (!existsSync(logPath)) return { lines: [], truncated: false, logPath, error: 'log file not found' }
  try {
    return { ...tail(logPath, maxLines), logPath }
  } catch (error) {
    return { lines: [], truncated: false, logPath, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Detached so a dashboard restart (or this request finishing) does not take the service down. */
function spawnEntry(entry: ServiceEntry): { pid?: number; error?: string } {
  if (!entry.start?.length) return { error: 'no start command registered' }
  if (entry.cwd && !existsSync(entry.cwd)) return { error: `cwd does not exist: ${entry.cwd}` }
  const logPath = resolveLogPath(entry)
  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openSync(logPath, 'a')
  try {
    const [command, ...args] = entry.start
    const child = spawn(command, args, {
      cwd: entry.cwd || homedir(),
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, ...entry.env },
    })
    child.unref()
    return { pid: child.pid }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* the child owns its own descriptor now */
    }
  }
}

/** Resolves when the probe reaches `target`, or after `timeoutMs`. */
async function settle(entry: ServiceEntry, target: 'up' | 'down', timeoutMs = 10000): Promise<ServiceStatus | undefined> {
  if (!entry.probe) return undefined
  const deadline = Date.now() + timeoutMs
  let last = await probeEntry(entry)
  while (last.status !== target && Date.now() < deadline) {
    await sleep(500)
    last = await probeEntry(entry)
  }
  return last
}

export interface ServiceActionResult {
  ok: boolean
  action: 'start' | 'stop' | 'restart'
  status?: ServiceStatus
  pid?: number
  logPath?: string
  error?: string
}

export async function startService(entry: ServiceEntry): Promise<ServiceActionResult> {
  if (entry.managed === false) return { ok: false, action: 'start', error: 'service is read-only in this registry' }
  const timeoutMs = entry.startTimeoutMs ?? 15000
  const port = entry.stopPort ?? portFromUrl(entry.probe?.url)
  const before = await probeEntry(entry)
  if (before.status === 'up') return { ok: true, action: 'start', status: before }

  // A previous click may already have a process on its way up (slow imports). Wait for that one
  // instead of spawning a second copy that would only fight over the same port.
  if (!port || findListeningPids(port).length === 0) {
    const spawned = spawnEntry(entry)
    if (spawned.error) return { ok: false, action: 'start', error: spawned.error, logPath: resolveLogPath(entry) }
    return finishStart(entry, await settle(entry, 'up', timeoutMs), spawned.pid, timeoutMs)
  }
  return finishStart(entry, await settle(entry, 'up', timeoutMs), undefined, timeoutMs)
}

function finishStart(entry: ServiceEntry, status: ServiceStatus | undefined, pid: number | undefined, timeoutMs: number): ServiceActionResult {
  const ready = status ? status.status === 'up' : true
  return {
    ok: ready,
    action: 'start',
    ...(pid ? { pid } : {}),
    logPath: resolveLogPath(entry),
    ...(status ? { status } : {}),
    // Spawned but not answering yet is not the same as "did not start": say which it is.
    ...(ready ? {} : { error: `${Math.round(timeoutMs / 1000)} 秒内没有应答，进程可能仍在启动中，点「日志」确认` }),
  }
}

function runStopCommand(entry: ServiceEntry): Promise<{ code: number | null; error?: string }> {
  if (!entry.stop?.length) return Promise.resolve({ code: null })
  return new Promise(resolve => {
    const [command, ...args] = entry.stop as string[]
    let settled = false
    const done = (result: { code: number | null; error?: string }) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      const child = spawn(command, args, {
        cwd: entry.cwd || homedir(),
        stdio: 'ignore',
        env: { ...process.env, ...entry.env },
      })
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        done({ code: null, error: 'stop command timed out' })
      }, 20000)
      child.once('error', error => {
        clearTimeout(timer)
        done({ code: null, error: error.message })
      })
      child.once('exit', code => {
        clearTimeout(timer)
        done({ code })
      })
    } catch (error) {
      done({ code: null, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

function signalPort(port: number, signal: NodeJS.Signals): number[] {
  const pids = findListeningPids(port)
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      /* gone or not ours */
    }
  }
  return pids
}

export async function stopService(entry: ServiceEntry): Promise<ServiceActionResult> {
  if (entry.managed === false) return { ok: false, action: 'stop', error: 'service is read-only in this registry' }
  const port = entry.stopPort ?? portFromUrl(entry.probe?.url)
  const hasStopCommand = Boolean(entry.stop?.length)
  const stopResult = hasStopCommand ? await runStopCommand(entry) : { code: null }
  let lastStatus: ServiceStatus | undefined
  // Only wait on the stop command's own effect; without one, go straight to the port listener
  // instead of burning the full settle window on a process that is still healthy.
  if (hasStopCommand && entry.probe) {
    lastStatus = await settle(entry, 'down', 8000)
    if (lastStatus?.status === 'down') {
      return { ok: true, action: 'stop', status: lastStatus }
    }
  } else if (!hasStopCommand && !port) {
    return { ok: false, action: 'stop', error: 'no stop command or port registered' }
  } else if (hasStopCommand && stopResult.code === 0) {
    return { ok: true, action: 'stop' }
  }
  if (!port) return { ok: false, action: 'stop', error: stopResult.error || 'no stop command or port registered' }

  signalPort(port, 'SIGTERM')
  if (entry.probe) {
    lastStatus = await settle(entry, 'down', 6000)
    if (lastStatus?.status === 'down') return { ok: true, action: 'stop', status: lastStatus }
  } else {
    await sleep(1500)
  }
  const remaining = signalPort(port, 'SIGKILL')
  if (!remaining.length) return { ok: true, action: 'stop', ...(lastStatus ? { status: lastStatus } : {}) }
  await sleep(500)
  const still = findListeningPids(port)
  if (still.length) {
    return { ok: false, action: 'stop', error: `port ${port} still held by pid ${still.join(',')}`, ...(lastStatus ? { status: lastStatus } : {}) }
  }
  return { ok: true, action: 'stop', ...(lastStatus ? { status: lastStatus } : {}) }
}

export async function restartService(entry: ServiceEntry): Promise<ServiceActionResult> {
  if (entry.managed === false) return { ok: false, action: 'restart', error: 'service is read-only in this registry' }
  const stopped = await stopService(entry)
  if (!stopped.ok) return { ...stopped, action: 'restart' }
  await sleep(500)
  const started = await startService(entry)
  return { ...started, action: 'restart' }
}

/** Registry + live status in one round trip, so the page never shows config without a state. */
export async function listServices(configPath: string = SERVICES_CONFIG_PATH): Promise<{
  services: ServiceRow[]
  configPath: string
  seeded: boolean
  error?: string
}> {
  const loaded = loadServices(configPath)
  const rows = await Promise.all(
    loaded.entries.map(async entry => {
      const status = await probeEntry(entry)
      const managed = entry.managed !== false
      return {
        ...entry,
        status,
        logPath: resolveLogPath(entry),
        canStart: managed && Boolean(entry.start?.length),
        canStop: managed && (Boolean(entry.stop?.length) || Boolean(entry.stopPort ?? portFromUrl(entry.probe?.url))),
      }
    }),
  )
  return { services: rows, configPath: loaded.configPath, seeded: loaded.seeded, ...(loaded.error ? { error: loaded.error } : {}) }
}