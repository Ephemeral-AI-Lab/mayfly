/** Direct status registry footer layout and containment coverage. */
import { Context } from '@deepseek-ai/cordis'
import type { MayflyStatusDefinition, MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import { MayflyStatusService } from '../../../ui/src/provider.ts'
import { describe, expect, it } from 'vitest'
import { StatusFooterComponent } from '../../src/transcript/status-model.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { COLORS } from './status-fakes.ts'

type StatusFixture = MayflyStatusDefinition & { readonly node: MayflyStatusNode | null }

function entry(id: string, content: string, options: Partial<MayflyStatusDefinition> & { readonly node?: MayflyStatusNode | null } = {}): StatusFixture {
  return { id, node: { kind: 'text', content }, ...options }
}

function registry(...entries: StatusFixture[]): MayflyStatusService {
  const service = new MayflyStatusService(new Context())
  for (const value of entries) {
    const { node, ...definition } = value
    service.register(definition, node)
  }
  return service
}

describe('StatusFooterComponent', () => {
  it('lays out two bands, priorities, right alignment, cache, and overflow', () => {
    const components = fakeMayflyComponents()
    const service = registry(
      entry('left', 'left', { priority: 0, node: { kind: 'text', content: 'left', tone: 'accent' } }),
      entry('hidden', 'hidden', { node: null }),
      entry('right', 'right', { band: 'right', node: { kind: 'text', content: 'right', tone: 'success' } }),
      entry('second', 'second', { row: 2, node: { kind: 'text', content: 'second', tone: 'warning' } }),
      entry('wide', '0123456789', { row: 2, priority: 2, overflow: 'hide' }),
    )
    const footer = new StatusFooterComponent(service, components, COLORS)
    expect(footer.render(14)).toEqual(['left     right', 'second        '])
    expect(footer.render(14)).toBe(footer.render(14))
    footer.invalidate()
    expect(footer.render(4)).toEqual(['left', 's\x1b[0m...\x1b[0m'])
  })

  it('compiles status stacks, right-only rows, and invalid trees safely', () => {
    const service = registry({
      id: 'stack',
      band: 'right',
      node: { kind: 'stack', direction: 'row', gap: 1, children: [
        { node: { kind: 'text', content: 'one' } },
        { node: { kind: 'text', content: 'two', tone: 'muted' } },
      ] },
    })
    const components = fakeMayflyComponents()
    const footer = new StatusFooterComponent(service, components, COLORS)
    const row = footer.render(12)[0]!
    expect(row).toContain('one')
    expect(row).toContain('two')
    expect(components.visibleWidth(row)).toBe(12)

    const invalid = registry(entry('bad', '', { node: { kind: 'actions' } as never }))
    const error = new StatusFooterComponent(invalid, fakeMayflyComponents(), COLORS)
    expect(error.render(12)[0]).toContain('Mayfly UI')
    expect(error.render(0)).toEqual([])
  })

  it('drops empty and overflowing compiled rows', () => {
    const service = registry(
      entry('empty', ''),
      {
        id: 'empty-stack',
        node: { kind: 'stack', direction: 'column', children: [] },
      },
      {
        id: 'overflow',
        overflow: 'hide',
        node: { kind: 'stack', direction: 'column', children: [
          { node: { kind: 'text', content: 'first' } },
          { node: { kind: 'text', content: 'second' } },
        ] },
      },
    )
    const footer = new StatusFooterComponent(service, fakeMayflyComponents(), COLORS)
    expect(footer.render(20)).toEqual([])
  })

  it('admits entries by priority across bands before lower-priority ones truncate', () => {
    const service = registry(
      entry('model', 'model', { priority: 0 }),
      entry('context', 'ctx 45%', { priority: 4, band: 'right', overflow: 'hide' }),
      entry('cwd', '~/dev/workspace', { priority: 5 }),
      entry('git', 'main', { priority: 10 }),
    )
    const footer = new StatusFooterComponent(service, fakeMayflyComponents(), COLORS)
    // Everything fits: left cluster in priority order, the readout right-aligned.
    expect(footer.render(40)).toEqual(['model  ~/dev/workspace  main     ctx 45%'])
    // Short of room, the right-band readout keeps its place; git drops, then cwd truncates.
    expect(footer.render(32)).toEqual(['model  ~/dev/workspace   ctx 45%'])
    expect(footer.render(26)).toEqual(['model  ~/dev/w\x1b[0m...\x1b[0m  ctx 45%'])
    // The readout hides whole only when it no longer fits after the model.
    expect(footer.render(12)).toEqual(['model  ~/\x1b[0m...\x1b[0m'])
  })

  it('centers the center band between the left and right clusters', () => {
    const service = registry(
      entry('left', 'L', { priority: 0 }),
      entry('center', 'MAIN', { priority: 0, band: 'center' }),
      entry('right', 'R', { priority: 1, band: 'right' }),
    )
    const footer = new StatusFooterComponent(service, fakeMayflyComponents(), COLORS)
    expect(footer.render(20)).toEqual(['L       MAIN       R'])
    const centerOnly = new StatusFooterComponent(registry(entry('center', 'MAIN', { band: 'center' })), fakeMayflyComponents(), COLORS)
    expect(centerOnly.render(10)).toEqual(['   MAIN   '])
  })

  it('separates multiple entries in one footer cluster', () => {
    const service = registry(entry('first', 'first'), entry('second', 'second'))
    const footer = new StatusFooterComponent(service, fakeMayflyComponents(), COLORS)
    expect(footer.render(20)).toEqual(['first  second       '])
  })

  describe('views lane', () => {
    /** A lane source with two summaries on row 2 and a switchable panel. */
    function source(panel: readonly string[] | undefined = undefined) {
      const current: { panel: readonly string[] | undefined } = { panel }
      const entries = [
        { id: 'views/agents', definition: { id: 'views/agents', priority: 1, band: 'left' as const, row: 2 as const }, node: { kind: 'text' as const, content: 'Agents 5' }, revision: 1 },
        { id: 'views/jobs', definition: { id: 'views/jobs', priority: 2, band: 'left' as const, row: 2 as const }, node: { kind: 'text' as const, content: 'Jobs 3' }, revision: 2 },
      ]
      return { current, views: { statusEntries: () => entries, panel: () => current.panel } }
    }

    it('admits the summaries of the lane beside the registry entries of row 2', () => {
      const { views } = source()
      const footer = new StatusFooterComponent(registry(entry('model', 'model'), entry('chip', 'chip', { row: 2, priority: 0 })), fakeMayflyComponents(), COLORS, undefined, views)
      expect(footer.render(40)).toEqual(['model'.padEnd(40), 'chip  Agents 5  Jobs 3'.padEnd(40)])
    })

    it('shows an entered view\'s panel in place of row 2, under row 1', () => {
      const { views, current } = source()
      const footer = new StatusFooterComponent(registry(entry('model', 'model')), fakeMayflyComponents(), COLORS, undefined, views)
      const idle = footer.render(30)
      expect(footer.render(30)).toBe(idle)
      current.panel = ['Agents 5   Jobs 3', '━━━━━━━━', 'body']
      expect(footer.render(30)).toEqual(['model'.padEnd(30), 'Agents 5   Jobs 3', '━━━━━━━━', 'body'])
      current.panel = undefined
      expect(footer.render(30)).toBe(idle)
    })

    it('shows the panel alone when row 1 is empty', () => {
      const { views, current } = source(['Agents', '━━━━━━'])
      const footer = new StatusFooterComponent(registry(), fakeMayflyComponents(), COLORS, undefined, views)
      expect(footer.render(20)).toEqual(['Agents', '━━━━━━'])
      current.panel = undefined
      expect(footer.render(20)).toEqual(['Agents 5  Jobs 3'.padEnd(20)])
    })
  })
})
