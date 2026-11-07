/**
 * Exact displayed-selection predicate shared by Remote interaction controllers.
 * @module @ephemeral-ai/mayfly/app/interactions/selection
 */

import type { HostClient, SessionRef } from '../../client/types.ts'
import type { RemoteFeatureSelection } from '../features.ts'

/** Test whether a captured Client/Session still owns the exact displayed selection. */
export function isRemoteFeatureSelection(
  current: RemoteFeatureSelection | undefined,
  client: HostClient,
  ref: SessionRef,
): current is RemoteFeatureSelection {
  return current?.client === client && current.ref.host === ref.host && current.ref.sessionId === ref.sessionId
}
