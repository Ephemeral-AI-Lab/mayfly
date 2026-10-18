/** Shared readonly skills listing over the same catalog used by prompt gestures.
 * One editor panel holds the list and the selected skill's detail.
 * @module @ephemeral-ai/mayfly/interaction/skills-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { browser, panel, ui, type MayflyListItem, type MayflyUiNode, type MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'

export const name = 'mayfly-skills-command'
export const inject = ['commands', 'mayflySkillsCatalog', 'mayflyCurrentAgent', 'mayflyOverlays']

export function skillGroup(source: string): string {
  if (source === 'project-dsh' || source === 'project-agents') return 'Project'
  if (source === 'user-dsh' || source === 'user-agents') return 'User'
  return source
}

/** The optional list/detail state of {@link skillsNode}; the wide list follows its cursor. */
export interface SkillsViewState {
  readonly focused?: string | undefined
  readonly detailMode?: boolean | undefined
}

function sortedSkills(skills: readonly SkillSummary[]): readonly SkillSummary[] {
  const order = ['Project', 'User']
  for (const skill of skills) if (!order.includes(skillGroup(skill.source))) order.push(skillGroup(skill.source))
  return skills.toSorted((left, right) => {
    const a = order.indexOf(skillGroup(left.source)), b = order.indexOf(skillGroup(right.source))
    return a - b || left.name.localeCompare(right.name)
  })
}

function skillDetail(skill: SkillSummary, t: MayflyTranslate): MayflyUiNode {
  return ui.stack.column([ui.child(ui.scroll(ui.stack.column([
    ui.text(skill.description),
    ...skill.whenToUse === undefined ? [] : [ui.text(skill.whenToUse)],
    ui.fields([{ label: t('Source'), value: [{ text: skill.source }] }, { label: t('Provider'), value: [{ text: skill.provider }] }]),
  ]), { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 })])
}

export function skillsNode(skills: readonly SkillSummary[], complete: boolean, t: MayflyTranslate, state: SkillsViewState = {}): MayflyUiNode {
  const sorted = sortedSkills(skills)
  const items: readonly MayflyListItem[] = sorted.map(skill => ({
    id: skill.name, label: skill.name, group: t(skillGroup(skill.source)), detail: skill.description,
    ...skill.invocation.modelInvocable ? {} : { badge: t('user-only') },
  }))
  const focused = sorted.find(skill => skill.name === state.focused) ?? sorted[0]
  const detailMode = state.detailMode === true && focused !== undefined
  const list = (id: string) => ui.list({
    id, role: 'browse', filterable: true, filterMode: 'slash', marker: 'selection', acceptVerb: 'open', selectedIds: [], items,
    empty: ui.empty({ title: t('No skills available') }),
  })
  return panel({
    title: detailMode && focused !== undefined ? focused.name : t('Skills'),
    escapeLabel: detailMode ? 'back' : 'close',
    body: ui.stack.column([
      ...complete ? [] : [ui.text(t('Skill catalog is incomplete; showing the last complete catalog'), { tone: 'warning' })],
      browser({
        list: list('skills'),
        listNarrow: list('skills-narrow'),
        detail: focused === undefined ? ui.text(t('No skills available'), { tone: 'muted' }) : skillDetail(focused, t),
        narrow: detailMode ? 'detail' : 'list',
      }),
      ui.actions({ id: 'skills-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
    ]),
  })
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
