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
import type { MayflySettingsDocument } from '@ephemeral-ai/mayfly-host/types'
import type { HostClient } from '../../client/types.ts'
import type { RemoteFeatureContext } from './contracts.ts'
import { onRemoteSettingsDocumentUpdated, RemoteCallError, RemoteFeatureController, remoteErrorMessage, remoteValue } from './official.ts'
import { openRemoteFeaturePanel, type RemoteMountedPanel, type RemotePanelModel } from './panel.ts'
import {
  remoteSettingsOperations,
  remoteSettingsProjection,
  remoteSettingsSecretPath,
  remoteSettingsWithoutSecrets,
  type RemoteSettingsChoices,
} from './settings-model.ts'

/** Host follow-up required before Mayfly preferences can persist through official settings. */
export const REMOTE_MAYFLY_SETTINGS_REQUIREMENT = 'mayfly-host must register the existing Mayfly settings schema under the "mayfly" namespace; Remote applies theme/locale locally and creates no competing settings store.'

/** Actual settings document read and compare-and-write through the Host settingsDocument DTO. */
export interface RemoteSettingsDocuments {
  readDocument(client: HostClient, parent?: AbortSignal): Promise<MayflySettingsDocument>
  writeDocument(client: HostClient, content: string, expectedRevision: string, parent?: AbortSignal): Promise<MayflySettingsDocument>
}

/** External editor hook the integration layer owns; undefined cancels the edit. */
export type RemoteSettingsEdit = (client: HostClient, content: string, signal: AbortSignal) => Promise<string | undefined>

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
/**
 * The document as panel rows. An empty document says so instead of showing a
 * blank row, and a long one ends with a count of what is not shown rather than
 * dropping the remainder silently - the external editor still owns the whole
 * text, so the panel must not imply that what it shows is all there is.
 * @param content - the document text.
 * @param t - the feature translator.
 * @returns the rows for the panel body.
 */
function documentContentRows(content: string, t: RemoteFeatureContext['t']): readonly { readonly text: string }[] {
  const lines = content.split('\n')
  const shown = lines.slice(0, 10).map(line => ({ text: line === '' ? ' ' : line }))
  if (content.trim() === '') return [{ text: t('The settings document is empty') }]
  if (lines.length <= 10) return shown
  return [...shown, { text: t('… {count} more lines; edit in an external editor to see them all', { count: lines.length - 10 }) }]
}

export class RemoteSettingsController extends RemoteFeatureController {
  constructor(
    context: RemoteFeatureContext,
    private readonly documents?: RemoteSettingsDocuments,
    private readonly edit?: RemoteSettingsEdit,
  ) { super(context) }

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

  /** Open the namespace roster, with the raw document entry when its DTO is composed. */
  async open(client = this.context.hosts.current()?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0]): Promise<void> {
    if (client === undefined) return
    try {
      const settings = await this.describe(client)
      if (settings === undefined) return
      let mounted: RemoteMountedPanel | undefined
      mounted = openRemoteFeaturePanel(this.context, {
        title: this.context.t('Settings'),
        subtitle: remoteMayflySettingsPersistence(settings) === 'available' ? undefined : REMOTE_MAYFLY_SETTINGS_REQUIREMENT,
        rows: [
          ...settings.namespaces.map((namespace: SettingsNamespaceView) => ({ id: namespace.ns, text: namespace.ns, detail: `revision ${namespace.revision}` })),
          ...this.documents === undefined ? [] : [{ id: '__document__', text: this.context.t('Settings document'), detail: this.context.t('View and edit the raw settings document') }],
        ],
        footer: settings.namespaces.length === 0 && this.documents === undefined ? this.context.t('No settings namespaces') : undefined,
      }, (action, ns) => {
        if (action !== 'accept' || ns === undefined) return
        mounted?.lease.close()
        if (ns === '__document__') { void this.openDocument(client); return }
        void this.openNamespace(client, ns)
      }, () => {})
    } catch (error) { this.context.notice.set(remoteErrorMessage(error)) }
  }

  /** Open the raw settings document; editing goes through the integration-owned editor. */
  async openDocument(client: HostClient): Promise<void> {
    const documents = this.documents
    const edit = this.edit
    if (documents === undefined) return
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      let document = await documents.readDocument(client, operation.signal)
      if (!operation.valid()) { operation.dispose(); return }
      let editing = false
      let mounted: RemoteMountedPanel | undefined
      const view = (): RemotePanelModel => ({
        title: this.context.t('Settings document'),
        subtitle: `${this.context.t('revision')} ${document.revision.slice(0, 12)}${document.writable ? '' : ` · ${this.context.t('read-only')}`}`,
        rows: [
          ...documentContentRows(document.content, this.context.t),
          { id: '__edit__', text: this.context.t('Edit in external editor'), disabled: !document.writable || editing },
        ],
        footer: editing ? this.context.t('Editing in the external editor…') : undefined,
        hint: 'Enter edit · Esc close',
      })
      const runEdit = async (): Promise<void> => {
        if (editing || !document.writable) return
        if (edit === undefined) { this.context.notice.set(this.context.t('No external editor is configured for the settings document')); return }
        editing = true
        mounted?.panel.update(view())
        try {
          const edited = await edit(client, document.content, operation.signal)
          if (!operation.valid() || edited === undefined || edited === document.content) return
          document = await documents.writeDocument(client, edited, document.revision, operation.signal)
          if (operation.valid()) this.context.notice.set(this.context.t('Settings document saved'))
        } catch (error) {
          if (operation.valid()) this.context.notice.set(settingsDocumentError(error, this.context.t))
        } finally {
          editing = false
          if (operation.valid()) mounted?.panel.update(view())
        }
      }
      mounted = openRemoteFeaturePanel(this.context, view(), (action, id) => {
        if (action === 'accept' && id === '__edit__') void runEdit()
      }, () => { operation.dispose() })
      const offSettings = onRemoteSettingsDocumentUpdated(client, () => {
        void (async () => {
          try {
            const next = await documents.readDocument(client, operation.signal)
            if (operation.valid() && !editing) {
              document = next
              mounted?.panel.update(view())
            }
          } catch { /* A newer revision still shows through the next explicit open. */ }
        })()
      })
      operation.onDispose(offSettings)
    } catch (error) {
      if (operation.valid()) this.context.notice.set(settingsDocumentError(error, this.context.t))
      operation.dispose()
    }
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

/** Present a settings-document failure, making compare-and-write conflicts actionable. */
function settingsDocumentError(error: unknown, t: (key: string) => string): string {
  if (error instanceof RemoteCallError && error.code === 'mayflyHost/settings-conflict') {
    return t('The settings document changed elsewhere (mayflyHost/settings-conflict); reopen it and review before saving')
  }
  return remoteErrorMessage(error)
}
