/**
 * Transient command and operation feedback owned by the remote editor.
 * @module @ephemeral-ai/mayfly/remote/notice
 */
export interface RemoteNotice {
  /** Replace the current notice; an empty string clears it. */
  set(text: string): void
}
