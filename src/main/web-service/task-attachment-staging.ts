import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { TaskRunAttachment } from '../../shared/task-api'
import { MAX_UPLOAD_CHUNK_BYTES, type UploadedAttachment } from '../../shared/uploads'
import { TaskRunnerError, type TaskAttachmentReservation } from '../tasks/task-runner'

const MAX_STAGED_ATTACHMENTS = 32
const STAGING_LIFETIME_MS = 30 * 60 * 1000
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)

const requestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !hasControlCharacter(value) && !/[/\\]/u.test(value)),
    mimeType: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !hasControlCharacter(value))
      .optional(),
    base64: z.string().max(Math.ceil(MAX_UPLOAD_CHUNK_BYTES / 3) * 4)
  })
  .strict()

type Scope = { projectId: string; sessionId: string }
type Entry = Scope & {
  upload: UploadedAttachment
  expiresAt: number
  timer: NodeJS.Timeout
  reserved: boolean
}

export class TaskAttachmentStaging {
  private readonly entries = new Map<string, Entry>()
  private staging = 0
  private disposed = false

  constructor(private readonly invoke: (channel: string, request: unknown) => Promise<unknown>) {}

  async stage(scope: Scope, input: unknown): Promise<TaskRunAttachment> {
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success || parsed.data.name === '.' || parsed.data.name === '..') {
      throw new TaskRunnerError('invalid_request', 'Invalid attachment upload request.')
    }
    const { name, mimeType, base64 } = parsed.data
    const bytes = Buffer.from(base64, 'base64')
    if (
      !bytes.length ||
      bytes.length > MAX_UPLOAD_CHUNK_BYTES ||
      bytes.toString('base64') !== base64
    ) {
      throw new TaskRunnerError(
        'invalid_request',
        'Attachment bytes must be non-empty valid base64, up to 8 MiB.'
      )
    }
    if (this.disposed || this.entries.size + this.staging >= MAX_STAGED_ATTACHMENTS) {
      throw new TaskRunnerError(
        'attachment_staging_unavailable',
        'Attachment staging is full or stopping.'
      )
    }

    const id = randomUUID()
    this.staging += 1
    try {
      await this.invoke('uploads:begin-transfer', {
        transferId: id,
        name,
        ...(mimeType ? { mimeType } : {}),
        size: bytes.length
      })
      await this.invoke('uploads:append-transfer', { transferId: id, offset: 0, chunk: bytes })
      const upload = (await this.invoke('uploads:finish-transfer', {
        transferId: id
      })) as UploadedAttachment
      if (this.disposed) {
        await this.deletePending(upload)
        throw new TaskRunnerError(
          'attachment_staging_unavailable',
          'Attachment staging is stopping.'
        )
      }
      const expiresAt = Date.now() + STAGING_LIFETIME_MS
      const timer = setTimeout(() => {
        const entry = this.entries.get(id)
        if (entry && !entry.reserved) {
          this.entries.delete(id)
          void this.deletePending(upload)
        }
      }, STAGING_LIFETIME_MS)
      timer.unref()
      this.entries.set(id, { ...scope, upload, expiresAt, timer, reserved: false })
      return { id, name: upload.originalName, size: upload.size, expiresAt }
    } catch (error) {
      await this.invoke('uploads:abort-transfer', { transferId: id }).catch(() => undefined)
      throw error
    } finally {
      this.staging -= 1
    }
  }

  reserve(scope: Scope, ids: readonly string[]): TaskAttachmentReservation {
    const entries = ids.map((id) => {
      const entry = this.entries.get(id)
      if (
        !entry ||
        entry.reserved ||
        entry.expiresAt <= Date.now() ||
        entry.projectId !== scope.projectId ||
        entry.sessionId !== scope.sessionId
      ) {
        throw new TaskRunnerError(
          'attachment_not_found',
          'Staged attachment is unavailable in this session.'
        )
      }
      return { id, entry }
    })
    for (const { entry } of entries) {
      entry.reserved = true
      clearTimeout(entry.timer)
    }
    const uploads = entries.map(({ entry }) => entry.upload)
    return {
      finalize: async (): Promise<UploadedAttachment[]> => {
        const finalized = (await this.invoke('uploads:finalize-session', {
          ...scope,
          attachments: uploads
        })) as UploadedAttachment[]
        if (finalized.length !== uploads.length || finalized.some((upload) => !upload.versionId)) {
          throw new Error('Attachment publication did not return all immutable Versions.')
        }
        return finalized
      },
      dispose: async (): Promise<void> => {
        await Promise.all(
          entries.map(async ({ id, entry }) => {
            this.entries.delete(id)
            await this.deletePending(entry.upload)
          })
        )
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const entries = [...this.entries]
    await Promise.all(
      entries.map(async ([id, entry]) => {
        if (entry.reserved) return
        this.entries.delete(id)
        clearTimeout(entry.timer)
        await this.deletePending(entry.upload)
      })
    )
  }

  private async deletePending(upload: UploadedAttachment): Promise<void> {
    await this.invoke('uploads:delete', { path: upload.path }).catch(() => undefined)
  }
}
