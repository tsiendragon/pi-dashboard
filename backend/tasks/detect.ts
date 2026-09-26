import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TasksConfig } from '@shared/tasks.js'

export function expandHome(p: string): string {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** A directory is a task journal when it carries the canonical index file. */
export function isJournalRoot(dir: string): boolean {
  try {
    return statSync(join(dir, 'tasks', 'DOMAINS.yaml')).isFile()
  } catch {
    return false
  }
}

/**
 * Candidates in priority order: configured roots → env override. Nothing is
 * hard-coded to a personal checkout; `autoDetect` callers pick the first root
 * that actually exists, so an unconfigured dashboard simply finds no journal.
 */
export function detectJournalRoots(journal: TasksConfig['journal']): { root: string; ok: boolean }[] {
  const candidates: string[] = []
  const push = (p?: string) => {
    if (!p) return
    const abs = expandHome(p)
    if (!candidates.includes(abs)) candidates.push(abs)
  }
  for (const root of journal.roots) push(root)
  push(process.env.PI_TASK_JOURNAL_ROOT)
  return candidates.map(root => ({ root, ok: isJournalRoot(root) }))
}
