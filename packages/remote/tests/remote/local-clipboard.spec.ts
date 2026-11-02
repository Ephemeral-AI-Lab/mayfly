/** Local clipboard delivery and copied-file admission use only local bytes. @module */
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clipboardToolsFor, copyLocalText, readCopiedImage, readCopiedPaths } from '../../src/remote/local/clipboard.ts'

const native = vi.hoisted(() => ({
  emitClipboardOsc52: vi.fn(() => false),
  runLocalTool: vi.fn(),
  open: vi.fn(),
}))
vi.mock('@ephemeral-ai/mayfly/core', () => ({ emitClipboardOsc52: native.emitClipboardOsc52 }))
vi.mock('../../src/remote/local/process.ts', async importOriginal => ({ ...await importOriginal(), runLocalTool: native.runLocalTool }))
vi.mock('node:fs/promises', () => ({ open: native.open }))
afterEach(() => { vi.clearAllMocks() })

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const limits: ImageAttachmentLimits = { maxImageBytes: 10, maxMessageImageBytes: 16, maxImagesPerMessage: 3, maxImageDimension: 4096, maxImagePixels: 16777216, mediaTypes: ['image/png'] }
const failure = (code: string | number = 'ENOENT', stderr = '') => ({ ok: false, code, killed: false, stdout: Buffer.alloc(0), stderr })
const signal = () => new AbortController().signal

function copied(bytes = png, size = bytes.length, regular = true) {
  const handle = { stat: vi.fn(async () => ({ size, isFile: () => regular })), readFile: vi.fn(async () => bytes), close: vi.fn(async () => {}) }
  native.open.mockResolvedValueOnce(handle)
  return handle
}

describe('local clipboard text', () => {
  it('uses platform-native tools in order', () => {
    expect(clipboardToolsFor('darwin')).toEqual([['pbcopy', []]])
    expect(clipboardToolsFor('win32')).toEqual([['clip.exe', []]])
    expect(clipboardToolsFor('linux')).toEqual([['wl-copy', []], ['xclip', ['-selection', 'clipboard']]])
  })

  it('emits OSC52 before trying local tools and reports a verified native delivery', async () => {
    native.runLocalTool.mockResolvedValueOnce(failure()).mockResolvedValueOnce({ ok: true })
    const lifetime = signal()
    expect(await copyLocalText('中文 $(literal)', lifetime, 'linux')).toBe('native')
    expect(native.emitClipboardOsc52).toHaveBeenCalledExactlyOnceWith('中文 $(literal)')
    expect(native.runLocalTool.mock.calls).toEqual([
      ['wl-copy', [], { input: '中文 $(literal)', signal: lifetime, maxBuffer: 65536 }],
      ['xclip', ['-selection', 'clipboard'], { input: '中文 $(literal)', signal: lifetime, maxBuffer: 65536 }],
    ])
    expect(native.emitClipboardOsc52.mock.invocationCallOrder[0]).toBeLessThan(native.runLocalTool.mock.invocationCallOrder[0]!)
  })

  it('labels OSC52-only delivery and otherwise explains all local failures', async () => {
    native.emitClipboardOsc52.mockReturnValueOnce(true)
    native.runLocalTool.mockResolvedValueOnce(failure())
    expect(await copyLocalText('text', signal(), 'darwin')).toBe('osc52')
    native.runLocalTool.mockResolvedValueOnce(failure()).mockResolvedValueOnce(failure(9, '\n display failed\nmore detail'))
    await expect(copyLocalText('text', signal(), 'linux')).rejects.toThrow('no clipboard tool is available (wl-copy not installed, xclip exited with code 9: display failed)')
  })

  it('stops local fallback after cancellation and supports the native platform default', async () => {
    const lifetime = new AbortController()
    native.runLocalTool.mockImplementationOnce(async () => { lifetime.abort(); return failure('ABORT_ERR') })
    await expect(copyLocalText('text', lifetime.signal)).rejects.toThrow('no clipboard tool is available')
    expect(native.runLocalTool).toHaveBeenCalledOnce()
  })
})

describe('copied local image files', () => {
  it('reads only a regular local image under native limits and closes its handle', async () => {
    const handle = copied()
    expect(await readCopiedImage('/local/photo.png', limits, signal())).toEqual({ data: new Uint8Array(png), mediaType: 'image/png', name: 'photo.png' })
    expect(handle.close).toHaveBeenCalledOnce()
    const flags = native.open.mock.calls[0]![1] as number
    const fs = await import('node:fs')
    expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW)
  })

  it('refuses cancellation before opening and describes local open errors', async () => {
    expect(await readCopiedImage('/local/photo.png', limits, AbortSignal.abort())).toEqual({ kind: 'file-failed', detail: 'clipboard read was cancelled' })
    expect(native.open).not.toHaveBeenCalled()
    native.open.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'ENOENT' }))
    expect(await readCopiedImage('/local/missing', limits, signal())).toEqual({ kind: 'file-failed', detail: 'missing could not be opened (ENOENT)' })
    native.open.mockRejectedValueOnce(Object.assign(new Error('symlink'), { code: 'ELOOP' }))
    expect(await readCopiedImage('/local/link', limits, signal())).toEqual({ kind: 'file-failed', detail: 'link symbolic links are not accepted' })
  })

  it('reports a local read failure and still closes the file', async () => {
    const handle = copied()
    handle.readFile.mockRejectedValueOnce(Object.assign(new Error('disk error'), { code: 'EIO' }))
    expect(await readCopiedImage('/local/photo.png', limits, signal())).toEqual({ kind: 'file-failed', detail: 'photo.png could not be read (EIO)' })
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it.each([
    ['directory', () => copied(png, 8, false), 'directory is not a regular file'],
    ['large', () => copied(png, 11), 'large exceeds the per-image byte limit'],
    ['growing', () => copied(Buffer.alloc(11), 8), 'growing exceeds the per-image byte limit'],
    ['unknown', () => copied(Buffer.from('badimage')), 'unknown is not a supported PNG, JPEG, WebP, or GIF image'],
    ['/', () => copied(png, 8, false), 'copied file is not a regular file'],
  ] as const)('refuses %s while still closing the opened file', async (name, prepare, detail) => {
    const handle = prepare()
    expect(await readCopiedImage(name, limits, signal())).toEqual({ kind: 'file-failed', detail })
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('refuses a recognized image type outside the Host media policy', async () => {
    const handle = copied()
    expect(await readCopiedImage('photo.png', { ...limits, mediaTypes: ['image/jpeg'] }, signal())).toMatchObject({ kind: 'file-failed' })
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('deduplicates copied files in order and enforces count and total-byte bounds', async () => {
    expect(await readCopiedPaths([], limits, signal())).toEqual({ kind: 'no-image' })
    expect(await readCopiedPaths(['1', '2', '3', '4'], limits, signal())).toMatchObject({ kind: 'file-failed', detail: 'copied file selection exceeds the 3-image limit' })
    expect(native.open).not.toHaveBeenCalled()
    copied(); copied()
    const two = await readCopiedPaths(['one.png', 'two.png', 'one.png'], limits, signal())
    expect(two).toMatchObject({ kind: 'images', images: [{ name: 'one.png' }, { name: 'two.png' }] })
    expect(native.open.mock.calls.map(([path]) => path)).toEqual(['one.png', 'two.png'])
    copied(); copied(); copied()
    expect(await readCopiedPaths(['1', '2', '3'], limits, signal())).toEqual({ kind: 'file-failed', detail: 'copied file selection exceeds the aggregate image-byte limit' })
  })

  it('returns the first local file refusal without reading the rest', async () => {
    copied(Buffer.from('bad'))
    expect(await readCopiedPaths(['bad', 'untouched'], limits, signal())).toMatchObject({ kind: 'file-failed' })
    expect(native.open).toHaveBeenCalledOnce()
  })
})
