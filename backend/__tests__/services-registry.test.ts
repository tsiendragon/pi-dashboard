import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listServices, probeExec, validateServiceEntry } from '../services/registry.js'

/** A probe command that exits with `code`, using the running node so the test needs no shell tools. */
const script = (source: string): string[] => [process.execPath, '-e', source]
const withProbe = (probe: unknown) => ({ id: 'vpn', label: 'VPN', probe })

describe('validateServiceEntry — probe shapes', () => {
  it('accepts an exec probe', () => {
    expect(validateServiceEntry(withProbe({ exec: ['ping', '-c1', '10.8.0.1'] }))).toBeNull()
  })

  it('accepts a url probe', () => {
    expect(validateServiceEntry(withProbe({ url: 'http://127.0.0.1:8765/health' }))).toBeNull()
  })

  it('rejects url and exec together', () => {
    expect(validateServiceEntry(withProbe({ url: 'http://127.0.0.1:1/', exec: ['true'] }))).toContain('not both')
  })

  it('rejects a probe with neither url nor exec', () => {
    expect(validateServiceEntry(withProbe({ timeoutMs: 1000 }))).toContain('probe.url or probe.exec')
  })

  it('rejects an empty or non-string exec array', () => {
    expect(validateServiceEntry(withProbe({ exec: [] }))).toContain('non-empty string array')
    expect(validateServiceEntry(withProbe({ exec: 'ping' }))).toContain('non-empty string array')
    expect(validateServiceEntry(withProbe({ exec: ['ping', 1] }))).toContain('non-empty string array')
  })

  it('rejects okStatus on an exec probe, where it has no meaning', () => {
    expect(validateServiceEntry(withProbe({ exec: ['true'], okStatus: [200] }))).toContain('url probes')
  })
})

describe('probeExec', () => {
  it('maps exit 0 to up', async () => {
    const status = await probeExec(script('process.exit(0)'))
    expect(status.status).toBe('up')
    expect(status.error).toBeUndefined()
    expect(status.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('maps a non-zero exit to down and keeps the reason the command printed', async () => {
    const status = await probeExec(script('console.error("peer unreachable"); process.exit(1)'))
    expect(status.status).toBe('down')
    expect(status.error).toContain('exit 1')
    expect(status.error).toContain('peer unreachable')
  })

  it('reports a missing binary as down instead of throwing', async () => {
    const status = await probeExec(['definitely-not-a-real-binary-xyz'])
    expect(status.status).toBe('down')
    expect(status.error).toBeTruthy()
  })

  it('kills a hanging probe at the timeout', async () => {
    const started = Date.now()
    const status = await probeExec(script('setTimeout(() => {}, 30000)'), 300)
    expect(status.status).toBe('down')
    expect(status.error).toContain('timed out after 300ms')
    expect(Date.now() - started).toBeLessThan(10000)
  })
})

describe('listServices — exec probes reach the page', () => {
  const withRegistry = async (services: unknown[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'services-registry-'))
    const configPath = join(dir, 'services.json')
    writeFileSync(configPath, JSON.stringify({ version: 1, services }), 'utf-8')
    try {
      return await listServices(configPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('marks the row up when the command exits 0', async () => {
    const { services, error } = await withRegistry([{ id: 'vpn', label: 'VPN', managed: false, probe: { exec: script('process.exit(0)') } }])
    expect(error).toBeUndefined()
    expect(services).toHaveLength(1)
    expect(services[0]?.status.status).toBe('up')
    // managed:false → monitoring only, no buttons that would need root
    expect(services[0]?.canStart).toBe(false)
    expect(services[0]?.canStop).toBe(false)
  })

  it('marks the row down with the command output as the reason', async () => {
    const { services } = await withRegistry([{ id: 'vpn', label: 'VPN', probe: { exec: script('console.error("no handshake"); process.exit(2)') } }])
    expect(services[0]?.status.status).toBe('down')
    expect(services[0]?.status.error).toContain('no handshake')
  })

  it('still fails closed on an invalid registry', async () => {
    const { services, error } = await withRegistry([{ id: 'vpn', label: 'VPN', probe: { url: 'http://127.0.0.1:1/', exec: ['true'] } }])
    expect(services).toHaveLength(0)
    expect(error).toContain('not both')
  })
})
