/**
 * Minimal `/proc` helpers shared by the live-session lineage inference and the
 * subagent close path.
 *
 * Both need to answer "is this PID really the subagent `pi` child process the
 * browser is talking about?" — the browser supplies a PID, so it is re-checked
 * against the process environment before anything is signalled.
 */
import { readFileSync } from 'fs'

/**
 * Set by the subagent workbench on every child `pi` process it spawns. Used to
 * tell a subagent child apart from an unrelated (possibly recycled) PID.
 */
export const PI_SUBAGENT_CHILD_ENV = 'PI_SUBAGENT_WORKBENCH_CHILD'

/**
 * Read a process environment as a map, or `undefined` when it is unreadable
 * (process gone, different user, unsupported platform).
 */
export function readProcessEnviron(pid: number): Map<string, string> | undefined {
  try {
    const values = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
    return new Map(
      values
        .map(value => {
          const separator = value.indexOf('=')
          return separator > 0 ? ([value.slice(0, separator), value.slice(separator + 1)] as const) : undefined
        })
        .filter((entry): entry is readonly [string, string] => !!entry),
    )
  } catch {
    return undefined
  }
}

/** True only when the PID is a live subagent workbench child process. */
export function isSubagentChildProcess(pid: number, readEnviron: (pid: number) => Map<string, string> | undefined = readProcessEnviron): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  return readEnviron(pid)?.get(PI_SUBAGENT_CHILD_ENV) === '1'
}