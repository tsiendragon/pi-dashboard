// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { displayWorktreePath, setWorktreeRoot } from '../utils/displayPath'

describe('displayWorktreePath', () => {
  beforeEach(() => setWorktreeRoot(''))

  it('leaves paths untouched when no worktree root is configured', () => {
    expect(displayWorktreePath('/home/someone/repos/worktree/task-a')).toBe(
      '/home/someone/repos/worktree/task-a',
    )
  })

  it('shortens the configured root and its children', () => {
    setWorktreeRoot('/home/someone/repos/worktree')
    expect(displayWorktreePath('/home/someone/repos/worktree')).toBe('<worktree>')
    expect(displayWorktreePath('/home/someone/repos/worktree/task-a')).toBe('<worktree>/task-a')
  })

  it('ignores trailing slashes and blank values', () => {
    setWorktreeRoot('/home/someone/repos/worktree/')
    expect(displayWorktreePath('/home/someone/repos/worktree/task-a')).toBe('<worktree>/task-a')

    setWorktreeRoot('   ')
    expect(displayWorktreePath('/home/someone/repos/worktree/task-a')).toBe(
      '/home/someone/repos/worktree/task-a',
    )
  })

  it('does not touch unrelated paths', () => {
    setWorktreeRoot('/home/someone/repos/worktree')
    expect(displayWorktreePath('/home/someone/repos/other/task-a')).toBe(
      '/home/someone/repos/other/task-a',
    )
    expect(displayWorktreePath('/home/someone/repos/worktree-2/task-a')).toBe(
      '/home/someone/repos/worktree-2/task-a',
    )
  })
})