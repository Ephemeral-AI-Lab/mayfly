/**
 * Native permission preset catalog, projection, command switching, and
 * settings-backed defaults.
 * @module @ephemeral-ai/mayfly/remote/features/permissions
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient, SessionRef } from '../../client/types.ts'

/** Official permission catalog projected from the generated Client method. */
export type RemotePermissionCatalog = Awaited<ReturnType<HostClient['remote']['permissionPresets']['catalog']>> extends RemoteResult<infer Value> ? Value : never
import type { RemoteFeatureContext, RemoteFeatureSelection } from './contracts.ts'
import {
  RemoteFeatureController,
  RemoteFeatureOperation,
  remoteErrorMessage,
  remoteStringProjection,
  remoteValue,
} from './official.ts'
import { openRemoteFeaturePanel, type RemoteMountedPanel } from './panel.ts'
import type { RemoteSettingsController } from './settings.ts'

/** Resolved sandbox/approval details require the focused Host permissionCatalogDetails DTO. */
export const REMOTE_PERMISSION_DETAILS_GAP = 'Resolved permission sandbox/approval bundles require the Host permissionCatalogDetails DTO.'

/** Optional future Host-owned detail adapter; switching never depends on it. */
export interface RemotePermissionCatalogDetails {
  detail(value: string): string | undefined
}

/** Read the official permissions projection. */
export function remotePermissionSelection(value: unknown): string | undefined {
  return remoteStringProjection(value, 'currentValue')
}

/** Permission picker/controller for one feature mount. */
export class RemotePermissionsController extends RemoteFeatureController {
  constructor(
    context: RemoteFeatureContext,
    private readonly settings: RemoteSettingsController,
    private readonly details?: RemotePermissionCatalogDetails,
  ) {
    super(context)
  }

  /** Read the current process-level catalog. */
  async catalog(selection?: RemoteFeatureSelection): Promise<RemotePermissionCatalog | undefined> {
    const client = selection?.client ?? this.context.hosts.current()?.client ?? this.context.hosts.list()[0]
    if (client === undefined) return undefined
    const operation = this.hostOperation(client)
    if (operation === undefined) return undefined
    try {
      const catalog = await remoteValue(client.remote.permissionPresets.catalog())
      return operation.valid() ? catalog : undefined
    } finally { operation.dispose() }
  }

  /** Open Session switching, or default selection when no Session is active. */
  async open(): Promise<void> {
    const selection = this.context.hosts.current()
    if (selection === undefined) { await this.openDefault(); return }
    const operation = this.sessionOperation(selection)
    if (operation === undefined) return
    try {
      const initial = await remoteValue(selection.client.remote.permissionPresets.catalog())
      if (!operation.valid()) { operation.dispose(); return }
      this.mountSession(operation, selection, initial)
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
    }
  }

  /** Switch one exact Session through the native /permission command. */
  async select(ref: SessionRef, value: string): Promise<void> {
    const selection = this.context.hosts.current()
    if (selection === undefined || selection.ref.host !== ref.host || selection.ref.sessionId !== ref.sessionId) return
    const operation = this.sessionOperation(selection)
    if (operation === undefined) return
    try { await this.selectInOperation(operation, selection, value) }
    finally { operation.dispose() }
  }

  private async openDefault(): Promise<void> {
    const client = this.context.hosts.list()[0]
    if (client === undefined) return
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      const [catalog, settings] = await Promise.all([
        remoteValue(client.remote.permissionPresets.catalog()),
        remoteValue(client.remote.settings.describe()),
      ])
      const descriptor = settings.namespaces.find((candidate: import('@deepseek-ai/dsh-api-remotes/client').SettingsNamespaceView) => candidate.ns === 'permission')
      if (descriptor === undefined || !operation.valid()) { operation.dispose(); return }
      let mounted: RemoteMountedPanel | undefined
      mounted = openRemoteFeaturePanel(this.context, {
        title: this.context.t('Permissions'),
        subtitle: this.context.t('Default permission preset'),
        rows: catalog.defaultOptions.map((option: RemotePermissionCatalog['options'][number]) => ({
          id: option.value,
          text: option.name,
          detail: this.details?.detail(option.value) ?? option.description,
          current: option.value === catalog.defaultPreset,
        })),
      }, (action, value) => {
        if (action !== 'accept' || value === undefined || !catalog.defaultOptions.some((option: RemotePermissionCatalog['options'][number]) => option.value === value)) return
        void (async () => {
          const revision = this.settings.revision(descriptor, settings.writable)
          await this.settings.mutate(client, 'permission', [{ op: 'set', path: ['defaultPreset'], value }], revision)
          if (operation.valid()) {
            this.context.notice.set(this.context.t('Permission preset: {preset}', { preset: value }))
            mounted?.lease.close()
          }
        })().catch((error: unknown) => { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error)) })
      }, () => { operation.dispose() })
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
    }
  }

  private mountSession(operation: RemoteFeatureOperation, selection: RemoteFeatureSelection, initial: RemotePermissionCatalog): void {
    let catalog = initial
    let current = remotePermissionSelection(selection.binding.session.projections.faceOf('permissions').getSnapshot())
    let mounted: RemoteMountedPanel | undefined
    const view = () => ({
      title: this.context.t('Permissions'),
      rows: [
        ...catalog.options.map((option: RemotePermissionCatalog['options'][number]) => ({
          id: option.value,
          text: option.name,
          detail: this.details?.detail(option.value) ?? option.description,
          current: option.value === current,
        })),
        ...current === 'custom' ? [{ text: 'custom', detail: this.context.t('custom is the derived state — pick a preset'), current: true, disabled: true }] : [],
      ],
    })
    const refresh = async (): Promise<void> => {
      try {
        const next = await remoteValue(selection.client.remote.permissionPresets.catalog())
        if (!operation.valid() || mounted === undefined) return
        catalog = next
        mounted.panel.update(view())
      } catch (error) { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error)) }
    }
    mounted = openRemoteFeaturePanel(this.context, view(), (action, value) => {
      if (action === 'refresh') { void refresh(); return }
      if (action !== 'accept' || value === undefined || !catalog.options.some((option: RemotePermissionCatalog['options'][number]) => option.value === value)) return
      void this.selectInOperation(operation, selection, value).then(() => {
        if (!operation.valid()) return
        this.context.notice.set(this.context.t('Permission preset: {preset}', { preset: value }))
        mounted?.lease.close()
      }).catch((error: unknown) => { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error)) })
    }, () => { operation.dispose() })
    const offProjection = selection.binding.session.projections.faceOf('permissions').subscribe(() => {
      if (!operation.valid() || mounted === undefined) return
      current = remotePermissionSelection(selection.binding.session.projections.faceOf('permissions').getSnapshot())
      mounted.panel.update(view())
    })
    const offCatalog = selection.client.remote.$on('permission-presets/catalog-changed', () => { void refresh() })
    operation.onDispose(offProjection)
    operation.onDispose(offCatalog)
  }

  private async selectInOperation(
    operation: RemoteFeatureOperation,
    selection: RemoteFeatureSelection,
    value: string,
  ): Promise<void> {
    if (!operation.valid()) return
    const catalog = await remoteValue(selection.client.remote.permissionPresets.catalog())
    if (!catalog.options.some((option: RemotePermissionCatalog['options'][number]) => option.value === value)) throw new Error(this.context.t('permission command is unavailable'))
    const result = await selection.binding.session.command(`/permission ${value}`)
    if (!result.ok) throw new Error(result.error.message)
    if (!result.value.matched) throw new Error(this.context.t('permission command is unavailable'))
  }
}
