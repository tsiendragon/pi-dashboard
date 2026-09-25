/**
 * Extension inventory types — shared by the backend builder (`backend/ext-inventory.ts`) and the
 * Extensions page. See the backend module for how each field is derived and its confidence.
 */

export type ExtState = 'enabled' | 'disabled' | 'forced'
export type ExtGroup = 'package' | 'path' | 'auto'
export type PackageKind = 'local' | 'npm' | 'git' | 'unresolved'

/**
 * `settings.json` `packages[]` entries are a union (pi's `PackageSource`):
 *   - string form  → load all resources from the package
 *   - object form  → `autoload:false` starts empty and only the explicit patterns apply
 */
export interface ExtensionPackage {
  /** id from `extensions.config.json`, when the package is also declared there. */
  id: string | null
  rawSource: string
  /** `string` = load-all form, `object` = filtered form. */
  form: 'string' | 'object'
  resolved: string | null
  exists: boolean
  kind: PackageKind
  unresolvedVars: string[]
  /** Which base a relative source was resolved against (relative sources are written that way). */
  resolvedBase: 'agent-dir' | 'pi-dir' | 'cwd' | null
  name: string | null
  version: string | null
  description: string | null
  /** Entry points declared in the package manifest (`pi.extensions`). */
  declaredEntries: string[]
  /** Explicit resource filters from the object form. */
  filters: { extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] }
  /** Object form with `autoload:false`: nothing is loaded unless a pattern matches. */
  autoload: boolean
}

/**
 * Static import edge between two settings packages (design §6 class ③: file-level imports).
 * Confidence: `derived` — only explicit relative / package-name imports are seen, not dynamic ones.
 */
export interface CrossPackageImport {
  /** Entry (by the name shown in the list) that contains the importing file. */
  from: string
  /** Importing file path. */
  fromPath: string
  /** Package the import points into. */
  toPackageId: string | null
  /** Absolute path inside the target package. */
  toPath: string
  /** Relative path inside the target package. */
  toManifestPath: string | null
  /** Set when the target file is itself an applied entry. */
  toEntry: string | null
}

/** A package whose code other entries import — disabling an entry here does not unload it. */
export interface SharedPackageUsage {
  packageId: string | null
  packageName: string | null
  importedBy: string[]
  files: number
}

/** An extension file a package provides by itself (manifest/autoload), without a settings entry. */
export interface PackageProvidedEntry {
  packageId: string | null
  packageName: string | null
  /** Absolute path. */
  path: string
  /** Path relative to the package directory. */
  manifestPath: string
  exists: boolean
  /** Where the entry comes from: the package manifest (`pi.extensions`) or the settings filter. */
  kind: 'manifest' | 'filter'
  /** The pattern that produced it (globs are expanded like pi does: alphabetically). */
  pattern: string
}

export interface ExtensionEntry {
  /** Exactly as written in `settings.json` (prefix included). */
  raw: string
  state: ExtState
  group: ExtGroup
  /** Absolute path, or null when the entry cannot be resolved. */
  path: string | null
  exists: boolean
  /** 1-based position in `settings.json` — the applied load order. */
  appliedOrder: number
  /** 1-based position in `extensions.config.json` loadOrder, when managed there. */
  managedOrder: number | null
  packageId: string | null
  packageSource: string | null
  /** Path relative to the providing package directory. */
  manifestPath: string | null
  declared: boolean
  duplicate: boolean
  name: string | null
  version: string | null
  description: string | null
  /** Patched-pi APIs used by this entry (heuristic scan, not a real dependency). */
  patchedApi: string[]
}

export interface AutoDiscovered {
  name: string
  file: string
  path: string
}

export interface ExtInventory {
  agentDir: string
  settingsPath: string
  configPath: string
  configExists: boolean
  packages: ExtensionPackage[]
  extensions: ExtensionEntry[]
  /** Provided by packages themselves (autoload), not listed in `settings.extensions`. */
  provided: PackageProvidedEntry[]
  auto: AutoDiscovered[]
  /** Declared in the syncer config but absent from settings, or the other way round. */
  drift: string[]
  warnings: string[]
  counts: {
    packages: number
    applied: number
    enabled: number
    disabled: number
    packageEntries: number
    pathEntries: number
    provided: number
    auto: number
    broken: number
    /** Entries whose source uses patched APIs — they need the tsien patched pi. */
    patched: number
  }
}

/** Payload of `GET /api/pi/ext/deps` — the heavier static scan, deliberately separate from the list. */
export interface ExtDependencies {
  crossImports: CrossPackageImport[]
  sharedPackages: SharedPackageUsage[]
  /** Third-party packages imported by entries (kept apart from "shared code" between entries). */
  externalPackages: string[]
  scannedFiles: number
  truncated: boolean
  cached: boolean
}
