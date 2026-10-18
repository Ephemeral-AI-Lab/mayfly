/** Provider configuration commands owned independently of Agent and renderer lifetimes.
 * @module @ephemeral-ai/mayfly/interaction/provider-commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { panel, ui, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { openProviderEditor } from './provider-edit.ts'
import { openAccountPanel } from './provider-account.ts'
import { openModelPicker } from './model-commands.ts'
import { deriveKeyRef } from './provider-profile.ts'
import { providerAddress, providerDescriptor, providerProfileAt } from './provider-store.ts'
import { registerOwnedCommand } from './sessionless-commands.ts'
import { interactionTranslator } from './locale.ts'
import { openProviderSetup } from './provider-add.ts'
import { openUiOverlay } from './ui-overlay.ts'

export const name = 'mayfly-provider-commands'
export const inject = ['commands', 'settings', 'credentials', 'mayflyOverlays', 'mayflyInteractionState']

export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const t = interactionTranslator(ctx)
  const add = async (signal: AbortSignal): Promise<CommandResult> => {
    if (signal.aborted || lifetime.signal.aborted) return { kind: 'success' }
    openProviderSetup(ctx, route => { void openModelPicker(ctx, lifetime.signal, route) }, lifetime.signal)
    return { kind: 'success' }
  }
  registerOwnedCommand(ctx, {
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
        const route = argument.slice('edit '.length).trim()
        return await openProviderEditor(ctx, route, lifetime.signal) || await openAccountPanel(ctx, route, lifetime.signal)
          ? { kind: 'success' } : { kind: 'error', text: t('The provider has no editable configuration') }
      }
      if (argument !== '' && argument !== 'list') return { kind: 'error', text: 'usage: /provider [list | edit <provider> | switch <provider> | add]' }
      const build = async (): Promise<MayflyUiNode> => {
        const settings = ctx.get('settings')
        const credentials = ctx.get('credentials')
        const items = await Promise.all((ctx.get('llm')?.listProviders() ?? []).map(async provider => {
          const address = providerAddress(ctx, provider.id)
          const descriptor = settings === undefined || address === undefined ? undefined : providerDescriptor(settings, address.ns)
          const profile = descriptor === undefined || address === undefined ? undefined : providerProfileAt(descriptor.value, address.path)
          const credential = await credentials?.describe(credentialRef(profile?.apiKeyEnv ?? deriveKeyRef(provider.id))).catch(() => undefined)
          const parts = [
            profile?.models === undefined ? undefined : profile.models.length === 0 ? t('no models') : t('{count} models', { count: profile.models.length }),
            credential === undefined || (profile === undefined && !credential.configured) ? undefined : t(credential.configured ? 'key configured' : 'no key set'),
          ].filter(part => part !== undefined)
          return { id: provider.id, label: provider.name || provider.id, ...(parts.length === 0 ? {} : { detail: parts.join(' · ') }) }
        }))
        return panel({
          title: t('Providers'),
          escapeLabel: 'close',
          body: ui.stack.column([
            ui.list({ id: 'providers', role: 'browse', selectedIds: [], filterable: true, filterMode: 'slash', items, empty: ui.empty({ title: t('No configured providers') }) }),
            ui.actions({ id: 'provider-list-actions', items: [{ id: 'add', label: t('Add provider'), hintLabel: t('add'), key: 'ctrl+a', hidden: true }] }),
          ]),
        })
      }
      let offSettings: (() => void) | undefined
      const handle = openUiOverlay(ctx, {
        id: 'mayfly.providers', title: t('Providers'), presentation: 'editor', capturing: true,
        scope: { kind: 'app', targetId: 'provider-configuration' },
        onEvent: { action: async (event, context) => {
          if (event.kind === 'selection-accept') {
            const route = event.selectedIds[0]!
            return await openProviderEditor(ctx, route, lifetime.signal) || await openAccountPanel(ctx, route, lifetime.signal)
              ? { kind: 'completed' } : { kind: 'failed', message: t('The provider has no editable configuration') }
          }
          if (event.kind === 'activate' && event.actionId === 'add') {
            await add(context.signal)
            return { kind: 'completed' }
          }
          return { kind: 'completed' }
        } },
      }, await build(), { signal: lifetime.signal, reopen: 'focus', onClosed: () => offSettings?.() })
      if (handle === undefined) return { kind: 'success' }
      offSettings = ctx.on('settings/document-updated', () => { void build().then(node => { if (!handle.closed) handle.set(node) }) })
      return { kind: 'success' }
    },
  })
}
