/**
 * Route: `GET /api/pi/ext/list` — the extension set that Pi will actually load.
 *
 * Reads `<agent dir>/{settings.json,extensions.config.json}` plus package manifests and returns the
 * inventory built by `buildExtensionInventory` (see that module for what is `declared` vs `derived`
 * vs `heuristic`). Read-only: writing stays with the syncer and `pi config`.
 */
import type { Express, Request, Response } from 'express'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { buildExtensionInventory, deriveExtensionDependencies, type InventoryIo } from '../ext-inventory.js'

function agentDir(): string {
  return process.env['PI_CODING_AGENT_DIR'] ?? join(os.homedir(), '.pi', 'agent')
}

const io: InventoryIo = {
  readJson(path: string) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  },
  readText(path: string) {
    try {
      return readFileSync(path, 'utf-8')
    } catch {
      return null
    }
  },
  fileExists(path: string) {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  isDirectory(path: string) {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  listFiles(dir: string) {
    try {
      return existsSync(dir) ? readdirSync(dir) : []
    } catch {
      return []
    }
  },
  realPath(path: string) {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  },
  listFilesRecursive(dir: string) {
    const out: string[] = []
    const walk = (current: string): void => {
      let items: import('fs').Dirent[] = []
      try {
        items = readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        if (item.name === 'node_modules' || item.name.startsWith('.git')) continue
        const full = join(current, item.name)
        if (item.isDirectory()) walk(full)
        else out.push(full.slice(dir.length + 1))
      }
    }
    walk(dir)
    return out
  },
}

/**
 * Cache for the dependency scan: keyed by settings.json mtime+size. The scan reads many files, so
 * repeated page loads must not redo it; any settings change invalidates it.
 */
const depsCache = new Map<string, { key: string; payload: unknown }>()

function depsCacheKey(agentDirectory: string): string {
  try {
    const stats = statSync(join(agentDirectory, 'settings.json'))
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return 'missing'
  }
}

export function registerPiExtListRoutes({ app }: { app: Express }): void {
  app.get('/api/pi/ext/list', (_req: Request, res: Response) => {
    const dir = agentDir()
    try {
      const inventory = buildExtensionInventory({ agentDir: dir, env: process.env, io })
      res.json(inventory)
    } catch (error) {
      // Never fail the page because one manifest is malformed.
      res.status(500).json({ error: error instanceof Error ? error.message : String(error), agentDir: dir })
    }
  })

  app.get('/api/pi/ext/deps', (_req: Request, res: Response) => {
    const dir = agentDir()
    const key = depsCacheKey(dir)
    const cached = depsCache.get(dir)
    if (cached && cached.key === key) {
      res.json({ ...(cached.payload as Record<string, unknown>), cached: true })
      return
    }
    try {
      const payload = deriveExtensionDependencies({ agentDir: dir, env: process.env, io, maxFilesPerPackage: 80 })
      depsCache.set(dir, { key, payload })
      res.json({ ...payload, cached: false })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error), agentDir: dir })
    }
  })
}