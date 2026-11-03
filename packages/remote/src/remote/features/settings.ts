/** Shared settings rail over native redacted descriptors and revisioned writes.
 * @module @ephemeral-ai/mayfly/remote/features/settings
 */

import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflySettingsDocument } from '@ephemeral-ai/mayfly-host/types'
import { settingsOperations, settingsProjection, type SettingsChoices, type SettingsProjection } from '@ephemeral-ai/mayfly/configuration-panels'
import { mountInteractionLocale } from '@ephemeral-ai/mayfly/editor-presentation'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import { panel, rail, ui, type MayflySourceStamp, type MayflyTranslate, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { HostClient } from '../../client/types.ts'
import type { RemoteFeatureContext } from './contracts.ts'
import { onRemoteSettingsDocumentUpdated, RemoteCallError, RemoteFeatureController, type RemoteFeatureOperation, remoteErrorMessage, remoteValue } from './official.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import { remoteSettingsSecretPath, remoteSettingsWithoutSecrets } from './settings-model.ts'

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
type SharedDescriptor = Parameters<typeof settingsProjection>[0]
const ROOT_ID = 'mayfly.settings'
const RAIL_ID = 'namespaces'

/** Both revisions required by every settings write. */
export interface RemoteSettingsWriteRevision {
  readonly descriptor: number
  readonly fields: string
}

interface SettingsEntry { readonly ns: string, readonly descriptor: SettingsNamespaceView, readonly projection: SettingsProjection }
interface SettingsSnapshot { readonly node: MayflyUiNode, readonly source: readonly MayflySourceStamp[], readonly entries: readonly SettingsEntry[] }

/** Availability of the Host-owned Mayfly schema. */
export function remoteMayflySettingsPersistence(settings: SettingsDescribeValue): 'available' | 'host-schema-required' {
  return settings.namespaces.some(namespace => namespace.ns === 'mayfly') ? 'available' : 'host-schema-required'
}

/** The native view is the serializable descriptor, with its namespace branding restored at the presentation boundary. */
function sharedDescriptor(descriptor: SettingsNamespaceView): SharedDescriptor {
  return { ...descriptor, ns: descriptor.ns as SharedDescriptor['ns'] }
}

/** One settings rail owner and revision-checked programmatic preference writes. */
export class RemoteSettingsController extends RemoteFeatureController {
  private readonly translate: MayflyTranslate
  private openSequence = 0
  private rail: { readonly client: HostClient, readonly operation: RemoteFeatureOperation, readonly panel: RemoteBrowserPanel } | undefined
  constructor(context: RemoteFeatureContext, private readonly documents?: RemoteSettingsDocuments, private readonly edit?: RemoteSettingsEdit) {
    super(context)
    mountInteractionLocale(context.ctx)
    this.translate = memoizedLocaleTranslator(context.ctx, 'interaction').translate
  }

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
      const descriptor = await this.assertRevision(client, ns, expected)
      if (!operation.valid()) throw new Error('Host is no longer attached')
      const saved = await remoteValue(client.remote.settings.update(ns, remoteSettingsWithoutSecrets(descriptor.schema, patch) as SettingsPatch, expected.descriptor))
      if (!operation.valid()) throw new Error('Host is no longer attached')
      return saved
    } finally { operation.dispose() }
  }

  /** Replace non-secret fields with descriptor and projected-field revisions. */
  async replace(client: HostClient, ns: string, section: SettingsSection, expected: RemoteSettingsWriteRevision): Promise<SettingsNamespaceView> {
    const operation = this.hostOperation(client)
    if (operation === undefined) throw new Error('Host is no longer attached')
    try {
      const descriptor = await this.assertRevision(client, ns, expected)
      if (!operation.valid()) throw new Error('Host is no longer attached')
      const saved = await remoteValue(client.remote.settings.replace(ns, remoteSettingsWithoutSecrets(descriptor.schema, section) as SettingsSection, expected.descriptor))
      if (!operation.valid()) throw new Error('Host is no longer attached')
      return saved
    } finally { operation.dispose() }
  }

  /** Apply programmatic non-secret path operations with both revisions. */
  async mutate(client: HostClient, ns: string, ops: readonly SettingsPathOpView[], expected: RemoteSettingsWriteRevision, parent?: AbortSignal): Promise<SettingsNamespaceView> {
    const operation = this.hostOperation(client, parent)
    if (operation === undefined) throw new Error('Host is no longer attached')
    try {
      const descriptor = await this.assertRevision(client, ns, expected)
      for (const op of ops) if (op.op === 'set' && remoteSettingsSecretPath(descriptor, op.path)) throw new Error('Use the provider credential controls for secret values')
      if (!operation.valid()) throw new Error('Host is no longer attached')
      const saved = await remoteValue(client.remote.settings.mutate(ns, [...ops], expected.descriptor))
      if (!operation.valid()) throw new Error('Host is no longer attached')
      return saved
    } finally { operation.dispose() }
  }

  /** Return the revision pair a caller must carry into its next write. */
  revision(descriptor: SettingsNamespaceView, writable: boolean, choices: SettingsChoices = {}): RemoteSettingsWriteRevision {
    return { descriptor: descriptor.revision, fields: settingsProjection(sharedDescriptor(descriptor), writable, choices, this.translate).revision }
  }

  /** Open the exact shared settings rail; repeated opens focus its existing forms. */
  async open(client = this.context.hosts.current()?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0], parent?: AbortSignal): Promise<void> {
    if (client !== undefined) await this.openRail(client, undefined, parent)
  }

  /** Focus the settings rail on a namespace without replacing unsaved drafts. */
  async openNamespace(client: HostClient, ns: string): Promise<void> { await this.openRail(client, ns) }

  /** Run the local editor directly, retaining the original Host document revision. */
  async openDocument(client: HostClient): Promise<void> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      const reply = await this.editDocument(client, operation, operation.signal)
      if (!operation.valid()) return
      if (reply.kind === 'failed' || reply.kind === 'conflict') this.context.notice.set(reply.message, 'error')
      else if ('feedback' in reply && reply.feedback !== undefined) this.context.notice.set(reply.feedback.message, reply.feedback.severity)
    } finally { operation.dispose() }
  }

  private async openRail(client: HostClient, initialNs?: string, parent?: AbortSignal): Promise<void> {
    if (parent?.aborted) return
    if (this.rail?.client === client && this.rail.operation.valid() && !this.rail.panel.closed) {
      this.context.ctx.mayflyOverlays.focus(ROOT_ID)
      if (initialNs !== undefined) this.context.ctx.get('mayflyUiInteraction')?.get('overlay', ROOT_ID)?.emit({ kind: 'tab-change', pagePath: [], controlId: RAIL_ID, tabId: initialNs })
      return
    }
    const sequence = ++this.openSequence
    const operation = this.hostOperation(client, parent)
    if (operation === undefined) return
    const t = this.translate
    try {
      const [initial, initialChoices] = await Promise.all([remoteValue(client.remote.settings.describe()), this.loadChoices(client)])
      if (!operation.valid() || sequence !== this.openSequence || initialNs !== undefined && !initial.namespaces.some(candidate => candidate.ns === initialNs)) { operation.dispose(); return }
      this.rail?.panel.close()
      let settings = initial
      let choices = initialChoices
      let active = initialNs ?? initial.namespaces[0]?.ns ?? ''
      let readSequence = 0
      let mounted: RemoteBrowserPanel | undefined
      const snapshot = (): SettingsSnapshot => {
        const entries = settings.namespaces.flatMap((descriptor): SettingsEntry[] => {
          const ns = descriptor.ns
          const projection = settingsProjection(sharedDescriptor(descriptor), settings.writable, choices, t, [{ controlId: RAIL_ID, itemId: ns }])
          return projection.bindings.size === 0 ? [] : [{ ns, descriptor, projection }]
        })
        if (!entries.some(entry => entry.ns === active)) active = entries[0]?.ns ?? ''
        return {
          node: panel({ title: t('Settings'), escapeLabel: 'close', body: entries.length === 0 ? ui.empty({ title: t('No settings namespaces') }) : rail({
            rail: { id: RAIL_ID, activeId: active, items: entries.map(entry => ({ id: entry.ns, label: entry.ns })) },
            pages: Object.fromEntries(entries.map(entry => [entry.ns, entry.projection.node])),
          }), footer: ui.actions({ id: 'settings-global-actions', items: [{
            id: 'open-file', label: t('Open settings.yaml in $EDITOR'), hintLabel: 'settings.yaml', semantic: 'external', hidden: true,
            disabled: !settings.writable || this.documents === undefined || this.edit === undefined,
          }] }) }),
          source: entries.flatMap(entry => [{ resourceId: `settings/${entry.ns}`, revision: entry.descriptor.revision }, { resourceId: `settings/${entry.ns}/fields`, revision: entry.projection.revision }]),
          entries,
        }
      }
      let current = snapshot()
      const read = async (): Promise<boolean> => {
        const sequence = ++readSequence
        const [next, dynamic] = await Promise.all([remoteValue(client.remote.settings.describe()), this.loadChoices(client)])
        if (!operation.valid() || sequence !== readSequence) return false
        settings = next
        choices = dynamic
        current = snapshot()
        return true
      }
      const refresh = async (): Promise<void> => {
        try { if (await read()) mounted?.refresh() }
        catch (error) { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error), 'error') }
      }
      mounted = openRemoteBrowser(this.context, {
        id: ROOT_ID, scope: { kind: 'app', targetId: 'settings' }, signal: operation.signal, isCurrent: () => operation.valid(), dismissal: 'confirm-dirty',
        view: () => current.node, source: () => current.source,
        observe: event => { if (event.kind === 'tab-change' && event.pagePath.length === 0 && event.controlId === RAIL_ID) active = event.tabId },
        action: async (event, context): Promise<MayflyUiActionReply> => {
          if (context.signal.aborted || !operation.valid()) return { kind: 'cancelled' }
          if (event.kind === 'activate' && event.actionId === 'refresh') { await refresh(); return { kind: 'completed' } }
          if (event.kind === 'activate' && event.actionId === 'open-file') {
            const reply = await this.editDocument(client, operation, context.signal)
            if (operation.valid() && !context.signal.aborted && 'feedback' in reply && reply.feedback !== undefined) await refresh()
            return reply
          }
          if (event.kind !== 'submit') return { kind: 'completed' }
          const form = event.submission.forms.find(candidate => candidate.formId === 'settings-form')
          const ns = form?.pagePath.find(segment => segment.controlId === RAIL_ID)?.itemId
          if (form === undefined || ns === undefined) return { kind: 'failed', message: t('Settings could not be saved') }
          try {
            if (!await read() || context.signal.aborted) return { kind: 'cancelled' }
            const entry = current.entries.find(candidate => candidate.ns === ns)
            if (entry === undefined) return { kind: 'cancelled', dismiss: true }
            const expected = event.submission.source.find(stamp => stamp.resourceId === `settings/${ns}`)?.revision
            const expectedFields = event.submission.source.find(stamp => stamp.resourceId === `settings/${ns}/fields`)?.revision
            if (expected !== entry.descriptor.revision || expectedFields !== entry.projection.revision) return { kind: 'conflict', node: current.node, source: current.source, message: t('Settings changed elsewhere; review before saving') }
            const operations = settingsOperations(entry.projection, form)
            if (operations.length > 0) {
              const saved = await remoteValue(client.remote.settings.mutate(ns, operations.map(op => op.op === 'set' ? { ...op, path: [...op.path], value: op.value as Extract<SettingsPathOpView, { op: 'set' }>['value'] } : { ...op, path: [...op.path] }), entry.descriptor.revision))
              if (!operation.valid() || context.signal.aborted) return { kind: 'cancelled' }
              settings = { ...settings, namespaces: settings.namespaces.map(descriptor => descriptor.ns === ns ? saved : descriptor) }
              current = snapshot()
            }
            return { kind: 'accepted', node: current.node, source: current.source, feedback: { severity: 'success', message: t('Settings saved') } }
          } catch (error) {
            if (!operation.valid() || context.signal.aborted) return { kind: 'cancelled' }
            if (error instanceof RemoteCallError && error.code === 'settings/conflict') {
              try { await read() } catch { /* Preserve the latest safe snapshot if the follow-up read fails. */ }
              if (!operation.valid() || context.signal.aborted) return { kind: 'cancelled' }
              return { kind: 'conflict', node: current.node, source: current.source, message: t('Settings changed elsewhere; review before saving') }
            }
            return { kind: 'failed', node: current.node, source: current.source, message: t('Settings could not be saved') }
          }
        },
        onClosed: () => { if (this.rail?.operation === operation) this.rail = undefined; operation.dispose() },
      })
      if (mounted.closed) { operation.dispose(); return }
      this.rail = { client, operation, panel: mounted }
      operation.onDispose(() => { mounted?.close() })
      operation.onDispose(this.context.subscribeLocale(() => { current = snapshot(); mounted?.refresh() }))
      operation.onDispose(onRemoteSettingsDocumentUpdated(client, () => { void refresh() }))
      operation.onDispose(client.remote.$on('permission-presets/catalog-changed', () => { void refresh() }))
    } catch (error) { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error), 'error'); operation.dispose() }
  }

  private async editDocument(client: HostClient, operation: RemoteFeatureOperation, callerSignal: AbortSignal): Promise<MayflyUiActionReply> {
    const t = this.translate
    if (this.documents === undefined) return { kind: 'failed', message: t('settings file unavailable') }
    if (this.edit === undefined) return { kind: 'failed', message: t('no editor configured ($VISUAL/$EDITOR)') }
    const signal = AbortSignal.any([operation.signal, callerSignal])
    try {
      const document = await this.documents.readDocument(client, signal)
      if (signal.aborted || !operation.valid()) return { kind: 'cancelled' }
      if (!document.writable) return { kind: 'failed', message: t('Settings are read-only') }
      const edited = await this.edit(client, document.content, signal)
      if (signal.aborted || !operation.valid()) return { kind: 'cancelled' }
      if (edited === undefined || edited === document.content) return { kind: 'completed' }
      await this.documents.writeDocument(client, edited, document.revision, signal)
      return signal.aborted || !operation.valid() ? { kind: 'cancelled' } : { kind: 'completed', feedback: { severity: 'success', message: t('Settings file saved') } }
    } catch (error) {
      if (signal.aborted || !operation.valid()) return { kind: 'cancelled' }
      return { kind: 'failed', message: error instanceof RemoteCallError && error.code === 'mayflyHost/settings-conflict'
        ? t('The settings file changed while the editor was open') : t('Settings file could not be edited') }
    }
  }

  private async assertRevision(client: HostClient, ns: string, expected: RemoteSettingsWriteRevision): Promise<SettingsNamespaceView> {
    const settings = await remoteValue(client.remote.settings.describe())
    const descriptor = settings.namespaces.find(candidate => candidate.ns === ns)
    if (descriptor === undefined) throw new Error(ns === 'mayfly' ? REMOTE_MAYFLY_SETTINGS_REQUIREMENT : `Settings namespace "${ns}" is unavailable`)
    const projection = settingsProjection(sharedDescriptor(descriptor), settings.writable, {}, this.translate)
    if (descriptor.revision !== expected.descriptor || projection.revision !== expected.fields) throw new Error(this.translate('Settings changed elsewhere; review before saving'))
    return descriptor
  }

  private async loadChoices(client: HostClient): Promise<SettingsChoices> {
    const [permissions, presets] = await Promise.allSettled([remoteValue(client.remote.permissionPresets.catalog()), remoteValue(client.remote.agentPresets.list())])
    return {
      ...permissions.status === 'fulfilled' ? { permission: permissions.value.options.map(option => option.value) } : {},
      ...presets.status === 'fulfilled' ? { agentPresets: presets.value.presets.filter(preset => preset.broken === undefined).map(preset => preset.id) } : {},
    }
  }
}
