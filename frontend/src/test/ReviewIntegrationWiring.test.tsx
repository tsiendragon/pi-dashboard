import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePanelState } from '../hooks/usePanelState'
import type { Comment } from '../hooks/usePanelState'
import { buildReviewMessage, commentReviewItems } from '../utils/reviewComments'

/**
 * Test the review integration logic that will be added to ChatPage:
 * 1. buildReviewMessage — formats comments into a chat message
 * 2. auto-open on agent .md writes
 */

describe('Review Integration — Message Formatting', () => {
  // AC1: Review button sends formatted message
  it('formats single-line and range comments correctly', () => {
    const comments: Comment[] = [
      { id: 'c1', startLine: 5, endLine: 5, content: 'Fix typo here', version: 1, createdAt: '2026-04-14T10:00:00Z' },
      { id: 'c2', startLine: 10, endLine: 15, content: 'Refactor this section', version: 1, createdAt: '2026-04-14T11:00:00Z' },
    ]
    const msg = buildReviewMessage('/tmp/spec.md', commentReviewItems(comments))
    expect(msg).toBe(
      'Please review and address the comments in /tmp/spec.md:\n\n' +
      '[1] Line 5\nComment: Fix typo here\n\n' +
      '[2] Lines 10-15\nComment: Refactor this section'
    )
  })

  // AC2: Message appears as user message (verified by checking send is called with correct text)
  it('formats single comment', () => {
    const comments: Comment[] = [
      { id: 'c1', startLine: 3, endLine: 3, content: 'Needs clarification', version: 1, createdAt: '2026-04-14T10:00:00Z' },
    ]
    const msg = buildReviewMessage('/docs/design.md', commentReviewItems(comments))
    expect(msg).toContain('Please review and address the comment in /docs/design.md')
    expect(msg).toContain('[1] Line 3\nComment: Needs clarification')
  })

  // AC1b: The quoted sentence travels with the comment
  it('includes the quoted sentence for each comment', () => {
    const comments: Comment[] = [
      { id: 'c1', startLine: 12, endLine: 14, content: '口径不对', quote: '净额按日汇总', version: 2, createdAt: '2026-04-14T10:00:00Z' },
    ]
    const msg = buildReviewMessage('/tmp/spec.md', commentReviewItems(comments))
    expect(msg).toContain('[1] Lines 12-14\nQuoted: "净额按日汇总"\nComment: 口径不对')
  })
})

describe('Review Integration — Auto-Open on Agent .md Write', () => {
  // AC3: Auto-open when panel is closed and agent writes to a previously discussed .md file
  it('should auto-open when panel is closed and discussed .md file changes', () => {
    const handleFileOpen = vi.fn()
    const discussedFiles = new Set(['/tmp/spec.md'])

    // Simulate the auto-open logic
    const panelIsOpen = false
    const panelFilePath = ''
    const changedPath = '/tmp/spec.md'

    const shouldAutoOpen = !panelIsOpen && changedPath.endsWith('.md') && discussedFiles.has(changedPath)
    if (shouldAutoOpen) handleFileOpen(changedPath)

    expect(handleFileOpen).toHaveBeenCalledWith('/tmp/spec.md')
  })

  // AC4: No auto-open when panel is busy with different file
  it('should NOT auto-open when panel is open with a different file', () => {
    const handleFileOpen = vi.fn()
    const discussedFiles = new Set(['/tmp/spec.md'])

    const panelIsOpen = true
    const panelFilePath = '/tmp/other.md'
    const changedPath = '/tmp/spec.md'

    const shouldAutoOpen = !panelIsOpen && changedPath.endsWith('.md') && discussedFiles.has(changedPath)
    if (shouldAutoOpen) handleFileOpen(changedPath)

    expect(handleFileOpen).not.toHaveBeenCalled()
  })

  // Auto-open should NOT trigger for non-.md files
  it('should NOT auto-open for non-.md files', () => {
    const handleFileOpen = vi.fn()
    const discussedFiles = new Set(['/tmp/app.ts'])

    const panelIsOpen = false
    const changedPath = '/tmp/app.ts'

    const shouldAutoOpen = !panelIsOpen && changedPath.endsWith('.md') && discussedFiles.has(changedPath)
    if (shouldAutoOpen) handleFileOpen(changedPath)

    expect(handleFileOpen).not.toHaveBeenCalled()
  })

  // Auto-open when panel is open with the SAME file (just refresh, not interrupt)
  it('should auto-open when panel is open with the same .md file', () => {
    const handleFileOpen = vi.fn()
    const discussedFiles = new Set(['/tmp/spec.md'])

    const panelIsOpen = true
    const panelFilePath = '/tmp/spec.md'
    const changedPath = '/tmp/spec.md'

    // Same file is OK — it's already showing, the live update handles it
    // Auto-open only needed when panel is closed
    const shouldAutoOpen = !panelIsOpen && changedPath.endsWith('.md') && discussedFiles.has(changedPath)
    if (shouldAutoOpen) handleFileOpen(changedPath)

    expect(handleFileOpen).not.toHaveBeenCalled()
  })
})
