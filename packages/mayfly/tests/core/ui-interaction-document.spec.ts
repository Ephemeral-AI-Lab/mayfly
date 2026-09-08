/** Semantic document anchors over source replacement and renderer widths.
 * @module @ephemeral-ai/mayfly/tests/core/ui-interaction-document
 */
import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import {
  documentAnchorAtRow,
  documentAnchorRow,
  documentBlocks,
  documentOffset,
  moveDocument,
  reconcileDocument,
  remapDocumentOffset,
} from '../../src/core/ui-interaction-document.ts'
import { materializeDeferredUiNode, validateMayflyUiNode } from '../../src/core/ui-validator.ts'

const document = (first: string, second = 'second') => ui.scroll(ui.stack.column([
  ui.child(ui.text(first), { id: 'first' }),
  ui.child(ui.text(second), { id: 'second' }),
]), { id: 'document' })

describe('semantic document state', () => {
  it('clamps offsets without splitting a surrogate pair', () => {
    const source = 'a😀b'
    expect(documentOffset(source, -1)).toBe(0)
    expect(documentOffset(source, 2)).toBe(1)
    expect(documentOffset(source, 99)).toBe(source.length)
    expect(documentOffset(source, Number.NaN)).toBe(0)
  })

  it('maps insertions, removals, tails, and bounded-diff fallbacks', () => {
    expect(remapDocumentOffset('same', 'same', 2)).toBe(2)
    expect(remapDocumentOffset('abc', 'ac', 1)).toBe(1)
    expect(remapDocumentOffset('abc', 'ac', 3)).toBe(2)
    expect(remapDocumentOffset('abc', 'abc!', 3)).toBe(4)
    const before = `${'a'.repeat(3_000)}tail`
    const after = `${'b'.repeat(3_200)}tail`
    expect(remapDocumentOffset(before, after, before.length)).toBe(after.length)
    expect(remapDocumentOffset(before, after, 10)).toBe(10)
  })

  it('extracts stable source text from every passive node shape', () => {
    const nodes = [
      ui.markdown('# markdown'),
      ui.code('const value = 1'),
      ui.code('print(1)', { language: 'python' }),
      ui.richText([{ text: 'rich' }, { text: ' text' }]),
      ui.fields([{ label: 'Name', value: [{ text: 'Value' }] }]),
      ui.diff('before', 'after'),
      ui.sections([
        { body: ui.text('untitled') },
        { title: 'Open', body: ui.text('body') },
        { title: 'Closed', body: ui.text('hidden'), collapsed: true },
      ]),
      ui.stack.row([ui.text('left'), ui.text('right')]),
      ui.surface({ title: 'Title', subtitle: 'Subtitle', child: ui.text('body'), footer: ui.text('footer') }),
      ui.surface({ child: ui.text('body') }),
      ui.scroll(ui.text('scroll body')),
      ui.diagram('graph TD'),
      ui.chart({ chart: 'sparkline', title: 'Chart', values: [1] }),
      ui.chart({ chart: 'sparkline', values: [1] }),
      ui.empty({ title: 'Empty', description: 'Description' }),
      ui.empty({ title: 'Empty' }),
      ui.progress({ label: 'Progress', value: 1, max: 2 }),
      ui.progress({ value: 1, max: 2 }),
      ui.divider({ label: 'Divider' }),
      ui.divider(),
      ui.form({ id: 'ignored', fields: [] }),
    ]
    const result = documentBlocks(ui.stack.row(nodes))
    expect(result.complete).toBe(true)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]!.source).toContain('# markdown')
    expect(result.blocks[0]!.source).toContain('python\nprint(1)')
    expect(result.blocks[0]!.source).toContain('Closed')
    expect(result.blocks[0]!.source).not.toContain('hidden')
  })

  it('retains prior blocks while a deferred branch is incomplete', () => {
    const admitted = validateMayflyUiNode({
      kind: 'stack', direction: 'column', children: [
        { id: 'ready', node: { kind: 'text', content: 'ready' } },
        { id: 'late', when: { minWidth: 100 }, node: { kind: 'text', content: 'late' } },
      ],
    })
    expect(admitted.ok).toBe(true)
    if (!admitted.ok || admitted.value.kind !== 'stack') throw new Error('expected stack')
    const lazy = admitted.value.children[1]!.node
    const incomplete = { kind: 'scroll' as const, child: admitted.value }
    const blocks = documentBlocks(admitted.value)
    expect(blocks).toMatchObject({ complete: false, blocks: [{ source: 'ready' }] })
    expect(documentBlocks({ kind: 'stack', direction: 'row', children: [{ node: lazy }, { node: ui.text('visible') }] })).toMatchObject({ complete: false, blocks: [] })
    const previous = reconcileDocument(undefined, document('old ready', 'old late'))
    const retained = reconcileDocument(previous, incomplete)
    expect(retained.blocks.map(block => block.id)).toEqual([JSON.stringify(['ready']), JSON.stringify(['first']), JSON.stringify(['second'])])
    expect(materializeDeferredUiNode(lazy)).toMatchObject({ ok: true })
    expect(documentBlocks(admitted.value)).toMatchObject({ complete: true })
  })

  it('remaps an anchored block and falls forward when that block is removed', () => {
    let state = reconcileDocument(undefined, document('hello world'))
    state = moveDocument(state, { blockId: JSON.stringify(['first']), offset: 6, follow: 'none' })
    state = reconcileDocument(state, document('hello brave world'))
    expect(state.blocks.find(block => block.id === JSON.stringify(['first']))!.source.slice(state.anchor!.offset)).toBe('world')
    state = reconcileDocument(state, ui.scroll(ui.stack.column([
      ui.child(ui.text('second'), { id: 'second' }),
    ]), { id: 'document' }))
    expect(state.anchor).toEqual({ blockId: JSON.stringify(['second']), offset: 0, follow: 'none' })
    expect(reconcileDocument(state, document('second', 'new'))).not.toBe(state)
  })

  it('uses the first surviving block or no anchor when all previous blocks disappear', () => {
    let state = reconcileDocument(undefined, document('one', 'two'))
    state = moveDocument(state, { blockId: JSON.stringify(['second']), offset: 1, follow: 'end' })
    state = reconcileDocument(state, ui.scroll(ui.stack.column([ui.child(ui.text('new'), { id: 'new' })])))
    expect(state.anchor).toEqual({ blockId: JSON.stringify(['new']), offset: 0, follow: 'end' })

    const deferred = validateMayflyUiNode({
      kind: 'stack', direction: 'column', children: [{ id: 'only', when: { minWidth: 100 }, node: { kind: 'text', content: 'late' } }],
    })
    expect(deferred.ok).toBe(true)
    if (!deferred.ok || deferred.value.kind !== 'stack') throw new Error('expected stack')
    const empty = reconcileDocument(undefined, { kind: 'scroll', child: deferred.value })
    expect(empty.anchor).toBeUndefined()
    expect(empty.blocks).toEqual([])

    const following = reconcileDocument(undefined, ui.scroll(ui.text('tail'), { follow: 'end' }))
    expect(following.anchor?.follow).toBe('end')
    expect(reconcileDocument(following, ui.scroll(ui.text('tail'), { follow: 'end' }))).toBe(following)
  })

  it('ignores missing and unchanged move targets', () => {
    const state = reconcileDocument(undefined, document('first'))
    expect(moveDocument(state, { blockId: 'missing', offset: 0, follow: 'none' })).toBe(state)
    expect(moveDocument(state, state.anchor!)).toBe(state)
  })

  it('maps rows to source offsets and back across wrapping and wide characters', () => {
    const state = reconcileDocument(undefined, document('0123456789中文😀tail'))
    const anchor = documentAnchorAtRow(state, 2, 5)
    expect(anchor).toBeDefined()
    const moved = moveDocument(state, anchor!)
    expect(documentAnchorRow(moved, 5)).toBe(2)
    expect(documentAnchorRow(moved, 10)).toBe(1)
  })

  it('maps empty, missing, newline, combining, negative, and tail rows', () => {
    expect(documentAnchorAtRow({ blocks: [] }, 0, 10)).toBeUndefined()
    expect(documentAnchorRow({ blocks: [{ id: 'one', source: 'body' }] }, 10)).toBe(0)
    expect(documentAnchorRow({ blocks: [{ id: 'one', source: 'body' }], anchor: { blockId: 'missing', offset: 0, follow: 'none' } }, 10)).toBe(0)
    const state = {
      blocks: [
        { id: 'one', source: 'a\nb' },
        { id: 'two', source: `e\u0301😀tail` },
      ],
      anchor: { blockId: 'two', offset: 2, follow: 'none' as const },
    }
    expect(documentAnchorAtRow(state, -5, Number.NaN)).toEqual({ blockId: 'one', offset: 0, follow: 'none' })
    const tail = documentAnchorAtRow(state, 999, 2, 'end')!
    expect(tail).toEqual({ blockId: 'two', offset: state.blocks[1]!.source.length, follow: 'end' })
    expect(documentAnchorRow({ ...state, anchor: tail }, 2)).toBeGreaterThan(1)
  })
})
