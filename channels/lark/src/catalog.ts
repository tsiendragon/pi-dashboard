import type { LiveSessionSummary } from '../../../shared/src/live-sessions.js'

/** Stable, human-meaningful identifier for a live session. */
export function refOf(summary: LiveSessionSummary): string {
  return summary.sessionFile || summary.sessionName || summary.processInstanceId
}

/**
 * Live-session directory.
 *
 * Bindings must not depend on `processInstanceId` (it changes when pi
 * restarts), so this keeps summaries addressable by the stable `sessionFile`
 * (and `sessionName`), while still resolving to the current processInstanceId
 * for sending commands.
 */
export class Catalog {
  private readonly byProcessId = new Map<string, LiveSessionSummary>()

  upsert(summary: LiveSessionSummary): void {
    this.byProcessId.set(summary.processInstanceId, summary)
  }

  remove(processInstanceId: string): void {
    this.byProcessId.delete(processInstanceId)
  }

  findByProcessId(processInstanceId: string): LiveSessionSummary | undefined {
    return this.byProcessId.get(processInstanceId)
  }

  list(): LiveSessionSummary[] {
    return [...this.byProcessId.values()].sort(
      (a, b) => a.startedAt - b.startedAt || a.processInstanceId.localeCompare(b.processInstanceId),
    )
  }

  /** Resolve by index (1-based, as shown in /list), sessionFile, sessionName or processInstanceId. */
  resolve(ref: string): LiveSessionSummary | undefined {
    const trimmed = ref.trim()
    if (!trimmed) return undefined
    if (/^\d+$/.test(trimmed)) {
      const index = Number.parseInt(trimmed, 10) - 1
      const sessions = this.list()
      return sessions[index]
    }
    for (const summary of this.byProcessId.values()) {
      if (summary.sessionFile === trimmed || summary.sessionName === trimmed || summary.processInstanceId === trimmed) {
        return summary
      }
    }
    return undefined
  }

  /** Find the currently-attached session whose stable file matches a binding. */
  resolveBinding(sessionFile: string): LiveSessionSummary | undefined {
    for (const summary of this.byProcessId.values()) if (summary.sessionFile === sessionFile) return summary
    return undefined
  }
}
