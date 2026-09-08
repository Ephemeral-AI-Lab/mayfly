/** Bounded UI declaration traversal and targeted deferred form admission.
 * @module @ephemeral-ai/mayfly/tests/core/ui-interaction-tree
 */
import { describe, expect, it, vi } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { prepareUiForms, uiControlKey, uiDeclarations, visitUiControls } from '../../src/core/ui-interaction-tree.ts'
import { MAYFLY_UI_MAX_COLLECTION, MAYFLY_UI_MAX_DEPTH, materializeDeferredUiNode, validateMayflyUiNode } from '../../src/core/ui-validator.ts'

describe('UI control traversal', () => {
  it('uses structured page addresses and visits all nested passive containers', () => {
    expect(uiControlKey({ pagePath: [{ controlId: 'a:b', itemId: 'c' }], controlId: 'd' }))
      .not.toBe(uiControlKey({ pagePath: [{ controlId: 'a', itemId: 'b:c' }], controlId: 'd' }))
    const visitor = vi.fn()
    visitUiControls(ui.stack.column([
      ui.child(ui.surface({ child: ui.scroll(ui.list({ id: 'list', role: 'browse', selectedIds: [], items: [], empty: ui.empty({ title: 'Empty', actions: ui.actions({ id: 'empty-actions', items: [] }) }) })), footer: ui.form({ id: 'footer-form', fields: [] }) }), { tab: { controlId: 'pages', itemId: 'one' } }),
      ui.surface({ child: ui.text('plain') }),
      ui.list({ id: 'plain-list', role: 'browse', selectedIds: [], items: [] }),
      ui.empty({ title: 'Plain empty' }),
    ]), visitor)
    expect(visitor.mock.calls.map(([node]) => node.kind)).toEqual(expect.arrayContaining(['stack', 'surface', 'scroll', 'list', 'empty', 'actions', 'form', 'text']))
    expect(visitor.mock.calls.find(([node]) => node.kind === 'form')![1]).toEqual([{ controlId: 'pages', itemId: 'one' }])
  })

  it('does not admit hidden nodes unless a required predicate selects them', () => {
    const admitted = validateMayflyUiNode({
      kind: 'stack', direction: 'column', children: [{ when: { minWidth: 100 }, node: { kind: 'form', id: 'hidden', fields: [] } }],
    })
    expect(admitted.ok).toBe(true)
    if (!admitted.ok || admitted.value.kind !== 'stack') throw new Error('expected stack')
    const hidden = admitted.value.children[0]!.node
    const passive = vi.fn()
    visitUiControls(admitted.value, passive)
    expect(passive.mock.calls.some(([node]) => node.kind === 'form')).toBe(false)
    const active = vi.fn()
    visitUiControls(admitted.value, active, [], node => node === hidden)
    expect(active.mock.calls.some(([node]) => node.kind === 'form')).toBe(true)
    expect(materializeDeferredUiNode(hidden)).toMatchObject({ ok: true })
  })

  it('throws a contained validation error only when a bad hidden node is required', () => {
    const admitted = validateMayflyUiNode({
      kind: 'stack', direction: 'column', children: [{ when: { minWidth: 100 }, node: { kind: 'unknown' } }],
    })
    expect(admitted.ok).toBe(true)
    if (!admitted.ok || admitted.value.kind !== 'stack') throw new Error('expected stack')
    expect(() => visitUiControls(admitted.value, () => {}, [], () => true)).toThrow('unknown Mayfly UI kind')
  })
})

describe('raw declarations', () => {
  it('extracts form field kinds and nested addresses without reading list items', () => {
    const source = {
      kind: 'stack', direction: 'column', children: [
        { tab: { controlId: 'pages', itemId: 'one' }, node: { kind: 'form', id: 'settings', fields: [{ kind: 'input', id: 'name' }, { kind: 'toggle', id: 'enabled' }] } },
        { node: {
          kind: 'surface', id: 'surface',
          child: { kind: 'scroll', id: 'scroll', child: { kind: 'list', id: 'list', items: [], empty: { kind: 'empty', id: 'empty', actions: { kind: 'actions', id: 'actions' } } } },
          footer: { kind: 'form', id: 'footer', fields: [] },
        } },
      ],
    }
    const result = uiDeclarations(source)
    expect(result.complete).toBe(true)
    const controls = [...result.controls.values()]
    expect(controls.find(control => control.address.controlId === 'settings')).toMatchObject({
      kind: 'form', address: { pagePath: [{ controlId: 'pages', itemId: 'one' }] }, fields: new Map([['name', 'input'], ['enabled', 'toggle']]),
    })
    expect(controls.map(control => control.address.controlId)).toEqual(expect.arrayContaining(['surface', 'scroll', 'list', 'empty', 'actions', 'footer']))
    expect(uiDeclarations({ kind: 'stack', children: [{ node: { kind: 'list', id: 'plain-list' } }, { node: { kind: 'empty', id: 'plain-empty' } }] }).complete).toBe(true)
  })

  it.each([
    null,
    'text',
    { kind: 'stack', id: 'stack', children: 'invalid' },
    { kind: 'stack', id: 'stack', children: [{ tab: { controlId: 1, itemId: 'one' }, node: { kind: 'text' } }] },
  ])('marks malformed declaration trees incomplete (%j)', source => {
    expect(uiDeclarations(source).complete).toBe(false)
  })

  it.each([
    { kind: 'form', id: 'form', fields: [{ kind: 'input' }] },
    { kind: 'form', id: 'form', fields: 'invalid' },
  ])('retains control identity when field metadata is unknown (%j)', source => {
    const result = uiDeclarations(source)
    expect(result.complete).toBe(true)
    expect(result.controls.values().next().value?.fields).toBeUndefined()
  })

  it('contains cycles, excessive depth, collections, accessors, and missing descriptors', () => {
    const cycle: { kind: string, child?: unknown } = { kind: 'surface' }
    cycle.child = cycle
    expect(uiDeclarations(cycle).complete).toBe(false)

    let deep: unknown = { kind: 'text' }
    for (let index = 0; index <= MAYFLY_UI_MAX_DEPTH; index += 1) deep = { kind: 'surface', child: deep }
    expect(uiDeclarations(deep).complete).toBe(false)

    expect(uiDeclarations({ kind: 'stack', id: 'stack', children: Array.from({ length: MAYFLY_UI_MAX_COLLECTION + 1 }, () => ({ node: { kind: 'text' } })) }).complete).toBe(false)
    expect(uiDeclarations({ kind: 'form', id: 'form', fields: Array.from({ length: MAYFLY_UI_MAX_COLLECTION + 1 }, () => ({ kind: 'input', id: 'field' })) }).controls.values().next().value?.fields).toBeUndefined()

    const accessor = Object.defineProperty({ kind: 'form', fields: [] }, 'id', { enumerable: true, get: () => 'hidden' })
    expect(uiDeclarations(accessor).controls).toEqual(new Map())
    expect(uiDeclarations(Object.create(null)).complete).toBe(true)
  })
})

describe('targeted form admission', () => {
  it('materializes only the responsive branch that contains a submitted form', () => {
    const admitted = validateMayflyUiNode({
      kind: 'stack', direction: 'column', children: [
        { when: { minWidth: 100 }, node: { kind: 'form', id: 'wanted', fields: [] } },
        { when: { minWidth: 100 }, node: { kind: 'form', id: 'other', fields: [] } },
      ],
    })
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) throw new Error('expected admitted node')
    const forms = prepareUiForms(admitted.value, [{ pagePath: [], formId: 'wanted' }])
    expect(forms.get(uiControlKey({ pagePath: [], controlId: 'wanted' }))).toMatchObject({ kind: 'form', id: 'wanted' })
    expect(() => prepareUiForms(admitted.value, [{ pagePath: [], formId: 'missing' }])).toThrow('no longer available')
  })
})
