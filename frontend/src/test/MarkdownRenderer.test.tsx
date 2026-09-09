import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MarkdownRenderer from '../components/MarkdownRenderer'

describe('MarkdownRenderer local files', () => {
  it('opens inline JSON/YAML paths and relative Markdown links in the document panel', () => {
    const onFileOpen = vi.fn()
    render(<MarkdownRenderer content={'`config.yaml` and [design](docs/design.md)'} onFileOpen={onFileOpen} />)

    fireEvent.click(screen.getByText('config.yaml'))
    fireEvent.click(screen.getByRole('link', { name: 'design' }))

    expect(onFileOpen).toHaveBeenNthCalledWith(1, 'config.yaml')
    expect(onFileOpen).toHaveBeenNthCalledWith(2, 'docs/design.md')
  })
})
