import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export class SessionDiscardError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SessionDiscardError'
  }
}

interface SessionRecord extends Record<string, unknown> {
  type: string
  id?: string
  parentId?: string | null
}

export interface PreparedSessionDiscard {
  readonly sessionFile: string
  readonly stagedFile: string
  readonly sourceHash: string
  readonly entryId: string
  readonly deletedEntries: number
  readonly removedEntries: number
}

/**
 * Stage an in-place rewind of the current branch after a user message.
 * prepare never changes the source file; the caller must stop Pi before commit.
 */
export function prepareSessionDiscard(sessionFile: string, entryId: string): PreparedSessionDiscard {
  return prepareSessionRewrite(sessionFile, entryId, false)
}

/** Remove the latest user message and its descendants, resuming at its parent. */
export function prepareSessionWithdrawal(sessionFile: string, entryId: string): PreparedSessionDiscard {
  return prepareSessionRewrite(sessionFile, entryId, true)
}

function prepareSessionRewrite(sessionFile: string, entryId: string, removeSelected: boolean): PreparedSessionDiscard {
  if (!entryId.trim()) throw new SessionDiscardError('invalid_entry_id', 'entryId is required')
  let fileMode: number
  let source: Buffer
  try {
    const stat = lstatSync(sessionFile)
    if (!stat.isFile()) throw new SessionDiscardError('session_file_invalid', 'session file must be a regular file')
    fileMode = stat.mode & 0o777
    source = readFileSync(sessionFile)
  } catch (error) {
    if (error instanceof SessionDiscardError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new SessionDiscardError('session_file_not_found', 'session file does not exist')
    throw error
  }

  const lines = source.toString('utf8').split(/\r?\n/).filter(line => line.trim().length > 0)
  let records: SessionRecord[]
  try {
    records = lines.map(line => JSON.parse(line) as SessionRecord)
  } catch (error) {
    throw new SessionDiscardError('session_file_invalid', `session file contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const header = records[0]
  if (!header || header.type !== 'session' || records.slice(1).some(record => record.type === 'session')) {
    throw new SessionDiscardError('session_file_invalid', 'session file has an invalid header')
  }
  const entries = records.slice(1)
  const byId = new Map<string, SessionRecord>()
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || !entry.id || byId.has(entry.id)) {
      throw new SessionDiscardError('session_file_invalid', 'session entries must have unique ids')
    }
    byId.set(entry.id, entry)
  }

  const target = byId.get(entryId)
  if (!target) throw new SessionDiscardError('session_entry_not_found', `entry ${entryId} was not found`)
  const message = target.type === 'message' && target.message && typeof target.message === 'object'
    ? target.message as Record<string, unknown> : undefined
  if (message?.role !== 'user') {
    throw new SessionDiscardError('entry_not_user_message', 'discard can only start at a user message')
  }

  const activeIds = new Set<string>()
  const activeBranch: SessionRecord[] = []
  let cursor = entries.at(-1)
  while (cursor) {
    if (!cursor.id || activeIds.has(cursor.id)) throw new SessionDiscardError('session_file_invalid', 'session branch contains a cycle')
    activeIds.add(cursor.id)
    activeBranch.push(cursor)
    if (cursor.parentId == null) break
    if (typeof cursor.parentId !== 'string') throw new SessionDiscardError('session_file_invalid', 'session entry has an invalid parent id')
    cursor = byId.get(cursor.parentId)
    if (!cursor) throw new SessionDiscardError('session_file_invalid', 'session branch references a missing parent')
  }
  if (!activeIds.has(entryId)) {
    throw new SessionDiscardError('entry_not_on_active_branch', 'the selected user message is no longer on the active branch; refresh and try again')
  }
  if (removeSelected) {
    const latestUser = activeBranch.find(record => {
      const content = record.type === 'message' && record.message && typeof record.message === 'object'
        ? record.message as Record<string, unknown> : undefined
      return content?.role === 'user'
    })
    if (latestUser?.id !== entryId) {
      throw new SessionDiscardError('not_latest_user_message', 'only the latest user message on the active branch can be withdrawn')
    }
  }

  const children = new Map<string, SessionRecord[]>()
  for (const entry of entries) {
    if (typeof entry.parentId !== 'string') continue
    const siblings = children.get(entry.parentId) ?? []
    siblings.push(entry)
    children.set(entry.parentId, siblings)
  }
  const discardedIds = new Set<string>([entryId])
  const queue = [entryId]
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (child.id && !discardedIds.has(child.id)) {
        discardedIds.add(child.id)
        queue.push(child.id)
      }
    }
  }
  const deletedEntries = discardedIds.size - 1
  if (!removeSelected && deletedEntries === 0) {
    throw new SessionDiscardError('nothing_to_discard', 'there are no later entries after this user message')
  }

  const retained = entries.filter(entry => !discardedIds.has(entry.id ?? ''))
  if (removeSelected) {
    if (typeof target.parentId === 'string') {
      const parent = byId.get(target.parentId)
      if (!parent) throw new SessionDiscardError('session_file_invalid', 'session branch references a missing parent')
      const parentIndex = retained.findIndex(entry => entry.id === parent.id)
      if (parentIndex >= 0) retained.splice(parentIndex, 1)
      retained.push(parent)
    } else if (retained.length > 0) {
      throw new SessionDiscardError('rewind_root_has_other_branches', 'cannot withdraw a root message while other session branches exist')
    }
  } else {
    // Keep earlier alternate branches, then put the selected message last so Pi
    // resumes from it without rerunning the original user prompt.
    retained.push(target)
  }
  const stagedContent = `${[header, ...retained].map(record => JSON.stringify(record)).join('\n')}\n`
  const stagedFile = path.join(path.dirname(sessionFile), `.${path.basename(sessionFile)}.discard-${randomUUID()}.tmp`)
  try {
    writeFileSync(stagedFile, stagedContent, { flag: 'wx', mode: fileMode })
  } catch (error) {
    rmSync(stagedFile, { force: true })
    throw error
  }

  return {
    sessionFile,
    stagedFile,
    sourceHash: createHash('sha256').update(source).digest('hex'),
    entryId,
    deletedEntries,
    removedEntries: removeSelected ? discardedIds.size : deletedEntries,
  }
}

/** Atomically replace the session only if it has not changed since staging. */
export function commitSessionDiscard(plan: PreparedSessionDiscard): void {
  const current = readFileSync(plan.sessionFile)
  const currentHash = createHash('sha256').update(current).digest('hex')
  if (currentHash !== plan.sourceHash) {
    throw new SessionDiscardError('session_changed', 'session file changed before discard; no history was removed')
  }
  renameSync(plan.stagedFile, plan.sessionFile)
}

export function cleanupSessionDiscard(plan: PreparedSessionDiscard): void {
  rmSync(plan.stagedFile, { force: true })
}
