/**
 * `/preset` for the standalone frontend. The bare form forwards to the
 * configuration lane's existing `/presets` roster instead of mounting a second
 * copy of it; the by-name form resolves the roster the in-process TUI uses and
 * switches the exact Session, or — with no Session selected — stores the preset
 * a later blank Session takes. Switching is the native `agentPresets.select`
 * turn-boundary guard, never a local recompose.
 * @module @ephemeral-ai/mayfly/remote/operations/presets
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { HostClient } from '../../client/types.ts'
import { RemoteFeatureOperation, remoteErrorMessage, remoteValue } from '../features/official.ts'
import { registerRemoteOperationsLocale, type RemoteOperationsContext } from './support.ts'

/** The native registry's settings namespace; `selectedDefault` is the next Session's preset. */
const PRESET_SETTINGS_NS = 'agent-preset-registry'

const zh: Readonly<Record<string, string>> = {
  'List agent presets or switch (blank sessions; sets the default before one starts)':
    '列出 Agent 预设或切换（仅空会话；在会话开始前设置默认值）',
  'Preset browsing is unavailable in this build': '此构建无法浏览预设',
  'No Host is attached': '未连接 Host',
  'Unknown preset: {name}': '未知预设：{name}',
  'The preset cannot compose a session: {reason}': '该预设无法组合会话：{reason}',
  'The preset cannot compose a session': '该预设无法组合会话',
  'preset selection is unavailable': '预设选择不可用',
  'Default preset: {preset}': '默认预设：{preset}',
  'Preset switched to {preset}': '已切换到预设 {preset}',
}

class RemotePresetOperationsController {
  private readonly t: MayflyTranslate
  private disposed = false

  constructor(private readonly context: RemoteOperationsContext) {
    this.t = memoizedLocaleTranslator(context.base.ctx, 'remote-preset').translate
    registerRemoteOperationsLocale(context.base, 'remote-preset', zh)
  }

  readonly dispose = (): void => {
    this.disposed = true
  }

  readonly execute = async (rawInput: string, signal: AbortSignal): Promise<void> => {
    const name = rawInput.trim()
    if (signal.aborted || this.disposed) return
    if (name === '') {
      await this.openRoster(signal)
      return
    }
    await this.switchTo(name, signal)
  }

  /** Forward the listing to `/presets`, which already owns the roster panel. */
  private async openRoster(signal: AbortSignal): Promise<void> {
    if (this.context.base.hosts.current() === undefined && this.context.base.hosts.list().length === 0) {
      this.context.base.notice.set(this.t('No Host is attached'))
      return
    }
    try {
      const handled = await this.context.base.commands.execute('presets', '', signal)
      if (!handled && !this.disposed && !signal.aborted) {
        this.context.base.notice.set(this.t('Preset browsing is unavailable in this build'))
      }
    } catch (error) {
      if (!this.disposed && !signal.aborted) this.context.base.notice.set(remoteErrorMessage(error))
    }
  }

  private async switchTo(name: string, signal: AbortSignal): Promise<void> {
    const selection = this.context.base.hosts.current()
    const client = selection?.client ?? this.context.base.hosts.active?.() ?? this.context.base.hosts.list()[0]
    if (client === undefined) {
      this.context.base.notice.set(this.t('No Host is attached'))
      return
    }
    const operation = new RemoteFeatureOperation(this.context.base, client, selection, signal)
    try {
      const roster = await remoteValue(client.remote.agentPresets.list())
      if (!operation.valid() || this.disposed) return
      const needle = name.toLowerCase()
      const match = roster.presets.find(preset => preset.id.toLowerCase() === needle)
        ?? roster.presets.find(preset => preset.name?.toLowerCase() === needle)
      if (match === undefined) {
        this.context.base.notice.set(this.t('Unknown preset: {name}', { name }))
        return
      }
      if (match.broken !== undefined) {
        // An empty reason still means broken; reporting a trailing colon with
        // nothing after it tells the user nothing.
        const reason = match.broken.trim()
        this.context.base.notice.set(reason === ''
          ? this.t('The preset cannot compose a session')
          : this.t('The preset cannot compose a session: {reason}', { reason }))
        return
      }
      if (selection === undefined) {
        await this.setDefault(client, match.id, match.name ?? match.id, operation)
        return
      }
      // A replaced selection must never receive a preset chosen for the old one.
      if (!operation.valid()) return
      const selected = await remoteValue(client.remote.agentPresets.select(selection.ref.sessionId, match.id))
      if (!operation.valid() || this.disposed) return
      this.context.base.notice.set(this.t('Preset switched to {preset}', { preset: selected }))
    } catch (error) {
      if (!this.disposed && operation.valid()) this.context.base.notice.set(remoteErrorMessage(error))
    } finally { operation.dispose() }
  }

  /** Persist the preset a later blank Session takes, bound to the descriptor revision. */
  private async setDefault(client: HostClient, id: string, label: string, operation: RemoteFeatureOperation): Promise<void> {
    const settings = await remoteValue(client.remote.settings.describe())
    if (this.disposed || !operation.valid()) return
    const descriptor = settings.namespaces.find(candidate => candidate.ns === PRESET_SETTINGS_NS)
    if (descriptor === undefined || !settings.writable) {
      this.context.base.notice.set(this.t('preset selection is unavailable'))
      return
    }
    await remoteValue(client.remote.settings.mutate(
      PRESET_SETTINGS_NS,
      [{ op: 'set', path: ['selectedDefault'], value: id }],
      descriptor.revision,
    ))
    if (this.disposed || !operation.valid()) return
    this.context.base.notice.set(this.t('Default preset: {preset}', { preset: label }))
  }
}

/** Mount `/preset`: the `/presets` roster plus switching by name. */
export function mountRemotePresetOperations(context: RemoteOperationsContext): () => void {
  const controller = new RemotePresetOperationsController(context)
  const t = memoizedLocaleTranslator(context.base.ctx, 'remote-preset').translate
  const unregister = context.base.commands.register({
    name: 'preset', scope: 'sessionless',
    description: t('List agent presets or switch (blank sessions; sets the default before one starts)'),
    input: { hint: '[name]' },
    execute: controller.execute,
  })
  return () => {
    unregister()
    controller.dispose()
  }
}
