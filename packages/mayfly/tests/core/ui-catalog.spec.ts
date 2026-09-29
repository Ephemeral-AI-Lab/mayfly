/** Catalog behavior through public registrations, the frontend, and the core compiler. */
import { afterEach, expect, it, vi } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { validateMayflyUiNode } from '../../src/core/ui-validator.ts'
import { backgroundColor, foregroundColor } from '../../src/core/theme-palette.ts'
import { highlightCodeLines } from '../../src/core/highlight.ts'
import { furniture } from '../../src/core/glyphs.ts'
import { choiceSegment } from '../../src/core/ui-interaction-choice.ts'
import { transcriptFocus, transcriptNavigationHint, markTranscriptCursor, transcriptCursorRow } from '../../src/core/transcript-focus.ts'
import type { MayflyKeymap, MayflyScreen } from '../../src/core/types.ts'
import { requestFixture, renderRequest, flushRequests } from '../interaction/request-fixture.ts'
import { INTERACTION_KEY_ACTIONS } from '../../src/interaction/keys.ts'
import { matchesKeyAction } from '../../src/core/key-actions.ts'
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { SCAN_WIDTHS, expectLinesFit } from './width-scan.ts'

const contexts: Awaited<ReturnType<typeof requestFixture>>['ctx'][] = []
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

it('keeps model rows stationary while focus crosses segmented and plain rows, then commits only on Enter', async () => {
  const bench = await requestFixture()
  contexts.push(bench.ctx)
  const action = vi.fn(() => ({ kind: 'completed' as const }))
  bench.ctx.mayflyOverlays.open({ id: 'catalog', capturing: true, onEvent: { action } }, ui.surface({ chrome: 'overlay', title: 'Models', child: ui.list({ id: 'models', role: 'browse', acceptVerb: 'choose', selectedIds: [], items: [
    { id: 'one', label: 'Model one', segment: { inheritedId: 'high', options: [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }, { id: 'max', label: 'max' }] } },
    { id: 'two', label: 'Plain model' },
  ] }) }))
  const model = bench.ctx.mayflyUiInteraction.get('overlay', 'catalog')!
  const rendered = renderRequest(model)
  const before = rendered.component.render(80)
  expect(before.join('\n')).toContain('Enter choose')
  rendered.input('\x1b[B')
  expect(rendered.component.render(80)).toHaveLength(before.length)
  rendered.input('\x1b[A')
  rendered.input('\x1b[D')
  expect(choiceSegment(model.choice({ pagePath: [], controlId: 'models' })!, 'one')).toBe('low')
  expect(action).not.toHaveBeenCalled()
  rendered.input('\x1b[3~')
  expect(choiceSegment(model.choice({ pagePath: [], controlId: 'models' })!, 'one')).toBeUndefined()
  for (const width of SCAN_WIDTHS) expectLinesFit('catalog-models', rendered.component.render(width), width)
  rendered.input('\r')
  await flushRequests()
  expect(action).toHaveBeenCalledOnce()
  expect(action.mock.calls[0]?.[0]).toMatchObject({ kind: 'selection-accept', selectedIds: ['one'] })
  expect(action.mock.calls[0]?.[0]).not.toHaveProperty('segmentId')
  rendered.runtime.dispose()
})

it('admits additive fields and rejects invalid inheritance, hint verbs, reveal modes, and arm delays', async () => {
  const list = ui.list({ id: 'list', role: 'browse', acceptVerb: 'choose', selectedIds: [], items: [{ id: 'one', label: 'One', segment: { inheritedId: 'yes', options: [{ id: 'yes', label: 'Yes' }] } }] })
  expect(validateMayflyUiNode(list).ok).toBe(true)
  expect(validateMayflyUiNode({ ...list, acceptVerb: 'save' }).ok).toBe(false)
  expect(validateMayflyUiNode({ ...list, items: [{ id: 'one', label: 'One', segment: { inheritedId: 'yes', options: [{ id: 'yes', label: 'Yes', disabled: true }] } }] }).ok).toBe(false)
  expect(validateMayflyUiNode(ui.actions({ id: 'a', reveal: 'focus', items: [] })).ok).toBe(true)
  expect(validateMayflyUiNode({ kind: 'actions', id: 'a', reveal: 'never', items: [] }).ok).toBe(false)
  const bench = await requestFixture()
  contexts.push(bench.ctx)
  for (const armMs of [-1, 0.5, 2001, Number.NaN]) expect(() => bench.ctx.mayflyOverlays.open({ id: 'invalid', armMs }, ui.text('request'))).toThrow()
  expect(() => bench.ctx.mayflyOverlays.open({ id: 'label', escapeLabel: 'allow' as never }, ui.text('request'))).toThrow()
})

it('reveals actions only for their focused group without moving adjacent rows', async () => {
  const bench = await requestFixture()
  contexts.push(bench.ctx)
  const action = vi.fn(() => ({ kind: 'completed' as const }))
  bench.ctx.mayflyOverlays.open({ id: 'reveal-actions', capturing: true, onEvent: { action } }, ui.stack.column([
    ui.list({ id: 'choices', role: 'browse', selectedIds: [], items: [{ id: 'one', label: 'One' }] }),
    ui.actions({ id: 'secondary', reveal: 'focus', items: [{ id: 'save', label: 'Save choice' }] }),
    ui.text('After actions'),
  ]))
  const model = bench.ctx.mayflyUiInteraction.get('overlay', 'reveal-actions')!
  const view = renderRequest(model)
  const before = view.component.render(80)
  expect(before.join('\n')).not.toContain('Save choice')
  view.input('\t')
  const focused = view.component.render(80)
  expect(focused.join('\n')).toContain('Save choice')
  expect(focused.indexOf('After actions')).toBe(before.indexOf('After actions'))
  view.input('\r')
  await flushRequests()
  expect(action).toHaveBeenCalledOnce()
  view.input('\x1b[Z')
  expect(view.component.render(80).join('\n')).not.toContain('Save choice')
  view.runtime.dispose()
})

it('starts the guard on presentation, preserves it across renderer replacement, and rearms after hiding', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const bench = await requestFixture()
  contexts.push(bench.ctx)
  const handle = bench.ctx.mayflyOverlays.open({ id: 'guard', armMs: 300, capturing: true }, ui.text('Request'))
  const model = bench.ctx.mayflyUiInteraction.get('overlay', 'guard')!
  model.present()
  expect(model.inputArmed()).toBe(false)
  now.mockReturnValue(1299)
  const first = renderRequest(model)
  first.runtime.dispose()
  expect(model.inputArmed()).toBe(false)
  now.mockReturnValue(1300)
  expect(model.inputArmed()).toBe(true)
  handle.hide()
  handle.show()
  model.present()
  expect(model.inputArmed()).toBe(false)
  now.mockReturnValue(1600)
  expect(model.inputArmed()).toBe(true)
})

it('removes colors from code and palettes without altering content, and converts only requested furniture', () => {
  vi.stubEnv('NO_COLOR', '1')
  expect(foregroundColor('#123456')('text')).toBe('text')
  expect(backgroundColor('#123456')('text')).toBe('text')
  expect(highlightCodeLines('const x = 1\n', 'ts', value => value)).toEqual(['const x = 1', ''])
  expect(furniture('╭─╮│╰─╯▸▾✓✗✻', true)).toBe('+-+|+-+>v+x*')
  expect(furniture('text', true)).toBe('text')
  expect(furniture('╭─╮', false)).toBe('╭─╮')
})

it('routes transcript focus and hints through the same keymap and returns to the prompt on Escape', () => {
  const entries = new Map(INTERACTION_KEY_ACTIONS.map(action => [action.id, typeof action.keys === 'string' ? [action.keys] : action.keys]))
  const keymap = { getKeys: (id: string) => entries.get(id) ?? [], matches: (data: string, id: string) => matchesKeyAction(undefined, data, id) } as MayflyKeymap
  const change = vi.fn(() => 3 as number | undefined)
  const screen = { rows: 24, requestRender: vi.fn(), focusPrompt: vi.fn(), revealTranscriptRow: vi.fn(), scrollContent: vi.fn() } as unknown as MayflyScreen
  const child = { render: () => ['content'], invalidate: vi.fn() }
  const focus = transcriptFocus(child, keymap, screen, change, () => true)
  expect(focus.canFocus).toBe(true)
  focus.focused = true
  expect(focus.focused).toBe(true)
  expect(focus.render(80)).toEqual(['content'])
  focus.invalidate()
  expect(child.invalidate).toHaveBeenCalledOnce()
  for (const key of ['\x1b[A', '\x1b[B', '\x1b[H', '\x1b[F', '\r']) focus.handleInput?.(key)
  expect(change.mock.calls.slice(1).map(call => call[0])).toEqual(['previous', 'next', 'first', 'last', 'toggle'])
  focus.handleInput?.('\x1b[5~')
  focus.handleInput?.('\x1b[6~')
  expect(screen.scrollContent).toHaveBeenCalledWith('up', 20)
  expect(screen.scrollContent).toHaveBeenCalledWith('down', 20)
  change.mockReturnValue(undefined)
  focus.handleInput?.('\r')
  focus.handleInput?.('z')
  focus.handleInput?.('\x1b')
  expect(screen.focusPrompt).toHaveBeenCalledOnce()
  const hint = transcriptNavigationHint(keymap, false, value => value)
  expect(hint).toBe('↑/↓ turns · Enter expand · Esc leave')
  expect(transcriptNavigationHint(keymap, true, value => value)).toContain('Enter collapse')
  expect(transcriptNavigationHint({ getKeys: () => [] } as never, false, value => value)).toBe('')
})


it('pins the grammar footer inside a tall form while its fields scroll', async () => {
  const bench = await requestFixture()
  contexts.push(bench.ctx)
  bench.ctx.mayflyOverlays.open({ id: 'tall', capturing: true }, ui.surface({ chrome: 'overlay', title: 'Settings', child: ui.form({
    id: 'settings', submitActionId: 'save', fields: Array.from({ length: 20 }, (_, index) => ({ kind: 'input' as const, id: `f${index}`, label: `Field ${index}`, value: '' })),
  }) }))
  const model = bench.ctx.mayflyUiInteraction.get('overlay', 'tall')!
  const view = renderRequest(model, { columns: 50, rows: 8 })
  const rows = view.component.render(50)
  expect(rows).toHaveLength(8)
  expect(rows.at(-2)).toContain('Esc close')
  expect(rows.at(-1)).toContain('╰')
  view.runtime.dispose()
})


it('paints a width-safe transcript cursor in core and leaves unselected content untouched', () => {
  const colors = { textMuted: (value: string) => value } as never
  const components = { visibleWidth, truncateToWidth, wrapText: wrapTextWithAnsi } as never
  const rows = ['', 'selected turn']
  expect(transcriptCursorRow(rows)).toBe(-1)
  expect(markTranscriptCursor([], 20, undefined, components, colors)).toEqual([])
  for (const asciiGlyphs of [false, true]) {
    for (const width of SCAN_WIDTHS) {
      const painted = markTranscriptCursor(rows, width, 'Enter expand', { visibleWidth, truncateToWidth, wrapText: wrapTextWithAnsi, asciiGlyphs } as never, colors)
      expect(transcriptCursorRow(painted)).toBe(1)
      expectLinesFit('transcript-cursor', painted, width)
    }
  }
  expect(markTranscriptCursor(rows, 30, undefined, components, colors)).toHaveLength(2)
  expect(rows).toEqual(['', 'selected turn'])
})

it('switches labels-left pages locally, preserves drafts, and keeps navigation working after resize', async () => {
  const bench = await requestFixture()
  contexts.push(bench.ctx)
  const observe = vi.fn()
  const action = vi.fn(() => ({ kind: 'completed' as const }))
  bench.ctx.mayflyOverlays.open({ id: 'pages', capturing: true, onEvent: { action, observe } }, ui.surface({ chrome: 'overlay', child: ui.stack.row([
    ui.child(ui.tabs({ id: 'pages', orientation: 'vertical', activeId: 'a', items: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second', backId: 'a' }] }), { basis: 20 }),
    ...['a', 'b'].map(id => ui.child(
      ui.scroll(ui.form({ id: `form-${id}`, fields: [{ kind: 'input', id: `field-${id}`, label: `Field ${id}`, value: '' }] })),
      { tab: { controlId: 'pages', itemId: id } },
    )),
  ]) }))
  const model = bench.ctx.mayflyUiInteraction.get('overlay', 'pages')!
  const viewport = { columns: 90, rows: 18 }
  const view = renderRequest(model, viewport)
  view.component.render(90)
  view.input('\x1b[B')
  expect(model.activeTab({ pagePath: [], controlId: 'pages' })).toBe('b')
  view.component.render(90)
  view.input('\x1b[A')
  expect(model.activeTab({ pagePath: [], controlId: 'pages' })).toBe('a')
  view.input('\x1b[B')
  view.input('\x1b[C')
  view.input('\t')
  view.input('draft')
  view.input('\x1b')
  const address = { pagePath: [{ controlId: 'pages', itemId: 'b' }], formId: 'form-b', fieldId: 'field-b' }
  expect(model.form(address)?.fields['field-b']?.value).toContain('draft')
  viewport.columns = 40
  view.component.invalidate()
  expectLinesFit('vertical-tabs-small', view.component.render(40), 40)
  model.activateTab({ pagePath: [], controlId: 'pages' }, 'a')
  model.activateTab({ pagePath: [], controlId: 'pages' }, 'b')
  expect(model.form(address)?.fields['field-b']?.value).toContain('draft')
  expect(action).not.toHaveBeenCalled()
  view.runtime.dispose()
  const back = renderRequest(model, viewport)
  back.input('\x1b')
  expect(model.activeTab({ pagePath: [], controlId: 'pages' })).toBe('a')
  back.runtime.dispose()
})

it('coalesces cursor observations and prevents them from becoming action publications', async () => {
  const bench = await requestFixture()
  contexts.push(bench.ctx)
  const observed: string[] = []
  bench.ctx.mayflyOverlays.open({ id: 'cursor', capturing: true, onEvent: { observe: event => { observed.push(event.kind); return { kind: 'completed' } } } }, ui.list({ id: 'list', role: 'browse', selectedIds: [], items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }))
  const model = bench.ctx.mayflyUiInteraction.get('overlay', 'cursor')!
  const address = { pagePath: [], controlId: 'list' }
  model.updateChoice(address, { kind: 'focus', id: 'b' })
  model.updateChoice(address, { kind: 'focus', id: 'a' })
  await flushRequests()
  expect(observed).toEqual(['focus-change'])
  model.emit({ kind: 'focus-change', ...address, itemId: 'missing' })
  model.emit({ kind: 'focus-change', ...address, itemId: 'a' })
  await flushRequests()
  expect(observed).toEqual(['focus-change', 'focus-change'])
})

it.each(['action', 'field', 'tab'] as const)('returns a page to its %s focus target on Escape', async kind => {
  const bench = await requestFixture()
  contexts.push(bench.ctx)
  const first = kind === 'action' ? ui.actions({ id: 'first-actions', items: [{ id: 'safe', label: 'Safe', defaultFocus: true }] })
    : kind === 'field' ? ui.form({ id: 'first-form', fields: [{ kind: 'input', id: 'first-field', label: 'Value', value: '' }] }) : ui.text('First page')
  bench.ctx.mayflyOverlays.open({ id: `back-${kind}`, capturing: true }, ui.stack.column([
    ui.tabs({ id: 'pages', activeId: 'b', items: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second', backId: 'a' }] }),
    ui.child(first, { tab: { controlId: 'pages', itemId: 'a' } }),
    ui.child(ui.actions({ id: 'second-actions', items: [{ id: 'other', label: 'Other', defaultFocus: true }] }), { tab: { controlId: 'pages', itemId: 'b' } }),
  ]))
  const model = bench.ctx.mayflyUiInteraction.get('overlay', `back-${kind}`)!
  const view = renderRequest(model)
  view.component.render(80)
  view.input('\x1b')
  expect(model.activeTab({ pagePath: [], controlId: 'pages' })).toBe('a')
  expect(model.focus?.controlId).toBe(kind === 'action' ? 'safe' : kind === 'field' ? 'first-field' : 'pages')
  view.runtime.dispose()
})

it('collects a row segment together with an explicit action and ignores disabled-only segment movement', async () => {
  const bench = await requestFixture()
  contexts.push(bench.ctx)
  const action = vi.fn(() => ({ kind: 'completed' as const }))
  bench.ctx.mayflyOverlays.open({ id: 'selection-action', capturing: true, onEvent: { action } }, ui.stack.column([
    ui.list({ id: 'list', role: 'browse', selectedIds: [], items: [{ id: 'a', label: 'A', segment: { options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], selectedId: 'high' } }] }),
    ui.actions({ id: 'actions', items: [{ id: 'apply', label: 'Apply', selections: [{ pagePath: [], controlId: 'list' }] }] }),
  ]))
  const model = bench.ctx.mayflyUiInteraction.get('overlay', 'selection-action')!
  model.invoke('apply')
  await flushRequests()
  expect(action.mock.calls[0]?.[0]).toMatchObject({ kind: 'activate', inputs: { selections: [{ controlId: 'list', segmentId: 'high' }] } })
})
