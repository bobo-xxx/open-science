export type PermissionProfile = 'ask' | 'auto' | 'full'
export type RunStatus = 'running' | 'completed' | 'failed'

export type Project = {
  id: string
  name: string
  description: string
  isExample: boolean
  createdAt: number
  updatedAt: number
}

export type Run = {
  id: string
  sessionId: string
  projectId: string
  workspacePath: string
  status: RunStatus
  startedAt: number
  completedAt?: number
  output?: string
  error?: string
  artifacts: Artifact[]
}

export type Configuration = {
  app: { version: string; commit?: string }
  agent: {
    frameworkId: 'claude-code' | 'opencode' | 'codex'
    providerId?: string
    providerType?: 'custom' | 'claude-default' | 'official' | 'codex-shared' | 'codex-isolated'
    providerName?: string
    profile?: 'shared' | 'isolated'
    model?: string
    reasoningEffort: 'default' | 'low' | 'medium' | 'high' | 'max'
  }
  skillIds: string[]
  connectorIds: string[]
  customConnectors: Array<{
    id: string
    name: string
    transport: 'stdio' | 'streamable_http' | 'sse'
  }>
}

export type Session = {
  id: string
  projectId: string
  title: string
  status: 'idle' | 'running' | 'waiting-permission' | 'error'
  permissionProfile?: PermissionProfile
  createdAt: number
  updatedAt: number
  output?: string
  error?: string
  artifactCount: number
}

export type Artifact = {
  id: string
  kind: 'workspace-file' | 'external-file' | 'managed-file'
  path: string
  name?: string
  mimeType?: string
  size?: number
  mtimeMs?: number
  sha256?: string
}

export class OpenScienceApiError extends Error {
  code: string
  status?: number
}

export class OpenScienceClient {
  constructor(options: {
    baseUrl: string
    token: string
    fetch?: typeof globalThis.fetch
    sleep?: (milliseconds: number) => Promise<void>
  })
  health(): Promise<unknown>
  listProjects(): Promise<Project[]>
  createProject(request: { name: string; description?: string }): Promise<Project>
  listSessions(project?: string): Promise<Session[]>
  getSession(sessionId: string): Promise<Session>
  getConfiguration(): Promise<Configuration>
  startRun(request: {
    project: string
    prompt: string
    sessionId?: string
    permissionProfile?: PermissionProfile
    skillIds?: string[]
    workspacePath?: string
  }): Promise<Run>
  getRun(runId: string): Promise<Run>
  waitForRun(
    runId: string,
    options?: { pollIntervalMs?: number; signal?: AbortSignal; timeoutMs?: number }
  ): Promise<Run>
  listArtifacts(sessionId: string): Promise<Artifact[]>
  downloadArtifact(artifactId: string, options?: { signal?: AbortSignal }): Promise<Response>
  events(options?: {
    signal?: AbortSignal
    WebSocket?: typeof globalThis.WebSocket
  }): AsyncIterable<{
    type: 'run.event' | 'permission.requested'
    data: unknown
  }> & { ready: Promise<void> }
}

export function connectToOpenScience(options?: {
  configRoot?: string
  env?: Record<string, string | undefined>
  fetch?: typeof globalThis.fetch
}): Promise<OpenScienceClient>
