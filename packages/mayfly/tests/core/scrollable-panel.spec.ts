/** Core-owned framed scrolling panel behavior and lifecycle. */

import { describe, expect, it, vi } from 'vitest'
import { ScrollablePanel } from '../../src/core/scrollable-panel.ts'
import type { MayflyComponent } from '../../src/core/types.ts'
import { FakeMayflyComponents, FakeScreen, FakeTheme } from '../interaction/fakes.ts'

function plain(rows: readonly string[]): string[] {
  return rows.map(row => row.replace(/\x1b\[[0-9;]*m/gu, '').replace(/[~^#!?@%]/gu, ''))
}

describe('ScrollablePanel', () => {
  it('frames, scrolls, anchors new rows, and closes through core key decoding', () => {
    const screen = new FakeScreen()
    screen.rows = 10
    const rows = Array.from({ length: 10 }, (_, index) => `row ${String(index)}`)
    const body = {
      render: () => [...rows],
      invalidate: vi.fn(),
    }
    const close = vi.fn()
    const panel = new ScrollablePanel({
      screen,
      components: new FakeMayflyComponents(),
      colors: new FakeTheme().colors,
      body,
      title: () => 'Transcript',
      hint: () => 'read-only',
      footer: () => ['keys'],
      onClose: close,
    })
    panel.focused = true
    expect(panel.focused).toBe(true)
    expect(plain(panel.render(20)).join('\n')).toContain('row 9')

    panel.handleInput('\x1b[A')
    expect(plain(panel.render(20)).join('\n')).toContain('row 4')
    panel.handleInput('\x1b[B')
    expect(plain(panel.render(20)).join('\n')).toContain('row 9')
    panel.handleInput('\x1b[5~')
    expect(plain(panel.render(20)).join('\n')).toContain('row 1')
    panel.handleInput('\x1b[6~')
    expect(plain(panel.render(20)).join('\n')).toContain('row 9')
    panel.handleInput('\x1b[H')
    expect(plain(panel.render(20)).join('\n')).toContain('row 0')
    panel.handleInput('\x1b[H')

    rows.push('row 10')
    const anchored = plain(panel.render(20)).join('\n')
    expect(anchored).toContain('row 0')
    expect(anchored).not.toContain('row 10')
    panel.handleInput('\x1b[F')
    expect(plain(panel.render(20)).join('\n')).toContain('row 10')
    panel.handleInput('x')
    panel.handleInput('\x1b')
    expect(close).toHaveBeenCalledOnce()
    expect(screen.renderRequests).toBeGreaterThan(0)

    panel.invalidate()
    expect(body.invalidate).toHaveBeenCalledOnce()
    expect(panel.render(4)).toEqual([])
  })

  it('uses fallback row budgets, sanitizes chrome, clips body rows, and disposes once', () => {
    const screen = new FakeScreen()
    screen.rows = Number.NaN
    const dispose = vi.fn()
    const body: MayflyComponent & { dispose(): void } = {
      render: () => ['01234567890123456789'],
      invalidate: vi.fn(),
      dispose,
    }
    const panel = new ScrollablePanel({
      screen,
      components: new FakeMayflyComponents(),
      colors: new FakeTheme().colors,
      body,
      title: () => 'Title\nignored',
      onClose: vi.fn(),
    })
    expect(plain(panel.render(30))[0]).toContain('Title ignored')
    const rendered = plain(panel.render(10))
    expect(rendered.every(row => new FakeMayflyComponents().visibleWidth(row) <= 10)).toBe(true)
    panel.handleInput('\x1b[B')
    panel.handleInput('\x1b[F')
    screen.rows = 0
    panel.render(10)
    panel.dispose()
    panel.dispose()
    panel.handleInput('\x1b')
    panel.invalidate()
    expect(panel.render(10)).toEqual([])
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('uses a component-provided viewport window when available', () => {
    const screen = new FakeScreen()
    screen.rows = 8
    const renderWindow = vi.fn((_width: number, _offset: number, rows: number) => ({ rows: ['windowed'], total: rows + 1 }))
    const panel = new ScrollablePanel({
      screen,
      components: new FakeMayflyComponents(),
      colors: new FakeTheme().colors,
      body: { render: () => ['fallback'], renderWindow, invalidate: vi.fn() },
      title: () => 'Windowed',
      onClose: vi.fn(),
    })
    expect(plain(panel.render(20)).join('\n')).toContain('windowed')
    expect(renderWindow).toHaveBeenCalledOnce()
  })
})
