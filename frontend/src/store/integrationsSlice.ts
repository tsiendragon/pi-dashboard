import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { DashboardFeatureName, ExtensionFeatureSnapshot } from '@shared/extension-bridge'
import { api } from '../api/client'

type FeatureState = {
  attached: boolean
  snapshot?: ExtensionFeatureSnapshot
  pending: number
  error?: string
}

type IntegrationsState = {
  bySlot: Record<string, Partial<Record<DashboardFeatureName, FeatureState>>>
}

const initialState: IntegrationsState = { bySlot: {} }

export const fetchIntegrations = createAsyncThunk(
  'integrations/fetch',
  async (slot: string) => ({ slot, integrations: await api.integrations(slot) as ExtensionFeatureSnapshot[] }),
)

const slice = createSlice({
  name: 'integrations',
  initialState,
  reducers: {
    featureAttached(state, action: PayloadAction<ExtensionFeatureSnapshot>) {
      const snapshot = action.payload
      const slot = state.bySlot[snapshot.slot] ??= {}
      slot[snapshot.feature] = { attached: true, snapshot, pending: slot[snapshot.feature]?.pending ?? 0 }
    },
    featureSnapshot(state, action: PayloadAction<ExtensionFeatureSnapshot>) {
      const snapshot = action.payload
      const slot = state.bySlot[snapshot.slot] ??= {}
      const current = slot[snapshot.feature]
      if (current?.snapshot && current.snapshot.revision > snapshot.revision) return
      slot[snapshot.feature] = { attached: true, snapshot, pending: current?.pending ?? 0 }
    },
    featureDetached(state, action: PayloadAction<ExtensionFeatureSnapshot>) {
      const snapshot = action.payload
      const slot = state.bySlot[snapshot.slot] ??= {}
      slot[snapshot.feature] = {
        attached: false,
        snapshot: { ...snapshot, stale: true },
        pending: 0,
      }
    },
    commandStarted(state, action: PayloadAction<{ slot: string; feature: DashboardFeatureName }>) {
      const features = state.bySlot[action.payload.slot] ??= {}
      const current = features[action.payload.feature] ?? { attached: false, pending: 0 }
      current.pending += 1
      current.error = undefined
      features[action.payload.feature] = current
    },
    commandFinished(state, action: PayloadAction<{ slot: string; feature: DashboardFeatureName; error?: string }>) {
      const current = state.bySlot[action.payload.slot]?.[action.payload.feature]
      if (!current) return
      current.pending = Math.max(0, current.pending - 1)
      current.error = action.payload.error
    },
    clearSlotIntegrations(state, action: PayloadAction<string>) {
      delete state.bySlot[action.payload]
    },
  },
  extraReducers: builder => {
    builder.addCase(fetchIntegrations.fulfilled, (state, action) => {
      const features = state.bySlot[action.payload.slot] ??= {}
      for (const snapshot of action.payload.integrations) {
        const current = features[snapshot.feature]
        if (!current?.snapshot || current.snapshot.revision <= snapshot.revision) {
          features[snapshot.feature] = { attached: true, snapshot, pending: current?.pending ?? 0 }
        }
      }
    })
  },
})

export const {
  featureAttached,
  featureSnapshot,
  featureDetached,
  commandStarted,
  commandFinished,
  clearSlotIntegrations,
} = slice.actions

export default slice.reducer
