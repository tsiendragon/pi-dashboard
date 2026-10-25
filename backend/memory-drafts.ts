/**
 * Drafts produced by the nightly memory review, and the human-approved publishing step.
 *
 * The nightly job only writes drafts. This module is the only place that turns a draft into a real
 * skill, rule, or knowledge note, and it always refuses to overwrite an existing file so an approved
 * change can never silently replace something the user already curated.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type DraftType = 'skill' | 'rule' | 'knowledge'
export type DraftStatus = 'draft' | 'published' | 'rejected'

export interface DraftEntry {
  slug: string
  memoryId: string
  type: DraftType
  title: string
  strength?: string
  signals?: { observed: number; applied: number; verified: number }
  draftPath: string
  status: DraftStatus
  createdAt: number
  publishedAt?: number
  publishedPath?: string
  rejectedReason?: string
}

export interface DraftView extends DraftEntry {
  content: string
  targetHint: string
}

export function memoryDataDir(): string {
  return process.env.PI_TSIEN_MEMORY_DIR?.trim() || join(homedir(), '.pi', 'tsien-memory')
}

function draftDir(): string {
  return process.env.PI_MEMORY_DRAFT_DIR?.trim() || join(memoryDataDir(), 'drafts')
}

function manifestPath(): string {
  return join(draftDir(), 'manifest.json')
}

function skillsDir(): string {
  return process.env.PI_MEMORY_SKILL_DIR?.trim() || join(homedir(), '.pi', 'agent', 'skills')
}

function agentsFile(): string {
  return process.env.PI_MEMORY_AGENTS_FILE?.trim() || join(homedir(), '.pi', 'agent', 'AGENTS.md')
}

function publishedDir(): string {
  return process.env.PI_MEMORY_PUBLISHED_DIR?.trim() || join(memoryDataDir(), 'published')
}

function readManifest(): DraftEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(), 'utf8')) as unknown
    return Array.isArray(parsed) ? (parsed as DraftEntry[]) : []
  } catch {
    return []
  }
}

function writeManifest(entries: DraftEntry[]): void {
  mkdirSync(draftDir(), { recursive: true, mode: 0o700 })
  writeFileSync(manifestPath(), `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 })
}

function targetFor(entry: DraftEntry): string {
  if (entry.type === 'skill') return join(skillsDir(), entry.slug, 'SKILL.md')
  if (entry.type === 'rule') return agentsFile()
  return join(publishedDir(), `${entry.slug}.md`)
}

export function listDrafts(): DraftView[] {
  const entries = readManifest()
  return entries
    .map((entry) => {
      let content = ''
      try {
        content = readFileSync(entry.draftPath, 'utf8')
      } catch {
        content = '（草稿文件已不存在）'
      }
      return { ...entry, content, targetHint: targetFor(entry) }
    })
    .sort((a, b) => (a.status === b.status ? b.createdAt - a.createdAt : a.status === 'draft' ? -1 : 1))
}

export interface PublishResult {
  ok: boolean
  publishedPath?: string
  hint?: string
  error?: string
}

export function publishDraft(slug: string): PublishResult {
  const entries = readManifest()
  const entry = entries.find((item) => item.slug === slug)
  if (!entry) return { ok: false, error: 'draft_not_found' }
  if (entry.status === 'published') return { ok: false, error: 'already_published', publishedPath: entry.publishedPath }
  if (entry.status === 'rejected') return { ok: false, error: 'draft_rejected', hint: '这条草稿已被拒绝，需要夜里重新生成后再批准。' }

  let content: string
  try {
    content = readFileSync(entry.draftPath, 'utf8')
  } catch {
    return { ok: false, error: 'draft_file_missing' }
  }

  const target = targetFor(entry)
  try {
    if (entry.type === 'rule') {
      const marker = `pi-memory-rule:${entry.slug}:begin`
      const existing = existsSync(target) ? readFileSync(target, 'utf8') : ''
      if (existing.includes(marker)) return { ok: false, error: 'already_published', publishedPath: target }
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, `${existing.replace(/\n*$/u, '\n\n')}${content}`, { mode: 0o600 })
      // Keep a copy so a later rewrite of the rules file never loses what the user approved.
      mkdirSync(publishedDir(), { recursive: true, mode: 0o700 })
      writeFileSync(join(publishedDir(), `${entry.slug}.md`), content, { mode: 0o600 })
    } else {
      if (existsSync(target)) return { ok: false, error: 'target_exists', publishedPath: target }
      mkdirSync(entry.type === 'skill' ? join(target, '..') : publishedDir(), { recursive: true, mode: 0o700 })
      writeFileSync(target, content, { mode: 0o600 })
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const updated = entries.map((item) => (item.slug === slug ? { ...item, status: 'published' as DraftStatus, publishedAt: Date.now(), publishedPath: target } : item))
  writeManifest(updated)
  return {
    ok: true,
    publishedPath: target,
    hint: entry.type === 'knowledge' ? '这条知识已写入文件；如需进入知识库检索，请让助手把它加进对应知识库。' : undefined,
  }
}

export function rejectDraft(slug: string, reason = 'user_rejected'): PublishResult {
  const entries = readManifest()
  const entry = entries.find((item) => item.slug === slug)
  if (!entry) return { ok: false, error: 'draft_not_found' }
  if (entry.status === 'published') return { ok: false, error: 'already_published' }
  const updated = entries.map((item) => (item.slug === slug ? { ...item, status: 'rejected' as DraftStatus, rejectedReason: reason } : item))
  writeManifest(updated)
  return { ok: true }
}