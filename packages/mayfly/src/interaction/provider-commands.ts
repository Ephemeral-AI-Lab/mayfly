/** Provider configuration commands owned independently of Agent and renderer lifetimes.
 * @module @ephemeral-ai/mayfly/interaction/provider-commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { openProviderEditor } from './provider-edit.ts'
import { openModelPicker } from './model-commands.ts'
import { interactionTranslator } from './locale.ts'
import { openProviderSetup } from './provider-add.ts'

export const name = 'mayfly-provider-commands'
export const inject = ['commands', 'settings', 'credentials', 'mayflyOverlays']

export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const t = interactionTranslator(ctx)
  const add = async (signal: AbortSignal): Promise<CommandResult> => {
    if (signal.aborted || lifetime.signal.aborted) return { kind: 'success' }
    openProviderSetup(ctx, route => { void openModelPicker(ctx, lifetime.signal, route) }, lifetime.signal)
    return { kind: 'success' }
  }
  ctx.commands.register({
    name: 'provider', description: 'Configure providers or choose their models', input: { hint: '[list | edit <provider> | switch <provider> | add]' },
    handler: async invocation => {
      const signal = AbortSignal.any([invocation.signal, lifetime.signal])
      const argument = invocation.rawInput.trim()
      if (argument === 'add') return add(signal)
      if (argument.startsWith('switch ')) {
        const requested = argument.slice('switch '.length).trim().toLowerCase()
        const match = ctx.get('llm')?.listProviders().find(provider => provider.id.toLowerCase() === requested || provider.name.toLowerCase() === requested)
        return match === undefined ? { kind: 'error', text: t('Unknown provider') } : openModelPicker(ctx, signal, match.id)
      }
      if (argument.startsWith('edit ')) {
        return await openProviderEditor(ctx, argument.slice('edit '.length).trim(), lifetime.signal)
          ? { kind: 'success' } : { kind: 'error', text: t('The provider has no editable configuration') }
      }
      if (argument !== '' && argument !== 'list') return { kind: 'error', text: 'usage: /provider [list | edit <provider> | switch <provider> | add]' }
      if (ctx.mayflyOverlays.focus('mayfly.providers')) return { kind: 'success' }
      const build = () => ui.stack.column([
        ui.list({ id: 'providers', role: 'browse', selectedIds: [], filterable: true, items: (ctx.get('llm')?.listProviders() ?? []).map(provider => ({ id: provider.id, label: provider.name || provider.id })), empty: ui.empty({ title: t('No configured providers') }) }),
        ui.actions({ id: 'provider-list-actions', items: [{ id: 'add', label: t('Add provider') }, { id: 'close', label: t('Close'), dismiss: true }] }),
      ])
      const handle = ctx.mayflyOverlays.open({
        id: 'mayfly.providers', title: t('Providers'), presentation: 'editor', capturing: true,
        scope: { kind: 'app', targetId: 'provider-configuration' },
        onEvent: { action: async (event, context) => {
          if (event.kind === 'selection-accept') return await openProviderEditor(ctx, event.selectedIds[0]!, lifetime.signal)
            ? { kind: 'completed' } : { kind: 'failed', message: t('The provider has no editable configuration') }
          if (event.kind === 'activate' && event.actionId === 'add') {
            await add(context.signal)
            return { kind: 'completed' }
          }
          return { kind: 'completed' }
        } },
      }, build())
      const offSettings = ctx.on('settings/updated', () => { handle.set(build()) })
      const offOverlay = ctx.mayflyOverlays.subscribe(delta => {
        if (delta.kind === 'remove' && delta.id === handleId && handle.closed) { offSettings(); offOverlay() }
      })
      const handleId = 'mayfly.providers'
      return { kind: 'success' }
    },
  })
}
