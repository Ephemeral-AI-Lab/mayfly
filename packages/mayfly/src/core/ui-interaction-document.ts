/** Stable document source positions without renderer geometry or component ownership.
 * @module @ephemeral-ai/mayfly/core/ui-interaction-document
 */
import { diffChars } from 'diff'
import { freezeWire, type MayflyScrollNode, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { isDeferredUiNode, materializedDeferredUiNode } from './ui-validator.ts'
import { visibleWidth } from './width.ts'

export interface UiDocumentBlock { readonly id: string, readonly source: string }
export interface UiDocumentAnchor { readonly blockId: string, readonly offset: number, readonly follow: 'none' | 'end' }
export interface UiDocumentState { readonly blocks: readonly UiDocumentBlock[], readonly anchor?: UiDocumentAnchor }

export function documentOffset(source: string, offset: number): number {
  const position = Number.isFinite(offset) ? Math.max(0, Math.min(source.length, Math.trunc(offset))) : 0
  return position > 0 && /[\uDC00-\uDFFF]/u.test(source[position] ?? '') && /[\uD800-\uDBFF]/u.test(source[position - 1]!) ? position - 1 : position
}

/** Bound Myers work; arbitrary replacement falls back within the same source block. */
export function remapDocumentOffset(before: string, after: string, offset: number): number {
  const position = documentOffset(before, offset)
  if (before === after) return position
  const changes = diffChars(before, after, { maxEditLength: 2_048 })
  if (changes === undefined) {
    let suffix = 0
    while (suffix < before.length && suffix < after.length && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix += 1
    return documentOffset(after, position >= before.length - suffix ? after.length - before.length + position : position)
  }
  let oldPosition = 0, newPosition = 0
  for (const change of changes) {
    if (change.added) { newPosition += change.value.length; continue }
    if (position < oldPosition + change.value.length) return documentOffset(after, change.removed ? newPosition : newPosition + position - oldPosition)
    oldPosition += change.value.length
    if (!change.removed) newPosition += change.value.length
  }
  return after.length
}

function sourceText(node: MayflyUiNode): string | undefined {
  if (isDeferredUiNode(node)) {
    const admitted = materializedDeferredUiNode(node)
    return admitted?.ok === true ? sourceText(admitted.value) : undefined
  }
  const join = (values: readonly (string | undefined)[]) => values.includes(undefined) ? undefined : values.join('\n')
  switch (node.kind) {
    case 'text': return node.content
    case 'markdown': return node.source
    case 'code': return node.language === undefined ? node.code : `${node.language}\n${node.code}`
    case 'rich-text': return node.spans.map(span => span.text).join('')
    case 'fields': return node.rows.map(row => `${row.label}: ${row.value.map(span => span.text).join('')}`).join('\n')
    case 'diff': return `${node.before}\n${node.after}`
    case 'sections': return join(node.sections.map(section => join([section.title ?? '', section.collapsed ? '' : sourceText(section.body)])))
    case 'stack': return join(node.children.map(child => sourceText(child.node)))
    case 'surface': return join([node.title ?? '', node.subtitle ?? '', sourceText(node.child), node.footer === undefined ? '' : sourceText(node.footer)])
    case 'scroll': return sourceText(node.child)
    case 'diagram': return node.source
    case 'chart': return 'title' in node && node.title !== undefined ? node.title : ''
    case 'empty': return `${node.title}\n${node.description ?? ''}`
    case 'progress': return node.label ?? ''
    case 'divider': return node.label ?? ''
    default: return ''
  }
}

export function documentBlocks(node: MayflyUiNode): { readonly complete: boolean, readonly blocks: readonly UiDocumentBlock[] } {
  const blocks: UiDocumentBlock[] = []
  let complete = true
  const visit = (current: MayflyUiNode, path: readonly string[]): void => {
    if (!isDeferredUiNode(current) && current.kind === 'stack' && current.direction === 'column' && current.children.length > 0 && current.children.every(child => child.id !== undefined)) {
      for (const child of current.children) visit(child.node, [...path, child.id!])
      return
    }
    const source = sourceText(current)
    if (source === undefined) { complete = false; return }
    blocks.push({ id: JSON.stringify(path), source })
  }
  visit(node, [])
  return { complete, blocks: freezeWire(blocks) }
}

export function reconcileDocument(previous: UiDocumentState | undefined, node: MayflyScrollNode): UiDocumentState {
  const next = documentBlocks(node.child)
  const blocks = next.complete ? next.blocks : [...next.blocks, ...(previous?.blocks ?? []).filter(block => !next.blocks.some(next => next.id === block.id))]
  if (previous !== undefined && previous.blocks.length === blocks.length && previous.blocks.every((block, index) => block.id === blocks[index]!.id && block.source === blocks[index]!.source)) return previous
  const old = previous?.anchor
  let anchor: UiDocumentAnchor | undefined
  if (old !== undefined) {
    const target = blocks.find(block => block.id === old.blockId)
    const original = previous!.blocks.find(block => block.id === old.blockId)!
    if (target !== undefined) anchor = { ...old, offset: remapDocumentOffset(original.source, target.source, old.offset) }
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
  const next = { ...anchor, offset: documentOffset(block.source, anchor.offset) }
  if (state.anchor?.blockId === next.blockId && state.anchor.offset === next.offset && state.anchor.follow === next.follow) return state
  return freezeWire({ ...state, anchor: next })
}

function rowOffsets(source: string, width: number): readonly number[] {
  const available = Math.max(1, Math.floor(width))
  const offsets = [0]
  let column = 0
  for (let index = 0; index < source.length;) {
    const point = source.codePointAt(index)!
    const value = String.fromCodePoint(point)
    const length = value.length
    if (value === '\n') {
      offsets.push(index + length)
      column = 0
      index += length
      continue
    }
    const size = Math.max(0, visibleWidth(value))
    if (column > 0 && column + size > available) {
      offsets.push(index)
      column = 0
    }
    column += size
    index += length
  }
  return offsets
}

export function documentAnchorRow(state: UiDocumentState, width: number): number {
  const anchor = state.anchor
  if (anchor === undefined) return 0
  let row = 0
  for (const block of state.blocks) {
    const offsets = rowOffsets(block.source, width)
    if (block.id === anchor.blockId) {
      const offset = documentOffset(block.source, anchor.offset)
      const local = offsets.findLastIndex(value => value <= offset)
      return row + Math.max(0, local)
    }
    row += offsets.length
  }
  return 0
}

export function documentAnchorAtRow(state: UiDocumentState, row: number, width: number, follow: 'none' | 'end' = 'none'): UiDocumentAnchor | undefined {
  if (state.blocks.length === 0) return undefined
  let remaining = Math.max(0, Math.floor(row))
  for (const block of state.blocks) {
    const offsets = rowOffsets(block.source, width)
    if (remaining < offsets.length) return { blockId: block.id, offset: offsets[remaining]!, follow }
    remaining -= offsets.length
  }
  const block = state.blocks.at(-1)!
  return { blockId: block.id, offset: documentOffset(block.source, block.source.length), follow }
}
