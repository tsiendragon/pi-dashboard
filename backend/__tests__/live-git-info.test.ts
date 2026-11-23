import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LiveSessionGitInfoResolver, safeRemoteUrl } from '../live-sessions/git-info.js'

describe('safeRemoteUrl', () => {
  it('removes HTTPS credentials instead of showing them in a session row', () => {
    expect(safeRemoteUrl('https://user:github_pat_ABC123@github.com/acme/app.git'))
      .toBe('https://github.com/acme/app.git')
  })

  it('keeps SSH/scp forms that contain no password', () => {
    expect(safeRemoteUrl('git@github.com:acme/app.git')).toBe('git@github.com:acme/app.git')
    expect(safeRemoteUrl('ssh://git:secret@example.test:2222/acme/app.git'))
      .toBe('ssh://git@example.test:2222/acme/app.git')
  })

  it('drops credential-shaped query parameters and hashes', () => {
    expect(safeRemoteUrl('https://example.test/acme/app.git?access_token=x&foo=1#frag'))
      .toBe('https://example.test/acme/app.git?foo=1')
  })

  it('rejects control characters and empty values', () => {
    expect(safeRemoteUrl('')).toBeUndefined()
    expect(safeRemoteUrl('   ')).toBeUndefined()
    expect(safeRemoteUrl('https://example.test/a\nb')).toBeUndefined()
  })
})

describe('LiveSessionGitInfoResolver', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  function initRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'pidash-git-'))
    dir = root
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['remote', 'add', 'origin', 'https://user:secret@example.test/acme/app.git'], { cwd: root })
    return root
  }

  it('resolves root and the scrubbed remote URL', async () => {
    const root = initRepo()
    const info = await new LiveSessionGitInfoResolver().resolve(root)
    expect(info?.root).toBeTruthy()
    expect(info?.remoteUrl).toBe('https://example.test/acme/app.git')
    expect(JSON.stringify(info)).not.toContain('secret')
  })

  it('prefers origin when several remotes exist', async () => {
    const root = initRepo()
    execFileSync('git', ['remote', 'add', 'upstream', 'https://example.test/upstream/app.git'], { cwd: root })
    const info = await new LiveSessionGitInfoResolver().resolve(root)
    expect(info?.remoteUrl).toBe('https://example.test/acme/app.git')
  })

  it('omits the field when the repository has no remote', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pidash-git-'))
    dir = root
    execFileSync('git', ['init', '-q'], { cwd: root })
    const info = await new LiveSessionGitInfoResolver().resolve(root)
    expect(info?.root).toBeTruthy()
    expect(info?.remoteUrl).toBeUndefined()
  })
})
