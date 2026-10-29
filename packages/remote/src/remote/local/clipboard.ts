/**
 * Remote-local clipboard text delivery and bounded copied-file image reads.
 * @module @ephemeral-ai/mayfly/remote/local/clipboard
 */

import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ImageAttachmentLimits, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { emitClipboardOsc52 } from '@ephemeral-ai/mayfly/core'
import { sniffImageMediaType } from '../editor/attachments.ts'
import { failureDetail as detail, runLocalTool, type LocalToolRun } from './process.ts'

/** Ordered native clipboard tools for each Remote platform. */
export function clipboardToolsFor(platform: NodeJS.Platform): readonly (readonly [string, string[]])[] {
  if (platform === 'darwin') return [['pbcopy', []]]
  if (platform === 'win32') return [['clip.exe', []]]
  return [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]
}

function toolFailure(command: string, run: LocalToolRun): string {
  if (run.code === 'ENOENT') return `${command} not installed`
  return detail(command, run)
}

/** Copy through OSC52 first, then a verified local clipboard tool when available. */
export async function copyLocalText(
  text: string,
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<'native' | 'osc52'> {
  const emitted = emitClipboardOsc52(text)
  const failures: string[] = []
  for (const [command, args] of clipboardToolsFor(platform)) {
    const result = await runLocalTool(command, args, { input: text, signal, maxBuffer: 64 * 1024 })
    if (result.ok) return 'native'
    failures.push(toolFailure(command, result))
    if (signal.aborted) break
  }
  if (emitted) return 'osc52'
  throw new Error(`no clipboard tool is available (${failures.join(', ')})`)
}

/** One copied local file rejected without following its final symlink. */
export async function readCopiedImage(
  path: string,
  limits: ImageAttachmentLimits,
  signal: AbortSignal,
): Promise<SaveImageAttachment | { readonly kind: 'file-failed', readonly detail: string }> {
  const name = basename(path) || 'copied file'
  if (signal.aborted) return { kind: 'file-failed', detail: 'clipboard read was cancelled' }
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { kind: 'file-failed', detail: `${name} could not be opened (${String(code)})` }
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return { kind: 'file-failed', detail: `${name} is not a regular file` }
    if (stat.size > limits.maxImageBytes) return { kind: 'file-failed', detail: `${name} exceeds the per-image byte limit` }
    const data = await handle.readFile()
    if (data.byteLength > limits.maxImageBytes) return { kind: 'file-failed', detail: `${name} exceeds the per-image byte limit` }
    const mediaType = sniffImageMediaType(data)
    if (mediaType === undefined || !limits.mediaTypes.includes(mediaType)) {
      return { kind: 'file-failed', detail: `${name} is not a supported PNG, JPEG, WebP, or GIF image` }
    }
    return { data: new Uint8Array(data), mediaType, name }
  } finally {
    await handle.close()
  }
}

/** Read an ordered, deduplicated copied-file batch under count and aggregate-byte limits. */
export async function readCopiedPaths(
  paths: readonly string[],
  limits: ImageAttachmentLimits,
  signal: AbortSignal,
): Promise<
  | { readonly kind: 'images', readonly images: readonly SaveImageAttachment[] }
  | { readonly kind: 'no-image' }
  | { readonly kind: 'file-failed', readonly detail: string }
> {
  const unique = [...new Set(paths)]
  if (unique.length === 0) return { kind: 'no-image' }
  if (unique.length > limits.maxImagesPerMessage) {
    return { kind: 'file-failed', detail: `copied file selection exceeds the ${String(limits.maxImagesPerMessage)}-image limit` }
  }
  const images: SaveImageAttachment[] = []
  let bytes = 0
  for (const path of unique) {
    const image = await readCopiedImage(path, limits, signal)
    if ('kind' in image) return image
    bytes += image.data.byteLength
    if (bytes > limits.maxMessageImageBytes) return { kind: 'file-failed', detail: 'copied file selection exceeds the aggregate image-byte limit' }
    images.push(image)
  }
  return { kind: 'images', images }
}
