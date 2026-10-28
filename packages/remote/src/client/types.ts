import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare const hostKeyBrand: unique symbol

/** Stable frontend-local identity for one configured dsh Host. */
export type HostKey = string & { readonly [hostKeyBrand]: true }

/** Validate a Host key supplied by a user or an endpoint record. */
export function HostKey(value: string): HostKey {
  if (value.trim().length === 0) throw new Error('Host key must not be empty')
  return value as HostKey
}

/** Session identity namespaced by its owning Host. */
export interface SessionRef {
  readonly host: HostKey
  readonly sessionId: SessionId
}

/** One independent HTTP/WebSocket Client and its official dsh object layer. */
export interface HostClient {
  readonly key: HostKey
  readonly connection: ConnectionHandle
  readonly remote: ClientRemote
  readonly sessions: ISessions
  readonly workspaces: IWorkspaces
  /** Release only this Client's resources; never stop the remote Agent or Host. */
  detach(): Promise<void>
}
