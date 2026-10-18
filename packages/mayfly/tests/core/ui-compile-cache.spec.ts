/** The compile memo: a static leaf keeps its component across passes and follows the newest surface. */
import { describe, expect, it, vi } from 'vitest'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { MayflyCompileCache, type PaintOptions } from '../../src/core/ui-compile-cache.ts'
import {
  MayflyUiSurfaceRuntime,
  compileMayflyUiNode,
  compileMayflyUiSurfaceNode,
} from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel, type UiSurfaceSnapshot } from '../../src/core/ui-interaction-surface.ts'
import { createAdmissionCache } from '../../src/core/ui-validator.ts'
import type { MayflyComponent, MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { plainColors } from '../helpers.ts'

const colors = plainColors()
const components = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth, sliceByColumn } as unknown as MayflyComponents

const paint = (extra: Partial<PaintOptions> = {}): PaintOptions => ({ components, colors, reportRuntimeFailure: () => {}, ...extra })
const leaf = (): MayflyComponent => ({ render: () => ['x'], invalidate: () => {} })

describe('MayflyCompileCache', () => {
  it('hands a leaf back in a later pass, re-pointed at the newest surface', () => {
    const cache = new MayflyCompileCache()
    const node = {}
    const first = vi.fn()
    const second = vi.fn()
    let built: PaintOptions | undefined
    cache.beginPass()
    const component = cache.keep(node, paint({ reportRuntimeFailure: first }), options => { built = options; return leaf() })
    cache.beginPass()
    expect(cache.take(node, paint({ reportRuntimeFailure: second }))).toBe(component)
    built!.reportRuntimeFailure('boom')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('boom')
  })

  it('never lends one leaf twice in a pass, and keeps the first of two occurrences', () => {
    const cache = new MayflyCompileCache()
    const node = {}
    cache.beginPass()
    const first = cache.keep(node, paint(), leaf)
    expect(cache.take(node, paint())).toBeUndefined()
    const second = cache.keep(node, paint(), leaf)
    expect(second).not.toBe(first)
    cache.beginPass()
    expect(cache.take(node, paint())).toBe(first)
  })

  it('answers nothing for an unknown node or for colors and components it was not built for', () => {
    const cache = new MayflyCompileCache()
    const node = {}
    cache.beginPass()
    cache.keep(node, paint(), leaf)
    cache.beginPass()
    expect(cache.take({}, paint())).toBeUndefined()
    expect(cache.take(node, paint({ colors: { ...colors } as MayflySemanticColors }))).toBeUndefined()
    expect(cache.take(node, paint({ components: { ...components } as MayflyComponents }))).toBeUndefined()
    expect(cache.take(node, paint())).toBeDefined()
  })

  it('replaces an entry that an earlier pass left behind', () => {
    const cache = new MayflyCompileCache()
    const node = {}
    cache.beginPass()
    cache.keep(node, paint(), leaf)
    cache.beginPass()
    const rebuilt = cache.keep(node, paint({ colors: { ...colors } as MayflySemanticColors }), leaf)
    cache.beginPass()
    expect(cache.take(node, paint({ colors: { ...colors } as MayflySemanticColors }))).toBeUndefined()
    expect(cache.take(node, paint())).not.toBe(rebuilt)
  })
})

describe('leaf reuse in the compiler', () => {
  const viewport = { getViewport: () => ({ columns: 80, rows: 24 }), bounded: true }

  it('compiles an unchanged bounded entry once and keeps its leaf across passes', () => {
    const admission = createAdmissionCache()
    const reuse = new MayflyCompileCache()
    const keep = vi.spyOn(reuse, 'keep')
    const entry = ui.richText([{ text: 'branch ' }, { text: 'main', tone: 'muted' }])
    const publish = (tail: string) => {
      const result = compileMayflyUiNode(ui.stack.row([ui.child(entry), ui.child(ui.text(tail))]), { components, colors, ...viewport, admission, reuse, emit: () => {} })
      if (!result.ok) throw new Error(result.message)
      const rows = result.value.component.render(80)
      return { rows }
    }
    publish('a')
    const coldBuilds = keep.mock.calls.length
    const warm = publish('b')
    expect(keep.mock.calls.length - coldBuilds, 'the changed text alone').toBe(1)
    expect(warm.rows.join('\n')).toContain('branch main')
    expect(warm.rows.join('\n')).toContain('b')
  })

  it('does not share a leaf between two surfaces, and a repeated node paints in both places', () => {
    const shared = ui.text('same')
    const compile = (node: ReturnType<typeof ui.stack.column>) => {
      const result = compileMayflyUiNode(node, { components, colors, ...viewport, emit: () => {} })
      if (!result.ok) throw new Error(result.message)
      return result.value.component.render(80).join('\n')
    }
    expect(compile(ui.stack.column([ui.child(shared), ui.child(shared)])).match(/same/g)).toHaveLength(2)
    expect(compile(ui.stack.column([ui.child(shared)]))).toContain('same')
  })

  it('reuses leaves across the publishes of one surface through its runtime', () => {
    const events = { prepare: async () => ({ reply: { kind: 'completed' as const }, publish: () => true }) }
    const heading = ui.text('Heading')
    const snapshot = (revision: number, tail: string): UiSurfaceSnapshot => ({
      id: 's', node: ui.stack.column([ui.child(heading), ui.child(ui.text(tail))]), revision, source: [], scope: { kind: 'app', targetId: 's' }, update: { reason: 'data' }, events, definition: { onEvent: {} },
    } as unknown as UiSurfaceSnapshot)
    const model = new UiSurfaceModel('s', snapshot(1, 'one'))
    const runtime = new MayflyUiSurfaceRuntime(model, () => {})
    const keep = vi.spyOn(runtime.reuse, 'keep')
    const compile = () => {
      const result = compileMayflyUiSurfaceNode(model.node!, { components, colors, ...viewport, emit: () => {}, surfaceRuntime: runtime })
      if (!result.ok) throw new Error(result.message)
      return result.value.component.render(80).join('\n')
    }
    expect(compile()).toContain('Heading')
    expect(keep).toHaveBeenCalledTimes(2)
    keep.mockClear()
    model.receive(snapshot(2, 'two'))
    expect(compile()).toContain('two')
    expect(keep.mock.calls.length, 'the new tail, not the heading').toBe(1)
    runtime.dispose()
    model.dispose()
  })
})

describe('key hint memo', () => {
  const viewport = { getViewport: () => ({ columns: 80, rows: 24 }), bounded: true }
  const events = { prepare: async () => ({ reply: { kind: 'completed' as const }, publish: () => true }) }

  function hinted() {
    const node = ui.form({ id: 'f', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] })
    const model = new UiSurfaceModel('hint', { id: 'hint', node, revision: 1, source: [], scope: { kind: 'app', targetId: 'hint' }, update: { reason: 'data' }, events, definition: { onEvent: {} } } as unknown as UiSurfaceSnapshot)
    const runtime = new MayflyUiSurfaceRuntime(model, () => {})
    const compile = (palette: MayflySemanticColors) => {
      const result = compileMayflyUiSurfaceNode(model.node!, { components, colors: palette, ...viewport, emit: () => {}, contextHints: { enabled: true }, surfaceRuntime: runtime })
      if (!result.ok) throw new Error(result.message)
      result.value.focusTarget!.focused = true
      return result.value
    }
    return { compile, dispose: () => { runtime.dispose(); model.dispose() } }
  }

  it('paints an unchanged hint once, again when the hint changes, and again for a new palette', () => {
    const { compile, dispose } = hinted()
    const compiled = compile(colors)
    const first = compiled.component.render(80)
    expect(first.at(-1)).toContain('Enter')
    compiled.component.invalidate?.()
    const again = compiled.component.render(80)
    expect(again.at(-1), 'the same hint is not painted again').toBe(first.at(-1))
    compiled.focusTarget!.handleInput!('\r')
    const editing = compiled.component.render(80)
    expect(editing.at(-1)).not.toBe(first.at(-1))
    let reads = 0
    const base = plainColors()
    const fresh = Object.fromEntries(Object.entries(base).map(([key, value]) => [key, typeof value === 'function'
      ? (...args: unknown[]) => { reads += 1; return (value as (...values: unknown[]) => unknown)(...args) }
      : value])) as unknown as MayflySemanticColors
    const recoloured = compile(fresh)
    recoloured.component.render(80)
    expect(reads, 'a new palette never serves the old row').toBeGreaterThan(0)
    dispose()
  })
})
