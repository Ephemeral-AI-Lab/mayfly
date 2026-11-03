/** Page ownership and typed-control admission for the interaction protocol.
 * @module @ephemeral-ai/mayfly/tests/core/ui-interaction-admission
 */
import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { materializeDeferredUiNode, validateMayflyStatusNode, validateMayflyUiNode } from '../../src/core/ui-validator.ts'

const pages = ui.tabs({ id: 'pages', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] })
const form = () => ui.form({ id: 'config', fields: [{ kind: 'input', id: 'name', label: 'Name', value: 'A' }] })

describe('interaction schema admission', () => {
  it('admits wizard links and rejects ambiguous navigation and cyclic returns', () => {
    const definition = ui.stack.column([
      ui.tabs({ id: 'steps', mode: 'wizard', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two', backId: 'one' }] }),
      ui.actions({ id: 'links', items: [{ id: 'next', label: 'Next', read: [{ pagePath: [], formId: 'form' }], navigate: [{ controlId: 'steps', itemId: 'two' }] }] }),
    ])
    expect(validateMayflyUiNode(definition)).toEqual({ ok: true, value: definition })
    for (const item of [
      { navigate: [] },
      { navigate: [{ controlId: 'steps', itemId: 'two' }], dismiss: true },
      { navigate: [{ controlId: 'steps', itemId: 'two' }], submit: [{ pagePath: [], formId: 'form' }] },
    ]) expect(validateMayflyUiNode({ kind: 'actions', id: 'links', items: [{ id: 'next', label: 'Next', ...item }] })).toMatchObject({ ok: false })
    for (const backId of ['one', 'missing']) expect(validateMayflyUiNode({ ...pages, items: [{ id: 'one', label: 'One', backId }] })).toMatchObject({ ok: false })
    expect(validateMayflyUiNode({ ...pages, mode: 'unknown' })).toMatchObject({ ok: false })
    expect(validateMayflyUiNode({ ...pages, items: [{ id: 'one', label: 'One', backId: 'two' }, { id: 'two', label: 'Two', backId: 'one' }] })).toMatchObject({ ok: false, message: expect.stringContaining('cycle') })
  })

  it('preserves explicit tab associations and admits repeated form and field ids on different pages', () => {
    const definition = ui.stack.column([
      pages,
      ui.child(form(), { tab: { controlId: 'pages', itemId: 'one' } }),
      ui.child(form(), { tab: { controlId: 'pages', itemId: 'two' } }),
      ui.actions({ id: 'form-actions', items: [{ id: 'save', label: 'Save', defaultFocus: true, submit: [
        { pagePath: [{ controlId: 'pages', itemId: 'one' }], formId: 'config' },
        { pagePath: [{ controlId: 'pages', itemId: 'two' }], formId: 'config' },
      ] }] }),
    ])
    const result = validateMayflyUiNode(definition)
    expect(result).toEqual({ ok: true, value: definition })
    expect(Object.isFrozen(result.ok && result.value)).toBe(true)
    expect(validateMayflyUiNode(ui.stack.column([form(), form()]))).toMatchObject({ ok: false, message: expect.stringContaining('duplicated') })
  })

  it('resolves nested tab ids relative to their owning page', () => {
    const nested = ui.stack.column([
      ui.tabs({ id: 'pages', activeId: 'inner', items: [{ id: 'inner', label: 'Inner' }] }),
      ui.child(form(), { tab: { controlId: 'pages', itemId: 'inner' } }),
    ])
    expect(validateMayflyUiNode(ui.stack.column([
      ui.child(nested, { tab: { controlId: 'pages', itemId: 'one' } }), pages,
    ]))).toMatchObject({ ok: true })
    expect(validateMayflyUiNode(ui.stack.column([
      pages, ui.child(form(), { tab: { controlId: 'pages', itemId: 'missing' } }),
    ]))).toMatchObject({ ok: false, message: expect.stringContaining('unknown tab') })
    expect(validateMayflyStatusNode({ kind: 'stack', direction: 'column', children: [{ tab: { controlId: 'pages', itemId: 'one' }, node: { kind: 'text', content: 'status' } }] })).toMatchObject({ ok: false, message: expect.stringContaining('only supported') })
  })

  it('retains page context across deferred admission and rolls back failed branch identities', () => {
    const deferred = (valid: boolean) => ui.child(ui.stack.column([
      ui.tabs({ id: 'nested', activeId: 'x', items: [{ id: 'x', label: 'X' }] }),
      ui.child(form(), { tab: { controlId: 'nested', itemId: valid ? 'x' : 'missing' } }),
    ]), { tab: { controlId: 'pages', itemId: 'one' }, when: { minWidth: 100 } })
    const result = validateMayflyUiNode(ui.stack.column([pages, deferred(false), deferred(true)]))
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'stack') throw new Error('expected a stack')
    expect(materializeDeferredUiNode(result.value.children[1]!.node)).toMatchObject({ ok: false, message: expect.stringContaining('unknown tab') })
    expect(materializeDeferredUiNode(result.value.children[2]!.node)).toMatchObject({ ok: true })
  })

  it('admits numeric, collection, reset, and search semantics as readonly wire data', () => {
    const definition = ui.stack.column([
      ui.form({ id: 'typed', fields: [
        { kind: 'number', id: 'count', label: 'Count', value: 2.5, required: true, min: 0, max: 10, step: 0.5, unit: 'ms', origin: 'inherited', resetValue: null },
        { kind: 'multiselect', id: 'levels', label: 'Levels', value: [], minSelected: 0, maxSelected: 2, resetValue: ['one'], options: [{ id: 'one', label: 'One' }] },
        { kind: 'input', id: 'text', label: 'Text', value: '', minLength: 1, maxLength: 20, resetValue: 'default', disabledReason: 'Not writable' },
        { kind: 'toggle', id: 'flag', label: 'Flag', value: false, resetValue: true },
        { kind: 'select', id: 'option', label: 'Option', value: null, resetValue: null, options: [] },
      ] }),
      ui.list({ id: 'tree', role: 'browse', tree: true, filterable: true, selectedIds: [], acceptActionId: 'open', items: [
        { id: 'root', label: 'Root', searchText: 'root directory' },
        { id: 'child', parentId: 'root', label: 'Child', disabled: true, disabledReason: 'No longer live' },
      ] }),
    ])
    expect(validateMayflyUiNode(definition)).toEqual({ ok: true, value: definition })
  })

  it('rejects self-parenting and cyclic tree declarations while keeping orphan roots', () => {
    const list = (items: readonly { readonly id: string, readonly label: string, readonly parentId?: string }[]) => ui.list({ id: 'tree', role: 'browse', tree: true, selectedIds: [], items })
    expect(validateMayflyUiNode(list([{ id: 'self', label: 'Self', parentId: 'self' }]))).toMatchObject({ ok: false, message: expect.stringContaining('itself') })
    expect(validateMayflyUiNode(list([{ id: 'a', label: 'A', parentId: 'b' }, { id: 'b', label: 'B', parentId: 'a' }]))).toMatchObject({ ok: false, message: expect.stringContaining('cycle') })
    expect(validateMayflyUiNode(list([{ id: 'orphan', label: 'Orphan', parentId: 'missing' }]))).toMatchObject({ ok: true })
  })

  it('keeps unavailable baseline choices available for the shared conflict presentation', () => {
    const definition = ui.list({ id: 'choice', role: 'choose', selectedIds: ['removed'], items: [], minSelected: 0, maxSelected: 1 })
    expect(validateMayflyUiNode(definition)).toEqual({ ok: true, value: definition })
  })

  it.each([
    { kind: 'number', value: 1, min: 2, max: 1 },
    { kind: 'number', value: 1, step: 0 },
    { kind: 'number', value: 1, step: Infinity },
    { kind: 'number', value: 1, resetValue: 'wrong' },
    { kind: 'input', value: '', minLength: 4, maxLength: 2 },
    { kind: 'input', value: '', required: 'wrong' },
    { kind: 'input', value: '', origin: 'wrong' },
    { kind: 'multiselect', value: ['one', 'one'], options: [] },
    { kind: 'multiselect', value: [], options: [], minSelected: 2, maxSelected: 1 },
    { kind: 'toggle', value: false, resetValue: 'wrong' },
  ])('rejects invalid field declarations %j', options => {
    expect(validateMayflyUiNode({ kind: 'form', id: 'form', fields: [{ id: 'field', label: 'Field', ...options }] })).toMatchObject({ ok: false })
  })

  it('requires list roles and rejects ambiguous submission boundaries', () => {
    expect(validateMayflyUiNode({ kind: 'list', id: 'list', items: [], selectedIds: [] })).toMatchObject({ ok: false, message: expect.stringContaining('role') })
    const target = { pagePath: [], formId: 'form' }
    for (const submit of [[], [target, target]]) {
      expect(validateMayflyUiNode(ui.actions({ id: 'actions', items: [{ id: 'save', label: 'Save', submit }] }))).toMatchObject({ ok: false, message: expect.stringContaining('unique form addresses') })
    }
    expect(validateMayflyUiNode(ui.stack.column([
      ui.form({ id: 'form', fields: [], submitActionId: 'save' }),
      ui.actions({ id: 'actions', items: [{ id: 'save', label: 'Save' }] }),
    ]))).toMatchObject({ ok: true })
  })
})
