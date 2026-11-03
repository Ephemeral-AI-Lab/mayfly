/** Exact raw settings document reads and content-revision compare/write. @module */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { MayflySettingsDocument, MayflySettingsDocumentWrite } from '../types.ts'
import { frozen } from './json.ts'

function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function readDocument(ctx: Context, signal: AbortSignal): Promise<MayflySettingsDocument> {
  signal.throwIfAborted()
  try {
    const path = await ctx.settings.prepareDocument()
    signal.throwIfAborted()
    const content = await readFile(path, 'utf8')
    signal.throwIfAborted()
    return frozen({ writable: ctx.settings.writable, content, revision: revision(content) })
  } catch (error) {
    if (signal.aborted) throw error
    throw new RemoteError('mayflyHost/settings-document-unavailable', 'the settings document could not be read', {})
  }
}

/** Serialize compare-and-write operations for one Host service lifetime. */
export class SettingsDocumentCoordinator {
  private pending: Promise<unknown> = Promise.resolve()

  /** A failed or cancelled writer never prevents the next writer from checking its revision. */
  write(ctx: Context, request: MayflySettingsDocumentWrite, signal: AbortSignal): Promise<MayflySettingsDocument> {
    const operation = this.pending.then(() => writeSettingsDocument(ctx, request, signal))
    this.pending = operation.then(() => undefined, () => undefined)
    return operation
  }
}

/** Read the actual settings document; no caller-selected file path is accepted. */
export function readSettingsDocument(ctx: Context, signal: AbortSignal): Promise<MayflySettingsDocument> {
  return readDocument(ctx, signal)
}

/** Write only when the current content hash matches the caller's revision. */
export async function writeSettingsDocument(ctx: Context, request: MayflySettingsDocumentWrite, signal: AbortSignal): Promise<MayflySettingsDocument> {
  signal.throwIfAborted()
  if (!ctx.settings.writable) throw new RemoteError('mayflyHost/settings-read-only', 'the settings document is read-only', {})
  const current = await readDocument(ctx, signal)
  if (current.revision !== request.expectedRevision) {
    throw new RemoteError('mayflyHost/settings-conflict', 'the settings document changed since it was read', {
      expectedRevision: request.expectedRevision,
      actualRevision: current.revision,
    })
  }
  if (request.content === current.content) return current
  try {
    const latest = await readDocument(ctx, signal)
    if (latest.revision !== request.expectedRevision) {
      throw new RemoteError('mayflyHost/settings-conflict', 'the settings document changed since it was read', {
        expectedRevision: request.expectedRevision,
        actualRevision: latest.revision,
      })
    }
    const path = await ctx.settings.prepareDocument()
    signal.throwIfAborted()
    await writeFile(path, request.content, 'utf8')
    signal.throwIfAborted()
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof RemoteError && error.code === 'mayflyHost/settings-conflict') throw error
    throw new RemoteError('mayflyHost/settings-document-unavailable', 'the settings document could not be written', {})
  }
  return readDocument(ctx, signal)
}
