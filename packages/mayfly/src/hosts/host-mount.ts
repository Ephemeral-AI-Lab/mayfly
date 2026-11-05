/**
 * Typed mount seam for the generated Mayfly Host Remote contribution.
 * @module @ephemeral-ai/mayfly/frontend/host-mount
 */
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { HostClient } from '../client/types.ts'
import type { MayflyHostRemote } from './host-contract.ts'

/** Generated Client-safe Remote artifact injected by the integration layer. */
type HostRemoteContribution = Parameters<ClientRemote['$mount']>[0]

/** Authoritative Host projection key consumed through ProjectionValueStore. */
export const MAYFLY_CONVERSATION_PROJECTION = 'mayflyConversation'

/** Mount the injected generated artifact on the same Client that owns ClientSessions. */
export function mountMayflyHostRemote(
  client: HostClient,
  contribution: HostRemoteContribution,
): ReturnType<ClientRemote['$mount']> {
  return client.remote.$mount(contribution)
}

/** Read the namespace installed by that exact generated contribution. */
export function mayflyHostRemote(client: HostClient): MayflyHostRemote {
  return client.remote.mayflyHost
}
