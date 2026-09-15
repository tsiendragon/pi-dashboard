import type { LiveSessionCommand, LiveSessionDetail, LiveSessionGroup, LiveSessionMeta, LiveSessionModelOption, LiveSessionSummary } from '@shared/live-sessions'

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
  websocketTicket: () => post<{ ok: true; result: { ticket: string; expiresAt: number } }>('/api/live-sessions/ws-ticket', {})
    .then(result => result.result),
  start: (input: { cwd: string; model?: string; thinkingLevel?: string; title?: string }) => post<{ ok: true; result: { slotKey: string; cwd: string; title: string } }>('/api/live-sessions/start', input)
    .then(result => result.result),
  rename: (processInstanceId: string, name: string) => post<{ ok: true; result: unknown }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/commands`, { command: { type: 'set_session_name', name } },
  ).then(result => result.result),
  list: () => fetch('/api/live-sessions', { credentials: 'same-origin' })
    .then(json<{ sessions: LiveSessionSummary[]; browserClientId?: string }>),
  listMeta: () => fetch('/api/live-session-meta', { credentials: 'same-origin' })
    .then(json<{ meta: Record<string, LiveSessionMeta> }>).then(result => result.meta),
  patchMeta: (processInstanceId: string, patch: { tags?: string[]; pinned?: boolean }) => fetch(`/api/live-sessions/${encodeURIComponent(processInstanceId)}/meta`, {
    method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }).then(json<{ ok: true; meta: LiveSessionMeta; all: Record<string, LiveSessionMeta> }>).then(result => result.all),
  listOrder: () => fetch('/api/live-session-order', { credentials: 'same-origin' })
    .then(json<{ order?: string[] }>).then(result => Array.isArray(result.order) ? result.order : []),
  saveOrder: (order: string[]) => fetch('/api/live-session-order', {
    method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order }),
  }).then(json<{ ok: true; order?: string[] }>).then(result => Array.isArray(result.order) ? result.order : []),
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
  models: (processInstanceId: string) => post<{ ok: true; result: { models: LiveSessionModelOption[] } }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/commands`, { command: { type: 'get_models' } },
  ).then(result => result.result.models),
  command: (processInstanceId: string, command: Extract<LiveSessionCommand, { type: 'input' | 'abort' | 'set_session_name' | 'get_models' | 'set_model' | 'compact' | 'reload' | 'feature_command' | 'answer_ui' }>) => post<{ ok: true; result: unknown }>(
    `/api/live-sessions/${encodeURIComponent(processInstanceId)}/commands`, { command },
  ),
  /** Close a tmux-first live session: kills the tmux session hosting its Pi. */
  closeTmuxSession: (tmuxSession: string) => fetch(`/api/pty/sessions/${encodeURIComponent(tmuxSession)}`, {
    method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
  }).then(json<{ ok: true }>),
}
