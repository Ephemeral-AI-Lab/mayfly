/** Clipboard backend admission, fallback, cooldown and temporary-stage ownership. @module */
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clipboardFailureNotice, LocalImagePaste, type ClipboardFailure } from '../../src/remote/local/image-paste.ts'
import type { LocalToolRun } from '../../src/remote/local/process.ts'

const native = vi.hoisted(() => ({ run: vi.fn(), files: vi.fn(), stage: vi.fn(), read: vi.fn(), remove: vi.fn() }))
vi.mock('../../src/remote/local/process.ts', async original => ({ ...await original(), runLocalTool: native.run }))
vi.mock('../../src/remote/local/clipboard.ts', () => ({ readCopiedPaths: native.files }))
vi.mock('node:fs/promises', () => ({ mkdtemp: native.stage, readFile: native.read, rm: native.remove }))

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const jpeg = Buffer.from([255, 216, 255])
const gif = Buffer.from('GIF8')
const limits: ImageAttachmentLimits = { maxImageBytes: 100, maxMessageImageBytes: 200, maxImagesPerMessage: 2, maxImageDimension: 4096, maxImagePixels: 16777216, mediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] }
const ok = (data: Buffer | string = ''): LocalToolRun => ({ ok: true, code: 0, killed: false, stdout: Buffer.from(data), stderr: '' })
const fail = (code: string | number = 'ENOENT', stderr = '', killed = false): LocalToolRun => ({ ok: false, code, killed, stdout: Buffer.alloc(0), stderr })
const signal = () => new AbortController().signal
const read = (backend: 'auto' | 'wayland' | 'x11' = 'wayland', lifetime = signal(), policy = limits) => new LocalImagePaste(() => backend).read(policy, lifetime)
const platform = (value: NodeJS.Platform) => { vi.stubGlobal('process', { ...process, platform: value }) }

beforeEach(() => {
  vi.stubEnv('DISPLAY', '')
  vi.stubEnv('WAYLAND_DISPLAY', '')
  vi.stubEnv('XDG_RUNTIME_DIR', '')
  native.stage.mockResolvedValue('/tmp/paste-stage')
  native.remove.mockResolvedValue(undefined)
  native.files.mockResolvedValue({ kind: 'no-image' })
  native.run.mockResolvedValue(ok())
})
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Linux image clipboard', () => {
  it('uses the configured local backend and validates declared bytes', async () => {
    const lifetime = signal()
    native.run.mockResolvedValueOnce(ok('image/png\n')).mockResolvedValueOnce(ok(png))
    expect(await read('wayland', lifetime)).toEqual({ kind: 'image', data: new Uint8Array(png), mediaType: 'image/png', backend: 'wayland', fallback: false })
    expect(native.run.mock.calls).toEqual([['wl-paste', ['-l'], { signal: lifetime }], ['wl-paste', ['-t', 'image/png'], { signal: lifetime }]])
    native.run.mockResolvedValueOnce(ok('image/jpeg')).mockResolvedValueOnce(ok(jpeg))
    expect(await read('x11')).toMatchObject({ kind: 'image', mediaType: 'image/jpeg', backend: 'x11', fallback: false })
    expect(native.run.mock.calls[2]?.slice(0, 2)).toEqual(['xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']])
    expect(native.run.mock.calls[3]?.[1]).toEqual(['-selection', 'clipboard', '-t', 'image/jpeg', '-o'])
  })

  it('respects admitted types, prefers valid later bytes and reports invalid declared images', async () => {
    native.run.mockResolvedValueOnce(ok('image/png\nimage/jpeg')).mockResolvedValueOnce(ok(jpeg))
    expect(await read('wayland', signal(), { ...limits, mediaTypes: ['image/jpeg'] })).toMatchObject({ kind: 'image', mediaType: 'image/jpeg' })
    native.run.mockResolvedValueOnce(ok('image/png\nimage/jpeg')).mockResolvedValueOnce(ok(jpeg)).mockResolvedValueOnce(ok(jpeg))
    expect(await read()).toMatchObject({ kind: 'image', mediaType: 'image/jpeg' })
    native.run.mockResolvedValueOnce(ok('image/png\nimage/jpeg')).mockResolvedValueOnce(ok('bad')).mockResolvedValueOnce(ok('bad'))
    expect(await read()).toEqual({ kind: 'failed', detail: 'wl-paste returned invalid bytes for image/png' })
    native.run.mockResolvedValueOnce(ok('image/png')).mockResolvedValueOnce(ok())
    expect(await read()).toEqual({ kind: 'no-image' })
  })

  it.each([
    [fail(), { kind: 'missing-tool' }],
    [fail('ETIMEDOUT'), { kind: 'timeout' }],
    [fail(9, 'deadline', true), { kind: 'timeout' }],
    [fail(1, 'Failed to connect to a Wayland server'), { kind: 'unreachable' }],
    [fail(1, 'cannot open display'), { kind: 'failed', detail: 'wl-paste exited with code 1: cannot open display' }],
  ])('classifies listing failures without a read: %j', async (run, expected) => {
    native.run.mockResolvedValueOnce(run)
    expect(await read()).toEqual(expected)
    expect(native.run).toHaveBeenCalledOnce()
  })

  it('interprets an empty failed X11 listing as no clipboard owner and detects display failure', async () => {
    native.run.mockResolvedValueOnce(fail(1, '  '))
    expect(await read('x11')).toEqual({ kind: 'no-image' })
    native.run.mockResolvedValueOnce(fail(1, "Can't open display"))
    expect(await read('x11')).toEqual({ kind: 'unreachable' })
    native.run.mockResolvedValueOnce(fail(1, 'bad target'))
    expect(await read('x11')).toMatchObject({ kind: 'failed' })
  })

  it('continues ordinary image read failures but stops hard failures', async () => {
    native.run.mockResolvedValueOnce(ok('image/png\nimage/jpeg')).mockResolvedValueOnce(fail(2, 'PNG unavailable')).mockResolvedValueOnce(ok(jpeg))
    expect(await read()).toMatchObject({ kind: 'image', mediaType: 'image/jpeg' })
    native.run.mockResolvedValueOnce(ok('image/png\nimage/jpeg')).mockResolvedValueOnce(fail(2, 'PNG unavailable')).mockResolvedValueOnce(fail(2, 'JPEG unavailable'))
    expect(await read()).toEqual({ kind: 'failed', detail: 'wl-paste exited with code 2: PNG unavailable' })
    native.run.mockResolvedValueOnce(ok('image/png')).mockResolvedValueOnce(fail())
    expect(await read()).toEqual({ kind: 'missing-tool' })
  })

  it('parses local copied-file URIs in order without exposing nonlocal schemes', async () => {
    native.run.mockResolvedValueOnce(ok('text/uri-list')).mockResolvedValueOnce(ok('# comment\r\nfile:///local/a%20b.png\nfile:///local/a%20b.png\nfile:///local/c.png\n'))
    native.files.mockResolvedValueOnce({ kind: 'images', images: [{ data: png, mediaType: 'image/png', name: 'a b.png' }] })
    expect(await read()).toMatchObject({ kind: 'images', backend: 'wayland', fallback: false })
    expect(native.files.mock.calls[0]?.[0]).toEqual(['/local/a b.png', '/local/c.png'])
    for (const operation of ['copy', 'cut']) {
      native.run.mockResolvedValueOnce(ok('x-special/gnome-copied-files')).mockResolvedValueOnce(ok(`${operation}\nfile:///local/image.png`))
      expect(await read()).toEqual({ kind: 'no-image' })
    }
    native.run.mockResolvedValueOnce(ok('text/uri-list\nx-special/gnome-copied-files')).mockResolvedValueOnce(ok('')).mockResolvedValueOnce(ok('copy\nfile:///local/image.png'))
    native.files.mockResolvedValueOnce({ kind: 'no-image' }).mockResolvedValueOnce({ kind: 'file-failed', detail: 'local file is too large' })
    expect(await read()).toEqual({ kind: 'file-failed', detail: 'local file is too large' })
  })

  it.each([
    ['text/uri-list', 'https://example.test/image.png', 'clipboard URI scheme https is not local'],
    ['text/uri-list', 'not a URI', 'clipboard file list contains an invalid local URI'],
    ['text/uri-list', 'file://other-machine/image.png', 'clipboard file list contains an invalid local URI'],
    ['x-special/gnome-copied-files', 'move\nfile:///local/a.png', 'GNOME copied-files data has no copy/cut operation'],
    ['x-special/gnome-copied-files', '', 'GNOME copied-files data has no copy/cut operation'],
  ])('refuses invalid copied-file data: %s %s', async (type, content, detail) => {
    native.run.mockResolvedValueOnce(ok(type)).mockResolvedValueOnce(ok(content))
    expect(await read()).toEqual({ kind: 'file-failed', detail })
    expect(native.files).not.toHaveBeenCalled()
  })

  it('reports file target read failures and unsupported-only image offers', async () => {
    native.run.mockResolvedValueOnce(ok('text/uri-list')).mockResolvedValueOnce(fail('ENOENT'))
    expect(await read()).toEqual({ kind: 'missing-tool' })
    native.run.mockResolvedValueOnce(ok('image/tiff\ntext/plain'))
    expect(await read()).toEqual({ kind: 'unsupported', mediaType: 'image/tiff' })
    native.run.mockResolvedValueOnce(ok('image/png\nimage/tiff'))
    expect(await read('wayland', signal(), { ...limits, mediaTypes: [] })).toEqual({ kind: 'no-image' })
  })

  it('orders auto probes by the local display and marks a fallback success', async () => {
    platform('linux')
    for (const [display, wayland, first, backend] of [['', 'wayland-0', 'wl-paste', 'x11'], [':1', '', 'xclip', 'wayland'], ['', '', 'wl-paste', 'x11']] as const) {
      vi.stubEnv('DISPLAY', display)
      vi.stubEnv('WAYLAND_DISPLAY', wayland)
      native.run.mockResolvedValueOnce(fail()).mockResolvedValueOnce(ok('image/png')).mockResolvedValueOnce(ok(png))
      const offset = native.run.mock.calls.length
      expect(await read('auto')).toMatchObject({ kind: 'image', backend, fallback: true })
      expect(native.run.mock.calls[offset]?.[0]).toBe(first)
    }
  })

  it('keeps the most useful failure, handles mixed missing/unreachable and stops after abort', async () => {
    platform('linux')
    native.run.mockResolvedValueOnce(fail(1, 'failed to connect to a wayland server')).mockResolvedValueOnce(fail())
    expect(await read('auto')).toEqual({ kind: 'unreachable' })
    vi.stubEnv('DISPLAY', ':1')
    native.run.mockResolvedValueOnce(fail()).mockResolvedValueOnce(fail(1, 'failed to connect to a wayland server'))
    expect(await read('auto')).toEqual({ kind: 'missing-tool' })
    vi.stubEnv('DISPLAY', '')
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0')
    native.run.mockResolvedValueOnce(fail(1, 'failed to connect to a wayland server')).mockResolvedValueOnce(fail())
    expect(await read('auto')).toEqual({ kind: 'missing-tool' })
    native.run.mockResolvedValueOnce(fail()).mockResolvedValueOnce(ok('image/tiff'))
    expect(await read('auto')).toEqual({ kind: 'unsupported', mediaType: 'image/tiff' })
    native.run.mockResolvedValueOnce(ok('text/uri-list')).mockResolvedValueOnce(ok('https://example.test/a')).mockResolvedValueOnce(fail())
    expect(await read('auto')).toMatchObject({ kind: 'file-failed' })
    const controller = new AbortController()
    native.run.mockImplementationOnce(async () => { controller.abort(); return fail('ABORT_ERR') })
    const calls = native.run.mock.calls.length
    expect(await read('auto', controller.signal)).toMatchObject({ kind: 'failed' })
    expect(native.run).toHaveBeenCalledTimes(calls + 1)
  })

  it('cools down timeouts per backend/display and retries after the deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const owner = new LocalImagePaste(() => 'wayland')
    native.run.mockResolvedValueOnce(fail('ETIMEDOUT'))
    expect(await owner.read(limits, signal())).toEqual({ kind: 'timeout' })
    expect(await owner.read(limits, signal())).toEqual({ kind: 'timeout' })
    expect(native.run).toHaveBeenCalledOnce()
    vi.stubEnv('WAYLAND_DISPLAY', 'new-display')
    expect(await owner.read(limits, signal())).toEqual({ kind: 'no-image' })
    vi.stubEnv('WAYLAND_DISPLAY', '')
    vi.advanceTimersByTime(60_000)
    expect(await owner.read(limits, signal())).toEqual({ kind: 'no-image' })
    expect(native.run).toHaveBeenCalledTimes(3)
  })

  it('handles an absent display environment as well as explicitly empty values', async () => {
    platform('linux')
    vi.stubEnv('DISPLAY', undefined)
    vi.stubEnv('WAYLAND_DISPLAY', undefined)
    vi.stubEnv('XDG_RUNTIME_DIR', undefined)
    native.run.mockResolvedValueOnce(fail(1, 'failed to connect to a wayland server')).mockResolvedValueOnce(fail())
    expect(await read('auto')).toEqual({ kind: 'unreachable' })
  })
})

describe('Windows staging', () => {
  beforeEach(() => { platform('win32') })

  it('runs an STA helper with local stage passed only through env and cleans it', async () => {
    native.read.mockResolvedValueOnce('image\n').mockResolvedValueOnce(png)
    const lifetime = signal()
    expect(await read('auto', lifetime)).toEqual({ kind: 'image', data: new Uint8Array(png), mediaType: 'image/png', backend: 'win32' })
    const [command, args, options] = native.run.mock.calls[0]!
    expect(command).toBe('powershell.exe')
    expect(args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-Command'])
    expect(args[4]).toContain('$env:MAYFLY_PASTE_STAGE')
    expect(options).toMatchObject({ signal: lifetime, timeoutMs: 10_000, env: { MAYFLY_PASTE_STAGE: '/tmp/paste-stage' } })
    expect(native.remove).toHaveBeenCalledExactlyOnceWith('/tmp/paste-stage', { recursive: true, force: true })
  })

  it('returns ordered copied-file results and still cleans staging on a local read error', async () => {
    native.read.mockResolvedValueOnce('files').mockResolvedValueOnce('one.png\r\ntwo.png\n')
    const images = [{ data: new Uint8Array(png), mediaType: 'image/png', name: 'one.png' }]
    native.files.mockResolvedValueOnce({ kind: 'images', images })
    expect(await read('auto')).toEqual({ kind: 'images', images, backend: 'win32' })
    expect(native.files.mock.calls[0]?.[0]).toEqual(['/tmp/paste-stage/files/one.png', '/tmp/paste-stage/files/two.png'])
    native.read.mockResolvedValueOnce('files').mockResolvedValueOnce('')
    expect(await read('auto')).toEqual({ kind: 'no-image' })
    native.read.mockRejectedValueOnce(Object.assign(new Error('read failed'), { code: 'EIO' }))
    native.remove.mockRejectedValueOnce(new Error('already removed'))
    expect(await read('auto')).toEqual({ kind: 'failed', detail: 'powershell.exe staging read failed (EIO)' })
    expect(native.remove).toHaveBeenCalledTimes(3)
  })

  it('describes helper absence, an empty clipboard, invalid bytes and unknown markers', async () => {
    native.run.mockResolvedValueOnce(fail(2))
    expect(await read('auto')).toEqual({ kind: 'no-image' })
    native.run.mockResolvedValueOnce(fail())
    expect(await read('auto')).toEqual({ kind: 'missing-tool' })
    native.read.mockResolvedValueOnce('image').mockResolvedValueOnce(jpeg)
    expect(await read('auto')).toEqual({ kind: 'failed', detail: 'powershell.exe returned invalid PNG bytes' })
    native.read.mockResolvedValueOnce('unknown')
    expect(await read('auto')).toEqual({ kind: 'failed', detail: 'powershell.exe did not write a clipboard staging marker' })
    expect(native.remove).toHaveBeenCalledTimes(4)
  })
})

describe('macOS staging', () => {
  beforeEach(() => { platform('darwin') })

  it.each([['PNGf', png, 'image/png'], ['JPEG picture', jpeg, 'image/jpeg'], ['GIF picture', gif, 'image/gif']] as const)('reads the advertised %s format', async (type, bytes, mediaType) => {
    native.run.mockResolvedValueOnce(ok(type.includes('picture') ? type : `«class ${type}»`))
    native.read.mockResolvedValueOnce(bytes)
    expect(await read('auto')).toEqual({ kind: 'image', data: new Uint8Array(bytes), mediaType, backend: 'darwin' })
    expect(native.run.mock.calls[0]?.slice(0, 2)).toEqual(['osascript', ['-e', 'clipboard info']])
    expect(native.run.mock.calls[1]?.[2]).toMatchObject({ timeoutMs: 5000 })
    expect(native.remove).toHaveBeenCalledOnce()
  })

  it('escapes local stage paths as AppleScript strings and reports invalid typed bytes', async () => {
    native.stage.mockResolvedValueOnce('/tmp/a"b\\c')
    native.run.mockResolvedValueOnce(ok('«class PNGf»'))
    native.read.mockResolvedValueOnce(jpeg)
    expect(await read('auto')).toEqual({ kind: 'failed', detail: 'osascript returned invalid bytes for image/png' })
    expect(native.run.mock.calls[1]?.[1]).toContain('set fileRef to open for access POSIX file "/tmp/a\\"b\\\\c/clipboard.png" with write permission')
  })

  it('classifies info/hard read failures, keeps first soft failure and tries later formats', async () => {
    native.run.mockResolvedValueOnce(fail())
    expect(await read('auto')).toEqual({ kind: 'missing-tool' })
    native.run.mockResolvedValueOnce(ok('«class PNGf»')).mockResolvedValueOnce(fail('ETIMEDOUT'))
    expect(await read('auto')).toEqual({ kind: 'timeout' })
    native.run.mockResolvedValueOnce(ok('«class PNGf», JPEG picture')).mockResolvedValueOnce(fail(1, 'bad PNG'))
    native.read.mockResolvedValueOnce(jpeg)
    expect(await read('auto')).toMatchObject({ kind: 'image', mediaType: 'image/jpeg' })
    native.run.mockResolvedValueOnce(ok('«class PNGf», JPEG picture')).mockResolvedValueOnce(fail(1, 'bad PNG')).mockResolvedValueOnce(fail(1, 'bad JPEG'))
    expect(await read('auto')).toEqual({ kind: 'failed', detail: 'osascript exited with code 1: bad PNG' })
  })

  it('converts TIFF through sips after a failed coercion and validates PNG output', async () => {
    native.run.mockResolvedValueOnce(ok('TIFF picture')).mockResolvedValueOnce(fail(1)).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok())
    native.read.mockResolvedValueOnce(png)
    expect(await read('auto')).toMatchObject({ kind: 'image', mediaType: 'image/png' })
    expect(native.run.mock.calls[3]?.slice(0, 2)).toEqual(['sips', ['-s', 'format', 'png', '/tmp/paste-stage/clipboard.tiff', '--out', '/tmp/paste-stage/clipboard.png']])
    native.run.mockResolvedValueOnce(ok('«class TIFF»')).mockResolvedValueOnce(ok()).mockResolvedValueOnce(fail())
    expect(await read('auto')).toEqual({ kind: 'missing-tool' })
    native.run.mockResolvedValueOnce(ok('«class TIFF»'))
    native.read.mockResolvedValueOnce(jpeg).mockResolvedValueOnce(jpeg)
    expect(await read('auto')).toEqual({ kind: 'failed', detail: 'macOS TIFF clipboard conversion failed' })
    native.run.mockResolvedValueOnce(ok('«class PNGf», «class TIFF»')).mockResolvedValueOnce(fail(1, 'PNG failure')).mockResolvedValueOnce(fail(1)).mockResolvedValueOnce(fail(1))
    expect(await read('auto')).toEqual({ kind: 'failed', detail: 'osascript exited with code 1: PNG failure' })
  })

  it('reads macOS copied-file lists, returns file refusals and retains soft errors', async () => {
    native.run.mockResolvedValueOnce(ok('«class furl»')).mockResolvedValueOnce(ok('/local/one.png\n\n/local/two.png\n'))
    const images = [{ data: new Uint8Array(png), mediaType: 'image/png', name: 'one.png' }]
    native.files.mockResolvedValueOnce({ kind: 'images', images })
    expect(await read('auto')).toEqual({ kind: 'images', images, backend: 'darwin' })
    expect(native.files.mock.calls[0]?.[0]).toEqual(['/local/one.png', '/local/two.png'])
    native.run.mockResolvedValueOnce(ok('«class furl»'))
    native.files.mockResolvedValueOnce({ kind: 'file-failed', detail: 'too large' })
    expect(await read('auto')).toEqual({ kind: 'file-failed', detail: 'too large' })
    native.run.mockResolvedValueOnce(ok('«class furl»'))
    expect(await read('auto')).toEqual({ kind: 'no-image' })
    native.run.mockResolvedValueOnce(ok('«class furl»')).mockResolvedValueOnce(fail(1, 'no paths'))
    expect(await read('auto')).toEqual({ kind: 'failed', detail: 'osascript exited with code 1: no paths' })
    native.run.mockResolvedValueOnce(ok('«class PNGf», «class furl»')).mockResolvedValueOnce(fail(1, 'PNG failure')).mockResolvedValueOnce(fail(1, 'no paths'))
    expect(await read('auto')).toEqual({ kind: 'failed', detail: 'osascript exited with code 1: PNG failure' })
  })

  it('reports no supported types and cleans the stage if local image bytes disappear', async () => {
    expect(await read('auto')).toEqual({ kind: 'no-image' })
    native.run.mockResolvedValueOnce(ok('«class PNGf»'))
    native.read.mockRejectedValueOnce(new Error('staging file disappeared'))
    await expect(read('auto')).rejects.toThrow('staging file disappeared')
    expect(native.remove).toHaveBeenCalledTimes(2)
  })
})

describe('clipboard failure copy', () => {
  it.each([
    [{ kind: 'missing-tool' }, 'linux', 'clipboard image tool missing: install wl-clipboard (wl-paste) or xclip'],
    [{ kind: 'missing-tool' }, 'win32', 'clipboard image tool missing: powershell.exe is unavailable'],
    [{ kind: 'missing-tool' }, 'darwin', 'clipboard image tool missing: osascript or sips is unavailable'],
    [{ kind: 'unreachable' }, 'linux', 'clipboard unreachable: DISPLAY/WAYLAND_DISPLAY is not set in this session'],
    [{ kind: 'no-image' }, 'linux', 'no image available from the clipboard'],
    [{ kind: 'unsupported', mediaType: 'image/tiff' }, 'linux', 'clipboard image type image/tiff is not supported'],
    [{ kind: 'file-failed', detail: 'too large' }, 'linux', 'clipboard image file failed: too large'],
    [{ kind: 'timeout' }, 'linux', 'clipboard read timed out'],
    [{ kind: 'failed', detail: 'unknown helper exit' }, 'linux', 'clipboard read failed: unknown helper exit'],
  ] satisfies Array<[ClipboardFailure, NodeJS.Platform, string]>)('keeps actionable reference wording for %j on %s', (result, system, text) => {
    expect(clipboardFailureNotice(result, system)).toBe(text)
  })

  it('uses the actual local platform by default', () => {
    platform('darwin')
    expect(clipboardFailureNotice({ kind: 'missing-tool' })).toContain('osascript or sips')
  })
})
