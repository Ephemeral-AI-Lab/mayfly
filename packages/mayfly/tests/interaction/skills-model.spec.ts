/** Source grouping and readonly fallback facts in the shared skill browser. @module tests/interaction/skills-model */
import { describe, expect, it } from 'vitest'
import { skillsNode, skillGroup, type SkillPresentationFacts } from '../../src/interaction/skills-model.ts'

const t = (text: string): string => text
const fact = (name: string, source?: string): SkillPresentationFacts => ({
  name, description: `${name} routing description`, invocation: { modelInvocable: true },
  ...source === undefined ? {} : { source, provider: 'filesystem' },
})
function nodes(value: unknown): Readonly<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (value === null || typeof value !== 'object') return []
  const record = value as Readonly<Record<string, unknown>>
  return [record, ...Object.values(record).flatMap(nodes)]
}

describe('shared reference skill model', () => {
  it('preserves Project/User/custom ordering and groups the actual skill sources', () => {
    expect(['project-dsh', 'project-agents', 'user-dsh', 'user-agents', 'extension'].map(skillGroup)).toEqual(['Project', 'Project', 'User', 'User', 'extension'])
    const node = skillsNode([
      fact('extension', 'extension'), fact('zebra', 'project-agents'), fact('user', 'user-dsh'),
      { ...fact('alpha', 'project-dsh'), whenToUse: 'Use when ready', invocation: { modelInvocable: false } },
    ], true, t, { focused: 'alpha' })
    const list = nodes(node).find(item => item['kind'] === 'list' && item['id'] === 'skills')!
    expect(list['items']).toEqual([
      { id: 'alpha', label: 'alpha', group: 'Project', detail: 'alpha routing description', badge: 'user-only' },
      { id: 'zebra', label: 'zebra', group: 'Project', detail: 'zebra routing description' },
      { id: 'user', label: 'user', group: 'User', detail: 'user routing description' },
      { id: 'extension', label: 'extension', group: 'extension', detail: 'extension routing description' },
    ])
    expect(JSON.stringify(node)).toContain('Use when ready')
    expect(JSON.stringify(node)).toContain('filesystem')
    expect(JSON.stringify(node)).not.toContain('unknown')
  })

  it('shows only supplied metadata and supports narrow detail, empty, and incomplete states', () => {
    const detail = skillsNode([fact('native')], false, t, { detailMode: true, focused: 'missing', metadataNote: 'Native API does not advertise source metadata' })
    expect(detail).toMatchObject({ title: 'native', escapeLabel: 'back' })
    const list = nodes(detail).find(item => item['kind'] === 'list' && item['id'] === 'skills')!
    expect(list['items']).toEqual([{ id: 'native', label: 'native', detail: 'native routing description' }])
    expect(JSON.stringify(detail)).toContain('unknown')
    expect(JSON.stringify(detail)).toContain('Native API does not advertise source metadata')
    expect(JSON.stringify(detail)).toContain('Skill catalog is incomplete; showing the last complete catalog')
    const empty = skillsNode([], true, t, { detailMode: true })
    expect(empty).toMatchObject({ title: 'Skills', escapeLabel: 'close' })
    expect(JSON.stringify(empty)).toContain('No skills available')
    expect(skillsNode([fact('one')], true, t)).toMatchObject({ title: 'Skills' })
    const native = nodes(skillsNode([fact('zebra'), fact('alpha')], true, t)).find(item => item['kind'] === 'list' && item['id'] === 'skills')!
    expect((native['items'] as readonly { readonly id: string }[]).map(item => item.id)).toEqual(['alpha', 'zebra'])
  })
})
