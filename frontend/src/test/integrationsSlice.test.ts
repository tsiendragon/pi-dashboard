import { describe, expect, it } from 'vitest'
import reducer, { featureAttached, featureDetached, featureSnapshot } from '../store/integrationsSlice'
import type { ExtensionFeatureSnapshot } from '@shared/extension-bridge'

function snapshot(slot: string, feature: ExtensionFeatureSnapshot['feature'], revision: number, state: unknown): ExtensionFeatureSnapshot {
  return { slot, feature, apiVersion: 1, revision, generatedAt: revision, state }
}

describe('integrationsSlice', () => {
  it('keeps feature snapshots isolated by slot and rejects stale revisions', () => {
    let state = reducer(undefined, featureAttached(snapshot('a', 'btw', 2, { status: 'ready' })))
    state = reducer(state, featureAttached(snapshot('b', 'btw', 1, { status: 'closed' })))
    state = reducer(state, featureSnapshot(snapshot('a', 'btw', 1, { status: 'stale' })))
    expect((state.bySlot.a?.btw?.snapshot?.state as any).status).toBe('ready')
    expect((state.bySlot.b?.btw?.snapshot?.state as any).status).toBe('closed')
  })

  it('marks a detached feature stale without removing its last snapshot', () => {
    const initial = snapshot('a', 'subagent-workbench', 3, { conversations: [] })
    let state = reducer(undefined, featureAttached(initial))
    state = reducer(state, featureDetached(initial))
    expect(state.bySlot.a?.['subagent-workbench']?.attached).toBe(false)
    expect(state.bySlot.a?.['subagent-workbench']?.snapshot?.stale).toBe(true)
  })
})
