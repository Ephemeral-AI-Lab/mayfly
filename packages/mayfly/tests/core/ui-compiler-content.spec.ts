/** Compiled content, layout, and motion (slice 1.3): the surface chrome fields, a loader's Escape, the scroll region, motion rows, and a draining bar. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ui, type MayflyUiEvent, type MayflyUiNode } from '../../../ui/src/index.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiNode, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { UiAnimationClock } from '../../src/core/ui-loader-animation.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import type { MayflyPresentation } from '../../src/core/presentation.ts'
import { createWorkCounters } from '../../src/core/ui-work-counters.ts'
import { parityComponents } from '../design/parity.ts'

const identity = (value: string): string => value
const colors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as MayflySemanticColors

function components(presentation: Partial<MayflyPresentation> = {}): MayflyComponents {
  const base = parityComponents()
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
      ...(options.escape === undefined ? {} : { onUnhandledEscape: options.escape }),
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
      expect(surface.render().at(-2)).toContain(`Esc ${word}`)
      surface.press(KEYS.esc)
      expect(escape).toHaveBeenCalledOnce()
    }
  })

  it('keeps the host label when the surface names none, and draws no hint at all with hint none', () => {
    const plain = mount(ui.surface({ title: 'Card', chrome: 'overlay', child: ui.text('body') }), { escape: () => {} })
    expect(plain.render().at(-2)).toContain('Esc close')
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
    expect(rows[0]!.replace(/\x1b\[[0-9;]*m/gu, '')).toMatch(/^╭─+ …\S+ ╮$/u)
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

  it('shows its viewport rows with a scrollbar, follows the tail, and scrolls with the keys', () => {
    const surface = mount(region(10))
    expect(body(surface.render())).toEqual(['log line 7', 'log line 8', 'log line 9', 'log line 10'])
    expect(surface.render()[3]!.endsWith('█')).toBe(true)
    surface.press(KEYS.up)
    expect(body(surface.render())).toEqual(['log line 6', 'log line 7', 'log line 8', 'log line 9'])
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
    expect(surface.render()[0]).toMatch(/░|█/u)
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
    const result = compileMayflyUiNode(node, { components: components(), colors, getViewport: () => ({ columns: width, rows: 20 }), screenMode: 'alternate' })
    if (!result.ok) throw new Error(result.message)
    return result.value.component.render(width)
  }

  it('draws the main-screen scroll as its child, and a declared viewport in the alternate screen', () => {
    const main = compileMayflyUiNode(ui.scroll(lines(3), { height: 2 }), { components: components(), colors, getViewport: () => ({ columns: 20, rows: 20 }), screenMode: 'main' })
    if (!main.ok) throw new Error(main.message)
    expect(main.value.component.render(20)).toEqual(['log line 1', 'log line 2', 'log line 3'])
    expect(paint(ui.scroll(lines(3), { height: 2, scrollbar: false }), 20).map(row => row.trimEnd())).toEqual(['log line 1', 'log line 2'])
  })
})
