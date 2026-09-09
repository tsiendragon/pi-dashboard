const WORKTREE_ROOT = '/mnt/workspace/lilong/repos/worktree'

export function displayWorktreePath(value: string): string {
  if (value === WORKTREE_ROOT) return '<worktree>'
  if (value.startsWith(`${WORKTREE_ROOT}/`)) return `<worktree>/${value.slice(WORKTREE_ROOT.length + 1)}`
  return value
}
