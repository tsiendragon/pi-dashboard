/**
 * Extension write operations — pure functions over `settings.json`'s `extensions[]`.
 *
 * Pi reads prefixes on each entry (`package-manager.ts` override resolution):
 *   - plain   include
 *   - `!path` exclude (pattern)
 *   - `+path` force-include (overrides exclusions)
 *   - `-path` force-exclude (strongest: applied after force-include)
 *
 * Both operations are non-destructive (the path text is never lost) and idempotent, and they keep
 * each entry at its position so nothing else in the user's declared order moves.
 */

export type ToggleDirection = 'enable' | 'disable'

export interface WritePreview {
  before: string[]
  after: string[]
}

function stripPrefix(entry: string): { prefix: string; path: string } {
  return /^[+\-!]/.test(entry) ? { prefix: entry[0]!, path: entry.slice(1) } : { prefix: '', path: entry }
}

/**
 * Enable/disable one entry.
 *
 * enable : `-path` → plain (round-trips to what it was before disabling); `!path`/`+path` → `+path`
 *          (an exclusion must be overridden by a force-include); plain stays plain.
 * disable: any form → `-path` (force-exclude must win over a `+path` from elsewhere).
 */
export function applyToggle(entries: readonly string[], path: string, direction: ToggleDirection): string[] {
  const index = entries.findIndex((entry) => stripPrefix(entry).path === path)
  if (index === -1) throw new Error(`extension entry not found: ${path}`)
  const current = entries[index]!
  const { prefix } = stripPrefix(current)
  let next: string
  if (direction === 'disable') {
    next = `-${path}`
  } else if (prefix === '-' || prefix === '') {
    next = path
  } else {
    next = `+${path}`
  }
  if (next === current) return [...entries]
  const result = [...entries]
  result[index] = next
  return result
}

/**
 * Reorder the *managed* (unprefixed) entries; override entries stay at their current indices so a
 * user's manual disable flags never jump around.
 */
export function applyOrder(entries: readonly string[], paths: readonly string[]): string[] {
  const managedIndices: number[] = []
  const managedPaths: string[] = []
  entries.forEach((entry, index) => {
    const { prefix, path } = stripPrefix(entry)
    if (prefix === '') {
      managedIndices.push(index)
      managedPaths.push(path)
    }
  })
  const requested = [...paths]
  const sameSet =
    requested.length === managedPaths.length &&
    [...requested].sort().join('\u0000') === [...managedPaths].sort().join('\u0000')
  if (!sameSet) {
    throw new Error(
      `order must list exactly the ${managedPaths.length} unprefixed entries (got ${requested.length})`,
    )
  }
  const result = [...entries]
  managedIndices.forEach((index, position) => {
    result[index] = requested[position]!
  })
  return result
}

/** Human-readable before/after diff for the confirmation dialog. */
export function describeDiff(preview: WritePreview): string[] {
  const before = new Map<string, string>()
  preview.before.forEach((entry) => before.set(stripPrefix(entry).path, entry))
  const after = new Map<string, string>()
  preview.after.forEach((entry) => after.set(stripPrefix(entry).path, entry))
  const lines: string[] = []
  for (const [path, entry] of before) {
    const next = after.get(path)
    if (next === undefined) lines.push(`- removed: ${entry}`)
    else if (next !== entry) lines.push(`~ ${entry}  →  ${next}`)
  }
  for (const [path, entry] of after) if (!before.has(path)) lines.push(`+ added: ${entry}`)
  const beforeOrder = [...before.keys()].join(' | ')
  const afterOrder = [...after.keys()].join(' | ')
  if (beforeOrder !== afterOrder && lines.length === 0) lines.push('~ order changed')
  return lines
}