/**
 * Version and feature facts for the Mayfly Host protocol.
 *
 * @module @ephemeral-ai/mayfly-host/remote/capabilities
 */

import type { MayflyHostCapabilities } from '../types.ts'

/** Capabilities implemented by this Host package. */
export const MAYFLY_HOST_CAPABILITIES: MayflyHostCapabilities = Object.freeze({
  protocolVersion: 1,
  hostVersion: '0.1.4-rc.2',
  requiredDshVersion: '0.2.2-alpha.2',
  features: Object.freeze([
    'mayflyConversation', 'presentTools', 'followWorkflow', 'gitStatus', 'mcpCatalog', 'toolCatalog',
    'mayflySettings', 'skillCatalog', 'retractTurn', 'modelCatalogDetails', 'defaultModel', 'authorization',
    'permissionCatalogDetails', 'providerBalance', 'settingsDocument', 'subagentDrain', 'workspaceChanges',
    'workspacePath', 'mcpResources',
  ] as const),
})
