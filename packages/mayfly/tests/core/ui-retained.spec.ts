/**
 * Retained rows (roadmap slice 1.12c): a compiled component paints once per width until the surface's epoch moves or,
 * when it holds a moving cell, until the clock does; what reads untracked state is never remembered; and the clock
 * follows a moving cell only while the cell can be on screen.
 */
import type { Component } from '@earendil-works/pi-tui'
import { renderLayoutFrame, type LayoutFrame } from '@earendil-works/pi-tui/dist/layout.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode, type MayflyUiCompilerOptions } from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { LOADER_FRAME_MS, UiAnimationClock } from '../../src/core/ui-loader-animation.ts'
import type { MayflyKeymap, MayflySemanticColors } from '../../src/core/types.ts'
import { createWorkCounters } from '../../src/core/ui-work-counters.ts'
import { PROBE_PALETTE, parityComponents } from '../design/parity.ts'

const KEY = { down: '\x1b[B' } as const
const cleanups: (() => void)[] = []
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
})

interface Opened {
  readonly counters: ReturnType<typeof createWorkCounters>
  readonly model: UiSurfaceModel
  readonly runtime: MayflyUiSurfaceRuntime
  readonly component: Component
  readonly requestRender: ReturnType<typeof vi.fn>
  readonly requestFrame: ReturnType<typeof vi.fn>
  readonly viewport: { columns: number, rows: number }
  /** How many leaves painted during `step`. */
  paints(step: () => void): number
  /** pi-tui laying the surface out itself, as it does for a pane: every component is asked to render, every frame. */
  layout(width?: number, height?: number): LayoutFrame
  press(...keys: string[]): void
  publish(node: MayflyUiNode): void
}

function open(node: MayflyUiNode, extra: Partial<MayflyUiCompilerOptions> = {}): Opened {
  const counters = createWorkCounters()
  const viewport = { columns: 60, rows: 12 }
  let revision = 1
  const events = { prepare: async () => ({ reply: { kind: 'completed' as const }, publish: () => true }) }
  const snapshot = (value: MayflyUiNode) => ({
    id: 'retained', scope: { kind: 'app', targetId: 'retained' }, source: [], revision, update: { reason: 'data' }, node: value, events, definition: { onEvent: {} },
  }) as never
  const model = new UiSurfaceModel('retained', snapshot(node))
  const requestRender = vi.fn()
  const requestFrame = vi.fn()
  const clock = new UiAnimationClock(counters)
  const runtime = new MayflyUiSurfaceRuntime(model, requestRender, clock, undefined, requestFrame)
  const compile = (): Component => {
    const result = compileMayflyUiSurfaceNode(model.node!, {
      components: parityComponents(), colors: PROBE_PALETTE, getViewport: () => viewport, screenMode: 'alternate',
      // Paint counts are the subject here, so verification (which paints again on every hit) is on only where a case asks.
      emit: () => {}, contextHints: { enabled: true }, surfaceRuntime: runtime, counters, verifyRetained: false, ...extra,
    })
    if (!result.ok) throw new Error(result.message)
    if (result.value.focusTarget !== null) result.value.focusTarget.focused = true
    focus = result.value.focusTarget
    return result.value.component as Component
  }
  let focus: { handleInput?(data: string): void } | null = null
  let component = compile()
  cleanups.push(() => { clock.dispose(); runtime.dispose(); model.dispose() })
  return {
    counters, model, runtime, requestRender, requestFrame, viewport,
    get component() { return component },
    paints(step) {
      const before = counters.componentRenders
      step()
      return counters.componentRenders - before
    },
    layout: (width = viewport.columns, height = viewport.rows) => renderLayoutFrame(component, width, height, () => {}),
    press(...keys) { for (const key of keys) focus?.handleInput?.(key) },
    publish(value) {
      revision += 1
      model.receive(snapshot(value))
      component = compile()
    },
  }
}

const list = (id = 'rows'): MayflyUiNode => ui.list({ id, role: 'browse', selectedIds: [], items: ['a', 'b', 'c'].map(item => ({ id: item, label: item.toUpperCase() })) })
const panel = (): MayflyUiNode => ui.stack.column([
  ui.child(ui.tabs({ id: 'tabs', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] })),
  ui.child(ui.stack.row([ui.child(ui.text('left')), ui.child(list(), { grow: 1 })], { gap: 1 })),
  ui.child(ui.surface({ chrome: 'surface', padding: 1, title: 'Card', child: ui.progress({ label: 'Done', value: 2, max: 5 }) })),
])

describe('retained rows', () => {
  it('paints nothing for a frame in which nothing changed', () => {
    const view = open(panel())
    expect(view.paints(() => { view.layout() })).toBeGreaterThan(0)
    expect(view.paints(() => { view.layout() })).toBe(0)
    expect(view.paints(() => { view.layout(); view.layout() })).toBe(0)
    const rows = view.layout().lines
    expect(rows.join('\n')).toContain('Card')
    expect(view.layout().lines).toEqual(rows)
  })

  it('paints again after everything that can change a row', () => {
    const keymap = { revision: 1, getKeys: () => [], matches: () => false } as unknown as MayflyKeymap & { revision: number }
    let completions = false
    const view = open(panel(), { keymap, completionsOpen: () => completions })
    const repainted = (change: () => void): boolean => {
      view.layout()
      expect(view.paints(() => { view.layout() }), 'steady before the change').toBe(0)
      change()
      return view.paints(() => { view.layout() }) > 0
    }
    expect(repainted(() => { view.press('x') }), 'a key').toBe(true)
    expect(repainted(() => { view.component.invalidate() }), 'an invalidation').toBe(true)
    expect(repainted(() => { view.viewport.columns = 50 }), 'a new viewport').toBe(true)
    expect(repainted(() => { keymap.revision += 1 }), 'a rebound key').toBe(true)
    expect(repainted(() => { completions = true }), 'the completion list').toBe(true)
    expect(repainted(() => { view.model.updateChoice({ pagePath: [], controlId: 'rows' }, { kind: 'query', query: 'a' }) }), 'a model revision').toBe(true)
    expect(repainted(() => { view.publish(panel()) }), 'a new compile').toBe(true)
    const focus = view.component as Component & { focused: boolean, restoreFocusIdentity(identity: { controlId: string, pagePath: readonly string[], itemId: string }): boolean }
    expect(repainted(() => { focus.focused = false }), 'losing focus').toBe(true)
    expect(repainted(() => { focus.restoreFocusIdentity({ controlId: 'rows', pagePath: [], itemId: 'a' }) }), 'a restored focus').toBe(true)
  })

  it('remembers six combinations of width and viewport and paints the oldest again once a seventh arrives', () => {
    const view = open(ui.tabs({ id: 'tabs', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }))
    for (const width of [40, 41, 42, 43, 44, 45]) view.layout(width)
    // The hint row keeps one width of its own and paints at every change of width; the tabs do not.
    const hintAlone = view.paints(() => { view.layout(40) })
    expect(view.paints(() => { view.layout(41) })).toBe(hintAlone)
    view.layout(46)
    expect(view.paints(() => { view.layout(41) })).toBe(hintAlone)
    // The first width was dropped to make room for the seventh.
    expect(view.paints(() => { view.layout(40) })).toBe(hintAlone + 1)
  })

  it('throws when verification finds rows that changed without moving the epoch', () => {
    let saves = 0
    const form = ui.form({ id: 'f', submitActionId: 'save', fields: [{ id: 'one', kind: 'toggle', label: 'One', value: false }, { id: 'two', kind: 'toggle', label: 'Two', value: true }] })
    const stale = open(form, { verifyRetained: true, contextHints: { enabled: true, translate: key => key === 'Save' ? `Save ${String(saves++)}` : key } })
    // One frame asks for the submit row twice, to measure it and to lay it out: the second answer is checked.
    expect(() => stale.layout()).toThrow(/retained rows of a form submit went stale/u)
    // The same surface is quiet when what it reads is stable, and unverified it shows the remembered rows.
    const steady = open(panel(), { verifyRetained: true })
    steady.layout()
    expect(() => steady.layout()).not.toThrow()
    const unverified = open(form, { verifyRetained: false, contextHints: { enabled: true, translate: key => key === 'Save' ? `Save ${String(saves++)}` : key } })
    const first = unverified.layout().lines
    expect(unverified.layout().lines).toEqual(first)
  })

  it('never remembers a live prompt, nor the stack around it, and still remembers its sibling', () => {
    const view = open(ui.stack.column([ui.child(list()), ui.child(ui.prompt({ id: 'ask', placeholder: ['Ask'] }))]))
    view.layout()
    // The prompt paints on every frame, for the stack that measures it and for the layout; the list beside it does not.
    const listPaints = view.counters.rowsPainted
    expect(view.paints(() => { view.layout() })).toBe(2)
    expect(view.paints(() => { view.layout() })).toBe(2)
    expect(view.counters.rowsPainted - listPaints).toBe(4)
  })

  it('reports a failed paint on every frame instead of remembering it', () => {
    let paints = 0
    const fail = (): string => { paints += 1; throw new Error('palette failed') }
    const failing = Object.fromEntries(Object.keys(PROBE_PALETTE).map(token => [token, token === 'logoGradient' ? PROBE_PALETTE.logoGradient : fail])) as unknown as MayflySemanticColors
    const view = open(ui.loader({ message: 'Working' }), { colors: failing })
    view.layout()
    const first = paints
    expect(first).toBeGreaterThan(0)
    view.layout()
    expect(paints).toBeGreaterThan(first)
    expect(view.layout().lines.join('\n')).toContain('palette failed')
  })
})

describe('moving cells', () => {
  it('repaints the moving cell alone on a clock tick, and holds the rest', () => {
    const view = open(ui.stack.column([ui.child(ui.loader({ message: 'Working' })), ui.child(panel()), ui.child(ui.richText([{ text: 'shimmering', motion: 'shimmer' }]))]))
    view.layout()
    view.layout()
    expect(vi.getTimerCount(), 'one timer for the surface').toBe(1)
    expect(view.paints(() => { view.layout() })).toBe(0)
    vi.advanceTimersByTime(LOADER_FRAME_MS)
    // The tick asks for a frame and nothing else: an invalidation would repaint every row.
    expect(view.requestFrame).toHaveBeenCalledTimes(1)
    expect(view.requestRender).not.toHaveBeenCalled()
    expect(view.counters.clockTicks).toBe(1)
    const moved = view.paints(() => { view.layout() })
    expect(moved).toBeGreaterThan(0)
    expect(moved).toBeLessThanOrEqual(4)
    // Showing the same frame again paints nothing and keeps the surface on the clock.
    expect(view.paints(() => { view.layout() })).toBe(0)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('leaves the clock alone while the only moving cell is below the fold, and joins it when the cell scrolls in', () => {
    const view = open(ui.scroll(ui.stack.column([...Array.from({ length: 30 }, (_, index) => ui.child(ui.text(`row ${String(index)}`))), ui.child(ui.loader({ message: 'Working' }))]), { scrollbar: true }))
    // The first frame cannot know where the cell is and arms the clock; the frame its tick asks for knows.
    view.layout()
    vi.advanceTimersByTime(LOADER_FRAME_MS)
    view.layout()
    expect(vi.getTimerCount()).toBe(0)
    view.layout()
    vi.advanceTimersByTime(LOADER_FRAME_MS * 5)
    expect(view.requestFrame).toHaveBeenCalledTimes(1)
    const scroll = view.layout().primaryScrollView!
    scroll.scrollToEnd()
    view.layout()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(LOADER_FRAME_MS)
    expect(view.requestFrame).toHaveBeenCalledTimes(2)
    view.layout()
    expect(vi.getTimerCount()).toBe(1)
    // Scrolled away again, the next frame lets the clock stop.
    scroll.scrollToStart()
    vi.advanceTimersByTime(LOADER_FRAME_MS)
    view.layout()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('arms the clock at once for a cell painted outside any retained render, and ticks through the render request by default', () => {
    const requestRender = vi.fn()
    const runtime = new MayflyUiSurfaceRuntime(undefined, requestRender)
    cleanups.push(() => { runtime.dispose() })
    expect(runtime.loaderFrame()).toBe(0)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(LOADER_FRAME_MS)
    expect(requestRender).toHaveBeenCalledTimes(1)
    expect(runtime.loaderFrame()).toBe(1)
    // Marks left outside a render have nothing to mark.
    runtime.markVolatile()
    runtime.showMoving(new Map())
    expect(new MayflyUiSurfaceRuntime().loaderFrame()).toBe(0)
  })
})
