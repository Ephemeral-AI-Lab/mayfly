import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountRemoteEditor } from '../../src/remote/editor.ts'
import type {
  MayflyComponents, MayflyEditor, MayflyFocusable, MayflyScreenService, MayflySemanticColors,
} from '@ephemeral-ai/mayfly/core'

const colors = { muted: (text: string) => text } as MayflySemanticColors

function fixture() {
  const editor = {
    setPromptSymbol: vi.fn(),
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
  } as unknown as MayflyComponents
  return { editor, slot, screen, components }
}

describe('mountRemoteEditor', () => {
  it('submits trimmed text and keeps the original entry in local history', () => {
    const { editor, screen, components } = fixture()
    const actions = { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    mountRemoteEditor(new Context(), screen, components, colors, actions)
    editor.onSubmit?.('  hello world  ')
    expect(actions.submit).toHaveBeenCalledWith('hello world')
    expect(editor.addToHistory).toHaveBeenCalledWith('  hello world  ')
  })

  it('clears a draft before using Ctrl-C to exit', () => {
    const { editor, screen, components } = fixture()
    const actions = { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    mountRemoteEditor(new Context(), screen, components, colors, actions)
    editor.getText = vi.fn(() => 'draft')
    expect(editor.onKey?.('\x03')).toBe(true)
    expect(editor.setText).toHaveBeenCalledWith('')
    expect(actions.exit).not.toHaveBeenCalled()
    editor.getText = vi.fn(() => '')
    expect(editor.onKey?.('\x03')).toBe(true)
    expect(actions.exit).toHaveBeenCalledOnce()
  })

  it('uses Escape to cancel only after the draft is empty', () => {
    const { editor, screen, components } = fixture()
    const actions = { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    mountRemoteEditor(new Context(), screen, components, colors, actions)
    editor.getText = vi.fn(() => 'draft')
    expect(editor.onKey?.('\x1b')).toBe(true)
    expect(actions.cancel).not.toHaveBeenCalled()
    editor.getText = vi.fn(() => '')
    expect(editor.onKey?.('\x1b')).toBe(true)
    expect(actions.cancel).toHaveBeenCalledOnce()
  })

  it('routes asynchronous submit failures to the local error surface', async () => {
    const { editor, screen, components } = fixture()
    const failure = new Error('offline')
    const actions = { submit: vi.fn(async () => { throw failure }), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    mountRemoteEditor(new Context(), screen, components, colors, actions)
    editor.onSubmit?.('hello')
    await vi.waitFor(() => { expect(actions.onError).toHaveBeenCalledWith(failure) })
  })

  it('ignores blank submissions and unhandled keys, and disposes the editor slot', () => {
    const { editor, slot, screen, components } = fixture()
    const actions = { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    const handle = mountRemoteEditor(new Context(), screen, components, colors, actions)
    editor.onSubmit?.('   ')
    expect(actions.submit).not.toHaveBeenCalled()
    expect(editor.onKey?.('x')).toBe(false)
    handle.focus()
    expect(slot.focus).toHaveBeenCalledTimes(2)
    handle.dispose()
    expect(slot.dispose).toHaveBeenCalledOnce()
  })

  it('shows bounded transient notices below the editor and clears them on edit', () => {
    const { editor, screen, components } = fixture()
    const actions = { submit: vi.fn(), onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }
    const handle = mountRemoteEditor(new Context(), screen, components, colors, actions)
    const dock = vi.mocked(screen.mountDockSlot).mock.calls[0]![1]! as MayflyFocusable
    handle.notice.set(Array.from({ length: 10 }, (_, index) => `line ${String(index)}`).join('\n'))
    expect(dock.render(80)).toHaveLength(9)
    expect(dock.render(80)[1]).toBe('line 0')
    expect(screen.requestRender).toHaveBeenCalled()
    editor.onChange?.('next')
    expect(dock.render(80)).toEqual(['editor'])
    dock.focused = true
    expect(dock.focused).toBe(true)
    expect(editor.focused).toBe(true)
    dock.handleInput?.('x')
    expect(editor.handleInput).toHaveBeenCalledWith('x')
    dock.invalidate()
    expect(editor.invalidate).toHaveBeenCalledOnce()
  })
})
