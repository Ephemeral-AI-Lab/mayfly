/** Standalone editor admission, reference chrome, focus, and terminal-slot lifecycle. @module mayfly-remote/tests/editor */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Frontend from '../../src/frontend.ts'
import * as MayflyUiProvider from '@ephemeral-ai/mayfly-ui/provider'
import { MayflyKeymapService } from '../../src/core.ts'
import { INTERACTION_KEY_ACTIONS } from '../../src/command-panels.ts'
import { mountRemoteEditor } from '../../src/app/editor.ts'
import type {
  MayflyComponents, MayflyEditor, MayflyFocusable, MayflyScreenService, MayflySemanticColors,
} from '../../src/core.ts'

const identity = (text: string): string => text
// The compiled editor shell paints its chrome and motion cells through the
// full semantic palette; a single-tone stub makes its breath probe call an
// undefined `paint`.
const colors = {
  primary: identity,
  border: identity,
  accent: identity,
  text: identity,
  textStrong: identity,
  muted: identity,
  textMuted: identity,
  success: identity,
  warning: identity,
  error: identity,
  modelHighlight: identity,
  logoInks: Array.from({ length: 5 }, () => identity),
} as unknown as MayflySemanticColors

const contexts: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function fixture(rows = 30) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MayflyUiProvider)
  await ctx.plugin(Frontend)
  await ctx.plugin(MayflyKeymapService)
  ctx.mayflyKeymap.register([...INTERACTION_KEY_ACTIONS])
  const editor = {
    setPromptSymbol: vi.fn(),
    setAutocompleteProvider: vi.fn(),
    setSubmitBarrier: vi.fn(),
    setShellMode: vi.fn(),
    updateColors: vi.fn(),
    setPlaceholder: vi.fn(),
    onSubmit: undefined as MayflyEditor['onSubmit'],
    onChange: undefined as MayflyEditor['onChange'],
    onKey: undefined as MayflyEditor['onKey'],
    addToHistory: vi.fn(),
    getText: vi.fn(() => ''),
    setText: vi.fn(),
    isShowingAutocomplete: vi.fn(() => false),
    handleInput: vi.fn(),
    render: vi.fn(() => ['editor']),
    invalidate: vi.fn(),
    focused: false,
  } as unknown as MayflyEditor
  const slot = { focus: vi.fn(), dispose: vi.fn() }
  const offScroll = vi.fn()
  const screen = {
    rows, mountDockSlot: vi.fn(() => slot), requestRender: vi.fn(),
    enterViews: vi.fn(() => false), focusConversation: vi.fn(() => false),
    setContentScrollHandler: vi.fn(() => offScroll), scrollContent: vi.fn(() => false), followContent: vi.fn(),
  } as unknown as MayflyScreenService
  ctx.provide('mayflyScreen', screen)
  const components = {
    createEditor: () => editor,
    wrapText: (text: string) => [text],
    truncateToWidth: (text: string) => text,
    visibleWidth: (text: string) => text.length,
    strong: (text: string) => text,
  } as unknown as MayflyComponents
  return { ctx, editor, slot, screen, components, offScroll }
}

describe('mountRemoteEditor', () => {
  it('contains a shared compiler failure with an owned notification and editable fallback', async () => {
    const { ctx, editor, screen, components } = await fixture()
    const unavailable = { ...components, get presentation(): NonNullable<MayflyComponents['presentation']> { throw new Error('presentation unavailable') } }
    const handle = mountRemoteEditor(ctx, screen, unavailable, colors, { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() })
    expect(ctx.mayflyUiInteraction.notificationSnapshot()).toContainEqual(expect.objectContaining({
      severity: 'error', message: 'Mayfly editor shell compilation failed safely',
    }))
    const dock = vi.mocked(screen.mountDockSlot).mock.calls[0]![1]!
    expect(dock.render(80)).toEqual(['editor'])
    expect(editor.onKey?.('x')).toBe(false)
    handle.dispose()
  })

  it('submits trimmed text and keeps the original entry in local history', async () => {
    const { ctx, editor, screen, components } = await fixture()
    const actions = { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    mountRemoteEditor(ctx, screen, components, colors, actions)
    editor.onSubmit?.('  hello world  ')
    expect(actions.submit).toHaveBeenCalledWith('hello world')
    expect(editor.addToHistory).toHaveBeenCalledWith('  hello world  ')
  })

  it('clears a draft before using Ctrl-C to exit', async () => {
    const { ctx, editor, screen, components } = await fixture()
    const actions = { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    mountRemoteEditor(ctx, screen, components, colors, actions)
    editor.getText = vi.fn(() => 'draft')
    expect(editor.onKey?.('\x03')).toBe(true)
    expect(editor.setText).toHaveBeenCalledWith('')
    expect(actions.exit).not.toHaveBeenCalled()
    editor.getText = vi.fn(() => '')
    expect(editor.onKey?.('\x03')).toBe(true)
    expect(actions.exit).toHaveBeenCalledOnce()
  })

  it('uses Escape to cancel only after the draft is empty', async () => {
    const { ctx, editor, screen, components } = await fixture()
    const actions = { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    mountRemoteEditor(ctx, screen, components, colors, actions)
    editor.getText = vi.fn(() => 'draft')
    expect(editor.onKey?.('\x1b')).toBe(true)
    expect(actions.cancel).not.toHaveBeenCalled()
    editor.getText = vi.fn(() => '')
    expect(editor.onKey?.('\x1b')).toBe(true)
    expect(actions.cancel).toHaveBeenCalledOnce()
  })

  it('routes asynchronous submit failures to the local error surface', async () => {
    const { ctx, editor, screen, components } = await fixture()
    const failure = new Error('offline')
    const actions = { submit: vi.fn(async () => { throw failure }), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    mountRemoteEditor(ctx, screen, components, colors, actions)
    editor.onSubmit?.('hello')
    await vi.waitFor(() => { expect(actions.onError).toHaveBeenCalledWith(failure) })
  })

  it('ignores blank submissions and unhandled keys, and disposes the editor slot', async () => {
    const { ctx, editor, slot, screen, components } = await fixture()
    const actions = { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    const handle = mountRemoteEditor(ctx, screen, components, colors, actions)
    editor.onSubmit?.('   ')
    expect(actions.submit).not.toHaveBeenCalled()
    expect(editor.onKey?.('x')).toBe(false)
    handle.focus()
    expect(slot.focus).toHaveBeenCalledTimes(2)
    handle.dispose()
    expect(slot.dispose).toHaveBeenCalledOnce()
  })

  it('routes command feedback to the reference notification row and preserves editor focus and input', async () => {
    const { ctx, editor, screen, components } = await fixture()
    const actions = { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    const handle = mountRemoteEditor(ctx, screen, components, colors, actions)
    const dock = vi.mocked(screen.mountDockSlot).mock.calls[0]![1]! as MayflyFocusable
    expect(() => dock.render(Number.NaN)).not.toThrow()
    handle.notice.set('first line\nsecond line')
    const records = ctx.mayflyUiInteraction.notificationSnapshot()
    expect(records).toEqual([expect.objectContaining({ message: 'first line · second line', detail: 'first line\nsecond line' })])
    expect(dock.render(80).some(row => row.includes('first line'))).toBe(false)
    dock.focused = true
    dock.render(80)
    expect(editor.focused).toBe(true)
    dock.handleInput?.('x')
    expect(editor.handleInput).toHaveBeenCalledWith('x')
    const invalidations = vi.mocked(editor.invalidate).mock.calls.length
    dock.invalidate()
    expect(editor.invalidate).toHaveBeenCalledTimes(invalidations + 1)
    handle.notice.set('')
    expect(ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
    handle.dispose()
    handle.dispose()
    handle.notice.set('late')
    expect(ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
  })

  it('uses reference placeholder ladders for idle, running, side, readonly, quiet, and shell states', async () => {
    const { ctx, editor, screen, components } = await fixture()
    let facts: import('../../src/app/editor.ts').RemoteEditorPresentation = {}
    const handle = mountRemoteEditor(ctx, screen, components, colors, { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }, () => facts)
    const dock = vi.mocked(screen.mountDockSlot).mock.calls[0]![1]! as MayflyFocusable
    dock.render(100)
    expect(editor.setPlaceholder).toHaveBeenLastCalledWith([
      'Ask anything · / commands · @ files · # skills · ! shell', 'Ask anything · / commands · @ files · # skills',
      'Ask anything · / commands · @ files', 'Ask anything · / commands', 'Ask anything',
    ])
    facts = { view: { kind: 'primary', access: 'interactive', label: 'Primary conversation' } }
    handle.refresh()
    expect(dock.render(100).join('')).not.toContain('Primary conversation')
    facts = { running: true }
    handle.refresh()
    dock.render(100)
    expect(editor.setPlaceholder).toHaveBeenLastCalledWith(['Type a follow-up to queue it · @ files · # skills', 'Type a follow-up to queue it'])
    facts = { view: { kind: 'btw', access: 'interactive', label: 'Side question' } }
    handle.refresh()
    dock.render(100)
    expect(editor.setPlaceholder).toHaveBeenLastCalledWith(['Continue the side question · @ files · # skills', 'Continue the side question'])
    facts = { view: { kind: 'subagent', access: 'readonly', label: 'Worker' } }
    handle.refresh()
    dock.render(100)
    expect(editor.setPlaceholder).toHaveBeenLastCalledWith(['Read-only conversation'])
    facts = { quietHints: 'off' }
    handle.refresh()
    dock.render(100)
    expect(editor.setPlaceholder).toHaveBeenLastCalledWith([])
    editor.setShellMode(true)
    dock.render(100)
    expect(editor.setPlaceholder).toHaveBeenLastCalledWith(['Run a shell command · Esc leaves shell mode'])
    expect(dock.render(100).join('')).toContain('! ')
    editor.setShellMode(false)
    handle.dispose()
    handle.refresh()
  })

  it('rethemes the retained editor and frame without replacing it or taking focus', async () => {
    const { ctx, editor, slot, screen, components } = await fixture()
    const actions = { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    const handle = mountRemoteEditor(ctx, screen, components, colors, actions)
    const dock = vi.mocked(screen.mountDockSlot).mock.calls[0]![1]! as MayflyFocusable
    dock.focused = false
    const next = { ...colors, border: (text: string) => `next:${text}` }
    const createEditor = vi.fn()
    handle.retheme({ ...components, createEditor }, next)
    expect(handle.editor).toBe(editor)
    expect(editor.updateColors).toHaveBeenCalledWith(next)
    expect(createEditor).not.toHaveBeenCalled()
    expect(dock.focused).toBe(false)
    expect(slot.focus).toHaveBeenCalledOnce()
    handle.dispose()
    handle.retheme(components, colors)
    expect(editor.updateColors).toHaveBeenCalledOnce()
  })

  it('retires command and extension feedback only on a real palette replacement while preserving external owners', async () => {
    const { ctx, screen, components } = await fixture()
    const handle = mountRemoteEditor(ctx, screen, components, colors, { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() })
    const external = ctx.mayflyUiInteraction.createNotificationOwner('external')
    const registration = ctx.mayflyEditorExtensions.register({ id: 'acme.palette', onEvent: {
      action: () => ({ kind: 'completed', feedback: { severity: 'success', message: 'extension feedback' } }),
    } }, { actions: [{ id: 'apply', label: 'Apply extension', key: 'ctrl+r' }] })
    handle.extensions.focused = true
    handle.extensions.render(80)
    handle.extensions.handleInput('\x12')
    await vi.waitFor(() => { expect(ctx.mayflyUiInteraction.notificationSnapshot()).toContainEqual(expect.objectContaining({ message: 'extension feedback' })) })
    handle.notice.set('command feedback')
    external.report('work', { kind: 'app', targetId: 'external' }, { severity: 'info', message: 'external feedback' })
    const notices = ctx.mayflyUiInteraction.notificationSnapshot()
    expect(notices).toHaveLength(3)
    handle.retheme(components, colors)
    expect(ctx.mayflyUiInteraction.notificationSnapshot()).toEqual(notices.map(({ id, message }) => expect.objectContaining({ id, message })))
    const nextColors = { ...colors }
    handle.retheme(components, nextColors)
    expect(ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([expect.objectContaining({ message: 'external feedback' })])
    handle.notice.set('another command')
    handle.retheme({ ...components }, nextColors)
    expect(ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([expect.objectContaining({ message: 'external feedback' })])
    registration.dispose()
    external.dispose()
    handle.dispose()
  })

  it('refreshes readonly settings and locale without a keystroke and fences queued snapshots after unload', async () => {
    const { ctx, editor, screen, components } = await fixture()
    const observeLocale = vi.spyOn(ctx.mayflyLocale, 'subscribe')
    const observeEvents = vi.spyOn(ctx, 'on')
    let facts: import('../../src/app/editor.ts').RemoteEditorPresentation = {}
    const handle = mountRemoteEditor(ctx, screen, components, colors, { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }, () => facts)
    const dock = vi.mocked(screen.mountDockSlot).mock.calls[0]![1]! as MayflyFocusable
    const queuedLocale = observeLocale.mock.calls.at(-1)![0]
    const queuedSettings = observeEvents.mock.calls.find(([event]) => event === 'mayfly/settings-source-ready')![1] as () => void
    dock.render(80)
    expect(editor.setPlaceholder).toHaveBeenLastCalledWith(expect.arrayContaining(['Ask anything']))
    facts = { quietHints: 'off' }
    ctx.emit('mayfly/settings-source-ready', {})
    dock.render(80)
    expect(editor.setPlaceholder).toHaveBeenLastCalledWith([])
    facts = {}
    ctx.emit('mayfly/settings-source-ready', {})
    ctx.mayflyLocale.setPreference('zh')
    await new Promise<void>(resolve => setImmediate(resolve))
    dock.render(80)
    expect(editor.setPlaceholder).toHaveBeenLastCalledWith(expect.arrayContaining(['随便问']))
    handle.dispose()
    const renders = vi.mocked(screen.requestRender).mock.calls.length
    queuedLocale(ctx.mayflyLocale.snapshot)
    queuedSettings()
    ctx.emit('mayfly/settings-source-ready', {})
    ctx.mayflyLocale.setPreference('en')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(screen.requestRender).toHaveBeenCalledTimes(renders)
  })

  it.each(['\x1b[1;3A', '\x1bOS'])('routes previous focus through the registered action with a retained draft: %j', async key => {
    const { ctx, editor, screen, components } = await fixture()
    mountRemoteEditor(ctx, screen, components, colors, { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() })
    editor.getText = vi.fn(() => 'retain this draft')
    vi.mocked(screen.focusConversation).mockReturnValue(true)
    expect(editor.onKey?.(key)).toBe(true)
    expect(screen.focusConversation).toHaveBeenCalledOnce()
    expect(editor.setText).not.toHaveBeenCalled()
    expect(screen.enterViews).not.toHaveBeenCalled()
  })

  it.each(['\x1b[1;3B', '\x1b[15~'])('routes next focus only from an empty prompt without autocomplete: %j', async key => {
    const { ctx, editor, screen, components } = await fixture()
    mountRemoteEditor(ctx, screen, components, colors, { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() })
    vi.mocked(screen.enterViews).mockReturnValue(true)
    editor.getText = vi.fn(() => 'draft')
    expect(editor.onKey?.(key)).toBe(false)
    expect(screen.enterViews).not.toHaveBeenCalled()
    editor.getText = vi.fn(() => '')
    vi.mocked(editor.isShowingAutocomplete).mockReturnValue(true)
    expect(editor.onKey?.(key)).toBe(false)
    expect(screen.enterViews).not.toHaveBeenCalled()
    vi.mocked(editor.isShowingAutocomplete).mockReturnValue(false)
    expect(editor.onKey?.(key)).toBe(true)
    expect(screen.enterViews).toHaveBeenCalledOnce()
  })

  it('preserves autocomplete ownership and leaves unavailable focus targets to the editor', async () => {
    const { ctx, editor, screen, components } = await fixture()
    mountRemoteEditor(ctx, screen, components, colors, { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() })
    vi.mocked(editor.isShowingAutocomplete).mockReturnValue(true)
    expect(editor.onKey?.('\x1b[1;3A')).toBe(false)
    expect(screen.focusConversation).not.toHaveBeenCalled()
    vi.mocked(editor.isShowingAutocomplete).mockReturnValue(false)
    expect(editor.onKey?.('\x1b[1;3A')).toBe(false)
    expect(editor.onKey?.('\x1b[1;3B')).toBe(false)
    expect(screen.focusConversation).toHaveBeenCalledOnce()
    expect(screen.enterViews).toHaveBeenCalledOnce()
  })

  it('honors live native key rebinding instead of claiming the default raw bytes', async () => {
    const { ctx, editor, screen, components } = await fixture()
    mountRemoteEditor(ctx, screen, components, colors, { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() })
    ctx.mayflyKeymap.bind('ui.focus-prev', 'ctrl+f4')
    ctx.mayflyKeymap.bind('ui.focus-next', 'ctrl+f5')
    vi.mocked(screen.focusConversation).mockReturnValue(true)
    vi.mocked(screen.enterViews).mockReturnValue(true)
    for (const key of ['\x1b[1;3A', '\x1bOS', '\x1b[1;3B', '\x1b[15~']) expect(editor.onKey?.(key)).toBe(false)
    expect(editor.onKey?.('\x1b[1;5S')).toBe(true)
    expect(editor.onKey?.('\x1b[15;5~')).toBe(true)
    expect(screen.focusConversation).toHaveBeenCalledOnce()
    expect(screen.enterViews).toHaveBeenCalledOnce()
  })

  it('opens native key help only from an empty prompt outside shell and autocomplete', async () => {
    const { ctx, editor, screen, components } = await fixture()
    mountRemoteEditor(ctx, screen, components, colors, { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() })
    const help = vi.fn()
    ctx.on('mayfly/request-help', help)
    editor.getText = vi.fn(() => 'draft')
    expect(editor.onKey?.('?')).toBe(false)
    editor.getText = vi.fn(() => '')
    editor.setShellMode(true)
    expect(editor.onKey?.('?')).toBe(false)
    editor.setShellMode(false)
    vi.mocked(editor.isShowingAutocomplete).mockReturnValue(true)
    expect(editor.onKey?.('?')).toBe(false)
    expect(help).not.toHaveBeenCalled()
    vi.mocked(editor.isShowingAutocomplete).mockReturnValue(false)
    expect(editor.onKey?.('?')).toBe(true)
    expect(help).toHaveBeenCalledOnce()
  })

  it('keeps focused wheel reports at the boundary and routes page, marker and tail actions through core', async () => {
    const { ctx, editor, screen, components, offScroll } = await fixture()
    const handle = mountRemoteEditor(ctx, screen, components, colors, { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() })
    const scroll = vi.mocked(screen.setContentScrollHandler).mock.calls[0]![0]!
    const dock = vi.mocked(screen.mountDockSlot).mock.calls[0]![1]! as MayflyFocusable
    expect(scroll('\x1b[5~')).toBe(false)
    expect(screen.scrollContent).not.toHaveBeenCalled()
    dock.focused = true
    expect(scroll('\x1b[<64;2;3M')).toBe(true)
    expect(screen.scrollContent).toHaveBeenLastCalledWith('up', 3)
    expect(scroll('\x1b[<65;2;3M')).toBe(true)
    expect(screen.scrollContent).toHaveBeenLastCalledWith('down', 3)
    expect(scroll('\x1b[5~')).toBe(false)
    expect(screen.scrollContent).toHaveBeenLastCalledWith('up', 26)
    vi.mocked(screen.scrollContent).mockReturnValue(true)
    expect(scroll('\x1b[6~')).toBe(true)
    expect(screen.scrollContent).toHaveBeenLastCalledWith('down', 26)
    editor.getText = vi.fn(() => 'draft')
    const newMessages = vi.fn()
    ctx.on('mayfly/request-new-messages', newMessages)
    expect(scroll('\x1b[1;5B')).toBe(true)
    expect(newMessages).toHaveBeenCalledOnce()
    expect(scroll('\x1b[F')).toBe(false)
    expect(screen.followContent).not.toHaveBeenCalled()
    editor.getText = vi.fn(() => '')
    expect(scroll('\x1b[F')).toBe(true)
    expect(screen.followContent).toHaveBeenCalledOnce()
    expect(scroll('x')).toBe(false)
    expect(editor.setText).not.toHaveBeenCalled()
    handle.dispose()
    expect(offScroll).toHaveBeenCalledOnce()
    expect(scroll('\x1b[<64;2;3M')).toBe(false)
    expect(scroll('\x1b[1;5B')).toBe(false)
    expect(newMessages).toHaveBeenCalledOnce()
  })

  it('honors scroll rebindings and clamps page movement on a short terminal', async () => {
    const { ctx, screen, components } = await fixture(2)
    mountRemoteEditor(ctx, screen, components, colors, { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() })
    const scroll = vi.mocked(screen.setContentScrollHandler).mock.calls[0]![0]!
    const dock = vi.mocked(screen.mountDockSlot).mock.calls[0]![1]! as MayflyFocusable
    dock.focused = true
    scroll('\x1b[5~')
    expect(screen.scrollContent).toHaveBeenLastCalledWith('up', 1)
    ctx.mayflyKeymap.bind('ui.up', 'ctrl+up')
    expect(scroll('\x1b[<64;2;3M')).toBe(false)
    ctx.mayflyKeymap.bind('ui.page-up', 'ctrl+pageUp')
    vi.mocked(screen.scrollContent).mockClear()
    expect(scroll('\x1b[5~')).toBe(false)
    scroll('\x1b[5;5~')
    expect(screen.scrollContent).toHaveBeenCalledWith('up', 1)
  })

  it('retires captured callbacks and pending submission failures before a replacement mount', async () => {
    const { ctx, editor, slot, screen, components } = await fixture()
    let reject!: (error: Error) => void
    const pending = new Promise<void>((_resolve, fail) => { reject = fail })
    const actions = { submit: vi.fn(() => pending), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    const handle = mountRemoteEditor(ctx, screen, components, colors, actions)
    const key = editor.onKey!
    const submit = editor.onSubmit!
    const change = editor.onChange!
    const shell = editor.setShellMode
    submit('before unload')
    handle.dispose()
    const renders = vi.mocked(screen.requestRender).mock.calls.length
    for (const data of ['\x1b[1;3A', '\x1b[1;3B', '\x03', '\x1b']) expect(key(data)).toBe(false)
    submit('queued after unload')
    change('queued after unload')
    shell(true)
    handle.focus()
    reject(new Error('old submission failed'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(actions.submit).toHaveBeenCalledOnce()
    expect(actions.onError).not.toHaveBeenCalled()
    expect(actions.exit).not.toHaveBeenCalled()
    expect(actions.cancel).not.toHaveBeenCalled()
    expect(screen.focusConversation).not.toHaveBeenCalled()
    expect(screen.enterViews).not.toHaveBeenCalled()
    expect(screen.requestRender).toHaveBeenCalledTimes(renders)
    expect(slot.focus).toHaveBeenCalledOnce()
  })
})
