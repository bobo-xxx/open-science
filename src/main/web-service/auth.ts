import { randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const TOKEN_FILE = 'web-token'
const TASK_TOKEN_FILE = 'task-token'
const COOKIE_NAME = 'open_science_web_token'

const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code

const newToken = (): string => randomBytes(32).toString('base64url')

const loadOrCreateToken = async (configRoot: string, filename: string): Promise<string> => {
  const tokenPath = join(configRoot, filename)
  await mkdir(dirname(tokenPath), { recursive: true })

  for (;;) {
    let tokenFile: FileHandle
    try {
      tokenFile = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error

      const token = newToken()
      try {
        tokenFile = await open(
          tokenPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600
        )
      } catch (createError) {
        if (hasErrorCode(createError, 'EEXIST')) continue
        throw createError
      }
      try {
        await tokenFile.chmod(0o600)
        await tokenFile.write(`${token}\n`, 0, 'utf8')
        return token
      } finally {
        await tokenFile.close()
      }
    }

    try {
      await tokenFile.chmod(0o600)
      const identity = await tokenFile.stat()
      const existing = (await tokenFile.readFile('utf8')).trim()
      if (existing.length >= 32) return existing

      const writableTokenFile = await open(tokenPath, constants.O_WRONLY | constants.O_NOFOLLOW)
      try {
        const writableIdentity = await writableTokenFile.stat()
        if (writableIdentity.dev !== identity.dev || writableIdentity.ino !== identity.ino) {
          throw new Error('Credential file changed while it was being opened.')
        }
        const token = newToken()
        await writableTokenFile.chmod(0o600)
        await writableTokenFile.truncate(0)
        await writableTokenFile.write(`${token}\n`, 0, 'utf8')
        return token
      } finally {
        await writableTokenFile.close()
      }
    } finally {
      await tokenFile.close()
    }
  }
}

const loadOrCreateWebToken = (configRoot: string): Promise<string> =>
  loadOrCreateToken(configRoot, TOKEN_FILE)

const loadOrCreateTaskToken = (configRoot: string): Promise<string> =>
  loadOrCreateToken(configRoot, TASK_TOKEN_FILE)

const safeEqual = (left: string | undefined, right: string): boolean => {
  if (!left) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

const cookieToken = (request: IncomingMessage): string | undefined => {
  const cookies = request.headers.cookie?.split(';') ?? []
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split('=')
    if (name === COOKIE_NAME) {
      try {
        return decodeURIComponent(value.join('='))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host) return false
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

const isAllowedOrigin = (request: IncomingMessage): boolean => {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      isLoopbackHost(parsed.host) &&
      parsed.host === request.headers.host
    )
  } catch {
    return false
  }
}

const bearerToken = (request: IncomingMessage): string | undefined => {
  const authorization = request.headers.authorization
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
}

const authenticateRequest = (
  request: IncomingMessage,
  url: URL,
  token: string
): { ok: boolean; queryToken: boolean; localBearer: boolean; browserCookie: boolean } => {
  const bearer = bearerToken(request)
  const query = url.searchParams.get('token') ?? undefined
  const ok =
    isLoopbackHost(request.headers.host) &&
    isAllowedOrigin(request) &&
    safeEqual(bearer ?? query ?? cookieToken(request), token)
  return {
    ok,
    queryToken: safeEqual(query, token),
    localBearer: ok && bearer !== undefined && request.headers.origin === undefined,
    browserCookie: ok && bearer === undefined && query === undefined
  }
}

const authenticateTaskRequest = (
  request: IncomingMessage,
  url: URL,
  token: string | undefined,
  allowQuery = false
): boolean =>
  token !== undefined &&
  isLoopbackHost(request.headers.host) &&
  isAllowedOrigin(request) &&
  safeEqual(
    bearerToken(request) ?? (allowQuery ? (url.searchParams.get('token') ?? undefined) : undefined),
    token
  )

const persistAuthCookie = (response: ServerResponse, token: string): void => {
  response.setHeader(
    'set-cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`
  )
}

export {
  authenticateRequest,
  authenticateTaskRequest,
  loadOrCreateTaskToken,
  loadOrCreateWebToken,
  persistAuthCookie,
  TASK_TOKEN_FILE,
  TOKEN_FILE
}
