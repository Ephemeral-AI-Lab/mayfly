/** Actual reference completion painter, presentation, waiting and overlay lifetime. @module */
import { Context } from '@deepseek-ai/cordis'
import type { MayflyComponent, MayflyEditor, MayflyScreenService } from '../../src/core.ts'
import { describe, expect, it, vi } from 'vitest'
import { mountRemoteCompletionDrawer } from '../../src/app/completion-drawer.ts'
import { fakeMayflyComponents, plain, plainColors } from './render-fixture.ts'

describe('Remote completion presentation', () => {
  it('uses the current glyph vocabulary and prompt waiting row without moving the editor', async () => {
    const ctx = new Context()
    const hide = vi.fn()
    const requestRender = vi.fn()
    let drawer!: MayflyComponent
    let overlay!: NonNullable<Parameters<MayflyScreenService['showOverlay']>[1]>
    let completion: ReturnType<MayflyEditor['completion']> = {
      kind: 'commands', prefix: '/', index: 0,
      items: [{ label: '/theme', value: '/theme', detail: 'Switch the color theme' }],
    }
    let columns = 80
    let editorRows = 4
    const screen = {
      get columns() { return columns },
      get editorRowsFromBottom() { return editorRows },
      requestRender,
      showOverlay(component: MayflyComponent, options: typeof overlay) {
        drawer = component
        overlay = options
        return { hide }
      },
    } as unknown as MayflyScreenService
    const editor = { completion: () => completion } as MayflyEditor
    const components = { ...fakeMayflyComponents(), presentation: { glyphs: 'ascii' as const, monochrome: false, reducedMotion: false } }
    const mount = mountRemoteCompletionDrawer(ctx, screen, editor, plainColors(), components)
    expect(overlay.anchor).toBe('bottom-left')
    expect(overlay.nonCapturing).toBe(true)
    expect(overlay.visible?.(columns, 24)).toBe(true)
    expect(overlay.width).toBe(80)
    expect(overlay.offsetY).toBe(-4)
    expect(plain(drawer.render(columns))[0]).toContain('> /theme')
    ctx.emit('mayfly/prompt-wait-changed', 'Waiting for files…')
    expect(requestRender).toHaveBeenCalledOnce()
    expect(plain(drawer.render(columns)).at(-1)).toContain('Waiting for files…')
    for (const width of [1, 8, 20, 40, 80, 120]) {
      columns = width
      expect(overlay.width).toBe(width)
      for (const row of drawer.render(width)) expect(components.visibleWidth(row)).toBeLessThanOrEqual(width)
    }
    editorRows = 8
    expect(overlay.offsetY).toBe(-8)
    ctx.emit('mayfly/prompt-wait-changed', undefined)
    expect(drawer.render(columns)).toHaveLength(1)
    completion = undefined
    expect(overlay.visible?.(columns, 24)).toBe(false)
    mount.dispose()
    mount.dispose()
    expect(hide).toHaveBeenCalledOnce()
    const renders = requestRender.mock.calls.length
    ctx.emit('mayfly/prompt-wait-changed', 'late')
    expect(requestRender).toHaveBeenCalledTimes(renders)
    await ctx.fiber.dispose()
  })

  it('ignores a wait callback already captured by native dispatch when an earlier listener unloads it', async () => {
    const ctx = new Context()
    let mount!: ReturnType<typeof mountRemoteCompletionDrawer>
    ctx.on('mayfly/prompt-wait-changed', () => { mount.dispose() })
    const hide = vi.fn()
    const requestRender = vi.fn()
    const screen = { columns: 80, editorRowsFromBottom: 1, requestRender, showOverlay: () => ({ hide }) } as unknown as MayflyScreenService
    const editor = { completion: () => undefined } as MayflyEditor
    mount = mountRemoteCompletionDrawer(ctx, screen, editor, plainColors(), fakeMayflyComponents())
    // Cordis snapshots the listeners before invoking the first one. Unload removes future dispatches,
    // while this dispatch still owns the completion listener that follows the disposer.
    ctx.emit('mayfly/prompt-wait-changed', 'Waiting after unload')
    expect(hide).toHaveBeenCalledOnce()
    expect(requestRender).not.toHaveBeenCalled()
    mount.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps unicode when no presentation override exists and tolerates a headless screen', async () => {
    const ctx = new Context()
    const mount = mountRemoteCompletionDrawer(ctx, {} as MayflyScreenService, {} as MayflyEditor, plainColors(), fakeMayflyComponents())
    mount.dispose()
    mount.dispose()
    const screen = { columns: 0, editorRowsFromBottom: 1, requestRender: vi.fn(), showOverlay: vi.fn(() => ({ hide: vi.fn() })) } as unknown as MayflyScreenService
    const editor = { completion: () => ({ kind: 'commands', prefix: '/', index: 0, items: [{ label: '/theme', value: '/theme' }] }) } as unknown as MayflyEditor
    const unicode = mountRemoteCompletionDrawer(ctx, screen, editor, plainColors(), fakeMayflyComponents())
    const component = vi.mocked(screen.showOverlay).mock.calls[0]![0]
    expect(plain(component.render(40))[0]).toContain('→ /theme')
    unicode.dispose()
    await ctx.fiber.dispose()
  })
})
