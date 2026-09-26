/** Worktree root used to shorten Live Pi paths. Injected at runtime from the dashboard
 *  config (`liveSessions.worktreeRoot`); nothing is hard-coded, and an unset root leaves
 *  paths untouched. */
let worktreeRoot = ''

export function setWorktreeRoot(root: string | undefined | null): void {
  worktreeRoot = typeof root === 'string' ? root.trim().replace(/\/+$/, '') : ''
}

export function displayWorktreePath(value: string): string {
  if (!worktreeRoot) return value
  if (value === worktreeRoot) return '<worktree>'
  if (value.startsWith(`${worktreeRoot}/`)) return `<worktree>/${value.slice(worktreeRoot.length + 1)}`
  return value
}
