import { existsSync, writeFileSync } from 'node:fs'
import { SessionManager } from '@earendil-works/pi-coding-agent'

/** A fork request the session file itself rejected (bad entry id, unreadable file…). */
export class SessionForkError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SessionForkError'
  }
}

/**
 * Extract the root→`entryId` branch of `sessionFile` into a NEW session file and
 * return its path. The source file is never modified.
 *
 * pi's `SessionManager.createBranchedSession` only writes the new file right away
 * when the branch already ends in an assistant message; otherwise it defers the
 * write to the first reply (same contract as `newSession()`). The dashboard
 * launches a fresh Pi **on** that file, so a deferred file would not exist yet.
 * When that happens the file is written here from the manager's own entries —
 * the exact bytes `_rewriteFile()` would produce, no re-parsing.
 */
export function createBranchedSessionFile(sessionFile: string, entryId: string): string {
  if (!entryId) throw new SessionForkError('invalid_entry_id', 'entryId is required')
  if (!existsSync(sessionFile)) throw new SessionForkError('session_file_not_found', `session file does not exist: ${sessionFile}`)

  const manager = SessionManager.open(sessionFile)
  let branched: string | undefined
  try {
    branched = manager.createBranchedSession(entryId)
  } catch (error) {
    throw new SessionForkError('session_entry_not_found', error instanceof Error ? error.message : String(error))
  }
  if (!branched) throw new SessionForkError('live_pi_start_failed', 'pi could not create a branched session file')

  if (!existsSync(branched)) {
    const header = manager.getHeader()
    const entries = manager.getEntries()
    const lines = [...(header ? [header] : []), ...entries].map(entry => JSON.stringify(entry))
    writeFileSync(branched, lines.length ? `${lines.join('\n')}\n` : '')
  }
  return branched
}