/**
 * Version and feature facts for the Mayfly Host protocol. The feature list is
 * computed per read from the live composition: transport health is advertised
 * only while the optional native MCP catalog face answers.
 *
 * @module @ephemeral-ai/mayfly-host/remote/capabilities
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyHostCapabilities, MayflyHostFeature } from '../types.ts'
import { mcpCatalogFace } from './mcp-catalog-face.ts'
import { hostVersion, requiredDshVersion } from './version.ts'

/** Features this Host package implements in every composition. */
const MAYFLY_HOST_BASE_FEATURES: readonly MayflyHostFeature[] = [
  'mayflyConversation', 'presentTools', 'followWorkflow', 'gitStatus', 'mcpCatalog', 'toolCatalog',
  'mayflySettings', 'skillCatalog', 'retractTurn', 'modelCatalogDetails', 'defaultModel', 'authorization',
  'permissionCatalogDetails', 'providerBalance', 'settingsDocument', 'subagentDrain', 'workspaceChanges',
  'workspacePath', 'mcpResources',
]

/**
 * The feature keys this Host composition currently implements, without state:
 * the base list plus `mcpTransportHealth` only when the native MCP catalog
 * face is installed and callable.
 * @param ctx - Host context whose optional services are probed.
 * @returns the current feature keys in stable order.
 */
export function mayflyHostFeatures(ctx: Context): readonly MayflyHostFeature[] {
  return mcpCatalogFace(ctx) === undefined
    ? MAYFLY_HOST_BASE_FEATURES
    : [...MAYFLY_HOST_BASE_FEATURES, 'mcpTransportHealth']
}

/**
 * The capabilities this Host composition currently implements, computed fresh
 * on every handshake read so a late service install is advertised without a
 * restart.
 * @param ctx - Host context whose optional services are probed.
 * @returns the immutable capabilities value.
 */
export function mayflyHostCapabilities(ctx: Context): MayflyHostCapabilities {
  return Object.freeze({
    protocolVersion: 1,
    hostVersion,
    requiredDshVersion,
    features: Object.freeze(mayflyHostFeatures(ctx)),
  })
}
