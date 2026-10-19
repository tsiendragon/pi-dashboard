/**
 * Session persistence and JSONL parser for pi sessions.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const HOME: string = homedir()
const SESSIONS_DIR: string = join(HOME, '.pi', 'agent', 'sessions')
const STATE_FILE: string = join(HOME, '.pi', 'agent', 'pi-web-sessions.json')

// ── Types ──

import type { ChatMessage } from '@shared/types.js'
export type { ChatMessage } from '@shared/types.js'
import type { PiTransport } from './pi-session.js'

export interface SlotState {
  key: string
  title: string
  messages?: ChatMessage[]
  sessionFile: string | null
  modelProvider: string | null
  modelId: string | null
  thinkingLevel?: string | null
  cwd: string | null
  tags?: string[]
  // Sidebar pin (slice: sidebar-refresh). Absent/false → unpinned. Pinned slots
  // render in a leading "Pinned" group regardless of the chosen group mode.
  pinned?: boolean
  // Transport backend for this slot ('rpc' | 'sdk'). Absent in old state →
  // restore defaults to 'rpc' (see pi-manager restoreSlot).
  transport?: PiTransport
  // Permission-gating flag (slice 11). Absent/false → tool calls run ungated
  // (default OFF). SDK-only at runtime; persisted for all slots for parity.
  toolApproval?: boolean
  // Crash-recovery (slice 8): true when the slot had a turn in progress at
  // persist time. On the crash path (uncaughtException/unhandledRejection
  // backstop runs saveSlotStateSync), this marks slots whose in-flight turn was
  // interrupted so boot can surface a resume offer. Absent/false → idle slot.
  midTurn?: boolean
}

export interface SessionTreeEntry {
  id: string | null
  parentId: string | null
  type: string
  timestamp?: string
  role?: string
  text?: string
  fullText?: string
  tools?: string[]
}

/** Duck-typed interface for PiProcess slots (avoids circular deps) */
interface SlotProcess {
  _title?: string
  _tags?: string[]
  _pinned?: boolean
  messages: ChatMessage[]
  sessionFile?: string | null
  modelProvider?: string | null
  modelId?: string | null
  thinkingLevel?: string | null
  cwd?: string | null
  transport?: PiTransport
  toolApproval?: boolean
  running?: boolean
}

type ContentPart = { type: string; text?: string; thinking?: string }

// ── Parse a pi session JSONL into chat messages ──

/**
 * Incremental line parser for pi session transcripts.
 *
 * Feed JSONL lines oldest-first. The history pager (session-history.ts)
 * drives this parser over a bounded window of lines so a partial read
 * produces the same message sequence as a full-file parse. toolResult lines
 * merge into the most recent matching tool message; when the matching
 * toolCall falls outside the fed window the result surfaces as a standalone
 * tool message (same fallback as a truncated transcript).
 */
export interface SessionLineParser {
  readonly messages: ChatMessage[]
  feed(line: string): void
}

export function createSessionLineParser(): SessionLineParser {
  const messages: ChatMessage[] = []
  function feed(line: string): void {
    if (!line.trim()) return
    try {
      const obj = JSON.parse(line)
      if (obj.type !== 'message') return
      const msg = obj.message
      if (!msg) return
      const role: string = msg.role
      const ts: string | undefined = msg.timestamp ? new Date(msg.timestamp).toISOString() : undefined

      if (role === 'user') {
        const text = stripInjectedBlocks(extractText(msg.content))
        if (text) messages.push({ role: 'user', content: text, ts })
      } else if (role === 'assistant') {
        // Extract thinking blocks
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'thinking' && part.thinking) {
              messages.push({ role: 'thinking', content: part.thinking, ts })
            }
          }
        }
        const text = extractText(msg.content)
        if (text) messages.push({ role: 'assistant', content: text, ts })
        // Extract tool calls with args
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'toolCall') {
              messages.push({
                role: 'tool',
                content: `🔧 ${part.name || 'tool'}`,
                ts,
                meta: {
                  toolName: part.name,
                  toolCallId: part.id,
                  args: typeof part.arguments === 'string'
                    ? part.arguments
                    : JSON.stringify(part.arguments || {}, null, 2),
                },
              })
            }
          }
        }
      } else if (role === 'toolResult') {
        // Attach result to the matching tool message
        const resultText: string = Array.isArray(msg.content)
          ? msg.content.filter((c: ContentPart) => c.type === 'text').map((c: ContentPart) => c.text).join('')
          : ''
        const toolMsg = [...messages].reverse().find(
          (m: ChatMessage) => m.role === 'tool' && m.meta?.toolCallId === msg.toolCallId
        )
        if (toolMsg) {
          toolMsg.meta = {
            ...toolMsg.meta,
            result: resultText.slice(0, 5000),
            isError: msg.isError || false,
          }
        } else {
          messages.push({
            role: 'tool',
            content: `🔧 ${msg.toolName || 'tool'}`,
            ts,
            meta: { result: resultText.slice(0, 5000), isError: msg.isError || false },
          })
        }
      }
    } catch {
      // skip malformed lines
    }
  }
  return { messages, feed }
}

export function parseSessionMessages(sessionPath: string, limit: number = 200): ChatMessage[] {
  if (!existsSync(sessionPath)) return []
  try {
    const parser = createSessionLineParser()
    // Whole-file parse; callers page through session-history.ts instead when
    // the file can be large.
    for (const line of readFileSync(sessionPath, 'utf-8').split('\n')) parser.feed(line)
    // Return last N messages
    return parser.messages.slice(-limit)
  } catch {
    // skip unreadable files
    return []
  }
}

export function extractText(content: string | ContentPart[] | null | undefined, separator: string = ''): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p: ContentPart) => p.type === 'text')
      .map((p: ContentPart) => p.text || '')
      .join(separator)
  }
  return ''
}

/**
 * Produce a short, human-readable summary of a provider-side error message.
 *
 * Witnessed cause: amazon-claude-code / bedrock-converse-stream errors (e.g.
 * Fable-5 capacity throttling) carry a raw serialized Node error/response
 * object appended after the human-readable prefix, e.g.
 *   'Service unavailable: 503: {"_events":{...},"_readableState":{...},...}'
 * Left unsummarized this dumps hundreds of chars of internal stream-object
 * JSON into the chat transcript. Trim to the prefix before the first `{`.
 */
export function summarizeProviderError(raw: unknown): string {
  if (!raw) return 'Unknown provider error'
  const s = String(raw)
  const braceIdx = s.indexOf('{')
  const head = (braceIdx > 0 ? s.slice(0, braceIdx) : s).trim().replace(/[:\s]+$/, '')
  return head || s.slice(0, 200)
}

/** Strip platform-injected blocks (implicitInstruction, context entries, etc.) from user messages */
const IMPLICIT_RE = /\s*<implicitInstruction>[\s\S]*?<\/implicitInstruction>\s*/g
const CONTEXT_ENTRY_RE = /\s*--- CONTEXT ENTRY BEGIN ---[\s\S]*?--- CONTEXT ENTRY END ---\s*/g
const USER_MSG_RE = /--- USER MESSAGE BEGIN ---\s*([\s\S]*?)\s*--- USER MESSAGE END ---/

export function stripInjectedBlocks(text: string): string {
  // Remove implicit instruction blocks
  let cleaned = text.replace(IMPLICIT_RE, '')
  // Remove context entry blocks
  cleaned = cleaned.replace(CONTEXT_ENTRY_RE, '')
  // If wrapped in USER MESSAGE markers, extract just the user message
  const match = cleaned.match(USER_MSG_RE)
  if (match) cleaned = match[1]
  return cleaned.trim()
}

// ── Find session file by key ──

export function findSessionFile(key: string): string | null {
  try {
    const dirs = readdirSync(SESSIONS_DIR).filter((d: string) => d.startsWith('--'))
    for (const dir of dirs) {
      const full = join(SESSIONS_DIR, dir)
      if (!statSync(full).isDirectory()) continue
      const files = readdirSync(full).filter((f: string) => f.endsWith('.jsonl'))
      for (const f of files) {
        if (f.replace('.jsonl', '') === key) {
          return join(full, f)
        }
      }
    }
  } catch {
    // skip
  }
  return null
}

// ── Session discovery (index-free history search) ──

/**
 * One session file summarized from its head, without loading the whole file.
 *
 * `userMessageCount` / `assistantMessageCount` stay at 0 on purpose: exact
 * counts need a full read of every transcript (several GB on a busy machine),
 * so history search reports titles and projects instead of numbers it cannot
 * back up cheaply. The UI hides the count when it is 0.
 */
export interface SessionFileSummary {
  id: string
  name: string
  file: string
  cwd: string
  startedAt: string
  projectSlug: string
  modified: string
  size: number
  userMessageCount: number
  assistantMessageCount: number
  models: string[]
}

interface SessionFileEntry {
  file: string
  modifiedMs: number
  summary: SessionFileSummary
}

const SCAN_CACHE_TTL_MS = 20_000
const SCAN_HEAD_BYTES = 16 * 1024
const CONTENT_SCAN_FILES = 120
const CONTENT_SCAN_BYTES = 192 * 1024
const CONTENT_SCAN_TAIL_BYTES = 128 * 1024
const CONTENT_SCAN_BUDGET_MS = 900

let scanCache: { at: number; entries: SessionFileEntry[] } | null = null

function readFileSlice(file: string, offset: number, bytes: number): string {
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const read = readSync(fd, buf, 0, bytes, offset)
      return buf.subarray(0, read).toString('utf-8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function readFileHead(file: string, bytes: number): string {
  return readFileSlice(file, 0, bytes)
}

function summarizeSessionHead(
  id: string,
  file: string,
  projectDir: string,
  head: string,
  modified: Date,
  size: number,
): SessionFileSummary {
  let name = ''
  let cwd = ''
  let startedAt = ''
  const models: string[] = []
  for (const line of head.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: any
    try {
      obj = JSON.parse(trimmed)
    } catch {
      break // head was cut mid-line
    }
    if (obj.type === 'session') {
      if (typeof obj.cwd === 'string') cwd = obj.cwd
      if (typeof obj.timestamp === 'string') startedAt = obj.timestamp
    } else if (obj.type === 'session_info') {
      if (!name && typeof obj.name === 'string') name = obj.name
    } else if (obj.type === 'model_change') {
      const model = [obj.provider, obj.modelId].filter(Boolean).join('/')
      if (model && !models.includes(model)) models.push(model)
    } else if (obj.type === 'message' && !name && obj.message?.role === 'user') {
      const text = stripInjectedBlocks(extractText(obj.message.content))
      if (text) name = text.slice(0, 100).replace(/\s+/g, ' ')
    }
  }
  const projectLabel = projectDir.replace(/^--/, '').replace(/--$/, '').replace(/--/g, '/')
  return {
    id,
    name: name || projectLabel || id,
    file,
    cwd,
    startedAt: startedAt || modified.toISOString(),
    projectSlug: projectDir,
    modified: modified.toISOString(),
    size,
    userMessageCount: 0,
    assistantMessageCount: 0,
    models,
  }
}

/**
 * Every session file on disk, newest first, cached briefly so keystroke-debounced
 * search does not re-stat 600+ transcripts on each query.
 */
function scanSessionFiles(): SessionFileEntry[] {
  const now = Date.now()
  if (scanCache && now - scanCache.at < SCAN_CACHE_TTL_MS) return scanCache.entries
  const entries: SessionFileEntry[] = []
  let projectDirs: string[] = []
  try {
    projectDirs = readdirSync(SESSIONS_DIR).filter((d: string) => d.startsWith('--'))
  } catch {
    scanCache = { at: now, entries }  // no sessions directory yet
    return entries
  }
  for (const dir of projectDirs) {
    const full = join(SESSIONS_DIR, dir)
    let names: string[]
    try {
      if (!statSync(full).isDirectory()) continue
      names = readdirSync(full)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(full, name)
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      const id = name.replace(/\.jsonl$/, '')
      const head = readFileHead(file, SCAN_HEAD_BYTES)
      entries.push({
        file,
        modifiedMs: stat.mtimeMs,
        summary: summarizeSessionHead(id, file, dir, head, stat.mtime, stat.size),
      })
    }
  }
  entries.sort((a, b) => b.modifiedMs - a.modifiedMs)
  scanCache = { at: now, entries }
  return entries
}

function tokenizeQuery(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)
}

/**
 * History search that needs no FTS index: match titles/projects from the scan
 * cache, then fall back to a bounded read of recent transcripts so keywords
 * from the conversation body still hit. The content pass is capped in both file
 * count and wall time — a search request must never stall the server.
 */
export function searchSessionsOnDisk(query: string, limit: number): SessionFileSummary[] {
  const entries = scanSessionFiles()
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return entries.slice(0, limit).map(e => e.summary)

  const scored: { entry: SessionFileEntry; score: number }[] = []
  const matched = new Set<string>()
  for (const entry of entries) {
    const name = entry.summary.name.toLowerCase()
    const haystack = [entry.summary.projectSlug, entry.summary.cwd, entry.file].join(' ').toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (name.includes(token)) score += 3
      else if (haystack.includes(token)) score += 1
    }
    if (score > 0) {
      scored.push({ entry, score })
      matched.add(entry.file)
    }
  }
  scored.sort((a, b) => b.score - a.score || b.entry.modifiedMs - a.entry.modifiedMs)
  const results = scored.map(s => s.entry)

  if (results.length < limit) {
    const started = Date.now()
    let scanned = 0
    for (const entry of entries) {
      if (results.length >= limit) break
      if (matched.has(entry.file)) continue
      if (scanned >= CONTENT_SCAN_FILES) break
      if (Date.now() - started > CONTENT_SCAN_BUDGET_MS) break
      scanned++
      // Read the beginning and the end: transcripts run to hundreds of MB, so
      // the newest exchange (end) matters as much as the session opener (head).
      const begin = readFileHead(entry.file, CONTENT_SCAN_BYTES)
      const end = entry.summary.size > CONTENT_SCAN_BYTES
        ? readFileSlice(entry.file, Math.max(0, entry.summary.size - CONTENT_SCAN_TAIL_BYTES), CONTENT_SCAN_TAIL_BYTES)
        : ''
      const text = (begin + '\n' + end).toLowerCase()
      if (tokens.every(token => text.includes(token))) {
        results.push(entry)
        matched.add(entry.file)
      }
    }
  }

  return results.slice(0, limit).map(e => e.summary)
}

// ── Parse session JSONL into a tree structure ──

export function parseSessionTree(sessionPath: string): { entries: SessionTreeEntry[]; leafId: string | null } {
  if (!existsSync(sessionPath)) return { entries: [], leafId: null }
  const entries: SessionTreeEntry[] = []
  let leafId: string | null = null
  try {
    const raw = readFileSync(sessionPath, 'utf-8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'session') continue
        const entry: SessionTreeEntry = {
          id: obj.id || null,
          parentId: obj.parentId || null,
          type: obj.type,
          timestamp: obj.timestamp,
        }
        if (obj.type === 'message' && obj.message) {
          entry.role = obj.message.role
          const rawText = obj.message.role === 'user'
            ? stripInjectedBlocks(extractText(obj.message.content))
            : extractText(obj.message.content)
          entry.text = rawText.slice(0, 200)
          if (obj.message.role === 'user') entry.fullText = rawText
          // For assistant, check for tool calls
          if (obj.message.role === 'assistant' && Array.isArray(obj.message.content)) {
            const tools: string[] = obj.message.content.filter((p: ContentPart) => p.type === 'toolCall').map((p: any) => p.name)
            if (tools.length) entry.tools = tools
          }
        } else if (obj.type === 'branch_summary') {
          entry.role = 'branchSummary'
          entry.text = (obj.summary || '').slice(0, 200)
        } else if (obj.type === 'compaction') {
          entry.role = 'compaction'
          entry.text = 'Context compacted'
        } else if (obj.type === 'model_change') {
          entry.role = 'system'
          entry.text = `Model: ${obj.modelId || ''}`
        } else if (obj.type === 'custom_message') {
          entry.role = 'system'
          entry.text = (obj.content || '').slice(0, 200)
        } else {
          entry.role = 'system'
          entry.text = obj.type
        }
        if (entry.id) {
          entries.push(entry)
          leafId = entry.id  // last entry is the leaf
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // skip unreadable files
  }
  return { entries, leafId }
}

// ── Persist/restore dashboard slot state ──

// Async persist with write coalescing — avoids blocking the event loop
let _persistPending: boolean = false
let _persistQueued: SlotState[] | null = null  // latest slots snapshot waiting to write

export function saveSlotState(slots: Map<string, SlotProcess>): void {
  // Snapshot the data immediately (cheap), write async
  const data: SlotState[] = []
  for (const [key, pi] of slots.entries()) {
    const entry: SlotState = {
      key,
      title: pi._title || 'New Chat',
      sessionFile: pi.sessionFile || null,
      modelProvider: pi.modelProvider || null,
      modelId: pi.modelId || null,
      thinkingLevel: pi.thinkingLevel || null,
      cwd: pi.cwd || null,
      transport: pi.transport || undefined,
      toolApproval: pi.toolApproval || undefined,
      tags: pi._tags?.length ? pi._tags : undefined,
      pinned: pi._pinned || undefined,
      midTurn: pi.running === true ? true : undefined,
    }
    // Only persist messages for slots without a session file (unsaved new chats)
    if (!pi.sessionFile && pi.messages.length > 0) {
      entry.messages = pi.messages
    }
    data.push(entry)
  }
  _persistQueued = data
  if (!_persistPending) {
    _persistPending = true
    // Defer to next tick so multiple rapid calls coalesce
    setImmediate(_flushPersist)
  }
}

async function _flushPersist(): Promise<void> {
  while (_persistQueued) {
    const data = _persistQueued
    _persistQueued = null
    try {
      // Stringify in chunks won't help much, but at least the write is async
      const json = JSON.stringify(data)
      await writeFile(STATE_FILE, json, 'utf-8')
    } catch {
      // skip write errors
    }
  }
  _persistPending = false
}

/** Synchronous save for shutdown — blocks but ensures data is written */
export function saveSlotStateSync(slots: Map<string, SlotProcess>): void {
  const data: SlotState[] = []
  for (const [key, pi] of slots.entries()) {
    const entry: SlotState = {
      key,
      title: pi._title || 'New Chat',
      sessionFile: pi.sessionFile || null,
      modelProvider: pi.modelProvider || null,
      modelId: pi.modelId || null,
      thinkingLevel: pi.thinkingLevel || null,
      cwd: pi.cwd || null,
      transport: pi.transport || undefined,
      toolApproval: pi.toolApproval || undefined,
      tags: pi._tags?.length ? pi._tags : undefined,
      pinned: pi._pinned || undefined,
      midTurn: pi.running === true ? true : undefined,
    }
    // Only persist messages for slots without a session file (unsaved new chats)
    if (!pi.sessionFile && pi.messages.length > 0) {
      entry.messages = pi.messages
    }
    data.push(entry)
  }
  try {
    writeFileSync(STATE_FILE, JSON.stringify(data), 'utf-8')
  } catch {
    // skip write errors
  }
}

export function loadSlotState(): SlotState[] {
  if (!existsSync(STATE_FILE)) return []
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
  } catch { return [] }
}
