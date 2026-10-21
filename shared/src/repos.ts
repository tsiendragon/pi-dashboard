/** Repo registry shared by the backend routes and the Repos page. */

/** One entry of `repos` in `~/.pi/dashboard.json`. `id` is the stable reference key. */
export interface RepoEntry {
  id: string
  path: string
  name?: string
  tags?: string[]
  pinned?: boolean
  defaultBranch?: string
}

/** Live git state, queried on demand and never written back to the config. */
export interface RepoGitStatus {
  /** false when the path is a plain directory, true for any checkout. */
  isGit: boolean
  branch: string | null
  detached: boolean
  /** null = no upstream configured. */
  ahead: number | null
  behind: number | null
  staged: number
  modified: number
  untracked: number
  conflicted: number
  stash: number
  worktrees: number
  localBranches: number
  /** `git status` did not finish in time (cold or huge checkout); counts above are unknown. */
  slow: boolean
  /** Raw `remote.origin.url` as written in the repo, e.g. `git@github.com:a/b.git`. */
  origin: string | null
  /** Browser-openable form of `origin`, when it can be derived. */
  webUrl: string | null
  /** Commit identity in effect here: `user.name` / `user.email` after repo and global config merge. */
  identity: { name: string | null; email: string | null } | null
  last: { hash: string; subject: string; author: string; time: number } | null
}

export interface RepoView extends RepoEntry {
  exists: boolean
  status: RepoGitStatus | null
  /** Epoch ms when `status` was read; null while nothing has been read yet. */
  statusAt: number | null
  /** A background status read is running right now. */
  refreshing: boolean
  /** Live Pi sessions whose cwd is inside this repo. */
  liveSessions: number
}

export type RepoRefKind = 'head' | 'local' | 'remote' | 'tag'
export interface RepoRef { name: string; kind: RepoRefKind }

export interface RepoCommit {
  hash: string
  parents: string[]
  refs: RepoRef[]
  author: string
  time: number
  subject: string
}

export interface RepoGraphPage {
  commits: RepoCommit[]
  /** Pass back as `cursor` for the next page; null when history is exhausted. */
  nextCursor: number | null
}

export interface RepoCommitFile { path: string; added: number | null; deleted: number | null }
export interface RepoCommitDetail {
  hash: string
  parents: string[]
  author: string
  email: string
  time: number
  subject: string
  body: string
  files: RepoCommitFile[]
}
