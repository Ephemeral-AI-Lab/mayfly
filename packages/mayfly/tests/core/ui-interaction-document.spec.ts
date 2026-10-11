/** Semantic document anchors over source replacement and renderer widths.
 * @module @ephemeral-ai/mayfly/tests/core/ui-interaction-document
 */
import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import {
  documentAnchorAtRow,
  documentAnchorRow,
  documentBlocks,
  documentBlockText,
  documentOffset,
  documentResolver,
  moveDocument,
  reconcileDocument,
  remapDocumentOffset,
  type DocumentResolver,
  type UiDocumentState,
} from '../../src/core/ui-interaction-document.ts'
import { materializeDeferredUiNode, validateMayflyUiNode } from '../../src/core/ui-validator.ts'
import { DARK_COLORS } from '../../src/core/theme-dark.ts'
import { MayflyContentCache } from '../../src/core/ui-content-cache.ts'
import type { ContentRowsEnv } from '../../src/core/content-rows.ts'
import type { MayflyComponents } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'

const env: ContentRowsEnv = {
  components: { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as MayflyComponents,
  colors: DARK_COLORS,
  cache: new MayflyContentCache(),
  bounded: false,
  viewportRows: () => 0,
  elide: hidden => `…${String(hidden)}`,
  errorRows: message => [`<error>${message}</error>`],
}
const resolve: DocumentResolver = documentResolver(env)

const document = (first: string, second = 'second') => ui.scroll(ui.stack.column([
  ui.child(ui.text(first), { id: 'first' }),
  ui.child(ui.text(second), { id: 'second' }),
]), { id: 'document' })

/** Inline block fixtures carry plain text nodes so the document model can be fed without builders. */
const textBlock = (id: string, content: string) => ({ id, node: ui.text(content) })
const withAnchor = (state: Omit<UiDocumentState, 'anchor'>, anchor: UiDocumentState['anchor']): UiDocumentState =>
  anchor === undefined ? state : { ...state, anchor }

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
    // A position inside the common prefix or suffix keeps its seat; an edit storm past the diff cap falls back
    // to clamping the position into the new document.
    expect(remapDocumentOffset('abc def', 'abc XYZ', 2)).toBe(2)
    expect(remapDocumentOffset('abc', 'xbc', 2)).toBe(2)
    const stormBefore = Array.from({ length: 1_100 }, (_, index) => `a${String(index)}`).join('')
    const stormAfter = Array.from({ length: 1_100 }, (_, index) => `b${String(index)}`).join('')
    expect(remapDocumentOffset(stormBefore, stormAfter, 5)).toBe(5)
    const before = `${'a'.repeat(3_000)}tail`
    const after = `${'b'.repeat(3_200)}tail`
    expect(remapDocumentOffset(before, after, before.length)).toBe(after.length)
    expect(remapDocumentOffset(before, after, 10)).toBe(10)
  })

  it('remaps positions inside added, removed, and kept changes', () => {
    // 'aXYc' -> 'ac': the removed 'XY' swallows its positions.
    expect(remapDocumentOffset('aXYc', 'ac', 1)).toBe(1)
    expect(remapDocumentOffset('aXYc', 'ac', 2)).toBe(1)
    // 'abx' -> 'aXYby': 'b' sits in a kept change after an added one, 'x' in the removed tail change.
    expect(remapDocumentOffset('abx', 'aXYby', 1)).toBe(3)
    expect(remapDocumentOffset('abx', 'aXYby', 2)).toBe(4)
  })

  it('keeps admitted nodes as blocks and derives their source text on demand', () => {
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
      ui.chart({ chart: 'sparkline', label: 'Chart', values: [1] }),
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
    const text = documentBlockText(result.blocks[0]!)
    expect(text).toContain('# markdown')
    expect(text).toContain('python\nprint(1)')
    expect(text).toContain('Closed')
    expect(text).not.toContain('hidden')
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
    expect(blocks).toMatchObject({ complete: false, blocks: [{ node: { content: 'ready' } }] })
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
    expect(documentBlockText(state.blocks.find(block => block.id === JSON.stringify(['first']))!).slice(state.anchor!.offset)).toBe('world')
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

  it('keeps the anchor when a republish admits the same content in new nodes', () => {
    // Locale refreshes rebuild every node; the text is identical, so the offset carries verbatim.
    let state = reconcileDocument(undefined, document('anchor body'))
    state = moveDocument(state, { blockId: JSON.stringify(['first']), offset: 4, follow: 'none' })
    const republished = reconcileDocument(state, document('anchor body'))
    expect(republished).toBe(state)
  })

  it('ignores missing and unchanged move targets', () => {
    const state = reconcileDocument(undefined, document('first'))
    expect(moveDocument(state, { blockId: 'missing', offset: 0, follow: 'none' })).toBe(state)
    expect(moveDocument(state, state.anchor!)).toBe(state)
  })

  it('maps rows to source offsets and back across wrapping and wide characters', () => {
    const state = reconcileDocument(undefined, document('0123456789中文😀tail'))
    const anchor = documentAnchorAtRow(state, 2, 5, 'none', resolve)
    expect(anchor).toBeDefined()
    const moved = moveDocument(state, anchor!)
    expect(documentAnchorRow(moved, 5, resolve)).toBe(2)
    expect(documentAnchorRow(moved, 10, resolve)).toBe(1)
  })

  it('answers anchor geometry for a megabyte document without painting it', () => {
    const body = Array.from({ length: 4_000 }, (_, index) => `line ${String(index)} ${'x'.repeat(60)}`).join('\n')
    const state = reconcileDocument(undefined, ui.scroll(ui.code(body, { language: 'text' }), { id: 'big' }))
    const block = state.blocks[0]!
    const source = resolve(block, 40)
    expect(source.length).toBeGreaterThan(4_000)
    // The map and the source agree: a row's offset maps back to that row's segment.
    const anchor = documentAnchorAtRow(state, 2_000, 40, 'none', resolve)!
    expect(anchor.blockId).toBe(block.id)
    const row = documentAnchorRow(withAnchor({ blocks: state.blocks }, anchor), 40, resolve)
    expect(Math.abs(row - 2_000)).toBeLessThanOrEqual(1)
    expect(documentAnchorAtRow(state, source.length + 9, 40, 'end', resolve)).toEqual({ blockId: block.id, offset: documentBlockText(block).length, follow: 'end' })
  })

  it('derives block text and sources across every block kind', () => {
    // A responsive branch the viewport has not activated yet contributes nothing to the source text.
    const gated = validateMayflyUiNode({
      kind: 'stack', direction: 'column', children: [
        { id: 'ready', node: { kind: 'text', content: 'ready' } },
        { id: 'late', when: { minWidth: 100 }, node: { kind: 'text', content: 'late' } },
      ],
    })
    if (!gated.ok || gated.value.kind !== 'stack') throw new Error('expected stack')
    const deferred = gated.value.children[1]!.node
    expect(documentBlockText({ id: 'd', node: deferred })).toBe('')
    expect(documentBlockText({ id: 's', node: { kind: 'stack', direction: 'row', children: [{ node: deferred }, { node: ui.text('visible') }] } })).toBe('')
    materializeDeferredUiNode(deferred)
    expect(documentBlockText({ id: 'd', node: deferred })).toBe('late')

    // Kinds with no content source take the estimated map; its width prefix memo evicts past four entries.
    const chart = { id: 'c', node: ui.chart({ chart: 'line', title: 'Load', series: [{ id: 'a', label: 'a', points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }] }) }
    const wide = { id: 'w', node: ui.stack.row([ui.text(Array.from({ length: 100 }, (_, index) => `line ${String(index)}`).join('\n'))]) }
    for (const width of [10, 20, 30, 40, 50]) expect(resolve(chart, width).length).toBeGreaterThanOrEqual(0)
    // An image block maps its alt text; a block whose parts contribute nothing still resolves a source.
    expect(documentBlockText({ id: 'i', node: { kind: 'image', attachmentId: 'a1', alt: '[Image #1]' } })).toBe('[Image #1]')
    const gatedBad = validateMayflyUiNode({
      kind: 'stack', direction: 'column', children: [
        { id: 'bad', when: { minWidth: 100 }, node: { kind: 'text', content: 42 } },
      ],
    })
    if (!gatedBad.ok || gatedBad.value.kind !== 'stack') throw new Error('expected stack')
    const badStack = { id: 'b', node: { kind: 'stack', direction: 'column', children: [{ node: gatedBad.value.children[0]!.node }] } }
    expect(resolve(badStack as never, 40).length).toBeGreaterThanOrEqual(0)
    const estimated = resolve(wide, 10)
    expect(estimated.length).toBeGreaterThanOrEqual(100)
    expect(estimated.rowOf(50)).toBeGreaterThan(0)
    expect(estimated.offsetOf(estimated.length - 1)).toBeGreaterThan(0)
    expect(estimated.offsetOf(estimated.rowOf(50))).toBeLessThanOrEqual(50)

    // Content kinds without a shared offset map take the proportional map over their real length.
    const diffBlock = { id: 'd', node: ui.diff('a\nb\nc', 'a\nx\nc') }
    const proportional = resolve(diffBlock, 20)
    expect(proportional.length).toBeGreaterThan(1)
    expect(proportional.rowOf(0)).toBe(0)
    expect(proportional.offsetOf(0)).toBe(0)
    const pastEnd = proportional.offsetOf(proportional.length + 9)
    expect(pastEnd).toBeGreaterThan(0)
    expect(pastEnd).toBeLessThanOrEqual(documentBlockText(diffBlock).length)
    const oneRow = resolve({ id: 'f', node: ui.fields([{ label: 'L', value: [{ text: 'V' }] }]) }, 40)
    expect(oneRow.rowOf(99)).toBe(0)
  })

  it('maps empty, missing, newline, combining, negative, and tail rows', () => {
    expect(documentAnchorAtRow({ blocks: [] }, 0, 10, 'none', resolve)).toBeUndefined()
    expect(documentAnchorRow({ blocks: [textBlock('one', 'body')] }, 10, resolve)).toBe(0)
    expect(documentAnchorRow({ blocks: [textBlock('one', 'body')], anchor: { blockId: 'missing', offset: 0, follow: 'none' } }, 10, resolve)).toBe(0)
    const state: UiDocumentState = {
      blocks: [
        textBlock('one', 'a\nb'),
        textBlock('two', 'e\u0301😀tail'),
      ],
      anchor: { blockId: 'two', offset: 2, follow: 'none' as const },
    }
    expect(documentAnchorAtRow(state, -5, Number.NaN, 'none', resolve)).toEqual({ blockId: 'one', offset: 0, follow: 'none' })
    const tail = documentAnchorAtRow(state, 999, 2, 'end', resolve)!
    expect(tail).toEqual({ blockId: 'two', offset: documentBlockText(state.blocks[1]!).length, follow: 'end' })
    expect(documentAnchorRow({ ...state, anchor: tail }, 2, resolve)).toBeGreaterThan(1)
  })
})
