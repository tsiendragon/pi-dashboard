import { describe, expect, it } from 'vitest'
import { minimalSupervisorConfig, normalizeSupervisorConfig } from '../supervisor/config.js'

describe('supervisor config persistence', () => {
  it('drops derived resource paths so moving either repo needs no config edit', () => {
    const config = normalizeSupervisorConfig({ enabled: true })
    const persisted = minimalSupervisorConfig(config)
    expect(persisted.cwd).toBeUndefined()
    expect(persisted.agentResources?.rolePath).toBeUndefined()
    expect(persisted.agentResources?.skillPaths).toBeUndefined()
    expect(persisted.agentResources?.extensionPaths).toBeUndefined()
    expect(persisted.enabled).toBe(true)
  })

  it('keeps resource paths that differ from the derived defaults', () => {
    const config = normalizeSupervisorConfig({ enabled: true, agentResources: { rolePath: '/tmp/other-role.md' } })
    const persisted = minimalSupervisorConfig(config)
    expect(persisted.agentResources?.rolePath).toBe('/tmp/other-role.md')
    expect(persisted.agentResources?.extensionPaths).toBeUndefined()
  })

  it('round-trips to the same effective config', () => {
    const config = normalizeSupervisorConfig({ enabled: true, cwd: '/tmp/supervisor-work', eventTypes: ['review'] })
    expect(normalizeSupervisorConfig(minimalSupervisorConfig(config))).toEqual(config)
  })
})