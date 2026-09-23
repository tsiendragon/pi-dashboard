import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DocumentPreviewModal, { languageForPreview } from '../components/DocumentPreviewModal'

vi.mock('../components/MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown-preview">{content}</div>,
}))

describe('DocumentPreviewModal', () => {
  it('maps supported source files to their highlighting language', () => {
    expect(languageForPreview('/tmp/config.json')?.id).toBe('json')
    expect(languageForPreview('/tmp/config.yaml')?.label).toBe('YAML')
    expect(languageForPreview('/tmp/app.py')?.id).toBe('python')
    expect(languageForPreview('/tmp/app.ts')?.id).toBe('typescript')
    expect(languageForPreview('/tmp/run.sh')?.id).toBe('bash')
  })

  it('renders TypeScript source with a language-specific code class', () => {
    const { container } = render(
      <DocumentPreviewModal
        filePath="/tmp/app.ts"
        content="const answer: number = 42"
        onClose={() => {}}
      />,
    )

    expect(screen.getByText('TypeScript')).toBeInTheDocument()
    expect(container.querySelector('code.language-typescript')).toBeInTheDocument()
    expect(container.querySelector('code.language-typescript')).toHaveTextContent('const answer')
  })

  it('renders Markdown through the Markdown renderer', () => {
    render(
      <DocumentPreviewModal
        filePath="/tmp/README.md"
        content="# Hello"
        onClose={() => {}}
      />,
    )

    expect(screen.getByText('Markdown')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-preview')).toHaveTextContent('# Hello')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<DocumentPreviewModal filePath="/tmp/a.json" content="{}" onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('copies the whole file content to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    render(<DocumentPreviewModal filePath="/tmp/notes.md" content="# Hello" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '复制文件内容' }))

    await screen.findByText('✓ 已复制')
    expect(writeText).toHaveBeenCalledWith('# Hello')
  })

  describe('inline comments', () => {
    const emptyComments: Comment[] = []
    const commentHandlers = {
      onAddComment: vi.fn(),
      onEditComment: vi.fn(),
      onDeleteComment: vi.fn(),
      onReviewComments: vi.fn(),
    }

    it('shows existing comments and sends them for review', () => {
      const comments: Comment[] = [
        { id: 'c1', startLine: 3, endLine: 3, content: 'clarify this', quote: 'Some body text', version: 1, createdAt: '2026-04-14T10:00:00Z' },
      ]
      render(
        <DocumentPreviewModal
          filePath="/tmp/spec.md"
          content={'# Title\n\nSome body text'}
          onClose={() => {}}
          comments={comments}
          {...commentHandlers}
        />
      )
      expect(screen.getByText('clarify this')).toBeTruthy()
      expect(screen.getByText('“Some body text”')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: /review comments/i }))
      expect(commentHandlers.onReviewComments).toHaveBeenCalledTimes(1)
    })

    it('adds a comment on the right-clicked sentence', () => {
      const content = '# Title\n\nSome body text'
      const onAddComment = vi.fn()
      const { container } = render(
        <DocumentPreviewModal filePath="/tmp/spec.md" content={content} onClose={() => {}} comments={emptyComments} {...commentHandlers} onAddComment={onAddComment} />
      )
      vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false, toString: () => 'Some body text' } as any)
      const contentArea = container.querySelector('.min-h-0.flex-1.overflow-auto.p-4')
      expect(contentArea).toBeTruthy()

      fireEvent.contextMenu(contentArea!)
      fireEvent.click(screen.getByText(/Add Comment/))
      fireEvent.change(screen.getByPlaceholderText(/add a comment/i), { target: { value: 'clarify this' } })
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

      expect(onAddComment).toHaveBeenCalledWith(3, 3, 'clarify this', 'Some body text')
      vi.restoreAllMocks()
    })

    it('does not offer commenting when the caller passes no handlers', () => {
      const { container } = render(<DocumentPreviewModal filePath="/tmp/spec.md" content="# Hello" onClose={() => {}} />)
      vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false, toString: () => 'Hello' } as any)
      fireEvent.contextMenu(container.querySelector('.min-h-0.flex-1.overflow-auto.p-4')!)
      expect(screen.queryByText(/Add Comment/)).toBeNull()
      vi.restoreAllMocks()
    })
  })
})
