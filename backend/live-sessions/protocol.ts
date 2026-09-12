import {
  LIVE_SESSION_MAX_COMMAND_BYTES,
  LIVE_SESSION_MAX_IMAGE_BYTES,
  LIVE_SESSION_MAX_IMAGES,
  LIVE_SESSION_MAX_IMAGE_TOTAL_BYTES,
  LIVE_SESSION_MAX_PROMPT_BYTES,
  LIVE_SESSION_PROTOCOL_VERSION,
  type LiveSessionCommand,
  type LiveSessionCommandResult,
  type LiveSessionEventMessage,
  type LiveSessionGoodbye,
  type LiveSessionHeartbeat,
  type LiveSessionImage,
  type LiveSessionHello,
  type LiveSessionSnapshot,
  type LiveSessionSummary,
} from '../../shared/src/live-sessions.js'

export class LiveSessionProtocolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'LiveSessionProtocolError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function finiteInteger(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
}

function nonEmptyString(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function parseImages(value: unknown): LiveSessionImage[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > LIVE_SESSION_MAX_IMAGES) return undefined
  let totalBytes = 0
  const images: LiveSessionImage[] = []
  for (const item of value) {
    if (!record(item) || !onlyKeys(item, ['type', 'data', 'mimeType']) || item.type !== 'image'
      || !nonEmptyString(item.data, LIVE_SESSION_MAX_IMAGE_BYTES)
      || typeof item.mimeType !== 'string'
      || !/^image\/[a-z0-9.+-]+$/i.test(item.mimeType)
      || Buffer.byteLength(item.data, 'utf8') > LIVE_SESSION_MAX_IMAGE_BYTES) return undefined
    totalBytes += Buffer.byteLength(item.data, 'utf8')
    if (totalBytes > LIVE_SESSION_MAX_IMAGE_TOTAL_BYTES) return undefined
    images.push({ type: 'image', data: item.data, mimeType: item.mimeType })
  }
  return images
}

export function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    throw new LiveSessionProtocolError('invalid_json', 'message must be JSON serializable')
  }
}

export function parseJsonLine(line: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(line) } catch {
    throw new LiveSessionProtocolError('invalid_json', 'invalid JSONL message')
  }
  if (!record(value)) throw new LiveSessionProtocolError('invalid_message', 'message must be an object')
  return value
}

export function parseHello(value: unknown): LiveSessionHello {
  if (!record(value) || value.type !== 'hello') throw new LiveSessionProtocolError('hello_required', 'hello must be the first message')
  if (!onlyKeys(value, ['type', 'protocolVersion', 'brokerToken', 'processInstanceId', 'pid', 'cwd', 'mode', 'sessionId'])) {
    throw new LiveSessionProtocolError('invalid_hello', 'hello contains unknown fields')
  }
  if (value.protocolVersion !== LIVE_SESSION_PROTOCOL_VERSION) throw new LiveSessionProtocolError('unsupported_protocol', 'unsupported protocol version')
  if (!nonEmptyString(value.brokerToken, 512)) throw new LiveSessionProtocolError('invalid_token', 'broker token is required')
  if (!nonEmptyString(value.processInstanceId, 256)) throw new LiveSessionProtocolError('invalid_hello', 'processInstanceId is required')
  if (!finiteInteger(value.pid, 1)) throw new LiveSessionProtocolError('invalid_hello', 'pid must be a positive integer')
  if (!nonEmptyString(value.cwd, 16 * 1024)) throw new LiveSessionProtocolError('invalid_hello', 'cwd is required')
  if (value.mode !== 'tui' && value.mode !== 'rpc') throw new LiveSessionProtocolError('invalid_hello', 'mode must be tui or rpc')
  if (!nonEmptyString(value.sessionId, 4096)) throw new LiveSessionProtocolError('invalid_hello', 'sessionId is required')
  return value as unknown as LiveSessionHello
}

function validateSummary(value: unknown): value is LiveSessionSummary {
  if (!record(value)) return false
  if (!nonEmptyString(value.processInstanceId, 256) || !nonEmptyString(value.sessionId, 4096)) return false
  if (!finiteInteger(value.pid, 1) || !nonEmptyString(value.cwd, 16 * 1024)) return false
  if (typeof value.canonicalCwd !== 'string') return false
  if (value.mode !== 'tui' && value.mode !== 'rpc') return false
  if (value.status !== 'idle' && value.status !== 'running' && value.status !== 'reconnecting') return false
  if (!finiteInteger(value.startedAt) || !finiteInteger(value.lastActivityAt) || !finiteInteger(value.revision) || !finiteInteger(value.eventSequence)) return false
  if (!record(value.claim) || (value.claim.state !== 'unclaimed' && value.claim.state !== 'claimed')) return false
  if (value.claim.leaseId !== undefined && !nonEmptyString(value.claim.leaseId, 512)) return false
  if (value.claim.expiresAt !== undefined && !finiteInteger(value.claim.expiresAt)) return false
  if (value.model !== undefined && (!record(value.model) || !nonEmptyString(value.model.provider, 512) || !nonEmptyString(value.model.id, 1024))) return false
  return true
}

export function parseSnapshot(value: unknown): LiveSessionSnapshot {
  if (!record(value) || value.type !== 'snapshot') throw new LiveSessionProtocolError('invalid_snapshot', 'snapshot message required')
  if (!nonEmptyString(value.processInstanceId, 256) || !finiteInteger(value.revision) || !finiteInteger(value.sequence)) {
    throw new LiveSessionProtocolError('invalid_snapshot', 'invalid snapshot identity')
  }
  if (!validateSummary(value.summary) || !Array.isArray(value.entries)) throw new LiveSessionProtocolError('invalid_snapshot', 'invalid snapshot payload')
  return value as unknown as LiveSessionSnapshot
}

export function parseEvent(value: unknown): LiveSessionEventMessage {
  if (!record(value) || value.type !== 'event') throw new LiveSessionProtocolError('invalid_event', 'event message required')
  if (!nonEmptyString(value.processInstanceId, 256) || !finiteInteger(value.sequence) || !record(value.event) || !nonEmptyString(value.event.type, 256)) {
    throw new LiveSessionProtocolError('invalid_event', 'invalid event payload')
  }
  return value as unknown as LiveSessionEventMessage
}

export function parseCommandResult(value: unknown): LiveSessionCommandResult {
  if (!record(value) || value.type !== 'command_result' || !nonEmptyString(value.requestId, 256) || typeof value.ok !== 'boolean') {
    throw new LiveSessionProtocolError('invalid_command_result', 'invalid command result')
  }
  if (!value.ok && (!record(value.error) || !nonEmptyString(value.error.code, 256) || !nonEmptyString(value.error.message, 4096))) {
    throw new LiveSessionProtocolError('invalid_command_result', 'failed command result requires an error')
  }
  return value as unknown as LiveSessionCommandResult
}

export function parseHeartbeat(value: unknown): LiveSessionHeartbeat {
  if (!record(value) || value.type !== 'heartbeat' || !nonEmptyString(value.processInstanceId, 256) || !finiteInteger(value.at)) {
    throw new LiveSessionProtocolError('invalid_heartbeat', 'invalid heartbeat')
  }
  return value as unknown as LiveSessionHeartbeat
}

export function parseGoodbye(value: unknown): LiveSessionGoodbye {
  if (!record(value) || value.type !== 'goodbye' || !nonEmptyString(value.processInstanceId, 256) || !nonEmptyString(value.reason, 1024)) {
    throw new LiveSessionProtocolError('invalid_goodbye', 'invalid goodbye')
  }
  return value as unknown as LiveSessionGoodbye
}

export function validateLiveSessionCommand(value: unknown, browserOnly = false): LiveSessionCommand {
  if (!record(value) || !nonEmptyString(value.type, 64)) throw new LiveSessionProtocolError('invalid_command', 'command type is required')
  if (jsonBytes(value) > LIVE_SESSION_MAX_COMMAND_BYTES) throw new LiveSessionProtocolError('command_too_large', 'command exceeds 8 MiB')
  if (browserOnly && value.type !== 'input' && value.type !== 'abort' && value.type !== 'set_session_name' && value.type !== 'get_models' && value.type !== 'feature_command') {
    throw new LiveSessionProtocolError('unsupported_command', 'browser command must be input, abort, set_session_name, get_models, or feature_command')
  }
  switch (value.type) {
    case 'resync':
      if (onlyKeys(value, ['type'])) return value as { type: 'resync' }
      break
    case 'claim':
      if (onlyKeys(value, ['type', 'browserClientId', 'requestedLeaseMs']) && nonEmptyString(value.browserClientId, 256) && finiteInteger(value.requestedLeaseMs, 10_000) && value.requestedLeaseMs <= 120_000) return value as unknown as LiveSessionCommand
      break
    case 'renew':
    case 'release':
    case 'abort':
      if (onlyKeys(value, ['type', 'leaseId']) && nonEmptyString(value.leaseId, 512)) return value as unknown as LiveSessionCommand
      break
    case 'set_session_name':
      if (onlyKeys(value, ['type', 'name']) && nonEmptyString(value.name, 160)) return value as unknown as LiveSessionCommand
      break
    case 'get_models':
      if (onlyKeys(value, ['type'])) return value as unknown as LiveSessionCommand
      break
    case 'feature_command': {
      if (!onlyKeys(value, ['type', 'leaseId', 'feature', 'command'])) break
      if (!nonEmptyString(value.leaseId, 512) || value.feature !== 'btw' || !record(value.command)
        || !onlyKeys(value.command, ['type']) || (value.command.type !== 'open' && value.command.type !== 'close')) break
      return value as unknown as LiveSessionCommand
    }
    case 'input': {
      if (!onlyKeys(value, ['type', 'text', 'channel', 'deliverAs', 'images'])) break
      const hasImages = Object.hasOwn(value, 'images')
      const images = parseImages(value.images)
      if ((hasImages && !images) || typeof value.text !== 'string' || Buffer.byteLength(value.text, 'utf8') > LIVE_SESSION_MAX_PROMPT_BYTES || (!value.text.trim() && !images?.length)) break
      if (value.deliverAs !== undefined && value.deliverAs !== 'steer' && value.deliverAs !== 'followUp') break
      if (value.channel !== 'web' && value.channel !== 'terminal' && value.channel !== 'chatapp' && value.channel !== 'mobile') break
      return { ...value, ...(images ? { images } : {}) } as LiveSessionCommand
    }
  }
  throw new LiveSessionProtocolError('invalid_command', `invalid or unsupported ${String(value.type)} command`)
}
