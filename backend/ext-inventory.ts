/**
 * Extension inventory — what Pi will actually load, derived from files only.
 *
 * The pre-existing `GET /api/pi/extensions` lists `<agent dir>/extensions/*.ts`, which is *not*
 * the loaded set: the real list comes from `settings.json` (`packages[]` + `extensions[]`), and
 * entries there can be prefixed with `+`/`-`/`!` (Pi's non-destructive enable/disable markers).
 *
 * Everything here is a pure function over injected I/O so it can be unit-tested with fixtures.
 * Confidence is labelled honestly:
 *   - `declared`  — package `pi.extensions` manifest / `extensions.config.json` loadOrder
 *   - `derived`   — resolved from paths on disk
 *   - `heuristic` — patched-API usage detected by scanning source text (NOT a real dependency)
 */
import { basename, isAbsolute, join, relative, resolve, sep } from 'path'

import type {
  AutoDiscovered,
  ExtGroup,
  ExtInventory,
  ExtensionEntry,
  ExtensionPackage,
  ExtState,
  PackageKind,
} from '@shared/ext-inventory.js'

export type { AutoDiscovered, ExtGroup, ExtInventory, ExtensionEntry, ExtensionPackage, ExtState, PackageKind }

export interface InventoryIo {
  readJson(path: string): Record<string, unknown> | null
  readText(path: string): string | null
  fileExists(path: string): boolean
  listFiles(dir: string): string[]
  isDirectory(path: string): boolean
}


/** Patched-pi APIs (absent from upstream pi). Heuristic: text scan, not a real dependency. */
const PATCHED_API_PATTERNS: Array<[string, RegExp]> = [
  ['executeTool', /\bexecuteTool\s*\(/],
  ['respondExtensionUi', /\brespondExtensionUi\s*\(/],
  ['extension_ui', /["']extension_ui["']/],
  ['extension_ui_notify', /["']extension_ui_notify["']/],
]

function expandVars(
  source: string,
  env: Record<string, string | undefined>,
): { resolved: string; missing: string[] } {
  const missing: string[] = []
  const resolved = source.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = env[name]
    if (!value) {
      missing.push(name)
      return `\0${name}\0`
    }
    return value
  })
  return { resolved, missing }
}

function classifySource(source: string): PackageKind {
  if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('git@') || source.endsWith('.git')) return 'git'
  if (source.startsWith('file:') || isAbsolute(source) || source.startsWith('.')) return 'local'
  if (source.includes('/') || source.startsWith('@')) return 'npm'
  return 'npm'
}

function stateOf(raw: string): ExtState {
  if (raw.startsWith('-')) return 'disabled'
  if (raw.startsWith('+')) return 'enabled'
  if (raw.startsWith('!')) return 'forced'
  return 'enabled'
}

function stripPrefix(raw: string): string {
  return /^[+\-!]/.test(raw) ? raw.slice(1) : raw
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export interface BuildInput {
  agentDir: string
  env: Record<string, string | undefined>
  io: InventoryIo
}

export function buildExtensionInventory({ agentDir, env, io }: BuildInput): ExtInventory {
  const settingsPath = join(agentDir, 'settings.json')
  const configPath = join(agentDir, 'extensions.config.json')
  const warnings: string[] = []

  const settings = io.readJson(settingsPath)
  if (!settings) warnings.push(`cannot read ${settingsPath}`)
  const config = io.readJson(configPath)

  // ── packages from settings.json (+ id/loadOrder from the syncer config) ──
  const configPackages = Array.isArray(config?.['packages']) ? (config!['packages'] as unknown[]) : []
  const configPackageIds = new Map<string, string>()
  for (const item of configPackages) {
    const record = asRecord(item)
    const source = asString(record?.['source'])
    const id = asString(record?.['id'])
    if (source && id) {
      const { resolved } = expandVars(source, env)
      configPackageIds.set(resolved, id)
    }
  }

  const packages: ExtensionPackage[] = []
  const settingsPackages = Array.isArray(settings?.['packages']) ? (settings!['packages'] as unknown[]) : []
  for (const item of settingsPackages) {
    const record = asRecord(item)
    const rawSource = asString(record?.['source'])
    if (!rawSource) continue
    const { resolved, missing } = expandVars(rawSource, env)
    const exists = missing.length === 0 && io.isDirectory(resolved)
    const manifest = exists ? io.readJson(join(resolved, 'package.json')) : null
    const piField = asRecord(manifest?.['pi'])
    const declared = Array.isArray(piField?.['extensions']) ? (piField!['extensions'] as unknown[]) : []
    packages.push({
      id: configPackageIds.get(missing.length === 0 ? resolved : rawSource) ?? null,
      rawSource,
      resolved: missing.length === 0 ? resolved : null,
      exists,
      kind: missing.length > 0 ? 'unresolved' : classifySource(rawSource),
      unresolvedVars: missing,
      name: asString(manifest?.['name']),
      version: asString(manifest?.['version']),
      description: asString(manifest?.['description']),
      declaredEntries: declared.filter((entry): entry is string => typeof entry === 'string'),
      autoload: record?.['autoload'] === true,
    })
    if (missing.length > 0) warnings.push(`package source ${rawSource} references unset variable(s): ${missing.join(', ')}`)
    else if (!exists) warnings.push(`package source not found on disk: ${resolved}`)
  }

  // ── applied extensions ──
  const rawEntries = Array.isArray(settings?.['extensions']) ? (settings!['extensions'] as unknown[]) : []
  const configLoadOrder = Array.isArray(config?.['loadOrder']) ? (config!['loadOrder'] as unknown[]) : []
  const configOrderByPath = new Map<string, number>()
  configLoadOrder.forEach((item, index) => {
    const record = asRecord(item)
    const path = asString(record?.['path'])
    const packageId = asString(record?.['package'])
    if (path) configOrderByPath.set(`${packageId ?? ''}\0${path}`, index + 1)
  })

  const entries: ExtensionEntry[] = []
  const seenPaths = new Map<string, number>()
  rawEntries.forEach((raw, index) => {
    const text = asString(raw)
    if (!text) return
    const bare = stripPrefix(text)
    let absolute: string | null = null
    for (const pkg of packages) {
      if (!pkg.resolved) continue
      if (bare === pkg.resolved || bare.startsWith(pkg.resolved + sep)) {
        absolute = bare === pkg.resolved ? bare : bare
        break
      }
    }
    if (!absolute && isAbsolute(bare)) absolute = bare
    const owner = absolute
      ? packages.find((pkg) => pkg.resolved && (absolute === pkg.resolved || absolute.startsWith(pkg.resolved + sep))) ?? null
      : null
    const manifestPath = owner && owner.resolved && absolute ? relative(owner.resolved, absolute) : null
    const exists = absolute !== null && io.fileExists(absolute)
    if (absolute) {
      const previous = seenPaths.get(absolute)
      if (previous !== undefined) seenPaths.set(absolute, previous)
      else seenPaths.set(absolute, index + 1)
    }
    const source = absolute ? io.readText(absolute) : null
    const patchedApi = source ? PATCHED_API_PATTERNS.filter(([, pattern]) => pattern.test(source)).map(([name]) => name) : []
    const declared = Boolean(owner && manifestPath && owner.declaredEntries.some((entry) => entry.replace(/^\.\//, '') === manifestPath))
    const managedKey = manifestPath && owner?.id ? `${owner.id}\0${manifestPath}` : null
    entries.push({
      raw: text,
      state: stateOf(text),
      group: owner ? 'package' : 'path',
      path: absolute,
      exists,
      appliedOrder: index + 1,
      managedOrder: managedKey ? configOrderByPath.get(managedKey) ?? null : null,
      packageId: owner?.id ?? null,
      packageSource: owner?.rawSource ?? null,
      manifestPath,
      declared,
      duplicate: false,
      name: owner?.name ?? (owner?.resolved ? basename(owner.resolved) : null) ?? (absolute ? basename(absolute).replace(/\.(ts|js|mjs)$/, '') : basename(bare)),
      version: declared || owner ? owner?.version ?? null : null,
      description: owner?.description ?? null,
      patchedApi,
    })
    if (absolute && !exists) warnings.push(`extension entry missing on disk: ${absolute}`)
    if (!absolute) warnings.push(`extension entry has no resolvable path: ${text}`)
  })
  for (const entry of entries) {
    if (entry.path && (seenPaths.get(entry.path) ?? 0) !== entry.appliedOrder) entry.duplicate = true
  }

  // ── auto-discovered files in <agentDir>/extensions (quarantined by the syncer's strict mode) ──
  const autoDir = join(agentDir, 'extensions')
  const appliedPaths = new Set(entries.map((entry) => entry.path).filter((value): value is string => Boolean(value)))
  const auto: AutoDiscovered[] = io
    .listFiles(autoDir)
    .filter((file) => /\.(ts|js|mjs)$/.test(file))
    .map((file) => ({ name: file.replace(/\.(ts|js|mjs)$/, ''), file, path: join(autoDir, file) }))
    .filter((item) => !appliedPaths.has(item.path))

  // ── declared-vs-applied drift ──
  // Only compare packages whose source resolves here; an unresolved `${VAR}` source must not turn
  // every applied entry into bogus drift (it is a dashboard env problem, reported as a warning).
  const drift: string[] = []
  const declaredPaths = new Set<string>()
  const unresolvedDeclared = new Set<string>()
  for (const item of configLoadOrder) {
    const record = asRecord(item)
    const path = asString(record?.['path'])
    const packageId = asString(record?.['package'])
    if (!path) continue
    const pkg = packages.find((candidate) => candidate.id === packageId)
    if (pkg?.resolved) declaredPaths.add(resolve(pkg.resolved, path))
    else if (packageId) unresolvedDeclared.add(packageId)
  }
  for (const path of declaredPaths) if (!appliedPaths.has(path)) drift.push(`declared but not applied: ${path}`)
  if (unresolvedDeclared.size === 0) {
    for (const path of appliedPaths) if (declaredPaths.size > 0 && !declaredPaths.has(path)) drift.push(`applied but not declared: ${path}`)
  } else {
    warnings.push(
      `declared-vs-applied not checked for ${unresolvedDeclared.size} package(s): their source in extensions.config.json uses ${'${VAR}'} placeholders the dashboard cannot resolve `
        + `(e.g. PI_TSIEN_EXTENSION_ROOT). Set them in dashboard.env to enable this check — applied entries: ${[...unresolvedDeclared].join(', ')}`,
    )
  }

  const counts = {
    packages: packages.length,
    applied: entries.length,
    enabled: entries.filter((entry) => entry.state !== 'disabled').length,
    disabled: entries.filter((entry) => entry.state === 'disabled').length,
    packageEntries: entries.filter((entry) => entry.group === 'package').length,
    pathEntries: entries.filter((entry) => entry.group === 'path').length,
    auto: auto.length,
    broken: entries.filter((entry) => !entry.exists).length,
    patched: entries.filter((entry) => entry.patchedApi.length > 0).length,
  }

  return { agentDir, settingsPath, configPath, configExists: config !== null, packages, extensions: entries, auto, drift, warnings, counts }
}