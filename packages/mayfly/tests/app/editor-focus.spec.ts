/** Real core editor and transcript focus transitions through a recording terminal boundary. @module remote/tests/editor-focus */
import { Context } from '@deepseek-ai/cordis'
import {
  compileMayflyUiNode, MayflyComponentsService, MayflyKeymapService, MayflyScreenService,
  type MayflyComponent, type MayflyComponentsDeps, type MayflyFocusable, type MayflySemanticColors,
} from '../../src/core.ts'
import { INTERACTION_KEY_ACTIONS } from '../../src/command-panels.ts'
import { createTranscriptModel, TranscriptController } from '../../src/transcript.ts'
import * as Frontend from '../../src/frontend.ts'
import { ui } from '@ephemeral-ai/mayfly-ui'
import * as MayflyUiProvider from '@ephemeral-ai/mayfly-ui/provider'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountRemoteEditor, type RemoteEditorPresentation } from '../../src/app/editor.ts'

const identity = (text: string): string => text
const colors = new Proxy({ logoInks: Array.from({ length: 5 }, () => identity) }, {
  get: (target, property) => property === 'logoInks' ? target.logoInks : identity,
}) as unknown as MayflySemanticColors
const owners: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of owners.splice(0).reverse()) await dispose() })
const flush = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)) }

async function fixture(columns: number) {
  const ctx = new Context()
  await ctx.plugin(MayflyUiProvider)
  await ctx.plugin(Frontend)
  await ctx.plugin(MayflyKeymapService)
  ctx.mayflyKeymap.register([...INTERACTION_KEY_ACTIONS])
  const children: MayflyComponent[] = []
  const docks: MayflyComponent[] = []
  let focused: MayflyFocusable | null = null
  let scrollHandler: ((data: string) => boolean) | undefined
  const requestRender = vi.fn()
  // Only terminal delivery is doubled: the public screen owns every slot,
  // the shared transcript owns its list/search, and the real editor owns its caret.
  const runtime = {
    columns, rows: 30, mode: 'alternate', requestRender,
    surfaces: { views: { onEnteredChange: () => () => {}, panel: () => [], enter: () => false, leave() {} } },
    addChild(component: MayflyComponent) { children.push(component) },
    addBottomChild(component: MayflyComponent) { docks.push(component) },
    addDockChild(component: MayflyComponent) { docks.push(component) },
    removeChild(component: MayflyComponent) {
      const index = docks.indexOf(component)
      if (index >= 0) docks.splice(index, 1)
      if (focused === component) this.setFocus(null)
    },
    setFocus(component: MayflyFocusable | null) {
      if (focused !== null) focused.focused = false
      focused = component
      if (focused !== null) focused.focused = true
    },
    hasCapturingOverlay: () => false,
    surfaceLaneRows: () => 0, dockRows: () => 0,
    setContentScrollbarColors() {}, contentStart: () => 0,
    contentTail: () => undefined, watchContentTail: () => () => {},
    scrollContent: () => false, scrollContentTo() {}, followContent() {},
    setContentScrollHandler(handler: ((data: string) => boolean) | undefined) {
      scrollHandler = handler
      return () => { scrollHandler = undefined }
    },
  }
  await ctx.plugin(MayflyScreenService, runtime as unknown as ConstructorParameters<typeof MayflyScreenService>[1])
  const screen = ctx.mayflyScreen
  const components = new MayflyComponentsService(ctx, {
    theme: { colors }, tui: { requestRender, terminal: { rows: 30, columns } },
  } as unknown as MayflyComponentsDeps)
  const unbind = screen.bindNodeSlots({
    interaction: ctx.mayflyUiInteraction, components, colors, keymap: ctx.mayflyKeymap,
    mode: 'alternate', requestRender,
  })
  let presentation: RemoteEditorPresentation = {}
  const submit = vi.fn()
  const handle = mountRemoteEditor(ctx, screen, components, colors, { submit, onError: vi.fn(), cancel: vi.fn(), exit: vi.fn() }, () => presentation)
  const prompt = focused
  const modes: string[] = []
  const queued = [{ id: 'queued-one', text: 'queued message remains available', lane: 'turn' as const }]
  const transcript = new TranscriptController({
    t: (text, values) => text.replace(/\{([^}]+)\}/gu, (_token, key: string) => String(values?.[key] ?? '')),
    queued: () => queued,
    focusMode: mode => { modes.push(mode); ctx.emit('mayfly/focus-mode-changed', mode) },
  })
  transcript.setView('main', createTranscriptModel('focus', [ui.text('needle first turn'), ui.text('needle second turn')], false))
  transcript.show('main')
  transcript.attach(screen)
  const paint = (): string[] => [...children, ...docks].flatMap(child => child.render(columns))
  paint()
  const send = async (data: string): Promise<void> => {
    if (scrollHandler?.(data) !== true) focused?.handleInput?.(data)
    await flush(); paint()
  }
  owners.push(async () => { transcript.dispose(); handle.dispose(); unbind(); await ctx.fiber.dispose() })
  return {
    ctx, screen, components, editor: handle.editor, handle, prompt, transcript, modes, paint, send, submit, focused: () => focused,
    present(next: RemoteEditorPresentation) { presentation = next; handle.refresh() },
  }
}

describe('standalone editor and core transcript focus', () => {
  it('retires pending extension transform, completion and action on a real palette replacement while keeping the original native draft', async () => {
    const f = await fixture(80)
    const providers = vi.spyOn(f.editor, 'setAutocompleteProvider')
    const transform = Promise.withResolvers<{ readonly text: string }>()
    const complete = Promise.withResolvers<readonly { readonly id: string, readonly label: string, readonly insertText: string }[]>()
    const action = Promise.withResolvers<{ readonly kind: 'completed', readonly feedback: { readonly severity: 'success', readonly message: string } }>()
    const signals = new Map<string, AbortSignal>()
    const prepare = vi.fn((text: string) => ({ text, captured: { content: [{ type: 'text' as const, text }], pending: [], assertFileScope() {}, rollback() {} } }))
    const unbind = f.handle.extensions.bind({
      autocomplete: { sources: () => [], subscribe: () => () => {} },
      beginWait: () => () => {},
      captureSubmit: source => ({ text: source, attachments: [], prepare }),
      shouldTransformSubmit: () => true,
    })
    const registration = f.ctx.mayflyEditorExtensions.register({
      id: 'acme.palette-pending',
      transformSubmit: (_request, context) => { signals.set('transform', context.signal); return transform.promise },
      complete: (_request, context) => { signals.set('complete', context.signal); return complete.promise },
      onEvent: { action: (_event, context) => { signals.set('action', context.signal); return action.promise } },
    }, { actions: [{ id: 'apply', label: 'Apply extension', key: 'ctrl+r' }] })
    const suggestions = providers.mock.calls.at(-1)![0]!.getSuggestions(['@seed'], 0, 5, { signal: new AbortController().signal })
    f.editor.setText('original native draft')
    f.editor.submit()
    await f.send('\x12')
    await vi.waitFor(() => { expect(signals.size).toBe(3) })
    f.handle.retheme(f.components, colors)
    expect([...signals.values()].map(signal => signal.aborted)).toEqual([false, false, false])
    f.paint()
    const before = f.editor.renderContent(80)
    f.handle.retheme(f.components, new Proxy(colors, {}))
    expect([...signals.values()].map(signal => signal.aborted)).toEqual([true, true, true])
    transform.resolve({ text: 'late transformed draft' })
    complete.resolve([{ id: 'late', label: 'Late completion', insertText: 'late' }])
    action.resolve({ kind: 'completed', feedback: { severity: 'success', message: 'Late action feedback' } })
    expect(await suggestions).toBeNull()
    await flush()
    f.paint()
    expect(f.editor.getText()).toBe('original native draft')
    expect(f.editor.renderContent(80)).toEqual(before)
    expect(f.submit).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
    registration.dispose()
    unbind()
  })

  it.each([1, 8, 20, 40, 80, 160])('consumes direct extension decorations and actions through the retained editor shell at width %i', async width => {
    const f = await fixture(width)
    f.editor.setText('keep draft')
    for (let index = 0; index < 5; index++) await f.send('\x1b[D')
    const before = f.editor.renderContent(80)
    const action = vi.fn(() => ({ kind: 'completed' as const, feedback: { severity: 'success' as const, message: 'Extension applied', detail: 'full extension detail' } }))
    const registration = f.ctx.mayflyEditorExtensions.register({ id: 'acme.editor', onEvent: { action } }, {
      before: ui.text('before extension'), after: ui.text('after extension'), hint: 'extension hint',
      diagnostics: [{ id: 'warning', message: 'extension diagnostic', tone: 'warning' }],
      actions: [{ id: 'apply', label: 'Apply extension', key: 'ctrl+r' }],
    })
    f.present({ slashHint: 'no matching command: /unknown' })
    for (const row of f.paint()) expect(f.components.visibleWidth(row)).toBeLessThanOrEqual(width)
    if (width >= 40) {
      const rows = f.paint().join('\n')
      for (const text of ['before extension', 'after extension', 'extension hint', 'extension diagnostic', 'Apply extension', 'no matching command']) expect(rows).toContain(text)
    }
    await f.send('\x12')
    expect(action).toHaveBeenCalledOnce()
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toContainEqual(expect.objectContaining({
      severity: 'success', message: 'Extension applied', detail: 'full extension detail',
    }))
    registration.set({ after: ui.text('updated extension') })
    f.handle.retheme(f.components, colors)
    const repainted = f.paint()
    for (const row of repainted) expect(f.components.visibleWidth(row)).toBeLessThanOrEqual(width)
    expect(f.focused()).toBe(f.prompt)
    expect(f.editor.renderContent(80)).toEqual(before)
    if (width >= 40) expect(repainted.join('\n')).toContain('updated extension')
    registration.dispose()
    expect(f.paint().join('\n')).not.toContain('updated extension')
    await f.send('!')
    expect(f.editor.getText()).toBe('keep !draft')
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
  })

  it.each([1, 8, 20, 40, 80, 160])('preserves the exact draft caret across repeated transcript visits at width %i', async width => {
    const f = await fixture(width)
    f.editor.addToHistory('old recalled history')
    f.editor.setText('keep 猫 draft')
    for (let index = 0; index < 6; index++) await f.send('\x1b[D')
    const before = f.editor.renderContent(Math.max(width, 20))
    for (const [up, down] of [
      ['\x1b[1;3A', '\x1b[1;3B'],
      ['\x1bOS', '\x1b[15~'],
      ['\x1b[1;3A', '\x1b'],
    ] as const) {
      await f.send(up)
      expect(f.focused()).not.toBe(f.prompt)
      expect(f.editor.focused).toBe(false)
      expect(f.editor.getText()).toBe('keep 猫 draft')
      expect(f.modes.at(-1)).toBe('conversation')
      for (const row of f.paint()) expect(f.components.visibleWidth(row)).toBeLessThanOrEqual(width)
      await f.send(down)
      expect(f.focused()).toBe(f.prompt)
      expect(f.editor.focused).toBe(true)
      expect(f.modes.at(-1)).toBe('prompt')
      expect(f.editor.renderContent(Math.max(width, 20))).toEqual(before)
    }
    await f.send('!')
    expect(f.editor.getText()).toBe('keep 猫! draft')
  })

  it.each([20, 80, 160])('enters actual transcript search and returns through the native focus owner at width %i', async width => {
    const f = await fixture(width)
    await f.send('\x1b[1;3A')
    await f.send('/')
    expect(f.focused()).not.toBe(f.prompt)
    await f.send('needle')
    expect(f.paint().join('\n')).toContain('2')
    await f.send('\r')
    await f.send('\x1b')
    await f.send('\x1b')
    expect(f.focused()).toBe(f.prompt)
    expect(f.editor.getText()).toBe('')
    expect(f.paint().join('\n')).toContain('queued message')
  })

  it('retains the draft and caret across serial view switches while searching', async () => {
    const f = await fixture(80)
    f.editor.setText('before after')
    for (let index = 0; index < 6; index++) await f.send('\x1b[D')
    const before = f.editor.renderContent(80)
    f.transcript.setView('child', createTranscriptModel('child', [ui.text('child conversation')], false))
    for (const view of ['child', 'main', 'child', 'main']) {
      await f.send('\x1b[1;3A')
      await f.send('/')
      await f.send('needle')
      f.transcript.show(view)
      f.paint()
      expect(f.focused()).toBe(f.prompt)
      expect(f.editor.renderContent(80)).toEqual(before)
    }
    await f.send('!')
    expect(f.editor.getText()).toBe('before! after')
  })

  it('restores the retained editor and its caret after an editor overlay closes', async () => {
    const f = await fixture(80)
    f.editor.setText('before after')
    for (let index = 0; index < 6; index++) await f.send('\x1b[D')
    const before = f.editor.renderContent(80)
    const compiled = compileMayflyUiNode(ui.form({ id: 'overlay', fields: [{ kind: 'input', id: 'value', label: 'Overlay', value: '' }] }), {
      components: f.components, colors, keymap: f.ctx.mayflyKeymap,
      getViewport: () => ({ columns: 80, rows: 30 }), screenMode: 'alternate', emit: () => {},
      onUnhandledEscape: () => { f.screen.setEditorReplacement(null) },
    })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) throw new Error(compiled.message)
    f.screen.setEditorReplacement(compiled.value.focusTarget)
    expect(f.editor.focused).toBe(false)
    await f.send('\x1b')
    expect(f.editor.focused).toBe(true)
    expect(f.editor.renderContent(80)).toEqual(before)
    await f.send('\x1bOS')
    expect(f.modes.at(-1)).toBe('conversation')
    await f.send('\x1b[15~')
    expect(f.editor.renderContent(80)).toEqual(before)
    await f.send('!')
    expect(f.editor.getText()).toBe('before! after')
  })
})
