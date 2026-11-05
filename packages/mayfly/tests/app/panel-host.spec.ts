/** Component-overlay generations, opaque cell widths and focus restoration. @module */
import { describe, expect, it, vi } from 'vitest'
import { visibleWidth } from '../../src/core/width.ts'
import type { MayflyComponent, MayflyFocusable, MayflyScreen } from '../../src/core/types.ts'
import { RemotePanelController, remotePanelOverlayOptions } from '../../src/app/panels.ts'

function fixture(opaque = false) {
  const mounted: Array<{ component: MayflyComponent, hide: ReturnType<typeof vi.fn> }> = []
  const showOverlay = vi.fn((component: MayflyComponent, _options: unknown) => {
    const row = { component, hide: vi.fn() }
    mounted.push(row)
    return { hide: row.hide }
  })
  const screen = { columns: 80, showOverlay } as unknown as MayflyScreen
  const restore = vi.fn()
  const host = new RemotePanelController(screen, restore, opaque, { visibleWidth })
  const component: MayflyFocusable = { focused: false, render: () => ['界', '1234'], invalidate: vi.fn(), handleInput: vi.fn() }
  return { host, screen, component, mounted, showOverlay, restore }
}

describe('Remote component-overlay owner', () => {
  it('provides one full-row default and admits explicit placement overrides', () => {
    const f = fixture()
    expect(remotePanelOverlayOptions(f.screen)).toEqual({ width: 80, maxHeight: '80%', anchor: 'center' })
    expect(remotePanelOverlayOptions(f.screen, { width: 40, anchor: 'top-center' })).toEqual({ width: 40, maxHeight: '80%', anchor: 'top-center' })
    const lease = f.host.open(f.component)
    expect(f.showOverlay).toHaveBeenCalledWith(f.component, { width: 80, maxHeight: '70%', anchor: 'center' })
    expect(lease.closed).toBe(false)
    lease.close(); lease.close(); f.host.close()
    expect(lease.closed).toBe(true)
    expect(f.mounted[0]!.hide).toHaveBeenCalledOnce()
    expect(f.restore).toHaveBeenCalledOnce()
  })

  it('closes replaced generations once and a stale lease cannot dismiss its replacement', () => {
    const f = fixture()
    const closed = vi.fn()
    const old = f.host.open(f.component, { onClosed: closed, maxHeight: 10 })
    const next = f.host.open(f.component)
    expect(next.generation).toBeGreaterThan(old.generation)
    expect(old.closed).toBe(true)
    old.close()
    expect(next.closed).toBe(false)
    expect(closed).toHaveBeenCalledOnce()
    expect(f.restore).not.toHaveBeenCalled()
    f.host.dispose(); f.host.dispose()
    expect(next.closed).toBe(true)
    expect(f.mounted.every(row => row.hide.mock.calls.length === 1)).toBe(true)
    expect(f.restore).not.toHaveBeenCalled()
  })

  it('preserves newly opened focus during a close callback and restores focus even when cleanup throws', () => {
    const f = fixture()
    const old = f.host.open(f.component, { onClosed: () => { f.host.open(f.component) } })
    old.close()
    expect(f.restore).not.toHaveBeenCalled()
    expect(f.mounted).toHaveLength(2)
    f.host.close()
    expect(f.restore).toHaveBeenCalledOnce()
    f.host.open(f.component, { onClosed: () => { throw new Error('cleanup failed') } })
    expect(() => f.host.close()).toThrow('cleanup failed')
    expect(f.restore).toHaveBeenCalledTimes(2)
    f.host.dispose()
  })

  it('uses only the shared visible-width measure for opaque rows and forwards component focus and input', () => {
    const f = fixture(true)
    f.host.open(f.component)
    const painted = f.mounted[0]!.component as MayflyFocusable
    expect(painted.render(4)).toEqual(['界  ', '1234'])
    expect(painted.render(1)).toEqual(['界', '1234'])
    expect(painted.focused).toBe(false)
    painted.focused = true
    expect(f.component.focused).toBe(true)
    painted.handleInput!('key'); painted.invalidate()
    expect(f.component.handleInput).toHaveBeenCalledWith('key')
    expect(f.component.invalidate).toHaveBeenCalledOnce()
    const withoutInput = { focused: false, render: () => [], invalidate: vi.fn() }
    f.host.open(withoutInput)
    expect(() => f.mounted[1]!.component.handleInput!('ignored')).not.toThrow()
    f.host.dispose()
  })
})
