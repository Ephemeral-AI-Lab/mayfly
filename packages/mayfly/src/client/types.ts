import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { FileUploadService } from '@deepseek-ai/dsh-client-file-upload/client'
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

/** Stable transport failure categories safe to present without credentials. */
export type HostTransportErrorCode =
  | 'configuration'
  | 'authentication-required'
  | 'forbidden'
  | 'unavailable'
  | 'protocol'
  | 'detached'
  | 'superseded'

/** Redacted transport failure with an actionable category and message. */
export class HostTransportError extends Error {
  override readonly name = 'HostTransportError'

  /**
   * @param code - stable failure category for local recovery decisions.
   * @param message - actionable text containing no startup token or cookie.
   */
  constructor(readonly code: HostTransportErrorCode, message: string) {
    super(message)
  }
}

/** Immutable authentication and official Connection lifecycle snapshot. */
export type HostConnectionState =
  | { readonly status: 'connecting', readonly generation: number }
  | { readonly status: 'connected', readonly generation: number }
  | { readonly status: 'disconnected', readonly generation: number, readonly error: HostTransportError }
  | { readonly status: 'authentication-required', readonly generation: number, readonly error: HostTransportError }
  | { readonly status: 'failed', readonly generation: number, readonly error: HostTransportError }
  | { readonly status: 'detached', readonly generation: number }

/** Instance-owned subscription to one Host's connection state. */
export interface HostConnectionStateSource {
  /** Current immutable snapshot; its identity changes only with the state. */
  getSnapshot(): HostConnectionState
  /**
   * Subscribe to snapshot changes.
   * @param listener - called after a new snapshot is committed.
   * @returns listener removal; safe to call more than once.
   */
  subscribe(listener: () => void): () => void
}

/** One independent HTTP/WebSocket Client and its official dsh object layer. */
export interface HostClient {
  readonly key: HostKey
  readonly connection: ConnectionHandle
  readonly remote: ClientRemote
  readonly fileUpload: FileUploadService
  readonly sessions: ISessions
  readonly workspaces: IWorkspaces
  /** Configured origin (scheme/host/port) without token, path, or credentials. */
  readonly origin: string
  /** Redacted authentication and Connection state for frontend presentation. */
  readonly state: HostConnectionStateSource
  /** Release only this Client's resources; never stop the remote Agent or Host. */
  detach(): Promise<void>
}
