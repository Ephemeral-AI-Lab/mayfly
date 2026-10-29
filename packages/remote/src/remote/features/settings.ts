/**
 * Redacted settings namespaces and revision-checked official writes. Remote
 * does not own a competing preferences store.
 * @module @ephemeral-ai/mayfly/remote/features/settings
 */

import type {
  SettingsDescribeValue,
  SettingsNamespaceView,
  SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient } from '../../client/types.ts'
import type { RemoteFeatureContext } from './contracts.ts'
import { onRemoteSettingsDocumentUpdated, RemoteFeatureController, remoteErrorMessage, remoteValue } from './official.ts'
import { openRemoteFeaturePanel, type RemoteMountedPanel } from './panel.ts'
import {
  remoteSettingsOperations,
  remoteSettingsProjection,
  remoteSettingsSecretPath,
  remoteSettingsWithoutSecrets,
  type RemoteSettingsChoices,
} from './settings-model.ts'

/** Host follow-up required before Mayfly preferences can persist through official settings. */
export const REMOTE_MAYFLY_SETTINGS_REQUIREMENT = 'mayfly-host must register the existing Mayfly settings schema under the "mayfly" namespace; Remote applies theme/locale locally and creates no competing settings store.'
/** Exact local raw-document editing needs a read/content-revision/write DTO. */
export const REMOTE_SETTINGS_DOCUMENT_GAP = 'Exact local raw settings-document editing requires the Host settingsDocument content/revision DTO.'

type SettingsPatch = Parameters<HostClient['remote']['settings']['update']>[1]
type SettingsSection = Parameters<HostClient['remote']['settings']['replace']>[1]

/** Both revisions required by every settings write. */
export interface RemoteSettingsWriteRevision {
  readonly descriptor: number
  readonly fields: string
}

/** Availability of the follow-up Host-owned Mayfly schema. */
export function remoteMayflySettingsPersistence(settings: SettingsDescribeValue): 'available' | 'host-schema-required' {
  return settings.namespaces.some((namespace: SettingsNamespaceView) => namespace.ns === 'mayfly') ? 'available' : 'host-schema-required'
}

/** Settings controller and plain namespace forms. */
export class RemoteSettingsController extends RemoteFeatureController {
  constructor(context: RemoteFeatureContext) { super(context) }

  /** Read all redacted namespaces for one current Host generation. */
  async describe(client: HostClient): Promise<SettingsDescribeValue | undefined> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return undefined
    try {
      const settings = await remoteValue(client.remote.settings.describe())
      return operation.valid() ? settings : undefined
    } finally { operation.dispose() }
  }

  /** Merge non-secret fields with descriptor and projected-field revisions. */
  async update(client: HostClient, ns: string, patch: SettingsPatch, expected: RemoteSettingsWriteRevision): Promise<SettingsNamespaceView> {
    const operation = this.hostOperation(client)
    if (operation === undefined) throw new Error('Host is no longer attached')
    try {
      await this.assertRevision(client, ns, expected)
      return await remoteValue(client.remote.settings.update(ns, remoteSettingsWithoutSecrets(
        (await this.requireNamespace(client, ns)).schema,
        patch,
      ) as SettingsPatch, expected.descriptor))
    } finally { operation.dispose() }
  }

  /** Replace non-secret fields with descriptor and projected-field revisions. */
  async replace(client: HostClient, ns: string, section: SettingsSection, expected: RemoteSettingsWriteRevision): Promise<SettingsNamespaceView> {
    const operation = this.hostOperation(client)
    if (operation === undefined) throw new Error('Host is no longer attached')
    try {
      const descriptor = await this.assertRevision(client, ns, expected)
      return await remoteValue(client.remote.settings.replace(ns, remoteSettingsWithoutSecrets(descriptor.schema, section) as SettingsSection, expected.descriptor))
    } finally { operation.dispose() }
  }

  /** Apply path operations with both revisions and no secret values. */
  async mutate(client: HostClient, ns: string, ops: readonly SettingsPathOpView[], expected: RemoteSettingsWriteRevision): Promise<SettingsNamespaceView> {
    const operation = this.hostOperation(client)
    if (operation === undefined) throw new Error('Host is no longer attached')
    try {
      const descriptor = await this.assertRevision(client, ns, expected)
      for (const op of ops) {
        if (op.op === 'set' && remoteSettingsSecretPath(descriptor, op.path)) throw new Error('Use the provider credential controls for secret values')
      }
      return await remoteValue(client.remote.settings.mutate(ns, [...ops], expected.descriptor))
    } finally { operation.dispose() }
  }

  /** Return the revision pair a caller must carry into its next write. */
  revision(descriptor: SettingsNamespaceView, writable: boolean, choices: RemoteSettingsChoices = {}): RemoteSettingsWriteRevision {
    return { descriptor: descriptor.revision, fields: remoteSettingsProjection(descriptor, writable, choices, this.context.t).revision }
  }

  /** Open the namespace roster. */
  async open(client = this.context.hosts.current()?.client ?? this.context.hosts.list()[0]): Promise<void> {
    if (client === undefined) return
    try {
      const settings = await this.describe(client)
      if (settings === undefined) return
      let mounted: RemoteMountedPanel | undefined
      mounted = openRemoteFeaturePanel(this.context, {
        title: this.context.t('Settings'),
        subtitle: remoteMayflySettingsPersistence(settings) === 'available' ? undefined : REMOTE_MAYFLY_SETTINGS_REQUIREMENT,
        rows: settings.namespaces.map((namespace: SettingsNamespaceView) => ({ id: namespace.ns, text: namespace.ns, detail: `revision ${namespace.revision}` })),
        footer: settings.namespaces.length === 0 ? this.context.t('No settings namespaces') : undefined,
      }, (action, ns) => {
        if (action !== 'accept' || ns === undefined) return
        mounted?.lease.close()
        void this.openNamespace(client, ns)
      }, () => {})
    } catch (error) { this.context.notice.set(remoteErrorMessage(error)) }
  }

  /** Open one redacted namespace form; external changes mark it stale without overwriting drafts. */
  async openNamespace(client: HostClient, ns: string): Promise<void> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      const settings = await remoteValue(client.remote.settings.describe())
      const descriptor = settings.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === ns)
      if (descriptor === undefined || !operation.valid()) { operation.dispose(); return }
      let current = descriptor
      let choices = await this.loadChoices(client)
      let projection = remoteSettingsProjection(current, settings.writable, choices, this.context.t)
      let stale = false
      let mounted: RemoteMountedPanel | undefined
      const view = () => ({
        title: `${this.context.t('Settings')} · ${ns}`,
        subtitle: stale ? this.context.t('Settings changed elsewhere; review before saving') : `revision ${current.revision}`,
        fields: projection.fields.length === 0 ? undefined : projection.fields,
        rows: projection.fields.length === 0 ? projection.readonly.map(text => ({ text })) : undefined,
        footer: projection.fields.length === 0 ? undefined : projection.readonly.join('\n'),
        hint: 'Enter last field save · Esc close',
      })
      const save = async (values: Readonly<Record<string, string>>): Promise<void> => {
        if (stale) throw new Error(this.context.t('Settings changed elsewhere; review before saving'))
        const changes = projection.fields.flatMap(field => {
          const initial = field.value ?? ''
          const value = values[field.id] ?? ''
          return value === initial ? [] : [{ id: field.id, change: 'set' as const, value }]
        })
        const operations = remoteSettingsOperations(projection, changes)
        if (operations.length === 0) { mounted?.lease.close(); return }
        const latest = await remoteValue(client.remote.settings.describe())
        const latestDescriptor = latest.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === ns)
        if (latestDescriptor === undefined) throw new Error(this.context.t('Settings changed elsewhere; review before saving'))
        const latestChoices = await this.loadChoices(client)
        const latestProjection = remoteSettingsProjection(latestDescriptor, latest.writable, latestChoices, this.context.t)
        if (latestDescriptor.revision !== current.revision || latestProjection.revision !== projection.revision) {
          throw new Error(this.context.t('Settings changed elsewhere; review before saving'))
        }
        const updated = await remoteValue(client.remote.settings.mutate(ns, operations, current.revision))
        if (!operation.valid()) return
        current = updated
        choices = latestChoices
        projection = remoteSettingsProjection(current, latest.writable, choices, this.context.t)
        this.context.notice.set(this.context.t('Settings saved'))
        mounted?.lease.close()
      }
      mounted = openRemoteFeaturePanel(this.context, view(), (action, _id, values) => {
        if (action === 'submit') void save(values).catch((error: unknown) => {
          if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
        })
        else if (action === 'refresh') {
          stale = true
          mounted?.panel.update(view())
          this.context.notice.set(this.context.t('Settings changed elsewhere; review before saving'))
        }
      }, () => { operation.dispose() })
      const offSettings = onRemoteSettingsDocumentUpdated(client, (updated) => {
        if (String(updated) !== ns) return
        stale = true
        mounted?.panel.update(view())
      })
      const offLocale = this.context.subscribeLocale(() => {
        projection = remoteSettingsProjection(current, settings.writable, choices, this.context.t)
        mounted?.panel.update(view())
      })
      operation.onDispose(offSettings)
      operation.onDispose(offLocale)
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
    }
  }

  private async assertRevision(client: HostClient, ns: string, expected: RemoteSettingsWriteRevision): Promise<SettingsNamespaceView> {
    const descriptor = await this.requireNamespace(client, ns)
    const projection = remoteSettingsProjection(descriptor, true, {}, this.context.t)
    if (descriptor.revision !== expected.descriptor || projection.revision !== expected.fields) {
      throw new Error(this.context.t('Settings changed elsewhere; review before saving'))
    }
    return descriptor
  }

  private async requireNamespace(client: HostClient, ns: string): Promise<SettingsNamespaceView> {
    const settings = await remoteValue(client.remote.settings.describe())
    const descriptor = settings.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === ns)
    if (descriptor === undefined) throw new Error(ns === 'mayfly' ? REMOTE_MAYFLY_SETTINGS_REQUIREMENT : `Settings namespace "${ns}" is unavailable`)
    return descriptor
  }

  private async loadChoices(client: HostClient): Promise<RemoteSettingsChoices> {
    const [permissions, presets] = await Promise.allSettled([
      remoteValue(client.remote.permissionPresets.catalog()),
      remoteValue(client.remote.agentPresets.list()),
    ])
    return {
      ...permissions.status === 'fulfilled' ? { permission: permissions.value.options.map(option => option.value) } : {},
      ...presets.status === 'fulfilled' ? { agentPresets: presets.value.presets.filter(preset => preset.broken === undefined).map(preset => preset.id) } : {},
    }
  }
}
