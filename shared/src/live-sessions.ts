export const LIVE_SESSION_PROTOCOL_VERSION = 2 as const
export const LIVE_SESSION_MAX_EVENT_BYTES = 8 * 1024 * 1024
export const LIVE_SESSION_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const LIVE_SESSION_MAX_COMMAND_BYTES = 8 * 1024 * 1024
export const LIVE_SESSION_MAX_BUFFER_BYTES = 16 * 1024 * 1024
export const LIVE_SESSION_MAX_PROMPT_BYTES = 128 * 1024
export const LIVE_SESSION_MAX_IMAGE_BYTES = 3 * 1024 * 1024
export const LIVE_SESSION_MAX_IMAGES = 4
export const LIVE_SESSION_MAX_IMAGE_TOTAL_BYTES = 6 * 1024 * 1024

export type LiveSessionMode = 'tui' | 'rpc'
export type LiveSessionStatus = 'idle' | 'running' | 'reconnecting'

export interface LiveSessionGroup {
  id: string
  name: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

/**
 * Browser-side organization metadata for a live Pi session (sidebar tags +
 * pin + the tmux session hosting a dashboard-started live Pi). Persisted
 * server-side keyed by pi `sessionId`; intentionally kept out of
 * {@link LiveSessionSummary} so the versioned live-session wire protocol is
 * untouched.
 */
export interface LiveSessionMeta {
  tags: string[]
  pinned: boolean
  /** Namespaced tmux session (`pi-dash-live-xxxxxxxx`) — terminal access path. */
  tmux?: string
  updatedAt: string
}

export interface LiveSessionSummary {
  processInstanceId: string
  sessionId: string
  role?: 'main' | 'subagent'
  parentSessionId?: string
  parentToolCallId?: string
  subagentWorkId?: string
  sessionFile?: string
  sessionName?: string
  pid: number
  cwd: string
  canonicalCwd: string
  mode: LiveSessionMode
  model?: { provider: string; id: string }
  thinkingLevel?: string
  status: LiveSessionStatus
  claim: {
    state: 'unclaimed' | 'claimed'
    leaseId?: string
    expiresAt?: number
  }
  startedAt: number
  lastActivityAt: number
  revision: number
  eventSequence: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
  /**
   * Additive, optional capability list advertised by the bridge. Absent = older
   * bridge. Adding values is backward compatible in both directions and does NOT
   * change {@link LIVE_SESSION_PROTOCOL_VERSION}.
   *
   * `session_tree` = the bridge registers the `/ls-navigate` and `/ls-fork`
   * extension commands. The dashboard must NOT send those commands without it:
   * pi falls back to submitting an unrecognized `/command` text as a normal model
   * prompt, which would pollute the conversation.
   */
  capabilities?: string[]
  git?: {
    root?: string
    branch?: string
  }
}

export interface LiveSessionHello {
  type: 'hello'
  protocolVersion: typeof LIVE_SESSION_PROTOCOL_VERSION
  brokerToken: string
  processInstanceId: string
  pid: number
  cwd: string
  mode: LiveSessionMode
  sessionId: string
}

export interface LiveSessionSnapshot {
  type: 'snapshot'
  processInstanceId: string
  revision: number
  sequence: number
  summary: LiveSessionSummary
  entries: unknown[]
}

export interface LiveSessionEventMessage {
  type: 'event'
  processInstanceId: string
  sequence: number
  event: {
    type: string
    data?: unknown
    [key: string]: unknown
  }
}

export interface LiveSessionCommandResult {
  type: 'command_result'
  requestId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export interface LiveSessionHeartbeat {
  type: 'heartbeat'
  processInstanceId: string
  at: number
}

export interface LiveSessionGoodbye {
  type: 'goodbye'
  processInstanceId: string
  reason: string
}

export type LiveSessionClientMessage =
  | LiveSessionHello
  | LiveSessionSnapshot
  | LiveSessionEventMessage
  | LiveSessionCommandResult
  | LiveSessionHeartbeat
  | LiveSessionGoodbye

/** Which input surface/channel a message was sent from; drives queue attribution and (later) per-channel routing. */
export type LiveSessionInputChannel = 'web' | 'terminal' | 'chatapp' | 'mobile'

export interface LiveSessionImage {
  type: 'image'
  data: string
  mimeType: string
}

export type LiveSessionCommand =
  | { type: 'resync' }
  | { type: 'claim'; browserClientId: string; requestedLeaseMs: number }
  | { type: 'renew'; leaseId: string }
  | { type: 'release'; leaseId: string }
  | {
      type: 'input'
      text: string
      images?: LiveSessionImage[]
      /** Input origin. Required so the shared queue never guesses attribution. */
      channel: LiveSessionInputChannel
      deliverAs?: 'steer' | 'followUp'
    }
  | { type: 'abort'; leaseId: string }
  | { type: 'set_session_name'; name: string }
  | { type: 'get_models' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'compact'; leaseId: string }
  | { type: 'reload' }
  | { type: 'feature_command'; leaseId: string; feature: 'btw'; command: { type: 'open' | 'close' } }
  | { type: 'answer_ui'; id: string; value?: string; cancelled?: boolean }

/** A pending extension UI request projected from a live session (L1 emits `extension_ui`). */
export interface LiveSessionUiRequest {
  id: string
  method: 'confirm' | 'select' | 'input' | 'editor'
  title: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
}

export interface LiveSessionCommandEnvelope {
  type: 'command'
  requestId: string
  processInstanceId: string
  command: LiveSessionCommand
}

export type LiveSessionServerMessage =
  | { type: 'welcome'; protocolVersion: typeof LIVE_SESSION_PROTOCOL_VERSION; heartbeatMs: number }
  | { type: 'reject'; code: string; message: string }
  | LiveSessionCommandEnvelope

export interface LiveSessionDetail {
  summary: LiveSessionSummary
  entries: unknown[]
}

export interface LiveSessionModelOption {
  provider: string
  id: string
  name: string
  reasoning: boolean
  contextWindow: number
  thinkingLevels: string[]
}

export type LiveSessionBrowserEventType =
  | 'live_session_attached'
  | 'live_session_snapshot'
  | 'live_session_event'
  | 'live_session_claim_changed'
  | 'live_session_reconnecting'
  | 'live_session_detached'
  | 'live_session_error'

export interface LiveSessionBrowserEvent {
  type: LiveSessionBrowserEventType
  data: unknown
}
