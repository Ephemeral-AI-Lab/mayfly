/** Stable document source positions without renderer geometry or component ownership.
 * @module @ephemeral-ai/mayfly/core/ui-interaction-document
 */
import { diffChars } from 'diff'
import { freezeWire, type MayflyScrollNode, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { fieldText } from './field-text.ts'
import { isDeferredUiNode, materializedDeferredUiNode } from './ui-validator.ts'
import { indexContent, type ContentIndex } from './content-segments.ts'
import { commonPrefix, commonSuffix } from './text-match.ts'
import { documentRowsSource, type ContentRowsEnv } from './content-rows.ts'

export interface UiDocumentBlock { readonly id: string, readonly node: MayflyUiNode }
export interface UiDocumentAnchor { readonly blockId: string, readonly offset: number, readonly follow: 'none' | 'end' }
export interface UiDocumentState { readonly blocks: readonly UiDocumentBlock[], readonly anchor?: UiDocumentAnchor }

/**
 * A block's map between source-text offsets and rows at one width: `rowOf` counts the rows before an offset, and
 * `offsetOf` answers where a row begins. Segmented sources answer from their live row map; bounded kinds estimate
 * proportionally; anything else rides an index of the block's text — none of them re-wrap the document.
 */
export interface DocumentBlockSource {
  readonly length: number
  rowOf(offset: number): number
  offsetOf(row: number): number
}

/** Resolves one block's row map at a width; the compiler supplies it so anchors share the painted sources. */
export type DocumentResolver = (block: UiDocumentBlock, width: number) => DocumentBlockSource

export function documentOffset(source: string, offset: number): number {
  const position = Number.isFinite(offset) ? Math.max(0, Math.min(source.length, Math.trunc(offset))) : 0
  return position > 0 && /[\uDC00-\uDFFF]/u.test(source[position] ?? '') && /[\uD800-\uDBFF]/u.test(source[position - 1]!) ? position - 1 : position
}

/**
 * `offset` from `before` expressed in `after`: the unchanged prefix and suffix carry positions through verbatim,
 * positions past them ride the length shift, and only the changed window costs a bounded Myers diff — a replaced
 * megabyte body diffs its touched chunk, not the document. The unchanged ends are matched by native block compares, so
 * an appended or head-trimmed log costs a memory scan, not a loop over its units.
 */
export function remapDocumentOffset(before: string, after: string, offset: number): number {
  const position = documentOffset(before, offset)
  if (before === after) return position
  const prefix = commonPrefix(before, after, Math.min(before.length, after.length))
  if (position < prefix) return position
  const suffix = commonSuffix(before, after, Math.min(before.length - prefix, after.length - prefix))
  if (position >= before.length - suffix) return documentOffset(after, position + after.length - before.length)
  const changes = diffChars(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix), { maxEditLength: 2_048 })
  if (changes === undefined) return documentOffset(after, position)
  let oldPosition = prefix, newPosition = prefix
  for (const change of changes) {
    if (change.added) { newPosition += change.value.length; continue }
    if (position < oldPosition + change.value.length) return documentOffset(after, change.removed ? newPosition : newPosition + position - oldPosition)
    oldPosition += change.value.length
    if (!change.removed) newPosition += change.value.length
  }
  return documentOffset(after, newPosition)
}

function sourceText(node: MayflyUiNode): string | undefined {
  if (isDeferredUiNode(node)) {
    const admitted = materializedDeferredUiNode(node)
    return admitted?.ok === true ? sourceText(admitted.value) : undefined
  }
  const join = (values: readonly (string | undefined)[]) => values.includes(undefined) ? undefined : values.join('\n')
  switch (node.kind) {
    case 'text': return fieldText(node.content)
    case 'markdown': return fieldText(node.source)
    case 'code': return node.language === undefined ? fieldText(node.code) : `${node.language}\n${fieldText(node.code)}`
    case 'rich-text': return node.spans.map(span => span.text).join('')
    case 'fields': return node.rows.map(row => `${row.label}: ${row.value.map(span => span.text).join('')}`).join('\n')
    case 'diff': return `${node.before}\n${node.after}`
    case 'sections': return join(node.sections.map(section => join([section.title ?? '', section.collapsed ? '' : sourceText(section.body)])))
    case 'stack': return join(node.children.map(child => sourceText(child.node)))
    case 'surface': return join([node.title ?? '', node.subtitle ?? '', sourceText(node.child), node.footer === undefined ? '' : sourceText(node.footer)])
    case 'scroll': return sourceText(node.child)
    case 'diagram': return fieldText(node.source)
    case 'chart': return 'title' in node && node.title !== undefined ? node.title : ''
    case 'empty': return `${node.title}\n${node.description ?? ''}`
    case 'progress': return node.label ?? ''
    case 'divider': return node.label ?? ''
    case 'image': return node.alt
    default: return ''
  }
}

/** Whether `node` has document text at all — `sourceText`'s shape without joining the strings. */
function hasSource(node: MayflyUiNode): boolean {
  if (isDeferredUiNode(node)) {
    const admitted = materializedDeferredUiNode(node)
    return admitted?.ok === true && hasSource(admitted.value)
  }
  switch (node.kind) {
    case 'sections': return node.sections.every(section => section.collapsed === true || hasSource(section.body))
    case 'stack': return node.children.every(child => hasSource(child.node))
    case 'surface': return hasSource(node.child) && (node.footer === undefined || hasSource(node.footer))
    case 'scroll': return hasSource(node.child)
    default: return true
  }
}

/**
 * The admitted leaf nodes of a document, in order: a column stack of identified children nests, anything else is a
 * block. Blocks keep their node, not a copy of its text — the text is derived only where an anchor needs it.
 */
export function documentBlocks(node: MayflyUiNode): { readonly complete: boolean, readonly blocks: readonly UiDocumentBlock[] } {
  const blocks: UiDocumentBlock[] = []
  let complete = true
  const visit = (current: MayflyUiNode, path: readonly string[]): void => {
    if (!isDeferredUiNode(current) && current.kind === 'stack' && current.direction === 'column' && current.children.length > 0 && current.children.every(child => child.id !== undefined)) {
      for (const child of current.children) visit(child.node, [...path, child.id!])
      return
    }
    if (!hasSource(current)) { complete = false; return }
    blocks.push({ id: JSON.stringify(path), node: current })
  }
  visit(node, [])
  return { complete, blocks: freezeWire(blocks) }
}

/** A node's document text, materialized once: the node is frozen, so its text is stable while it lives. */
const documentTexts = new WeakMap<object, string>()

/** The text a block anchors, derived on demand — blocks keep their node, not a copy of this. */
export function documentBlockText(block: UiDocumentBlock): string {
  let text = documentTexts.get(block.node)
  if (text === undefined) {
    const resolved = sourceText(block.node)
    if (resolved === undefined) return ''
    text = resolved
    documentTexts.set(block.node, text)
  }
  return text
}

/**
 * A document's estimate for a block whose rows no content source maps (forms, lists, charts): the text is indexed
 * once, and each width carries a lazily built prefix over the same estimate model the segmented sources use.
 */
const estimatedDocuments = new WeakMap<object, { readonly text: string, readonly index: ContentIndex, readonly sources: Map<number, DocumentBlockSource> }>()

function estimatedBlockSource(node: MayflyUiNode, width: number): DocumentBlockSource {
  let held = estimatedDocuments.get(node)
  if (held === undefined) {
    const text = sourceText(node) ?? ''
    held = { text, index: indexContent(text), sources: new Map() }
    estimatedDocuments.set(node, held)
  }
  const safe = Math.max(1, Math.floor(width))
  let source = held.sources.get(safe)
  if (source === undefined) {
    if (held.sources.size >= 4) held.sources.delete(held.sources.keys().next().value!)
    const { index, text } = held
    let prefixes: number[] | undefined
    const prefix = (): number[] => {
      if (prefixes === undefined) {
        prefixes = new Array<number>(index.segments + 1).fill(0)
        for (let segment = 0; segment < index.segments; segment += 1) prefixes[segment + 1] = prefixes[segment]! + index.estimateRows(segment, safe)
      }
      return prefixes
    }
    source = {
      get length() { return prefix()[index.segments]! },
      rowOf(offset) {
        const segment = index.segmentAtOffset(offset)
        return prefix()[segment]! + index.rowOfOffset(segment, offset, safe, text)
      },
      offsetOf(row) {
        const bounds = prefix()
        let low = 0, high = index.segments - 1
        while (low < high) {
          const middle = (low + high + 1) >> 1
          if (bounds[middle]! <= row) low = middle
          else high = middle - 1
        }
        return index.offsetOfRow(low, Math.max(0, row - bounds[low]!), safe, text)
      },
    }
    held.sources.set(safe, source)
  }
  return source
}

/** A proportional map over a real row length: bounded blocks that keep no offset map of their own. */
function proportionalBlockSource(length: () => number, units: number): DocumentBlockSource {
  return {
    get length() { return length() },
    rowOf(offset) {
      const rows = length()
      return rows <= 1 ? 0 : Math.min(rows - 1, Math.floor((Math.max(0, Math.min(units, offset)) * rows) / Math.max(1, units)))
    },
    offsetOf(row) {
      const rows = length()
      return Math.min(units, Math.floor((Math.max(0, Math.min(Math.max(0, rows - 1), row)) * units) / Math.max(1, rows)))
    },
  }
}

/** The kinds whose shared source maps offsets in the same text space `sourceText` produces. */
const MAPPED_KINDS = new Set(['text', 'code', 'rich-text', 'markdown'])

/**
 * The block's row map at `width`: the shared segmented source for the kinds whose offsets ride it, a proportional
 * map over the shared source's real length for the other content kinds, or an index estimate for everything else.
 */
export function documentBlockSource(block: UiDocumentBlock, width: number, env: ContentRowsEnv): DocumentBlockSource {
  const safe = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1
  const source = documentRowsSource(block.node, safe, env)
  if (source !== undefined && MAPPED_KINDS.has(block.node.kind) && source.rowOf !== undefined && source.offsetOf !== undefined) {
    return { get length() { return source.length }, rowOf: offset => source.rowOf!(offset), offsetOf: row => source.offsetOf!(row) }
  }
  if (source !== undefined) return proportionalBlockSource(() => source.length, documentBlockText(block).length)
  return estimatedBlockSource(block.node, safe)
}

/** One resolver for a compiled surface: every block's map shares the env the leaves paint with. */
export function documentResolver(env: ContentRowsEnv): DocumentResolver {
  return (block, width) => documentBlockSource(block, width, env)
}

export function reconcileDocument(previous: UiDocumentState | undefined, node: MayflyScrollNode): UiDocumentState {
  const next = documentBlocks(node.child)
  const blocks = next.complete ? next.blocks : [...next.blocks, ...(previous?.blocks ?? []).filter(block => !next.blocks.some(next => next.id === block.id))]
  if (previous !== undefined && previous.blocks.length === blocks.length && previous.blocks.every((block, index) => {
    const next = blocks[index]!
    return block.id === next.id && (block.node === next.node || documentBlockText(block) === documentBlockText(next))
  })) return previous
  const old = previous?.anchor
  let anchor: UiDocumentAnchor | undefined
  if (old !== undefined) {
    const target = blocks.find(block => block.id === old.blockId)
    const original = previous!.blocks.find(block => block.id === old.blockId)!
    if (target !== undefined) anchor = { ...old, offset: target.node === original.node ? old.offset : remapDocumentOffset(documentBlockText(original), documentBlockText(target), old.offset) }
    else {
      const index = previous!.blocks.findIndex(block => block.id === old.blockId)
      const neighbors = [...previous!.blocks.slice(index + 1), ...previous!.blocks.slice(0, index).toReversed()]
      const fallback = neighbors.map(block => blocks.find(next => next.id === block.id)).find(block => block !== undefined) ?? blocks[0]!
      anchor = { blockId: fallback.id, offset: 0, follow: old.follow }
    }
  } else if (blocks[0] !== undefined) anchor = { blockId: blocks[0].id, offset: 0, follow: node.follow === 'end' ? 'end' : 'none' }
  return freezeWire({ blocks, ...(anchor === undefined ? {} : { anchor }) })
}

export function moveDocument(state: UiDocumentState, anchor: UiDocumentAnchor): UiDocumentState {
  const block = state.blocks.find(block => block.id === anchor.blockId)
  if (block === undefined) return state
  const next = { ...anchor, offset: documentOffset(documentBlockText(block), anchor.offset) }
  if (state.anchor?.blockId === next.blockId && state.anchor.offset === next.offset && state.anchor.follow === next.follow) return state
  return freezeWire({ ...state, anchor: next })
}

/** The document row the anchor points at: block lengths before it, then the anchor block's own offset map. */
export function documentAnchorRow(state: UiDocumentState, width: number, resolve: DocumentResolver): number {
  const anchor = state.anchor
  if (anchor === undefined) return 0
  let row = 0
  for (const block of state.blocks) {
    const source = resolve(block, width)
    if (block.id === anchor.blockId) return row + Math.max(0, Math.min(source.length, source.rowOf(documentOffset(documentBlockText(block), anchor.offset))))
    row += source.length
  }
  return 0
}

/** The anchor the scroll position `row` points at: the block holding that row, at the offset the row starts. */
export function documentAnchorAtRow(state: UiDocumentState, row: number, width: number, follow: 'none' | 'end', resolve: DocumentResolver): UiDocumentAnchor | undefined {
  if (state.blocks.length === 0) return undefined
  let remaining = Math.max(0, Math.floor(row))
  for (const block of state.blocks) {
    const source = resolve(block, width)
    if (remaining < source.length) return { blockId: block.id, offset: documentOffset(documentBlockText(block), source.offsetOf(remaining)), follow }
    remaining -= source.length
  }
  const block = state.blocks.at(-1)!
  return { blockId: block.id, offset: documentBlockText(block).length, follow }
}
