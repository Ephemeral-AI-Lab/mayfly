/** Shared marketplace and explicit split release upgrade composition.
 * @module @ephemeral-ai/mayfly/app/operations/plugins
 */
import { mountRemoteMarketplace } from './plugin-marketplace.ts'
import { mountRemoteUpdate } from './update.ts'
import type { RemoteOperationsContext } from './support.ts'

/** Mount native Host plugin management and the coordinated Host/TUI updater. */
export function mountRemotePluginOperations(context: RemoteOperationsContext): () => void {
  const disposeMarketplace = mountRemoteMarketplace(context)
  const disposeUpdate = mountRemoteUpdate(context)
  return () => { disposeUpdate(); disposeMarketplace() }
}
