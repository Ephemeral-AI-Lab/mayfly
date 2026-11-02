/** Native permission preset catalog and shared decision-lane presentation.
 * @module @ephemeral-ai/mayfly/remote/features/permissions
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflyPermissionSpec } from '@ephemeral-ai/mayfly-host/types'
import { decisionLane, ui, type MayflyListItem, type MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { mountInteractionLocale } from '@ephemeral-ai/mayfly/editor-presentation'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { HostClient, SessionRef } from '../../client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from './contracts.ts'
import { RemoteFeatureController, RemoteFeatureOperation, remoteErrorMessage, remoteStringProjection, remoteValue } from './official.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import type { RemoteSettingsController } from './settings.ts'

/** Official permission catalog projected from the generated Client method. */
export type RemotePermissionCatalog = Awaited<ReturnType<HostClient['remote']['permissionPresets']['catalog']>> extends RemoteResult<infer Value> ? Value : never

/** Resolved native bundles; consequences follow facts rather than preset names. */
export interface RemotePermissionCatalogDetails {
  readonly yolo: boolean
  detail(value: string): string | undefined
  spec(value: string): MayflyPermissionSpec | undefined
}

/** Per-Host resolved detail source; a Host without the DTO contributes none. */
export interface RemotePermissionDetailSource {
  resolve(client: HostClient, currentPreset?: string, parent?: AbortSignal): Promise<RemotePermissionCatalogDetails | undefined>
}

/** Read the official permissions projection. */
export function remotePermissionSelection(value: unknown): string | undefined {
  return remoteStringProjection(value, 'currentValue')
}

/** Permission picker/controller for one feature mount. */
export class RemotePermissionsController extends RemoteFeatureController {
  private readonly translate: MayflyTranslate
  constructor(
    context: RemoteFeatureContext,
    private readonly settings: RemoteSettingsController,
    private readonly source?: RemotePermissionDetailSource,
  ) {
    super(context)
    mountInteractionLocale(context.ctx)
    this.translate = memoizedLocaleTranslator(context.ctx, 'interaction').translate
  }

  /** Read the current process-level catalog. */
  async catalog(selection?: RemoteFeatureSelection): Promise<RemotePermissionCatalog | undefined> {
    const client = selection?.client ?? this.context.hosts.current()?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0]
    if (client === undefined) return undefined
    const operation = this.hostOperation(client)
    if (operation === undefined) return undefined
    try {
      const catalog = await remoteValue(client.remote.permissionPresets.catalog())
      return operation.valid() ? catalog : undefined
    } finally { operation.dispose() }
  }

  /** Open Session switching, or default selection when no Session is active. */
  async open(parent?: AbortSignal): Promise<void> {
    if (parent?.aborted) return
    const selection = this.context.hosts.current()
    const client = selection?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0]
    if (client === undefined) return
    const operation = selection === undefined ? this.hostOperation(client, parent) : this.sessionOperation(selection, parent)
    if (operation === undefined) return
    try {
      const current = selection === undefined ? undefined : remotePermissionSelection(selection.binding.session.projections.faceOf('permissions').getSnapshot())
      const [catalog, details, settings] = await Promise.all([
        remoteValue(client.remote.permissionPresets.catalog()),
        this.loadDetails(operation, client, current),
        selection === undefined ? remoteValue(client.remote.settings.describe()) : undefined,
      ])
      if (!operation.valid()) { operation.dispose(); return }
      if (selection === undefined) {
        const descriptor = settings?.namespaces.find(candidate => candidate.ns === 'permission')
        if (descriptor === undefined || settings === undefined) { operation.dispose(); return }
        this.mount(operation, catalog, details, catalog.defaultPreset, catalog.defaultOptions, async (value, signal) => {
          const revision = this.settings.revision(descriptor, settings.writable)
          await this.settings.mutate(client, 'permission', [{ op: 'set', path: ['defaultPreset'], value }], revision, signal)
        })
      } else {
        this.mount(operation, catalog, details, current, catalog.options,
          async (value, signal) => { await this.selectInOperation(operation, selection, value, signal) }, selection)
      }
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
    }
  }

  /** Switch one exact Session through the native /permission command. */
  async select(ref: SessionRef, value: string, parent?: AbortSignal): Promise<void> {
    if (parent?.aborted) return
    const selection = this.context.hosts.current()
    if (selection === undefined || selection.ref.host !== ref.host || selection.ref.sessionId !== ref.sessionId) return
    const operation = this.sessionOperation(selection, parent)
    if (operation === undefined) return
    try { await this.selectInOperation(operation, selection, value) }
    finally { operation.dispose() }
  }

  private async loadDetails(operation: RemoteFeatureOperation, client: HostClient, currentPreset: string | undefined): Promise<RemotePermissionCatalogDetails | undefined> {
    if (this.source === undefined) return undefined
    try { return await this.source.resolve(client, currentPreset, operation.signal) }
    catch { return undefined }
  }

  private mount(
    operation: RemoteFeatureOperation,
    initialCatalog: RemotePermissionCatalog,
    initialDetails: RemotePermissionCatalogDetails | undefined,
    initialCurrent: string | undefined,
    initialOptions: RemotePermissionCatalog['options'],
    select: (value: string, signal: AbortSignal) => Promise<void>,
    selection?: RemoteFeatureSelection,
  ): void {
    let catalog = initialCatalog
    let details = initialDetails
    let current = initialCurrent
    let options = initialOptions
    let readSequence = 0
    let mounted: RemoteBrowserPanel | undefined
    const t = this.translate
    const view = () => {
      const items: MayflyListItem[] = options.map(option => {
        const spec = details?.spec(option.value)
        const detail = details?.detail(option.value)
        return {
          id: option.value, label: option.name,
          ...detail === undefined ? {} : { detail },
          ...option.value === current ? { current: true } : {},
          ...spec?.sandbox === 'danger-full-access' ? { confirm: {
            title: t('Enable {preset}?', { preset: option.name }),
            detail: t(spec.approval === 'never'
              ? 'Disable the file sandbox. Requests that still require approval will be rejected without prompting.'
              : 'Disable the file sandbox. Requests that require approval will still prompt.'),
            confirmLabel: t('Enable'), tone: 'danger' as const,
          } } : {},
        }
      })
      if (current === 'custom') items.push({ id: 'custom', label: 'Custom', disabled: true, disabledReason: t('custom is the derived state — pick a preset') })
      return decisionLane({ id: 'permissions', title: t('Permissions'), escapeLabel: 'close', body: ui.list({
        id: 'permissions', role: 'choose', numbered: true, selectedIds: current === undefined || current === 'custom' ? [] : [current], items,
      }) })
    }
    const refresh = async (): Promise<void> => {
      const sequence = ++readSequence
      try {
        const [next, nextDetails] = await Promise.all([
          remoteValue(operation.client.remote.permissionPresets.catalog()),
          this.loadDetails(operation, operation.client, current),
        ])
        if (!operation.valid() || mounted?.closed !== false || sequence !== readSequence) return
        catalog = next
        details = nextDetails
        options = selection === undefined ? catalog.defaultOptions : catalog.options
        if (selection === undefined) current = catalog.defaultPreset
        mounted.refresh()
      } catch (error) { if (operation.valid() && sequence === readSequence) this.context.notice.set(remoteErrorMessage(error)) }
    }
    mounted = openRemoteBrowser(this.context, {
      id: 'mayfly.permission', scope: { kind: 'app', targetId: 'permission' }, signal: operation.signal,
      isCurrent: () => operation.valid(), view,
      action: async (event, context) => {
        if (event.kind !== 'selection-accept' || event.controlId !== 'permissions') return { kind: 'completed' }
        const value = event.selectedIds[0]
        if (value === undefined || !options.some(option => option.value === value)) return { kind: 'completed' }
        if (context.signal.aborted || !operation.valid()) return { kind: 'cancelled', dismiss: true }
        try {
          await select(value, context.signal)
          if (context.signal.aborted || !operation.valid()) return { kind: 'cancelled', dismiss: true }
          this.context.notice.set(t('Permission preset: {preset}', { preset: options.find(option => option.value === value)!.name }))
          return { kind: 'completed', dismiss: true }
        } catch (error) { return operation.valid() ? { kind: 'failed', message: remoteErrorMessage(error) } : { kind: 'cancelled', dismiss: true } }
      },
      onClosed: () => operation.dispose(),
    })
    operation.onDispose(() => { mounted?.close() })
    if (selection !== undefined) operation.onDispose(selection.binding.session.projections.faceOf('permissions').subscribe(() => {
      if (!operation.valid() || mounted?.closed !== false) return
      current = remotePermissionSelection(selection.binding.session.projections.faceOf('permissions').getSnapshot())
      mounted.refresh()
    }))
    operation.onDispose(operation.client.remote.$on('permission-presets/catalog-changed', () => { void refresh() }))
  }

  private async selectInOperation(operation: RemoteFeatureOperation, selection: RemoteFeatureSelection, value: string, signal?: AbortSignal): Promise<void> {
    const catalog = await remoteValue(selection.client.remote.permissionPresets.catalog())
    if (!operation.valid() || signal?.aborted) return
    if (!catalog.options.some(option => option.value === value)) throw new Error(this.translate('permission command is unavailable'))
    const result = await selection.binding.session.command(`/permission ${value}`)
    if (!operation.valid()) return
    if (!result.ok) throw new Error(result.error.message)
    if (!result.value.matched) throw new Error(this.translate('permission command is unavailable'))
  }
}
