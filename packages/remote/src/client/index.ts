/** Remote dsh Host Client assembly, transport, shared contracts, and headless smoke. */
export {
  createHostClient,
  type CreateHostClientOptions,
  type HostRemoteContribution,
} from './host-client.ts'
export {
  NodeConnectionTransport,
  type NodeConnectionTransportOptions,
  type NodeWebSocketFactory,
} from './transport.ts'
export { smokeHostClient, type HostClientSmokeOptions, type HostClientSmokeResult } from './smoke.ts'
export {
  HostKey,
  HostTransportError,
  type HostClient,
  type HostConnectionState,
  type HostConnectionStateSource,
  type HostTransportErrorCode,
  type SessionRef,
} from './types.ts'
