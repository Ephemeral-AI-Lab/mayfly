/** Shared readonly skills listing over the same catalog used by prompt gestures.
 * @module @ephemeral-ai/mayfly/interaction/skills-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { ui, type MayflyUiNode, type MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'

export const name = 'mayfly-skills-command'
export const inject = ['commands', 'mayflySkillsCatalog', 'mayflyCurrentAgent', 'mayflyOverlays']

export function skillGroup(source: string): string {
  if (source === 'project-dsh' || source === 'project-agents') return 'Project'
  if (source === 'user-dsh' || source === 'user-agents') return 'User'
  return source
}

export function skillsNode(skills: readonly SkillSummary[], complete: boolean, t: MayflyTranslate): MayflyUiNode {
  const order = ['Project', 'User']
  for (const skill of skills) if (!order.includes(skillGroup(skill.source))) order.push(skillGroup(skill.source))
  const sorted = skills.toSorted((left, right) => {
    const a = order.indexOf(skillGroup(left.source)), b = order.indexOf(skillGroup(right.source))
    return a - b || left.name.localeCompare(right.name)
  })
  return ui.surface({ title: t('Skills'), chrome: 'overlay', padding: 1, child: ui.stack.column([
    ...complete ? [] : [ui.text(t('Skill catalog is incomplete; showing the last complete catalog'), { tone: 'warning' })],
    ui.list({ id: 'skills', role: 'browse', filterable: true, selectedIds: [], items: sorted.map(skill => ({
      id: skill.name, label: skill.name, group: t(skillGroup(skill.source)), detail: skill.description,
      ...skill.invocation.modelInvocable ? {} : { badge: t('user-only') },
    })), empty: ui.empty({ title: t('No skills available') }) }),
    ui.actions({ id: 'skills-actions', items: [{ id: 'refresh', label: t('Refresh') }, { id: 'close', label: t('Close'), dismiss: true }] }),
  ]) })
}

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
    const view = () => { const snapshot = catalog.snapshot(); return skillsNode(snapshot.skills, snapshot.complete, t) }
    let handle: MayflyOverlayHandle | undefined
    const refresh = () => { if (handle?.closed === false) handle.set(view()) }
    handle = await openAgentOverlay(ctx, agent, { id: 'mayfly.skills', presentation: 'editor', capturing: true }, view(), owner => {
      owner.effect(() => catalog.subscribe(refresh))
      owner.effect(() => observeInteractionLocale(owner, refresh))
      return async event => {
        if (event.kind === 'activate' && event.actionId === 'refresh') { await catalog.refresh(); return { kind: 'completed' } }
        if (event.kind !== 'selection-accept' || event.controlId !== 'skills') return { kind: 'completed' }
        const skill = catalog.userInvocable().find(skill => skill.name === event.selectedIds[0])
        if (skill === undefined) return { kind: 'cancelled' }
        ctx.mayflyOverlays.close('mayfly.skills.detail')
        const detail = (skill: SkillSummary) => ui.surface({ title: skill.name, chrome: 'overlay', padding: 1, child: ui.stack.column([
          ...catalog.snapshot().complete ? [] : [ui.text(t('Skill catalog is incomplete; showing the last complete catalog'), { tone: 'warning' })],
          ui.child(ui.scroll(ui.stack.column([
            ui.text(skill.description), ...skill.whenToUse === undefined ? [] : [ui.text(skill.whenToUse)],
            ui.fields([{ label: t('Source'), value: [{ text: skill.source }] }, { label: t('Provider'), value: [{ text: skill.provider }] }]),
          ]), { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 }),
          ui.actions({ id: 'detail-actions', items: [{ id: 'close', label: t('Close'), dismiss: true }] }),
        ]) })
        let child: MayflyOverlayHandle | undefined
        const refreshDetail = () => {
          if (child?.closed !== false) return
          const latest = catalog.userInvocable().find(item => item.name === skill.name)
          if (latest === undefined) child.close()
          else child.set(detail(latest))
        }
        child = await openAgentOverlay(owner, agent, { id: 'mayfly.skills.detail', presentation: 'editor', capturing: true }, detail(skill), scope => {
          scope.effect(() => catalog.subscribe(refreshDetail))
          scope.effect(() => observeInteractionLocale(scope, refreshDetail))
          return () => ({ kind: 'completed' })
        }, lifetime.signal)
        refreshDetail()
        return { kind: 'completed' }
      }
    }, lifetime.signal)
    if (invocation.signal.aborted) handle?.close()
    refresh()
    return { kind: 'success' }
  } })
}
