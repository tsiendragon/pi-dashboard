/**
 * Lark channel account settings.
 *
 * The `channels/lark` gateway reads the same file, so accounts configured here
 * take effect in the gateway without any extra plumbing. In "B" mode exactly
 * one account is active at a time (`activeId`).
 *
 * appSecret is never returned to the browser: reads are masked, and writing a
 * masked value keeps the stored secret.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import os from 'os'
import { dirname, join } from 'path'
import type { Express, Request, Response } from 'express'

const CONFIG_PATH = join(os.homedir(), '.pi', 'agent', 'run', 'pi-dashboard', 'lark-accounts.json')
const MASK_PREFIX = '••••'

interface StoredAccount {
  id: string
  name: string
  appId: string
  appSecret: string
  /** 'feishu' (open.feishu.cn) or 'lark' (open.larksuite.com). Long-connection is domain-isolated. */
  domain?: 'feishu' | 'lark'
  createdAt: string
}

interface StoredConfig {
  version: 1
  activeId: string | null
  accounts: StoredAccount[]
  /** Users allowed to drive the gateway. Empty / absent = unrestricted. */
  allowedUserIds?: string[]
}

function readConfig(): StoredConfig {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as StoredConfig
    if (parsed?.version === 1 && Array.isArray(parsed.accounts)) {
      return {
        version: 1,
        activeId: parsed.activeId ?? null,
        accounts: parsed.accounts,
        allowedUserIds: Array.isArray(parsed.allowedUserIds) ? parsed.allowedUserIds : [],
      }
    }
  } catch {
    /* missing or invalid -> empty */
  }
  return { version: 1, activeId: null, accounts: [], allowedUserIds: [] }
}

function writeConfig(config: StoredConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  const tmp = `${CONFIG_PATH}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, CONFIG_PATH)
}

function maskSecret(secret: string): string {
  if (!secret) return ''
  return secret.length <= 4 ? MASK_PREFIX : `${MASK_PREFIX}${secret.slice(-4)}`
}

function publicAccount(account: StoredAccount) {
  return {
    id: account.id,
    name: account.name,
    appId: account.appId,
    domain: account.domain || 'feishu',
    appSecretMasked: maskSecret(account.appSecret),
    createdAt: account.createdAt,
  }
}

export function registerLarkRoutes(app: Express): void {
  app.get('/api/lark/accounts', (_req: Request, res: Response) => {
    const config = readConfig()
    res.json({
      activeId: config.activeId,
      accounts: config.accounts.map(publicAccount),
      allowedUserIds: config.allowedUserIds ?? [],
    })
  })

  /** Set the allow-list of users permitted to drive the gateway (empty = unrestricted). */
  app.put('/api/lark/allowed-users', (req: Request, res: Response) => {
    const raw = (req.body || {}).allowedUserIds
    const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [])
      .map(value => String(value).trim())
      .filter(Boolean)
    const allowedUserIds = [...new Set(list)]
    const config = readConfig()
    config.allowedUserIds = allowedUserIds
    writeConfig(config)
    res.json({ ok: true, allowedUserIds })
  })

  app.put('/api/lark/accounts', (req: Request, res: Response) => {
    const body = req.body || {}
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const appId = typeof body.appId === 'string' ? body.appId.trim() : ''
    if (!appId) return res.status(400).json({ error: 'appId_required' })

    const config = readConfig()
    const id = typeof body.id === 'string' && body.id ? body.id : randomUUID()
    const existing = config.accounts.find(account => account.id === id)

    const incomingSecret = typeof body.appSecret === 'string' ? body.appSecret : ''
    const keepExistingSecret = incomingSecret === '' || incomingSecret.startsWith(MASK_PREFIX)
    const appSecret = keepExistingSecret ? existing?.appSecret ?? '' : incomingSecret
    if (!appSecret) return res.status(400).json({ error: 'appSecret_required' })
    const domain: 'feishu' | 'lark' = body.domain === 'lark' ? 'lark' : 'feishu'

    if (existing) {
      existing.name = name || existing.name
      existing.appId = appId
      existing.domain = domain
      existing.appSecret = appSecret
    } else {
      config.accounts.push({ id, name: name || appId, appId, domain, appSecret, createdAt: new Date().toISOString() })
    }
    if (!config.activeId) config.activeId = id
    writeConfig(config)
    res.json({ ok: true, id, activeId: config.activeId })
  })

  app.delete('/api/lark/accounts/:id', (req: Request, res: Response) => {
    const config = readConfig()
    const before = config.accounts.length
    config.accounts = config.accounts.filter(account => account.id !== req.params.id)
    if (config.accounts.length === before) return res.status(404).json({ error: 'not_found' })
    if (config.activeId === req.params.id) config.activeId = config.accounts[0]?.id ?? null
    writeConfig(config)
    res.json({ ok: true, activeId: config.activeId })
  })

  /** Switch which account the gateway uses (B mode). */
  app.post('/api/lark/accounts/:id/activate', (req: Request, res: Response) => {
    const config = readConfig()
    const account = config.accounts.find(candidate => candidate.id === req.params.id)
    if (!account) return res.status(404).json({ error: 'not_found' })
    config.activeId = account.id
    writeConfig(config)
    res.json({ ok: true, activeId: config.activeId })
  })

  /** Verify credentials by requesting a tenant access token from Lark. */
  app.post('/api/lark/accounts/:id/verify', async (req: Request, res: Response) => {
    const config = readConfig()
    const account = config.accounts.find(candidate => candidate.id === req.params.id)
    if (!account) return res.status(404).json({ error: 'not_found' })
    try {
      const endpoint =
        account.domain === 'lark'
          ? 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal'
          : 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: account.appId, app_secret: account.appSecret }),
      })
      const data = (await response.json()) as { code?: number; msg?: string }
      if (data.code === 0) return res.json({ ok: true })
      return res.status(400).json({ ok: false, error: data.msg || `code_${data.code}` })
    } catch (error) {
      return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}
