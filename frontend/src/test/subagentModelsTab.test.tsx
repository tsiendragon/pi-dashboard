import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import SubagentModelsTab from '../features/subagent-models/SubagentModelsTab'

const CONFIG = {
  version: 1, defaultTier: 'medium', roles: { read_only: 'light', research: 'medium', code: 'medium' }, allowInherit: false, extra: 1,
  tiers: { light: { candidates: [{ model: 'p/a' }] }, medium: { candidates: [] }, heavy: { candidates: [] }, ultra: { candidates: [] } },
}
let putStatus = 200
let putBody: any

beforeEach(() => {
  putStatus = 200
  putBody = undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/models/catalog') return new Response(JSON.stringify({ models: [{ provider: 'p', id: 'a' }, { provider: 'p', id: 'b' }] }))
    if (init?.method === 'PUT') {
      putBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify(putStatus === 200 ? { ok: true, mtimeMs: 2, path: '/x', warnings: [] } : { error: 'changed' }), { status: putStatus })
    }
    return new Response(JSON.stringify({ config: CONFIG, mtimeMs: 1, path: '/agent/subagent-models.json', warnings: ['tier medium is empty'] }))
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('SubagentModelsTab', () => {
  it('shows path and warnings, assigns a model to the end of a tier, and saves with baseMtimeMs', async () => {
    render(<SubagentModelsTab />)
    expect(await screen.findByText('/agent/subagent-models.json')).toBeTruthy()
    expect(screen.getByText(/tier medium is empty/)).toBeTruthy()
    fireEvent.click(within(screen.getByLabelText('档位 p/b')).getByText('轻量'))
    const light = screen.getByLabelText('轻量档')
    expect(within(light).getAllByRole('listitem').map(li => li.querySelector('[title]')?.getAttribute('title'))).toEqual(['p/a', 'p/b'])
    expect(within(screen.getByLabelText('档位 p/b')).getByText('轻量').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(putBody).toBeTruthy())
    expect(putBody.baseMtimeMs).toBe(1)
    expect(putBody.config.extra).toBe(1)
    expect(putBody.config.tiers.light.candidates.map((c: any) => c.model)).toEqual(['p/a', 'p/b'])
  })

  it('shows a conflict message with a reload button on 409', async () => {
    putStatus = 409
    render(<SubagentModelsTab />)
    await screen.findByText('/agent/subagent-models.json')
    fireEvent.click(within(screen.getByLabelText('档位 p/b')).getByText('强'))
    fireEvent.click(screen.getByText('保存'))
    expect(await screen.findByText(/被别处改过/)).toBeTruthy()
    expect(screen.getByText('重新加载')).toBeTruthy()
  })

  it('reorders and removes candidates with icon buttons, and filters by assignment', async () => {
    render(<SubagentModelsTab />)
    await screen.findByText('/agent/subagent-models.json')
    fireEvent.click(within(screen.getByLabelText('档位 p/b')).getByText('轻量'))
    fireEvent.click(screen.getByLabelText('上移 p/b'))
    const order = () => within(screen.getByLabelText('轻量档')).getAllByRole('listitem').map(li => li.querySelector('[title]')?.getAttribute('title'))
    expect(order()).toEqual(['p/b', 'p/a'])
    fireEvent.click(screen.getByLabelText('移出 p/a'))
    expect(order()).toEqual(['p/b'])
    fireEvent.click(screen.getByText(/^不用 /))
    expect(screen.getByLabelText('档位 p/a')).toBeTruthy()
    expect(screen.queryByLabelText('档位 p/b')).toBeNull()
  })
})
