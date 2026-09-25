/**
 * Serialized writer for the pi agent directory's `settings.json`.
 *
 * Why a single module: `settings.json` used to be written by a full-file `PUT /api/pi/settings`, and
 * the Extensions page would write the same file for enable/disable and reorder. Two writers reading
 * and rewriting the whole document concurrently lose each other's changes (`system.ts` PUT vs a
 * toggle). Everything now goes through `mutate()`, which is serialized and always:
 *   1. reads the current file,
 *   2. copies it to `<agent dir>/backups/settings-<timestamp>.json`,
 *   3. applies the mutation,
 *   4. writes atomically (temp file + rename).
 *
 * Only keys the mutator touches change; unrelated keys are preserved verbatim.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import os from 'os'

export interface SettingsMutationResult<T> {
  result: T
  /** Backup written before the mutation; null when nothing changed (no write happened). */
  backupPath: string | null
  changed: boolean
  before: Record<string, unknown>
  after: Record<string, unknown>
}

export class SettingsStore {
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * `resolveAgentDir` is called per operation (not captured) so a later `PI_CODING_AGENT_DIR`
   * injection still applies.
   */
  constructor(private readonly resolveAgentDir: () => string) {}

  get agentDir(): string {
    return this.resolveAgentDir()
  }

  get settingsPath(): string {
    return join(this.agentDir, 'settings.json')
  }

  get backupsDir(): string {
    return join(this.agentDir, 'backups')
  }

  /** Current settings (empty object when the file is missing or malformed, never throws). */
  read(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.settingsPath, 'utf-8'))
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  /** Copy the current file into `backups/` without modifying it. Returns the backup path. */
  snapshot(): string {
    return this.writeBackup()
  }

  /**
   * Run `mutator` against the current settings under a serialization lock.
   *
   * Returning `undefined` from the mutator means "no change" and skips the write entirely.
   */
  mutate<T>(mutator: (settings: Record<string, unknown>, save: (next: Record<string, unknown>) => void) => T | undefined): Promise<SettingsMutationResult<T | undefined>> {
    const run = async (): Promise<SettingsMutationResult<T | undefined>> => {
      const before = this.read()
      let next: Record<string, unknown> | null = null
      const save = (updated: Record<string, unknown>): void => {
        next = updated
      }
      const result = mutator(structuredClone(before), save)
      if (next === null) {
        return { result, backupPath: null, changed: false, before, after: before }
      }
      const after = next as Record<string, unknown>
      const backupPath = this.writeBackup()
      this.writeAtomic(after)
      return { result, backupPath, changed: true, before, after }
    }
    const chained = this.queue.then(run, run)
    // Keep the chain alive even if a caller's mutation throws.
    this.queue = chained.then(
      () => undefined,
      () => undefined,
    )
    return chained
  }

  private writeBackup(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = join(this.backupsDir, `settings-${stamp}.json`)
    try {
      mkdirSync(this.backupsDir, { recursive: true })
      if (existsSync(this.settingsPath)) copyFileSync(this.settingsPath, backupPath)
      else writeFileSync(backupPath, '{}\n', 'utf-8')
    } catch {
      // A failed backup must not silently allow an unbacked write; surface it to the caller instead.
      throw new Error(`could not back up settings.json to ${backupPath}`)
    }
    return backupPath
  }

  private writeAtomic(settings: Record<string, unknown>): void {
    const temp = `${this.settingsPath}.tmp-${process.pid}`
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
    renameSync(temp, this.settingsPath)
  }
}
/** The agent directory Pi itself uses. */
export function defaultAgentDir(): string {
  return process.env['PI_CODING_AGENT_DIR'] ?? join(os.homedir(), '.pi', 'agent')
}

/**
 * Process-wide store: every writer of `settings.json` must share this instance for the serialization
 * to mean anything (`PUT /api/pi/settings`, extension toggle/order, future writers).
 */
export const settingsStore = new SettingsStore(defaultAgentDir)
