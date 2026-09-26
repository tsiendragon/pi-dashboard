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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'

import type {
  AutoDiscovered,
  CrossPackageImport,
  PackageProvidedEntry,
  SharedPackageUsage,
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
  /** Relative file paths under `dir`, recursively. Optional: the cross-import scan degrades gracefully. */
  listFilesRecursive?(dir: string): string[]
  /** Symlink resolution (node resolves package symlinks); optional. */
  realPath?(path: string): string
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

/** Name of an `npm:<spec>` source, without the `npm:` prefix and without a version pin. */
function npmSourceName(source: string): string | null {
  if (!source.startsWith('npm:')) return null
  const spec = source.slice('npm:'.length).trim()
  if (!spec) return null
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    if (slash === -1) return spec
    const versionAt = spec.indexOf('@', slash)
    return versionAt === -1 ? spec : spec.slice(0, versionAt)
  }
  const versionAt = spec.indexOf('@')
  return versionAt === -1 ? spec : spec.slice(0, versionAt)
}

/**
 * Host + owner/repo of a git source, mirroring pi's `getGitInstallPath` layout
 * (`<agentDir>/git/<host>/<path>`). Handles `git:host/owner/repo`, git@host:owner/repo,
 * https://host/owner/repo(.git) and ssh://git@host/owner/repo.
 */
function gitSourceParts(source: string): { host: string; path: string } | null {
  const stripGit = (value: string): string => value.replace(/\.git$/, '').replace(/\/+$/, '')
  if (source.startsWith('git:')) {
    const rest = stripGit(source.slice('git:'.length))
    const slash = rest.indexOf('/')
    if (slash === -1) return null
    return { host: rest.slice(0, slash), path: rest.slice(slash + 1) }
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(source)
  if (scp && !source.includes('://')) return { host: scp[1]!, path: stripGit(scp[2]!) }
  if (source.startsWith('ssh://') || source.startsWith('https://') || source.startsWith('http://')) {
    try {
      const url = new URL(source.startsWith('ssh://') ? source : source)
      const host = url.hostname
      const path = stripGit(url.pathname.replace(/^\//, ''))
      if (!host || !path) return null
      return { host, path }
    } catch {
      return null
    }
  }
  return null
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
      // `${VAR}` sources cannot be expanded here when the dashboard did not inject the variable, so
      // also key by the trailing directory name (`.../packages/pi-tsien-web-tools` -> `pi-tsien-web-tools`).
      const tail = resolved.replace(/\/+$/, '').split('/').pop()
      if (tail && !configPackageIds.has(tail)) configPackageIds.set(tail, id)
    }
  }

  const packages: ExtensionPackage[] = []
  const settingsPackages = Array.isArray(settings?.['packages']) ? (settings!['packages'] as unknown[]) : []
  for (const item of settingsPackages) {
    // String form = load all resources; object form can filter resources and disable autoload.
    const objectForm = asRecord(item)
    const rawSource = typeof item === 'string' ? item : asString(objectForm?.['source'])
    if (!rawSource) continue
    const { resolved, missing } = expandVars(rawSource, env)
    // `pi install npm:<name>` materialises the package under <agentDir>/npm/node_modules/<name>
    // (project scope: <cwd>/.pi/npm/node_modules/<name>) — mirror pi's getManagedNpmInstallPath.
    const npmName = npmSourceName(resolved)
    const gitParts = npmName ? null : gitSourceParts(resolved)
    const cwd = process.cwd?.() ?? agentDir
    const bases: Array<{ label: 'agent-dir' | 'pi-dir' | 'cwd'; dir: string }> = gitParts
      ? [
          { label: 'agent-dir', dir: join(agentDir, 'git', gitParts.host, gitParts.path) },
          { label: 'cwd', dir: join(cwd, '.pi', 'git', gitParts.host, gitParts.path) },
        ]
      : npmName
      ? [
          { label: 'agent-dir', dir: join(agentDir, 'npm', 'node_modules', npmName) },
          { label: 'cwd', dir: join(cwd, '.pi', 'npm', 'node_modules', npmName) },
        ]
      : isAbsolute(resolved) || classifySource(resolved) !== 'local'
        ? []
        : [
            { label: 'agent-dir', dir: agentDir },
            { label: 'pi-dir', dir: resolve(agentDir, '..') },
            { label: 'cwd', dir: cwd },
          ]
    let resolvedPath: string | null = null
    let resolvedBase: ExtensionPackage['resolvedBase'] = null
    if (missing.length === 0) {
      if (bases.length === 0) {
        resolvedPath = resolved
        resolvedBase = 'agent-dir'
      } else if (npmName || gitParts) {
        // For npm sources the candidate dirs are already absolute package paths.
        for (const candidate of bases) {
          if (io.isDirectory(candidate.dir)) {
            resolvedPath = candidate.dir
            resolvedBase = candidate.label
            break
          }
        }
        if (resolvedPath === null) {
          resolvedPath = bases[0]!.dir
          resolvedBase = bases[0]!.label
        }
      } else {
        for (const candidate of bases) {
          const attempt = resolve(candidate.dir, resolved)
          if (io.isDirectory(attempt)) {
            resolvedPath = attempt
            resolvedBase = candidate.label
            break
          }
        }
        if (resolvedPath === null) {
          resolvedPath = resolve(bases[0]!.dir, resolved)
          resolvedBase = bases[0]!.label
        }
      }
    }
    const exists = missing.length === 0 && resolvedPath !== null && io.isDirectory(resolvedPath)
    const manifest = exists && resolvedPath ? io.readJson(join(resolvedPath, 'package.json')) : null
    const piField = asRecord(manifest?.['pi'])
    const declared = Array.isArray(piField?.['extensions']) ? (piField!['extensions'] as unknown[]) : []
    const filters: ExtensionPackage['filters'] = {}
    for (const resource of ['extensions', 'skills', 'prompts', 'themes'] as const) {
      const value = objectForm?.[resource]
      if (Array.isArray(value)) filters[resource] = value.filter((entry): entry is string => typeof entry === 'string')
    }
    packages.push({
      // Match the config's declared package by resolved path first, then by directory name.
      id:
        configPackageIds.get(resolvedPath ?? resolved) ??
        configPackageIds.get(resolved) ??
        (resolvedPath ? configPackageIds.get(basename(resolvedPath)) : undefined) ??
        null,
      rawSource,
      form: typeof item === 'string' ? 'string' : 'object',
      sourceKind: npmName ? 'npm' : gitParts ? 'git' : 'local',
      resolved: resolvedPath,
      exists,
      kind: missing.length > 0 ? 'unresolved' : classifySource(rawSource),
      unresolvedVars: missing,
      resolvedBase,
      name: asString(manifest?.['name']),
      version: asString(manifest?.['version']),
      description: asString(manifest?.['description']),
      declaredEntries: declared.filter((entry): entry is string => typeof entry === 'string'),
      filters,
      autoload: typeof item === 'string' ? true : objectForm?.['autoload'] !== false,
    })
    if (missing.length > 0) warnings.push(`package source ${rawSource} references unset variable(s): ${missing.join(', ')}`)
    else if (!exists && npmName) warnings.push(`npm 包尚未安装：${npmName}（先执行 pi install npm:${npmName}）`)
    else if (!exists && gitParts)
      warnings.push(`git 包尚未克隆：${gitParts.host}/${gitParts.path}（先执行 pi install git:${gitParts.host}/${gitParts.path}）`)
    else if (!exists) warnings.push(`package source not found on disk: ${resolvedPath}`)
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
        absolute = bare
        break
      }
    }
    if (!absolute && isAbsolute(bare)) absolute = bare
    // Longest matching prefix: the repo-root package also matches everything underneath it, so a
    // naive first-match would attribute every sub-package file to the root package.
    const owner = absolute
      ? packages
          .filter((pkg) => pkg.resolved && (absolute === pkg.resolved || absolute.startsWith(pkg.resolved + sep)))
          .sort((a, b) => (b.resolved?.length ?? 0) - (a.resolved?.length ?? 0))[0] ?? null
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

  // ── entries packages provide by themselves, without a settings entry ──
  // Mirrors pi's resource resolution: string form / `autoload !== false` starts from the package
  // manifest (`pi.extensions`), `autoload: false` starts empty and only the settings filter applies;
  // glob patterns are expanded alphabetically (package-manager.ts expandPackageGlob).
  const expandGlob = (root: string, pattern: string): string[] => {
    const cleaned = pattern.replace(/^\.\//, '')
    if (!cleaned.includes('*')) return [cleaned]
    const matcher = new RegExp(`^${cleaned.split('**').map((part) => part.split('*').map((chunk) => chunk.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`)
    return (io.listFilesRecursive?.(root) ?? []).filter((file) => matcher.test(file)).sort()
  }
  // Attribute a provided entry to the package that actually owns the file (nearest package.json
  // inside the settings package), so an umbrella git package does not swallow its sub-packages.
  const ownerNameCache = new Map<string, string | null>()
  const ownerPackageName = (target: string, packageRoot: string): string | null => {
    const cached = ownerNameCache.get(target)
    if (cached !== undefined) return cached
    let dir = dirname(target)
    let found: string | null = null
    while (dir.length > packageRoot.length) {
      const manifest = io.readJson(join(dir, 'package.json'))
      if (manifest) {
        found = asString(manifest['name'])
        break
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    ownerNameCache.set(target, found)
    return found
  }

  const provided: PackageProvidedEntry[] = []
  for (const pkg of packages) {
    if (!pkg.resolved || !pkg.exists) continue
    const patterns: Array<{ pattern: string; kind: 'manifest' | 'filter' }> = []
    if (pkg.autoload) for (const pattern of pkg.declaredEntries) patterns.push({ pattern, kind: 'manifest' })
    for (const pattern of pkg.filters.extensions ?? []) patterns.push({ pattern, kind: 'filter' })
    for (const { pattern, kind } of patterns) {
      for (const manifestPath of expandGlob(pkg.resolved, pattern)) {
        const target = resolve(pkg.resolved, manifestPath)
        if (appliedPaths.has(target)) continue
        if (provided.some((item) => item.path === target)) continue
        provided.push({
          packageId: pkg.id,
          packageName: ownerPackageName(target, pkg.resolved) ?? pkg.name,
          path: target,
          manifestPath,
          exists: io.fileExists(target),
          kind,
          pattern,
        })
      }
    }
  }

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
    provided: provided.length,
    auto: auto.length,
    broken: entries.filter((entry) => !entry.exists).length,
    patched: entries.filter((entry) => entry.patchedApi.length > 0).length,
  }

  return { agentDir, settingsPath, configPath, configExists: config !== null, packages, extensions: entries, provided, auto, drift, warnings, counts }
}

export interface DependencyScanInput extends BuildInput {
  /** Cap on files scanned per package (keeps the endpoint bounded). */
  maxFilesPerPackage?: number
  /** Cap on bytes read per file. */
  maxFileBytes?: number
}

export interface DependencyScanResult {
  crossImports: CrossPackageImport[]
  sharedPackages: SharedPackageUsage[]
  externalPackages: string[]
  scannedFiles: number
  truncated: boolean
}

/**
 * Cross-package static import scan — the design's class ③ dependency signal.
 *
 * Kept OUT of `buildExtensionInventory`: it reads many files, so the list endpoint stays cheap and
 * this runs on its own endpoint (`GET /api/pi/ext/deps`) with a bounded budget.
 */
export function deriveExtensionDependencies(input: DependencyScanInput): DependencyScanResult {
  const inventory = buildExtensionInventory(input)
  const io18 = input.io
  const { packages, extensions: entries, agentDir } = inventory
  const maxFilesPerPackage = input.maxFilesPerPackage ?? 120
  const maxFileBytes = input.maxFileBytes ?? 256 * 1024
  let scannedFiles = 0
  let truncated = false

  // Resolution mirrors Node: package-name specifiers are looked up in `node_modules` (npm workspaces
  // symlink our packages there) and, as a shortcut, in the declared settings packages.
  const packageByName = new Map<string, ExtensionPackage>()
  for (const pkg of packages) if (pkg.name) packageByName.set(pkg.name, pkg)

  const manifestCache = new Map<string, { dir: string; name: string | null } | null>()
  const nearestPackage = (fromPath: string): { dir: string; name: string | null } | null => {
    let dir = dirname(fromPath)
    for (let depth = 0; depth < 12; depth += 1) {
      const cached = manifestCache.get(dir)
      if (cached !== undefined) return cached
      const manifestPath = join(dir, 'package.json')
      if (io18.fileExists(manifestPath)) {
        const parsed = io18.readJson(manifestPath)
        const result = { dir, name: typeof parsed?.['name'] === 'string' ? (parsed['name'] as string) : null }
        manifestCache.set(dir, result)
        return result
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    manifestCache.set(dirname(fromPath), null)
    return null
  }

  const resolveInDirectory = (base: string): string | null => {
    for (const attempt of [base, `${base}.ts`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.js')]) {
      if (io18.fileExists(attempt)) return io18.realPath?.(attempt) ?? attempt
    }
    return null
  }

  const resolveSpecifier = (fromFile: string, specifier: string): string | null => {
    if (specifier.startsWith('.')) return resolveInDirectory(resolve(dirname(fromFile), specifier))
    const declared = packageByName.get(specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'))
    if (declared?.resolved) {
      const rest = specifier.slice(specifier.indexOf('/') + 1)
      const hit = resolveInDirectory(specifier.includes('/') ? resolve(declared.resolved, rest) : declared.resolved)
      if (hit) return hit
    }
    // node_modules walk (handles packages that are not declared in settings.json, e.g. libraries)
    const segments = specifier.split('/')
    const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!
    const rest = specifier.slice(packageName.length + 1)
    let dir = dirname(fromFile)
    for (let depth = 0; depth < 12; depth += 1) {
      const candidate = join(dir, 'node_modules', packageName)
      if (io18.isDirectory(candidate)) {
        const real = io18.realPath?.(candidate) ?? candidate
        return resolveInDirectory(rest ? join(real, rest) : real)
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  }

  const settingsOwnerOf = (target: string): ExtensionPackage | null =>
    packages
      .filter((pkg) => pkg.resolved && (target === pkg.resolved || target.startsWith(pkg.resolved + sep)))
      .sort((a, b) => (b.resolved?.length ?? 0) - (a.resolved?.length ?? 0))[0] ?? null
  /** Package a file belongs to: the nearest ancestor with package.json (settings package or library). */
  const packageRootOf = (target: string): { dir: string; name: string | null; settings: ExtensionPackage | null } | null => {
    const nearest = nearestPackage(target)
    if (!nearest) return null
    return { dir: nearest.dir, name: nearest.name, settings: settingsOwnerOf(target) }
  }
  const entryByPath = new Map<string, ExtensionEntry>()
  for (const entry of entries) if (entry.path) entryByPath.set(entry.path, entry)
  const importSpecifiers = (source: string): string[] => {
    const found: string[] = []
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) found.push(match[1]!)
    return found
  }

  const crossImports: CrossPackageImport[] = []
  const externalPackages = new Set<string>()
  const importedByPackage = new Map<string, { pkg: { dir: string; name: string | null; settings: ExtensionPackage | null }; from: Set<string>; files: Set<string> }>()
  for (const entry of entries) {
    if (!entry.path || !entry.exists) continue
    const own = packageRootOf(entry.path)
    const ownDir = own?.dir ?? null
    const sources: string[] = [entry.path]
    if (ownDir) {
      const listed = (io18.listFilesRecursive?.(ownDir) ?? []).filter((file) => /\.(ts|js|mjs)$/.test(file))
      if (listed.length > maxFilesPerPackage) truncated = true
      for (const file of listed.slice(0, maxFilesPerPackage)) sources.push(join(ownDir, file))
    }
    for (const file of sources) {
      const source = io18.readText(file)
      if (source === null) continue
      if (source.length > maxFileBytes) {
        truncated = true
        continue
      }
      scannedFiles += 1
      for (const specifier of importSpecifiers(source)) {
        const target = resolveSpecifier(file, specifier)
        if (!target) continue
        const targetRoot = packageRootOf(target)
        if (!targetRoot || (ownDir && (target === ownDir || target.startsWith(ownDir + sep)))) continue
        // Third-party deps are not "shared code between entries": list them separately only.
        const isOurs = Boolean(targetRoot.settings) || /^pi-(tsien|rtk|zero|knowledge|web)/.test(targetRoot.name ?? '')
        if (!isOurs) {
          externalPackages.add(targetRoot.name ?? targetRoot.dir.split(sep).pop() ?? 'unknown')
          continue
        }
        crossImports.push({
          from: entry.name ?? entry.raw,
          fromPath: file,
          toPackageId: targetRoot.settings?.id ?? null,
          toPath: target,
          toManifestPath: relative(targetRoot.dir, target),
          toEntry: entryByPath.get(target)?.name ?? null,
        })
        // Group by the nearest package.json (the real package boundary): a library such as
        // `pi-tsien-shared` is not declared in settings.json but is still the thing being imported.
        const grouped = targetRoot
        const key = grouped.dir
        const bucket = importedByPackage.get(key) ?? { pkg: grouped, from: new Set<string>(), files: new Set<string>() }
        bucket.from.add(entry.name ?? entry.raw)
        bucket.files.add(target)
        importedByPackage.set(key, bucket)
      }
    }
  }
  const sharedPackages: SharedPackageUsage[] = [...importedByPackage.values()]
    .map((bucket) => ({
      packageId: bucket.pkg.settings?.id ?? null,
      packageName: bucket.pkg.name ?? bucket.pkg.dir.split('/').pop() ?? null,
      importedBy: [...bucket.from].sort(),
      files: bucket.files.size,
    }))
    .sort((a, b) => b.importedBy.length - a.importedBy.length)

  void agentDir
  return { crossImports, sharedPackages, externalPackages: [...externalPackages].sort(), scannedFiles, truncated }
}
