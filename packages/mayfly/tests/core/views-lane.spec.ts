/** The views lane: summaries as status-row entries, the entered panel under the row, and the lane's keys.
 * @module @ephemeral-ai/mayfly/tests/core/views-lane
 */
import { describe, expect, it, vi } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import type { MayflyComponent, MayflyFocusable, MayflyFocusIdentity, MayflySemanticColors } from '../../src/core/types.ts'
import { VIEWS_FOCUS_ID, ViewsLane, type ViewRegistration, type ViewsLaneHost } from '../../src/core/views-lane.ts'
import { plain } from '../helpers.ts'

const PRIMARY = '\x1b[35m'
const MUTED = '\x1b[2m'
const colors = new Proxy({}, {
  get: (_target, key) => key === 'primary' ? (text: string) => `${PRIMARY}${text}\x1b[39m` : key === 'muted' ? (text: string) => `${MUTED}${text}\x1b[22m` : (text: string) => text,
}) as unknown as MayflySemanticColors
/** Plain text of painted rows. */

interface Harness {
  readonly lane: ViewsLane
  readonly host: ViewsLaneHost
  readonly calls: string[]
  readonly size: { columns: number, rows: number }
}

function harness(extra: Partial<ViewsLaneHost> = {}): Harness {
  const lane = new ViewsLane()
  const calls: string[] = []
  const size = { columns: 40, rows: 30 }
  const host: ViewsLaneHost = {
    colors,
    focus: component => { calls.push('focus'); component.focused = true },
    release: () => { calls.push('release'); lane.component.focused = false; lane.focusLost() },
    requestRender: () => { calls.push('render') },
    viewport: () => size,
    ...extra,
  }
  lane.bind(host)
  return { lane, host, calls, size }
}

interface Panel {
  readonly component: MayflyComponent
  readonly target: MayflyFocusable & { readonly input: ReturnType<typeof vi.fn>, identity: MayflyFocusIdentity | undefined }
}

function panel(rows: readonly string[]): Panel {
  const input = vi.fn()
  const target = {
    focused: false,
    identity: undefined as MayflyFocusIdentity | undefined,
    input,
    render: () => [...rows],
    invalidate: vi.fn(),
    handleInput: input,
    captureFocusIdentity(): MayflyFocusIdentity | undefined { return this.identity },
  }
  return { component: target, target }
}

const summary = (text: string) => ({ node: ui.richText([{ text }]) })

function view(lane: ViewsLane, id: string, options: { priority?: number, rows?: readonly string[], enterable?: boolean } = {}): { registration: ViewRegistration, panel: Panel } {
  const registration = lane.register({ id, ...(options.priority === undefined ? {} : { priority: options.priority }), summary: summary(id) })
  const made = panel(options.rows ?? [`${id} body`])
  if (options.enterable !== false) registration.setPanel(made.component, made.target)
  return { registration, panel: made }
}

describe('ViewsLane registration and the status-row entries', () => {
  it('lists summaries as ordered status entries in the left band, and a null summary leaves the row', () => {
    const { lane } = harness()
    const a = view(lane, 'b.second', { priority: 5 })
    view(lane, 'a.first', { priority: 1 })
    view(lane, 'c.tie', { priority: 5 })
    const entries = lane.statusEntries()
    expect(entries.map(entry => entry.id)).toEqual(['views/a.first', 'views/b.second', 'views/c.tie'])
    expect(entries[0]!.definition).toMatchObject({ band: 'left', priority: 1 })
    expect(entries[0]!.definition).not.toHaveProperty('row')
    expect(lane.statusEntries()).toBe(entries)
    const serial = entries[1]!.revision
    a.registration.setSummary(summary('changed'))
    expect(lane.statusEntries()[1]!.revision).toBeGreaterThan(serial)
    a.registration.setSummary(null)
    expect(lane.statusEntries().map(entry => entry.id)).toEqual(['views/a.first', 'views/c.tie'])
    expect(lane.panel(40)).toBeUndefined()
  })

  it('treats a fresh summary of equal content as no change at all', () => {
    const { lane, calls } = harness()
    const a = view(lane, 'a')
    const before = lane.statusEntries()[0]!
    const revision = lane.revision
    calls.length = 0
    // A view that rebuilds its summary every tick hands the lane a fresh, equal tree.
    a.registration.setSummary(summary('a'))
    expect(lane.revision).toBe(revision)
    expect(lane.statusEntries()[0]!.revision).toBe(before.revision)
    expect(calls).toEqual([])
    // A truly changed node is still a change.
    a.registration.setSummary(summary('changed'))
    expect(lane.revision).toBeGreaterThan(revision)
    expect(lane.statusEntries()[0]!.revision).toBeGreaterThan(before.revision)
    expect(calls).toContain('render')
  })

  it('breaks priority ties by id whichever registered first, and counts its changes', () => {
    const { lane } = harness()
    const before = lane.revision
    view(lane, 'z')
    view(lane, 'a')
    expect(lane.statusEntries().map(entry => entry.id)).toEqual(['views/a', 'views/z'])
    expect(lane.revision).toBeGreaterThan(before)
    expect(lane.component.render(20)).toEqual([])
  })

  it('refuses a duplicate id, ignores identical updates, and removes a disposed view', () => {
    const { lane, calls } = harness()
    const first = view(lane, 'one')
    expect(() => lane.register({ id: 'one', summary: null })).toThrow('Duplicate view id: one')
    const kept = summary('kept')
    first.registration.setSummary(kept)
    calls.length = 0
    first.registration.setSummary(kept)
    first.registration.setPanel(first.panel.component, first.panel.target)
    expect(calls).toEqual([])
    first.registration.dispose()
    first.registration.dispose()
    first.registration.setSummary(summary('late'))
    first.registration.setPanel(null, null)
    expect(first.registration.disposed).toBe(true)
    expect(lane.statusEntries()).toEqual([])
  })

  it('normalizes the priority', () => {
    const { lane } = harness()
    const odd = lane.register({ id: 'odd', priority: Number.NaN, summary: summary('x') })
    const made = panel(['body'])
    odd.setPanel(made.component, made.target)
    expect(lane.enter()).toBe(true)
    expect(plain(lane.panel(40))[0]).toBe('body')
    expect(lane.statusEntries()[0]!.definition.priority).toBe(0)
  })
})

describe('ViewsLane entering and leaving', () => {
  it('cannot be entered without a host, without a panel, or without a focus target', () => {
    const lane = new ViewsLane()
    view(lane, 'a')
    expect(lane.enterable).toBe(false)
    expect(lane.enter()).toBe(false)
    const { lane: bound } = harness()
    view(bound, 'no-panel', { enterable: false })
    const targetless = bound.register({ id: 'targetless', summary: summary('t') })
    targetless.setPanel(panel(['x']).component, null)
    expect(bound.enterable).toBe(false)
    expect(bound.enter()).toBe(false)
    expect(bound.enter('missing')).toBe(false)
    expect(bound.statusEntries()).toHaveLength(2)
  })

  it('enters the first view with focus, switches in place, and leaves back through the host', () => {
    const { lane, calls } = harness()
    view(lane, 'agents', { priority: 1 })
    view(lane, 'jobs', { priority: 2 })
    expect(lane.enterable).toBe(true)
    expect(lane.isEntered).toBe(false)
    expect(lane.enter()).toBe(true)
    expect(calls).toContain('focus')
    expect(lane.isEntered).toBe(true)
    expect(lane.active).toBe('agents')
    calls.length = 0
    expect(lane.enter('jobs')).toBe(true)
    expect(calls).not.toContain('focus')
    expect(lane.active).toBe('jobs')
    expect(lane.enter()).toBe(true)
    expect(lane.active).toBe('jobs')
    lane.leave()
    expect(calls).toContain('release')
    expect(lane.isEntered).toBe(false)
    lane.leave()
    expect(calls.filter(call => call === 'release')).toHaveLength(1)
  })

  it('forgets being entered when focus moves off by another path', () => {
    const { lane } = harness()
    view(lane, 'a')
    lane.focusLost()
    lane.enter()
    lane.focusLost()
    expect(lane.isEntered).toBe(false)
    expect(VIEWS_FOCUS_ID).toBe('@views')
  })

  it('leaves when the host unbinds, and a stale unbind does nothing', () => {
    const lane = new ViewsLane()
    const calls: string[] = []
    const make = (): ViewsLaneHost => ({ colors, focus: component => { component.focused = true }, release: () => { calls.push('release'); lane.focusLost() }, requestRender: () => {}, viewport: () => ({ columns: 40, rows: 30 }) })
    const first = make()
    const unbindFirst = lane.bind(first)
    view(lane, 'a')
    lane.enter()
    const unbindSecond = lane.bind(make())
    unbindFirst()
    expect(lane.isEntered).toBe(true)
    unbindSecond()
    expect(calls).toEqual(['release'])
    expect(lane.isEntered).toBe(false)
    expect(lane.enter()).toBe(false)
  })

  it('moves to the view now at its place when the active one goes, and leaves when none is left', () => {
    const { lane, calls } = harness()
    const a = view(lane, 'a', { priority: 1 })
    const b = view(lane, 'b', { priority: 2 })
    const c = view(lane, 'c', { priority: 3 })
    lane.enter('b')
    b.registration.dispose()
    expect(lane.active).toBe('c')
    c.registration.setSummary(null)
    expect(lane.active).toBe('a')
    expect(lane.isEntered).toBe(true)
    lane.enter('a')
    a.registration.setPanel(null, null)
    expect(lane.isEntered).toBe(false)
    expect(calls.at(-2)).toBe('render')
    expect(calls.at(-1)).toBe('release')
  })

  it('hands over to the last view when none sorts after the vanished one', () => {
    const { lane } = harness()
    view(lane, 'a', { priority: 1 })
    const z = view(lane, 'z', { priority: 9 })
    lane.enter('z')
    z.registration.dispose()
    expect(lane.active).toBe('a')
  })

  it('keeps ties on priority ordered by id when picking the successor', () => {
    const { lane } = harness()
    view(lane, 'a', { priority: 1 })
    const b = view(lane, 'b', { priority: 1 })
    view(lane, 'c', { priority: 1 })
    lane.enter('b')
    b.registration.dispose()
    expect(lane.active).toBe('c')
  })
})

describe('ViewsLane painting', () => {
  it('paints the active panel alone, with no strip, rule, title, or count: the row names the items', () => {
    const { lane } = harness()
    view(lane, 'agents', { priority: 1, rows: ['one', 'two'] })
    view(lane, 'jobs', { priority: 2 })
    view(lane, 'goal', { priority: 3 })
    lane.enter('jobs')
    expect(plain(lane.panel(60)).filter(row => row !== '')).toEqual(['jobs body'])
    expect(plain(lane.component.render(60)).filter(row => row !== '')).toHaveLength(1)
    lane.switchView(-1)
    expect(plain(lane.panel(60)).filter(row => row !== '')).toEqual(['one', 'two'])
  })

  it('shows the lane at most a third of the terminal, at least four rows, and names the rows it cuts', () => {
    const { lane, size } = harness()
    view(lane, 'a', { rows: Array.from({ length: 20 }, (_, index) => `row ${String(index)}`) })
    lane.enter()
    size.rows = 30
    const rows = lane.panel(40)!
    expect(rows).toHaveLength(10)
    expect(rows.at(-1)).toContain('more rows')
    expect(lane.viewport()).toEqual({ columns: 40, rows: 10 })
    size.rows = 6
    expect(lane.panel(40)).toHaveLength(4)
    expect(lane.viewport().rows).toBe(4)
    size.rows = 3
    expect(lane.viewport().rows).toBe(4)
  })

  it('clamps rows wider than the width', () => {
    const { lane } = harness()
    view(lane, 'a', { rows: ['x'.repeat(50), 'y'] })
    lane.enter()
    expect(lane.panel(20)).toEqual(['x'.repeat(20), 'y'])
  })

  it('paints nothing before a host or an entered view exist', () => {
    const lane = new ViewsLane()
    view(lane, 'a')
    expect(lane.panel(20)).toBeUndefined()
    expect(lane.viewport()).toEqual({ columns: 1, rows: 4 })
    const { lane: bound } = harness()
    view(bound, 'a')
    expect(bound.panel(20)).toBeUndefined()
  })
})

describe('ViewsLane keys', () => {
  it('switches views with the arrows, holds at the ends, and sends everything else to the active panel', () => {
    const { lane } = harness()
    const a = view(lane, 'a', { priority: 1 })
    const b = view(lane, 'b', { priority: 2 })
    lane.enter('a')
    lane.component.handleInput!('x')
    expect(a.panel.target.input).toHaveBeenCalledWith('x')
    lane.component.handleInput!('\x1b[D')
    expect(lane.active).toBe('a')
    lane.component.handleInput!('\x1b[C')
    expect(lane.active).toBe('b')
    lane.component.handleInput!('\x1b[C')
    expect(lane.active).toBe('b')
    lane.component.handleInput!('y')
    expect(b.panel.target.input).toHaveBeenCalledWith('y')
    expect(a.panel.target.input).toHaveBeenCalledTimes(1)
  })

  it('leaves the arrows to a panel that is editing', () => {
    const { lane } = harness()
    const a = view(lane, 'a', { priority: 1 })
    view(lane, 'b', { priority: 2 })
    lane.enter('a')
    a.panel.target.identity = { controlId: 'name', editing: true }
    lane.component.handleInput!('\x1b[C')
    expect(lane.active).toBe('a')
    expect(a.panel.target.input).toHaveBeenCalledWith('\x1b[C')
    a.panel.target.identity = { controlId: 'name' }
    lane.component.handleInput!('\x1b[C')
    expect(lane.active).toBe('b')
  })

  it('ignores keys when no view is entered, and a target without a capture hook is never editing', () => {
    const { lane } = harness()
    const a = view(lane, 'a', { priority: 1 })
    view(lane, 'b', { priority: 2 })
    lane.component.handleInput!('x')
    expect(a.panel.target.input).not.toHaveBeenCalled()
    lane.enter('a')
    const plain = { focused: false, render: () => ['p'], invalidate: () => {}, handleInput: vi.fn() }
    a.registration.setPanel(plain, plain)
    lane.component.handleInput!('z')
    expect(plain.handleInput).toHaveBeenCalledWith('z')
    const silent = { focused: false, render: () => ['s'], invalidate: () => {} }
    a.registration.setPanel(silent, silent)
    lane.component.handleInput!('z')
    lane.component.handleInput!('\x1b[C')
    expect(lane.active).toBe('b')
  })

  it('follows a rebound key and offers the items hint only with a second view', () => {
    const keymap = { getKeys: (id: string) => id === 'ui.left' ? ['h'] : id === 'ui.right' ? ['l'] : [], matches: (data: string, id: string) => (id === 'ui.left' && data === 'h') || (id === 'ui.right' && data === 'l') } as never
    const { lane } = harness({ keymap })
    view(lane, 'a', { priority: 1 })
    expect(lane.hints()).toEqual([])
    view(lane, 'b', { priority: 2 })
    expect(lane.hints()).toEqual([{ id: 'views', keys: 'H/L', label: 'items' }])
    lane.enter('a')
    lane.component.handleInput!('\x1b[C')
    expect(lane.active).toBe('a')
    lane.component.handleInput!('l')
    expect(lane.active).toBe('b')
    lane.component.handleInput!('h')
    expect(lane.active).toBe('a')
  })

  it('says nothing when the arrows are unbound, or when no host is bound', () => {
    const keymap = { getKeys: () => [], matches: () => false } as never
    const { lane } = harness({ keymap })
    view(lane, 'a', { priority: 1 })
    view(lane, 'b', { priority: 2 })
    expect(lane.hints()).toEqual([])
    expect(new ViewsLane().hints()).toEqual([])
  })

  it('mirrors its focus onto the active panel and moves it with the active view', () => {
    const { lane } = harness()
    const a = view(lane, 'a', { priority: 1 })
    const b = view(lane, 'b', { priority: 2 })
    lane.enter('a')
    expect(a.panel.target.focused).toBe(true)
    lane.switchView(1)
    expect(a.panel.target.focused).toBe(false)
    expect(b.panel.target.focused).toBe(true)
    lane.leave()
    expect(b.panel.target.focused).toBe(false)
    const empty = new ViewsLane()
    empty.component.focused = true
    expect(empty.component.focused).toBe(true)
  })

  it('invalidates every panel', () => {
    const { lane } = harness()
    const a = view(lane, 'a')
    const b = view(lane, 'b', { enterable: false })
    lane.component.invalidate()
    expect(a.panel.target.invalidate).toHaveBeenCalled()
    expect(b.panel.target.invalidate).not.toHaveBeenCalled()
  })
})
