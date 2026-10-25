import type { LiveSessionSummary, LiveSessionUiRequest } from '@shared/live-sessions'

/**
 * One pending write a main-agent extension is waiting for the user to approve.
 *
 * The extension appends a compact `[supervisor-confirm]{…}` trailer to its UI request (pi's UI
 * request only carries text). That trailer is what lets the dashboard show the approval next to
 * the object it targets — task page, ledger page, sidebar badge — instead of covering the screen
 * with a modal that can push its own buttons out of view.
 */
export interface PendingConfirmation {
  processInstanceId: string
  sessionLabel?: string
  request: LiveSessionUiRequest
  /** Stable object uid from the extension, e.g. `task-journal:eu-fake-id-service`. */
  objectRef?: string
  operation?: string
  /** One-line description of what will be written. */
  summary?: string
  /** The request text with the machine-readable trailer removed, safe to show. */
  body: string
}

interface ConfirmationMarker {
  op?: string
  ref?: string
  sum?: string
}

const TRAILER = /^\[supervisor-confirm\]\s*(\{.*\})\s*$/

/** Separate the human-readable text from the extension's machine-readable trailer. */
export function splitConfirmationMarker(message: string | undefined): { marker?: ConfirmationMarker; body: string } {
  const lines = (message ?? '').split('\n')
  const index = lines.findIndex(line => TRAILER.test(line.trim()))
  if (index < 0) return { body: (message ?? '').trim() }
  const match = TRAILER.exec(lines[index].trim())
  let marker: ConfirmationMarker | undefined
  try {
    marker = match ? (JSON.parse(match[1]) as ConfirmationMarker) : undefined
  } catch {
    marker = undefined
  }
  const body = [...lines.slice(0, index), ...lines.slice(index + 1)].join('\n').trim()
  return { marker, body }
}

/**
 * Pending confirmations that name a target object, optionally narrowed to one object.
 *
 * Requests without a usable trailer are left to the modal fallback: there is nowhere to pin them,
 * and silently dropping them would let a write wait forever with nothing on screen.
 */
export function collectPendingConfirmations(
  pendingUi: Record<string, Record<string, LiveSessionUiRequest>>,
  sessions: Record<string, LiveSessionSummary>,
  objectRef?: string,
): PendingConfirmation[] {
  const found: PendingConfirmation[] = []
  for (const [processInstanceId, bucket] of Object.entries(pendingUi)) {
    const summary = sessions[processInstanceId]
    for (const request of Object.values(bucket ?? {})) {
      const { marker, body } = splitConfirmationMarker(request.message)
      if (!marker) continue
      if (objectRef !== undefined && marker.ref !== objectRef) continue
      found.push({
        processInstanceId,
        ...(summary ? { sessionLabel: summary.sessionName || `Pi ${summary.pid}` } : {}),
        request,
        ...(marker.ref ? { objectRef: marker.ref } : {}),
        ...(marker.op ? { operation: marker.op } : {}),
        ...(marker.sum ? { summary: marker.sum } : {}),
        body,
      })
    }
  }
  return found.sort((left, right) => (left.summary ?? left.body).localeCompare(right.summary ?? right.body))
}

/** True when the request carries a trailer, i.e. a page or the sidebar badge can carry it. */
export function hasConfirmationMarker(request: LiveSessionUiRequest): boolean {
  return splitConfirmationMarker(request.message).marker !== undefined
}