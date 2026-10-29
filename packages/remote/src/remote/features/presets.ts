/**
 * Agent preset roster, document reads, exact-Session selection events, and
 * settings-backed defaults.
 * @module @ephemeral-ai/mayfly/remote/features/presets
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient, SessionRef } from '../../client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from './contracts.ts'
import {
  RemoteFeatureController,
  RemoteFeatureOperation,
  remoteErrorMessage,
  remoteValue,
} from './official.ts'
import { openRemoteFeaturePanel, type RemoteMountedPanel } from './panel.ts'
import type { RemoteSettingsController } from './settings.ts'

/** Official preset roster projected from the generated Client method. */
export type RemoteAgentPresetRoster = Awaited<ReturnType<HostClient['remote']['agentPresets']['list']>> extends RemoteResult<infer Value> ? Value : never
/** Official read-only preset composition document. */
export type RemoteAgentPresetDocument = Awaited<ReturnType<HostClient['remote']['agentPresets']['read']>> extends RemoteResult<infer Value> ? Value : never

/** Read an agentPreset projection without trusting its unknown value. */
export function remoteAgentPresetSelection(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined
}

/** Agent preset controller for one feature mount. */
export class RemoteAgentPresetsController extends RemoteFeatureController {
  constructor(context: RemoteFeatureContext, private readonly settings: RemoteSettingsController) {
    super(context)
  }

  /** List the current Host roster. */
  async list(client: HostClient): Promise<RemoteAgentPresetRoster | undefined> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return undefined
    try {
      const roster = await remoteValue(client.remote.agentPresets.list())
      return operation.valid() ? roster : undefined
    } finally { operation.dispose() }
  }

  /** Read one preset's declared composition without starting an Agent. */
  async read(client: HostClient, id: string): Promise<RemoteAgentPresetDocument | undefined> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return undefined
    try {
      const document = await remoteValue(client.remote.agentPresets.read(id))
      return operation.valid() ? document : undefined
    } finally { operation.dispose() }
  }

  /** Open Session selection, or the next-Session default without a Session. */
  async open(): Promise<void> {
    const selection = this.context.hosts.current()
    if (selection === undefined) { await this.openDefault(); return }
    const operation = this.sessionOperation(selection)
    if (operation === undefined) return
    try {
      const roster = await remoteValue(selection.client.remote.agentPresets.list())
      if (!operation.valid()) { operation.dispose(); return }
      this.mountSession(operation, selection, roster)
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
    }
  }

  /** Select one exact Session preset through the official turn-boundary guard. */
  async select(ref: SessionRef, id: string): Promise<string | undefined> {
    const selection = this.context.hosts.current()
    if (selection === undefined || selection.ref.host !== ref.host || selection.ref.sessionId !== ref.sessionId) return undefined
    const operation = this.sessionOperation(selection)
    if (operation === undefined) return undefined
    try { return await this.selectInOperation(operation, selection, id) }
    finally { operation.dispose() }
  }

  /** Open a read-only composition document panel. */
  async openDocument(client: HostClient, id: string): Promise<void> {
    const document = await this.read(client, id)
    if (document === undefined) return
    openRemoteFeaturePanel(this.context, {
      title: document.name ?? document.agentPreset,
      rows: document.content.split('\n').map(text => ({ text: text || ' ' })),
    }, () => {}, () => {})
  }

  private async openDefault(): Promise<void> {
    const client = this.context.hosts.list()[0]
    if (client === undefined) return
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      const [roster, settings] = await Promise.all([
        remoteValue(client.remote.agentPresets.list()),
        remoteValue(client.remote.settings.describe()),
      ])
      const descriptor = settings.namespaces.find((candidate: import('@deepseek-ai/dsh-api-remotes/client').SettingsNamespaceView) => candidate.ns === 'agent-preset-registry')
      if (descriptor === undefined || !operation.valid()) { operation.dispose(); return }
      let mounted: RemoteMountedPanel | undefined
      mounted = openRemoteFeaturePanel(this.context, {
        title: this.context.t('Presets'),
        subtitle: this.context.t('Default agent preset'),
        rows: roster.presets.map((preset: RemoteAgentPresetRoster['presets'][number]) => ({
          id: preset.id,
          text: preset.name ?? preset.id,
          detail: preset.broken ?? preset.description,
          current: preset.isDefault,
          disabled: preset.broken !== undefined,
        })),
      }, (action, id) => {
        if (action === 'copy' && id !== undefined) { void this.openDocument(client, id); return }
        if (action !== 'accept' || id === undefined || !roster.presets.some((preset: RemoteAgentPresetRoster['presets'][number]) => preset.id === id && preset.broken === undefined)) return
        void (async () => {
          const revision = this.settings.revision(descriptor, settings.writable)
          await this.settings.mutate(client, 'agent-preset-registry', [{ op: 'set', path: ['selectedDefault'], value: id }], revision)
          if (operation.valid()) {
            this.context.notice.set(this.context.t('Default preset: {preset}', { preset: id }))
            mounted?.lease.close()
          }
        })().catch((error: unknown) => { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error)) })
      }, () => { operation.dispose() })
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
    }
  }

  private mountSession(operation: RemoteFeatureOperation, selection: RemoteFeatureSelection, roster: RemoteAgentPresetRoster): void {
    let current = remoteAgentPresetSelection(selection.binding.session.projections.faceOf('agentPreset').getSnapshot())
    let mounted: RemoteMountedPanel | undefined
    const view = () => ({
      title: this.context.t('Presets'),
      rows: roster.presets.map((preset: RemoteAgentPresetRoster['presets'][number]) => ({
        id: preset.id,
        text: preset.name ?? preset.id,
        detail: preset.broken ?? preset.description,
        current: preset.id === current,
        disabled: preset.broken !== undefined,
      })),
      hint: '↑↓ select · Enter choose · Ctrl+Y read · Esc close',
    })
    mounted = openRemoteFeaturePanel(this.context, view(), (action, id) => {
      if (action === 'copy' && id !== undefined) { void this.openDocument(selection.client, id); return }
      if (action !== 'accept' || id === undefined || !roster.presets.some((preset: RemoteAgentPresetRoster['presets'][number]) => preset.id === id && preset.broken === undefined)) return
      void this.selectInOperation(operation, selection, id).then(selected => {
        if (!operation.valid() || selected === undefined) return
        this.context.notice.set(this.context.t('Preset switched to {preset}', { preset: selected }))
        mounted?.lease.close()
      }).catch((error: unknown) => { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error)) })
    }, () => { operation.dispose() })
    const offProjection = selection.binding.session.projections.faceOf('agentPreset').subscribe(() => {
      if (!operation.valid() || mounted === undefined) return
      current = remoteAgentPresetSelection(selection.binding.session.projections.faceOf('agentPreset').getSnapshot())
      mounted.panel.update(view())
    })
    const offSelected = selection.client.remote.$on('agent-preset/selected', (sessionId, agentPreset) => {
      if (sessionId !== selection.ref.sessionId || !operation.valid() || mounted === undefined) return
      current = agentPreset
      mounted.panel.update(view())
    })
    operation.onDispose(offProjection)
    operation.onDispose(offSelected)
  }

  private async selectInOperation(
    operation: RemoteFeatureOperation,
    selection: RemoteFeatureSelection,
    id: string,
  ): Promise<string | undefined> {
    if (!operation.valid()) return undefined
    const selected = await remoteValue(selection.client.remote.agentPresets.select(selection.ref.sessionId, id))
    return operation.valid() ? selected : undefined
  }
}
