/**
 * Read-only git queries behind the Repos page.
 *
 * Every call is `git -C <path> ...` through execFile (no shell), so the repo path and revision
 * strings are never interpreted. Nothing here writes to a repo except `fetchRepo`, which only
 * updates remote-tracking refs.
 */
import { promisify } from 'util'
import type {
  RepoCommit, RepoCommitDetail, RepoCommitFile, RepoGitStatus, RepoGraphPage, RepoRef,
} from '../../shared/src/repos.js'

const GIT_TIMEOUT_MS = 10_000
/** `git status` scans the work tree; on a cold network mount a large checkout takes tens of seconds. */
const STATUS_TIMEOUT_MS = 45_000
const FETCH_TIMEOUT_MS = 60_000
const SEP = '\x1f'
const END = '\x1e'

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  // Loaded lazily: server wiring tests mock `child_process` and must still import this module.
  const { execFile } = await import('child_process')
  const run = promisify(execFile)
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })
  return stdout
}

/** `git@host:a/b.git` / `https://host/a/b.git` -> `https://host/a/b`; null for anything else. */
export function webUrlFromRemote(remote: string): string | null {
  const text = remote.trim()
  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(text)
  if (scp) return `https://${scp[1]}/${scp[2]}`
  const url = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(text)
  if (url) return `https://${url[1]}/${url[2]}`
  return null
}

const EMPTY_STATUS: RepoGitStatus = {
  isGit: false, branch: null, detached: false, ahead: null, behind: null,
  staged: 0, modified: 0, untracked: 0, conflicted: 0, stash: 0, worktrees: 0,
  localBranches: 0, slow: false, webUrl: null, last: null,
}

/** Parses `git status --porcelain=v2 --branch` into counts. Exported for tests. */
export function parsePorcelainV2(output: string): Pick<RepoGitStatus, 'branch' | 'detached' | 'ahead' | 'behind' | 'staged' | 'modified' | 'untracked' | 'conflicted'> {
  let branch: string | null = null
  let detached = false
  let ahead: number | null = null
  let behind: number | null = null
  let staged = 0, modified = 0, untracked = 0, conflicted = 0
  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length)
      detached = head === '(detached)'
      branch = detached ? null : head
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) { ahead = Number(m[1]); behind = Number(m[2]) }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.split(' ')[1] ?? '..'
      if (xy[0] !== '.') staged++
      if (xy[1] !== '.') modified++
    } else if (line.startsWith('u ')) {
      conflicted++
    } else if (line.startsWith('? ')) {
      untracked++
    }
  }
  return { branch, detached, ahead, behind, staged, modified, untracked, conflicted }
}

export async function repoStatus(cwd: string): Promise<RepoGitStatus> {
  try {
    await git(cwd, ['rev-parse', '--git-dir'])
  } catch {
    return { ...EMPTY_STATUS }
  }
  const [porcelain, stash, worktrees, branches, remote, last] = await Promise.all([
    git(cwd, ['status', '--porcelain=v2', '--branch'], STATUS_TIMEOUT_MS).catch(() => null),
    git(cwd, ['stash', 'list']).catch(() => ''),
    git(cwd, ['worktree', 'list', '--porcelain']).catch(() => ''),
    git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads']).catch(() => ''),
    git(cwd, ['remote', 'get-url', 'origin']).catch(() => ''),
    git(cwd, ['log', '-1', `--format=%h${SEP}%an${SEP}%ct${SEP}%s`]).catch(() => ''),
  ])
  const [hash, author, time, ...subject] = last.trim().split(SEP)
  return {
    ...EMPTY_STATUS,
    ...parsePorcelainV2(porcelain ?? ''),
    isGit: true,
    slow: porcelain === null,
    stash: stash.split('\n').filter(Boolean).length,
    worktrees: worktrees.split('\n').filter(line => line.startsWith('worktree ')).length,
    localBranches: branches.split('\n').filter(Boolean).length,
    webUrl: webUrlFromRemote(remote),
    last: hash ? { hash, subject: subject.join(SEP), author: author ?? '', time: Number(time) || 0 } : null,
  }
}

/** Parses `%D` with `--decorate=full`: `HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1`. */
export function parseRefs(decoration: string): RepoRef[] {
  const refs: RepoRef[] = []
  for (const raw of decoration.split(',').map(part => part.trim()).filter(Boolean)) {
    if (raw === 'HEAD') { refs.push({ name: 'HEAD', kind: 'head' }); continue }
    const head = raw.startsWith('HEAD -> ')
    const text = head ? raw.slice('HEAD -> '.length) : raw
    let ref: RepoRef | null = null
    if (text.startsWith('tag: refs/tags/')) ref = { name: text.slice('tag: refs/tags/'.length), kind: 'tag' }
    else if (text.startsWith('refs/heads/')) ref = { name: text.slice('refs/heads/'.length), kind: head ? 'head' : 'local' }
    else if (text.startsWith('refs/remotes/')) {
      const name = text.slice('refs/remotes/'.length)
      if (!name.endsWith('/HEAD')) ref = { name, kind: 'remote' }
    }
    if (ref) refs.push(ref)
  }
  return refs
}

export const GRAPH_PAGE_SIZE = 200

export async function repoGraph(cwd: string, scope: 'all' | 'head', cursor: number): Promise<RepoGraphPage> {
  const format = ['%H', '%P', '%D', '%an', '%ct', '%s'].join(SEP) + END
  const out = await git(cwd, [
    'log', scope === 'all' ? '--all' : 'HEAD', '--date-order', '--decorate=full',
    `--skip=${cursor}`, `-n`, String(GRAPH_PAGE_SIZE + 1), `--format=${format}`,
  ])
  const commits: RepoCommit[] = out.split(END).map(chunk => chunk.replace(/^\n/, '')).filter(Boolean).map(chunk => {
    const [hash, parents, refs, author, time, ...subject] = chunk.split(SEP)
    return {
      hash: hash!,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      refs: parseRefs(refs ?? ''),
      author: author ?? '',
      time: Number(time) || 0,
      subject: subject.join(SEP),
    }
  })
  const more = commits.length > GRAPH_PAGE_SIZE
  return { commits: commits.slice(0, GRAPH_PAGE_SIZE), nextCursor: more ? cursor + GRAPH_PAGE_SIZE : null }
}

export const SHA_PATTERN = /^[0-9a-f]{7,40}$/

export async function repoCommit(cwd: string, sha: string): Promise<RepoCommitDetail> {
  if (!SHA_PATTERN.test(sha)) throw new Error('invalid_sha')
  const format = ['%H', '%P', '%an', '%ae', '%ct', '%s', '%b'].join(SEP) + END
  const out = await git(cwd, ['show', '--no-color', '--numstat', '--no-renames', `--format=${format}`, sha])
  const [head, rest = ''] = out.split(END)
  const [hash, parents, author, email, time, subject, ...body] = head!.split(SEP)
  const files: RepoCommitFile[] = rest.split('\n').filter(Boolean).map(line => {
    const [added, deleted, ...file] = line.split('\t')
    return { path: file.join('\t'), added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) }
  })
  return {
    hash: hash!, parents: parents ? parents.split(' ').filter(Boolean) : [], author: author ?? '', email: email ?? '',
    time: Number(time) || 0, subject: subject ?? '', body: body.join(SEP).trim(), files,
  }
}

export async function fetchRepo(cwd: string): Promise<void> {
  await git(cwd, ['fetch', '--prune'], FETCH_TIMEOUT_MS)
}
