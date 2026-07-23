import type { ArtifactFile } from './artifacts'
import type { PermissionProfileId } from './permission-profiles'
import type { Project } from './projects'
import type { AgentFrameworkId, ProviderType, ReasoningEffort } from './settings'

export type TaskRunStatus = 'running' | 'completed' | 'failed'

export type StartTaskRunRequest = {
  project: string
  prompt: string
  sessionId?: string
  permissionProfile?: PermissionProfileId
  skillIds?: string[]
  workspacePath?: string
}

export type TaskRun = {
  id: string
  sessionId: string
  projectId: string
  workspacePath: string
  status: TaskRunStatus
  startedAt: number
  completedAt?: number
  output?: string
  error?: string
  artifacts: ArtifactFile[]
}

export type TaskConfiguration = {
  app: {
    version: string
    commit?: string
  }
  agent: {
    frameworkId: AgentFrameworkId
    providerId?: string
    providerType?: ProviderType
    providerName?: string
    profile?: 'shared' | 'isolated'
    model?: string
    reasoningEffort: ReasoningEffort
  }
  skillIds: string[]
  connectorIds: string[]
  customConnectors: Array<{
    id: string
    name: string
    transport: 'stdio' | 'streamable_http' | 'sse'
  }>
}

export type TaskSessionSummary = {
  id: string
  projectId: string
  title: string
  status: 'idle' | 'running' | 'waiting-permission' | 'error'
  permissionProfile?: PermissionProfileId
  createdAt: number
  updatedAt: number
  output?: string
  error?: string
  artifactCount: number
}

export type TaskProject = Project

export type AcquiredTaskArtifact = {
  resourceId: string
  url: string
  name: string
  mimeType?: string
  size: number
}

export type TaskApiErrorCode =
  | 'invalid_request'
  | 'project_not_found'
  | 'project_ambiguous'
  | 'session_not_found'
  | 'session_busy'
  | 'run_not_found'
  | 'artifact_not_found'
