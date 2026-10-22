/**
 * The single depth-first traversal over canonical Mayfly UI trees and the
 * core-private editor-shell tree. One child-position list serves control
 * collection, deferred admission, field state, and editor-slot assertions.
 *
 * @module @ephemeral-ai/mayfly/core/ui-walk
 */

import type { MayflyUiChild, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyEditorShellNode } from './ui-contracts.ts'

/** Any tree the walk accepts: public UI nodes plus the editor-shell injection shapes. */
export type MayflyUiWalkNode = MayflyUiNode | MayflyEditorShellNode

/** One parent-to-child position in a canonical tree. */
export interface MayflyUiWalkEdge {
  readonly kind: 'stack-child' | 'surface-child' | 'surface-footer' | 'scroll-child' | 'list-empty' | 'empty-actions'
  readonly index?: number
  readonly wrapper?: Omit<MayflyUiChild, 'node'>
  readonly node: MayflyUiWalkNode
}

function* uiNodeChildEdges(node: MayflyUiWalkNode): IterableIterator<MayflyUiWalkEdge> {
  switch (node.kind) {
    case 'stack': {
      let index = 0
      for (const child of node.children) {
        yield { kind: 'stack-child', index, wrapper: child, node: child.node }
        index += 1
      }
      break
    }
    case 'surface':
      yield { kind: 'surface-child', node: node.child }
      if (node.footer !== undefined) yield { kind: 'surface-footer', node: node.footer }
      break
    case 'scroll':
      yield { kind: 'scroll-child', node: node.child }
      break
    case 'list':
      if (node.empty !== undefined) yield { kind: 'list-empty', node: node.empty }
      break
    case 'empty':
      if (node.actions !== undefined) yield { kind: 'empty-actions', node: node.actions }
      break
    default: break
  }
}

/**
 * Depth-first pre-order traversal. The visitor receives the current node and
 * context plus a `descend` continuation; calling `descend` walks the node's
 * child positions in order. A select callback may prune an edge with `false`
 * or supply the child context; omitting it descends everywhere unchanged.
 */
export function walkUiNode<Context>(
  node: MayflyUiWalkNode,
  context: Context,
  visit: (
    node: MayflyUiWalkNode,
    context: Context,
    descend: (select?: (edge: MayflyUiWalkEdge) => Context | false | undefined) => void,
  ) => void,
): void {
  visit(node, context, select => {
    for (const edge of uiNodeChildEdges(node)) {
      if (select === undefined) {
        walkUiNode(edge.node, context, visit)
        continue
      }
      const selected = select(edge)
      if (selected === false) continue
      walkUiNode(edge.node, selected === undefined ? context : selected, visit)
    }
  })
}

/** Short-circuiting walk over the same positions; `descend` may restrict which nodes unfold. */
export function someUiNode(
  node: MayflyUiWalkNode,
  predicate: (node: MayflyUiWalkNode) => boolean,
  descend?: (node: MayflyUiWalkNode) => boolean,
): boolean {
  if (predicate(node)) return true
  if (descend !== undefined && !descend(node)) return false
  for (const edge of uiNodeChildEdges(node)) if (someUiNode(edge.node, predicate, descend)) return true
  return false
}
