import type { SessionRef, TaskFact } from '@shared/tasks.js'

export interface LiveSessionInput {
  sessionId: string
  processInstanceId: string
  cwd: string
  title?: string
  tags: string[]
}

function toRef(s: LiveSessionInput, live: boolean): SessionRef {
  return {
    sessionId: s.sessionId,
    processInstanceId: s.processInstanceId,
    cwd: s.cwd,
    title: s.title,
    tags: s.tags,
    live,
  }
}

function underPath(cwd: string, base: string): boolean {
  if (!cwd || !base) return false
  if (cwd === base) return true
  const prefix = base.endsWith('/') ? base : `${base}/`
  return cwd.startsWith(prefix)
}

/**
 * Attach live sessions to tasks.
 *
 * Priority: cwd prefix (physical fact, longest prefix wins ⇒ only the most
 * specific task gets it) > session tag == task id > manual planning.sessionIds.
 * Returns a side structure keyed by uid; never mutates TaskFact.
 */
export function linkSessions(
  tasks: TaskFact[],
  live: LiveSessionInput[],
  manual: Record<string, string[]>,
): Record<string, SessionRef[]> {
  const refs: Record<string, SessionRef[]> = {}
  const seen = new Map<string, Set<string>>()

  const add = (uid: string, ref: SessionRef) => {
    const set = seen.get(uid) ?? new Set<string>()
    if (set.has(ref.sessionId)) return
    set.add(ref.sessionId)
    seen.set(uid, set)
    ;(refs[uid] ??= []).push(ref)
  }

  // cwd prefix — longest task.path first so the most specific wins.
  const byPath = tasks
    .filter(t => t.path)
    .map(t => ({ uid: t.uid, path: t.path as string }))
    .sort((a, b) => b.path.length - a.path.length)
  for (const s of live) {
    const match = byPath.find(t => underPath(s.cwd, t.path))
    if (match) add(match.uid, toRef(s, true))
  }

  // session tag contains task id (lowercased).
  const uidById = new Map<string, string>()
  for (const t of tasks) if (t.plannable) uidById.set(t.id.toLowerCase(), t.uid)
  for (const s of live) {
    for (const tag of s.tags) {
      const uid = uidById.get(tag.toLowerCase())
      if (uid) add(uid, toRef(s, true))
    }
  }

  // manual associations from the planning layer.
  const liveById = new Map(live.map(s => [s.sessionId, s]))
  for (const [uid, ids] of Object.entries(manual)) {
    for (const id of ids) {
      const s = liveById.get(id)
      if (s) add(uid, toRef(s, true))
      else add(uid, { sessionId: id, processInstanceId: '', cwd: '', tags: [], live: false })
    }
  }

  return refs
}
