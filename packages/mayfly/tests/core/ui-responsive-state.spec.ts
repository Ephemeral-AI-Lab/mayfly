/** Responsive aliases share semantic drafts once per page without replaying definition identities. @module */
import { describe, expect, it } from 'vitest'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { materializeDeferredUiNode } from '../../src/core/ui-validator.ts'

const page = (itemId: string) => [{ controlId: 'pages', itemId }]

describe('responsive semantic state', () => {
  it('settles independently admitted aliases once and retains separate forms, tabs, choices, and documents per page', () => {
    const source = ui.stack.column([
      ui.form({ id: 'form', fields: [{ id: 'name', kind: 'input', label: 'Name', value: '' }] }),
      ui.list({ id: 'list', role: 'browse', selectedIds: [], filterable: true, filterMode: 'slash', items: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] }),
      ui.tabs({ id: 'tabs', activeId: 'left', items: [{ id: 'left', label: 'Left' }, { id: 'right', label: 'Right' }] }),
      ui.scroll(ui.text('native document'), { id: 'document' }),
      ui.actions({ id: 'actions', items: [{ id: 'copy', label: 'Copy', semantic: 'copy', hidden: true }] }),
    ])
    const model = new UiSurfaceModel('responsive', {
      id: 'surface', revision: 1, source: [], scope: { kind: 'app', targetId: 'test' }, update: { reason: 'data' }, definition: {},
      events: { prepare: async () => ({ reply: { kind: 'completed' }, publish: () => true }) },
      node: ui.stack.column([
        ui.tabs({ id: 'pages', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
        ...['one', 'two'].map(itemId => ui.child(ui.stack.row([
          ui.child(source, { when: { minWidth: 100 } }),
          ui.child(source, { when: { maxWidth: 99 } }),
        ]), { tab: { controlId: 'pages', itemId } })),
      ]),
    })
    try {
      const node = model.node!
      if (node.kind !== 'stack') throw new Error('Expected stack')
      for (const child of node.children.slice(1)) {
        if (child.node.kind !== 'stack') throw new Error('Expected responsive stack')
        for (const alias of child.node.children) expect(materializeDeferredUiNode(alias.node)).toMatchObject({ ok: true })
      }
      model.admitVisibleControls()
      for (const [itemId, value] of [['one', 'Alpha'], ['two', 'Beta']] as const) {
        const pagePath = page(itemId)
        model.edit({ pagePath, formId: 'form', fieldId: 'name' }, value)
        model.updateChoice({ pagePath, controlId: 'list' }, { kind: 'query', query: value })
        model.emit({ kind: 'tab-change', pagePath, controlId: 'tabs', tabId: itemId === 'one' ? 'right' : 'left' })
        model.moveDocument({ pagePath, controlId: 'document' }, { blockId: '[]', offset: itemId === 'one' ? 1 : 2, follow: 'none' })
      }
      const revision = model.revision
      for (let round = 0; round < 4; round += 1) {
        model.admitVisibleControls()
        expect(model.revision).toBe(revision)
        for (const [itemId, value] of [['one', 'Alpha'], ['two', 'Beta']] as const) {
          const pagePath = page(itemId)
          expect(model.form({ pagePath, formId: 'form' })?.fields.name?.value).toBe(value)
          expect(model.choice({ pagePath, controlId: 'list' })).toMatchObject({ query: value, focusedId: itemId === 'one' ? 'a' : 'b' })
          expect(model.activeTab({ pagePath, controlId: 'tabs' })).toBe(itemId === 'one' ? 'right' : 'left')
          expect(model.document({ pagePath, controlId: 'document' })?.anchor?.offset).toBe(itemId === 'one' ? 1 : 2)
          expect(model.availableActions().filter(action => action.actionId === 'copy' && action.pagePath[0]?.itemId === itemId)).toHaveLength(1)
        }
      }
    } finally { model.dispose() }
  })
})
