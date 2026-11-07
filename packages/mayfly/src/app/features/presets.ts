/** Native Agent preset selection through shared choice surfaces.
 * @module @ephemeral-ai/mayfly/app/features/presets
 */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { panel, ui, type MayflyListItem, type MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { mountInteractionLocale } from '../../interaction/locale.ts'
import { memoizedLocaleTranslator } from '../../frontend/locale.ts'
import type { HostClient, SessionRef } from '../../client/types.ts'
import type { RemoteFeatureContext } from './contracts.ts'
import { RemoteFeatureController, remoteErrorMessage, remoteValue } from './official.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import type { RemoteSettingsController } from './settings.ts'

/** Official preset roster projected from the generated Client method. */
type RemoteAgentPresetRoster = Awaited<ReturnType<HostClient['remote']['agentPresets']['list']>> extends RemoteResult<infer Value> ? Value : never
/** Official read-only preset composition document. */
type RemoteAgentPresetDocument = Awaited<ReturnType<HostClient['remote']['agentPresets']['read']>> extends RemoteResult<infer Value> ? Value : never

/** Read an agentPreset projection without trusting its unknown value. */
export function remoteAgentPresetSelection(value: unknown): string | null | undefined { return value === null || typeof value === 'string' ? value : undefined }

/** Agent preset controller for one feature mount. */
export class RemoteAgentPresetsController extends RemoteFeatureController {
  private readonly translate: MayflyTranslate
  constructor(context: RemoteFeatureContext, private readonly settings: RemoteSettingsController) {
    super(context)
    mountInteractionLocale(context.ctx)
    this.translate = memoizedLocaleTranslator(context.ctx, 'interaction').translate
  }

  /** List the current Host roster. */
  async list(client: HostClient): Promise<RemoteAgentPresetRoster | undefined> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return undefined
    try { const roster = await remoteValue(client.remote.agentPresets.list()); return operation.valid() ? roster : undefined }
    finally { operation.dispose() }
  }

  /** Read one preset's declared composition without starting an Agent. */
  async read(client: HostClient, id: string): Promise<RemoteAgentPresetDocument | undefined> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return undefined
    try { const document = await remoteValue(client.remote.agentPresets.read(id)); return operation.valid() ? document : undefined }
    finally { operation.dispose() }
  }

  /** Open the exact filterable preset roster, including the Session-independent default. */
  async open(parent?: AbortSignal): Promise<void> {
    if (parent?.aborted || this.context.ctx.mayflyOverlays.focus('mayfly.presets')) return
    const selection = this.context.hosts.current()
    const client = selection?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0]
    if (client === undefined) return
    const operation = selection === undefined ? this.hostOperation(client, parent) : this.sessionOperation(selection, parent)
    if (operation === undefined) return
    const t = this.translate
    try {
      const [initial, described] = await Promise.all([remoteValue(client.remote.agentPresets.list()), selection === undefined ? remoteValue(client.remote.settings.describe()) : undefined])
      if (!operation.valid()) { operation.dispose(); return }
      const descriptor = described?.namespaces.find(candidate => candidate.ns === 'agent-preset-registry')
      if (selection === undefined && descriptor === undefined) { operation.dispose(); return }
      let roster = initial
      let sequence = 0
      let mounted: RemoteBrowserPanel | undefined
      const current = () => selection === undefined ? roster.presets.find(preset => preset.isDefault)?.id : remoteAgentPresetSelection(selection.binding.session.projections.faceOf('agentPreset').getSnapshot())
      const view = () => {
        const composed = current()
        const items: MayflyListItem[] = roster.presets.map(preset => ({
          id: preset.id, label: preset.name ?? preset.id,
          ...preset.broken === undefined ? preset.description === undefined ? {} : { detail: preset.description } : { detail: preset.broken, disabled: true, disabledReason: preset.broken },
          ...preset.id === composed ? { current: true } : {},
        }))
        return panel({ title: t('Presets'), escapeLabel: 'close', body: ui.list({ id: 'presets', role: 'browse', filterable: true, filterMode: 'slash', selectedIds: typeof composed === 'string' ? [composed] : [], items, empty: ui.empty({ title: t('No presets composed') }) }),
          footer: ui.actions({ id: 'preset-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
        })
      }
      mounted = openRemoteBrowser(this.context, {
        id: 'mayfly.presets', scope: selection === undefined ? { kind: 'app', targetId: 'preset' } : { kind: 'session', sessionId: selection.ref.sessionId },
        signal: operation.signal, isCurrent: () => operation.valid(), view,
        action: async (event, context) => {
          if (!operation.valid() || context.signal.aborted) return { kind: 'cancelled' }
          if (event.kind === 'activate' && event.actionId === 'refresh') {
            const generation = ++sequence
            try {
              const next = await remoteValue(client.remote.agentPresets.list())
              if (!operation.valid() || context.signal.aborted || generation !== sequence) return { kind: 'cancelled' }
              roster = next; mounted?.refresh()
              return { kind: 'completed' }
            } catch (error) { return operation.valid() && !context.signal.aborted && generation === sequence ? { kind: 'failed', message: remoteErrorMessage(error) } : { kind: 'cancelled' } }
          }
          if (event.kind !== 'selection-accept' || event.controlId !== 'presets') return { kind: 'completed' }
          const id = event.selectedIds[0]
          const preset = roster.presets.find(preset => preset.id === id && preset.broken === undefined)
          if (preset === undefined) return { kind: 'failed', message: t('The preset is no longer available') }
          try {
            operation.assertWritable()
            let selected: string
            if (selection === undefined) {
              const revision = this.settings.revision(descriptor!, described!.writable)
              await this.settings.mutate(client, 'agent-preset-registry', [{ op: 'set', path: ['selectedDefault'], value: preset.id }], revision, context.signal)
              selected = preset.name ?? preset.id
            } else selected = await remoteValue(client.remote.agentPresets.select(selection.ref.sessionId, preset.id))
            if (!operation.valid() || context.signal.aborted) return { kind: 'cancelled' }
            this.context.notice.set(t(selection === undefined ? 'Default preset: {preset}' : 'Preset switched to {preset}', { preset: selected }), 'success')
            return { kind: 'accepted', node: view(), source: [], dismiss: true }
          } catch (error) {
            if (!operation.valid() || context.signal.aborted) return { kind: 'cancelled' }
            const message = remoteErrorMessage(error)
            this.context.notice.set(message, 'error')
            return { kind: 'failed', message }
          }
        },
        onClosed: () => operation.dispose(),
      })
      operation.onDispose(() => { mounted?.close() })
      if (selection !== undefined) {
        operation.onDispose(selection.binding.session.projections.faceOf('agentPreset').subscribe(() => { if (operation.valid()) mounted?.refresh() }))
        operation.onDispose(client.remote.$on('agent-preset/selected', sessionId => { if (operation.valid() && sessionId === selection.ref.sessionId) mounted?.refresh() }))
      }
    } catch (error) { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error), 'error'); operation.dispose() }
  }

  /** Select one exact Session preset through the official turn-boundary guard. */
  async select(ref: SessionRef, id: string): Promise<string | undefined> {
    const selection = this.context.hosts.current()
    if (selection === undefined || selection.ref.host !== ref.host || selection.ref.sessionId !== ref.sessionId) return undefined
    const operation = this.sessionOperation(selection)
    if (operation === undefined) return undefined
    try { operation.assertWritable(); const selected = await remoteValue(selection.client.remote.agentPresets.select(selection.ref.sessionId, id)); return operation.valid() ? selected : undefined }
    finally { operation.dispose() }
  }

  /** Read the full composition in a lifecycle-owned shared code surface. */
  async openDocument(client: HostClient, id: string): Promise<void> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      const document = await remoteValue(client.remote.agentPresets.read(id))
      if (!operation.valid()) { operation.dispose(); return }
      const mounted = openRemoteBrowser(this.context, {
        id: `mayfly.preset.${Buffer.from(id).toString('hex')}`, scope: { kind: 'app', targetId: 'preset' }, signal: operation.signal,
        isCurrent: () => operation.valid(), view: () => panel({ title: document.name ?? document.agentPreset, escapeLabel: 'close', body: ui.code(document.content, { language: 'yaml' }) }),
        onClosed: () => operation.dispose(),
      })
      operation.onDispose(() => { mounted.close() })
    } catch (error) { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error), 'error'); operation.dispose() }
  }
}
