import type { TaskConfigurationOptions, TaskSessionRuntimePermission } from '../../shared/task-api'

type TaskControlPorts = {
  specialists: {
    resolve(reference: string): Promise<{ id: string }>
  }
  configuration?: {
    listSpecialists(): Promise<TaskConfigurationOptions['specialists']>
    listComputeHosts(): Promise<TaskConfigurationOptions['computeHosts']>
    runtimePermission(sessionId: string): TaskSessionRuntimePermission | undefined
  }
}

export type { TaskControlPorts }
