/**
 * Public `/provider` routing into the shared reference provider configuration
 * and model picker. The configuration family owns all native Host operations
 * and generation-scoped surfaces.
 * @module @ephemeral-ai/mayfly/remote/operations/providers
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import { registerRemoteOperationsLocale, type RemoteOperationsContext } from './support.ts'

const zh: Readonly<Record<string, string>> = {
  'Configure providers or choose their models': '配置提供商或选择其模型',
}

/** Mount one public command over the hidden configuration composition route. */
export function mountRemoteProviderOperations(context: RemoteOperationsContext): () => void {
  registerRemoteOperationsLocale(context.base, 'remote-provider', zh)
  const t = memoizedLocaleTranslator(context.base.ctx, 'remote-provider').translate
  let disposed = false
  const unregister = context.base.commands.register({
    name: 'provider', scope: 'sessionless',
    description: t('Configure providers or choose their models'),
    input: { hint: '[list | edit <provider> | switch <provider> | add]' },
    execute: async (rawInput, signal) => {
      if (disposed || signal.aborted) return
      const input = rawInput.trim()
      const words = input.split(/\s+/u)
      const verb = words[0]!.toLowerCase()
      const name = words.slice(1).join(' ')
      let route: string
      if (input === '' || verb === 'list' || verb === 'switch' && name === '') route = ''
      else if (verb === 'add') route = 'add'
      else if (verb === 'edit') {
        if (name === '') throw new Error('Usage: /provider edit <provider>')
        route = `edit ${name}`
      } else if (verb === 'remove') {
        context.base.notice.set('Usage: /provider [list | edit <provider> | switch <provider> | add]')
        return
      } else route = `switch ${verb === 'switch' ? name : input}`
      await context.base.commands.execute('providers', route, signal)
    },
  })
  return () => { disposed = true; unregister() }
}
