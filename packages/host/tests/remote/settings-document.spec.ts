/**
 * Decision tests for the raw settings document surface: revision guarding on
 * every write, read-only refusal, and the closed error vocabulary.
 * @module
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { readFile, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as atomic from '@deepseek-ai/dsh-atomic-write'
import { readSettingsDocument, SettingsDocumentCoordinator, writeSettingsDocument } from '../../src/remote/settings-document.ts'
import { mkdtempTracked, registerTempDirCleanup } from '../../../mayfly/tests/core/temp-dir.ts'

vi.mock('@deepseek-ai/dsh-atomic-write', async importOriginal => {
  const actual = await importOriginal<typeof atomic>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})

registerTempDirCleanup()

/** The hash the module compares revisions by. */
function revisionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

let temporary: string | undefined

afterEach(async (): Promise<void> => {
  if (temporary !== undefined) await rm(temporary, { recursive: true, force: true })
  temporary = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** A context whose settings document is one temp file. */
async function documentContext(initial: string, writable = true): Promise<{ ctx: Context, file: string, write(content: string): Promise<void> }> {
  temporary = mkdtempTracked('mayfly-settings-')
  const file = join(temporary, 'settings.json')
  await writeFile(file, initial, 'utf8')
  const ctx = {
    profileContext: { dir: temporary },
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

  it('rejects cancellation while the native document path is being prepared', async () => {
    const controller = new AbortController()
    const context = { settings: { prepareDocument: async () => {
      controller.abort(new Error('cancelled preparation'))
      return '/unused'
    } } } as unknown as Context
    await expect(readSettingsDocument(context, controller.signal)).rejects.toThrow('cancelled preparation')
  })
})

describe('writeSettingsDocument', () => {
  it('serializes concurrent compare-and-write requests instead of losing a writer', async () => {
    const { ctx, file } = await documentContext('one')
    const coordinator = new SettingsDocumentCoordinator()
    const signal = new AbortController().signal
    const request = { expectedRevision: revisionOf('one'), content: 'two' }
    const first = coordinator.write(ctx, request, signal)
    const second = coordinator.write(ctx, { ...request, content: 'three' }, signal)
    const results = await Promise.allSettled([first, second])
    expect(results[0]?.status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'mayflyHost/settings-conflict' } })
    expect(await readFile(file, 'utf8')).toBe('two')
    await expect(coordinator.write(ctx, { expectedRevision: revisionOf('two'), content: 'four' }, signal)).resolves.toMatchObject({ content: 'four' })
  })

  it('discards a cancelled queued writer and lets subsequent writers proceed', async () => {
    const { ctx, file } = await documentContext('one')
    const coordinator = new SettingsDocumentCoordinator()
    const controller = new AbortController()
    const cancelled = coordinator.write(ctx, { expectedRevision: revisionOf('one'), content: 'cancelled' }, controller.signal)
    controller.abort(new Error('cancelled edit'))
    const next = coordinator.write(ctx, { expectedRevision: revisionOf('one'), content: 'next' }, new AbortController().signal)
    await expect(cancelled).rejects.toThrow('cancelled edit')
    await expect(next).resolves.toMatchObject({ content: 'next' })
    expect(await readFile(file, 'utf8')).toBe('next')
  })

  it('detects an uncooperative edit present before the locked revision read', async () => {
    const { ctx, file } = await documentContext('one')
    ctx.settings.prepareDocument = async () => { await writeFile(file, 'external', 'utf8'); return file }
    await expect(writeSettingsDocument(ctx, { expectedRevision: revisionOf('one'), content: 'mine' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'mayflyHost/settings-conflict', details: { actualRevision: revisionOf('external') } })
    expect(await readFile(file, 'utf8')).toBe('external')
  })

  it('uses a public failure code when the validated document cannot be written', async () => {
    const { ctx, file } = await documentContext('one')
    vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk failure'))
    await expect(writeSettingsDocument(ctx, { expectedRevision: revisionOf('one'), content: 'two' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'mayflyHost/settings-document-unavailable' })
    expect(await readFile(file, 'utf8')).toBe('one')
  })

  it('does not write when cancelled while native path preparation settles', async () => {
    const { ctx, file } = await documentContext('one')
    const controller = new AbortController()
    ctx.settings.prepareDocument = async () => {
      controller.abort(new Error('cancelled before write'))
      return file
    }
    await expect(writeSettingsDocument(ctx, { expectedRevision: revisionOf('one'), content: 'two' }, controller.signal)).rejects.toThrow('cancelled before write')
    expect(await readFile(file, 'utf8')).toBe('one')
  })

  it('coordinates independent services through the native profile writer lock', async () => {
    const { ctx, file } = await documentContext('one')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const prepare = vi.spyOn(ctx.settings, 'prepareDocument').mockImplementationOnce(async () => {
      entered.resolve(); await release.promise; return file
    })
    const first = new SettingsDocumentCoordinator().write(ctx, { expectedRevision: revisionOf('one'), content: 'two' }, new AbortController().signal)
    await entered.promise
    expect(await readFile(join(temporary!, 'package.json.lock'), 'utf8')).toContain(String(process.pid))
    const second = new SettingsDocumentCoordinator().write(ctx, { expectedRevision: revisionOf('one'), content: 'three' }, new AbortController().signal)
    expect(prepare).toHaveBeenCalledOnce()
    release.resolve()
    await expect(first).resolves.toMatchObject({ content: 'two' })
    await expect(second).rejects.toMatchObject({ code: 'mayflyHost/settings-conflict' })
    expect(await readFile(file, 'utf8')).toBe('two')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readdir(temporary!)).toEqual(['settings.json'])
  })

  it('waits for a real other-process native writer and preserves its committed content', async () => {
    const { ctx, file } = await documentContext('one')
    const modulePath = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-atomic-write')
    const child = fork(new URL('./settings-writer.mjs', import.meta.url), [modulePath, join(temporary!, 'package.json'), file], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    try {
      await once(child, 'message')
      const prepare = vi.spyOn(ctx.settings, 'prepareDocument')
      const pending = writeSettingsDocument(ctx, { expectedRevision: revisionOf('one'), content: 'mine' }, new AbortController().signal)
      expect(prepare).not.toHaveBeenCalled()
      child.send('release')
      await expect(pending).rejects.toMatchObject({ code: 'mayflyHost/settings-conflict' })
      expect(await readFile(file, 'utf8')).toBe('external')
    } finally {
      child.kill()
    }
  })

  it('retires lock acquisition on cancellation and checks writability again after waiting', async () => {
    const { ctx, file } = await documentContext('one')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holder = atomic.withFileLock(join(temporary!, 'package.json'), async () => { entered.resolve(); await release.promise })
    await entered.promise
    const controller = new AbortController()
    const cancelled = writeSettingsDocument(ctx, { expectedRevision: revisionOf('one'), content: 'cancelled' }, controller.signal)
    controller.abort(new Error('cancelled lock acquisition'))
    await expect(cancelled).rejects.toThrow('cancelled lock acquisition')
    const next = writeSettingsDocument(ctx, { expectedRevision: revisionOf('one'), content: 'next' }, new AbortController().signal)
    Object.defineProperty(ctx.settings, 'writable', { value: false })
    release.resolve(); await holder
    await expect(next).rejects.toMatchObject({ code: 'mayflyHost/settings-read-only' })
    expect(await readFile(file, 'utf8')).toBe('one')
  })

  it('lets an admitted atomic write finish when the caller retires and releases its lock', async () => {
    const { ctx, file } = await documentContext('one')
    const controller = new AbortController()
    const native = await vi.importActual<typeof atomic>('@deepseek-ai/dsh-atomic-write')
    vi.spyOn(atomic, 'writeFileAtomic').mockImplementationOnce(async (...args) => {
      controller.abort(new Error('retired after admission'))
      await native.writeFileAtomic(...args)
    })
    await expect(writeSettingsDocument(ctx, { expectedRevision: revisionOf('one'), content: 'committed' }, controller.signal))
      .rejects.toThrow('retired after admission')
    expect(await readFile(file, 'utf8')).toBe('committed')
    expect(await readdir(temporary!)).toEqual(['settings.json'])
  })
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
