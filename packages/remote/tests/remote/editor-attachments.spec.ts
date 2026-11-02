/** Native image policy, reversible markers, file receipts and exact Session attachment reads. @module */
import type { ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/client'
import type { MayflyComponents } from '@ephemeral-ai/mayfly/core'
import { describe, expect, it, vi } from 'vitest'
import { EditorAttachments, formatImageSize, imageMarker, sniffImageMediaType } from '../../src/remote/editor/attachments.ts'
import type { EditorUpload } from '../../src/remote/editor/types.ts'
import { deferred, denied, wire } from './editor-feature-fixture.ts'

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const limits: ImageAttachmentLimits = { maxImageBytes: 100, maxMessageImageBytes: 200, maxImagesPerMessage: 3, maxImageDimension: 100, maxImagePixels: 10_000, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }
const formats: Array<[ImageMediaType, Uint8Array, string]> = [
  ['image/png', png, 'png'], ['image/jpeg', new Uint8Array([255, 216, 255]), 'jpg'],
  ['image/gif', new Uint8Array(Buffer.from('GIF8')), 'gif'], ['image/webp', new Uint8Array(Buffer.from('RIFF0000WEBP')), 'webp'],
]
const receipt = { receiptId: 'receipt', file: { attachmentId: 'file-id', name: 'report].txt', bytes: 3 } } as FileUploadValue

function fixture() {
  let policy: unknown = limits
  const host = wire('attachment-host')
  const imageDimensions = vi.fn((): { width: number, height: number } | undefined => ({ width: 1, height: 1 }))
  const upload = vi.fn<EditorUpload>(async () => ({ ok: true, value: receipt }))
  const read = vi.fn(async () => ({ ok: true as const, value: { data: png } }))
  Object.assign(host.selected.session, { projections: { faceOf: () => ({ getSnapshot: () => policy }) }, readAttachment: read })
  const attachments = new EditorAttachments({ imageDimensions } as unknown as MayflyComponents, upload)
  return { attachments, host, upload, read, imageDimensions, policy(value: unknown) { policy = value } }
}

describe('image marker policy and bytes', () => {
  it('formats byte units and recognizes only admitted image signatures', () => {
    expect([0, 1023, 1024, 1024 * 1024].map(formatImageSize)).toEqual(['0 B', '1023 B', '1 KB', '1.0 MB'])
    expect(imageMarker(2, 1024)).toBe('[image #2 1 KB]')
    for (const [type, bytes] of formats) expect(sniffImageMediaType(bytes)).toBe(type)
    for (const bytes of [new Uint8Array(), new Uint8Array([137]), Buffer.from('RIFF0000nope'), Buffer.from('not an image')]) expect(sniffImageMediaType(bytes)).toBeUndefined()
  })

  it('refuses absent or malformed native limits and returns only positive safe integer policies', () => {
    const f = fixture()
    expect(f.attachments.limits(undefined)).toBeUndefined()
    for (const policy of [null, 'policy', {}, { ...limits, mediaTypes: null }, ...['maxImageBytes', 'maxImagesPerMessage', 'maxMessageImageBytes', 'maxImagePixels', 'maxImageDimension'].flatMap(key => [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100'].map(value => ({ ...limits, [key]: value })))]) {
      f.policy(policy)
      expect(f.attachments.limits(f.host.selected)).toBeUndefined()
    }
    expect(() => f.attachments.addImage(undefined, png, 'image/png')).toThrow('image limits are unavailable')
    f.policy(limits)
    expect(f.attachments.limits(f.host.selected)).toBe(limits)
  })

  it.each(formats)('keeps owned %s bytes, default extension and optional names', (type, bytes, extension) => {
    const f = fixture()
    const marker = f.attachments.addImage(f.host.selected, bytes, type)
    expect(f.attachments.image(marker)).toEqual({ marker, data: bytes, mediaType: type, name: `pasted-image.${extension}` })
    expect(f.attachments.image('unknown')).toBeUndefined()
    const named = f.attachments.addImage(f.host.selected, bytes, type, 'local name')
    expect(f.attachments.image(named)?.name).toBe('local name')
    expect(f.attachments.tokenSpans(`plain ${marker} [image #99 missing]`)).toEqual([{ start: 6, end: 6 + marker.length, kind: 'image' }])
    expect(f.attachments.tokenSpans('ordinary text')).toEqual([])
  })

  it('refuses unsupported declarations, unrecognizable bytes, mismatches and byte/count bounds', () => {
    const f = fixture()
    f.policy({ ...limits, mediaTypes: ['image/jpeg'] })
    expect(() => f.attachments.addImage(f.host.selected, png, 'image/png')).toThrow('image type image/png is not supported')
    f.policy(limits)
    expect(() => f.attachments.addImage(f.host.selected, new Uint8Array([0]), 'image/png')).toThrow('not a recognizable PNG')
    expect(() => f.attachments.addImage(f.host.selected, png, 'image/jpeg')).toThrow('declared image/jpeg but the bytes sniff as image/png')
    f.policy({ ...limits, maxImageBytes: 7 })
    expect(() => f.attachments.addImage(f.host.selected, png, 'image/png')).toThrow('per-image byte limit')
    f.policy({ ...limits, maxImagesPerMessage: 1 })
    f.attachments.addImage(f.host.selected, png, 'image/png')
    expect(() => f.attachments.addImage(f.host.selected, png, 'image/png')).toThrow('1-image limit')
    f.policy({ ...limits, maxMessageImageBytes: 15 })
    expect(() => f.attachments.addImage(f.host.selected, png, 'image/png')).toThrow('aggregate image-byte limit')
  })

  it('requires decoded dimensions and independently bounds pixel count, width and height', () => {
    const f = fixture()
    f.imageDimensions.mockReturnValueOnce(undefined)
    expect(() => f.attachments.addImage(f.host.selected, png, 'image/png')).toThrow('dimensions could not be decoded')
    for (const size of [{ width: 101, height: 100 }, { width: 101, height: 1 }, { width: 1, height: 101 }]) {
      f.imageDimensions.mockReturnValueOnce(size)
      expect(() => f.attachments.addImage(f.host.selected, png, 'image/png')).toThrow('pixel limit')
    }
  })
})

describe('reversible structured submission attachments', () => {
  it('describes readonly original metadata and admits the exact original attachments without parsing transformed markers', async () => {
    const f = fixture()
    await f.attachments.stageFile(f.host.selected, png, 'report].txt', new AbortController().signal)
    const image = f.attachments.addImage(f.host.selected, png, 'image/png', 'original.png')
    const file = f.attachments.addFile(receipt, f.host.selected)
    const extraImage = f.attachments.addImage(f.host.selected, png, 'image/png', 'not-described.png')
    const extraFile = f.attachments.addFile({ ...receipt, receiptId: 'not-described' } as FileUploadValue, f.host.selected)
    const described = f.attachments.describe(`${file} source ${image} [image #999 unknown]`)
    expect(described.text).toBe('source  [image #999 unknown]')
    expect(described.attachments).toEqual([
      { id: receipt.receiptId, label: receipt.file.name, size: receipt.file.bytes },
      { id: image, label: 'original.png', mediaType: 'image/png', size: png.byteLength },
    ])
    expect(Object.isFrozen(described.attachments)).toBe(true)
    expect(described.attachments.every(Object.isFrozen)).toBe(true)
    expect(f.attachments.image(image)).toBeDefined()
    const literal = `/quit ${extraImage} ${extraFile}`
    const prepared = described.prepare(literal)
    expect(prepared.text).toBe(literal)
    expect(prepared.captured.content).toEqual([
      { type: 'text', text: literal }, { type: 'file', receiptId: receipt.receiptId },
      { type: 'image', mediaType: 'image/png', name: 'original.png', data: Buffer.from(png).toString('base64') },
    ])
    expect(prepared.captured.pending.map(part => part.type)).toEqual(['file', 'image'])
    prepared.captured.assertFileScope(f.host.selected)
    expect(() => prepared.captured.assertFileScope(undefined)).toThrow('different Host or Session')
    expect(f.attachments.image(image)).toBeUndefined()
    expect(f.attachments.image(extraImage)?.name).toBe('not-described.png')
    expect(f.attachments.capture(extraFile).content).toEqual([{ type: 'file', receiptId: 'not-described' }])
    prepared.captured.rollback()
    prepared.captured.rollback()
    expect(f.attachments.image(image)?.name).toBe('original.png')
    expect(f.attachments.capture(file).content).toEqual([{ type: 'file', receiptId: receipt.receiptId }])
  })

  it('skips original identities already consumed or unloaded and never resurrects a retired capture on late rollback', () => {
    const f = fixture()
    const image = f.attachments.addImage(f.host.selected, png, 'image/png')
    const file = f.attachments.addFile(receipt, f.host.selected)
    const described = f.attachments.describe(`${image}${file}`)
    const earlier = f.attachments.capture(`${image}${file}`)
    expect(described.prepare(`${image}${file}`).captured.content).toEqual([{ type: 'text', text: `${image}${file}` }])
    earlier.rollback()
    const empty = described.prepare('')
    expect(empty.captured.content.map(part => part.type)).toEqual(['image', 'file'])
    f.attachments.dispose()
    empty.captured.rollback()
    expect(f.attachments.image(image)).toBeUndefined()
    expect(described.prepare('after unload').captured).toMatchObject({ content: [{ type: 'text', text: 'after unload' }], pending: [] })
    expect(f.attachments.capture(file).content).toEqual([{ type: 'text', text: file }])
  })

  it('splits only owned markers into native parts and restores each consumed draft once', () => {
    const f = fixture()
    const marker = f.attachments.addImage(f.host.selected, png, 'image/png', 'photo.png')
    const file = f.attachments.addFile(receipt, f.host.selected)
    expect(file).toBe('[file #2 report_.txt]')
    const captured = f.attachments.capture(`before ${marker} between ${file} after [image #99 unknown]`)
    expect(captured.content).toEqual([
      { type: 'text', text: 'before ' }, { type: 'image', data: Buffer.from(png).toString('base64'), mediaType: 'image/png', name: 'photo.png' },
      { type: 'text', text: ' between ' }, { type: 'file', receiptId: 'receipt' }, { type: 'text', text: ' after [image #99 unknown]' },
    ])
    expect(captured.pending).toEqual([{ type: 'image', value: { previewUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, name: 'photo.png', width: 1, height: 1 } }])
    expect(f.attachments.image(marker)).toBeUndefined()
    captured.rollback()
    captured.rollback()
    expect(f.attachments.image(marker)?.name).toBe('photo.png')
    expect(f.attachments.capture(file).content).toEqual([{ type: 'file', receiptId: 'receipt' }])
    expect(f.attachments.capture('')).toMatchObject({ content: [{ type: 'text', text: '' }], pending: [] })
    expect(f.attachments.capture('ordinary')).toMatchObject({ content: [{ type: 'text', text: 'ordinary' }], pending: [] })
    f.attachments.dispose()
    expect(f.attachments.image(marker)).toBeUndefined()
  })

  it('keeps native file receipts under the exact upload identity and uses local copied bytes', async () => {
    const f = fixture()
    const bytes = new Uint8Array([1, 2, 3])
    const lifetime = new AbortController().signal
    expect(await f.attachments.stageFile(f.host.selected, bytes, 'notes.txt', lifetime)).toBe(receipt)
    expect(f.upload).toHaveBeenCalledWith(f.host.selected.ref.sessionId, bytes, 'notes.txt', lifetime)
    const sentBytes = f.upload.mock.calls[0]![1]
    expect(sentBytes).not.toBe(bytes)
    const marker = f.attachments.addFile(receipt, f.host.selected)
    expect(f.attachments.capture(marker).pending).toEqual([{ type: 'file', value: receipt.file }])
    f.upload.mockResolvedValueOnce(denied('upload refused') as never)
    await expect(f.attachments.stageFile(f.host.selected, bytes, undefined, lifetime)).rejects.toThrow('upload refused')
  })

  it('validates each file under its exact Host, Client, native binding, Session id and generation', () => {
    const f = fixture()
    const marker = f.attachments.addFile(receipt, f.host.selected)
    const captured = f.attachments.capture(marker)
    expect(() => captured.assertFileScope(f.host.selected)).not.toThrow()
    const owner = f.host.selected
    const other = wire('other')
    for (const selection of [
      undefined,
      { ...owner, client: other.selected.client },
      { ...owner, session: other.selected.session },
      { ...owner, ref: { ...owner.ref, host: other.selected.ref.host } },
      { ...owner, ref: { ...owner.ref, sessionId: 'other' as typeof owner.ref.sessionId } },
      { ...owner, generation: owner.generation + 1 },
    ]) expect(() => captured.assertFileScope(selection)).toThrow('File attachments belong to a different Host or Session generation')
    captured.rollback()
    expect(f.attachments.capture(marker).content).toEqual([{ type: 'file', receiptId: receipt.receiptId }])
    expect(() => f.attachments.capture('no file markers').assertFileScope(undefined)).not.toThrow()
  })

  it('keeps mixed file/image order and complete file metadata from native upload receipts', async () => {
    const f = fixture()
    await f.attachments.stageFile(f.host.selected, new Uint8Array([1, 2, 3]), 'report].txt', new AbortController().signal)
    const first = f.attachments.addFile(receipt, f.host.selected)
    const image = f.attachments.addImage(f.host.selected, png, 'image/png', 'diagram.png')
    const second = f.attachments.addFile(receipt, f.host.selected)
    const captured = f.attachments.capture(`${first} ${image} ${second}`)
    expect(captured.content.filter(part => part.type !== 'text')).toEqual([
      { type: 'file', receiptId: receipt.receiptId },
      { type: 'image', mediaType: 'image/png', name: 'diagram.png', data: Buffer.from(png).toString('base64') },
      { type: 'file', receiptId: receipt.receiptId },
    ])
    expect(captured.pending.map(part => part.type)).toEqual(['file', 'image', 'file'])
    expect(captured.pending[0]).toEqual({ type: 'file', value: receipt.file })
    expect(captured.pending[2]).toEqual({ type: 'file', value: receipt.file })
    captured.assertFileScope(f.host.selected)
  })

  it('never starts an aborted upload or retains a receipt that arrived after cancellation', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort(new Error('retired upload'))
    await expect(f.attachments.stageFile(f.host.selected, png, undefined, controller.signal)).rejects.toThrow('retired upload')
    expect(f.upload).not.toHaveBeenCalled()
    const pending = deferred<Awaited<ReturnType<typeof f.upload>>>()
    f.upload.mockReturnValueOnce(pending.promise)
    const active = new AbortController()
    const upload = f.attachments.stageFile(f.host.selected, png, 'retired.txt', active.signal)
    active.abort(new Error('late upload'))
    pending.resolve({ ok: true, value: receipt })
    await expect(upload).rejects.toThrow('late upload')
    const marker = f.attachments.addFile(receipt, f.host.selected)
    expect(f.attachments.capture(marker).pending).toEqual([])
  })

  it('reads only native addressed image attachments and can present dimensions omitted after admission', async () => {
    const f = fixture()
    const attachment = { attachmentId: 'image-id', mediaType: 'image/png' } as ImageAttachmentRef
    expect(await f.attachments.read(f.host.selected, attachment)).toBe(png)
    expect(f.read).toHaveBeenCalledWith(attachment)
    f.read.mockResolvedValueOnce(denied('image read refused') as never)
    await expect(f.attachments.read(f.host.selected, attachment)).rejects.toThrow('image read refused')
    const marker = f.attachments.addImage(f.host.selected, png, 'image/png')
    f.imageDimensions.mockReturnValueOnce(undefined)
    expect(f.attachments.capture(marker).pending).toEqual([{ type: 'image', value: { previewUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, name: 'pasted-image.png' } }])
  })
})
