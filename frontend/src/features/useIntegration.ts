import { useCallback, useEffect } from 'react'
import type { DashboardFeatureName } from '@shared/extension-bridge'
import { api } from '../api/client'
import { useAppDispatch, useAppSelector } from '../store'
import { commandFinished, commandStarted, featureSnapshot, fetchIntegrations } from '../store/integrationsSlice'

export function useIntegration<T>(slot: string | null, feature: DashboardFeatureName) {
  const dispatch = useAppDispatch()
  const state = useAppSelector(s => slot ? s.integrations.bySlot[slot]?.[feature] : undefined)

  useEffect(() => {
    if (slot) dispatch(fetchIntegrations(slot))
  }, [dispatch, slot])

  const send = useCallback(async (command: object) => {
    if (!slot) throw new Error('No active chat slot')
    dispatch(commandStarted({ slot, feature }))
    try {
      const response = await api.integrationCommand(slot, feature, command)
      try {
        const snapshot = await api.integration(slot, feature)
        dispatch(featureSnapshot(snapshot))
      } catch {}
      dispatch(commandFinished({ slot, feature }))
      return response.result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      dispatch(commandFinished({ slot, feature, error: message }))
      throw error
    }
  }, [dispatch, feature, slot])

  return {
    attached: state?.attached ?? false,
    snapshot: state?.snapshot?.state as T | undefined,
    pending: state?.pending ?? 0,
    error: state?.error,
    send,
  }
}
