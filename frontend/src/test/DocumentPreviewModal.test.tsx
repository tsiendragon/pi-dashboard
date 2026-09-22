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
})
