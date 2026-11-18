import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, open, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncConnectorSkillDocs, syncCustomServerSkillDocs } from './provision'
import type { StoredCustomMcpServer } from '../settings/types'

describe('syncConnectorSkillDocs', () => {
  it('does not write or remove bundled docs when already cancelled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skills-cancel-'))
    try {
      await mkdir(join(dir, 'mcp-chemistry'))
      await writeFile(join(dir, 'mcp-chemistry', 'SKILL.md'), 'existing')
      const controller = new AbortController()
      controller.abort()

      await expect(syncConnectorSkillDocs(dir, [], controller.signal)).rejects.toBe(
        controller.signal.reason
      )

      expect(await readFile(join(dir, 'mcp-chemistry', 'SKILL.md'), 'utf8')).toBe('existing')
      expect(await readdir(dir)).toEqual(['mcp-chemistry'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes enabled connectors as mcp-<id>/SKILL.md and removes disabled ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skills-'))
    // A stale disabled connector directory that should be removed.
    await mkdir(join(dir, 'mcp-pubmed'), { recursive: true })
    await writeFile(join(dir, 'mcp-pubmed', 'SKILL.md'), 'stale')

    await syncConnectorSkillDocs(dir, ['chemistry', 'literature'])

    const entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-chemistry', 'mcp-literature'])
    // Claude Code discovers skills as a directory containing SKILL.md.
    expect((await stat(join(dir, 'mcp-chemistry'))).isDirectory()).toBe(true)
    const doc = await readFile(join(dir, 'mcp-chemistry', 'SKILL.md'), 'utf8')
    expect(doc).toContain('name: mcp-chemistry')
    expect(doc).toContain('source: connector')
    const literature = await readFile(join(dir, 'mcp-literature', 'SKILL.md'), 'utf8')
    for (const method of [
      'crossref_get_work',
      'crossref_get_updates',
      'datacite_search_records',
      'datacite_get_record'
    ]) {
      expect(literature).toContain(`### ${method}`)
    }
  })

  it('atomically publishes new bundled content while an open reader keeps the original bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'connector-skill-replacement-'))
    try {
      const skills = join(root, 'skills')
      const directory = join(skills, 'mcp-genes')
      const path = join(directory, 'SKILL.md')
      await mkdir(directory, { recursive: true })
      await writeFile(path, 'original connector document')
      const reader = await open(path, 'r')
      let settled = false
      const publication = syncConnectorSkillDocs(skills, ['genes'])
        .then(
          () => undefined,
          (error: unknown) => error
        )
        .finally(() => {
          settled = true
        })
      try {
        await vi.waitFor(async () => {
          const staged = (await readdir(root)).some((entry) =>
            entry.startsWith('.connector-skill-')
          )
          expect(staged || settled).toBe(true)
        })
        // Windows can forbid replacement while this reader is open. Release it before the bounded
        // rename retries run out and allow the publication to finish.
        expect(await reader.readFile('utf8')).toBe('original connector document')
      } finally {
        await reader.close()
      }
      expect(await publication).toBeUndefined()
      expect(await readFile(path, 'utf8')).toContain('name: mcp-genes')
      expect(await readdir(root)).toEqual(['skills'])
      expect(await readdir(directory)).toEqual(['SKILL.md'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('cancelled custom Connector Skill discovery', () => {
  it.each(['resolve', 'reject'] as const)(
    'preserves docs and skips subsequent servers and cleanup when discovery later %ss',
    async (outcome) => {
      const dir = await mkdtemp(join(tmpdir(), 'skills-discovery-cancel-'))
      try {
        for (const name of ['discovering', 'stale']) {
          await mkdir(join(dir, `mcp-${name}`))
          await writeFile(join(dir, `mcp-${name}`, 'SKILL.md'), `existing-${name}`)
        }
        const server: StoredCustomMcpServer = {
          id: 'discovering-id',
          name: 'discovering',
          displayName: 'Discovering',
          transport: 'stdio',
          command: 'mcp',
          enabled: true
        }
        let finishDiscovery!: () => void
        const listTools = vi.fn(
          () =>
            new Promise<[]>((resolve, reject) => {
              finishDiscovery = () =>
                outcome === 'resolve' ? resolve([]) : reject(new Error('discovery stopped'))
            })
        )
        const controller = new AbortController()
        const sync = syncCustomServerSkillDocs(
          dir,
          [server, { ...server, id: 'later-id', name: 'later' }],
          listTools,
          undefined,
          controller.signal
        )
        const settled = sync.then(
          () => undefined,
          (error: unknown) => error
        )
        await vi.waitFor(() => expect(listTools).toHaveBeenCalledOnce())
        controller.abort()
        finishDiscovery()
        expect(await settled).toBe(controller.signal.reason)

        expect(listTools).toHaveBeenCalledOnce()
        expect((await readdir(dir)).sort()).toEqual(['mcp-discovering', 'mcp-stale'])
        for (const name of ['discovering', 'stale']) {
          expect(await readFile(join(dir, `mcp-${name}`, 'SKILL.md'), 'utf8')).toBe(
            `existing-${name}`
          )
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
})
