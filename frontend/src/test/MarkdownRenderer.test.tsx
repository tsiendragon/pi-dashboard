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
