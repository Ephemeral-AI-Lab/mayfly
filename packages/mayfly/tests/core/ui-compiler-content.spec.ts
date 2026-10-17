/** Compiled content, layout, and motion (slice 1.3): the surface chrome fields, a loader's Escape, the scroll region, motion rows, and a draining bar. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ui, type MayflyUiEvent, type MayflyUiNode } from '../../../ui/src/index.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiNode, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import { ScrollRegion } from '../../src/core/ui-scroll-region.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { UiAnimationClock } from '../../src/core/ui-loader-animation.ts'
import type { MayflyComponents } from '../../src/core/types.ts'
import type { MayflyPresentation } from '../../src/core/presentation.ts'
import { createWorkCounters } from '../../src/core/ui-work-counters.ts'
import { probeComponents } from '../design/probe.ts'
import { plainColors, plainText } from '../helpers.ts'

const colors = plainColors()

function components(presentation: Partial<MayflyPresentation> = {}): MayflyComponents {
  const base = probeComponents()
  return Object.assign(Object.create(base) as MayflyComponents, base, { presentation: { glyphs: 'unicode', monochrome: false, reducedMotion: false, ...presentation } })
}

const KEYS = { up: '\x1b[A', down: '\x1b[B', pageUp: '\x1b[5~', pageDown: '\x1b[6~', home: '\x1b[H', end: '\x1b[F', ctrlE: '\x05', esc: '\x1b' }

const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.useRealTimers() })

interface MountOptions {
  readonly width?: number
  readonly rows?: number
  readonly presentation?: Partial<MayflyPresentation>
  readonly escape?: () => void
  readonly completionsOpen?: () => boolean
  readonly clock?: boolean
  /** No interaction model: events reach the compile options' `emit`, as in a plain compile. */
  readonly modelless?: boolean
  readonly counters?: ReturnType<typeof createWorkCounters>
}

/** A focused surface a host republishes: one model and runtime, the node replaced by `publish`. */
function mount(initial: MayflyUiNode, options: MountOptions = {}) {
  const width = options.width ?? 60
  const events: MayflyUiEvent[] = []
  const bridge = { prepare: async () => ({ reply: { kind: 'completed' as const }, publish: () => true }) }
  let revision = 1
  const snapshot = (node: MayflyUiNode) => ({ scope: { kind: 'app' as const, targetId: 'content' }, source: [], revision: revision++, update: { reason: 'data' as const }, node, events: bridge, definition: { onEvent: {} } })
  const model = options.modelless === true ? undefined : new UiSurfaceModel('content', snapshot(initial) as never)
  let plain = initial
  const clock = new UiAnimationClock()
  const runtime = new MayflyUiSurfaceRuntime(model, options.clock === false ? undefined : () => {}, options.clock === false ? undefined : clock)
  disposers.push(() => { runtime.dispose(); model?.dispose(); clock.dispose() })
  const compile = () => {
    const result = compileMayflyUiSurfaceNode(model?.node ?? plain, {
      components: components(options.presentation), colors, getViewport: () => ({ columns: width, rows: options.rows ?? 30 }), screenMode: 'alternate',
      emit: event => events.push(event), contextHints: { enabled: true, focusWithoutControls: true }, surfaceRuntime: runtime,
      ...(options.escape === undefined ? {} : { onUnhandledEscape: options.escape, escapeHint: 'close' as const }),
      ...(options.completionsOpen === undefined ? {} : { completionsOpen: options.completionsOpen }),
      ...(options.counters === undefined ? {} : { counters: options.counters }),
    })
    if (!result.ok) throw new Error(result.message)
    result.value.focusTarget!.focused = true
    return result.value
  }
  let compiled = compile()
  return {
    events,
    runtime,
    render: (): string[] => compiled.component.render(width),
    press: (key: string): void => { compiled.focusTarget!.handleInput?.(key) },
    publish: (node: MayflyUiNode): void => { plain = node; model?.receive(snapshot(node) as never); compiled = compile() },
  }
}

const lines = (count: number): MayflyUiNode => ui.stack.column(Array.from({ length: count }, (_, index) => ui.text(`log line ${String(index + 1)}`)))

describe('surface fields', () => {
  it('words Escape with the surface, and hands it to the host', () => {
    for (const [label, word] of [['close', 'close'], ['back', 'back'], ['cancel', 'cancel'], ['reject', 'reject'], ['leave', 'leave']] as const) {
      const escape = vi.fn()
      const surface = mount(ui.surface({ title: 'Card', chrome: 'overlay', escapeLabel: label, child: ui.text('body') }), { escape })
      expect(surface.render().join('\n')).toContain(`Esc ${word}`)
      surface.press(KEYS.esc)
      expect(escape).toHaveBeenCalledOnce()
    }
  })

  it('keeps the host label when the surface names none, and draws no hint at all with hint none', () => {
    const plain = mount(ui.surface({ title: 'Card', chrome: 'overlay', child: ui.text('body') }), { escape: () => {} })
    expect(plain.render().join('\n')).toContain('Esc close')
    const quiet = mount(ui.surface({ title: 'Card', chrome: 'overlay', hint: 'none', child: ui.text('body') }), { escape: () => {} })
    expect(quiet.render().join('\n')).not.toContain('Esc')
  })

  it('draws the hint of hint completions only while the completion list is open', () => {
    let open = false
    const surface = mount(ui.surface({ title: 'Prompt', chrome: 'overlay', hint: 'completions', child: ui.text('body') }), { escape: () => {}, completionsOpen: () => open })
    expect(surface.render().join('\n')).not.toContain('Esc')
    open = true
    expect(surface.render().join('\n')).toContain('Esc close')
    const absent = mount(ui.surface({ title: 'Prompt', chrome: 'overlay', hint: 'completions', child: ui.text('body') }), { escape: () => {} })
    expect(absent.render().join('\n')).not.toContain('Esc')
  })

  it('paints a right-aligned title at the corner, eliding its start, and a border tone', () => {
    const rows = mount(ui.surface({ title: '~/work/mayfly/packages/mayfly', titleAlign: 'right', chrome: 'surface', border: 'warning', badges: [{ text: 'dirty' }], child: ui.text('body') }), { width: 30 }).render()
    expect(plainText(rows[0]!)).toMatch(/^╭─+ …\S+ ╮$/u)
  })
})

describe('a loader with a cancel', () => {
  it('shows Esc as the hint and fires the cancel from Escape, before the surface closes', () => {
    const escape = vi.fn()
    const surface = mount(ui.surface({ chrome: 'overlay', child: ui.loader({ message: 'Discovering', cancelActionId: 'cancel', cancelLabel: 'Stop now' }) }), { escape, modelless: true })
    expect(surface.render().join('\n')).toContain('Esc stop now')
    surface.press(KEYS.esc)
    expect(surface.events).toEqual([expect.objectContaining({ kind: 'activate', actionId: 'cancel' })])
    expect(escape).not.toHaveBeenCalled()
  })

  it('names the default word, and fires Escape even when the host closes nothing', () => {
    const surface = mount(ui.loader({ message: 'Working', cancelActionId: 'cancel' }), { modelless: true })
    expect(surface.render().join('\n')).toContain('Esc cancel')
    surface.press(KEYS.esc)
    expect(surface.events).toHaveLength(1)
  })
})

describe('the scroll region', () => {
  const region = (count: number, options: Partial<Extract<MayflyUiNode, { readonly kind: 'scroll' }>> = {}): MayflyUiNode => ui.scroll(lines(count), { follow: 'end', height: 4, ...options })
  const body = (rows: readonly string[]): string[] => rows.slice(0, 4).map(row => row.slice(0, -2).trimEnd())

  it('shows its viewport rows and scrolls with the keys, showing the bar while it moves', () => {
    const surface = mount(region(10))
    expect(body(surface.render())).toEqual(['log line 7', 'log line 8', 'log line 9', 'log line 10'])
    // The bar is quiet while the view follows the tail; it shows while the reader scrolls.
    expect(surface.render().some(row => /[░█]$/u.test(row))).toBe(false)
    surface.press(KEYS.up)
    expect(body(surface.render())).toEqual(['log line 6', 'log line 7', 'log line 8', 'log line 9'])
    expect(surface.render().some(row => /[░█]$/u.test(row))).toBe(true)
    surface.press(KEYS.pageUp)
    expect(body(surface.render())[0]).toBe('log line 2')
    surface.press(KEYS.down)
    expect(body(surface.render())[0]).toBe('log line 3')
    surface.press(KEYS.pageDown)
    expect(body(surface.render())[0]).toBe('log line 7')
    surface.press(KEYS.home)
    expect(body(surface.render())[0]).toBe('log line 1')
    surface.press(KEYS.end)
    expect(body(surface.render())[3]).toBe('log line 10')
  })

  it('keeps the place of a scrolled-away view when lines arrive, and shows the pill', () => {
    const surface = mount(region(10, { pill: true }))
    surface.render()
    surface.press(KEYS.up)
    surface.publish(region(13, { pill: true }))
    const rows = surface.render()
    expect(rows[0]).toContain('log line 6')
    expect(rows[3]).toContain('↓ 3 new · End')
    surface.press(KEYS.end)
    expect(surface.render().join('\n')).not.toContain('new · End')
    expect(surface.render()[3]).toContain('log line 13')
  })

  it('shows no pill while nothing new has arrived, and none at the tail', () => {
    const surface = mount(region(10, { pill: true }))
    surface.render()
    surface.press(KEYS.up)
    expect(surface.render().join('\n')).not.toContain('new')
  })

  it('expands with Ctrl+E to expandedHeight and collapses with Escape', () => {
    const surface = mount(region(10, { expandedHeight: 8 }))
    expect(surface.render()).toHaveLength(4 + 1)
    surface.press(KEYS.ctrlE)
    expect(surface.render().length).toBe(8 + 1)
    surface.press(KEYS.esc)
    expect(surface.render()).toHaveLength(4 + 1)
  })

  it('fit shrinks to short content and drops the scrollbar, and grows a bar back once it overflows', () => {
    const surface = mount(region(2, { fit: true, height: 5, follow: 'none' }))
    expect(surface.render().filter(row => row.startsWith('log line')).map(row => row.trimEnd())).toEqual(['log line 1', 'log line 2'])
    surface.publish(region(9, { fit: true, height: 5, follow: 'none' }))
    // The republished surface binds its control on the first paint.
    surface.render()
    // Once the content overflows, moving the view shows the bar again.
    surface.press(KEYS.down)
    expect(surface.render().some(row => /[░█]$/u.test(row))).toBe(true)
    expect(surface.render().filter(row => /[░█]$/u.test(row))).toHaveLength(5)
  })

  it('draws no scrollbar when scrollbar is false, pads a short region, and keeps its place across a republish', () => {
    const surface = mount(region(2, { scrollbar: false, follow: 'none' }))
    expect(surface.render().slice(0, 4).map(row => row.trimEnd())).toEqual(['log line 1', 'log line 2', '', ''])
    const tall = mount(region(10, { follow: 'none' }))
    tall.render()
    tall.press(KEYS.down)
    tall.publish(region(10, { follow: 'none' }))
    expect(tall.render()[0]).toContain('log line 2')
  })

  it('remembers the places of the scroll regions it painted lately, not of every position its tree has had', () => {
    // A region is remembered by its position in the tree, so a tree that grows and loses siblings brings a new position
    // for the same region each time. The memory keeps a bounded number of the latest, more than the regions a live tree
    // (at most 256 nodes) can hold, so the regions of the live tree are always among them.
    const placed = (before: number, inner: number, count = 10): MayflyUiNode => ui.stack.column([
      ...Array.from({ length: before }, () => ui.spacer()),
      ui.stack.column([...Array.from({ length: inner }, () => ui.spacer()), region(count, { follow: 'none' })]),
    ])
    const surface = mount(placed(0, 0))
    for (let before = 0; before < 25; before += 1) for (let inner = 0; inner < 50; inner += 1) surface.publish(placed(before, inner))
    expect(surface.runtime['scrolled'].size).toBeLessThanOrEqual(512)
    // The live region keeps its place across a republish, however many positions came and went before it.
    surface.publish(placed(1, 1))
    surface.render()
    surface.press(KEYS.down)
    surface.publish(placed(1, 1, 12))
    expect(surface.render().filter(row => row.includes('log line')).map(row => row.trim())[0]).toContain('log line 2')
    surface.publish(placed(1, 1, 14))
    expect(surface.render().filter(row => row.includes('log line')).map(row => row.trim())[0]).toContain('log line 2')
  })

  it('works on a narrow width and an id with a document, and counts its rows', () => {
    const counters = createWorkCounters()
    const surface = mount(region(10, { id: 'log' }), { width: 2, counters })
    expect(surface.render()).toHaveLength(4)
    const wide = mount(region(10, { id: 'log' }), { counters })
    wide.render()
    wide.press(KEYS.up)
    wide.press(KEYS.pageUp)
    wide.press(KEYS.home)
    wide.press(KEYS.end)
    expect(wide.render()[3]).toContain('log line 10')
    expect(counters.rowsPainted).toBeGreaterThan(0)
    wide.publish(region(14, { id: 'log' }))
    expect(wide.render()[3]).toContain('log line 14')
    wide.press(KEYS.up)
    wide.publish(region(15, { id: 'log' }))
    expect(wide.render()[3]).not.toContain('log line 15')
  })

  it('stays out of the layout frame, so the surface keeps its natural height', () => {
    const surface = mount(ui.surface({ chrome: 'overlay', child: region(10) }), { rows: 40 })
    expect(surface.render().length).toBeLessThan(10)
  })
})

describe('motion rows', () => {
  const rich = (...spans: Parameters<typeof ui.richText>[0]): MayflyUiNode => ui.richText(spans)

  it('steps a loader cell and a shimmer with the one clock, and stops the clock when nothing moves', () => {
    vi.useFakeTimers()
    const surface = mount(rich({ text: '', motion: 'loader', variant: 'bloom' }, { text: ' Thinking' }))
    expect(surface.render()[0]).toBe('· Thinking')
    vi.advanceTimersByTime(100)
    expect(surface.render()[0]).toBe('✢ Thinking')
    for (const frame of ['✳', '✶']) {
      vi.advanceTimersByTime(100)
      expect(surface.render()[0]).toBe(`${frame} Thinking`)
    }
    surface.publish(ui.text('settled'))
    surface.render()
    vi.advanceTimersByTime(500)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('freezes on the first frame under reduced motion and never arms the clock', () => {
    vi.useFakeTimers()
    const surface = mount(rich({ text: '', motion: 'loader', variant: 'fill' }, { text: ' Working' }, ), { presentation: { reducedMotion: true } })
    expect(surface.render()[0]).toBe('⡀ Working')
    vi.advanceTimersByTime(500)
    expect(surface.render()[0]).toBe('⡀ Working')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('draws the ASCII spinner for a loader cell in ASCII mode, and truncates a shimmering row on request', () => {
    const ascii = mount(rich({ text: '', motion: 'loader' }, { text: ' Loading' }), { presentation: { glyphs: 'ascii' } })
    expect(ascii.render()[0]).toBe('- Loading')
    const label = ui.richText([{ text: 'Running a very long command line', motion: 'shimmer' }], { overflow: 'truncate' })
    expect(mount(label, { width: 12 }).render()[0]!.replaceAll('\x1b[0m', '')).toBe('Running a v…')
    const wrapped = mount(ui.richText([{ text: 'Running a very long command line', motion: 'shimmer' }]), { width: 12 })
    expect(wrapped.render().length).toBeGreaterThan(1)
  })

  it('paints a motion row without a clock as its first frame', () => {
    const surface = mount(rich({ text: '', motion: 'loader' }, { text: ' Idle' }), { clock: false })
    expect(surface.render()[0]).toBe('⣾ Idle')
  })
})

describe('a bar with a transition', () => {
  const bar = (rev: number): MayflyUiNode => ui.progress({ value: 10, max: 100, style: 'cells', width: 10, showCount: false, showPercent: true, transition: { from: 90, ms: 400, rev } })

  it('drains with the clock, then holds still and stops the clock', () => {
    vi.useFakeTimers()
    const surface = mount(bar(1))
    expect(surface.render()[0]).toBe('▰▰▰▰▰▰▰▰▰▱ 90%')
    for (const shown of ['70', '50', '30', '10']) {
      vi.advanceTimersByTime(100)
      expect(surface.render()[0]).toBe(`${'▰'.repeat(Number(shown) / 10)}${'▱'.repeat(10 - Number(shown) / 10)} ${shown}%`)
    }
    vi.advanceTimersByTime(300)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts again for a new revision and shows the settled value without a clock or under reduced motion', () => {
    vi.useFakeTimers()
    const surface = mount(bar(1))
    for (let step = 0; step < 5; step += 1) { surface.render(); vi.advanceTimersByTime(100) }
    surface.render()
    surface.publish(bar(2))
    expect(surface.render()[0]).toBe('▰▰▰▰▰▰▰▰▰▱ 90%')
    expect(mount(bar(1), { clock: false }).render()[0]).toBe('▰▱▱▱▱▱▱▱▱▱ 10%')
    expect(mount(bar(1), { presentation: { reducedMotion: true } }).render()[0]).toBe('▰▱▱▱▱▱▱▱▱▱ 10%')
  })
})

describe('content nodes in a plain compile', () => {
  const paint = (node: MayflyUiNode, width = 40): string[] => {
    const result = compileMayflyUiNode(node, { emit: () => {}, components: components(), colors, getViewport: () => ({ columns: width, rows: 20 }), screenMode: 'alternate' })
    if (!result.ok) throw new Error(result.message)
    return result.value.component.render(width)
  }

  it('moves a bounded leaf\'s elision row with the viewport height, both ways', () => {
    // Outside a scroll the alternate screen bounds a leaf to the viewport plus `… N more rows`, and the focused action
    // below it keeps the end of the leaf on screen. The leaf is compiled once; its rows must follow the viewport each
    // frame reports, not the one it was first painted at.
    const viewport = { columns: 40, rows: 6 }
    const runtime = new MayflyUiSurfaceRuntime()
    disposers.push(() => { runtime.dispose() })
    const result = compileMayflyUiSurfaceNode(ui.stack.column([
      ui.text(Array.from({ length: 100 }, (_, index) => `line ${String(index)}`).join('\n')),
      ui.actions({ id: 'act', items: [{ id: 'ok', label: 'OK' }] }),
    ]), { components: components(), colors, getViewport: () => viewport, screenMode: 'alternate', emit: () => {}, surfaceRuntime: runtime })
    if (!result.ok) throw new Error(result.message)
    result.value.focusTarget!.focused = true
    const frame = (rows: number): string[] => { viewport.rows = rows; return [...result.value.component.render(40)].map(row => row.trim()) }
    const elisions = (rows: readonly string[]): string[] => rows.filter(row => row.includes('more rows'))
    expect(elisions(frame(6))).toEqual(['… +94 more rows'])
    const grown = frame(9)
    expect(elisions(grown)).toEqual(['… +91 more rows'])
    expect(grown).toContain('line 8')
    expect(elisions(frame(4))).toEqual(['… +96 more rows'])
    expect(elisions(frame(6))).toEqual(['… +94 more rows'])
  })

  it('draws the main-screen scroll as its child, and a declared viewport in the alternate screen', () => {
    const main = compileMayflyUiNode(ui.scroll(lines(3), { height: 2 }), { emit: () => {}, components: components(), colors, getViewport: () => ({ columns: 20, rows: 20 }), screenMode: 'main' })
    if (!main.ok) throw new Error(main.message)
    expect([...main.value.component.render(20)]).toEqual(['log line 1', 'log line 2', 'log line 3'])
    expect(paint(ui.scroll(lines(3), { height: 2, scrollbar: false }), 20).map(row => row.trimEnd())).toEqual(['log line 1', 'log line 2'])
  })

  it('leaves a main-mode render a facade, painting only the rows a consumer reads', () => {
    const counters = createWorkCounters()
    const compile = (node: MayflyUiNode) => {
      const result = compileMayflyUiNode(node, { emit: () => {}, components: components(), colors, getViewport: () => ({ columns: 80, rows: 20 }), screenMode: 'main', counters })
      if (!result.ok) throw new Error(result.message)
      return result.value.component
    }
    const after = Array.from({ length: 25000 }, (_, index) => `line ${index} content`).join('\n')
    const rendered = compile(ui.sections([{ title: 'f', body: ui.diff('', after) }])).render(80)
    expect(rendered.length).toBeGreaterThan(25000)
    expect(counters.rowsPainted).toBe(0)
    const window = rendered.slice(0, 11)
    expect(counters.rowsPainted).toBeLessThan(200)
    expect(window[0]).toContain('f')
    const markdown = compile(ui.markdown(`# T\n\n${Array.from({ length: 5000 }, (_, index) => `paragraph ${index} `.repeat(4)).join('\n\n')}`)).render(80)
    expect(counters.rowsPainted).toBeLessThan(200)
    expect(markdown.length).toBeGreaterThan(5000)
    markdown.slice(0, 5)
    expect(counters.rowsPainted).toBeLessThan(400)
  })
})

describe('smaller seams', () => {
  it('admits a child without a priority beside prioritized ones, and draws a child that paints no row', () => {
    const surface = mount(ui.stack.row([
      ui.child(ui.richText([{ text: 'fixed' }])),
      ui.child(ui.text(''), { priority: 1 }),
      ui.child(ui.richText([{ text: 'late' }]), { priority: 2 }),
    ]))
    expect(surface.render()[0]!.replaceAll('\x1b[0m', '').trimEnd()).toBe('fixed    late')
  })

  it('gives a scroll that only asks for a pill the default viewport of six rows', () => {
    expect(mount(ui.scroll(lines(20), { pill: true, follow: 'none', scrollbar: false })).render().filter(row => row.startsWith('log line'))).toHaveLength(6)
  })

  it('draws the hint row of hint completions around an expanded layout scroll only while the list is open', () => {
    let open = false
    const surface = mount(ui.surface({ chrome: 'overlay', hint: 'completions', child: ui.scroll(lines(40)) }), { escape: () => {}, completionsOpen: () => open, rows: 12 })
    surface.render()
    surface.press(KEYS.ctrlE)
    expect(surface.render().join('\n')).not.toContain('collapse')
    open = true
    expect(surface.render().join('\n')).toContain('collapse')
  })

  it('invalidates the child of a scroll region', () => {
    const invalidate = vi.fn()
    const region = new ScrollRegion({
      child: { render: () => ['x'], invalidate }, memory: { offset: 0, following: undefined, away: 0 }, height: 2, expandedHeight: 4, fit: false, pill: false, follow: false,
      scrollbar: true, more: false, expanded: () => false, colors, components: probeComponents(), pillText: String, moreText: String, repaint: () => {},
    })
    region.invalidate()
    region.setScrollbarActive(true)
    expect(invalidate).toHaveBeenCalledOnce()
    expect(region.render(10)).toHaveLength(2)
  })
})
