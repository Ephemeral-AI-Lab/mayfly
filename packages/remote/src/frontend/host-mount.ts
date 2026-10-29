/**
 * Typed mount seam for the generated Mayfly Host Remote contribution.
 * @module @ephemeral-ai/mayfly/frontend/host-mount
 */
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { HostClient } from '../client/types.ts'

/** Generated contribution exported by @ephemeral-ai/mayfly-host/remote. */
export type MayflyHostRemoteContribution = Parameters<ClientRemote['$mount']>[0]
/** Disposer returned by the official Client Remote mount lifecycle. */
export type MayflyHostRemoteDisposer = Awaited<ReturnType<ClientRemote['$mount']>>

/** Authoritative Host projection key consumed through ProjectionValueStore. */
export const MAYFLY_CONVERSATION_PROJECTION = 'mayflyConversation'
/** Optional Host presentation-facts projection key; absence leaves standard Session facts intact. */
export const MAYFLY_FACTS_PROJECTION = 'mayflyConversationFacts'

/** Mount the generated Host contribution on the same Client that owns ClientSessions. */
export function mountMayflyHostRemote(
  client: HostClient,
  contribution: MayflyHostRemoteContribution,
): ReturnType<ClientRemote['$mount']> {
  return client.remote.$mount(contribution)
}
