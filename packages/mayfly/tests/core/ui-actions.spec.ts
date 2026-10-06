/**
 * Action items as named actions (roadmap slice 1.7): the naming rules the validator enforces, the static key claims
 * of a common meaning, action scopes, and the compiler resolving an item's effective keys on every key and paint.
 */
import { describe, expect, it } from 'vitest'
import { ui, type MayflyUiEvent } from '../../../ui/src/index.ts'
import {
  COMMON_MEANINGS, actionHintLabel, actionNamingProblem, actionScopeActive, defaultItemKey, effectiveItemKeys, itemActionId,
} from '../../src/core/ui-actions.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode, type MayflyUiCompilerOptions } from '../../src/core/ui-compiler.ts'
import { validateMayflyEditorShellNode, validateMayflyUiNode } from '../../src/core/ui-validator.ts'
import type { MayflyKeymap, MayflySemanticColors } from '../../src/core/types.ts'
import { parityComponents } from '../design/parity.ts'

const identity = (value: string): string => value
const colors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as MayflySemanticColors

/** A keymap stand-in that answers `getKeys` from a table, the way the real one answers an override. */
function keymapWith(keys: Readonly<Record<string, readonly string[]>>): MayflyKeymap {
  return { getKeys: (action: string) => [...keys[action] ?? []], matches: () => false } as unknown as MayflyKeymap
}

function surface(node: unknown, overrides: Partial<MayflyUiCompilerOptions> = {}) {
  const events: MayflyUiEvent[] = []
  const result = compileMayflyUiSurfaceNode(node, {
    components: parityComponents(),
    colors,
    getViewport: () => ({ columns: 100, rows: 30 }),
    screenMode: 'alternate',
    emit: event => events.push(event),
    contextHints: { enabled: true },
    ...overrides,
    surfaceRuntime: new MayflyUiSurfaceRuntime(),
  })
  if (!result.ok) throw new Error(result.message)
  const focus = result.value.focusTarget!
  focus.focused = true
  return {
    events,
    press: (data: string) => { focus.handleInput?.(data) },
    hint: () => focus.render(100).at(-1) ?? '',
    activated: () => events.flatMap(event => event.kind === 'activate' ? [event.actionId] : []),
  }
}

describe('action naming', () => {
  it('names an item by its meaning or its component action', () => {
    expect(COMMON_MEANINGS).toEqual(['save', 'copy', 'delete', 'refresh', 'external', 'search'])
    expect(itemActionId({ semantic: 'delete' })).toBe('ui.delete')
    expect(itemActionId({ action: 'demo-plugin.install', key: 'i' })).toBe('demo-plugin.install')
    expect(itemActionId({ key: 'ctrl+y' })).toBeUndefined()
    expect(defaultItemKey({ semantic: 'save' })).toBe('ctrl+s')
    expect(defaultItemKey({ key: 'ctrl+y' })).toBe('ctrl+y')
    expect(actionHintLabel({ label: 'Copy link', hintLabel: 'copy link' })).toBe('copy link')
    expect(actionHintLabel({ label: 'Copy' })).toBe('Copy')
  })

  it.each([
    [{ semantic: 'copy', key: 'c' }, '.semantic and .key are exclusive'],
    [{ semantic: 'copy', action: 'demo.copy' }, '.semantic and .action are exclusive'],
    [{ action: 'install' }, 'must be an <owner>.<action> id'],
    [{ action: 'Demo.Install' }, 'must be an <owner>.<action> id'],
    [{ action: 'demo..install' }, 'must be an <owner>.<action> id'],
    [{ action: 'ui.copy' }, 'reserved ui.* namespace'],
  ] as const)('refuses %j', (item, problem) => {
    expect(actionNamingProblem(item)).toContain(problem)
    expect(validateMayflyUiNode(ui.actions({ id: 'bar', items: [{ id: 'x', label: 'X', ...item }] }))).toMatchObject({ ok: false, message: expect.stringContaining(problem) })
  })

  it('admits a meaning, a component action, and a hint label', () => {
    const node = ui.actions({ id: 'bar', items: [
      { id: 'remove', label: 'Remove', semantic: 'delete', hidden: true },
      { id: 'install', label: 'Install', action: 'demo-plugin.install', key: 'i', hintLabel: 'install' },
      { id: 'later', label: 'Later', action: 'demo-plugin.later.v2' },
    ] })
    expect(actionNamingProblem({ action: 'demo-plugin.later.v2' })).toBeUndefined()
    expect(validateMayflyUiNode(node)).toEqual({ ok: true, value: node })
    expect(validateMayflyUiNode(ui.actions({ id: 'bar', items: [{ id: 'x', label: 'X', semantic: 'undo' as never }] })))
      .toMatchObject({ ok: false, message: expect.stringContaining('.semantic is invalid') })
  })

  it('claims a meaning\'s default key on the page, so a printable one is refused beside a type-to-filter list', () => {
    const list = ui.list({ id: 'rows', role: 'browse', selectedIds: [], filterable: true, items: [{ id: 'a', label: 'A' }] })
    expect(validateMayflyUiNode(ui.stack.column([list, ui.actions({ id: 'bar', items: [{ id: 'copy', label: 'Copy', semantic: 'copy', hidden: true }] })])))
      .toMatchObject({ ok: false, message: expect.stringContaining('semantic "copy" would swallow typed filter text') })
    expect(validateMayflyUiNode(ui.stack.column([list, ui.actions({ id: 'bar', items: [{ id: 'save', label: 'Save', semantic: 'save' }] })])).ok).toBe(true)
    expect(validateMayflyUiNode(ui.actions({ id: 'bar', items: [{ id: 'copy', label: 'Copy', semantic: 'copy' }, { id: 'mine', label: 'Mine', key: 'c' }] })))
      .toMatchObject({ ok: false, message: expect.stringContaining('.key "c" is already bound on this page') })
  })

  it('leaves a meaning out of an editor shell, which owns unmodified keys', () => {
    const shell = { kind: 'stack', direction: 'column', children: [
      { node: { kind: 'editor-control' } },
      { node: ui.actions({ id: 'bar', items: [{ id: 'save', label: 'Save', semantic: 'save' }] }) },
    ] }
    expect(validateMayflyEditorShellNode(shell)).toMatchObject({ ok: false, message: expect.stringContaining('needs a modifier accelerator') })
  })
})

describe('action scope', () => {
  const rows = (id: string) => ui.list({ id, role: 'browse', selectedIds: [], items: [{ id: `${id}-a`, label: 'A' }] })
  const scoped = (id: string, scope: string | readonly string[], key = 'ctrl+y') => ui.actions({ id, scope, items: [{ id: `${id}-run`, label: 'Run', key, hidden: true }] })

  it('names one or more distinct controls on the page or an enclosing one', () => {
    expect(validateMayflyUiNode(ui.stack.column([scoped('bar', 'left'), rows('left')])).ok).toBe(true)
    expect(validateMayflyUiNode(ui.stack.column([rows('left'), rows('right'), scoped('bar', ['left', 'right'])])).ok).toBe(true)
    expect(validateMayflyUiNode(ui.stack.column([rows('left'), scoped('bar', 'nowhere')])))
      .toMatchObject({ ok: false, message: expect.stringContaining('$.children[1].node.scope "nowhere" names no control on this page') })
    expect(validateMayflyUiNode(ui.stack.column([rows('left'), scoped('bar', [])]))).toMatchObject({ ok: false, message: expect.stringContaining('one or more distinct controls') })
    expect(validateMayflyUiNode(ui.stack.column([rows('left'), scoped('bar', ['left', 'left'])]))).toMatchObject({ ok: false, message: expect.stringContaining('one or more distinct controls') })
    expect(validateMayflyUiNode(ui.stack.column([rows('left'), scoped('bar', [7] as never)]))).toMatchObject({ ok: false })
    const tabs = ui.tabs({ id: 'pages', activeId: 'one', items: [{ id: 'one', label: 'One' }] })
    expect(validateMayflyUiNode(ui.stack.column([tabs, rows('outer'), ui.child(scoped('bar', 'outer'), { tab: { controlId: 'pages', itemId: 'one' } })])).ok).toBe(true)
    expect(validateMayflyUiNode(ui.stack.column([tabs, ui.child(rows('inner'), { tab: { controlId: 'pages', itemId: 'one' } }), scoped('bar', 'inner')])).ok).toBe(false)
  })

  it('trusts a responsive branch to hold the named control', () => {
    expect(validateMayflyUiNode(ui.stack.column([scoped('bar', 'later'), ui.child(rows('later'), { when: { minWidth: 200 } })])).ok).toBe(true)
  })

  it('lets groups share a key only when their scopes name disjoint controls', () => {
    expect(validateMayflyUiNode(ui.stack.column([rows('left'), rows('right'), scoped('a', 'left'), scoped('b', 'right')])).ok).toBe(true)
    expect(validateMayflyUiNode(ui.stack.column([rows('left'), rows('right'), scoped('a', ['left', 'right']), scoped('b', 'right')])))
      .toMatchObject({ ok: false, message: expect.stringContaining('already bound on this page') })
    expect(validateMayflyUiNode(ui.stack.column([rows('left'), scoped('a', 'left'), ui.actions({ id: 'b', items: [{ id: 'b-run', label: 'Run', key: 'ctrl+y' }] })])))
      .toMatchObject({ ok: false, message: expect.stringContaining('already bound on this page') })
  })

  it('acts only while one of its controls, or the group holding it, has focus', () => {
    expect(actionScopeActive(undefined, [])).toBe(true)
    expect(actionScopeActive(['rows'], ['rows-a', 'rows'])).toBe(true)
    expect(actionScopeActive(['rows'], ['other'])).toBe(false)
    const view = surface(ui.stack.column([rows('left'), rows('right'), scoped('copy', 'right', 'ctrl+y')]))
    expect(view.hint()).not.toContain('Ctrl+Y')
    view.press('\x19')
    expect(view.activated()).toEqual([])
    view.press('\t')
    expect(view.hint()).toContain('Ctrl+Y Run')
    view.press('\x19')
    expect(view.activated()).toEqual(['copy-run'])
  })

  it('stays out of scope while nothing on the surface can take focus', () => {
    const blocked = ui.list({ id: 'blocked', role: 'browse', selectedIds: [], items: [{ id: 'b', label: 'B', disabled: true }] })
    const view = surface(ui.stack.column([blocked, scoped('bar', 'blocked')]), { contextHints: { enabled: true, focusWithoutControls: true } })
    expect(view.hint()).not.toContain('Ctrl+Y')
    view.press('\x19')
    expect(view.activated()).toEqual([])
  })

  it('reaches a form through any of its fields and a scroll through its own id', () => {
    const form = ui.form({ id: 'profile', fields: [{ kind: 'toggle', id: 'on', label: 'On', value: false }] })
    const formView = surface(ui.stack.column([form, scoped('bar', 'profile')]))
    formView.press('\x19')
    expect(formView.activated()).toEqual(['bar-run'])
    const scroll = ui.scroll(ui.text('long body'), { id: 'body' })
    const scrollView = surface(ui.stack.column([scroll, scoped('bar', 'body')]))
    scrollView.press('\x19')
    expect(scrollView.activated()).toEqual(['bar-run'])
  })
})

describe('effective keys', () => {
  it('follows a meaning\'s binding and leaves a plain accelerator its key', () => {
    expect(effectiveItemKeys({ semantic: 'delete' }, undefined)).toEqual(['x'])
    expect(effectiveItemKeys({ semantic: 'delete' }, keymapWith({ 'ui.delete': ['d'] }))).toEqual(['d'])
    expect(effectiveItemKeys({ key: 'ctrl+y' }, keymapWith({}))).toEqual(['ctrl+y'])
    expect(effectiveItemKeys({ action: 'demo-plugin.later' }, undefined)).toEqual([])
  })

  it('dispatches a hidden meaning from its current binding, and the hint row follows', () => {
    const node = ui.stack.column([
      ui.text('A provider'),
      ui.actions({ id: 'bar', items: [{ id: 'save', label: 'Save' }, { id: 'remove', label: 'Remove', semantic: 'delete', hidden: true, hintLabel: 'remove' }] }),
    ])
    const plain = surface(node)
    expect(plain.hint()).toContain('X remove')
    plain.press('x')
    expect(plain.activated()).toEqual(['remove'])
    const rebound = surface(node, { keymap: keymapWith({ 'ui.delete': ['ctrl+d', 'f9'], 'ui.accept': ['enter'] }) })
    expect(rebound.hint()).toContain('Ctrl+D remove')
    expect(rebound.hint()).not.toContain('F9')
    rebound.press('x')
    expect(rebound.activated()).toEqual([])
    rebound.press('\x1b[20~')
    expect(rebound.activated()).toEqual(['remove'])
    const unbound = surface(node, { keymap: keymapWith({ 'ui.accept': ['enter'] }) })
    expect(unbound.hint()).not.toContain('remove')
  })

  it('shows a visible item\'s own key on its button and hints a hidden plain accelerator by its hint label', () => {
    const view = surface(ui.actions({ id: 'bar', items: [
      { id: 'copy', label: 'Copy', key: 'c' },
      { id: 'link', label: 'Copy link', key: 'ctrl+y', hidden: true, hintLabel: 'copy link' },
    ] }))
    expect(view.hint()).toContain('Ctrl+Y copy link')
    view.press('\x19')
    expect(view.activated()).toEqual(['link'])
  })
})
