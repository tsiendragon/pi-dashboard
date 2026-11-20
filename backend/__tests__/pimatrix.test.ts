import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claimTierCounts,
  clearPimatrixCache,
  locatePackage,
  runPimatrix,
  statusForRoot,
  findProjectRoot,
  isPimatrixPackage,
  ledgerStamp,
  mapPool,
  projectEvent,
  projectSummary,
  settingsPackagePaths,
  trimSolverRun,
} from '../pimatrix/kernel.js'
import { projectRootsUnder, registerPimatrixRoutes, resolveAllowedProject } from '../routes/pimatrix.js'
import type { RouteDeps } from '../routes/types.js'

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'pimatrix-dashboard-'))
}

describe('findProjectRoot', () => {
  it('walks up from a nested directory', () => {
    const root = fixture()
    try {
      writeFileSync(join(root, 'pimatrix.json'), '{}')
      const nested = join(root, 'proofs', 'T')
      mkdirSync(nested, { recursive: true })
      expect(findProjectRoot(nested)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns undefined when no marker exists', () => {
    const root = fixture()
    try {
      expect(findProjectRoot(root)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('settingsPackagePaths', () => {
  it('resolves local sources against the settings file and skips registries', () => {
    const root = fixture()
    try {
      writeFileSync(join(root, 'settings.json'), JSON.stringify({
        packages: [
          '/abs/pi_matrix',
          '../../repos/pi_matrix',
          { source: './relative/package', autoload: false },
          { source: 'npm:pi-tsien-memory' },
          { source: 'git:github.com/x/y' },
          { source: 'https://example.com/x.tgz' },
          42,
        ],
      }))
      const paths = settingsPackagePaths(join(root, 'settings.json'))
      expect(paths).toContain('/abs/pi_matrix')
      expect(paths).toContain(join(root, '..', '..', 'repos', 'pi_matrix'))
      expect(paths).toContain(join(root, 'relative', 'package'))
      expect(paths.some(p => p.includes('npm:'))).toBe(false)
      expect(paths.some(p => p.includes('github.com'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns an empty list for a missing or malformed file', () => {
    const root = fixture()
    try {
      expect(settingsPackagePaths(join(root, 'missing.json'))).toEqual([])
      writeFileSync(join(root, 'bad.json'), '{not json')
      expect(settingsPackagePaths(join(root, 'bad.json'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('isPimatrixPackage', () => {
  it('requires the Python kernel source', () => {
    const root = fixture()
    try {
      expect(isPimatrixPackage(root)).toBe(false)
      mkdirSync(join(root, 'verifier', 'src', 'pimatrix'), { recursive: true })
      expect(isPimatrixPackage(root)).toBe(false)
      writeFileSync(join(root, 'verifier', 'src', 'pimatrix', '__init__.py'), '')
      expect(isPimatrixPackage(root)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ledgerStamp', () => {
  it('tracks mtime and size, and reports "none" when absent', () => {
    const root = fixture()
    try {
      expect(ledgerStamp(root)).toBe('none')
      mkdirSync(join(root, 'ledger'), { recursive: true })
      writeFileSync(join(root, 'ledger', 'events.jsonl'), '{"seq":0}\n')
      const first = ledgerStamp(root)
      expect(first).toMatch(/^[\d.]+:\d+$/)
      writeFileSync(join(root, 'ledger', 'events.jsonl'), '{"seq":0}\n{"seq":1}\n')
      expect(ledgerStamp(root)).not.toBe(first)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('projectSummary', () => {
  it('projects targets, tiers and the review rule without inventing status', () => {
    const root = fixture()
    try {
      writeFileSync(join(root, 'pimatrix.json'), JSON.stringify({ title: 'Demo' }))
      const status: any = {
        project: 'demo',
        ledger: { events: 2, head: 'sha256:abc', chain_ok: true },
        review_rule: { passes_required: 3, families_required: 2 },
        targets: [{ id: 'T', status: 'reviewed', tier: 'draft', aligned: false, refines: null, statement: 'x' }],
        claims: [
          { id: 'T', tier: 'draft' },
          { id: 'L', tier: 'draft' },
          { id: 'M', tier: 'conjecture' },
        ],
        low_yield: { flag: false, events_since_progress: 4, window: 12 },
        warnings: ['alignment pending'],
      }
      const summary = projectSummary(status, root)
      expect(summary.title).toBe('Demo')
      expect(summary.id).toBe('demo')
      expect(summary.targets).toEqual([{ id: 'T', status: 'reviewed', tier: 'draft', aligned: false }])
      expect(summary.claims).toEqual({ total: 3, byTier: { draft: 2, conjecture: 1 } })
      expect(summary.reviewRule).toEqual({ passes_required: 3, families_required: 2 })
      expect(summary.warnings).toEqual(['alignment pending'])
      expect(summary.updatedAt).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('counts claims by tier', () => {
    expect(claimTierCounts([{ tier: 'draft' }, { tier: 'draft' }, { tier: 'cited' }] as any)).toEqual({ draft: 2, cited: 1 })
    expect(claimTierCounts([])).toEqual({})
  })
})

describe('projectEvent', () => {
  it('keeps claim/route/verdict facts and a compact summary', () => {
    const event = projectEvent({
      seq: 7,
      ts: '2026-01-01T00:00:00+00:00',
      type: 'review_recorded',
      data: { claim: 'L1', route: 'r1', verdict: 'fail', model: 'm', family: 'f', score: 0.5, findings: [{ huge: 'x'.repeat(5000) }] },
    })
    expect(event.seq).toBe(7)
    expect(event.claim).toBe('L1')
    expect(event.route).toBe('r1')
    expect(event.verdict).toBe('fail')
    expect(event.summary).toBe('FAIL by m (f)')
    expect(JSON.stringify(event).length).toBeLessThan(2000)
  })

  it('uses the claim id for claim_registered and the reason for attempts', () => {
    expect(projectEvent({ seq: 1, ts: '', type: 'claim_registered', data: { id: 'T', kind: 'target' } }).claim).toBe('T')
    const attempt = projectEvent({ seq: 2, ts: '', type: 'attempt_logged', data: { claim: 'L', outcome: 'abandoned', reason: 'r'.repeat(1000) } })
    expect(attempt.summary).toBe('abandoned on L')
    expect(attempt.detail?.endsWith('…')).toBe(true)
    expect(attempt.detail?.length).toBeLessThanOrEqual(300)
  })

  it('falls back to the event type for unknown records', () => {
    expect(projectEvent({ seq: 3, ts: '', type: 'future_event', data: {} }).summary).toBe('future_event')
  })
})

describe('trimSolverRun', () => {
  it('drops the candidate source and counts operations instead of returning them', () => {
    const run = trimSolverRun({
      id: 'sabc',
      claim: 'T',
      phase: 'searching',
      candidate: { path: 'runs/sabc/candidates/a.json', source: 'theorem x : True := by trivial' },
      operations: [{ kind: 'model' }, { kind: 'feedback' }],
      budget: { max_wall_seconds: 600 },
      used: { model: 1 },
      audit_status: 'not_run',
      remaining_obligations: ['o1'],
    })
    expect(run.candidate).toEqual({ path: 'runs/sabc/candidates/a.json', source_hash: undefined })
    expect(run.operations).toBe(2)
    expect(JSON.stringify(run)).not.toContain('theorem x')
  })
})

describe('projectRootsUnder', () => {
  it('accepts a project root, or scans exactly one level of children', () => {
    const root = fixture()
    try {
      const alpha = join(root, 'alpha')
      const beta = join(root, 'beta')
      mkdirSync(alpha, { recursive: true })
      mkdirSync(beta, { recursive: true })
      writeFileSync(join(alpha, 'pimatrix.json'), '{}')
      writeFileSync(join(beta, 'pimatrix.json'), '{}')
      // A project nested two levels down is not discovered: only one level is scanned.
      const nested = join(root, 'group', 'gamma')
      mkdirSync(nested, { recursive: true })
      writeFileSync(join(nested, 'pimatrix.json'), '{}')

      expect(projectRootsUnder(alpha)).toEqual([alpha])
      expect(projectRootsUnder(root).sort()).toEqual([alpha, beta])
      expect(projectRootsUnder(join(root, 'group'))).toEqual([nested])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('scans children directly instead of adopting an ancestor project', () => {
    const parent = fixture()
    try {
      writeFileSync(join(parent, 'pimatrix.json'), '{}')
      const root = join(parent, 'repos')
      const alpha = join(root, 'alpha')
      mkdirSync(alpha, { recursive: true })
      writeFileSync(join(alpha, 'pimatrix.json'), '{}')
      expect(projectRootsUnder(root)).toEqual([alpha])
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('does not authorize projects reached through an out-of-root symlink', () => {
    const root = fixture()
    const outside = fixture()
    try {
      const alpha = join(root, 'alpha')
      const nested = join(alpha, 'proofs')
      mkdirSync(nested, { recursive: true })
      writeFileSync(join(alpha, 'pimatrix.json'), '{}')
      writeFileSync(join(outside, 'pimatrix.json'), '{}')
      const alias = join(root, 'external')
      symlinkSync(outside, alias, 'dir')
      expect(projectRootsUnder(root)).toEqual([alpha])
      expect(resolveAllowedProject(nested, [root])).toBe(alpha)
      expect(() => resolveAllowedProject(alias, [root])).toThrow('outside configured')
      expect(resolveAllowedProject(alias, [outside])).toBe(outside)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('proof route boundary', () => {
  it('requires browser auth and applies the same project policy to path and slot', async () => {
    const allowed = fixture()
    const outside = fixture()
    const auth = new LiveSessionBrowserAuth({ tokenPath: join(allowed, 'control-token') })
    const app = express()
    registerPimatrixRoutes({
      app,
      manager: { getSlot: (key: string) => key === 'outside' ? { cwd: outside } : undefined },
    } as unknown as RouteDeps, auth)
    const server = app.listen(0, '127.0.0.1')
    try {
      if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve))
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      vi.stubEnv('PIMATRIX_PROJECT_ROOTS', allowed)
      vi.stubEnv('PIMATRIX_PACKAGE', join(allowed, 'intentionally-missing'))
      writeFileSync(join(allowed, 'pimatrix.json'), '{}')
      writeFileSync(join(outside, 'pimatrix.json'), '{}')
      const endpoint = `${origin}/api/pimatrix/status`
      const anonymous = await fetch(endpoint, { headers: { Origin: origin } })
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers.get('cache-control')).toBe('private, no-store')
      await auth.start()
      const result = await auth.authenticate(readFileSync(auth.tokenPath, 'utf8'), false)
      expect(result).toBeDefined()
      const cookie = result!.setCookie.split(';')[0]
      const crossOrigin = await fetch(endpoint, { headers: { Cookie: cookie, Origin: 'http://unrelated.invalid' } })
      expect(crossOrigin.status).toBe(403)
      const headers = { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', Referer: `${origin}/plugin/proof` }
      for (const query of [`path=${encodeURIComponent(outside)}`, 'slot=outside']) {
        const rejected = await fetch(`${endpoint}?${query}`, { headers })
        expect(rejected.status).toBe(403)
        expect(await rejected.json()).toMatchObject({ code: 'project_not_allowed' })
      }
      const authorized = await fetch(`${endpoint}?path=${encodeURIComponent(allowed)}`, { headers })
      expect(authorized.status).toBe(503)
      expect(await authorized.json()).toMatchObject({ code: 'kernel_unavailable' })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await auth.stop()
      vi.unstubAllEnvs()
      rmSync(allowed, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('trusted status kernel', () => {
  it('ignores project package settings, coalesces refreshes and discards superseded reads', async () => {
    const root = fixture()
    const agent = join(root, 'agent')
    const project = join(root, 'project')
    const trusted = join(root, 'trusted')
    const projectPackage = join(root, 'project-package')
    const ledger = join(project, 'ledger', 'events.jsonl')
    const release = join(project, 'release')
    const source = (base: string) => join(base, 'verifier', 'src', 'pimatrix')
    const reads: Promise<unknown>[] = []
    try {
      for (const dir of [agent, join(project, '.pi'), join(project, 'ledger'), source(trusted), source(projectPackage)]) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [trusted] }))
      writeFileSync(join(project, '.pi', 'settings.json'), JSON.stringify({ packages: [projectPackage] }))
      writeFileSync(join(source(projectPackage), '__init__.py'), '')
      writeFileSync(join(source(trusted), '__init__.py'), '')
      writeFileSync(join(source(trusted), '__main__.py'), `
import json, sys, time
from pathlib import Path
project = Path(sys.argv[sys.argv.index('-C') + 1])
version = (project / 'ledger' / 'events.jsonl').read_text()
with (project / 'calls').open('a') as f:
    f.write(version + '\\n')
if version == 'old':
    while not (project / 'release').exists():
        time.sleep(0.01)
print(json.dumps(dict(ok=True, project=version, cwd=str(Path.cwd()), targets=[], claims=[], ledger={})))
`)
      vi.stubEnv('PI_CODING_AGENT_DIR', agent)
      vi.stubEnv('PIMATRIX_PACKAGE', undefined)
      vi.stubEnv('PIMATRIX_PYTHON', undefined)
      expect(locatePackage()).toBe(trusted)
      writeFileSync(ledger, 'old')
      const older = statusForRoot(project, { force: true, timeoutMs: 5000 })
      const coalesced = statusForRoot(project, { force: true, timeoutMs: 5000 })
      reads.push(older, coalesced)
      await vi.waitFor(() => expect(existsSync(join(project, 'calls'))).toBe(true))
      writeFileSync(ledger, 'new-version')
      const fresh = await statusForRoot(project, { force: true, timeoutMs: 5000 })
      expect(fresh.status).toMatchObject({ project: 'new-version', cwd: trusted })
      expect(fresh.meta.stale).toBe(false)
      writeFileSync(release, '')
      const results = await Promise.all([older, coalesced])
      expect(results[0]).toBe(results[1])
      expect(results[0].meta).toMatchObject({ stale: true, error: 'ledger changed during the status read' })
      expect(results[0].meta.ledgerStamp).toBeUndefined()
      expect(await statusForRoot(project)).toBe(fresh)
      expect(readFileSync(join(project, 'calls'), 'utf8')).toBe('old\nnew-version\n')
      vi.stubEnv('PIMATRIX_PACKAGE', join(root, 'missing'))
      expect((await runPimatrix(['status'], { root: project })).json.ok).toBe(false)
    } finally {
      if (existsSync(project)) writeFileSync(release, '')
      await Promise.allSettled(reads)
      clearPimatrixCache()
      vi.unstubAllEnvs()
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)
})

describe('mapPool', () => {
  it('preserves input order under bounded concurrency', async () => {
    const result = await mapPool([1, 2, 3, 4, 5], 2, async n => {
      await new Promise(resolve => setTimeout(resolve, (6 - n) * 2))
      return n * 10
    })
    expect(result).toEqual([10, 20, 30, 40, 50])
  })
})
