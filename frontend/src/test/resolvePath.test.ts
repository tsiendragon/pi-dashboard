import { describe, it, expect } from 'vitest'
import { resolveMarkdownAssetUrl, resolvePath } from '../utils/resolvePath'

describe('resolvePath', () => {
  const cwd = '/workspace/example-project'

  it('returns absolute paths unchanged', () => {
    const p = '/workspace/example-project/docs/design/1-pager.md'
    expect(resolvePath(p, cwd)).toBe(p)
  })

  it('returns ~ paths unchanged (backend expandHome handles them)', () => {
    expect(resolvePath('~/vault/Notes/foo.md', cwd)).toBe('~/vault/Notes/foo.md')
    expect(resolvePath('~', cwd)).toBe('~')
  })

  it('joins workspace-relative paths against cwd — the 1-pager.md fix', () => {
    expect(resolvePath('docs/design/1-pager.md', cwd))
      .toBe('/workspace/example-project/docs/design/1-pager.md')
  })

  it('collapses leading ./ on relative paths', () => {
    expect(resolvePath('./docs/design/1-pager.md', cwd))
      .toBe('/workspace/example-project/docs/design/1-pager.md')
  })

  it('handles bare hyphenated filenames', () => {
    expect(resolvePath('1-pager.md', cwd))
      .toBe('/workspace/example-project/1-pager.md')
  })

  it('strips a trailing slash from cwd before joining', () => {
    expect(resolvePath('foo.md', '/tmp/work/')).toBe('/tmp/work/foo.md')
  })

  it('leaves relative paths alone when no cwd is known', () => {
    expect(resolvePath('docs/1-pager.md', null)).toBe('docs/1-pager.md')
    expect(resolvePath('docs/1-pager.md', undefined)).toBe('docs/1-pager.md')
    expect(resolvePath('docs/1-pager.md', '')).toBe('docs/1-pager.md')
  })

  it('returns empty input unchanged', () => {
    expect(resolvePath('', cwd)).toBe('')
  })
})

describe('resolveMarkdownAssetUrl', () => {
  const doc = '/workspace/example-project/docs/features.md'
  const localFile = (p: string) => `/api/local-file?path=${encodeURIComponent(p)}`

  it('resolves a relative asset against the markdown file directory', () => {
    expect(resolveMarkdownAssetUrl('images/features/chat.png', doc))
      .toBe(localFile('/workspace/example-project/docs/images/features/chat.png'))
  })

  it('resolves ./ and ../ segments', () => {
    expect(resolveMarkdownAssetUrl('./chat.png', doc))
      .toBe(localFile('/workspace/example-project/docs/chat.png'))
    expect(resolveMarkdownAssetUrl('../assets/chat.png', doc))
      .toBe(localFile('/workspace/example-project/assets/chat.png'))
  })

  it('leaves absolute URLs and root-relative URLs alone', () => {
    for (const url of [
      'https://example.com/a.png',
      'http://example.com/a.png',
      'data:image/png;base64,AAAA',
      'blob:http://localhost/abc',
      '//cdn.example.com/a.png',
      '/api/local-file?path=%2Ftmp%2Fa.png',
      '/images/a.png',
    ]) expect(resolveMarkdownAssetUrl(url, doc)).toBe(url)
  })

  it('drops a query / fragment suffix before resolving', () => {
    expect(resolveMarkdownAssetUrl('chat.png?v=2#fig-1', doc))
      .toBe(localFile('/workspace/example-project/docs/chat.png'))
  })

  it('keeps ~ paths so the backend can expand them', () => {
    expect(resolveMarkdownAssetUrl('images/a.png', '~/notes/doc.md'))
      .toBe(localFile('~/notes/images/a.png'))
  })

  it('leaves assets alone when the file path is unknown (chat, live sessions)', () => {
    expect(resolveMarkdownAssetUrl('images/a.png', undefined)).toBe('images/a.png')
    expect(resolveMarkdownAssetUrl('images/a.png', null)).toBe('images/a.png')
    expect(resolveMarkdownAssetUrl('images/a.png', '')).toBe('images/a.png')
  })

  it('falls back to a repo-relative path for a file with no directory', () => {
    expect(resolveMarkdownAssetUrl('docs/a.png', 'README.md'))
      .toBe(localFile('docs/a.png'))
  })
})
