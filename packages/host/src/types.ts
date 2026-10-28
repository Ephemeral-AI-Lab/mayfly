/**
 * Client-safe DTOs and Remote errors for the Mayfly Host capability.
 *
 * @module @ephemeral-ai/mayfly-host/types
 */

import type {} from '@deepseek-ai/dsh-typert-protocol'

export type * from './conversation/types.ts'

/** Mayfly Host features advertised by the capabilities handshake. */
export type MayflyHostFeature = 'mayflyConversation'

/** Version and feature facts a Client validates before entering its UI. */
export interface MayflyHostCapabilities {
  readonly protocolVersion: number
  readonly hostVersion: string
  readonly requiredDshVersion: string
  readonly features: readonly MayflyHostFeature[]
}

/** Details of a requested feature absent from this Host composition. */
export interface MayflyHostCapabilityUnavailableDetails {
  readonly feature: string
}

/** Mayfly Host domain failures carried by the standard Remote error union. */
export type MayflyHostErrorCode = 'mayflyHost/capability-unavailable'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A requested Mayfly feature is not available in this Host composition. */
    'mayflyHost/capability-unavailable': MayflyHostCapabilityUnavailableDetails
  }
}
