/** Shared readonly skills listing over the same catalog used by prompt gestures.
 * One editor panel holds the list and the selected skill's detail.
 * @module @ephemeral-ai/mayfly/interaction/skills-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'
import { skillsNode } from './skills-model.ts'

export const name = 'mayfly-skills-command'
export const inject = ['commands', 'mayflySkillsCatalog', 'mayflyCurrentAgent', 'mayflyOverlays']

export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const catalog = ctx.mayflySkillsCatalog
  const t = interactionTranslator(ctx)
  ctx.commands.register({ name: 'skills', description: t('List available skills (the # prompt invokes one)'), handler: async invocation => {
    const agent = invocation.agent
    if (lifetime.signal.aborted || invocation.signal.aborted) return { kind: 'success' }
    if (ctx.mayflyCurrentAgent.current() !== agent) return { kind: 'error', text: t('no active session') }
    if (ctx.mayflyOverlays.focus('mayfly.skills')) return { kind: 'success' }
    await catalog.refresh()
    if (lifetime.signal.aborted || invocation.signal.aborted || ctx.mayflyCurrentAgent.current() !== agent) return { kind: 'success' }
    let focused: string | undefined
    let detailMode = false
    const view = () => {
      const snapshot = catalog.snapshot()
      return skillsNode(snapshot.skills, snapshot.complete, t, { focused, detailMode })
    }
    let handle: MayflyOverlayHandle | undefined
    const refresh = () => {
      const names = catalog.userInvocable().map(skill => skill.name)
      if (focused === undefined || !names.includes(focused)) focused = names[0]
      if (detailMode && focused === undefined) detailMode = false
      if (handle?.closed === false) handle.set(view())
    }
    handle = await openAgentOverlay(ctx, agent, { id: 'mayfly.skills', presentation: 'editor', capturing: true }, view(), owner => {
      owner.effect(() => catalog.subscribe(refresh))
      owner.effect(() => observeInteractionLocale(owner, refresh))
      return async event => {
        if (event.kind === 'dismiss') {
          if (detailMode) {
            detailMode = false
            if (handle?.closed === false) handle.set(view())
            return { kind: 'completed', dismiss: false }
          }
          return { kind: 'completed' }
        }
        if (event.kind === 'selection-accept' && (event.controlId === 'skills' || event.controlId === 'skills-narrow')) {
          const name = event.selectedIds[0]
          if (name === undefined || !catalog.userInvocable().some(skill => skill.name === name)) return { kind: 'cancelled' }
          focused = name
          if (event.controlId === 'skills-narrow') detailMode = true
          if (handle?.closed === false) handle.set(view())
          return { kind: 'completed' }
        }
        if (event.kind === 'activate' && event.actionId === 'refresh') {
          await catalog.refresh()
          refresh()
          return { kind: 'completed' }
        }
        return { kind: 'completed' }
      }
    }, { signal: lifetime.signal, reopen: 'focus' })
    if (invocation.signal.aborted) handle?.close()
    refresh()
    return { kind: 'success' }
  } })
}
