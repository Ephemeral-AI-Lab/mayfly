/** The admission memo: a snapshot admitted once is not validated again, and every limit still holds. */
import { describe, expect, it } from 'vitest'
import { freezeWire, ui } from '@ephemeral-ai/mayfly-ui'
import {
  MAYFLY_UI_MAX_NODES,
  MAYFLY_UI_MAX_TEXT,
  createAdmissionCache,
  validateMayflyEditorShellNode,
  validateMayflyStatusNode,
  validateMayflyUiNode,
} from '../../src/core/ui-validator.ts'
import { createWorkCounters } from '../../src/core/ui-work-counters.ts'

function admitted<Value>(result: { readonly ok: boolean, readonly value?: Value, readonly message?: string }): Value {
  if (!result.ok) throw new Error(result.message)
  return result.value!
}

const line = (id: string): ReturnType<typeof ui.chart> => ui.chart({
  chart: 'line',
  series: Array.from({ length: 11 }, (_, series) => ({ id: `${id}-${String(series)}`, points: Array.from({ length: 190 }, (__, x) => ({ x, y: x })) })),
})

describe('admission cache', () => {
  it('returns the admitted subtree it already holds and counts only the nodes it validated', () => {
    const cache = createAdmissionCache()
    const entry = ui.richText([{ text: 'entry ' }, { text: '0', tone: 'muted' }])
    const first = createWorkCounters()
    const one = admitted(validateMayflyStatusNode(ui.stack.row([ui.child(entry), ui.child(ui.text('a'))]), first, cache))
    expect(first.nodesValidated).toBe(3)
    const second = createWorkCounters()
    const two = admitted(validateMayflyStatusNode(ui.stack.row([ui.child(entry), ui.child(ui.text('b'))]), second, cache))
    expect(second.nodesValidated).toBe(2)
    expect(two.kind === 'stack' && one.kind === 'stack' && two.children[0]!.node).toBe(one.kind === 'stack' ? one.children[0]!.node : undefined)
  })

  it('admits the same result with and without a cache', () => {
    const tree = ui.stack.column([ui.child(ui.text('a', { tone: 'muted' })), ui.child(ui.fields([{ label: 'k', value: [{ text: 'v' }] }]))])
    const cache = createAdmissionCache()
    const cold = validateMayflyUiNode(tree)
    expect(validateMayflyUiNode(tree, undefined, cache)).toEqual(cold)
    expect(validateMayflyUiNode(tree, createWorkCounters(), cache)).toEqual(cold)
    expect(validateMayflyUiNode(tree, createWorkCounters())).toEqual(cold)
  })

  it('keeps section content, which admits as view-only, apart from ordinary content', () => {
    const cache = createAdmissionCache()
    const body = ui.text('body')
    const counters = createWorkCounters()
    admitted(validateMayflyUiNode(ui.stack.column([ui.child(ui.sections([{ body }])), ui.child(body)]), counters, cache))
    admitted(validateMayflyUiNode(ui.stack.column([ui.child(ui.sections([{ body }])), ui.child(body)]), counters, cache))
    expect(counters.nodesValidated, 'four nodes the first time (the body in each context), then a root and a fresh sections node').toBe(6)
  })

  it('keeps a subtree per context, so the same snapshot admits again at another depth', () => {
    const cache = createAdmissionCache()
    const leaf = ui.text('leaf')
    admitted(validateMayflyUiNode(ui.stack.column([ui.child(leaf)]), undefined, cache))
    const deeper = createWorkCounters()
    admitted(validateMayflyUiNode(ui.stack.column([ui.child(ui.stack.column([ui.child(leaf)]))]), deeper, cache))
    expect(deeper.nodesValidated, 'the root, the inner stack, and the leaf at its new depth').toBe(3)
    const original = createWorkCounters()
    admitted(validateMayflyUiNode(ui.stack.column([ui.child(leaf)]), original, cache))
    expect(original.nodesValidated, 'only the root; the leaf is a hit at its first depth').toBe(1)
  })

  it('never memoizes a subtree that carries controls, tabs, actions, or a responsive branch', () => {
    const cache = createAdmissionCache()
    const form = ui.form({ id: 'f', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] })
    const panel = ui.stack.column([ui.child(form)])
    // [tree, nodes validated cold, nodes validated warm]: every control-bearing node is validated again; only a passive page text is a hit.
    for (const [node, coldCount, warmCount] of [
      [ui.stack.column([ui.child(panel), ui.child(ui.actions({ id: 'a', items: [{ id: 'go', label: 'Go', key: 'ctrl+g' }] }))]), 4, 4],
      [ui.stack.column([ui.child(panel), ui.child(ui.text('x'), { when: { minColumns: 40 } })]), 3, 3],
      [ui.stack.column([ui.child(ui.tabs({ id: 't', activeId: 'one', items: [{ id: 'one', label: 'One' }] })), ui.child(ui.text('page'), { tab: { controlId: 't', itemId: 'one' } })]), 3, 2],
    ] as const) {
      const cold = createWorkCounters()
      admitted(validateMayflyUiNode(node, cold, cache))
      const warm = createWorkCounters()
      admitted(validateMayflyUiNode(node, warm, cache))
      expect([cold.nodesValidated, warm.nodesValidated]).toEqual([coldCount, warmCount])
    }
    const again = createWorkCounters()
    expect(validateMayflyUiNode(ui.stack.column([ui.child(form), ui.child(form)]), again, cache)).toMatchObject({ ok: false, message: expect.stringContaining('duplicated') })
  })

  it('does not memoize editor slots or filterable lists with printable accelerators', () => {
    const cache = createAdmissionCache()
    const shell = ui.stack.column([ui.child({ kind: 'editor-control' } as never), ui.child(ui.text('hint'))])
    expect(validateMayflyEditorShellNode(shell, undefined, cache)).toMatchObject({ ok: true })
    expect(validateMayflyEditorShellNode(shell, undefined, cache)).toMatchObject({ ok: true })
    const list = ui.list({ id: 'l', role: 'browse', selectedIds: [], filterable: true, items: [{ id: 'a', label: 'A' }] })
    const action = ui.actions({ id: 'x', items: [{ id: 'save', label: 'Save', key: 's' }] })
    const tree = ui.stack.column([ui.child(list), ui.child(action)])
    for (let round = 0; round < 2; round += 1) expect(validateMayflyUiNode(tree, undefined, cache)).toMatchObject({ ok: false, message: expect.stringContaining('would swallow typed filter text') })
  })

  it('replays the node, text, and chart quotas instead of skipping them', () => {
    const cache = createAdmissionCache()
    const block = ui.stack.column(Array.from({ length: 20 }, () => ui.child(ui.text('x'))))
    const run = (length: number): ReturnType<typeof ui.child> => ui.child(ui.stack.column(Array.from({ length }, (_, index) => ui.child(ui.text(String(index))))))
    admitted(validateMayflyUiNode(block, undefined, cache))
    expect(validateMayflyUiNode(ui.stack.column([run(150), run(90)]), undefined, cache)).toMatchObject({ ok: true })
    expect(validateMayflyUiNode(ui.stack.column([run(150), run(90), ui.child(block)]), undefined, cache)).toMatchObject({ ok: false, code: 'MAYFLY_LIMIT_EXCEEDED', message: expect.stringContaining(`${String(MAYFLY_UI_MAX_NODES)} nodes`) })

    const halfLength = Math.floor(MAYFLY_UI_MAX_TEXT / 2) + 1
    const half = ui.text('y'.repeat(halfLength))
    admitted(validateMayflyUiNode(half, undefined, cache))
    expect(validateMayflyUiNode(ui.stack.column([ui.child(half), ui.child(ui.text('z'.repeat(MAYFLY_UI_MAX_TEXT - halfLength)))]), undefined, cache)).toMatchObject({ ok: true })
    expect(validateMayflyUiNode(ui.stack.column([ui.child(half), ui.child(half)]), undefined, cache)).toMatchObject({ ok: false, code: 'MAYFLY_LIMIT_EXCEEDED', message: expect.stringContaining('text') })

    const chart = line('a')
    admitted(validateMayflyUiNode(chart, undefined, cache))
    expect(validateMayflyUiNode(ui.stack.column([ui.child(chart), ui.child(chart)]), undefined, cache)).toMatchObject({ ok: false, code: 'MAYFLY_LIMIT_EXCEEDED', message: expect.stringContaining('4000 cells') })
  })

  it('shares admitted list items by identity, and admits a caller-owned item every time', () => {
    const cache = createAdmissionCache()
    const stable = freezeWire({ id: 'a', label: 'A', detail: 'one' })
    const owned = { id: 'b', label: 'B' }
    const publish = (counters = createWorkCounters()) => {
      const list = ui.list({ id: 'l', role: 'browse', selectedIds: [], items: [stable, ui.list({ id: 'unused', role: 'browse', selectedIds: [], items: [owned] }).items[0]!] })
      return { counters, node: admitted(validateMayflyUiNode(list, counters, cache)) }
    }
    const first = publish()
    const second = publish()
    expect(first.counters.nodesValidated).toBe(3)
    expect(second.counters.nodesValidated, 'the list and the one caller-owned item').toBe(2)
    const [one, two] = [first.node, second.node].map(node => node.kind === 'list' ? node.items[0] : undefined)
    expect(two).toBe(one)
    const plain = createWorkCounters()
    admitted(validateMayflyUiNode({ kind: 'list', id: 'raw', role: 'browse', selectedIds: [], items: [{ id: 'c', label: 'C' }] }, plain, cache))
    admitted(validateMayflyUiNode({ kind: 'list', id: 'raw', role: 'browse', selectedIds: [], items: [{ id: 'c', label: 'C' }] }, plain, cache))
    expect(plain.nodesValidated).toBe(4)
  })

  it('shares admitted items of a lazy list and of a select', () => {
    const cache = createAdmissionCache()
    const items = Array.from({ length: 300 }, (_, index) => freezeWire({ id: `i${String(index)}`, label: `Item ${String(index)}` }))
    const lazy = ui.list({ id: 'big', role: 'browse', selectedIds: [], items })
    const result = admitted(validateMayflyUiNode(lazy, undefined, cache))
    const again = admitted(validateMayflyUiNode(ui.list({ ...lazy, filter: 'x' }), undefined, cache))
    expect(result.kind === 'list' && again.kind === 'list' && again.items[3]).toBe(result.kind === 'list' ? result.items[3] : undefined)
  })
})
