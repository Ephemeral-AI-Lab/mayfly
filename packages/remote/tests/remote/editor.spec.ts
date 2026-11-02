/** Standalone editor admission, reference chrome, focus, and terminal-slot lifecycle. @module mayfly-remote/tests/editor */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Frontend from '@ephemeral-ai/mayfly/frontend'
import * as MayflyUiProvider from '@ephemeral-ai/mayfly-ui/provider'
import * as Core from '@ephemeral-ai/mayfly/core'
import { mountRemoteEditor } from '../../src/remote/editor.ts'
import type {
  MayflyComponents, MayflyEditor, MayflyFocusable, MayflyScreenService, MayflySemanticColors,
} from '@ephemeral-ai/mayfly/core'

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

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MayflyUiProvider)
  await ctx.plugin(Frontend)
  const editor = {
    setPromptSymbol: vi.fn(),
    setShellMode: vi.fn(),
    updateColors: vi.fn(),
    setPlaceholder: vi.fn(),
    onSubmit: undefined as MayflyEditor['onSubmit'],
    onChange: undefined as MayflyEditor['onChange'],
    onKey: undefined as MayflyEditor['onKey'],
    addToHistory: vi.fn(),
    getText: vi.fn(() => ''),
    setText: vi.fn(),
    handleInput: vi.fn(),
    render: vi.fn(() => ['editor']),
    invalidate: vi.fn(),
    focused: false,
  } as unknown as MayflyEditor
  const slot = { focus: vi.fn(), dispose: vi.fn() }
  const screen = { mountDockSlot: vi.fn(() => slot), requestRender: vi.fn() } as unknown as MayflyScreenService
  const components = {
    createEditor: () => editor,
    wrapText: (text: string) => [text],
    truncateToWidth: (text: string) => text,
    visibleWidth: (text: string) => text.length,
    strong: (text: string) => text,
  } as unknown as MayflyComponents
  return { ctx, editor, slot, screen, components }
}

describe('mountRemoteEditor', () => {
  it('propagates a shared compiler failure before acquiring a terminal slot', async () => {
    const { ctx, screen, components } = await fixture()
    vi.spyOn(Core, 'compileMayflyEditorShellNode').mockReturnValueOnce({
      ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION', message: 'renderer unavailable',
      errorComponent: { render: () => ['renderer unavailable'], invalidate: vi.fn() },
    })
    expect(() => mountRemoteEditor(ctx, screen, components, colors, { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() })).toThrow('renderer unavailable')
    expect(screen.mountDockSlot).not.toHaveBeenCalled()
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
    dock.invalidate()
    expect(editor.invalidate).toHaveBeenCalledOnce()
    handle.notice.set('')
    expect(ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
    handle.dispose()
    handle.dispose()
    handle.notice.set('late')
    expect(ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
  })

  it('uses reference placeholder ladders for idle, running, side, readonly, quiet, and shell states', async () => {
    const { ctx, editor, screen, components } = await fixture()
    let facts: import('../../src/remote/editor.ts').RemoteEditorPresentation = {}
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
})
