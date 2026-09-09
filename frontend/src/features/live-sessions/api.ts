import type { LiveSessionCommand, LiveSessionDetail, LiveSessionGroup, LiveSessionSummary } from '@shared/live-sessions'

export class LiveSessionApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'LiveSessionApiError'
  }
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new LiveSessionApiError(
      response.status,
      typeof body.error === 'string' ? body.error : 'live_session_request_failed',
      typeof body.message === 'string' ? body.message : `HTTP ${response.status}`,
    )
  }
  return body as T
}

function post<T>(path: string, body: unknown): Promise<T> {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json<T>)
}

export const liveSessionApi = {
  authenticate: (token: string) => post<{ ok: true; browserClientId: string }>('/api/live-sessions/auth', { token }),
  start: (input: { cwd: string; model?: string; thinkingLevel?: string; title?: string }) => post<{ ok: true; result: { slotKey: string; cwd: string; title: string } }>('/api/live-sessions/start', input)
    .then(result => result.result),
  list: () => fetch('/api/live-sessions', { credentials: 'same-origin' })
    .then(json<{ sessions: LiveSessionSummary[]; browserClientId?: string }>),
  listGroups: () => fetch('/api/live-session-groups', { credentials: 'same-origin' })
    .then(json<{ groups: LiveSessionGroup[] }>)
    .then(result => result.groups),
  createGroup: (name: string) => post<{ ok: true; groups: LiveSessionGroup[] }>('/api/live-session-groups', { name })
    .then(result => result.groups),
  renameGroup: (groupId: string, name: string) => fetch(`/api/live-session-groups/${encodeURIComponent(groupId)}`, {
    method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }).then(json<{ ok: true; groups: LiveSessionGroup[] }>).then(result => result.groups),
  deleteGroup: (groupId: string) => fetch(`/api/live-session-groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
  }).then(json<{ ok: true; groups: LiveSessionGroup[] }>).then(result => result.groups),
  addGroupMember: (groupId: string, processInstanceId: string) => post<{ ok: true; groups: LiveSessionGroup[] }>(
    `/api/live-session-groups/${encodeURIComponent(groupId)}/members`, { processInstanceId },
  ).then(result => result.groups),
  removeGroupMember: (groupId: string, sessionId: string) => fetch(`/api/live-session-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
  }).then(json<{ ok: true; groups: LiveSessionGroup[] }>).then(result => result.groups),
  detail: (processInstanceId: string) => fetch(`/api/live-sessions/${encodeURIComponent(processInstanceId)}`, { credentials: 'same-origin' })
    .then(json<LiveSessionDetail>),
  claim: (processInstanceId: string, requestedLeaseMs = 30_000) => post<{ ok: true; result: { leaseId: string; expiresAt?: number } }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/claim`, { requestedLeaseMs },
  ),
  renew: (processInstanceId: string, leaseId: string) => post<{ ok: true; result: { leaseId: string; expiresAt?: number } }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/renew`, { leaseId },
  ),
  release: (processInstanceId: string, leaseId: string) => post<{ ok: true; result: unknown }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/release`, { leaseId },
  ),
  command: (processInstanceId: string, command: Extract<LiveSessionCommand, { type: 'prompt' | 'abort' | 'feature_command' }>) => post<{ ok: true; result: unknown }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/commands`, { command },
  ),
}
