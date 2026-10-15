/**
 * The footer: one status row on the footer node slot. Covers the order of its entries (priority, then id), what it leaves out
 * (an entry with nothing to show), the heavy line under the entered item, the publication that happens only when an entry, an item
 * of the views lane, or the entered state changes, the lease released with the Fiber, and the narrower forms a status node sheds to
 * (`shedNode`).
 * @module transcript-status-rows
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { ui, type MayflyStatusEntry, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { MayflyStatusService } from '../../../ui/src/provider.ts'
import { buildStatusFooter, mountStatusFooter } from '../../src/transcript/status-rows.ts'
import { shedNode, SHED } from '../../src/transcript/status-shed.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { footerRows } from './footer-fakes.ts'
import { COLORS } from './status-fakes.ts'

const ANSI = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/gu
const components = fakeMayflyComponents()
const entry = (id: string, text: string | null, extra: { readonly priority?: number, readonly band?: 'left' | 'center' | 'right' } = {}): MayflyStatusEntry => ({
  id, definition: { id, ...extra }, node: text === null ? null : { kind: 'text', content: text }, revision: 1,
})
const rows = (entries: readonly MayflyStatusEntry[], width = 60, active?: string): string[] => footerRows(entries, width, components, COLORS, { active }).map(row => row.replace(ANSI, '').replace(/^ /u, '').trimEnd())  // the surface's one column of padding at the left

describe('buildStatusFooter', () => {
  it('has no footer when no entry has anything to show', () => {
    expect(buildStatusFooter([], {})).toBeNull()
    expect(buildStatusFooter([entry('a', null)], {})).toBeNull()
  })

  it('orders the entries by priority, then by id, and leaves out the ones with nothing to show', () => {
    expect(rows([entry('z', 'last', { priority: 10 }), entry('b', 'tie-b', { priority: 5 }), entry('a', 'tie-a', { priority: 5 }), entry('mid', null, { priority: 7 }), entry('first', 'first', { priority: 0 })]))
      .toEqual(['first  tie-a  tie-b  last'])
    // No priority means priority zero, ahead of the ranked ones.
    expect(rows([entry('ranked', 'ranked', { priority: 1 }), entry('plain', 'plain')])).toEqual(['plain  ranked'])
  })

  it('puts an entry in its band: the left cluster first, the right one at the edge', () => {
    expect(rows([entry('model', 'model', { priority: 0 }), entry('ctx', 'ctx 18%', { priority: 6, band: 'right' })], 30)).toEqual([`model${' '.repeat(30 - 2 - 'model'.length - 'ctx 18%'.length)}ctx 18%`])
  })

  it('draws a heavy line on the row below, under the words of the item that is entered, and under no other', () => {
    const entries = [entry('model', 'model', { priority: 0 }), entry('views/jobs', '● jobs 2', { priority: 12 }), entry('views/goal', '● goal 2/8', { priority: 13 })]
    expect(rows(entries, 60, 'views/jobs')).toEqual(['model  ● jobs 2  ● goal 2/8', `       ${'━'.repeat('● jobs 2'.length)}`])
    expect(rows(entries, 60, 'views/goal')[1]).toBe(`${' '.repeat('model  ● jobs 2  '.length)}${'━'.repeat('● goal 2/8'.length)}`)
    expect(rows(entries, 60)).toHaveLength(1)
    expect(rows(entries, 60, 'views/missing')).toHaveLength(1)
  })

  it('is one surface with no chrome, padded one column', () => {
    expect(buildStatusFooter([entry('a', 'a')], {})).toMatchObject({ kind: 'surface', chrome: 'none', padding: 1 })
  })
})

describe('shedNode', () => {
  it('is the node itself when it has no narrower form, and a shed node with its forms when it has', () => {
    const full = ui.richText([{ text: 'cwd' }])
    expect(shedNode(full, [])).toBe(full)
    const forms = [{ rank: SHED.cwd, node: ui.richText([{ text: 'c' }]) }]
    expect(shedNode(full, forms)).toEqual({ kind: 'shed', node: full, narrower: forms })
  })

  it('ranks what the row gives up in the order the owner chose', () => {
    expect(SHED).toEqual({ time: 5, provider: 10, effort: 20, git: 30, cwd: 40, cache: 50, bar: 55, context: 60, model: 70 })
    const ranks = Object.values(SHED)
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
  })
})

describe('mountStatusFooter', () => {
  /** A screen with the footer slot and the views lane's read-only window, driven by hand. */
  function screen() {
    const published: (MayflyUiNode | null)[] = []
    let disposed = false
    const lane = { items: [] as MayflyStatusEntry[], isEntered: false, active: undefined as string | undefined, listeners: new Set<() => void>() }
    const windowOnLane = {
      statusEntries: () => lane.items,
      get isEntered() { return lane.isEntered },
      get active() { return lane.active },
      subscribe(listener: () => void) { lane.listeners.add(listener); return () => { lane.listeners.delete(listener) } },
    }
    const slot = { id: 'status.footer', set: (node: MayflyUiNode | null) => { published.push(node) }, dispose: () => { disposed = true } }
    const mountNodeSlot = vi.fn(() => slot)
    const change = (): void => { for (const listener of [...lane.listeners]) listener() }
    return { published, lane, change, mountNodeSlot, views: windowOnLane, isDisposed: () => disposed, screen: { mountNodeSlot, views: windowOnLane } as never }
  }

  async function mount() {
    const ctx = new Context()
    const status = new MayflyStatusService(ctx)
    const fake = screen()
    const fiber = await ctx.plugin({ name: 'footer-owner', apply: (owner: Context) => { mountStatusFooter(owner, fake.screen) } })
    return { ctx, status, fake, fiber }
  }

  it('leases the footer slot and publishes the row, then again only when something it shows changed', async () => {
    const { status, fake, fiber } = await mount()
    expect(fake.mountNodeSlot).toHaveBeenCalledWith('status.footer', { region: 'footer' })
    // Nothing registered: nothing to show.
    expect(fake.published).toEqual([null])
    const model = status.register({ id: 'model', priority: 0 }, { kind: 'text', content: 'model' })
    expect(fake.published).toHaveLength(2)
    expect(rows(status.list())).toEqual(['model'])
    // The same node at the same revision is not a change.
    fake.change()
    expect(fake.published).toHaveLength(2)
    model.set({ kind: 'text', content: 'other model' })
    expect(fake.published).toHaveLength(3)
    // An item of the lane joins the row, and the entered state moves the heavy line.
    fake.lane.items = [entry('views/jobs', '● jobs 1', { priority: 12 })]
    fake.change()
    expect(fake.published).toHaveLength(4)
    fake.lane.isEntered = true
    fake.lane.active = 'jobs'
    fake.change()
    expect(fake.published).toHaveLength(5)
    expect(JSON.stringify(fake.published.at(-1))).toContain('"mark":"underline"')
    // An active view that is not entered draws no line.
    fake.lane.isEntered = false
    fake.change()
    expect(JSON.stringify(fake.published.at(-1))).not.toContain('underline')
    await fiber.dispose()
  })

  it('releases the lease and the listeners with its Fiber', async () => {
    const { status, fake, fiber } = await mount()
    await fiber.dispose()
    expect(fake.isDisposed()).toBe(true)
    expect(fake.lane.listeners.size).toBe(0)
    const before = fake.published.length
    status.register({ id: 'late', priority: 0 }, { kind: 'text', content: 'late' })
    fake.change()
    expect(fake.published).toHaveLength(before)
  })
})
