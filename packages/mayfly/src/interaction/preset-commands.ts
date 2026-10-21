/** Native Agent preset selection through frontend-owned shared choice surfaces.
 * @module @ephemeral-ai/mayfly/interaction/preset-commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-settings'
import { panel, ui, type MayflyListItem, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'
import { createInteractionNotificationOwner } from './notifications.ts'
import { registerOwnedCommand } from './sessionless-commands.ts'

export const name = 'mayfly-preset-command'
export const inject = ['commands', 'agentPresets', 'mayflyCurrentAgent', 'mayflyOverlays', 'mayflyInteractionState']
const ID = 'mayfly.presets'
/** The native registry's settings namespace; `selectedDefault` is the next session's preset. */
const PRESET_SETTINGS_NS = 'agent-preset-registry'

export function presetItems(presets: readonly AgentPreset[], current: string | undefined): readonly MayflyListItem[] {
  return presets.toSorted((left, right) => (left.order ?? Infinity) - (right.order ?? Infinity) || left.id.localeCompare(right.id)).map(preset => ({
    id: preset.id, label: preset.name ?? preset.id,
    ...preset.broken === undefined ? preset.description === undefined ? {} : { detail: preset.description } : { detail: preset.broken, disabled: true, disabledReason: preset.broken },
    ...preset.id === current ? { current: true } : {},
  }))
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** A preset selection ready to report: the native identity and its display label. */
interface PresetChoice { readonly id: string, readonly label: string }

/** Reject an unknown or unreadable definition before it becomes the default. */
async function resolvePreset(roster: Context['agentPresets'], id: string): Promise<AgentPreset> {
  const preset = await roster.resolve(id)
  if (preset.broken !== undefined) throw new Error(preset.broken)
  return preset
}

/** Persist the preset a session created later takes through the native settings field. */
async function setDefaultPreset(ctx: Context, id: string): Promise<void> {
  const t = interactionTranslator(ctx)
  const settings = ctx.get('settings')
  const entry = settings?.describe().find(item => String(item.ns) === PRESET_SETTINGS_NS)
  if (settings === undefined || entry === undefined) throw new Error(t('preset selection is unavailable'))
  try {
    await settings.update(PRESET_SETTINGS_NS, { selectedDefault: id }, entry.revision)
  } catch (error) {
    throw new Error(message(error))
  }
}
export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const roster = ctx.agentPresets
  const t = interactionTranslator(ctx)
  const notifications = createInteractionNotificationOwner(ctx, 'mayfly.preset', 'preset')
  /** Whether this invocation still owns the selection it read. */
  const current = (agent: Agent | null) => !lifetime.signal.aborted
    && (agent === null ? ctx.mayflyCurrentAgent.current() === null : ctx.mayflyCurrentAgent.current() === agent)
  const select = async (agent: Agent | null, id: string, signal: AbortSignal): Promise<PresetChoice> => {
    if (signal.aborted || !current(agent)) throw new Error(t('The active Agent changed before the preset switch'))
    if (agent === null) {
      const selected = await resolvePreset(roster, id)
      await setDefaultPreset(ctx, selected.id)
      if (signal.aborted || !current(agent)) throw new Error(t('The active Agent changed before the preset switch'))
      return { id: selected.id, label: selected.name ?? selected.id }
    }
    if (agent.status !== 'idle') throw new Error(t('cannot switch presets while the agent is running'))
    return { id: await roster.select(agent, id), label: id }
  }
  registerOwnedCommand(ctx, {
    name: 'preset', description: t('List agent presets or switch (blank sessions; sets the default before one starts)'), input: { hint: '[name]' },
    handler: async invocation => {
      const agent = ctx.mayflyCurrentAgent.current()
      const signal = AbortSignal.any([invocation.signal, lifetime.signal])
      if (signal.aborted) return { kind: 'success' }
      const id = invocation.rawInput.trim()
      try {
        if (id !== '') {
          const selected = await select(agent, id, signal)
          if (signal.aborted || !current(agent)) return { kind: 'success' }
          return { kind: 'success', text: agent === null ? t('Default preset: {preset}', { preset: selected.label }) : `preset ${selected.id}` }
        }
        if (ctx.mayflyOverlays.focus(ID)) return { kind: 'success' }
        let catalog = await roster.list()
        if (signal.aborted || !current(agent)) return { kind: 'success' }
        if (ctx.mayflyOverlays.focus(ID)) return { kind: 'success' }
        const view = (): MayflyUiNode => {
          const composed = agent === null ? roster.defaultId : roster.composedPreset(agent.ctx)
          return panel({
            title: t('Presets'),
            escapeLabel: 'close',
            body: ui.list({ id: 'presets', role: 'browse', filterable: true, filterMode: 'slash', selectedIds: composed === undefined ? [] : [composed], items: presetItems(catalog, composed), empty: ui.empty({ title: t('No presets composed') }) }),
            footer: ui.actions({ id: 'preset-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
          })
        }
        let handle: MayflyOverlayHandle | undefined
        handle = await openAgentOverlay(ctx, agent, { id: ID, presentation: 'editor', capturing: true }, view(), owner => {
          owner.effect(() => observeInteractionLocale(owner, () => { if (handle?.closed === false) handle.set(view()) }))
          return async (event, context) => {
          if (event.kind === 'selection-accept' && event.controlId === 'presets') {
            const selected = event.selectedIds[0]
            if (selected === undefined || !catalog.some(preset => preset.id === selected && preset.broken === undefined)) return { kind: 'failed', message: t('The preset is no longer available') }
            try {
              const switched = await select(agent, selected, context.signal)
              if (context.signal.aborted || !current(agent)) return { kind: 'cancelled' }
              notifications.report('select', {
                severity: 'success',
                message: agent === null ? t('Default preset: {preset}', { preset: switched.label }) : t('Preset switched to {preset}', { preset: switched.id }),
              })
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
        }
        }, { signal, reopen: 'focus' })
        return { kind: 'success' }
      } catch (error) { return signal.aborted || !current(agent) ? { kind: 'success' } : { kind: 'error', text: message(error) } }
    },
  })
}
