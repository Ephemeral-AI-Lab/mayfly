/** The compiled surface under a presentation: ASCII glyphs on painted rows, never on typed text, and reduced motion. */
import { describe, expect, it, vi } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { compileMayflyUiNode, MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { UiAnimationClock } from '../../src/core/ui-loader-animation.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import type { MayflyPresentation } from '../../src/core/presentation.ts'
import { parityComponents } from '../design/parity.ts'

const identity = (value: string): string => value
const colors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as MayflySemanticColors

function components(presentation: Partial<MayflyPresentation>): MayflyComponents {
  const base = parityComponents()
  return Object.assign(Object.create(base) as MayflyComponents, base, { presentation: { glyphs: 'unicode', monochrome: false, reducedMotion: false, ...presentation } })
}

function render(node: unknown, presentation: Partial<MayflyPresentation>, width = 40): string[] {
  const result = compileMayflyUiNode(node, { components: components(presentation), colors, getViewport: () => ({ columns: width, rows: 20 }), screenMode: 'alternate' })
  if (!result.ok) throw new Error(result.message)
  return result.value.component.render(width)
}

describe('glyph mode on compiled surfaces', () => {
  it('paints the one-cell fallback in ASCII mode and the vocabulary otherwise', () => {
    const node = ui.stack.column([ui.divider({ label: 'Rule' }), ui.text('✓ done → next'), ui.markdown('- item'), ui.diagram('flowchart LR\n  a --> b')])
    const unicode = render(node, {})
    const ascii = render(node, { glyphs: 'ascii' })
    expect(unicode[0]).toContain('─')
    expect(unicode.join('\n')).toContain('✓ done → next')
    expect(ascii[0]).not.toContain('─')
    expect(ascii[0]).toContain('-')
    expect(ascii.join('\n')).toContain('v done > next')
    expect(ascii.map(row => row.length)).toEqual(unicode.map(row => row.length))
  })
})

describe('loader motion', () => {
  function loaderSurface(presentation: Partial<MayflyPresentation>): { render: () => string[], clock: UiAnimationClock, dispose: () => void } {
    const model = new UiSurfaceModel('loader', {
      scope: { kind: 'app', targetId: 'loader' }, source: [], revision: 1, update: { reason: 'data' },
      node: ui.loader({ message: 'Loading' }) as never,
      events: { prepare: async () => ({ reply: { kind: 'completed' as const }, publish: () => true }) },
      definition: { onEvent: {} },
    } as never)
    const clock = new UiAnimationClock()
    const runtime = new MayflyUiSurfaceRuntime(model, () => {}, clock)
    const result = compileMayflyUiSurfaceNode(model.node!, { components: components(presentation), colors, getViewport: () => ({ columns: 30, rows: 5 }), screenMode: 'alternate', surfaceRuntime: runtime })
    if (!result.ok) throw new Error(result.message)
    return { render: () => result.value.component.render(30), clock, dispose: () => { runtime.dispose(); model.dispose() } }
  }

  it('freezes on the first frame and never arms the clock under reduced motion', () => {
    vi.useFakeTimers()
    try {
      const frozen = loaderSurface({ reducedMotion: true })
      expect(frozen.render()[0]).toBe('⠋ Loading')
      vi.advanceTimersByTime(400)
      expect(frozen.render()[0]).toBe('⠋ Loading')
      expect(vi.getTimerCount()).toBe(0)
      frozen.dispose()
      const moving = loaderSurface({ glyphs: 'ascii' })
      expect(moving.render()[0]).toBe('- Loading')
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(80)
      expect(moving.render()[0]).toBe('\\ Loading')
      moving.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
