/**
 * Transient command and operation feedback owned by the remote editor.
 * @module @ephemeral-ai/mayfly/remote/notice
 */
import type { MayflyFeedbackRecord } from '@ephemeral-ai/mayfly-ui'

export interface RemoteNotice {
  /** Replace the current notice; an empty string clears it. */
  set(text: string, severity?: MayflyFeedbackRecord['severity'], detail?: string): void
}
