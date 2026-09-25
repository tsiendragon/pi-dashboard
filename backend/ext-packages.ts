/**
 * Package install / remove / update — one implementation for every caller.
 *
 * The old `/api/pi/packages/*` routes ran `execSync("pi install " + JSON.stringify(source))`, which
 * was unauthenticated, shell-interpolated, unbacked and unlogged. Everything now goes through here:
 *   - `execFile` (no shell, so a crafted source cannot inject commands);
 *   - a backup of `settings.json` and a before/after diff (via `SettingsStore`);
 *   - an audit record (via `ext-audit.ts`), including the backup path for rollback.
 */
import { execFile } from 'child_process'
import { appendAuditRecord, type ExtAuditAction, type ExtAuditRecord } from './ext-audit.js'
import type { SettingsStore } from './settings-store.js'

export type PackageAction = 'install' | 'remove' | 'update'

export interface PackageOperationInput {
  action: PackageAction
  source: string
  store: SettingsStore
  /** Resolved pi executable (never a shell string). */
  piBin: string
  actor?: string | null
  cwd?: string
  timeoutMs?: number
}

export interface PackageOperationResult {
  ok: boolean
  action: PackageAction
  source: string
  output: string
  error?: string
  before: string[]
  after: string[]
  backupPath: string | null
  audit: ExtAuditRecord
}

const DEFAULT_TIMEOUT_MS = 120_000

function entryList(settings: Record<string, unknown>): string[] {
  const extensions = settings['extensions']
  const packages = settings['packages']
  const extensionList = Array.isArray(extensions) ? extensions.filter((item): item is string => typeof item === 'string') : []
  // `packages[]` is a union: plain strings (load all) and objects with `source`.
  const packageList = Array.isArray(packages)
    ? packages
        .map((item) =>
          typeof item === 'string'
            ? item
            : item && typeof item === 'object' && typeof (item as { source?: unknown }).source === 'string'
              ? (item as { source: string }).source
              : null,
        )
        .filter((item): item is string => item !== null)
    : []
  return [...packageList.map((source) => `package:${source}`), ...extensionList]
}

/** `pi update self` / `pi update pi` would try to replace the running (patched) pi — refuse. */
export function validatePackageSource(action: PackageAction, source: string): string | null {
  if (!source.trim()) return 'source is required'
  if (/\s/.test(source.trim())) return 'source must not contain whitespace'
  if (action !== 'update') return null
  const normalized = source.trim()
  if (normalized === 'self' || normalized === 'pi') return `refusing to run "pi update ${normalized}" (that would replace the pi binary itself)`
  return null
}

export async function runPackageOperation(input: PackageOperationInput): Promise<PackageOperationResult> {
  const { action, source, store, piBin } = input
  const invalid = validatePackageSource(action, source)
  const before = entryList(store.read())

  const finish = (
    ok: boolean,
    output: string,
    error: string | undefined,
    backupPath: string | null,
    after: string[],
  ): PackageOperationResult => {
    const audit = appendAuditRecord(store.agentDir, {
      action: action as ExtAuditAction,
      target: source,
      actor: input.actor ?? null,
      ok,
      backupPath,
      before,
      after,
      output,
      ...(error === undefined ? {} : { error }),
    })
    return { ok, action, source, output, ...(error === undefined ? {} : { error }), before, after, backupPath, audit }
  }

  if (invalid) return finish(false, '', invalid, null, before)

  // Snapshot first so even a failed install leaves an audit record with a rollback point.
  let backupPath: string | null = null
  try {
    backupPath = store.snapshot()
  } catch {
    backupPath = null
  }

  const output = await new Promise<{ ok: boolean; text: string }>((resolve) => {
    execFile(
      piBin,
      [action, source],
      { timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, cwd: input.cwd, encoding: 'utf-8', env: process.env },
      (error, stdout, stderr) => {
        const text = `${stdout ?? ''}${stderr ?? ''}`.trim()
        resolve({ ok: !error, text: error ? `${text}${text ? '\n' : ''}${error.message}` : text })
      },
    )
  })

  const after = entryList(store.read())
  return finish(output.ok, output.text, output.ok ? undefined : output.text, backupPath, after)
}