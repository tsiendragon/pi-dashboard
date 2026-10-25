import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HtmlRenderer from '../components/renderers/HtmlRenderer'

const okBlob = (body: string, type: string) =>
  ({ ok: true, blob: async () => new Blob([body], { type }) }) as Response

describe('HtmlRenderer', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('inlines relative assets as data URIs so the sandboxed iframe fetches nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes(encodeURIComponent('/tmp/report/images/a.png'))) return okBlob('<svg/>', 'image/svg+xml')
      return { ok: false, blob: async () => new Blob([]) } as Response
    }))

    render(<HtmlRenderer content={'<html><body><img src="images/a.png"></body></html>'} baseFilePath="/tmp/report/index.html" />)

    const iframe = await screen.findByTitle('HTML preview')
    expect(iframe.getAttribute('srcdoc')).toContain('data:image/svg+xml;base64,')
    expect(iframe.getAttribute('sandbox')).toContain('allow-scripts')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })

  it('falls back to /api/local-file URLs when an asset cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, blob: async () => new Blob([]) }) as Response))

    render(<HtmlRenderer content={'<img src="missing/pic.png">'} baseFilePath="/tmp/report/index.html" />)

    const iframe = await screen.findByTitle('HTML preview')
    expect(iframe.getAttribute('srcdoc')).toContain(
      `/api/local-file?path=${encodeURIComponent('/tmp/report/missing/pic.png')}`,
    )
  })

  it('renders immediately without fetching when no base path is known', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)

    render(<HtmlRenderer content={'<h1>hi</h1>'} />)

    const iframe = await screen.findByTitle('HTML preview')
    expect(iframe.getAttribute('srcdoc')).toContain('<h1>hi</h1>')
    expect(spy).not.toHaveBeenCalled()
  })
})
