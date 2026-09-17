import type { TaskFact, ProviderCapabilities } from '@shared/tasks.js'

export interface TaskCreateInput {
  title: string
  description?: string
  status?: string
  path?: string
  tags?: string[]
}

export interface TaskUpdateInput {
  title?: string
  description?: string
  status?: string
  path?: string
  tags?: string[]
}

/** A data source for tasks. Read-only sources implement `list`/`get` only. */
export interface TaskProvider {
  id: string
  label: string
  type: string
  capabilities: ProviderCapabilities
  available(): Promise<boolean>
  list(): Promise<TaskFact[]>
  get?(id: string): Promise<TaskFact | null>
  createTask?(input: TaskCreateInput): Promise<TaskFact>
  updateTask?(id: string, patch: TaskUpdateInput): Promise<TaskFact | null>
  deleteTask?(id: string): Promise<boolean>
}

export interface ProviderResult {
  providerId: string
  label: string
  type: string
  capabilities: ProviderCapabilities
  available: boolean
  tasks: TaskFact[]
  warning?: string
}
