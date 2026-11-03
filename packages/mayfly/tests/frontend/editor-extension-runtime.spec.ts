/** Native-independent extension input ownership and queued lifecycle boundaries. @module tests/frontend/editor-extension-runtime */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyAutocompleteProvider, MayflyEditorSubmitAttempt } from '../../src/core/types.ts'
import type { MayflyUiEvent } from '@ephemeral-ai/mayfly-ui'
import { EditorExtensionRuntime, type EditorExtensionRuntimeBindings } from '../../src/frontend/editor-extension-runtime.ts'
import { Editor } from '../../src/components/editor.ts'
import { fakeMayflyContext, FakeMayflyEditor } from '../interaction/fakes.ts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks(); vi.useRealTimers() })

function fixture() {
  const { ctx } = fakeMayflyContext()
  const editor = new FakeMayflyEditor()
  const notices = vi.fn()
  const barriers = vi.spyOn(editor, 'setSubmitBarrier')
  const nativeSources = vi.spyOn(ctx.mayflyPromptEditor, 'listAutocompleteSources')
  const nativeSubscribe = vi.spyOn(ctx.mayflyPromptEditor, 'subscribeEditorState')
  const runtime = new EditorExtensionRuntime({ ctx, editor, report: notices, frame: ({ parked }) => Editor({ shell: false, parked }) })
  cleanup.push(() => { runtime.dispose() })
  return { ctx, editor, runtime, notices, nativeSources, nativeSubscribe, barrier: () => barriers.mock.calls.at(-1)![0]! }
}

function bindings(provider: MayflyAutocompleteProvider): EditorExtensionRuntimeBindings {
  return {
    autocomplete: { sources: () => [provider], subscribe: () => () => {} },
    beginWait: () => () => {},
    captureSubmit: source => ({ text: source, attachments: Object.freeze([]), prepare: text => ({ text }) }),
    shouldTransformSubmit: () => true,
  }
}

function provider(label: string): MayflyAutocompleteProvider {
  return {
    getSuggestions: async () => ({ items: [{ value: label, label }], prefix: '/' }),
    applyCompletion: () => ({ lines: [label], cursorLine: 0, cursorCol: label.length }),
  }
}

const suggestions = (editor: FakeMayflyEditor) => editor.autocompleteProvider!.getSuggestions(['/'], 0, 1, { signal: new AbortController().signal })

function attempt(text: string): MayflyEditorSubmitAttempt {
  return { text, revision: 0, signal: new AbortController().signal, commit: vi.fn(() => true), cancel: vi.fn() }
}

describe('shared editor extension owner', () => {
  it('renders real registry decorations and completions without acquiring native input services', async () => {
    const f = fixture()
    const complete = vi.fn(() => [{ id: 'remote', label: 'Remote completion', insertText: 'remote result' }])
    const transform = vi.fn(() => ({ text: 'must not run without input owner' }))
    const registration = f.ctx.mayflyEditorExtensions.register({ id: 'external.static', complete, transformSubmit: transform }, {
      before: { kind: 'text', content: 'Before the real editor' },
      after: { kind: 'text', content: 'After the real editor' }, hint: 'Reference extension hint',
    })
    cleanup.push(() => { registration.dispose() })
    const rendered = f.runtime.render(80).join('\n')
    expect(rendered).toContain('Before the real editor')
    expect(rendered).toContain('After the real editor')
    expect(rendered).toContain('Reference extension hint')
    expect(await suggestions(f.editor)).toMatchObject({ items: [{ label: 'Remote completion' }] })
    const submit = attempt('original source')
    f.barrier()(submit)
    expect(submit.commit).toHaveBeenCalledOnce()
    expect(transform).not.toHaveBeenCalled()
    expect(f.nativeSources).not.toHaveBeenCalled()
    expect(f.nativeSubscribe).not.toHaveBeenCalled()
  })

  it('replaces exact source owners and makes older unsubscribe and queued callbacks inert', async () => {
    const f = fixture()
    let queued!: () => void
    const offOld = vi.fn()
    const first = { ...bindings(provider('first')), autocomplete: { sources: () => [provider('first')], subscribe: (listener: () => void) => { queued = listener; listener(); return offOld } } }
    const unbindOld = f.runtime.bind(first)
    expect(await suggestions(f.editor)).toMatchObject({ items: [{ value: 'first' }] })
    const oldProvider = f.editor.autocompleteProvider!
    const second = bindings(provider('second'))
    const unbindNew = f.runtime.bind(second)
    expect(offOld).toHaveBeenCalledOnce()
    const currentProvider = f.editor.autocompleteProvider
    queued()
    unbindOld()
    expect(f.editor.autocompleteProvider).toBe(currentProvider)
    expect(await oldProvider.getSuggestions(['/'], 0, 1, { signal: new AbortController().signal })).toBeNull()
    expect(oldProvider.applyCompletion(['untouched'], 0, 3, { value: 'old', label: 'old' }, '/')).toEqual({ lines: ['untouched'], cursorLine: 0, cursorCol: 3 })
    expect(oldProvider.shouldTriggerFileCompletion?.(['@'], 0, 1)).toBe(false)
    expect(await suggestions(f.editor)).toMatchObject({ items: [{ value: 'second' }] })
    unbindNew()
    unbindNew()
    expect(await suggestions(f.editor)).toBeNull()
    f.runtime.dispose()
    const disposedProvider = f.editor.autocompleteProvider
    queued()
    f.runtime.bind(first)()
    f.runtime.refreshPresentation(true)
    expect(f.editor.autocompleteProvider).toBe(disposedProvider)
    expect(await suggestions(f.editor)).toBeNull()
  })

  it('keeps successor ownership when the same binding object is registered twice', async () => {
    const f = fixture()
    const input = bindings(provider('same object'))
    const first = f.runtime.bind(input)
    const old = f.editor.autocompleteProvider!
    const second = f.runtime.bind(input)
    first()
    expect(await suggestions(f.editor)).toMatchObject({ items: [{ value: 'same object' }] })
    expect(await old.getSuggestions(['/'], 0, 1, { signal: new AbortController().signal })).toBeNull()
    second()
  })

  it.each(['dispose', 'replace'] as const)('releases a synchronously retired source subscription on %s', async retirement => {
    const f = fixture()
    const off = vi.fn()
    const subscribe = vi.fn((listener: () => void) => {
      listener()
      if (retirement === 'dispose') f.runtime.dispose()
      else f.runtime.bind(bindings(provider('successor')))
      return off
    })
    const unbind = f.runtime.bind({ ...bindings(provider('retired')), autocomplete: { sources: () => [provider('retired')], subscribe } })
    expect(off).toHaveBeenCalledOnce()
    const current = f.editor.autocompleteProvider
    unbind()
    expect(f.editor.autocompleteProvider).toBe(current)
    expect(await suggestions(f.editor)).toEqual(retirement === 'dispose' ? null : expect.objectContaining({ items: [expect.objectContaining({ value: 'successor' })] }))
    if (retirement === 'dispose') expect(f.barrier()).toBeUndefined()
  })

  it.each(['replace', 'unbind'] as const)('keeps an input installed reentrantly during %s cleanup', async operation => {
    const f = fixture()
    const successor = bindings(provider('cleanup successor'))
    const off = vi.fn(() => { f.runtime.bind(successor) })
    const unbind = f.runtime.bind({ ...bindings(provider('first')), autocomplete: { sources: () => [], subscribe: () => off } })
    const skippedSubscribe = vi.fn(() => () => {})
    if (operation === 'replace') f.runtime.bind({ ...bindings(provider('skipped')), autocomplete: { sources: () => [], subscribe: skippedSubscribe } })
    else unbind()
    expect(off).toHaveBeenCalledOnce()
    expect(skippedSubscribe).not.toHaveBeenCalled()
    expect(await suggestions(f.editor)).toMatchObject({ items: [{ value: 'cleanup successor' }] })
  })

  it('retires an in-flight native-independent completion and never calls one queued after unload', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<{ readonly items: [], readonly prefix: string }>()
    let signal!: AbortSignal
    const source = provider('slow')
    source.getSuggestions = (_lines, _line, _col, options) => { signal = options.signal; return gate.promise }
    f.runtime.bind(bindings(source))
    const reading = suggestions(f.editor)
    await Promise.resolve()
    f.runtime.bind(bindings(provider('replacement')))
    expect(signal.aborted).toBe(true)
    gate.resolve({ items: [], prefix: '/' })
    expect(await reading).toBeNull()
    const callback = vi.fn(async () => ({ items: [], prefix: '/' }))
    f.runtime.bind(bindings({ ...provider('queued'), getSuggestions: callback }))
    const queued = suggestions(f.editor)
    f.runtime.dispose()
    expect(await queued).toBeNull()
    await Promise.resolve()
    expect(callback).not.toHaveBeenCalled()
  })

  it('defers captured metadata preparation until the original native submit commits and fences retired barriers', async () => {
    const f = fixture()
    const prepare = vi.fn((text: string) => ({ text: `${text}[file #1 receipt]` }))
    const captured = { ...bindings(provider('base')), captureSubmit: (source: string) => ({ text: source, attachments: Object.freeze([{ id: 'receipt', label: 'readme.txt', size: 12 }]), prepare }) }
    f.runtime.bind(captured)
    const requests: unknown[] = []
    const registration = f.ctx.mayflyEditorExtensions.register({ id: 'remote.transform', transformSubmit: request => { requests.push(request); return { text: `transformed:${request.text}` } } })
    cleanup.push(() => { registration.dispose() })
    const submit = attempt('raw draft')
    f.barrier()(submit)
    await vi.waitFor(() => { expect(submit.commit).toHaveBeenCalledOnce() })
    expect(prepare).not.toHaveBeenCalled()
    expect(requests).toEqual([{ text: 'raw draft', attachments: [{ id: 'receipt', label: 'readme.txt', size: 12 }] }])
    expect(f.runtime.takePrepared('raw draft')).toEqual({ text: 'transformed:raw draft[file #1 receipt]' })
    expect(prepare).toHaveBeenCalledOnce()
    expect(f.runtime.takePrepared('raw draft')).toBeUndefined()
    const oldBarrier = f.barrier()
    f.runtime.bind(bindings(provider('next')))
    const stale = attempt('old attempt')
    oldBarrier(stale)
    expect(stale.cancel).toHaveBeenCalledOnce()
    expect(stale.commit).not.toHaveBeenCalled()
    f.runtime.dispose()
    const unloaded = attempt('unloaded')
    ;(f.runtime as unknown as { beginSubmit(attempt: MayflyEditorSubmitAttempt): void }).beginSubmit(unloaded)
    expect(unloaded.cancel).toHaveBeenCalledOnce()
  })

  it('forces a palette rebuild around the retained editor and ignores queued registry and shell events after retirement', async () => {
    const { ctx } = fakeMayflyContext()
    const editor = new FakeMayflyEditor()
    const colors = vi.fn(() => ctx.mayflyTheme.colors)
    const components = vi.fn(() => ctx.mayflyComponents)
    let registrySnapshot!: Parameters<Parameters<typeof ctx.mayflyEditorExtensions.subscribe>[0]>[0]
    let registryListener!: Parameters<typeof ctx.mayflyEditorExtensions.subscribe>[0]
    const subscribe = ctx.mayflyEditorExtensions.subscribe.bind(ctx.mayflyEditorExtensions)
    vi.spyOn(ctx.mayflyEditorExtensions, 'subscribe').mockImplementation(listener => {
      registryListener = listener
      return subscribe(delta => { registrySnapshot = delta; listener(delta) })
    })
    const runtime = new EditorExtensionRuntime({ ctx, editor, colors, components, report: () => {}, frame: ({ parked }) => Editor({ shell: false, parked }) })
    cleanup.push(() => { runtime.dispose() })
    runtime.focused = true
    const focusedCount = components.mock.calls.length
    runtime.focused = true
    expect(components).toHaveBeenCalledTimes(focusedCount)
    const action = vi.fn()
    const registration = ctx.mayflyEditorExtensions.register({ id: 'remote.actions', onEvent: { action } }, { actions: [{ id: 'run', label: 'Run extension', key: 'ctrl+r' }] })
    cleanup.push(() => { registration.dispose() })
    const shell = (runtime as unknown as { shell: unknown }).shell
    const firstCount = components.mock.calls.length
    runtime.refreshPresentation()
    expect(components).toHaveBeenCalledTimes(firstCount)
    runtime.refreshPresentation(true)
    expect(components).toHaveBeenCalledTimes(firstCount + 1)
    expect(colors).toHaveBeenCalledTimes(firstCount + 1)
    const event: MayflyUiEvent = { kind: 'activate', pagePath: [], controlId: 'extension-0-0', actionId: 'extension-0-0' }
    ;(runtime as unknown as { dispatchShellEvent(shell: unknown, event: MayflyUiEvent): void }).dispatchShellEvent(shell, event)
    expect(action).not.toHaveBeenCalled()
    runtime.dispose()
    registryListener(registrySnapshot)
    runtime.dispatchEvent(event)
    editor.onKey = action
    runtime.handleInput('retired')
    runtime.invalidate()
    runtime.focused = true
    expect(runtime.focused).toBe(false)
    expect(runtime.render(80)).toEqual([])
    expect(action).not.toHaveBeenCalled()
  })
})
