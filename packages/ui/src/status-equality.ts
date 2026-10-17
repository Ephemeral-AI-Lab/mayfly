/**
 * Value equality for the small status trees a views pane publishes as its summary. A producer that rebuilds its summary
 * on every tick or delta hands the lane a fresh object with equal content; the lane and the pane service compare it here
 * so an equal summary bumps no serial, settles nothing, and repaints nothing.
 *
 * @module @ephemeral-ai/mayfly-ui/status-equality
 */

import type {
  MayflyField,
  MayflyInlineSpan,
  MayflyPaneSummary,
  MayflyStatusChild,
  MayflyStatusNode,
  MayflyViewportCondition,
} from './contracts.ts'

function equalArray<Value>(left: readonly Value[] | undefined, right: readonly Value[] | undefined, equal: (a: Value, b: Value) => boolean): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) if (!equal(left[index]!, right[index]!)) return false
  return true
}

function equalStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return equalArray(left, right, (a, b) => a === b)
}

function equalSpan(left: MayflyInlineSpan, right: MayflyInlineSpan): boolean {
  return left.text === right.text
    && left.tone === right.tone
    && equalStrings(left.styles, right.styles)
    && left.motion === right.motion
    && left.variant === right.variant
}

function equalField(left: MayflyField, right: MayflyField): boolean {
  return left.label === right.label && equalArray(left.value, right.value, equalSpan)
}

function equalWhen(left: MayflyViewportCondition | undefined, right: MayflyViewportCondition | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined
    && left.minWidth === right.minWidth && left.maxWidth === right.maxWidth
    && left.minHeight === right.minHeight && left.maxHeight === right.maxHeight)
}

function equalContent(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left === 'string' || typeof right === 'string') return false
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((chunk, index) => (chunk as { readonly text?: unknown }).text === (right[index] as { readonly text?: unknown }).text)
}

function equalChild(left: MayflyStatusChild, right: MayflyStatusChild): boolean {
  return equalStatusNode(left.node, right.node)
    && left.id === right.id
    && left.basis === right.basis
    && left.grow === right.grow
    && left.shrink === right.shrink
    && left.minSize === right.minSize
    && left.maxSize === right.maxSize
    && equalWhen(left.when, right.when)
    && left.priority === right.priority
    && left.band === right.band
    && left.mark === right.mark
    && left.overflow === right.overflow
}

/**
 * Whether two status nodes carry the same content. The nodes are the small, plain trees a views summary and the status
 * row use: text, rich text, fields, progress, a status stack, or a shed chain. Comparison is structural; a fresh object
 * with equal content is equal.
 * @param left - the previous node, or null.
 * @param right - the next node, or null.
 * @returns whether both describe the same tree.
 */
export function equalStatusNode(left: MayflyStatusNode | null, right: MayflyStatusNode | null): boolean {
  if (left === right) return true
  if (left === null || right === null || left.kind !== right.kind) return false
  switch (left.kind) {
    case 'text':
      return right.kind === 'text'
        && equalContent(left.content, right.content)
        && left.tone === right.tone
        && left.overflow === right.overflow
        && equalStrings(left.styles, right.styles)
    case 'rich-text':
      return right.kind === 'rich-text'
        && equalArray(left.spans, right.spans, equalSpan)
        && left.overflow === right.overflow
    case 'fields':
      return right.kind === 'fields' && equalArray(left.rows, right.rows, equalField)
    case 'progress':
      return right.kind === 'progress'
        && left.label === right.label
        && left.value === right.value
        && left.max === right.max
        && left.style === right.style
        && left.width === right.width
        && left.tone === right.tone
        && left.showCount === right.showCount
        && left.showPercent === right.showPercent
        && left.transition?.from === right.transition?.from
        && left.transition?.ms === right.transition?.ms
        && left.transition?.rev === right.transition?.rev
    case 'stack':
      return right.kind === 'stack'
        && left.direction === right.direction
        && left.gap === right.gap
        && left.align === right.align
        && equalArray(left.children, right.children, equalChild)
    case 'shed':
      return right.kind === 'shed'
        && equalStatusNode(left.node, right.node)
        && equalArray(left.narrower, right.narrower, (a, b) => a.rank === b.rank && equalStatusNode(a.node, b.node))
  }
}

/**
 * Whether two views summaries carry the same node.
 * @param left - the previous summary, or null.
 * @param right - the next summary, or null.
 * @returns whether the summary is unchanged by value.
 */
export function equalPaneSummary(left: MayflyPaneSummary | null, right: MayflyPaneSummary | null): boolean {
  return left === right || (left !== null && right !== null && equalStatusNode(left.node, right.node))
}
