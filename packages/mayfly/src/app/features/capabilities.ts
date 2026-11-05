/**
 * Validated Mayfly Host capability reads for optional Remote productivity surfaces.
 * @module @ephemeral-ai/mayfly/remote/features/capabilities
 */

import type { MayflyHostFeature } from '@ephemeral-ai/mayfly-host/types'
import type { HostClient } from '../../client/types.ts'
import { RemoteCallError } from './official.ts'

/** Read whether one physical Host generation advertises an optional feature. */
export async function hasMayflyHostFeature(
  client: HostClient,
  feature: MayflyHostFeature,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted()
  const result = await client.remote.mayflyHost.capabilities()
  signal?.throwIfAborted()
  // The wire error is a plain object; throwing it would render as
  // '[object Object]' through remoteErrorMessage.
  if (!result.ok) throw new RemoteCallError(result.error.code, result.error.message)
  return result.value.features.includes(feature)
}

/** Actionable copy for a Host that does not compose an optional capability. */
export function unavailableCapability(feature: MayflyHostFeature): string {
  return `${feature} is unavailable on this Host; upgrade or recompose the Host to enable it`
}
