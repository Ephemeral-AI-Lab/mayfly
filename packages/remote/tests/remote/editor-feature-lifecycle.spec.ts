/** Mounted editor keyboard, local integrations and stale-result ownership. @module */
import { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentLimits, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/client'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { MayflyComponentsService, type MayflyComponent, type MayflyComponentsDeps, type MayflyFocusable, type MayflyKeymap, type MayflyScreen, type MayflySemanticColors } from '@ephemeral-ai/mayfly/core'
import * as Provider from '@ephemeral-ai/mayfly-ui/provider'
import * as Frontend from '@ephemeral-ai/mayfly/frontend'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachEditorFeatures } from '../../src/remote/editor/index.ts'
import type { EditorFeatureOptions, EditorFeatureSession, EditorToken } from '../../src/remote/editor/types.ts'
import { EditorDraftStore } from '../../src/remote/editor/utils.ts'
import { deferred, denied, flush, wire } from './editor-feature-fixture.ts'

const native = vi.hoisted(() => ({ paste: vi.fn(), edit: vi.fn(), command: vi.fn(), copy: vi.fn(), shell: vi.fn() }))
vi.mock('../../src/remote/local/image-paste.ts', async original => ({ ...await original(), LocalImagePaste: class { constructor(backend: () => string) { backend() } read = native.paste } }))
vi.mock('../../src/remote/local/external-editor.ts', () => ({ editLocalText: native.edit, resolveExternalEditorCommand: native.command }))
vi.mock('../../src/remote/local/clipboard.ts', () => ({ copyLocalText: native.copy }))
vi.mock('../../src/remote/editor/shell.ts', async original => ({ ...await original(), EditorShell: class { run = native.shell; dispose() {} } }))

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo0AAAAASUVORK5CYII=', 'base64')
const limits: ImageAttachmentLimits = { maxImageBytes: 4096, maxMessageImageBytes: 8192, maxImagesPerMessage: 3, maxImageDimension: 100, maxImagePixels: 10_000, mediaTypes: ['image/png'] }
const uploadValue = { receiptId: 'uploaded-file', file: { attachmentId: 'local-file', name: 'notes.txt', bytes: 3 } } as FileUploadValue
const owners: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of owners.splice(0)) await dispose(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers() })

async function fixture(extra: Partial<EditorFeatureOptions> = {}, withSession = true, withPrevious = true) {
  const ctx = new Context()
  await ctx.plugin(Provider)
  await ctx.plugin(Frontend)
  const host = wire('editor-host')
  let running = false
  let projection: unknown = limits
  const readAttachment = vi.fn(async () => ({ ok: true as const, value: { data: new Uint8Array(png) } }))
  Object.assign(host.selected.session, { getSnapshot: () => ({ running }), projections: { faceOf: () => ({ getSnapshot: () => projection }) }, readAttachment })
  const events = new Map<string, Set<(...args: never[]) => void>>()
  Object.assign(host.selected.client.remote, { $on: (name: string, listener: (...args: never[]) => void) => {
    const listeners = events.get(name) ?? new Set()
    events.set(name, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  } })
  let selected: EditorFeatureSession | undefined = withSession ? host.selected : undefined
  const colors = new Proxy({}, { get: () => (text: string) => text }) as MayflySemanticColors
  const requestRender = vi.fn()
  const components = new MayflyComponentsService(ctx, { theme: { colors }, tui: { requestRender } } as unknown as MayflyComponentsDeps)
  const editor = components.createEditor()
  const providers = vi.spyOn(editor, 'setAutocompleteProvider')
  const tokenSources = vi.spyOn(editor, 'setTokenSource')
  const hide = vi.fn()
  const screen = {
    columns: 80, rows: 24, screenMode: 'alternate', requestRender, setFocus: vi.fn(),
    suspend: vi.fn(async (callback: () => Promise<unknown>) => callback()),
    showOverlay: vi.fn((_component: MayflyComponent) => ({ hide })),
    mountContentSlot: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as MayflyScreen
  const offKeys = vi.fn()
  const keymap = { register: vi.fn(() => offKeys), matches: (data: string, id: string) => data === id } as unknown as MayflyKeymap
  const notice = { set: vi.fn() }
  const upload = vi.fn(async () => ({ ok: true as const, value: uploadValue }))
  const files = {
    openWorkspacePath: vi.fn(async () => ({ ok: true as const, value: { opened: true as const } })),
    stat: vi.fn(async () => ({ ok: true as const, value: { absolutePath: '/host/file', version: 'r1' } })),
    readBytes: vi.fn(async () => ({ ok: true as const, value: { absolutePath: '/host/file', version: 'r1', data: new TextEncoder().encode('Host file') } })),
  }
  const local = { list: () => [], execute: () => ({ kind: 'unhandled' as const }), cwd: () => '/remote/local', exit: vi.fn(), editorCommand: () => 'editor', clipboardBackend: () => 'x11' as const }
  const previous = { change: vi.fn(), submit: vi.fn(), key: vi.fn(() => false), token: vi.fn() }
  if (withPrevious) {
    editor.onChange = previous.change
    editor.onSubmit = previous.submit
    editor.onKey = previous.key
    editor.onTokenChange = previous.token
  }
  native.command.mockReturnValue('editor')
  native.edit.mockResolvedValue('edited\r\ntext\n')
  native.paste.mockResolvedValue({ kind: 'image', data: png, mediaType: 'image/png' })
  native.copy.mockResolvedValue('native')
  native.shell.mockResolvedValue(0)
  const options: EditorFeatureOptions = { ctx, editor, screen, components, colors, keymap, session: () => selected, notice, upload, files, local, ...extra }
  const controller = attachEditorFeatures(options)
  const dispose = async () => { controller.dispose(); await ctx.fiber.dispose() }
  owners.push(dispose)
  await flush()
  return { ctx, host, colors, components, editor, screen, hide, notice, upload, files, local, previous, controller, offKeys, readAttachment, requestRender, options, dispose, providers, tokenSources,
    key: (id: string) => editor.onKey?.(id),
    selected: () => selected,
    select(next: EditorFeatureSession | undefined) { selected = next; controller.selectionChanged() },
    replace(next: EditorFeatureSession | undefined) { selected = next },
    running(value: boolean) { running = value },
    limits(value: unknown) { projection = value },
    emit(name: string, ...args: unknown[]) { for (const listener of events.get(name) ?? []) listener(...args as never[]) },
    listeners: (name: string) => [...events.get(name) ?? []],
    listenerCount: () => [...events.values()].reduce((sum, listeners) => sum + listeners.size, 0),
  }
}

describe('mounted editor routes and ownership', () => {
  it('refreshes exact native catalogs and drops all prior callbacks and key registrations on teardown', async () => {
    const f = await fixture()
    expect(f.listenerCount()).toBe(2)
    f.emit('commands/change')
    f.emit('agent-preset/selected', 'other-session', 'preset')
    f.emit('agent-preset/selected', f.host.selected.ref.sessionId, 'preset')
    await f.controller.refreshCommands()
    await f.controller.refreshSkills()
    expect(f.host.listCommands).toHaveBeenCalled()
    expect(f.controller.skills()).toHaveLength(1)
    const change = f.editor.onChange!
    const submit = f.editor.onSubmit!
    const key = f.editor.onKey!
    const token = f.editor.onTokenChange!
    const retiredCommands = f.listeners('commands/change')[0]!
    const retiredPreset = f.listeners('agent-preset/selected')[0]!
    token(undefined)
    expect(f.previous.token).toHaveBeenCalledWith(undefined)
    f.editor.setText('preserved draft')
    await f.dispose()
    expect(f.listenerCount()).toBe(0)
    expect(f.offKeys).toHaveBeenCalledOnce()
    expect(f.editor.onChange).toBe(f.previous.change)
    expect(f.editor.onSubmit).toBe(f.previous.submit)
    expect(f.editor.onKey).toBe(f.previous.key)
    expect(f.editor.onTokenChange).toBe(f.previous.token)
    change('late')
    submit('late')
    expect(key('ui.external')).toBe(false)
    retiredCommands()
    retiredPreset(...[f.host.selected.ref.sessionId, 'preset'] as never[])
    const emptyProvider = f.providers.mock.calls.at(-1)![0]!
    expect(await emptyProvider.getSuggestions(['draft'], 0, 5, { signal: new AbortController().signal })).toBeNull()
    expect(emptyProvider.applyCompletion(['draft'], 0, 5, { value: 'ignored', label: 'ignored' }, '')).toEqual({ lines: ['draft'], cursorLine: 0, cursorCol: 5 })
    f.controller.selectionChanged()
    f.controller.presetChanged()
    await f.controller.openText('late')
    expect(native.edit).not.toHaveBeenCalled()
    expect(f.host.prompt).not.toHaveBeenCalled()
  })

  it('keeps shell mode local and applies cancel, interrupt and steering precedence', async () => {
    const f = await fixture()
    f.editor.handleInput?.('!')
    expect(f.editor.getText()).toBe('')
    expect(f.key('ui.cancel')).toBe(true)
    f.editor.handleInput?.('!')
    f.editor.onSubmit?.('  ')
    expect(native.shell).not.toHaveBeenCalled()
    f.editor.handleInput?.('!')
    f.editor.onSubmit?.('  printf local  ')
    await flush()
    expect(native.shell).toHaveBeenCalledWith('printf local', '/remote/local')
    expect(f.host.prompt).not.toHaveBeenCalled()
    f.editor.setText('clear me')
    expect(f.key('mayfly.interaction.interrupt')).toBe(true)
    expect(f.editor.getText()).toBe('')
    f.running(true)
    expect(f.key('mayfly.interaction.interrupt')).toBe(true)
    await flush()
    expect(f.host.cancel).toHaveBeenCalledOnce()
    f.running(false)
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    f.key('mayfly.interaction.interrupt')
    expect(f.notice.set).toHaveBeenLastCalledWith('press Ctrl+C again to exit')
    f.key('mayfly.interaction.interrupt')
    expect(f.local.exit).toHaveBeenCalledOnce()
    expect(f.key('mayfly.interaction.steer')).toBe(false)
    f.editor.setText('steer this prompt')
    expect(f.key('mayfly.interaction.steer')).toBe(true)
    await flush()
    expect(f.host.prompt).toHaveBeenCalledWith(expect.any(Array), 'steer', expect.any(AbortSignal), expect.any(String))
    f.previous.key.mockReturnValueOnce(true)
    expect(f.key('unclaimed')).toBe(true)
    f.previous.key.mockReturnValueOnce(true)
    expect(f.key('ui.cancel')).toBe(true)
  })

  it('runs local paste, previews the owned image and restores focus on every close key', async () => {
    const f = await fixture({ focusEditor: vi.fn() })
    const pending = deferred<unknown>()
    native.paste.mockReturnValueOnce(pending.promise)
    expect(f.key('mayfly.image.paste')).toBe(true)
    f.key('mayfly.image.paste')
    expect(native.paste).toHaveBeenCalledOnce()
    pending.resolve({ kind: 'image', data: png, mediaType: 'image/png' })
    await flush()
    const marker = f.editor.getText()
    expect(marker).toMatch(/^\[image #1 /u)
    expect(f.notice.set).toHaveBeenLastCalledWith('pasted 1 image')
    f.editor.setText(`${marker} @src`)
    vi.spyOn(f.editor, 'activeToken').mockReturnValue({ kind: 'image', text: marker } as EditorToken)
    for (const close of ['\x1b', '\x03', 'q', 'Q']) {
      f.key('ui.external')
      const view = vi.mocked(f.screen.showOverlay).mock.calls.at(-1)![0] as MayflyFocusable
      view.render(40)
      view.invalidate()
      view.handleInput?.('unclaimed')
      view.handleInput?.(close)
    }
    expect(f.hide).toHaveBeenCalledTimes(4)
    expect(f.options.focusEditor).toHaveBeenCalledTimes(4)
    vi.mocked(f.editor.activeToken).mockReturnValue({ kind: 'image', text: '[image #99 missing]' } as EditorToken)
    f.key('ui.external')
    expect(f.screen.showOverlay).toHaveBeenCalledTimes(4)
    vi.mocked(f.editor.activeToken).mockReturnValue({ kind: 'image', text: marker } as EditorToken)
    f.key('ui.external')
    f.key('ui.external')
    expect(f.hide).toHaveBeenCalledTimes(5)
    f.controller.hostReconnected()
    expect(f.hide).toHaveBeenCalledTimes(6)
  })

  it('reports batch paste and fallback provenance, refusals, and stale paste results', async () => {
    const f = await fixture()
    for (const backend of ['x11', 'wayland']) {
      native.paste.mockResolvedValueOnce({ kind: 'images', images: [{ data: png, mediaType: 'image/png', name: 'one' }], fallback: true, backend })
      f.key('mayfly.image.paste')
      await flush()
      expect(f.notice.set).toHaveBeenLastCalledWith(`pasted image via ${backend === 'x11' ? 'X11' : 'Wayland'} fallback; verify it is current`)
    }
    f.limits({ ...limits, maxImagesPerMessage: 4 })
    native.paste.mockResolvedValueOnce({ kind: 'images', images: [{ data: png, mediaType: 'image/png', name: 'third' }, { data: png, mediaType: 'image/png', name: 'fourth' }], fallback: true })
    f.key('mayfly.image.paste')
    await flush()
    expect(f.notice.set).toHaveBeenLastCalledWith('pasted 2 images')
    native.paste.mockResolvedValueOnce({ kind: 'no-image' })
    f.key('mayfly.image.paste')
    await flush()
    expect(f.notice.set).toHaveBeenLastCalledWith('no image available from the clipboard')
    native.paste.mockRejectedValueOnce(new Error('helper failed'))
    f.key('mayfly.image.paste')
    await flush()
    expect(f.notice.set).toHaveBeenLastCalledWith('image rejected: helper failed')
    const pending = deferred<unknown>()
    native.paste.mockReturnValueOnce(pending.promise)
    f.key('mayfly.image.paste')
    f.select(undefined)
    const text = f.editor.getText()
    pending.resolve({ kind: 'image', data: png, mediaType: 'image/png' })
    await flush()
    expect(f.editor.getText()).toBe(text)
    f.key('mayfly.image.paste')
    expect(f.notice.set).toHaveBeenLastCalledWith('image limits are unavailable for the selected Session')
  })

  it('passes expanded drafts and token content to the local editor, preserving folds and cancellation', async () => {
    const f = await fixture()
    f.editor.setText('draft text')
    f.key('ui.external')
    await flush()
    expect(native.edit).toHaveBeenCalledWith('draft text', 'editor', expect.any(AbortSignal))
    expect(f.editor.getText()).toBe('edited\ntext')
    vi.spyOn(f.editor, 'activeToken').mockReturnValue({ kind: 'paste', text: '[paste #1]', content: 'expanded paste' } as EditorToken)
    const replacement = vi.spyOn(f.editor, 'replaceActiveToken')
    f.key('ui.external')
    await flush()
    expect(native.edit).toHaveBeenLastCalledWith('expanded paste', 'editor', expect.any(AbortSignal))
    expect(replacement).toHaveBeenCalledWith('edited\ntext')
    vi.mocked(f.editor.activeToken).mockReturnValue({ kind: 'paste', text: 'raw token' } as EditorToken)
    native.edit.mockResolvedValueOnce(undefined)
    f.key('ui.external')
    await flush()
    expect(native.edit).toHaveBeenLastCalledWith('raw token', 'editor', expect.any(AbortSignal))
    native.edit.mockRejectedValueOnce(new Error('token editor failed'))
    f.key('ui.external')
    await flush()
    expect(f.notice.set).toHaveBeenLastCalledWith('token editor failed')
    const pending = deferred<string>()
    native.edit.mockReturnValueOnce(pending.promise)
    f.key('ui.external')
    f.key('ui.external')
    f.select(undefined)
    pending.resolve('retired token edit')
    await flush()
    expect(replacement).toHaveBeenCalledOnce()
    vi.mocked(f.editor.activeToken).mockReturnValue(undefined)
    native.edit.mockRejectedValueOnce(new Error('draft editor failed'))
    f.key('ui.external')
    await flush()
    expect(f.notice.set).toHaveBeenLastCalledWith('draft editor failed')
    const draftEdit = deferred<string>()
    native.edit.mockReturnValueOnce(draftEdit.promise)
    f.key('ui.external')
    f.key('ui.external')
    f.controller.hostReconnected()
    const text = f.editor.getText()
    draftEdit.resolve('retired draft edit')
    await flush()
    expect(f.editor.getText()).toBe(text)
  })

  it('explains absent editors for draft/token/transcript edits and fences late failures after teardown', async () => {
    const f = await fixture()
    native.command.mockReturnValue(undefined)
    f.key('ui.external')
    vi.spyOn(f.editor, 'activeToken').mockReturnValue({ kind: 'paste', text: 'token' } as EditorToken)
    f.key('ui.external')
    await f.controller.openText('transcript')
    expect(f.notice.set.mock.calls.filter(([text]) => text === 'set $VISUAL or $EDITOR to edit drafts externally')).toHaveLength(3)
    native.command.mockReturnValue('editor')
    await f.controller.openText('transcript')
    expect(native.edit).toHaveBeenLastCalledWith('transcript', 'editor', expect.any(AbortSignal))
    native.edit.mockRejectedValueOnce('transcript editor failed')
    await f.controller.openText('transcript')
    expect(f.notice.set).toHaveBeenLastCalledWith('transcript editor failed')
    const pending = deferred<undefined>()
    native.edit.mockReturnValueOnce(pending.promise)
    const opening = f.controller.openText('old transcript')
    await f.controller.openText('overlapping transcript')
    const count = f.notice.set.mock.calls.length
    await f.dispose()
    pending.reject(new Error('late failed editor'))
    await opening
    expect(f.notice.set).toHaveBeenCalledTimes(count)
  })

  it('opens selected Host mentions, describes live failures and suppresses retired failures', async () => {
    const f = await fixture()
    vi.spyOn(f.editor, 'activeToken').mockReturnValue({ kind: 'mention', text: '@"host path"' } as EditorToken)
    f.key('ui.external')
    await flush()
    expect(f.files.openWorkspacePath).toHaveBeenCalledWith('host path', expect.any(AbortSignal))
    f.files.openWorkspacePath.mockResolvedValueOnce(denied('Host opener refused') as never)
    f.key('ui.external')
    await flush()
    expect(f.notice.set).toHaveBeenLastCalledWith('Host opener refused')
    f.files.openWorkspacePath.mockRejectedValueOnce(new Error('Host opener offline'))
    f.key('ui.external')
    await flush()
    expect(f.notice.set).toHaveBeenLastCalledWith('Host opener offline')
    const pending = deferred<never>()
    f.files.openWorkspacePath.mockReturnValueOnce(pending.promise)
    f.key('ui.external')
    f.select(undefined)
    const count = f.notice.set.mock.calls.length
    pending.reject(new Error('late Host opener failure'))
    await flush()
    expect(f.notice.set).toHaveBeenCalledTimes(count)
    f.key('ui.external')
    expect(f.notice.set).toHaveBeenLastCalledWith('no active session')
  })

  it('uses exact native bytes and file upload receipts and suppresses all stale reads', async () => {
    const f = await fixture()
    const attachment = { attachmentId: 'image-ref', mediaType: 'image/png' } as ImageAttachmentRef
    expect(await f.controller.readAttachment(attachment)).toEqual(new Uint8Array(png))
    expect(f.readAttachment).toHaveBeenCalledWith(attachment)
    expect(f.controller.imageLimits()).toEqual(limits)
    const bytes = new Uint8Array([1, 2, 3])
    expect(await f.controller.stageFile(bytes, 'notes.txt')).toBe(uploadValue)
    expect(f.upload).toHaveBeenCalledWith(f.host.selected.ref.sessionId, bytes, 'notes.txt', expect.any(AbortSignal))
    expect(f.editor.getText()).toContain('[file #1 notes.txt]')
    expect(await f.controller.readHostFile('file')).toEqual({ absolutePath: '/host/file', version: 'r1', text: 'Host file' })
    f.upload.mockResolvedValueOnce(denied('upload refused') as never)
    expect(await f.controller.stageFile(bytes)).toBeUndefined()
    expect(f.notice.set).toHaveBeenLastCalledWith('upload refused')
    f.readAttachment.mockResolvedValueOnce(denied('image refused') as never)
    expect(await f.controller.readAttachment(attachment)).toBeUndefined()
    expect(f.notice.set).toHaveBeenLastCalledWith('image refused')
    f.files.readBytes.mockRejectedValueOnce(new Error('Host file refused'))
    expect(await f.controller.readHostFile('file')).toBeUndefined()
    expect(f.notice.set).toHaveBeenLastCalledWith('Host file refused')
    const image = deferred<never>()
    const file = deferred<never>()
    const upload = deferred<never>()
    f.readAttachment.mockReturnValueOnce(image.promise)
    f.files.stat.mockReturnValueOnce(file.promise)
    f.upload.mockReturnValueOnce(upload.promise)
    const pending = [f.controller.readAttachment(attachment), f.controller.readHostFile('file'), f.controller.stageFile(bytes)]
    f.select(undefined)
    const count = f.notice.set.mock.calls.length
    image.reject(new Error('retired image'))
    file.reject(new Error('retired file'))
    upload.reject(new Error('retired upload'))
    expect(await Promise.all(pending)).toEqual([undefined, undefined, undefined])
    expect(f.notice.set).toHaveBeenCalledTimes(count)
    expect(await f.controller.readAttachment(attachment)).toBeUndefined()
    expect(await f.controller.readHostFile('file')).toBeUndefined()
    expect(await f.controller.stageFile(bytes)).toBeUndefined()
    expect(f.notice.set).toHaveBeenLastCalledWith('no active session')
    expect(await f.controller.copyText('clipboard text')).toBe('native')
    expect(native.copy).toHaveBeenCalledWith('clipboard text', expect.any(AbortSignal))
  })

  it('retains queue drafts and route-independent modes without creating a Session for catalogs', async () => {
    const draft = new EditorDraftStore()
    draft.stashMode('bash')
    const f = await fixture({ draft }, false)
    await f.controller.openSkills()
    expect(f.notice.set).toHaveBeenLastCalledWith('no active session')
    expect(f.host.listCommands).not.toHaveBeenCalled()
    f.key('ui.cancel')
    f.controller.restoreQueued('restored queue')
    expect(f.editor.getText()).toBe('restored queue')
    expect(await f.controller.updateQueue('missing' as MessageId, { kind: 'remove' })).toBe(false)
    f.select(f.host.selected)
    f.controller.requeue('queue again', 'turn')
    await flush()
    expect(f.host.prompt).toHaveBeenCalled()
  })

  it('routes file completions, folder acceptance and token backspace through the native editor', async () => {
    const f = await fixture()
    const complete = vi.spyOn(f.editor, 'completion')
    vi.spyOn(f.editor, 'isShowingAutocomplete').mockReturnValue(true)
    const input = vi.spyOn(f.editor, 'handleInput')
    const refresh = vi.spyOn(f.editor, 'refreshAutocomplete')
    const backspace = vi.spyOn(f.editor, 'tokenBackspace').mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(f.key('mayfly.interaction.backspace')).toBe(true)
    expect(f.key('mayfly.interaction.backspace')).toBe(false)
    expect(backspace).toHaveBeenCalledTimes(2)
    for (const value of ['@src/', '@"my files/"', "@'other files/'"]) {
      complete.mockReturnValue({ kind: 'files', items: [{ label: 'folder/', value }], index: 0, prefix: '@' })
      expect(f.key('ui.accept')).toBe(true)
      expect(input).toHaveBeenCalledWith('\t')
      expect(refresh).toHaveBeenCalled()
      if (value !== '@src/') expect(input).toHaveBeenCalledWith('\x1b[C')
    }
    complete.mockReturnValue({ kind: 'files', items: [{ label: 'file.ts', value: '@src/file.ts' }], index: 0, prefix: '@' })
    expect(f.key('ui.accept')).toBe(false)
    expect(f.key('ui.external')).toBe(true)
    await flush()
    expect(f.files.openWorkspacePath).toHaveBeenCalledWith('src/file.ts', expect.any(AbortSignal))
    expect(f.key('ui.cancel')).toBe(false)
    complete.mockReturnValue({ kind: 'files', items: [{ label: 'folder/', value: '@src/' }], index: 0, prefix: '@' })
    native.edit.mockResolvedValueOnce(undefined)
    f.key('ui.external')
    await flush()
    complete.mockReturnValue({ kind: 'commands', items: [{ label: '/help', value: '/help' }], index: 0, prefix: '/' })
    expect(f.key('ui.accept')).toBe(false)
    complete.mockReturnValue(undefined)
    expect(f.key('ui.accept')).toBe(false)
    native.paste.mockResolvedValueOnce({ kind: 'image', data: png, mediaType: 'image/png' })
    f.key('mayfly.image.paste')
    await flush()
    const marker = f.editor.getText().match(/\[image #[^\]]+\]/u)![0]
    const source = f.tokenSources.mock.calls[0]![0]!
    const line = `${marker} @src/`
    expect(source(line).map(span => span.kind)).toEqual(['image', 'mention'])
  })

  it('suppresses late successful reads/uploads and late local failures after route retirement', async () => {
    const f = await fixture()
    const attachment = { attachmentId: 'image-ref', mediaType: 'image/png' } as ImageAttachmentRef
    const image = deferred<Awaited<ReturnType<typeof f.readAttachment>>>()
    const file = deferred<Awaited<ReturnType<typeof f.files.readBytes>>>()
    const upload = deferred<Awaited<ReturnType<typeof f.upload>>>()
    f.readAttachment.mockReturnValueOnce(image.promise)
    f.files.readBytes.mockReturnValueOnce(file.promise)
    f.upload.mockReturnValueOnce(upload.promise)
    const reads = [f.controller.readAttachment(attachment), f.controller.readHostFile('file'), f.controller.stageFile(new Uint8Array([1]))]
    await flush()
    f.select(undefined)
    image.resolve({ ok: true, value: { data: new Uint8Array(png) } })
    file.resolve({ ok: true, value: { absolutePath: '/host/file', version: 'r1', data: new Uint8Array([65]) } })
    upload.resolve({ ok: true, value: uploadValue })
    expect(await Promise.all(reads)).toEqual([undefined, undefined, undefined])
    expect(f.editor.getText()).toBe('')
    for (const token of [undefined, { kind: 'paste', text: 'token' } as EditorToken]) {
      vi.spyOn(f.editor, 'activeToken').mockReturnValue(token)
      const pending = deferred<never>()
      native.edit.mockReturnValueOnce(pending.promise)
      f.key('ui.external')
      f.controller.hostReconnected()
      const count = f.notice.set.mock.calls.length
      pending.reject(new Error('retired editor failure'))
      await flush()
      expect(f.notice.set).toHaveBeenCalledTimes(count)
    }
    f.select(f.host.selected)
    const paste = deferred<never>()
    native.paste.mockReturnValueOnce(paste.promise)
    f.key('mayfly.image.paste')
    f.select(undefined)
    const count = f.notice.set.mock.calls.length
    paste.reject(new Error('retired paste failure'))
    await flush()
    expect(f.notice.set).toHaveBeenCalledTimes(count)
  })

  it.each(['dispose', 'reconnect'] as const)('does not insert an upload marker when %s lands between native receipt settlement and editor continuation', async transition => {
    const f = await fixture()
    f.upload.mockImplementationOnce(async () => {
      queueMicrotask(() => { queueMicrotask(() => {
        if (transition === 'dispose') f.controller.dispose()
        else f.controller.hostReconnected()
      }) })
      return { ok: true, value: uploadValue }
    })
    expect(await f.controller.stageFile(new Uint8Array([1, 2]), 'late.txt')).toBeUndefined()
    expect(f.editor.getText()).toBe('')
    expect(f.notice.set).not.toHaveBeenCalled()
  })

  it('refreshes open skills, detects an unannounced selection and accepts missing local options', async () => {
    const f = await fixture({ local: { list: () => [], execute: () => ({ kind: 'unhandled' }), cwd: () => '/remote', exit: vi.fn() } })
    await f.controller.openSkills()
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(1)
    f.controller.presetChanged()
    await flush()
    const pending = deferred<Awaited<ReturnType<typeof f.host.listSkills>>>()
    f.host.listSkills.mockReturnValueOnce(pending.promise)
    const refreshing = f.controller.refreshSkills()
    const retired = f.listeners('commands/change')[0]!
    f.replace(undefined)
    retired()
    expect(f.controller.skills()).toEqual([])
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(0)
    await f.dispose()
    pending.resolve({ ok: true, value: { skills: [] } })
    await refreshing
  })

  it('preserves literal braces in local failures and supports an editor without draft snapshots', async () => {
    const f = await fixture({ local: { list: () => [], execute: () => ({ kind: 'unhandled' }), cwd: () => '/remote', exit: vi.fn() } })
    native.paste.mockResolvedValueOnce({ kind: 'failed', detail: 'missing {DISPLAY}' })
    f.key('mayfly.image.paste')
    await flush()
    expect(f.notice.set).toHaveBeenLastCalledWith('clipboard read failed: missing {DISPLAY}')
    Object.defineProperty(f.editor, 'captureDraft', { value: undefined, configurable: true })
    f.key('ui.external')
    await flush()
    vi.spyOn(f.editor, 'activeToken').mockReturnValue({ kind: 'paste', text: 'token' } as EditorToken)
    f.key('ui.external')
    await flush()
    await f.controller.openText('transcript')
    f.previous.key.mockReturnValueOnce(true)
    f.editor.setText('')
    expect(f.key('mayfly.interaction.steer')).toBe(true)
  })

  it('leaves an empty steering key unhandled when the original editor has no key callback', async () => {
    const f = await fixture({}, true, false)
    expect(f.key('mayfly.interaction.steer')).toBe(false)
    expect(f.host.prompt).not.toHaveBeenCalled()
  })
})
