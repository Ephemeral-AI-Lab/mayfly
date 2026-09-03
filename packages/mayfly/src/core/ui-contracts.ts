/** Renderer-private contracts for canonical validation and editor composition.
 * @module @ephemeral-ai/mayfly/core/ui-contracts
 */

import type { MayflyStackNode, MayflySurfaceNode, MayflyUiChild, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Validation failures emitted by the canonical renderer boundary. */
export type MayflyUiErrorCode = 'MAYFLY_INVALID_CONTRIBUTION' | 'MAYFLY_LIMIT_EXCEEDED'

/** Renderer-local validation result; this is not a plugin action protocol. */
export type MayflyValidationResult<Value> =
  | { readonly ok: true, readonly value: Value }
  | { readonly ok: false, readonly code: MayflyUiErrorCode, readonly message: string }

export interface MayflyEditorControlNode { readonly kind: 'editor-control' }
export interface MayflyEditorChild extends Omit<MayflyUiChild, 'node'> { readonly node: MayflyEditorShellNode }
export interface MayflyEditorStackNode extends Omit<MayflyStackNode, 'children'> { readonly children: readonly MayflyEditorChild[] }
export interface MayflyEditorSurfaceNode extends Omit<MayflySurfaceNode, 'child' | 'footer'> {
  readonly child: MayflyEditorShellNode
  readonly footer?: MayflyEditorShellNode
}

/** Core-private tree that injects the one Mayfly-owned editor control. */
export type MayflyEditorShellNode =
  | Exclude<MayflyUiNode, MayflyStackNode | MayflySurfaceNode>
  | MayflyEditorStackNode
  | MayflyEditorSurfaceNode
  | MayflyEditorControlNode
