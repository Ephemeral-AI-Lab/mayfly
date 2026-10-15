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

export interface MayflyEditorChild extends Omit<MayflyUiChild, 'node'> { readonly node: MayflyEditorShellNode }
interface MayflyEditorStackNode extends Omit<MayflyStackNode, 'children'> { readonly children: readonly MayflyEditorChild[] }
interface MayflyEditorSurfaceNode extends Omit<MayflySurfaceNode, 'child' | 'footer'> {
  readonly child: MayflyEditorShellNode
  readonly footer?: MayflyEditorShellNode
}

/** Core-private tree whose one `prompt` node is the face of the Mayfly-owned editor: the host paints its buffer and takes its keys. */
export type MayflyEditorShellNode =
  | Exclude<MayflyUiNode, MayflyStackNode | MayflySurfaceNode>
  | MayflyEditorStackNode
  | MayflyEditorSurfaceNode
