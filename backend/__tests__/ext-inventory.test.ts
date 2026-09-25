import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { readFileSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildExtensionInventory, deriveExtensionDependencies, type InventoryIo } from '../ext-inventory.js'

let dir: string

/** Real-filesystem I/O so the test covers the same reads the route performs. */
const io: InventoryIo = {
  readJson(path) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  },
  readText(path) {
    try {
      return readFileSync(path, 'utf-8')
    } catch {
      return null
    }
  },
  fileExists(path) {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  isDirectory(path) {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  listFiles(path) {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
  listFilesRecursive(dir) {
    const out: string[] = []
    const walk = (current: string): void => {
      let items: import('fs').Dirent[] = []
      try {
        items = readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        if (item.name === 'node_modules') continue
        const full = join(current, item.name)
        if (item.isDirectory()) walk(full)
        else out.push(full.slice(dir.length + 1))
      }
    }
    walk(dir)
    return out
  },
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-dash-ext-inventory-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Two packages: one migrated package with a manifest, one plain directory package without one. */
function seed(): { agentDir: string; pkgDir: string; pathDir: string } {
  const agentDir = join(dir, 'agent')
  const pkgDir = join(dir, 'repo/packages/pi-tsien-goal')
  const pathDir = join(dir, 'repo/tools')

  write(join(pkgDir, 'package.json'), JSON.stringify({
    name: 'pi-tsien-goal',
    version: '0.1.0',
    description: 'Goal tracking',
    pi: { extensions: ['./src/index.ts'] },
  }))
  write(join(pkgDir, 'src/index.ts'), 'export default function goal() {}\n')
  write(join(pathDir, 'patched.ts'), 'ctx.executeTool("bash", {})\n')
  write(join(pathDir, 'not-applied.ts'), 'export default function unused() {}\n')
  write(join(dir, 'standalone/single.ts'), 'export default function single() {}\n')
  write(join(agentDir, 'extensions/loose.ts'), 'export default function loose() {}\n')

  write(join(agentDir, 'settings.json'), JSON.stringify({
    packages: [
      { source: `${dir}/repo/packages/pi-tsien-goal`, autoload: false },
      { source: `${dir}/repo/tools`, autoload: false },
      { source: '${MISSING_ROOT}/x', autoload: false },
    ],
    extensions: [
      `${pkgDir}/src/index.ts`,
      `-${pathDir}/patched.ts`,
      `${pathDir}/patched.ts`,
      `${pkgDir}/src/gone.ts`,
      `${dir}/standalone/single.ts`,
    ],
  }))
  write(join(agentDir, 'extensions.config.json'), JSON.stringify({
    packages: [
      { id: 'pi-tsien-goal', source: `${dir}/repo/packages/pi-tsien-goal`, autoload: false },
      { id: 'tools', source: `${dir}/repo/tools`, autoload: false },
    ],
    loadOrder: [
      { package: 'pi-tsien-goal', path: 'src/index.ts' },
      { package: 'tools', path: 'patched.ts' },
      { package: 'tools', path: 'not-applied.ts' },
    ],
  }))
  return { agentDir, pkgDir, pathDir }
}

describe('buildExtensionInventory', () => {
  it('reports the applied set with attribution, state and health', () => {
    const { agentDir, pkgDir, pathDir } = seed()
    const inventory = buildExtensionInventory({ agentDir, env: { MISSING_ROOT: undefined }, io })

    expect(inventory.counts.applied).toBe(5)
    expect(inventory.counts.disabled).toBe(1)
    // 归属按「是否落在已声明 package 的目录下」判定：goal / tools 各两条，单文件一条
    expect(inventory.counts.packageEntries).toBe(4)
    expect(inventory.counts.pathEntries).toBe(1)
    expect(inventory.counts.broken).toBe(1)

    const goal = inventory.extensions[0]
    expect(goal?.name).toBe('pi-tsien-goal')   // 包内条目显示包名，而不是入口文件名
    expect(goal?.packageId).toBe('pi-tsien-goal')
    expect(goal?.manifestPath).toBe('src/index.ts')
    expect(goal?.declared).toBe(true)
    expect(goal?.managedOrder).toBe(1)
    expect(goal?.version).toBe('0.1.0')
    expect(goal?.exists).toBe(true)

    const disabled = inventory.extensions[1]
    expect(disabled?.state).toBe('disabled')
    expect(disabled?.raw.startsWith('-')).toBe(true)
    expect(disabled?.path).toBe(`${pathDir}/patched.ts`)

    const duplicate = inventory.extensions[2]
    expect(duplicate?.duplicate).toBe(true)
    expect(duplicate?.path).toBe(`${pathDir}/patched.ts`)

    const missing = inventory.extensions[3]
    expect(missing?.exists).toBe(false)
    expect(missing?.path).toBe(`${pkgDir}/src/gone.ts`)

    const standalone = inventory.extensions[4]
    expect(standalone?.group).toBe('path')
    expect(standalone?.packageId).toBeNull()
  })

  it('labels patched-API usage as a heuristic and flags unresolved package sources', () => {
    const { agentDir } = seed()
    const inventory = buildExtensionInventory({ agentDir, env: { MISSING_ROOT: undefined }, io })

    expect(inventory.extensions[1]?.patchedApi).toEqual(['executeTool'])
    expect(inventory.counts.patched).toBe(2)
    expect(inventory.packages[2]?.kind).toBe('unresolved')
    expect(inventory.packages[2]?.unresolvedVars).toEqual(['MISSING_ROOT'])
    expect(inventory.warnings.some((warning) => warning.includes('MISSING_ROOT'))).toBe(true)
  })

  it('lists auto-discovered files that are not applied, and the declared-vs-applied drift', () => {
    const { agentDir, pathDir } = seed()
    const inventory = buildExtensionInventory({ agentDir, env: { MISSING_ROOT: undefined }, io })

    expect(inventory.auto.map((item) => item.file)).toEqual(['loose.ts'])
    expect(inventory.drift).toContain(`declared but not applied: ${join(pathDir, 'not-applied.ts')}`)
    expect(inventory.drift).toContain(`applied but not declared: ${join(dir, 'standalone/single.ts')}`)
    expect(inventory.configExists).toBe(true)
  })

  it('does not report bogus drift when declared package sources are unresolvable', () => {
    const { agentDir } = seed()
    const config = JSON.parse(readFileSync(join(agentDir, 'extensions.config.json'), 'utf-8'))
    config.packages[0].source = '${NOT_SET_HERE}/pkg'
    writeFileSync(join(agentDir, 'extensions.config.json'), JSON.stringify(config), 'utf-8')

    const inventory = buildExtensionInventory({ agentDir, env: {}, io })
    expect(inventory.drift.every((item) => !item.startsWith('applied but not declared'))).toBe(true)
    expect(inventory.warnings.some((warning) => warning.includes('declared-vs-applied not checked'))).toBe(true)
  })

  it('handles the string package form (load-all) and lists the entries it provides', () => {
    const { agentDir } = seed()
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf-8'))
    // pi install writes plain strings, relative to the agent dir — reproduce that form.
    settings.packages.push('../repo/packages/pi-tsien-goal')
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings), 'utf-8')

    const inventory = buildExtensionInventory({ agentDir, env: { MISSING_ROOT: undefined }, io })
    const stringPkg = inventory.packages.find((item) => item.form === 'string')
    expect(stringPkg?.autoload).toBe(true)
    expect(stringPkg?.resolved?.endsWith('repo/packages/pi-tsien-goal')).toBe(true)
    expect(stringPkg?.resolvedBase).toBeTruthy()
    // its entry is already applied, so it must not show up as package-provided-again
    expect(inventory.provided.some((item) => item.path.endsWith('pi-tsien-goal/src/index.ts'))).toBe(false)
    expect(inventory.counts.provided).toBe(0)
  })

  it('lists entries a package provides by autoload when they are not in settings.extensions', () => {
    const { agentDir, pkgDir } = seed()
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf-8'))
    // string form = load-all (autoload), then drop the explicit entry so the
    // manifest-provided one becomes the only reason the extension loads
    settings.packages = settings.packages.map((item: unknown) =>
      typeof item === 'object' && item !== null && String((item as { source?: string }).source).includes('pi-tsien-goal')
        ? '../repo/packages/pi-tsien-goal'
        : item,
    )
    settings.extensions = settings.extensions.filter((entry: string) => !entry.includes('pi-tsien-goal'))
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings), 'utf-8')

    const inventory = buildExtensionInventory({ agentDir, env: { MISSING_ROOT: undefined }, io })
    expect(inventory.provided).toEqual([
      {
        packageId: 'pi-tsien-goal',
        packageName: 'pi-tsien-goal',
        path: `${pkgDir}/src/index.ts`,
        manifestPath: 'src/index.ts',
        exists: true,
        kind: 'manifest',
        pattern: './src/index.ts',
      },
    ])
    expect(inventory.counts.provided).toBe(1)
  })

  it('keeps the list payload free of the heavy scan (perf guard)', () => {
    const { agentDir } = seed()
    const inventory = buildExtensionInventory({ agentDir, env: { MISSING_ROOT: undefined }, io })
    expect('crossImports' in inventory).toBe(false)
    expect('sharedPackages' in inventory).toBe(false)
    expect('crossImports' in inventory.counts).toBe(false)
  })

  // fs-heavy (tmp dir + recursive walk); the scan itself is ~3ms, the budget is for the harness.
  it('derives cross-package imports (谁 import 了别的包的代码)', { timeout: 20_000 }, () => {
    const { agentDir, pkgDir } = seed()
    // a second package that imports into the first one, exactly like live-session -> auto-compact core
    const otherDir = join(dir, 'repo/packages/pi-tsien-live-session')
    write(join(otherDir, 'package.json'), JSON.stringify({ name: 'pi-tsien-live-session', version: '0.1.0', pi: { extensions: ['./src/index.ts'] } }))
    write(join(otherDir, 'src/index.ts'), 'import { shared } from "pi-tsien-goal/src/shared.ts";\nexport default function live() {}\n')
    write(join(pkgDir, 'src/shared.ts'), 'export const shared = 1\n')

    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf-8'))
    settings.packages.push({ source: otherDir, autoload: false })
    settings.extensions.push(`${otherDir}/src/index.ts`)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings), 'utf-8')

    const scan = deriveExtensionDependencies({ agentDir, env: { MISSING_ROOT: undefined }, io, maxFilesPerPackage: 50 })
    const edge = scan.crossImports.find((item) => item.from === 'pi-tsien-live-session')
    expect(edge?.toPackageId).toBe('pi-tsien-goal')
    expect(edge?.toManifestPath).toBe('src/shared.ts')
    const shared = scan.sharedPackages.find((item) => item.packageId === 'pi-tsien-goal')
    expect(shared?.importedBy).toEqual(['pi-tsien-live-session'])
    expect(scan.scannedFiles).toBeGreaterThan(0)
  })

  it('expands manifest globs and honors the settings filter for autoload:false packages', () => {
    const { agentDir } = seed()
    const globDir = join(dir, 'repo/packages/pi-tsien-globpkg')
    write(join(globDir, 'package.json'), JSON.stringify({
      name: 'pi-tsien-globpkg',
      version: '0.1.0',
      pi: { extensions: ['./ext/*.ts'] },
    }))
    write(join(globDir, 'ext/b-second.ts'), 'export default function b() {}\n')
    write(join(globDir, 'ext/a-first.ts'), 'export default function a() {}\n')

    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf-8'))
    // autoload:false + explicit filter → only the filtered file loads (not the glob)
    settings.packages.push({ source: globDir, autoload: false, extensions: ['./ext/a-first.ts'] })
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings), 'utf-8')

    const filtered = buildExtensionInventory({ agentDir, env: { MISSING_ROOT: undefined }, io })
    const globEntries = filtered.provided.filter((item) => item.path.includes('globpkg'))
    expect(globEntries.map((item) => `${item.kind}:${item.manifestPath}`)).toEqual(['filter:ext/a-first.ts'])

    // autoload true (default) → the glob expands, alphabetically like pi does
    settings.packages[settings.packages.length - 1] = { source: globDir }
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings), 'utf-8')
    const autoloaded = buildExtensionInventory({ agentDir, env: { MISSING_ROOT: undefined }, io })
    expect(autoloaded.provided.filter((item) => item.path.includes('globpkg')).map((item) => item.manifestPath))
      .toEqual(['ext/a-first.ts', 'ext/b-second.ts'])
  })

  it('survives a missing settings.json instead of throwing', () => {
    const agentDir = join(dir, 'empty-agent')
    mkdirSync(agentDir, { recursive: true })
    const inventory = buildExtensionInventory({ agentDir, env: {}, io })

    expect(inventory.extensions).toEqual([])
    expect(inventory.counts.applied).toBe(0)
    expect(inventory.warnings.some((warning) => warning.includes('settings.json'))).toBe(true)
  })
})