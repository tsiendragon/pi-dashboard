import { describe, it, expect } from 'vitest'
import { inlineHtmlAssets, resolveHtmlAssetRefs, resolveMarkdownAssetUrl, resolvePath } from '../utils/resolvePath'

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

describe('resolveHtmlAssetRefs', () => {
  const page = '/tmp/report/index.html'
  const localFile = (p: string) => `/api/local-file?path=${encodeURIComponent(p)}`

  it('rewrites relative src/href/poster attributes against the html directory', () => {
    const html = `<img src="images/a.png"> <video src='clip/intro.mp4' poster="covers/intro.jpg"></video> <a href="pages/detail.html">x</a>`
    const out = resolveHtmlAssetRefs(html, page)
    expect(out).toContain(`src="${localFile('/tmp/report/images/a.png')}"`)
    expect(out).toContain(`src='${localFile('/tmp/report/clip/intro.mp4')}'`)
    expect(out).toContain(`poster="${localFile('/tmp/report/covers/intro.jpg')}"`)
    expect(out).toContain(`href="${localFile('/tmp/report/pages/detail.html')}"`)
  })

  it('resolves ./ and ../ segments', () => {
    expect(resolveHtmlAssetRefs('<img src="../shared/logo.png">', page))
      .toContain(localFile('/tmp/shared/logo.png'))
    expect(resolveHtmlAssetRefs('<img src="./images/a.png">', page))
      .toContain(localFile('/tmp/report/images/a.png'))
  })

  it('leaves absolute, protocol, root-relative and fragment URLs untouched', () => {
    const html = `<img src="https://cdn.example.com/a.png"> <img src="data:image/png;base64,AAAA"> <a href="#section">s</a> <a href="javascript:void(0)">j</a> <img src="/abs/path.png">`
    expect(resolveHtmlAssetRefs(html, page)).toBe(html)
  })

  it('returns the html unchanged when the base path is unknown', () => {
    const html = '<img src="images/a.png">'
    expect(resolveHtmlAssetRefs(html, undefined)).toBe(html)
    expect(resolveHtmlAssetRefs(html, null)).toBe(html)
    expect(resolveHtmlAssetRefs(html, '')).toBe(html)
  })
})

describe('inlineHtmlAssets', () => {
  const page = '/tmp/report/index.html'

  const fetcher = (mapping: Record<string, { ok?: boolean; blob: Blob }>) =>
    (async (input: any) => {
      const url = String(input)
      const path = decodeURIComponent(new URL(url, 'http://x').searchParams.get('path') || '')
      const hit = mapping[path]
      if (!path || !hit) return { ok: false, status: 404, blob: async () => new Blob([]) } as Response
      return { ok: hit.ok !== false, blob: async () => hit.blob } as Response
    }) as typeof fetch

  it('inlines relative image/video assets as data URIs fetched via /api/local-file', async () => {
    const html = '<img src="images/a.png"> <video src="clip/intro.mp4"></video>'
    const out = await inlineHtmlAssets(html, page, fetcher({
      '/tmp/report/images/a.png': { blob: new Blob(['PNG'], { type: 'image/png' }) },
      '/tmp/report/clip/intro.mp4': { blob: new Blob(['MP4'], { type: 'video/mp4' }) },
    }))
    expect(out).toContain('src="data:image/png;base64,')
    expect(out).toContain('src="data:video/mp4;base64,')
    expect(out).not.toContain('images/a.png')
  })

  it('keeps absolute/protocol URLs untouched and never fetches them', async () => {
    const calls: string[] = []
    const counting = (async (input: any) => { calls.push(String(input)); return { ok: false, blob: async () => new Blob([]) } as Response }) as typeof fetch
    const html = '<img src="https://cdn.example.com/a.png"> <img src="/abs/b.png">'
    const out = await inlineHtmlAssets(html, page, counting)
    expect(out).toBe(html)
    expect(calls).toHaveLength(0)
  })

  it('leaves the reference alone when the asset fetch fails', async () => {
    const html = '<img src="missing/deep/pic.png">'
    const out = await inlineHtmlAssets(html, page, fetcher({}))
    expect(out).toContain('src="missing/deep/pic.png"')
  })

  it('returns the html unchanged without a base path', async () => {
    const html = '<img src="images/a.png">'
    expect(await inlineHtmlAssets(html, undefined)).toBe(html)
  })

  it('leaves non-asset links (other html pages) for the URL rewrite fallback', async () => {
    const calls: string[] = []
    const counting = (async (input: any) => { calls.push(String(input)); return { ok: false, blob: async () => new Blob([]) } as Response }) as typeof fetch
    const html = '<a href="pages/detail.html">next</a>'
    const out = await inlineHtmlAssets(html, page, counting)
    expect(out).toBe(html)
    expect(calls).toHaveLength(0)
  })
})
