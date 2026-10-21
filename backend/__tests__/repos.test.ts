import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { parsePorcelainV2, parseRefs, repoCommit, repoGraph, repoStatus, webUrlFromRemote } from '../repos/git.js'
import { RepoError, RepoStore, sanitizeEntries, type ConfigIo } from '../repos/store.js'
import type { RepoEntry } from '../../shared/src/repos.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tmp = () => { const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'repos-'))); dirs.push(dir); return dir }

function memoryIo(initial: RepoEntry[] = []): ConfigIo & { saved: RepoEntry[] } {
  const io = { saved: initial, load: () => io.saved, save: (entries: RepoEntry[]) => { io.saved = entries } }
  return io
}

function gitRepo(): string {
  const dir = tmp()
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T')
  writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  git('add', '.'); git('commit', '-qm', 'first')
  git('checkout', '-qb', 'feature')
  writeFileSync(path.join(dir, 'b.txt'), 'b\n')
  git('add', '.'); git('commit', '-qm', 'second')
  git('checkout', '-q', 'main')
  git('merge', '-q', '--no-ff', 'feature', '-m', 'merge feature')
  return dir
}

describe('RepoStore', () => {
  it('registers a directory with a generated unique id', () => {
    const a = tmp(); const b = tmp()
    mkdirSync(path.join(a, 'x')); mkdirSync(path.join(b, 'x'))
    const store = new RepoStore(memoryIo())
    expect(store.add({ path: path.join(a, 'x') }).id).toBe('x')
    expect(store.add({ path: path.join(b, 'x') }).id).toBe('x-2')
  })

  it('rejects relative, missing, file and duplicate paths and bad ids', () => {
    const dir = tmp()
    writeFileSync(path.join(dir, 'f'), '')
    const store = new RepoStore(memoryIo())
    const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as RepoError).code } return 'none' }
    expect(code(() => store.add({ path: 'rel/path' }))).toBe('path_not_absolute')
    expect(code(() => store.add({ path: path.join(dir, 'nope') }))).toBe('path_not_found')
    expect(code(() => store.add({ path: path.join(dir, 'f') }))).toBe('path_not_directory')
    store.add({ path: dir, id: 'one' })
    expect(code(() => store.add({ path: dir }))).toBe('path_duplicate')
    const other = tmp()
    expect(code(() => store.add({ path: other, id: 'one' }))).toBe('id_duplicate')
    expect(code(() => store.add({ path: other, id: 'Bad Id' }))).toBe('id_invalid')
  })

  it('updates fields but never the id, and removes without touching disk', () => {
    const dir = tmp(); const moved = tmp()
    const store = new RepoStore(memoryIo())
    store.add({ path: dir, id: 'r', tags: ['a', 'a', ' '] })
    const next = store.update('r', { path: moved, pinned: true, id: 'ignored' })
    expect(next).toMatchObject({ id: 'r', path: moved, pinned: true, tags: ['a'] })
    store.remove('r')
    expect(store.list()).toEqual([])
    expect(() => store.remove('r')).toThrow(RepoError)
  })

  it('sanitizeEntries drops malformed config entries instead of failing', () => {
    expect(sanitizeEntries([{ id: 'ok', path: '/a' }, { id: 'ok', path: '/b' }, { id: 'X', path: '/c' }, { id: 'rel', path: 'r' }, 3, null]))
      .toEqual([{ id: 'ok', path: '/a' }])
    expect(sanitizeEntries('nope')).toEqual([])
  })
})

describe('git helpers', () => {
  it('derives browser URLs from remotes', () => {
    expect(webUrlFromRemote('git@github.com:a/b.git')).toBe('https://github.com/a/b')
    expect(webUrlFromRemote('https://github.com/a/b.git')).toBe('https://github.com/a/b')
    expect(webUrlFromRemote('ssh://git@host:2222/a/b.git')).toBe('https://host/a/b')
    expect(webUrlFromRemote('/local/path')).toBeNull()
  })

  it('parses porcelain v2 counts and ahead/behind', () => {
    const out = ['# branch.oid abc', '# branch.head dev', '# branch.upstream origin/dev', '# branch.ab +2 -5',
      '1 M. N... 1 1 1 a b f1', '1 .M N... 1 1 1 a b f2', '1 MM N... 1 1 1 a b f3', 'u UU N... 1 1 1 1 a b c f4', '? new'].join('\n')
    expect(parsePorcelainV2(out)).toEqual({ branch: 'dev', detached: false, ahead: 2, behind: 5, staged: 2, modified: 2, untracked: 1, conflicted: 1 })
    expect(parsePorcelainV2('# branch.head (detached)\n')).toMatchObject({ branch: null, detached: true, ahead: null })
  })

  it('parses decorations into kinds', () => {
    expect(parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1, refs/heads/dev'))
      .toEqual([{ name: 'main', kind: 'head' }, { name: 'origin/main', kind: 'remote' }, { name: 'v1', kind: 'tag' }, { name: 'dev', kind: 'local' }])
  })

  it('reads status, graph and commit detail from a real repo', async () => {
    const dir = gitRepo()
    writeFileSync(path.join(dir, 'c.txt'), 'c')
    const status = await repoStatus(dir)
    expect(status).toMatchObject({ isGit: true, branch: 'main', ahead: null, untracked: 1, localBranches: 2, worktrees: 1 })
    expect(status.last?.subject).toBe('merge feature')

    const page = await repoGraph(dir, 'all', 0)
    expect(page.commits.map(c => c.subject)).toEqual(['merge feature', 'second', 'first'])
    expect(page.commits[0]!.parents).toHaveLength(2)
    expect(page.commits[0]!.refs).toContainEqual({ name: 'main', kind: 'head' })
    expect(page.nextCursor).toBeNull()

    const detail = await repoCommit(dir, page.commits[1]!.hash)
    expect(detail.files).toEqual([{ path: 'b.txt', added: 1, deleted: 0 }])
    await expect(repoCommit(dir, '--output=x')).rejects.toThrow('invalid_sha')
  })

  it('reads origin url and commit identity, null when unset', async () => {
    const dir = gitRepo()
    const before = await repoStatus(dir)
    expect(before.origin).toBeNull()
    expect(before.identity).toEqual({ name: 'T', email: 't@t' })
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:a/b.git'])
    const after = await repoStatus(dir)
    expect(after.origin).toBe('git@github.com:a/b.git')
    expect(after.webUrl).toBe('https://github.com/a/b')
  })

  it('reports a plain directory as not-git', async () => {
    expect(await repoStatus(tmp())).toMatchObject({ isGit: false, origin: null, identity: null })
  })
})
