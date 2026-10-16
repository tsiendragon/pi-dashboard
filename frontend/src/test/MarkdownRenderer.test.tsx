import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MarkdownRenderer from '../components/MarkdownRenderer'
import TextRenderer from '../components/renderers/TextRenderer'

describe('MarkdownRenderer local files', () => {
  it('opens inline JSON/YAML paths and relative Markdown links in the document panel', () => {
    const onFileOpen = vi.fn()
    render(<MarkdownRenderer content={'`config.yaml` and [design](docs/design.md)'} onFileOpen={onFileOpen} />)

    fireEvent.click(screen.getByText('config.yaml'))
    fireEvent.click(screen.getByRole('link', { name: 'design' }))

    expect(onFileOpen).toHaveBeenNthCalledWith(1, 'config.yaml')
    expect(onFileOpen).toHaveBeenNthCalledWith(2, 'docs/design.md')
  })

  it('opens Bash links and strips URL fragments before reading a local file', () => {
    const onFileOpen = vi.fn()
    render(<MarkdownRenderer content={'`scripts/run.bash` and [config](config.yaml?raw=1#section)'} onFileOpen={onFileOpen} />)

    fireEvent.click(screen.getByText('scripts/run.bash'))
    fireEvent.click(screen.getByRole('link', { name: 'config' }))

    expect(onFileOpen).toHaveBeenNthCalledWith(1, 'scripts/run.bash')
    expect(onFileOpen).toHaveBeenNthCalledWith(2, 'config.yaml')
  })

  // A shell command line reads as a path to PATH_RE, so clicking it used to ask
  // the backend for a file literally named `bash deploy/…` (404) and steal the
  // click meant to select the command.
  it('does not open a shell command line as a file', () => {
    const onFileOpen = vi.fn()
    const command = 'bash deploy/bench-ds-v41-all_new.sh              # 重启 + 测量 + 对比（约 15 分钟）'
    const { container } = render(
      <MarkdownRenderer content={'```bash\n' + command + '\n```\n\ninline `bash deploy/bench-ds-v41-all_new.sh --restart-only`\n'} onFileOpen={onFileOpen} />
    )

    const fenced = container.querySelector('pre code')
    expect(fenced).toBeTruthy()
    fireEvent.click(fenced as HTMLElement)
    fireEvent.click(screen.getByText('bash deploy/bench-ds-v41-all_new.sh --restart-only'))

    expect(onFileOpen).not.toHaveBeenCalled()
  })

  it('can hide the raw toggle for user-authored messages', () => {
    render(<MarkdownRenderer content="A long user message that should stay rendered in the timeline." showRaw={false} />)

    expect(screen.queryByText('raw')).not.toBeInTheDocument()
  })
})

// Markdown previews used to hand `![](images/a.png)` to the browser verbatim,
// which resolved it against `/chat` and got the SPA fallback HTML back (200,
// text/html) — so the image never rendered. A file context now rewrites it.
describe('MarkdownRenderer markdown images', () => {
  const target = '/workspace/project/docs/images/features/chat.png'
  const expected = `/api/local-file?path=${encodeURIComponent(target)}`

  it('resolves a relative image against the previewed file directory', () => {
    render(<MarkdownRenderer content={'![shot](images/features/chat.png)'} baseFilePath="/workspace/project/docs/features.md" />)

    expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute('src', expected)
  })

  it('leaves the src alone when there is no file context', () => {
    render(<MarkdownRenderer content={'![shot](images/features/chat.png)'} />)

    expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute('src', 'images/features/chat.png')
  })

  it('does not touch absolute image URLs', () => {
    render(<MarkdownRenderer content={'![shot](https://example.com/a.png)'} baseFilePath="/workspace/project/docs/features.md" />)

    expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute('src', 'https://example.com/a.png')
  })

  it('keeps relative markdown links raw so they still open in the panel', () => {
    const onFileOpen = vi.fn()
    render(<MarkdownRenderer content={'[design](docs/design.md)'} baseFilePath="/workspace/project/docs/features.md" onFileOpen={onFileOpen} />)

    fireEvent.click(screen.getByRole('link', { name: 'design' }))

    expect(onFileOpen).toHaveBeenCalledWith('docs/design.md')
  })
})

// TextRenderer is what the document panel renders for .md files; the file path
// it is given has to reach MarkdownRenderer for relative images to resolve.
describe('TextRenderer markdown images', () => {
  it('forwards the previewed file path as the image base directory', () => {
    render(
      <TextRenderer
        content={'![shot](images/features/chat.png)'}
        filePath="/workspace/project/docs/features.md"
        mode="preview"
        lineNums={false}
        onChange={() => {}}
        readOnly={false}
      />
    )

    expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute(
      'src',
      `/api/local-file?path=${encodeURIComponent('/workspace/project/docs/images/features/chat.png')}`
    )
  })
})
