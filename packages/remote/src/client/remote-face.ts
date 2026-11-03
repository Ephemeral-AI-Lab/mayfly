/**
 * Type-only single point for the official Client Remote faces consumed by
 * Remote feature lanes. The api-remotes client entry re-exports these faces
 * from its own node_modules, where the sibling packages do not resolve, so a
 * consumer compilation must import each generated face itself; this module is
 * that single import, and it doubles as the compile-time probe that the faces
 * exist at the pinned dsh version.
 * @module @ephemeral-ai/mayfly/client/remote-face
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-account-controller/remote'
import type {} from '@deepseek-ai/dsh-api-account-controller/types'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import type {} from '@deepseek-ai/dsh-api-settings-controller/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/remote'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {} from '@deepseek-ai/dsh-permission-presets/remote'
import type {} from '@deepseek-ai/dsh-permission-presets/types'
import type {} from '@deepseek-ai/dsh-plugin-manager/remote'
import type {} from '@deepseek-ai/dsh-plugin-manager/types'
import type {} from '@deepseek-ai/dsh-plugin-market/remote'
import type {} from '@deepseek-ai/dsh-plugin-market/types'
import type {} from '@deepseek-ai/dsh-schedule/remote'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'

export type { RemoteStreamHandle }
export type {
  BundleDetail, BundleInfo, BundleRowInfo, ChangeResult, InspectOptions, InstallBundleOptions, InstallSpecKind,
  ManagementError, PackageResult,
  PluginChange, PluginEntryId, PluginInfo, PluginInspectProblem, PluginInstallCancellation, PluginInstallFailureKind,
  PluginInstallLogChunk, PluginInstallProgress, PluginInstallRequestId, PluginRegistries, PluginSpecInspection,
  PluginUpdateProgress, PluginUpdateResult, PluginUpdateStep, PluginVersion, PluginVersionList, RegistryAttempt,
  ReadOnlyReason, Registry, RestartReason,
} from '@deepseek-ai/dsh-plugin-manager/types'
export type {
  MarketCompatibility, MarketIndexSummary, MarketInstallation, MarketInstallationStatus, MarketListingEntry,
  MarketListingVersion, MarketQuery, MarketSearchResult, MarketSort, PluginDetail, PluginDetailDocumentId,
  PluginDetailOrigin,
} from '@deepseek-ai/dsh-plugin-market/types'

/** Official plugin-manager namespace mounted by the api-remotes client handoff. */
export type ClientPluginManager = ClientRemote['pluginManager']
/** Official plugin-market namespace mounted by the api-remotes client handoff. */
export type ClientPluginMarket = ClientRemote['pluginMarket']
