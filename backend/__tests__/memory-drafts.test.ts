import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const keys = ['PI_TSIEN_MEMORY_DIR', 'PI_MEMORY_DRAFT_DIR', 'PI_MEMORY_SKILL_DIR', 'PI_MEMORY_AGENTS_FILE', 'PI_MEMORY_PUBLISHED_DIR'] as const
const saved: Record<string, string | undefined> = {}
let root = ''

function seedDrafts(): void {
  const draftDir = join(root, 'drafts')
  mkdirSync(draftDir, { recursive: true })
  const entries = [
    { slug: 'skill-use-pnpm', memoryId: 'm1', type: 'skill', title: 'use pnpm', strength: '中', draftPath: join(draftDir, 'skill-use-pnpm.md'), status: 'draft', createdAt: Date.now() },
    { slug: 'rule-run-typecheck', memoryId: 'm2', type: 'rule', title: 'run typecheck', strength: '弱', draftPath: join(draftDir, 'rule-run-typecheck.md'), status: 'draft', createdAt: Date.now() },
    { slug: 'knowledge-release-flow', memoryId: 'm3', type: 'knowledge', title: 'release flow', strength: '弱', draftPath: join(draftDir, 'knowledge-release-flow.md'), status: 'draft', createdAt: Date.now() },
  ]
  for (const entry of entries) writeFileSync(entry.draftPath, `draft body for ${entry.slug}\n`)
  writeFileSync(join(draftDir, 'manifest.json'), JSON.stringify(entries, null, 2))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-memory-drafts-'))
  for (const key of keys) saved[key] = process.env[key]
  process.env.PI_TSIEN_MEMORY_DIR = root
  process.env.PI_MEMORY_DRAFT_DIR = join(root, 'drafts')
  process.env.PI_MEMORY_SKILL_DIR = join(root, 'skills')
  process.env.PI_MEMORY_AGENTS_FILE = join(root, 'AGENTS.md')
  process.env.PI_MEMORY_PUBLISHED_DIR = join(root, 'published')
})

afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(root, { recursive: true, force: true })
})

describe('memory drafts', () => {
  it('lists drafts with their content and intended target', async () => {
    seedDrafts()
    const drafts = await import('../memory-drafts.js')
    const list = drafts.listDrafts()
    expect(list).toHaveLength(3)
    expect(list[0].content).toContain('draft body')
    expect(list.find((draft) => draft.type === 'skill')?.targetHint).toBe(join(root, 'skills', 'skill-use-pnpm', 'SKILL.md'))
  })

  it('publishes a skill draft into the skills directory and marks it published', async () => {
    seedDrafts()
    const drafts = await import('../memory-drafts.js')
    const result = drafts.publishDraft('skill-use-pnpm')
    expect(result.ok).toBe(true)
    const target = join(root, 'skills', 'skill-use-pnpm', 'SKILL.md')
    expect(readFileSync(target, 'utf8')).toContain('draft body')
    expect(drafts.listDrafts().find((draft) => draft.slug === 'skill-use-pnpm')?.status).toBe('published')
  })

  it('appends a rule block once and refuses to publish it twice', async () => {
    seedDrafts()
    writeFileSync(process.env.PI_MEMORY_AGENTS_FILE as string, '# existing rules\n')
    const drafts = await import('../memory-drafts.js')
    expect(drafts.publishDraft('rule-run-typecheck').ok).toBe(true)
    const content = readFileSync(process.env.PI_MEMORY_AGENTS_FILE as string, 'utf8')
    expect(content.startsWith('# existing rules')).toBe(true)
    expect(content).toContain('draft body for rule-run-typecheck')
    expect(drafts.publishDraft('rule-run-typecheck').ok).toBe(false)
    expect(readFileSync(process.env.PI_MEMORY_AGENTS_FILE as string, 'utf8')).toBe(content)
  })

  it('never overwrites an existing skill the user already curated', async () => {
    seedDrafts()
    mkdirSync(join(root, 'skills', 'skill-use-pnpm'), { recursive: true })
    writeFileSync(join(root, 'skills', 'skill-use-pnpm', 'SKILL.md'), 'my own version\n')
    const drafts = await import('../memory-drafts.js')
    const result = drafts.publishDraft('skill-use-pnpm')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('target_exists')
    expect(readFileSync(join(root, 'skills', 'skill-use-pnpm', 'SKILL.md'), 'utf8')).toBe('my own version\n')
  })

  it('keeps knowledge drafts out of the skill and rules paths', async () => {
    seedDrafts()
    const drafts = await import('../memory-drafts.js')
    const result = drafts.publishDraft('knowledge-release-flow')
    expect(result.ok).toBe(true)
    expect(result.hint).toContain('知识库')
    expect(readFileSync(join(root, 'published', 'knowledge-release-flow.md'), 'utf8')).toContain('draft body')
  })

  it('rejects a draft without publishing anything', async () => {
    seedDrafts()
    const drafts = await import('../memory-drafts.js')
    expect(drafts.rejectDraft('skill-use-pnpm', '证据太弱').ok).toBe(true)
    const entry = drafts.listDrafts().find((draft) => draft.slug === 'skill-use-pnpm')
    expect(entry?.status).toBe('rejected')
    expect(entry?.rejectedReason).toBe('证据太弱')
    const publishAfterReject = drafts.publishDraft('skill-use-pnpm')
    expect(publishAfterReject.ok).toBe(false)
    expect(publishAfterReject.error).toBe('draft_rejected')
  })
})
