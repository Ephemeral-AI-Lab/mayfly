/**
 * Decision tests for the raw settings document surface: revision guarding on
 * every write, read-only refusal, and the closed error vocabulary.
 * @module
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { readSettingsDocument, writeSettingsDocument } from '../../src/remote/settings-document.ts'

/** The hash the module compares revisions by. */
function revisionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

let temporary: string | undefined

afterEach(async (): Promise<void> => {
  if (temporary !== undefined) await rm(temporary, { recursive: true, force: true })
  temporary = undefined
  vi.unstubAllEnvs()
})

/** A context whose settings document is one temp file. */
async function documentContext(initial: string, writable = true): Promise<{ ctx: Context, file: string, write(content: string): Promise<void> }> {
  temporary = await mkdtemp(join(tmpdir(), 'mayfly-settings-'))
  const file = join(temporary, 'settings.json')
  await writeFile(file, initial, 'utf8')
  const ctx = {
    settings: {
      writable,
      prepareDocument: async (): Promise<string> => file,
    },
  } as unknown as Context
  return { ctx, file, write: async (content: string): Promise<void> => { await writeFile(file, content, 'utf8') } }
}

describe('readSettingsDocument', () => {
  it('reads the exact document with its content hash and writability', async () => {
    const { ctx } = await documentContext('{ "theme": "dark" }\n')
    const document = await readSettingsDocument(ctx, new AbortController().signal)
    expect(document.content).toBe('{ "theme": "dark" }\n')
    expect(document.revision).toBe(revisionOf('{ "theme": "dark" }\n'))
    expect(document.writable).toBe(true)
    expect(Object.isFrozen(document)).toBe(true)
  })

  it('refuses with a named code when the document cannot be read', async () => {
    const { ctx, file } = await documentContext('{}')
    await rm(file)
    await expect(readSettingsDocument(ctx, new AbortController().signal))
      .rejects.toMatchObject({ code: 'mayflyHost/settings-document-unavailable' })
  })

  it('propagates an abort instead of masking it as a read failure', async () => {
    const { ctx } = await documentContext('{}')
    const controller = new AbortController()
    controller.abort()
    await expect(readSettingsDocument(ctx, controller.signal)).rejects.toThrow()
  })
})

describe('writeSettingsDocument', () => {
  it('writes the new content only when the revision matches, and returns the next revision', async () => {
    const { ctx, file } = await documentContext('one')
    const before = await readSettingsDocument(ctx, new AbortController().signal)
    const after = await writeSettingsDocument(ctx, { content: 'two', expectedRevision: before.revision }, new AbortController().signal)
    expect(after.content).toBe('two')
    expect(after.revision).toBe(revisionOf('two'))
    expect(await readFile(file, 'utf8')).toBe('two')
  })

  it('refuses a stale revision with the conflict code and both revisions', async () => {
    const { ctx, write } = await documentContext('one')
    const before = await readSettingsDocument(ctx, new AbortController().signal)
    await write('changed elsewhere')
    await expect(writeSettingsDocument(ctx, { content: 'mine', expectedRevision: before.revision }, new AbortController().signal))
      .rejects.toMatchObject({
        code: 'mayflyHost/settings-conflict',
        details: { expectedRevision: before.revision, actualRevision: revisionOf('changed elsewhere') },
      })
    // The other writer's content stays on disk.
    expect(await readFile((await (ctx as unknown as { settings: { prepareDocument(): Promise<string> } }).settings.prepareDocument()), 'utf8')).toBe('changed elsewhere')
  })

  it('returns the current document unchanged when the content is identical', async () => {
    const { ctx } = await documentContext('same')
    const before = await readSettingsDocument(ctx, new AbortController().signal)
    const after = await writeSettingsDocument(ctx, { content: 'same', expectedRevision: before.revision }, new AbortController().signal)
    // The identical write is not performed; the document comes back equal.
    expect(after).toEqual(before)
  })

  it('refuses to write at all while the document is read-only', async () => {
    const { ctx } = await documentContext('frozen', false)
    const before = await readSettingsDocument(ctx, new AbortController().signal)
    await expect(writeSettingsDocument(ctx, { content: 'new', expectedRevision: before.revision }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'mayflyHost/settings-read-only' })
  })
})
