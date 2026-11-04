/**
 * Client-safe Host DTOs and the generated Mayfly namespace consumer.
 * The Host package owns all wire data definitions.
 * @module @ephemeral-ai/mayfly/frontend/host-contract
 */
import type * as Host from '@ephemeral-ai/mayfly-host/types'
import type {} from '@ephemeral-ai/mayfly-host/remote'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'

export type * from '@ephemeral-ai/mayfly-host/types'

/** Complete namespace derived from the generated Host artifact. */
export type MayflyHostRemote = TypertRemoteNamespaceMap['mayflyHost']

/** Discriminated views of the authoritative workflow wire frame. */
export type MayflyWorkflowBaselineFrame = Extract<Host.MayflyWorkflowFrame, { readonly type: 'baseline' }>
export type MayflyWorkflowReplacementFrame = Extract<Host.MayflyWorkflowFrame, { readonly type: 'replacement' }>

/** Consumer views derived from authoritative Host result payloads. */
export type MayflyAuthorizationNotice = Extract<Host.MayflyAuthorizationFrame, { readonly type: 'notice' }>['notice']
export type MayflyWorkspaceChangesSummary = NonNullable<Host.MayflyWorkspaceChangesSummaryResult>
export type MayflyWorkspaceFileDiff = NonNullable<Host.MayflyWorkspaceFileDiffResult>
