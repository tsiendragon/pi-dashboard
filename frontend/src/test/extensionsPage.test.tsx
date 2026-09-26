import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { ExtInventory } from '@shared/ext-inventory'
import ExtensionsPage from '../pages/ExtensionsPage'

/**
 * Render-level smoke tests for the Extensions page.
 *
 * The page cannot be eyeballed in CI (no browser) and its data is highly structured, so these tests
 * mock the three endpoints and assert the things a reviewer would check by hand: the list renders,
 * filters narrow it, details expand, the confirm dialog shows the exact write, and a rejected write
 * surfaces the server's reason instead of a success message.
 */

const INVENTORY: ExtInventory = {
  agentDir: '/home/u/.pi/agent',
  settingsPath: '/home/u/.pi/agent/settings.json',
  configPath: '/home/u/.pi/agent/extensions.config.json',
  configExists: true,
  packages: [],
  extensions: [
    {
      raw: './packages/pi-tsien-goal/src/index.ts',
      state: 'enabled',
      group: 'package',
      path: '/repo/packages/pi-tsien-goal/src/index.ts',
      exists: true,
      appliedOrder: 1,
      managedOrder: 1,
      packageId: 'pi-tsien-goal',
      packageSource: '/repo/packages/pi-tsien-goal',
      manifestPath: 'src/index.ts',
      declared: true,
      duplicate: false,
      name: 'pi-tsien-goal',
      version: '0.1.0',
      description: '长期目标管理',
      patchedApi: [],
    },
    {
      raw: '-./packages/pi-tsien-code-mode/src/index.ts',
      state: 'disabled',
      group: 'package',
      path: '/repo/packages/pi-tsien-code-mode/src/index.ts',
      exists: true,
      appliedOrder: 2,
      managedOrder: 2,
      packageId: 'pi-tsien-code-mode',
      packageSource: '/repo/packages/pi-tsien-code-mode',
      manifestPath: 'src/index.ts',
      declared: true,
      duplicate: false,
      name: 'pi-tsien-code-mode',
      version: '0.1.0',
      description: '代码模式',
      patchedApi: ['executeTool'],
    },
    {
      raw: '/home/u/.pi/agent/extensions/security-guard.ts',
      state: 'enabled',
      group: 'path',
      path: '/home/u/.pi/agent/extensions/security-guard.ts',
      exists: false,
      appliedOrder: 3,
      managedOrder: null,
      packageId: null,
      packageSource: null,
      manifestPath: null,
      declared: false,
      duplicate: false,
      name: 'security-guard',
      version: null,
      description: null,
      patchedApi: [],
    },
  ],
  provided: [
    {
      packageId: 'pi-tsien-live-session',
      packageName: 'pi-tsien-live-session',
      path: '/repo/packages/pi-tsien-live-session/src/index.ts',
      manifestPath: 'src/index.ts',
      exists: true,
      kind: 'manifest',
      pattern: './src/index.ts',
    },
  ],
  auto: [{ name: 'security-guard', file: 'security-guard.ts', path: '/home/u/.pi/agent/extensions/security-guard.ts' }],
  drift: [],
  warnings: ['package source not found on disk: npm:pi-tsien-missing'],
  counts: {
    packages: 2,
    applied: 3,
    enabled: 2,
    disabled: 1,
    packageEntries: 2,
    pathEntries: 1,
    provided: 1,
    auto: 1,
    broken: 1,
    patched: 1,
  },
}

const DEPS = {
  crossImports: [{ from: 'pi-tsien-live-session', fromPath: '/repo/p/lib.ts', toPackageId: 'pi-tsien-shared', toPath: '/repo/packages/pi-tsien-shared/src/lib/x.ts', toManifestPath: 'src/lib/x.ts', toEntry: null }],
  sharedPackages: [{ packageId: 'pi-tsien-shared', packageName: 'pi-tsien-shared', importedBy: ['pi-tsien-live-session', 'pi-tsien-side-chat'], files: 13 }],
  externalPackages: ['ignore', 'tree-sitter'],
  scannedFiles: 291,
  truncated: true,
  cached: true,
}

const AUDIT = {
  records: [
    { id: 'a1', ts: '2026-09-26T04:00:00.000Z', action: 'toggle', target: 'pi-tsien-schedule', ok: true, backupPath: '/home/u/.pi/agent/backups/settings-20260926-040000.json' },
    { id: 'a2', ts: '2026-09-26T04:05:00.000Z', action: 'install', target: 'npm:pi-tsien-web-tools', ok: false, backupPath: null, error: 'boom' },
  ],
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

let posts: Array<{ url: string; body: unknown }> = []

function stubFetch(overrides: { list?: unknown; post?: (url: string) => Response } = {}) {
  posts = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method && init.method !== 'GET') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
      return overrides.post ? overrides.post(url) : jsonResponse({ diff: ['x'], backupPath: '/home/u/.pi/agent/backups/settings-1.json' })
    }
    if (url.startsWith('/api/pi/ext/list')) return jsonResponse(overrides.list ?? INVENTORY)
    if (url.startsWith('/api/pi/ext/deps')) return jsonResponse(DEPS)
    if (url.startsWith('/api/pi/ext/audit')) return jsonResponse(AUDIT)
    if (url.startsWith('/api/pi/gallery')) return jsonResponse({ packages: [] })
    if (url.startsWith('/api/ext/config')) {
      return jsonResponse({
        agentDir: '/home/u/.pi/agent',
        configs: [{ name: 'bash-digest', file: 'bash-digest.json', description: '命令输出摘要', fields: [], path: '/home/u/.pi/agent/bash-digest.json', exists: true, readable: true, content: {}, seed: null }],
      })
    }
    return jsonResponse({})
  }))
}

/** Row-level action buttons (they repeat per entry), excluding the filter segments. */
function rowButtons(name: string): HTMLElement[] {
  return screen.getAllByRole('button', { name }).filter(button => !button.getAttribute('aria-label'))
}

async function renderPage() {
  render(<ExtensionsPage />)
  await screen.findByText('① 由 package 提供')
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  // The page remembers its tab in the URL hash — reset it so tests stay independent.
  window.history.replaceState(null, '', '#')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Extensions page', () => {
  it('renders the counts, entries and warnings from the inventory', async () => {
    stubFetch()
    await renderPage()

    expect(screen.getByText('Extensions')).toBeInTheDocument()
    expect(screen.getByText('已加载条目')).toBeInTheDocument()
    expect(screen.getByText('2 / 1')).toBeInTheDocument() // enabled / disabled
    expect(screen.getByText('pi-tsien-goal')).toBeInTheDocument()
    expect(screen.getByText('pi-tsien-code-mode')).toBeInTheDocument()
    expect(screen.getByText('需补丁版 pi')).toBeInTheDocument()
  })

  it('switches tabs and keeps the tab in the URL hash', async () => {
    stubFetch()
    await renderPage()

    fireEvent.click(screen.getByRole('tab', { name: /安装新扩展/ }))
    expect(await screen.findByText('已安装的 packages')).toBeInTheDocument()
    expect(screen.getByText('安装 / 更新 / 卸载')).toBeInTheDocument()
    expect(screen.getByText('GitHub 装齐 25 个')).toBeInTheDocument()
    expect(window.location.hash).toBe('#install')

    fireEvent.click(screen.getByRole('tab', { name: /配置/ }))
    expect(await screen.findByText('bash-digest')).toBeInTheDocument()
    expect(screen.getByText(/1\/1 个配置文件已存在/)).toBeInTheDocument()
    expect(window.location.hash).toBe('#config')

    fireEvent.click(screen.getByRole('tab', { name: /审计与诊断/ }))
    expect(await screen.findByText(/读取提示/)).toBeInTheDocument()
    expect(window.location.hash).toBe('#diagnostics')
  })

  it('shows the declared package rows in the install tab', async () => {
    stubFetch({
      list: {
        ...INVENTORY,
        packages: [
          {
            id: 'pi-tsien-goal',
            rawSource: 'npm:pi-tsien-goal',
            form: 'string',
            sourceKind: 'npm',
            resolved: '/home/u/.pi/agent/npm/node_modules/pi-tsien-goal',
            exists: true,
            kind: 'npm',
            unresolvedVars: [],
            resolvedBase: null,
            name: 'pi-tsien-goal',
            version: '0.1.0',
            description: null,
            declaredEntries: ['./src/index.ts'],
            filters: {},
            autoload: true,
          },
        ],
      },
    })
    await renderPage()

    fireEvent.click(screen.getByRole('tab', { name: /安装新扩展/ }))
    const row = (await screen.findByText('pi-tsien-goal')).closest('div')!
    expect(within(row).getByText('npm')).toBeInTheDocument()
    expect(within(row).getByText('string')).toBeInTheDocument()
    expect(within(row).getByText('1 entries')).toBeInTheDocument()
    expect(within(row).getByText('卸载')).toBeInTheDocument()
  })

  it('filters by text and by state', async () => {
    stubFetch()
    await renderPage()

    fireEvent.change(screen.getByLabelText('过滤扩展条目'), { target: { value: 'code-mode' } })
    await waitFor(() => expect(screen.queryByText('pi-tsien-goal')).not.toBeInTheDocument())
    expect(screen.getByText('pi-tsien-code-mode')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('过滤扩展条目'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '筛选状态：禁用' }))
    await waitFor(() => expect(screen.queryByText('pi-tsien-goal')).not.toBeInTheDocument())
    expect(screen.getByText('pi-tsien-code-mode')).toBeInTheDocument()
  })

  it('narrows to problem entries and expands details with the raw settings entry', async () => {
    stubFetch()
    await renderPage()

    fireEvent.click(screen.getByLabelText('只看异常'))
    await waitFor(() => expect(screen.queryByText('pi-tsien-goal')).not.toBeInTheDocument())
    expect(screen.getByText('pi-tsien-code-mode')).toBeInTheDocument()

    fireEvent.click(screen.getAllByText('详情')[0]!)
    expect(await screen.findByText('settings.json')).toBeInTheDocument()
    expect(screen.getByText('-./packages/pi-tsien-code-mode/src/index.ts')).toBeInTheDocument()
  })

  it('shows the exact write in the confirm dialog and posts the toggle', async () => {
    stubFetch()
    await renderPage()

    fireEvent.click(rowButtons('禁用')[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/→/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByText('确认写入'))
    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0]!.url).toBe('/api/pi/ext/toggle')
    expect(posts[0]!.body).toEqual({ path: '/repo/packages/pi-tsien-goal/src/index.ts', enabled: false })
  })

  it('surfaces a rejected write (401 + hint) instead of reporting success', async () => {
    stubFetch({ post: () => jsonResponse({ error: '需要浏览器认证', hint: '在终端粘贴令牌' }, 401) })
    await renderPage()

    fireEvent.click(rowButtons('禁用')[0]!)
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('确认写入'))

    expect(await screen.findByText(/需要浏览器认证/)).toBeInTheDocument()
    expect(screen.queryByText(/已禁用 pi-tsien/)).not.toBeInTheDocument()
  })

  it('closes the confirm dialog with Escape', async () => {
    stubFetch()
    await renderPage()

    fireEvent.click(rowButtons('禁用')[0]!)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posts.length).toBe(0)
  })

  it('renders the audit table and the shared-code summary', async () => {
    stubFetch()
    await renderPage()

    fireEvent.click(screen.getByRole('tab', { name: /审计与诊断/ }))
    expect(await screen.findByText('回滚')).toBeInTheDocument()
    const auditTable = screen.getAllByRole('table')[0]!
    expect(within(auditTable).getByText('安装')).toBeInTheDocument()
    expect(within(auditTable).getByText('失败')).toBeInTheDocument()
    expect(await screen.findByText(/被 2 个条目 import/)).toBeInTheDocument()
    expect(screen.getByText('ignore')).toBeInTheDocument()
    expect(screen.getByText('已截断')).toBeInTheDocument()
  })
})