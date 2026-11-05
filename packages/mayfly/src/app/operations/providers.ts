/**
 * Public `/provider` routing into the shared reference provider configuration
 * and model picker. The configuration family owns all native Host operations
 * and generation-scoped surfaces.
 * @module @ephemeral-ai/mayfly/app/operations/providers
 */

import { memoizedLocaleTranslator } from '../../frontend/locale.ts'
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
      let route: string
      if (input === '' || input === 'list') route = ''
      else if (input === 'add') route = 'add'
      else if (input.startsWith('switch ')) route = `switch ${input.slice('switch '.length).trim()}`
      else if (input.startsWith('edit ')) route = `edit ${input.slice('edit '.length).trim()}`
      else throw new Error('usage: /provider [list | edit <provider> | switch <provider> | add]')
      await context.base.commands.execute('providers', route, signal)
    },
  })
  return () => { disposed = true; unregister() }
}
