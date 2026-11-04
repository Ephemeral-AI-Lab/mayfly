/** Raw settings document revision checks and atomic writes under the native profile writer lock. @module */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
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

/**
 * Compare and commit while holding the same lock as native configEditor.edit.
 * Uncooperative external editors do not take this lock: their writes after the
 * last content check can still race and are not covered by this transaction.
 */
export async function writeSettingsDocument(ctx: Context, request: MayflySettingsDocumentWrite, signal: AbortSignal): Promise<MayflySettingsDocument> {
  signal.throwIfAborted()
  if (!ctx.settings.writable) throw new RemoteError('mayflyHost/settings-read-only', 'the settings document is read-only', {})
  try {
    return await withFileLock(join(ctx.profileContext.dir, 'package.json'), async () => {
      signal.throwIfAborted()
      if (!ctx.settings.writable) throw new RemoteError('mayflyHost/settings-read-only', 'the settings document is read-only', {})
      const path = await ctx.settings.prepareDocument()
      signal.throwIfAborted()
      const content = await readFile(path, 'utf8')
      signal.throwIfAborted()
      const actualRevision = revision(content)
      if (actualRevision !== request.expectedRevision) {
        throw new RemoteError('mayflyHost/settings-conflict', 'the settings document changed since it was read', {
          expectedRevision: request.expectedRevision, actualRevision,
        })
      }
      if (request.content === content) return frozen({ writable: true, content, revision: actualRevision })
      // Once admitted, the native atomic write finishes even if its caller retires.
      await writeFileAtomic(path, request.content, { mode: 0o600 })
      signal.throwIfAborted()
      const written = await readFile(path, 'utf8')
      signal.throwIfAborted()
      return frozen({ writable: ctx.settings.writable, content: written, revision: revision(written) })
    }, { signal })
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof RemoteError && (error.code === 'mayflyHost/settings-conflict' || error.code === 'mayflyHost/settings-read-only')) throw error
    throw new RemoteError('mayflyHost/settings-document-unavailable', 'the settings document could not be written', {})
  }
}
