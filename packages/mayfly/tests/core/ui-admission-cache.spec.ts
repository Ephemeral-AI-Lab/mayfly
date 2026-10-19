/** The admission memo: a snapshot admitted once is not validated again, and every limit still holds. */
import { describe, expect, it } from 'vitest'
import { freezeWire, ui } from '@ephemeral-ai/mayfly-ui'
import {
  MAYFLY_UI_MAX_NODES,
  createAdmissionCache,
  validateMayflyEditorShellNode,
  validateMayflyStatusNode,
  validateMayflyUiNode,
} from '../../src/core/ui/admit/ui-validator.ts'

function admitted<Value>(result: { readonly ok: boolean, readonly value?: Value, readonly message?: string }): Value {
  if (!result.ok) throw new Error(result.message)
  return result.value!
}

const line = (id: string): ReturnType<typeof ui.chart> => ui.chart({
  chart: 'line',
  series: Array.from({ length: 11 }, (_, series) => ({ id: `${id}-${String(series)}`, points: Array.from({ length: 190 }, (__, x) => ({ x, y: x })) })),
})

describe('admission cache', () => {
  it('returns the admitted subtree it already holds', () => {
    const cache = createAdmissionCache()
    const entry = ui.richText([{ text: 'entry ' }, { text: '0', tone: 'muted' }])
    const one = admitted(validateMayflyStatusNode(ui.stack.row([ui.child(entry), ui.child(ui.text('a'))]), cache))
    const two = admitted(validateMayflyStatusNode(ui.stack.row([ui.child(entry), ui.child(ui.text('b'))]), cache))
    expect(two.kind === 'stack' && one.kind === 'stack' && two.children[0]!.node).toBe(one.kind === 'stack' ? one.children[0]!.node : undefined)
  })

  it('admits the same result with and without a cache', () => {
    const tree = ui.stack.column([ui.child(ui.text('a', { tone: 'muted' })), ui.child(ui.fields([{ label: 'k', value: [{ text: 'v' }] }]))])
    const cache = createAdmissionCache()
    const cold = validateMayflyUiNode(tree)
    expect(validateMayflyUiNode(tree, cache)).toEqual(cold)
    expect(validateMayflyUiNode(tree, createAdmissionCache())).toEqual(cold)
  })

  it('keeps a subtree per context, so the same snapshot admits again at another depth', () => {
    const cache = createAdmissionCache()
    const leaf = ui.text('leaf')
    const shallow = ui.stack.column([ui.child(leaf)])
    const first = admitted(validateMayflyUiNode(shallow, cache))
    const deeper = admitted(validateMayflyUiNode(ui.stack.column([ui.child(ui.stack.column([ui.child(leaf)]))]), cache))
    const shallowLeaf = first.kind === 'stack' ? first.children[0]!.node : undefined
    const deepStack = deeper.kind === 'stack' ? deeper.children[0]!.node : undefined
    const deepLeaf = deepStack?.kind === 'stack' ? deepStack.children[0]!.node : undefined
    expect(deepLeaf, 'the leaf at its new depth is admitted fresh').not.toBe(shallowLeaf)
    expect(admitted(validateMayflyUiNode(shallow, cache)), 'the root at its first context is a hit').toBe(first)
  })

  it('never memoizes a subtree that carries controls, tabs, actions, or a responsive branch', () => {
    const cache = createAdmissionCache()
    const admit = (node: unknown) => admitted(validateMayflyUiNode(node, cache))
    const form = ui.form({ id: 'f', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] })
    const panel = ui.stack.column([ui.child(form)])
    for (const node of [
      ui.stack.column([ui.child(panel), ui.child(ui.actions({ id: 'a', items: [{ id: 'go', label: 'Go', key: 'ctrl+g' }] }))]),
      ui.stack.column([ui.child(panel), ui.child(ui.text('x'), { when: { minWidth: 40 } })]),
      ui.stack.column([ui.child(ui.tabs({ id: 't', activeId: 'one', items: [{ id: 'one', label: 'One' }] })), ui.child(ui.text('page'), { tab: { controlId: 't', itemId: 'one' } })]),
    ]) {
      // A control-bearing subtree is tied to the rest of the tree, so each admission is a fresh subtree.
      const one = admit(node)
      expect(admit(node)).not.toBe(one)
    }
    // A passive subtree is still shared by the root it admitted.
    const passive = ui.stack.column([ui.child(ui.text('x'))])
    expect(admit(passive)).toBe(admit(passive))
    expect(validateMayflyUiNode(ui.stack.column([ui.child(form), ui.child(form)]), cache)).toMatchObject({ ok: false, message: expect.stringContaining('duplicated') })
  })

  it('does not memoize editor slots or filterable lists with printable accelerators', () => {
    const cache = createAdmissionCache()
    const shell = ui.stack.column([ui.child({ kind: 'prompt', id: 'prompt' } as never), ui.child(ui.text('hint'))])
    expect(validateMayflyEditorShellNode(shell, cache)).toMatchObject({ ok: true })
    expect(validateMayflyEditorShellNode(shell, cache)).toMatchObject({ ok: true })
    const list = ui.list({ id: 'l', role: 'browse', selectedIds: [], filterable: true, items: [{ id: 'a', label: 'A' }] })
    const action = ui.actions({ id: 'x', items: [{ id: 'save', label: 'Save', key: 's' }] })
    const tree = ui.stack.column([ui.child(list), ui.child(action)])
    for (let round = 0; round < 2; round += 1) expect(validateMayflyUiNode(tree, cache)).toMatchObject({ ok: false, message: expect.stringContaining('would swallow typed filter text') })
  })

  it('replays the node and chart quotas instead of skipping them', () => {
    const cache = createAdmissionCache()
    const block = ui.stack.column(Array.from({ length: 20 }, () => ui.child(ui.text('x'))))
    const run = (length: number): ReturnType<typeof ui.child> => ui.child(ui.stack.column(Array.from({ length }, (_, index) => ui.child(ui.text(String(index))))))
    admitted(validateMayflyUiNode(block, cache))
    expect(validateMayflyUiNode(ui.stack.column([run(150), run(90)]), cache)).toMatchObject({ ok: true })
    expect(validateMayflyUiNode(ui.stack.column([run(150), run(90), ui.child(block)]), cache)).toMatchObject({ ok: false, code: 'MAYFLY_LIMIT_EXCEEDED', message: expect.stringContaining(`${String(MAYFLY_UI_MAX_NODES)} nodes`) })

    const chart = line('a')
    admitted(validateMayflyUiNode(chart, cache))
    expect(validateMayflyUiNode(ui.stack.column([ui.child(chart), ui.child(chart)]), cache)).toMatchObject({ ok: false, code: 'MAYFLY_LIMIT_EXCEEDED', message: expect.stringContaining('4000 cells') })
  })

  it('shares admitted list items by identity, and admits a caller-owned item every time', () => {
    const cache = createAdmissionCache()
    const stable = freezeWire({ id: 'a', label: 'A', detail: 'one' })
    const owned = { id: 'b', label: 'B' }
    const publish = () => {
      const list = ui.list({ id: 'l', role: 'browse', selectedIds: [], items: [stable, ui.list({ id: 'unused', role: 'browse', selectedIds: [], items: [owned] }).items[0]!] })
      return admitted(validateMayflyUiNode(list, cache))
    }
    const first = publish()
    const second = publish()
    const [one, two] = [first, second].map(node => node.kind === 'list' ? node.items[0] : undefined)
    expect(two, 'the stable item is shared').toBe(one)
    const [oneOwned, twoOwned] = [first, second].map(node => node.kind === 'list' ? node.items[1] : undefined)
    expect(twoOwned, 'a caller-owned item is admitted again').not.toBe(oneOwned)
  })

  it('shares admitted items of a lazy list and of a select', () => {
    const cache = createAdmissionCache()
    const items = Array.from({ length: 300 }, (_, index) => freezeWire({ id: `i${String(index)}`, label: `Item ${String(index)}` }))
    const lazy = ui.list({ id: 'big', role: 'browse', selectedIds: [], items })
    const result = admitted(validateMayflyUiNode(lazy, cache))
    const again = admitted(validateMayflyUiNode(ui.list({ ...lazy, filter: 'x' }), cache))
    expect(result.kind === 'list' && again.kind === 'list' && again.items[3]).toBe(result.kind === 'list' ? result.items[3] : undefined)
  })
})
