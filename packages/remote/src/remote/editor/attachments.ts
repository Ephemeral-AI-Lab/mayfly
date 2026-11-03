/**
 * Node image markers, official upload/read transport, and reversible prompt parts.
 * @module @ephemeral-ai/mayfly/remote/editor/attachments
 */

import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type { PendingSubmissionAttachment } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-remotes/client'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/client'
import type { MayflyComponents } from '@ephemeral-ai/mayfly/core'
import type { EditorFeatureSession, EditorTokenSpan, EditorUpload, RemoteEditorPrepared } from './types.ts'
import type { EditorExtensionSubmitCapture } from '@ephemeral-ai/mayfly/editor-presentation'

export const IMAGE_MARKER = /\[image #\d+ [^\]]+\]/gu
export const FILE_MARKER = /\[file #\d+ [^\]]+\]/gu
const ATTACHMENT_MARKER = /\[(?:image|file) #\d+ [^\]]+\]/gu

interface LocalImage {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly name: string
}

export interface CapturedAttachments {
  readonly content: PromptContentPart[]
  readonly pending: PendingSubmissionAttachment[]
  /** Uploaded files may be submitted only under the exact scope that received them. */
  assertFileScope(selected: EditorFeatureSession | undefined): void
  rollback(): void
}

interface StagedFile {
  readonly upload: FileUploadValue
  readonly owner: EditorFeatureSession
}

interface AttachmentBinding {
  readonly marker: string
  readonly image?: LocalImage
  readonly file?: StagedFile
}

/** Every image created by this owner has an explicit local/default name. */
type CapturedPart = Exclude<PromptContentPart, { readonly type: 'image' }>
  | (Extract<PromptContentPart, { readonly type: 'image' }> & { readonly name: string })

/** Format the byte count used in the current image marker presentation. */
export function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function imageMarker(serial: number, bytes: number): string {
  return `[image #${String(serial)} ${formatImageSize(bytes)}]`
}

function startsWith(data: Uint8Array, magic: readonly number[]): boolean {
  return data.length >= magic.length && magic.every((byte, index) => data[index] === byte)
}

/** Identify admitted image bytes independently of their clipboard-declared type. */
export function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data.subarray(8), [0x57, 0x45, 0x42, 0x50])) return 'image/webp'
  return undefined
}

function isLimits(value: unknown): value is ImageAttachmentLimits {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return ['maxImageBytes', 'maxImagesPerMessage', 'maxMessageImageBytes', 'maxImagePixels', 'maxImageDimension']
    .every(key => typeof candidate[key] === 'number' && Number.isSafeInteger(candidate[key]) && (candidate[key] as number) > 0)
    && Array.isArray(candidate.mediaTypes)
}

/** Instance-owned attachments; no browser Worker, Host fs, or second upload protocol. */
export class EditorAttachments {
  private readonly images = new Map<string, LocalImage>()
  private readonly files = new Map<string, StagedFile>()
  private readonly uploads = new Map<string, FileUploadValue>()
  private serial = 0
  private disposed = false

  constructor(
    private readonly components: MayflyComponents,
    private readonly upload: EditorUpload,
  ) {}

  /** Read Host projection limits with validation at the Client projection boundary. */
  limits(selected: EditorFeatureSession | undefined): ImageAttachmentLimits | undefined {
    if (selected === undefined) return undefined
    const value: unknown = selected.session.projections.faceOf('imageLimits').getSnapshot()
    return isLimits(value) ? value : undefined
  }

  /** Validate and register one local image, returning its editor marker. */
  addImage(
    selected: EditorFeatureSession | undefined,
    data: Uint8Array,
    mediaType: ImageMediaType,
    name?: string,
  ): string {
    const limits = this.limits(selected)
    if (limits === undefined) throw new Error('image limits are unavailable for the selected Session')
    if (!limits.mediaTypes.includes(mediaType)) throw new Error(`image type ${mediaType} is not supported`)
    const sniffed = sniffImageMediaType(data)
    if (sniffed === undefined) throw new Error('image bytes are not a recognizable PNG, JPEG, GIF, or WebP')
    if (sniffed !== mediaType) throw new Error(`declared ${mediaType} but the bytes sniff as ${sniffed}`)
    if (data.byteLength > limits.maxImageBytes) throw new Error('image exceeds the per-image byte limit')
    if (this.images.size >= limits.maxImagesPerMessage) throw new Error(`image exceeds the ${String(limits.maxImagesPerMessage)}-image limit`)
    const currentBytes = [...this.images.values()].reduce((sum, image) => sum + image.data.byteLength, 0)
    if (currentBytes + data.byteLength > limits.maxMessageImageBytes) throw new Error('image exceeds the aggregate image-byte limit')
    const dimensions = this.components.imageDimensions(data)
    if (dimensions === undefined) throw new Error('image dimensions could not be decoded')
    if (dimensions.width * dimensions.height > limits.maxImagePixels
      || dimensions.width > limits.maxImageDimension
      || dimensions.height > limits.maxImageDimension) throw new Error('image exceeds the pixel limit')
    this.serial += 1
    const marker = imageMarker(this.serial, data.byteLength)
    this.images.set(marker, {
      data: new Uint8Array(data),
      mediaType,
      name: name ?? `pasted-image.${this.extension(mediaType)}`,
    })
    return marker
  }

  image(marker: string): (LocalImage & { readonly marker: string }) | undefined {
    const image = this.images.get(marker)
    return image === undefined ? undefined : { marker, ...image }
  }

  tokenSpans(line: string): readonly EditorTokenSpan[] {
    if (!line.includes('[image #')) return []
    const spans: EditorTokenSpan[] = []
    for (const match of line.matchAll(IMAGE_MARKER)) {
      if (this.images.has(match[0])) spans.push({ start: match.index, end: match.index + match[0].length, kind: 'image' })
    }
    return spans
  }

  /** Add one uploaded file receipt to the next editor submission. */
  addFile(upload: FileUploadValue, owner: EditorFeatureSession): string {
    this.serial += 1
    const marker = `[file #${String(this.serial)} ${upload.file.name.replaceAll(']', '_')}]`
    this.files.set(marker, { upload, owner })
    return marker
  }

  /** Describe without consuming bytes; admit only the exact original identities after an extension awaits. */
  describe(source: string): EditorExtensionSubmitCapture<RemoteEditorPrepared> {
    const retained: AttachmentBinding[] = []
    const attachments: Array<{ readonly id: string, readonly label: string, readonly mediaType?: string, readonly size: number }> = []
    const text = source.replace(ATTACHMENT_MARKER, marker => {
      const image = this.images.get(marker)
      const file = this.files.get(marker)
      if (image === undefined && file === undefined) return marker
      retained.push({ marker, ...image === undefined ? {} : { image }, ...file === undefined ? {} : { file } })
      attachments.push(Object.freeze(image === undefined
        ? { id: file!.upload.receiptId, label: file!.upload.file.name, size: file!.upload.file.bytes }
        : { id: marker, label: image.name, mediaType: image.mediaType, size: image.data.byteLength }))
      return ''
    }).trim()
    return {
      text,
      attachments: Object.freeze(attachments),
      prepare: transformed => {
        const content: CapturedPart[] = transformed.length === 0 ? [] : [{ type: 'text', text: transformed }]
        const consumedImages: Array<readonly [string, LocalImage]> = []
        const consumedFiles: Array<readonly [string, StagedFile]> = []
        for (const { marker, image, file } of retained) {
          if (image !== undefined && this.images.get(marker) === image) {
            content.push(this.imagePart(image))
            this.images.delete(marker)
            consumedImages.push([marker, image])
          } else if (file !== undefined && this.files.get(marker) === file) {
            content.push({ type: 'file', receiptId: file.upload.receiptId })
            this.files.delete(marker)
            consumedFiles.push([marker, file])
          }
        }
        return { text: transformed, captured: this.captured(content, consumedImages, consumedFiles) }
      },
    }
  }

  /** Split known markers into official image/file parts and retain rollback until admission settles. */
  capture(text: string): CapturedAttachments {
    const content: CapturedPart[] = []
    const consumedImages: Array<readonly [string, LocalImage]> = []
    const consumedFiles: Array<readonly [string, StagedFile]> = []
    let last = 0
    for (const match of text.matchAll(ATTACHMENT_MARKER)) {
      const marker = match[0]
      const image = this.images.get(marker)
      const file = this.files.get(marker)
      if (image === undefined && file === undefined) continue
      const run = text.slice(last, match.index)
      if (run.length > 0) content.push({ type: 'text', text: run })
      if (image !== undefined) {
        content.push(this.imagePart(image))
        this.images.delete(marker)
        consumedImages.push([marker, image])
      } else {
        content.push({ type: 'file', receiptId: file!.upload.receiptId })
        this.files.delete(marker)
        consumedFiles.push([marker, file!])
      }
      last = match.index + marker.length
    }
    const tail = text.slice(last)
    if (tail.length > 0 || content.length === 0) content.push({ type: 'text', text: tail })
    return this.captured(content, consumedImages, consumedFiles)
  }

  private imagePart(image: LocalImage): Extract<CapturedPart, { readonly type: 'image' }> {
    return { type: 'image', mediaType: image.mediaType, data: Buffer.from(image.data).toString('base64'), name: image.name }
  }

  private captured(
    content: CapturedPart[],
    consumedImages: ReadonlyArray<readonly [string, LocalImage]>,
    consumedFiles: ReadonlyArray<readonly [string, StagedFile]>,
  ): CapturedAttachments {
    let rolledBack = false
    return {
      content,
      assertFileScope(selected) {
        for (const [, { owner }] of consumedFiles) {
          if (selected === undefined || owner.client !== selected.client || owner.session !== selected.session
            || owner.ref.host !== selected.ref.host || owner.ref.sessionId !== selected.ref.sessionId
            || owner.generation !== selected.generation) {
            throw new Error('File attachments belong to a different Host or Session generation; attach them again')
          }
        }
      },
      pending: content.flatMap((part): PendingSubmissionAttachment[] => {
        if (part.type === 'image') {
          const dimensions = this.components.imageDimensions(Buffer.from(part.data, 'base64'))
          return [{
            type: 'image',
            value: {
              previewUrl: `data:${part.mediaType};base64,${part.data}`,
              name: part.name,
              ...dimensions === undefined ? {} : dimensions,
            },
          }]
        }
        if (part.type === 'file') {
          const upload = this.uploads.get(part.receiptId)
          return upload === undefined ? [] : [{ type: 'file', value: upload.file }]
        }
        return []
      }),
      rollback: () => {
        if (rolledBack || this.disposed) return
        rolledBack = true
        // Serials are never reused; only this one-shot rollback restores these markers.
        for (const [marker, image] of consumedImages) this.images.set(marker, image)
        for (const [marker, file] of consumedFiles) this.files.set(marker, file)
      },
    }
  }

  /** Stage ordinary Node bytes through the exact official fileUpload Uint8Array method. */
  async stageFile(
    selected: EditorFeatureSession,
    data: Uint8Array,
    name: string | undefined,
    signal: AbortSignal,
  ): Promise<FileUploadValue> {
    signal.throwIfAborted()
    const result = await this.upload(selected.ref.sessionId, new Uint8Array(data), name, signal)
    signal.throwIfAborted()
    if (!result.ok) throw new Error(result.error.message)
    this.uploads.set(result.value.receiptId, result.value)
    return result.value
  }

  /** Resolve a durable image through the selected official Session permission scope. */
  async read(selected: EditorFeatureSession, attachment: ImageAttachmentRef): Promise<Uint8Array> {
    const result = await selected.session.readAttachment(attachment)
    if (!result.ok) throw new Error(result.error.message)
    return result.value.data
  }

  dispose(): void {
    this.disposed = true
    this.images.clear()
    this.files.clear()
    this.uploads.clear()
  }

  private extension(mediaType: ImageMediaType): string {
    switch (mediaType) {
      case 'image/png': return 'png'
      case 'image/jpeg': return 'jpg'
      case 'image/webp': return 'webp'
      case 'image/gif': return 'gif'
    }
  }
}
