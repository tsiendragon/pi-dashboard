import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { listRepoCandidates } from '../live-sessions/repo-candidates.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repo-candidates-'))
  created.push(root)
  return root
}

describe('listRepoCandidates', () => {
  it('lists direct child directories with their checkout marker', async () => {
    const root = await fixtureRoot()
    await mkdir(path.join(root, 'repo-a', '.git'), { recursive: true })
    await mkdir(path.join(root, 'plain'))
    await mkdir(path.join(root, 'node_modules'))
    await writeFile(path.join(root, 'notes.txt'), '')
    // A worktree checkout marks `.git` with a file instead of a directory.
    await mkdir(path.join(root, 'worktree-repo'), { recursive: true })
    await writeFile(path.join(root, 'worktree-repo', '.git'), 'gitdir: /elsewhere')

    const candidates = await listRepoCandidates([root])
    expect(candidates.map(candidate => [candidate.name, candidate.git])).toEqual([
      ['plain', false],
      ['repo-a', true],
      ['worktree-repo', true],
    ])
    expect(candidates.every(candidate => candidate.path.startsWith(root))).toBe(true)
  })

  it('follows symlinked checkouts and skips hidden entries', async () => {
    const root = await fixtureRoot()
    const outside = await fixtureRoot()
    await mkdir(path.join(outside, 'linked-repo', '.git'), { recursive: true })
    await symlink(path.join(outside, 'linked-repo'), path.join(root, 'linked-repo'))
    await mkdir(path.join(root, '.hidden-repo'))

    const candidates = await listRepoCandidates([root])
    expect(candidates.map(candidate => candidate.name)).toEqual(['linked-repo'])
    expect(candidates[0]!.git).toBe(true)
  })

  it('ignores roots that cannot be read and keeps the readable ones', async () => {
    const root = await fixtureRoot()
    await mkdir(path.join(root, 'repo'))
    const candidates = await listRepoCandidates([path.join(root, 'missing'), root])
    expect(candidates.map(candidate => candidate.name)).toEqual(['repo'])
  })
})