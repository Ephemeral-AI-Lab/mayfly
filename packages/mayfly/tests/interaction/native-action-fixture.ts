/** Invoke a registration endpoint to exercise stale and native failure paths.
 * @module @ephemeral-ai/mayfly/tests/interaction/native-action-fixture
 */
import { vi } from 'vitest'
import type { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import type { MayflyUiEvent } from '@ephemeral-ai/mayfly-ui'
export async function nativeAction(model: UiSurfaceModel, event: MayflyUiEvent, signal = new AbortController().signal) {
  const prepared = await model.endpoint.prepare(event, { surfaceId: model.id, source: model.source, revision: model.revision, operationId: 'native-test', signal, report: vi.fn() })
  return prepared.reply
}
export const activate = (actionId: string, controlId = 'actions'): MayflyUiEvent => ({ kind: 'activate', pagePath: [], controlId, actionId })
export const select = (controlId: string, ...selectedIds: string[]): MayflyUiEvent => ({ kind: 'selection-accept', pagePath: [], controlId, selectedIds })
