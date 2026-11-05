/** Renderer-neutral reference skill browser and detail presentation. @module @ephemeral-ai/mayfly/interaction/skills-model */
import { browser, panel, ui, type MayflyListItem, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'

/** Human-invocable skill metadata; bodies and Host objects never enter the view. */
export interface SkillPresentationFacts {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source?: string
  readonly provider?: string
  readonly invocation: { readonly modelInvocable: boolean }
}

export function skillGroup(source: string): string {
  if (source === 'project-dsh' || source === 'project-agents') return 'Project'
  if (source === 'user-dsh' || source === 'user-agents') return 'User'
  return source
}

/** Optional list/detail state; the wide list follows its cursor. */
interface SkillsViewState {
  readonly focused?: string | undefined
  readonly detailMode?: boolean | undefined
  /** An actual native API metadata limitation, shown beside the affected view. */
  readonly metadataNote?: string
}

function sortedSkills(skills: readonly SkillPresentationFacts[]): readonly SkillPresentationFacts[] {
  const order = ['Project', 'User']
  for (const skill of skills) if (!order.includes(skillGroup(skill.source ?? ''))) order.push(skillGroup(skill.source ?? ''))
  return skills.toSorted((left, right) => {
    const a = order.indexOf(skillGroup(left.source ?? '')), b = order.indexOf(skillGroup(right.source ?? ''))
    return a - b || left.name.localeCompare(right.name)
  })
}

function skillDetail(skill: SkillPresentationFacts, t: MayflyTranslate): MayflyUiNode {
  return ui.stack.column([ui.child(ui.scroll(ui.stack.column([
    ui.text(skill.description),
    ...skill.whenToUse === undefined ? [] : [ui.text(skill.whenToUse)],
    ui.fields([{ label: t('Source'), value: [{ text: skill.source ?? t('unknown') }] }, { label: t('Provider'), value: [{ text: skill.provider ?? t('unknown') }] }]),
  ]), { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 })])
}

/** The shared rc.2 layout; absent native metadata is never inferred from a filesystem path. */
export function skillsNode(skills: readonly SkillPresentationFacts[], complete: boolean, t: MayflyTranslate, state: SkillsViewState = {}): MayflyUiNode {
  const sorted = sortedSkills(skills)
  const items: readonly MayflyListItem[] = sorted.map(skill => ({
    id: skill.name, label: skill.name,
    ...skill.source === undefined ? {} : { group: t(skillGroup(skill.source)) },
    detail: skill.description,
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
      ...state.metadataNote === undefined ? [] : [ui.text(state.metadataNote, { tone: 'muted' })],
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
