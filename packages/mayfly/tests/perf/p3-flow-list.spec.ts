/**
 * P3: the flowing list paints and walks the visible window and the changed items, while its rows and total height stay
 * what a whole paint produced. The row source is checked against `paintList` over the same list, and the content slot
 * checks the outer tail scroll's height, follow-tail, wheel, and tracked line.
 * @module @ephemeral-ai/mayfly/tests/perf/p3-flow-list
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { freezeWire, ui, type MayflyListItem, type MayflyListNode } from '@ephemeral-ai/mayfly-ui'
import { FlowListPainter, paintList, type FlowListModel, type ListPaintOptions, type ListRowSpec } from '../../src/core/ui-list-paint.ts'
import { UiRowCache } from '../../src/core/ui-row-cache.ts'
import { createWorkCounters } from '../../src/core/ui-work-counters.ts'
import { plainColors } from '../helpers.ts'
import { FRAME_WORKLOADS, FrameHost, measureFrameWorkload } from './frame-workloads.ts'

const colors = plainColors()
const WIDTH = 118
const environment = { advance: (milliseconds: number): void => { vi.advanceTimersByTime(milliseconds) } }

const items = (): MayflyListItem[] => Array.from({ length: 2000 }, (_, index): MayflyListItem => {
  const base = { id: `item-${String(index)}`, label: `Item number ${String(index)}`, detail: `detail ${String(index)}` }
  if (index % 250 === 0) return { ...base, rule: `Rule ${String(index)}` }
  if (index % 251 === 0) return { ...base, gap: true }
  if (index % 97 === 0) return { ...base, label: `A wrapped item number ${String(index)} with a longer label`, wrap: true }
  if (index % 89 === 0) return { ...base, body: `body line ${String(index)}\nsecond body line`, bodyAlways: true }
  if (index % 61 === 0) return { ...base, body: `opened body ${String(index)}`, expanded: true }
  if (index % 500 === 0) return { ...base, group: `Group ${String(index)}` }
  return base
})

const node = (list: readonly MayflyListItem[]): MayflyListNode => ui.list({ id: 'stream', role: 'browse', selectedIds: [], items: list })

function specs(list: readonly MayflyListItem[]): ListRowSpec[] {
  return list.map((item, position) => {
    const always = item.bodyAlways === true && item.body !== undefined
    return { item, depth: 0, last: false, expandable: !always && item.body !== undefined, open: always || (item.body !== undefined && item.expanded === true), position }
  })
}

function paintOptions(cache: UiRowCache, rows: readonly ListRowSpec[]): ListPaintOptions {
  return {
    rows, cursorId: undefined, focused: false, marker: '', selectedIds: [], inputs: {},
    translate: key => key, flow: true,
    memo: { cache },
  }
}

function whole(list: readonly MayflyListItem[], cache: UiRowCache): string[] {
  const listNode = node(list)
  return paintList(listNode, WIDTH, Number.MAX_SAFE_INTEGER, colors, {
    ...paintOptions(cache, specs(list)),
    rows: specs(list),
    total: list.length,
    before: 0,
    after: 0,
  })
}

function model(list: readonly MayflyListItem[]): FlowListModel {
  return {
    items: list,
    specAt: index => specs(list)[index]!,
    signature: list.map(item => `${item.id}:${String(item.bodyAlways === true)}:${String(item.expanded === true)}`).join('|'),
  }
}

function painted(list: readonly MayflyListItem[], cache: UiRowCache): string[] {
  const painter = new FlowListPainter()
  painter.sync({ node: node(list), model: model(list), width: WIDTH, colors, options: paintOptions(cache, []) })
  return Array.from({ length: painter.length }, (_, index) => painter.row(index))
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the flow list row source', () => {
  it('paints the rows a whole paint produces, unchanged and with a changed or appended item', () => {
    const cache = new UiRowCache()
    const first = items()
    expect(painted(first, cache)).toEqual(whole(first, cache))

    // A stream changes its tail and appends the next item: the source rebuilds that tail, not the list.
    const changed = [...first.slice(0, -1), freezeWire({ ...first.at(-1)!, detail: 'streaming 1' })]
    expect(painted(changed, cache)).toEqual(whole(changed, cache))
    const appended = [...changed, freezeWire({ id: 'item-2000', label: 'Item number 2000', detail: 'detail 2000' })]
    expect(painted(appended, cache)).toEqual(whole(appended, cache))
    // A change in the middle, and an item prepended before it, rebuild only the block between the matching ends.
    const middle = appended.map((item, index) => index === 777 ? freezeWire({ ...item, detail: 'middle changed' }) : item)
    expect(painted(middle, cache)).toEqual(whole(middle, cache))
    const prepended = [freezeWire({ id: 'item--1', label: 'Item number -1', detail: 'detail -1' }), ...middle]
    expect(painted(prepended, cache)).toEqual(whole(prepended, cache))
  })

  it('locates the line of an item and reports the whole content height', () => {
    const list = items()
    const cache = new UiRowCache()
    const reference = whole(list, cache)
    const painter = new FlowListPainter()
    painter.sync({ node: node(list), model: model(list), width: WIDTH, colors, options: paintOptions(cache, []) })
    expect(painter.length).toBe(reference.length)
    for (const item of [list[1]!, list[777]!, list.at(-1)!]) {
      const line = painter.locate(item.id)
      expect(line).toBeDefined()
      expect(reference[line!]).toContain(item.label)
    }
  })

  it('walks the window and changed items, not a 2,000-item flow list', async () => {
    const counters = createWorkCounters()
    const host = await FrameHost.boot(counters, environment)
    const slot = host.root.mayflyScreen.mountNodeSlot('transcript.conversation', { region: 'content' })
    const list = Array.from({ length: 2000 }, (_, index) => freezeWire({ id: `item-${String(index)}`, label: `Item number ${String(index)}`, detail: `detail ${String(index)}` }))
    slot.track('stream', 'item-1999')
    slot.set(node(list))
    await host.frames()
    const first = host.root.mayflyScreen.contentTail()!
    expect(first.top + first.viewport).toBe(2000)
    expect(slot.trackedRow()).toBe(1999)

    Object.assign(counters, createWorkCounters())
    slot.set(node(list))
    await host.frames()
    const unchanged = { ...counters }
    expect(unchanged.itemsWalked).toBeLessThan(500)
    expect(unchanged.itemsWalked).toBeLessThan(first.viewport * 6)
    expect(host.root.mayflyScreen.contentTail()!.top + first.viewport).toBe(2000)

    Object.assign(counters, createWorkCounters())
    const changed = [...list.slice(0, -1), freezeWire({ ...list.at(-1)!, detail: 'streaming 1' })]
    slot.set(node(changed))
    await host.frames()
    const oneChanged = { ...counters }
    expect(oneChanged.itemsWalked).toBeLessThan(500)
    expect(slot.trackedRow()).toBe(1999)
    expect(host.root.mayflyScreen.contentTail()!.top + first.viewport).toBe(2000)

    host.root.mayflyScreen.scrollContent('up', 30)
    await host.frames()
    expect(host.root.mayflyScreen.contentTail()!.away).toBe(true)
    host.root.mayflyScreen.followContent()
    await host.frames()
    const followed = host.root.mayflyScreen.contentTail()!
    expect(followed.away).toBe(false)
    expect(followed.top + followed.viewport).toBe(2000)
    await host.dispose()
  }, 30_000)

  it('does not truncate a tall markdown body when the content slot is focused', async () => {
    const counters = createWorkCounters()
    const host = await FrameHost.boot(counters, environment)
    const slot = host.root.mayflyScreen.mountNodeSlot('transcript.conversation', { region: 'content' })
    const text = Array.from({ length: 160 }, (_, index) => `Paragraph ${String(index)}: a long answer that must remain reachable below the fold.`).join('\n\n')
    slot.set(ui.list({ id: 'stream', role: 'browse', selectedIds: [], items: [{ id: 'answer', label: '', body: ui.markdown(text), bodyAlways: true }] }))
    await host.frames()
    const flow = host.root.mayflyScreen.contentTail()!
    slot.focus()
    await host.frames()
    const focused = host.root.mayflyScreen.contentTail()!
    expect(flow.top + flow.viewport).toBeGreaterThan(160)
    expect(focused.top + focused.viewport).toBeGreaterThan(160)
    // Focus used to window the list to the viewport and hold the old scroll top, so this passed even while the tail
    // was unreachable. Following the content must land past the first screen, then Home must reach row 0.
    host.root.mayflyScreen.followContent()
    await host.frames()
    const followed = host.root.mayflyScreen.contentTail()!
    expect(followed.top).toBeGreaterThan(0)
    expect(followed.top + followed.viewport).toBeGreaterThan(160)
    host.root.mayflyScreen.scrollContent('up', 10000)
    await host.frames()
    expect(host.root.mayflyScreen.contentTail()!.top).toBe(0)
    await host.dispose()
  }, 30_000)
})

describe('the W33 flow-tick counter', () => {
  it.each(['W33a', 'W33b'])('%s walks the visible window and changed items', async id => {
    const workload = FRAME_WORKLOADS.find(entry => entry.id === id)!
    const counters = await measureFrameWorkload(workload, environment)
    expect(counters.itemsWalked).toBeLessThan(500)
  }, 30_000)
})
