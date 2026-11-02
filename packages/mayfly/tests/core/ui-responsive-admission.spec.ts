/** Responsive siblings share only immutable exclusive declarations and still pay all admission costs. @module */
import { describe, expect, it } from 'vitest'
import { ui, type MayflyUiNode, type MayflyViewportCondition } from '@ephemeral-ai/mayfly-ui'
import { createAdmissionCache, materializeDeferredUiNode, validateMayflyUiNode } from '../../src/core/ui-validator.ts'
import { createWorkCounters } from '../../src/core/ui-work-counters.ts'

const list = () => ui.list({ id: 'rows', role: 'browse', filterable: true, filterMode: 'slash', items: [{ id: 'one', label: 'One' }] })
const action = () => ui.actions({ id: 'commands', items: [{ id: 'run', label: 'Run', key: 'ctrl+g' }] })
const narrow = { maxWidth: 99 }
const wide = { minWidth: 100 }

function admitted(value: unknown, counters = createWorkCounters(), cache = createAdmissionCache()) {
  const result = validateMayflyUiNode(value, counters, cache)
  if (!result.ok) throw new Error(result.message)
  if (result.value.kind !== 'stack') throw new Error('Expected a stack')
  return result.value
}

function siblings(source: MayflyUiNode, conditions: readonly MayflyViewportCondition[] = [wide, narrow]) {
  return admitted(ui.stack.row(conditions.map(when => ui.child(source, { when })))).children.map(child => child.node)
}

describe('responsive declaration admission', () => {
  it('fully admits an immutable exclusive sibling again and keeps controls out of the memo', () => {
    const source = ui.stack.column([list(), action()])
    const counters = createWorkCounters()
    const cache = createAdmissionCache()
    const tree = ui.stack.row([ui.child(source, { when: wide }), ui.child(source, { when: narrow })])
    for (let round = 0; round < 2; round += 1) {
      const nodes = admitted(tree, counters, cache).children
      const first = materializeDeferredUiNode(nodes[0]!.node)
      const beforeSecond = counters.nodesValidated
      const second = materializeDeferredUiNode(nodes[1]!.node)
      expect(first).toMatchObject({ ok: true })
      expect(second).toEqual(first)
      expect(second).not.toBe(first)
      expect(counters.nodesValidated - beforeSecond).toBe(3)
      expect(materializeDeferredUiNode(nodes[1]!.node)).toBe(second)
    }
    expect(validateMayflyUiNode(ui.stack.row([source, source]), undefined, cache)).toMatchObject({ ok: false, message: expect.stringContaining('duplicated') })
  })

  it.each([
    [{ maxWidth: 9 }, { minWidth: 10 }],
    [{ minWidth: 10 }, { maxWidth: 9 }],
    [{ maxHeight: 9 }, { minHeight: 10 }],
    [{ minHeight: 10 }, { maxHeight: 9 }],
    [{ maxWidth: 9 }, { minWidth: 10, maxWidth: 19 }, { minWidth: 20 }],
  ])('accepts only provably disjoint inclusive viewport ranges: %j', (...conditions) => {
    for (const node of siblings(ui.stack.column([list(), action()]), conditions)) expect(materializeDeferredUiNode(node)).toMatchObject({ ok: true })
  })

  it('refuses distinct declarations, overlapping ranges, and mutable repeated source objects', () => {
    const source = list()
    for (const tree of [
      ui.stack.row([ui.child(list(), { when: narrow }), ui.child(list(), { when: wide })]),
      ui.stack.row([ui.child(source, { when: { minWidth: 40 } }), ui.child(source, { when: { maxWidth: 100 } })]),
      { kind: 'stack', direction: 'row', children: (() => {
        const mutable = { kind: 'list', id: 'rows', role: 'browse', items: [] }
        return [{ node: mutable, when: narrow }, { node: mutable, when: wide }]
      })() },
    ]) {
      const children = admitted(tree).children
      expect(materializeDeferredUiNode(children[0]!.node)).toMatchObject({ ok: true })
      expect(materializeDeferredUiNode(children[1]!.node)).toMatchObject({ ok: false, message: expect.stringContaining('duplicated') })
    }
  })

  it('does not share declarations across different parent stacks, depths, or scroll contexts', () => {
    const source = list()
    for (const second of [
      ui.stack.row([ui.child(source, { when: wide })]),
      ui.stack.row([ui.stack.row([ui.child(source, { when: wide })])]),
      ui.scroll(ui.stack.row([ui.child(source, { when: wide })])),
    ]) {
      const children = admitted(ui.stack.column([ui.stack.row([ui.child(source, { when: narrow })]), second])).children
      const first = children[0]!.node
      if (first.kind !== 'stack') throw new Error('Expected first stack')
      expect(materializeDeferredUiNode(first.children[0]!.node)).toMatchObject({ ok: true })
      let next = children[1]!.node
      while (next.kind === 'scroll' || next.kind === 'stack') next = next.kind === 'scroll' ? next.child : next.children[0]!.node
      expect(materializeDeferredUiNode(next)).toMatchObject({ ok: false, message: expect.stringContaining('duplicated') })
    }
  })

  it('fully validates identical source on distinct tab pages instead of sharing page reservations', () => {
    const source = ui.stack.column([list(), action()])
    const children = admitted(ui.stack.row([
      ui.tabs({ id: 'pages', activeId: 'a', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
      ui.child(source, { when: narrow, tab: { controlId: 'pages', itemId: 'a' } }),
      ui.child(source, { when: wide, tab: { controlId: 'pages', itemId: 'b' } }),
    ])).children
    expect(materializeDeferredUiNode(children[1]!.node)).toMatchObject({ ok: true })
    expect(materializeDeferredUiNode(children[2]!.node)).toMatchObject({ ok: true })
  })

  it('rejects duplicate controls and keys inside one branch and does not share further responsive subtrees', () => {
    for (const source of [ui.stack.column([list(), list()]), ui.stack.column([action(), action()])]) {
      for (const node of siblings(source)) expect(materializeDeferredUiNode(node)).toMatchObject({ ok: false })
    }
    const source = ui.stack.column([list(), ui.child(ui.text('later'), { when: narrow })])
    const nodes = siblings(source)
    expect(materializeDeferredUiNode(nodes[0]!)).toMatchObject({ ok: true })
    expect(materializeDeferredUiNode(nodes[1]!)).toMatchObject({ ok: false, message: expect.stringContaining('duplicated') })
  })

  it('restores controls, action keys, filter policy, and nested deferred state after a rejected branch', () => {
    const key = (value: string) => ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run', key: value }] })
    const typeFilter = ui.list({ id: 'rows', role: 'browse', filterable: true, items: [] })
    const invalid = { kind: 'unknown' } as unknown as MayflyUiNode
    for (const [failed, next] of [
      [ui.stack.column([key('q'), ui.child(ui.text('nested'), { when: wide }), invalid]), typeFilter],
      [ui.stack.column([typeFilter, key('ctrl+g'), invalid]), key('q')],
      [ui.stack.column([key('ctrl+g'), list(), invalid]), ui.stack.column([key('ctrl+g'), list()])],
    ]) {
      const children = admitted(ui.stack.row([ui.child(failed!, { when: narrow }), ui.child(next!, { when: wide })])).children
      expect(materializeDeferredUiNode(children[0]!.node)).toMatchObject({ ok: false })
      expect(materializeDeferredUiNode(children[1]!.node)).toMatchObject({ ok: true })
    }
  })

  it('enforces the same filter/key policy after deferred admission and preserves an existing printable binding on rollback', () => {
    const firstKey = ui.actions({ id: 'first', items: [{ id: 'first', label: 'First', key: 'b' }] })
    const typeFilter = ui.list({ id: 'rows', role: 'browse', filterable: true, items: [] })
    const children = admitted(ui.stack.row([
      firstKey,
      ui.child(typeFilter, { when: narrow }),
      ui.child(ui.actions({ id: 'next', items: [{ id: 'next', label: 'Next', key: 'q' }] }), { when: wide }),
      ui.child(typeFilter, { when: { minHeight: 10 } }),
    ])).children
    expect(materializeDeferredUiNode(children[1]!.node)).toMatchObject({ ok: false, message: expect.stringContaining('"b" would swallow typed filter text') })
    expect(materializeDeferredUiNode(children[2]!.node)).toMatchObject({ ok: true })
    expect(materializeDeferredUiNode(children[3]!.node)).toMatchObject({ ok: false, message: expect.stringContaining('"b" would swallow typed filter text') })
    const wrong = siblings(ui.stack.column([typeFilter, ui.actions({ id: 'key', items: [{ id: 'key', label: 'Key', key: 'q' }] })]))
    for (const node of wrong) expect(materializeDeferredUiNode(node)).toMatchObject({ ok: false, message: expect.stringContaining('would swallow typed filter text') })
  })

  it('keeps the original reservations and restores quota after an alias fails after consuming its leases', () => {
    const form = (id: string, size: number) => ui.form({ id, fields: [{ id: `${id}-text`, kind: 'textarea', label: 'Text', value: 'x'.repeat(size) }] })
    const source = ui.stack.column([action(), list(), form('draft', 60_000)])
    const children = admitted(ui.stack.row([
      ui.child(source, { when: narrow }),
      ui.child(source, { when: wide }),
      ui.child(list(), { when: { minHeight: 1 } }),
      ui.child(ui.actions({ id: 'unrelated', items: [{ id: 'unrelated', label: 'Unrelated', key: 'ctrl+g' }] }), { when: { minHeight: 2 } }),
      ui.child(form('remaining', 40_000), { when: { minHeight: 3 } }),
    ])).children
    expect(materializeDeferredUiNode(children[0]!.node)).toMatchObject({ ok: true })
    expect(materializeDeferredUiNode(children[1]!.node)).toMatchObject({ ok: false, code: 'MAYFLY_LIMIT_EXCEEDED' })
    expect(materializeDeferredUiNode(children[2]!.node)).toMatchObject({ ok: false, message: expect.stringContaining('duplicated') })
    expect(materializeDeferredUiNode(children[3]!.node)).toMatchObject({ ok: false, message: expect.stringContaining('already bound') })
    const remaining = materializeDeferredUiNode(children[4]!.node)
    expect(remaining, JSON.stringify(remaining)).toMatchObject({ ok: true })
  })

  it.each([
    ['nodes', ui.stack.column([list(), ...Array.from({ length: 130 }, () => ui.text('row'))]), '256 nodes'],
    ['charts', ui.stack.column([list(), ui.chart({ chart: 'line', series: Array.from({ length: 11 }, (_, id) => ({ id: String(id), points: Array.from({ length: 190 }, (_, x) => ({ x, y: x })) })) })]), '4000 cells'],
    ['images', ui.stack.column([list(), ...Array.from({ length: 5 }, () => ui.image({ attachmentId: 'attachment', alt: 'Image' }))]), '8 images'],
    ['drafts', ui.form({ id: 'form', fields: [{ id: 'text', kind: 'textarea', label: 'Text', value: 'x'.repeat(60_000) }] }), '100000'],
  ])('charges repeated exclusive %s against the whole-tree quota', (_name, source, message) => {
    const nodes = siblings(source as MayflyUiNode)
    expect(materializeDeferredUiNode(nodes[0]!)).toMatchObject({ ok: true })
    expect(materializeDeferredUiNode(nodes[1]!)).toMatchObject({ ok: false, code: 'MAYFLY_LIMIT_EXCEEDED', message: expect.stringContaining(message) })
  })
})
