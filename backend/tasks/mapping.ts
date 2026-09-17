import type { Completion } from '@shared/tasks.js'

/**
 * Upstream → normalized completion. Recognized values map cleanly (no raw kept);
 * anything else falls back to `todo` and keeps the original text in `completionRaw`.
 *
 * Real journal values seen in the wild: to_do, in_progress, done, paused, active,
 * archived, and free-text like `Feasibility`.
 */
const COMPLETION_MAP: Record<string, Completion> = {
  to_do: 'todo', todo: 'todo', open: 'todo', pending: 'todo', backlog: 'todo', planned: 'todo',
  in_progress: 'doing', doing: 'doing', active: 'doing', wip: 'doing', started: 'doing',
  done: 'done', complete: 'done', completed: 'done', closed: 'done', archived: 'done',
  paused: 'paused', blocked: 'paused', on_hold: 'paused', suspended: 'paused',
}

export function mapCompletion(raw: unknown): { completion: Completion; completionRaw?: string } {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return { completion: 'todo' }
  const key = s.toLowerCase().replace(/[\s-]+/g, '_')
  const mapped = COMPLETION_MAP[key]
  if (mapped) return { completion: mapped }
  return { completion: 'todo', completionRaw: s }
}
