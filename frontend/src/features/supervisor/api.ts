import type { LiveSessionDetail } from '../../../../shared/src/live-sessions'
import type { SupervisorAttachment, SupervisorConfig, SupervisorRequest, SupervisorState } from '../../../../shared/src/supervisor'

export class SupervisorApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'SupervisorApiError' }
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api/supervisor' + path, {
    ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  if (!response.ok) {
    const body = await response.text()
    let message = body
    try { const error = JSON.parse(body); message = error.message || error.error || body } catch { /* Non-JSON HTTP error. */ }
    throw new SupervisorApiError(response.status, typeof message === 'string' && message ? message : response.statusText)
  }
  return response.json() as Promise<T>
}
const post = <T,>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
export interface SupervisorImage { type: 'image'; mimeType: string; data: string }
export const supervisorApi = {
  state: (signal?: AbortSignal) => request<SupervisorState>('/state', { signal }),
  config: (signal?: AbortSignal) => request<SupervisorConfig | null>('/config', { signal }),
  configure: (config: SupervisorConfig) => request<SupervisorConfig>('/config', { method: 'PUT', body: JSON.stringify({ config }) }),
  clear: () => post<{ processInstanceId: string; sessionId: string }>('/agent/clear'),
  start: () => post<{ processInstanceId: string; sessionId: string }>('/agent/start'),
  input: (body: { text: string; images?: SupervisorImage[]; attachmentIds?: string[]; objectRef?: string }) => post<{ ok: true }>('/agent/input', body),
  detail: (signal?: AbortSignal) => request<LiveSessionDetail>('/agent/detail', { signal }),
  execute: <T,>(body: SupervisorRequest, signal?: AbortSignal) => request<{ result: T }>('/execute', { method: 'POST', body: JSON.stringify(body), signal }).then(response => response.result),
  upload: (body: { name: string; mime: string; data: string }) => post<{ attachment: SupervisorAttachment }>('/attachments', body).then(response => response.attachment),
  attachmentUrl: (id: string) => '/api/supervisor/attachments/' + encodeURIComponent(id),
}
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof SupervisorApiError && error.status === 401) return '需要认证：' + message
  if (error instanceof SupervisorApiError && error.status === 403) {
    if (message === 'supervisor_disabled') return '监督服务未启用：请先在监督台启用观察模式，再启动主 Agent 会话。'
    if (message === 'use_primary_agent_entry') return '该操作只能通过主 Agent 入口进行。'
    if (message === 'protected_supervisor_archive') return '监督档案请通过监督页面接口访问。'
    return '权限或授权范围不足：' + message
  }
  return message
}
