/**
 * The keys of a form (roadmap slice 1.6): completions, number steps, Enter and Space on a select or toggle of a form that
 * Enter submits, `ui.save` from any field, the buttons a form draws, Escape's cancel action, the unsaved-changes badge,
 * the rules shown once an edit is over, and the hint row in every form state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ui, type MayflyUiEvent, type MayflyUiNode } from '../../../ui/src/index.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode, type MayflyUiCompilerOptions } from '../../src/core/ui-compiler.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { createFakeEditor } from './fake-editor.ts'

const identity = (value: string) => value
const colors = new Proxy({ logoGradient: [identity] }, { get: (_target, key) => key === 'logoGradient' ? [identity] : identity }) as MayflySemanticColors
const components = { createEditor: createFakeEditor, visibleWidth, truncateToWidth, wrapText: wrapTextWithAnsi } as MayflyComponents
const plain = (rows: readonly string[]): string => rows.join('\n').replace(/\x1b\[[0-9;]*m/gu, '').replace(/\x1b_[^\x07]*\x07/gu, '')

const DOWN = '\x1b[B'
const UP = '\x1b[A'
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const TAB = '\t'
const ESC = '\x1b'
const ENTER = '\r'
const CTRL_S = '\x13'
const DELETE = '\x1b[3~'

const models: UiSurfaceModel[] = []
afterEach(() => { for (const model of models.splice(0)) model.dispose() })

/** A surface over `node`, its events, and the keys it takes. */
function open(node: MayflyUiNode, options: { readonly columns?: number, readonly onEscape?: (() => void) | null, readonly dismissal?: 'discard' } = {}) {
  const events: MayflyUiEvent[] = []
  const model = new UiSurfaceModel('keys', {
    id: 'keys', revision: 0, source: [], scope: { kind: 'app', targetId: 'keys' }, update: { reason: 'data' }, node,
    events: { prepare: async event => { events.push(event); return { reply: { kind: 'completed' as const }, publish: () => true } } },
    definition: { ...options.dismissal === undefined ? {} : { dismissal: options.dismissal } },
  } as never)
  models.push(model)
  const viewport = { columns: options.columns ?? 80, rows: 40 }
  const compileOptions: MayflyUiCompilerOptions = { components, colors, getViewport: () => viewport, screenMode: 'alternate', emit: event => model.emit(event), contextHints: { enabled: true }, surfaceRuntime: new MayflyUiSurfaceRuntime(model), ...options.onEscape === null ? {} : { onUnhandledEscape: options.onEscape ?? (() => {}) } }
  const result = compileMayflyUiSurfaceNode(model.node!, compileOptions)
  if (!result.ok) throw new Error(result.message)
  const focus = result.value.focusTarget!
  focus.focused = true
  const render = (): string => plain(result.value.component.render(viewport.columns))
  const press = (...keys: string[]): string => { for (const key of keys) focus.handleInput?.(key); return render() }
  const hint = (): string => plain(result.value.component.render(viewport.columns)).split('\n').at(-1)!
  const draft = (fieldId: string, formId = 'form') => model.form({ pagePath: [], formId })!.fields[fieldId]!
  const submitted = (): MayflyUiEvent[] => events.filter(event => event.kind === 'submit')
  return { model, events, press, render, hint, draft, submitted, focus }
}

const save = (formId = 'form') => ui.actions({ id: 'bar', items: [{ id: 'save', label: 'Save', intent: 'primary', submit: [{ pagePath: [], formId }] }] })

describe('completions', () => {
  const directory = ui.stack.column([ui.form({ id: 'form', fields: [
    { kind: 'input', id: 'dir', label: 'Directory', value: '', suggestions: ['~/work/mayfly', '~/work/website', '~/notes'] },
    { kind: 'input', id: 'other', label: 'Other', value: '' },
  ] }), save()])

  it('shows the matching completion with ⇥ while the field is edited, and Tab takes it', () => {
    const { press, render, hint, draft } = open(directory)
    press(ENTER, '~/w')
    expect(render()).toContain('⇥ ~/work/mayfly')
    expect(render()).toContain('  ~/work/website')
    expect(hint()).toBe('  Enter next · Tab complete · Esc done')
    press(TAB)
    expect(draft('dir').value).toBe('~/work/mayfly')
    // Nothing is left to complete: Tab now leaves the field like it does anywhere else.
    expect(hint()).toBe('  Enter next · Tab/Shift+Tab groups · Esc done')
    expect(render()).not.toContain('⇥')
    press(TAB)
    expect(render()).toContain('→ Other')
  })

  it('lets Tab leave a field whose text matches no suggestion, and offers no completion on a number', () => {
    const { press, hint, render } = open(directory)
    press(ENTER, 'zzz')
    expect(hint()).toBe('  Enter next · Tab/Shift+Tab groups · Esc done')
    press(TAB)
    expect(render()).toContain('→ Other')
    const numeric = open(ui.stack.column([ui.form({ id: 'form', fields: [{ kind: 'number', id: 'n', label: 'N', value: 3 }] }), save()]))
    numeric.press(ENTER)
    expect(numeric.hint()).toBe('  Enter next · Tab/Shift+Tab groups · Esc done')
  })

  it('completes the one suggestion that starts with what is typed', () => {
    const { press, draft } = open(directory)
    press(ENTER, '~/n')
    press(TAB)
    expect(draft('dir').value).toBe('~/notes')
  })
})

describe('numbers', () => {
  const timeout = ui.form({ id: 'form', fields: [
    { kind: 'number', id: 'timeout', label: 'Timeout', value: 30, min: 5, max: 40, step: 5, unit: 's' },
    { kind: 'input', id: 'name', label: 'Name', value: '' },
  ] })

  it('steps with ←/→ and hints the step', () => {
    const { press, render, hint, draft } = open(timeout)
    expect(render()).toContain('‹ 30 › s  5–40')
    expect(hint()).toBe('  ↑/↓ fields · ←/→ step · Enter edit · Esc close')
    press(RIGHT)
    expect(draft('timeout')).toMatchObject({ value: '35', change: 'set' })
    expect(render()).toContain('‹ 35 › s')
    press(DOWN)
    expect(render()).toContain('• Timeout')
    press(UP, RIGHT, RIGHT)
    expect(draft('timeout').value).toBe('40')
    press(LEFT)
    expect(draft('timeout').value).toBe('35')
  })

  it('hands ←/→ to the control beside it when the number cannot move further', () => {
    const { press, draft, render } = open(ui.stack.row([
      ui.child(ui.form({ id: 'form', fields: [{ kind: 'number', id: 'timeout', label: 'Timeout', value: 5, min: 5, max: 40 }] })),
      ui.child(ui.actions({ id: 'side', items: [{ id: 'go', label: 'Go' }] })),
    ]))
    press(LEFT)
    expect(draft('timeout').value).toBe('5')
    press(RIGHT, RIGHT)
    expect(draft('timeout').value).toBe('7')
    expect(render()).toContain('Go')
  })
})

describe('Enter and Space on a form that Enter submits', () => {
  const answers = ui.stack.column([
    ui.form({ id: 'form', enterSubmits: 'save', fields: [
      { kind: 'input', id: 'name', label: 'Name', value: 'x' },
      { kind: 'select', id: 'region', label: 'Region', value: 'us', options: [{ id: 'us', label: 'US' }, { id: 'eu', label: 'EU' }] },
      { kind: 'multiselect', id: 'tags', label: 'Tags', value: [], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { kind: 'toggle', id: 'on', label: 'On', value: false },
    ] }),
    save(),
  ])

  it('submits on Enter from a select, and Space opens its picker', async () => {
    const { press, hint, submitted, render, draft } = open(answers)
    press(DOWN)
    expect(hint()).toBe('  ↑/↓ fields · ←/→ adjust · Enter continue · Esc close')
    press(ENTER)
    await vi.waitFor(() => expect(submitted()).toHaveLength(1))
    press(' ')
    expect(hint()).toBe('  ↑/↓ options · Enter apply · Tab/Shift+Tab groups · Esc cancel')
    expect(render()).toContain('→ ● US')
    press(DOWN, ENTER)
    expect(draft('region').value).toBe('eu')
  })

  it('submits on Enter from a multiselect and a toggle, and Space flips the toggle', async () => {
    const { press, hint, submitted, draft } = open(answers)
    press(DOWN, DOWN)
    press(ENTER)
    await vi.waitFor(() => expect(submitted()).toHaveLength(1))
    press(DOWN)
    expect(hint()).toBe('  ↑/↓ fields · Enter continue · Tab/Shift+Tab groups · Esc close')
    press(' ')
    expect(draft('on').value).toBe(true)
    press(ENTER)
    await vi.waitFor(() => expect(submitted()).toHaveLength(2))
  })

  it('keeps Enter for the picker and the flip when the form does not submit on Enter', () => {
    const { press, hint, draft } = open(ui.form({ id: 'form', fields: [
      { kind: 'select', id: 'region', label: 'Region', value: 'us', options: [{ id: 'us', label: 'US' }, { id: 'eu', label: 'EU' }] },
      { kind: 'toggle', id: 'on', label: 'On', value: false },
    ] }))
    expect(hint()).toBe('  ↑/↓ fields · ←/→ adjust · Enter pick · Esc close')
    press(ENTER, DOWN, ENTER)
    expect(draft('region').value).toBe('eu')
    press(DOWN)
    expect(hint()).toBe('  ↑/↓ fields · Enter toggle · Esc close')
    press(ENTER)
    expect(draft('on').value).toBe(true)
  })

  it('submits on Enter from a single-field form that names a submit action, without drawing a button', async () => {
    const { press, render, submitted, hint } = open(ui.stack.column([
      ui.form({ id: 'form', submitActionId: 'save', fields: [{ kind: 'input', id: 'name', label: 'Name', value: 'x' }] }),
      ui.actions({ id: 'bar', items: [{ id: 'save', label: 'Save', hidden: true, submit: [{ pagePath: [], formId: 'form' }] }] }),
    ]))
    expect(render()).not.toContain('Save')
    expect(hint()).toBe('  Enter submit · Esc close')
    press(ENTER, ENTER)
    await vi.waitFor(() => expect(submitted()).toHaveLength(1))
  })
})

describe('ui.save', () => {
  const profile = (extra: Record<string, unknown> = {}, bar = save()) => ui.stack.column([
    ui.form({ id: 'form', ...extra, fields: [
      { kind: 'input', id: 'name', label: 'Name', value: 'x' },
      { kind: 'select', id: 'region', label: 'Region', value: 'us', options: [{ id: 'us', label: 'US' }, { id: 'eu', label: 'EU' }] },
      { kind: 'toggle', id: 'on', label: 'On', value: false },
    ] } as never),
    bar,
  ])

  it('submits the form from a field being edited, a select, a toggle, and a picker', async () => {
    const { press, submitted } = open(profile())
    press(ENTER, 'y', CTRL_S)
    await vi.waitFor(() => expect(submitted()).toHaveLength(1))
    expect((submitted()[0] as Extract<MayflyUiEvent, { readonly kind: 'submit' }>).submission.forms[0]!.fields[0]).toMatchObject({ id: 'name', value: 'xy' })
    press(DOWN)
    press(CTRL_S)
    await vi.waitFor(() => expect(submitted()).toHaveLength(2))
    press(ENTER, CTRL_S)
    await vi.waitFor(() => expect(submitted()).toHaveLength(3))
    press(ESC, DOWN)
    press(CTRL_S)
    await vi.waitFor(() => expect(submitted()).toHaveLength(4))
  })

  it('runs the form submit action, and the action Enter submits through, before searching the actions', async () => {
    const own = open(profile({ submitActionId: 'commit' }, ui.actions({ id: 'bar', items: [{ id: 'commit', label: 'Commit', hidden: true, submit: [{ pagePath: [], formId: 'form' }] }] })))
    own.press(CTRL_S)
    await vi.waitFor(() => expect(own.submitted()).toHaveLength(1))
    const enter = open(profile({ enterSubmits: 'send' }, ui.actions({ id: 'bar', items: [{ id: 'send', label: 'Send', hidden: true, submit: [{ pagePath: [], formId: 'form' }] }] })))
    enter.press(CTRL_S)
    await vi.waitFor(() => expect(enter.submitted()).toHaveLength(1))
  })

  it('prefers the primary action that submits the form, and does nothing when none does', async () => {
    const two = open(profile({}, ui.actions({ id: 'bar', items: [
      { id: 'draft', label: 'Draft', submit: [{ pagePath: [], formId: 'form' }] },
      { id: 'publish', label: 'Publish', intent: 'primary', submit: [{ pagePath: [], formId: 'form' }] },
    ] })))
    two.press(CTRL_S)
    await vi.waitFor(() => expect(two.submitted()).toHaveLength(1))
    expect(two.events.at(-1)).toMatchObject({ kind: 'submit', controlId: 'form' })
    const none = open(profile({}, ui.text('no button')))
    none.press(CTRL_S)
    none.press(ENTER, CTRL_S)
    await Promise.resolve()
    expect(none.submitted()).toHaveLength(0)
  })

  it('submits from the Save button a multi-field form draws', async () => {
    const { press, render, submitted } = open(ui.form({ id: 'form', submitActionId: 'save', fields: [
      { kind: 'input', id: 'name', label: 'Name', value: 'x' },
      { kind: 'input', id: 'other', label: 'Other', value: '' },
    ] }))
    expect(render()).toContain('[ Save ]')
    press(DOWN, DOWN)
    press(CTRL_S)
    await vi.waitFor(() => expect(submitted()).toHaveLength(1))
  })
})

describe('buttons', () => {
  const pair = [
    { kind: 'input' as const, id: 'name', label: 'Name', value: 'x' },
    { kind: 'input' as const, id: 'other', label: 'Other', value: '' },
  ]

  it('draws one primary Save, worded by submitLabel, and never a Cancel', () => {
    const named = open(ui.form({ id: 'form', submitActionId: 'save', submitLabel: 'Apply', cancelActionId: 'close', cancelLabel: 'Never', fields: pair }))
    expect(named.render()).toContain('[ Apply ]')
    expect(named.render()).not.toContain('Never')
    expect(named.render()).not.toContain('Cancel')
    expect(open(ui.form({ id: 'form', submitActionId: 'save', fields: pair })).render()).toContain('[ Save ]')
    expect(open(ui.form({ id: 'form', submitActionId: 'save', fields: [] })).render()).toContain('[ Save ]')
    expect(open(ui.form({ id: 'form', submitActionId: 'save', fields: [pair[0]!] })).render()).not.toContain('Save')
    expect(open(ui.form({ id: 'form', fields: pair })).render()).not.toContain('Save')
  })

  it('runs cancelActionId as the outermost Escape, asking first when there are edits', () => {
    const escaped = vi.fn()
    const closed = vi.fn()
    const surface = open(ui.form({ id: 'form', cancelActionId: 'close', fields: pair }), { onEscape: escaped })
    surface.model.bindings.close = closed
    expect(surface.hint()).toBe('  ↑/↓ fields · Enter edit · Esc close')
    surface.press(ESC)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(escaped).not.toHaveBeenCalled()
    surface.press('y', ESC)
    expect(closed).toHaveBeenCalledTimes(1)
    surface.press(ESC)
    expect(surface.model.decisionNode).toBeDefined()
  })

  it('closes through cancelActionId even where the host gave Escape no handler, and says so', () => {
    const surface = open(ui.form({ id: 'form', cancelActionId: 'close', fields: pair }), { onEscape: null })
    const closed = vi.fn()
    surface.model.bindings.close = closed
    expect(surface.hint()).toBe('  ↑/↓ fields · Enter edit · Esc cancel')
    surface.press(ESC)
    expect(closed).toHaveBeenCalledTimes(1)
    // A form without one leaves Escape to the host, or to nobody.
    const hosted = vi.fn()
    const plainForm = open(ui.form({ id: 'form', fields: pair }), { onEscape: hosted })
    plainForm.press(ESC)
    expect(hosted).toHaveBeenCalledTimes(1)
    const unhosted = open(ui.form({ id: 'form', fields: pair }), { onEscape: null })
    unhosted.press(ESC)
    expect(unhosted.hint()).toBe('  ↑/↓ fields · Enter edit')
  })
})

describe('the unsaved-changes badge', () => {
  it('shows in the surface head while a form is dirty, after the badges the author gave', () => {
    const surface = open(ui.surface({ chrome: 'overlay', title: 'Edit provider', badges: [{ text: 'running', tone: 'success' }], child: ui.form({ id: 'form', fields: [
      { kind: 'input', id: 'name', label: 'Name', value: 'x' },
    ] }) }))
    expect(surface.render().split('\n')[0]).toMatch(/Edit provider ─+ running ╮$/u)
    surface.press(ENTER, 'y', ESC)
    expect(surface.render().split('\n')[0]).toMatch(/Edit provider ─+ running unsaved changes ╮$/u)
    surface.press(DELETE)
    expect(surface.render().split('\n')[0]).not.toContain('unsaved changes')
  })

  it('drops the badge before the title when the head is narrow', () => {
    const surface = open(ui.surface({ chrome: 'overlay', title: 'Edit provider', child: ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: 'x' }] }) }), { columns: 20 })
    surface.press(ENTER, 'y', ESC)
    expect(surface.render().split('\n')[0]).toContain('Edit provider')
    expect(surface.render().split('\n')[0]).not.toContain('unsaved')
  })
})

describe('rules and refused saves', () => {
  const fields = ui.form({ id: 'form', fields: [
    { kind: 'input', id: 'url', label: 'Endpoint', value: 'https://a.example', pattern: '^https?://\\S+$', patternMessage: 'Must be an http(s) URL', required: true },
    { kind: 'input', id: 'name', label: 'Name', value: '' },
  ] })

  it('shows a broken rule under the field once the edit is over, and only then', () => {
    const { press, render, model } = open(fields)
    press(ENTER, ' z')
    expect(render()).not.toContain('Must be')
    press(ENTER)
    expect(render()).toContain('! Must be an http(s) URL')
    press(ESC)
    model.edit({ pagePath: [], formId: 'form', fieldId: 'url' }, 'https://b.example')
    expect(render()).not.toContain('Must be')
    model.edit({ pagePath: [], formId: 'form', fieldId: 'url' }, '')
    expect(render()).toContain('! Required')
  })

  it('refuses a save with the highlighted fields, keeping focus where it was', async () => {
    const { press, render, model, submitted } = open(ui.stack.column([
      ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '', required: true }, { kind: 'toggle', id: 'on', label: 'On', value: false }] }),
      save(),
    ]))
    press(DOWN, DOWN, ENTER)
    expect(render()).toContain('! Required')
    expect(model.feedbackSnapshot().at(-1)).toMatchObject({ severity: 'warning', message: 'Fix the highlighted fields' })
    expect(render()).toContain('→')
    expect(submitted()).toHaveLength(0)
  })

  it('brings an error on another page forward', () => {
    const pages = ui.stack.column([
      ui.tabs({ id: 'pages', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.child(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '', required: true }] }), { tab: { controlId: 'pages', itemId: 'two' } }),
      ui.child(ui.actions({ id: 'bar', items: [{ id: 'save', label: 'Save', submit: [{ pagePath: [{ controlId: 'pages', itemId: 'two' }], formId: 'form' }] }] }), { tab: { controlId: 'pages', itemId: 'one' } }),
    ])
    const { press, model } = open(pages)
    press(DOWN, ENTER)
    expect(model.activeTab({ pagePath: [], controlId: 'pages' })).toBe('two')
  })
})

describe('the hint row in each form state', () => {
  const kinds = ui.form({ id: 'form', fields: [
    { kind: 'input', id: 'name', label: 'Name', value: 'x' },
    { kind: 'secret', id: 'key', label: 'Key', value: 'sk' },
    { kind: 'textarea', id: 'notes', label: 'Notes', value: '' },
    { kind: 'number', id: 'n', label: 'N', value: 1, origin: 'inherited', resetValue: 1 },
    { kind: 'select', id: 'mode', label: 'Mode', value: 'a', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    { kind: 'multiselect', id: 'tags', label: 'Tags', value: [], options: [{ id: 'a', label: 'A' }] },
    { kind: 'toggle', id: 'on', label: 'On', value: false },
  ], submitActionId: 'save' })

  it('words each state the way the kit does', () => {
    const { press, hint } = open(kinds)
    expect(hint()).toBe('  ↑/↓ fields · Enter edit · Esc close')
    press(ENTER)
    expect(hint()).toBe('  Enter next · Esc done')
    press(ESC, DOWN, DOWN, ENTER)
    expect(hint()).toBe('  Enter next · Alt+Enter newline · Esc done')
    press(ESC, DOWN)
    expect(hint()).toBe('  ↑/↓ fields · ←/→ step · Enter edit · Esc close')
    press(RIGHT)
    expect(hint()).toBe('  ←/→ step · Enter edit · Delete use inherited · Esc close')
    press(DOWN)
    expect(hint()).toBe('  ↑/↓ fields · ←/→ adjust · Enter pick · Esc close')
    press(DOWN)
    expect(hint()).toBe('  ↑/↓ fields · Enter pick · Esc close')
    press(ENTER)
    expect(hint()).toBe('  Space toggle · Enter apply · Esc cancel')
    press(ESC, DOWN)
    expect(hint()).toBe('  ↑/↓ fields · Enter toggle · Esc close')
    press(DOWN)
    expect(hint()).toBe('  ↑/↓ fields · Enter submit · Esc close')
  })

  it('names Delete reset for an edited field and keeps it narrow-safe', () => {
    const { press, hint } = open(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: 'x' }] }), { columns: 70 })
    press(ENTER, 'y', ESC)
    expect(hint()).toBe('  Enter edit · Delete reset · Esc close')
  })
})
