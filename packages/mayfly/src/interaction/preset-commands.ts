/** Native Agent preset selection through frontend-owned shared choice surfaces.
 * @module @ephemeral-ai/mayfly/interaction/preset-commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-commands'
import { ui, type MayflyListItem, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'
import { createInteractionNotificationOwner } from './notifications.ts'

export const name = 'mayfly-preset-command'
export const inject = ['commands', 'agentPresets', 'mayflyCurrentAgent', 'mayflyOverlays']
const ID = 'mayfly.presets'

export function presetItems(presets: readonly AgentPreset[], current: string | undefined, t: MayflyTranslate): readonly MayflyListItem[] {
  return presets.toSorted((left, right) => (left.order ?? Infinity) - (right.order ?? Infinity) || left.id.localeCompare(right.id)).map(preset => ({
    id: preset.id, label: preset.name ?? preset.id,
    ...preset.broken === undefined ? preset.description === undefined ? {} : { detail: preset.description } : { detail: preset.broken, disabled: true, disabledReason: preset.broken },
    ...preset.id === current ? { badge: t('current') } : {},
  }))
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const roster = ctx.agentPresets
  const t = interactionTranslator(ctx)
  const notifications = createInteractionNotificationOwner(ctx, 'mayfly.preset', 'preset')
  const current = (agent: Agent) => !lifetime.signal.aborted && ctx.mayflyCurrentAgent.current() === agent
  const select = async (agent: Agent, id: string, signal: AbortSignal) => {
    if (signal.aborted || !current(agent)) throw new Error(t('The active Agent changed before the preset switch'))
    if (agent.status !== 'idle') throw new Error(t('cannot switch presets while the agent is running'))
    return roster.select(agent, id)
  }
  ctx.commands.register({
    name: 'preset', description: t('List agent presets or switch (blank sessions only)'), input: { hint: '[name]' },
    handler: async invocation => {
      const agent = invocation.agent
      const signal = AbortSignal.any([invocation.signal, lifetime.signal])
      if (signal.aborted) return { kind: 'success' }
      if (!current(agent)) return { kind: 'error', text: t('no session is live yet') }
      const id = invocation.rawInput.trim()
      try {
        if (id !== '') {
          const selected = await select(agent, id, signal)
          return signal.aborted || !current(agent) ? { kind: 'success' } : { kind: 'success', text: `preset ${selected}` }
        }
        if (ctx.mayflyOverlays.focus(ID)) return { kind: 'success' }
        let catalog = await roster.list()
        if (signal.aborted || !current(agent)) return { kind: 'success' }
        if (ctx.mayflyOverlays.focus(ID)) return { kind: 'success' }
        const view = (): MayflyUiNode => {
          const composed = roster.composedPreset(agent.ctx)
          return ui.surface({ title: t('Presets'), chrome: 'overlay', padding: 1, child: ui.stack.column([
            ui.list({ id: 'presets', role: 'browse', filterable: true, selectedIds: composed === undefined ? [] : [composed], items: presetItems(catalog, composed, t), empty: ui.empty({ title: t('No presets composed') }) }),
            ui.actions({ id: 'preset-actions', items: [{ id: 'refresh', label: t('Refresh') }, { id: 'close', label: t('Close'), dismiss: true }] }),
          ]) })
        }
        let handle: MayflyOverlayHandle | undefined
        handle = await openAgentOverlay(ctx, agent, { id: ID, presentation: 'editor', capturing: true }, view(), () => async (event, context) => {
          if (event.kind === 'selection-accept' && event.controlId === 'presets') {
            const selected = event.selectedIds[0]
            if (selected === undefined || !catalog.some(preset => preset.id === selected && preset.broken === undefined)) return { kind: 'failed', message: t('The preset is no longer available') }
            try {
              const switched = await select(agent, selected, context.signal)
              if (context.signal.aborted || !current(agent)) return { kind: 'cancelled' }
              notifications.report('select', { severity: 'success', message: t('Preset switched to {preset}', { preset: switched }) })
              return { kind: 'accepted', node: view(), source: [], dismiss: true }
            } catch (error) {
              notifications.report('select', { severity: 'error', message: message(error) })
              return { kind: 'failed', message: message(error) }
            }
          }
          if (event.kind === 'activate' && event.actionId === 'refresh') {
            const next = await roster.list()
            if (context.signal.aborted || !current(agent)) return { kind: 'cancelled' }
            catalog = next
            handle?.set(view())
          }
          return { kind: 'completed' }
        }, signal)
        if (handle === undefined || handle.closed) return { kind: 'success' }
        const offLocale = observeInteractionLocale(ctx, () => { handle!.set(view()) })
        let cleanup!: () => void
        const offRegistry = ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'remove' && delta.id === ID && handle!.closed) cleanup() })
        cleanup = ctx.effect(() => () => { offLocale(); offRegistry() })
        return { kind: 'success' }
      } catch (error) { return signal.aborted || !current(agent) ? { kind: 'success' } : { kind: 'error', text: message(error) } }
    },
  })
}
