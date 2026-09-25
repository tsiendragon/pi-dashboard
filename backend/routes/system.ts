/**
 * System routes — status, pi environment, skills, memory, config, workspaces, packages
 */
import { Request, Response } from 'express'
import { settingsStore } from '../settings-store.js'
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { execSync } from 'child_process'
import { promisify } from 'util'
import { exec } from 'child_process'
import os from 'os'
import type { RouteDeps } from './types.js'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { runPackageOperation } from '../ext-packages.js'
import { resolvePiScript } from '../pi-manager.js'
import { requireBrowserAuth } from './require-browser-auth.js'
import * as piEnv from '../pi-env.js'

const execAsync = promisify(exec)
const PI_AGENT_DIR = join(os.homedir(), '.pi', 'agent')
const DASHBOARD_TOKEN_PATH = join(os.homedir(), '.pi', 'dashboard-token')

function getDashboardToken(): string {
  try { return readFileSync(DASHBOARD_TOKEN_PATH, 'utf-8').trim() } catch { return '' }
}

export function registerSystemRoutes(deps: RouteDeps, auth?: LiveSessionBrowserAuth): void {
  const { app, manager } = deps

  app.get('/api/status', (_req: Request, res: Response) => res.json(manager.status()))

  // iOS / mobile connection info — returns token so the iOS app can be configured
  app.get('/api/connection-info', (req: Request, res: Response) => {
    const proto = req.headers['x-forwarded-proto'] || 'http'
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost'
    const serverURL = `${proto}://${host}`
    res.json({ token: getDashboardToken(), serverURL })
  })

  app.get('/api/system', async (_req: Request, res: Response) => {
    const mem = os.totalmem()
    const free = os.freemem()
    const used = mem - free
    const toGB = (b: number): string => (b / 1073741824).toFixed(1)
    const cpus = os.cpus()
    const load = os.loadavg()

    // Disk usage
    let diskTotal: string | number = '', diskFree: string | number = ''
    try {
      const dfCmd = process.platform === 'darwin' ? "df -g / | tail -1" : "df -BG / | tail -1"
      const { stdout: dfOut } = await execAsync(dfCmd, { timeout: 2000 })
      const df = dfOut.trim().split(/\s+/)
      diskTotal = parseFloat(df[1])
      diskFree = parseFloat(df[3])
    } catch {}

    // IP
    let ip = ''
    try {
      const nets = os.networkInterfaces()
      for (const iface of Object.values(nets)) {
        for (const cfg of iface || []) {
          if (cfg.family === 'IPv4' && !cfg.internal) { ip = cfg.address; break }
        }
        if (ip) break
      }
    } catch {}

    // Process info
    let procMem: string = '', procCpu: string = '', childProcs: string = '', threads: string = ''
    try {
      procMem = (process.memoryUsage.rss() / 1048576).toFixed(1)
    } catch {}
    try {
      if (process.platform === 'darwin') {
        const { stdout: psOut } = await execAsync(`ps -o rss= -p ${process.pid}`, { timeout: 2000 })
        if (!procMem) procMem = (parseInt(psOut.trim()) / 1024).toFixed(1)
      } else {
        const { stdout: psOut2 } = await execAsync(`ps -o rss=,nlwp= -p ${process.pid}`, { timeout: 2000 })
        const ps = psOut2.trim().split(/\s+/)
        if (!procMem) procMem = (parseInt(ps[0]) / 1024).toFixed(1)
        threads = ps[1]
      }
    } catch {}
    try {
      const { stdout: pgrepOut } = await execAsync(`pgrep -c -P ${process.pid} 2>/dev/null || echo 0`, { timeout: 2000 })
      childProcs = pgrepOut.trim()
    } catch {}

    // CPU usage
    const cpuTimes = cpus.reduce((a, c) => {
      a.idle += c.times.idle; a.total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
      return a
    }, { idle: 0, total: 0 })
    const cpuPct = (100 - (cpuTimes.idle / cpuTimes.total * 100)).toFixed(1)

    res.json({
      hostname: os.hostname(),
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpu_count: cpus.length,
      cpu_pct: parseFloat(cpuPct),
      load_1m: load[0].toFixed(2),
      load_5m: load[1].toFixed(2),
      load_15m: load[2].toFixed(2),
      mem_total_gb: toGB(mem),
      mem_used_gb: toGB(used),
      mem_free_gb: toGB(free),
      disk_total_gb: diskTotal || '—',
      disk_free_gb: diskFree || '—',
      ip,
      pid: process.pid,
      python: '—',
      proc_mem_mb: procMem || '—',
      proc_cpu_pct: null,
      child_processes: childProcs || '0',
      thread_count: threads || '—',
      cwd: process.cwd(),
      ollama_running: false,
      net_rx_kbs: null,
      net_tx_kbs: null,
    })
  })

  // Skills
  app.get('/api/skills', (_req: Request, res: Response) => res.json(piEnv.getSkills()))

  app.get('/api/skills/:name/files', (req: Request, res: Response) => {
    const skillDir = join(os.homedir(), '.pi', 'agent', 'skills', req.params.name as string)
    try {
      const files: string[] = []
      const walk = (dir: string, prefix: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? prefix + '/' + e.name : e.name
          if (e.isDirectory()) walk(join(dir, e.name), rel)
          else files.push(rel)
        }
      }
      walk(skillDir, '')
      res.json({ name: req.params.name as string, files })
    } catch (e: any) {
      res.status(e.code === 'ENOENT' ? 404 : 500).json({ error: e.message })
    }
  })

  app.get('/api/skills/:name/file', (req: Request, res: Response) => {
    const filePath = req.query.path as string
    if (!filePath) return res.status(400).json({ error: 'path query param required' })
    if (filePath.includes('..')) return res.status(400).json({ error: 'invalid path' })
    const full = join(os.homedir(), '.pi', 'agent', 'skills', req.params.name as string, filePath)
    try {
      res.json({ content: readFileSync(full, 'utf-8') })
    } catch (e: any) {
      res.status(e.code === 'ENOENT' ? 404 : 500).json({ error: e.message })
    }
  })

  app.put('/api/skills/:name/file', (req: Request, res: Response) => {
    const { path: filePath, content } = req.body
    if (!filePath || content == null) return res.status(400).json({ error: 'path and content required' })
    if (filePath.includes('..')) return res.status(400).json({ error: 'invalid path' })
    const full = join(os.homedir(), '.pi', 'agent', 'skills', req.params.name as string, filePath)
    try {
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content, 'utf-8')
      res.json({ ok: true })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  // Pi agent file browser
  app.get('/api/pi/files', (req: Request, res: Response) => {
    const sub = (req.query.dir as string) || ''
    if (sub.includes('..')) return res.status(400).json({ error: 'invalid path' })
    const target = sub ? join(PI_AGENT_DIR, sub) : PI_AGENT_DIR
    try {
      const entries = readdirSync(target, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'sessions' && e.name !== 'sessions-archive')
        .map(e => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1)
      res.json({ dir: sub || '.', entries })
    } catch (e: any) {
      res.status(e.code === 'ENOENT' ? 404 : 500).json({ error: e.message })
    }
  })

  app.get('/api/pi/file', (req: Request, res: Response) => {
    const filePath = req.query.path as string
    if (!filePath || filePath.includes('..')) return res.status(400).json({ error: 'invalid path' })
    try {
      res.json({ content: readFileSync(join(PI_AGENT_DIR, filePath), 'utf-8') })
    } catch (e: any) {
      res.status(e.code === 'ENOENT' ? 404 : 500).json({ error: e.message })
    }
  })

  app.put('/api/pi/file', (req: Request, res: Response) => {
    const { path: filePath, content } = req.body
    if (!filePath || content == null || filePath.includes('..')) return res.status(400).json({ error: 'invalid path or content' })
    const full = join(PI_AGENT_DIR, filePath)
    try {
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content, 'utf-8')
      res.json({ ok: true })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  // Crons, Lessons, Hooks
  app.get('/api/crons', (_req: Request, res: Response) => res.json(piEnv.getCrontab()))
  app.get('/api/lessons', (_req: Request, res: Response) => res.json(piEnv.getLessons()))
  app.get('/api/hooks', (_req: Request, res: Response) => res.json([]))

  // MCP (stubs)
  app.get('/api/mcp', (_req: Request, res: Response) => res.json([]))
  app.get('/api/mcp/active', (_req: Request, res: Response) => res.json([]))
  app.get('/api/mcp/probe', (_req: Request, res: Response) => res.json({ results: {} }))
  app.post('/api/mcp/probe', (_req: Request, res: Response) => res.json({ results: {} }))

  // Memory
  app.get('/api/memory/preferences', (_req: Request, res: Response) => res.json({ content: JSON.stringify(piEnv.getFacts(), null, 2) }))
  app.get('/api/memory/projects', (_req: Request, res: Response) => res.json({ content: '' }))
  app.get('/api/memory/history', (_req: Request, res: Response) => res.json({ content: '' }))
  app.get('/api/memory/settings', (_req: Request, res: Response) => res.json({}))
  app.get('/api/memory/stats', (_req: Request, res: Response) => res.json(piEnv.getMemoryStats()))
  app.get('/api/memory/embedding-status', (_req: Request, res: Response) => res.json({ enabled: false }))
  // Writes require the Live Session browser auth. Without an injected auth object we fail closed.
  const requireAuth = (handler: (req: Request, res: Response) => unknown | Promise<unknown>) =>
    (req: Request, res: Response) => {
      if (!auth) { res.status(503).json({ error: 'auth_unavailable' }); return }
      return requireBrowserAuth(auth)(req, res, () => { void handler(req, res) })
    }
  const authOf = (req: Request): string | null => auth?.getIdentity(req)?.browserClientId ?? null

  app.put('/api/memory/preferences', (_req: Request, res: Response) => res.json({ ok: true }))
  app.put('/api/memory/projects', (_req: Request, res: Response) => res.json({ ok: true }))
  app.put('/api/memory/history', (_req: Request, res: Response) => res.json({ ok: true }))

  // Agent config (stubs)
  app.get('/api/agent/config', (_req: Request, res: Response) => res.json({}))
  app.put('/api/agent/config', (_req: Request, res: Response) => res.json({ ok: true }))
  app.get('/api/config/default-agent', (_req: Request, res: Response) => res.json({ agent: 'default' }))
  app.put('/api/config/default-agent', (_req: Request, res: Response) => res.json({ ok: true }))
  app.get('/api/agents/installed', (_req: Request, res: Response) => res.json([]))

  // Pi environment APIs
  app.get('/api/pi/extensions', (_req: Request, res: Response) => res.json(piEnv.getExtensions()))

  // Dashboard config
  app.get('/api/dash/config', (_req: Request, res: Response) => res.json(piEnv.getDashConfig()))
  app.put('/api/dash/config', requireAuth((req: Request, res: Response) => {
    try {
      const saved = piEnv.saveDashConfig(req.body)
      res.json(saved)
    } catch (e: any) { res.status(500).json({ error: e.message }) }
  }))

  // Vault
  app.get('/api/pi/vault', (_req: Request, res: Response) => res.json(piEnv.getVaultStats()))
  app.get('/api/pi/vault/daily', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string || '7', 10)
    res.json(piEnv.getRecentDailyNotes(limit))
  })
  app.get('/api/pi/vault/daily/:date', (req: Request, res: Response) => {
    const content = piEnv.getDailyNote(req.params.date as string)
    if (!content) return res.status(404).json({ error: 'not found' })
    res.json({ date: req.params.date as string, content })
  })
  app.get('/api/pi/crontab', (_req: Request, res: Response) => res.json(piEnv.getCrontab()))
  app.get('/api/pi/memory', (_req: Request, res: Response) => {
    res.json({
      stats: piEnv.getMemoryStats(),
      facts: piEnv.getFacts(),
      lessons: piEnv.getLessons(50),
    })
  })

  // Task runner (stubs)
  app.get('/api/taskrunner', (_req: Request, res: Response) => res.json({ tasks: [] }))

  // Logs (stubs)
  app.get('/api/logs/level', (_req: Request, res: Response) => res.json({ level: 'info' }))
  app.post('/api/logs/level', (_req: Request, res: Response) => res.json({ ok: true }))

  // Update (stubs)
  app.get('/api/update/check', (_req: Request, res: Response) => res.json({ available: false }))
  app.get('/api/changelog', (_req: Request, res: Response) => res.json({ content: '' }))

  // Workspaces
  app.get('/api/workspaces', (_req: Request, res: Response) => {
    const dirs: { name: string; path: string }[] = []
    const wsDir = process.env.WORKSPACE_DIR
    if (wsDir) {
      try {
        for (const ws of readdirSync(wsDir)) {
          const full = `${wsDir}/${ws}`
          if (statSync(full).isDirectory()) dirs.push({ name: ws, path: full })
        }
      } catch {}
    }
    dirs.push({ name: '~', path: os.homedir() })
    dirs.push({ name: 'pi-dashboard', path: join(os.homedir(), 'pi-dashboard') })
    res.json({ workspaces: dirs })
  })

  // Pi settings
  app.get('/api/pi/settings', (_req: Request, res: Response) => {
    res.json(settingsStore.read())
  })

  app.put('/api/pi/settings', requireAuth(async (req: Request, res: Response) => {
    try {
      // Whole-file PUT goes through the shared store: serialized against the Extensions page's
      // enable/disable and reorder writes, backed up before writing, atomic rename.
      const outcome = await settingsStore.mutate((_current, save) => {
        save({ ...(req.body as Record<string, unknown>) })
      })
      res.json({ ok: true, changed: outcome.changed, backupPath: outcome.backupPath })
    } catch (e: any) { res.status(500).json({ error: e.message }) }
  }))

  // Package management — kept for the Settings page, but now the same gated implementation the
  // Extensions page uses (no shell, settings backup, audit record, browser auth).
  const runPackageAction = (action: 'install' | 'remove') => requireAuth(async (req: Request, res: Response) => {
    const source = typeof (req.body as { source?: unknown } | undefined)?.source === 'string' ? (req.body as { source: string }).source : ''
    const result = await runPackageOperation({
      action,
      source,
      store: settingsStore,
      piBin: resolvePiScript(),
      actor: authOf(req),
    })
    if (!result.ok) return res.status(400).json({ error: result.error ?? 'operation failed', ...result })
    return res.json(result)
  })

  app.post('/api/pi/packages/install', runPackageAction('install'))
  app.post('/api/pi/packages/remove', runPackageAction('remove'))

  // Package gallery (npm search)
  app.get('/api/pi/gallery', async (_req: Request, res: Response) => {
    try {
      const resp = await fetch('https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=50')
      const data = await resp.json() as any
      const packages = (data.objects || []).map((o: any) => ({
        name: o.package.name,
        description: o.package.description || '',
        version: o.package.version,
        author: o.package.author?.name || o.package.publisher?.username || '',
        date: o.package.date,
        links: o.package.links || {},
      }))
      res.json({ packages })
    } catch (e: any) { res.json({ packages: [], error: e.message }) }
  })
}
