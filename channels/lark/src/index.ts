import { watch } from 'node:fs'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readActiveAccount, readAllowedUserIds } from './accounts.js'
import { loadConfig, type LarkGatewayConfig } from './config.js'
import { Gateway } from './gateway.js'
import { LarkTransport } from './larkTransport.js'
import { StdioTransport } from './stdioTransport.js'
import type { ImTransport } from './transport.js'
import { TransportManager } from './transportManager.js'

const LOCK_PATH = path.join(os.homedir(), '.pi', 'agent', 'run', 'pi-dashboard', 'lark-gateway.lock')

/**
 * Single-instance lock. A Lark app allows only ONE long-connection listener at
 * a time, so two gateways against the same app would silently drop events.
 * Stale locks (dead pid) are reclaimed.
 */
async function acquireLock(filePath: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(filePath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(filePath, 'wx')
      await handle.writeFile(String(process.pid))
      return async () => {
        await handle.close().catch(() => {})
        await unlink(filePath).catch(() => {})
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const pid = Number.parseInt((await readFile(filePath, 'utf8').catch(() => '')).trim(), 10)
      if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) {
        throw new Error(`another gateway instance is running (pid ${pid}, lock ${filePath})`)
      }
      await unlink(filePath).catch(() => {})
    }
  }
  throw new Error(`could not acquire lock: ${filePath}`)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Build a transport from the active account, falling back to env, then stdio. */
function createTransport(
  cfg: LarkGatewayConfig,
  appId?: string,
  appSecret?: string,
  domain?: 'feishu' | 'lark',
): { transport: ImTransport; kind: string } {
  const id = appId || cfg.larkAppId
  const secret = appSecret || cfg.larkAppSecret
  if (id && secret) {
    return {
      transport: new LarkTransport({ ...cfg, larkAppId: id, larkAppSecret: secret, larkDomain: domain || 'feishu' }),
      kind: `lark(${id}, ${domain || 'feishu'})`,
    }
  }
  return { transport: new StdioTransport(), kind: 'stdio (dev; no active Lark account)' }
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  const envAllowedUserIds = (process.env.LARK_ALLOWED_USER_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)

  const manager = new TransportManager()
  const gateway = new Gateway(cfg, manager, envAllowedUserIds)
  await gateway.start()

  let release: (() => Promise<void>) | undefined
  const ensureLock = async (): Promise<void> => {
    if (!release) release = await acquireLock(LOCK_PATH)
  }

  const apply = async (reason: string): Promise<void> => {
    const active = await readActiveAccount(cfg.accountsPath).catch(() => undefined)
    const usesLark = Boolean((active?.appId && active.appSecret) || (cfg.larkAppId && cfg.larkAppSecret))
    if (usesLark) await ensureLock()
    // Allow-list: dashboard-managed file wins; env var is the fallback.
    const fileAllowed = await readAllowedUserIds(cfg.accountsPath).catch(() => [])
    gateway.setAllowedUserIds(fileAllowed.length ? fileAllowed : envAllowedUserIds)
    const { transport, kind } = createTransport(cfg, active?.appId, active?.appSecret, active?.domain)
    await manager.activate(transport)
    console.log(`[gateway] ${reason}: transport=${kind}${active ? ` account="${active.name}"` : ''}`)
  }

  await apply('started')

  // Hot-reload: switching the active account in the dashboard takes effect here.
  const watchDir = path.dirname(cfg.accountsPath)
  await mkdir(watchDir, { recursive: true })
  let timer: NodeJS.Timeout | undefined
  watch(watchDir, (_event, filename) => {
    if (filename && filename !== path.basename(cfg.accountsPath)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void apply('config changed').catch(error =>
        console.error('[gateway] reload failed:', error instanceof Error ? error.message : error),
      )
    }, 300)
  })

  const shutdown = async (): Promise<void> => {
    await gateway.stop().catch(() => {})
    await release?.().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch(error => {
  console.error('[gateway] failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
