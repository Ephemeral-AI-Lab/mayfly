/**
 * `ctx.mayflyScreen` service: registration and disposal on the fiber, and
 * delegation of every `MayflyScreen` method to the terminal runtime.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MayflyScreenService } from '../../src/core/screen.ts'
import type { MayflyTerminalRuntime } from '../../src/core/terminal.ts'
import type { MayflyComponent, MayflyDockOptions, MayflyOverlayHandle } from '../../src/core/types.ts'

interface Recorded {
  added: MayflyComponent[]
  bottomAdded: MayflyComponent[]
  dockAdded: { component: MayflyComponent, options: MayflyDockOptions | undefined }[]
  removed: MayflyComponent[]
  focused: (MayflyComponent | null)[]
  overlays: { component: MayflyComponent; options?: unknown }[]
  renders: (boolean | undefined)[]
  suspends: unknown[]
  titles: string[]
  scrolls: { direction: 'up' | 'down', amount: number | undefined }[]
  contentChanges: number
}

function recordingRuntime(): MayflyTerminalRuntime & Recorded {
  const handle: MayflyOverlayHandle = {
    hide: () => {},
    setHidden: () => {},
    isHidden: () => false,
    focus: () => {},
    unfocus: () => {},
    isFocused: () => true,
  }
  const recorded: Recorded = { added: [], bottomAdded: [], dockAdded: [], removed: [], focused: [], overlays: [], renders: [], suspends: [], titles: [], scrolls: [], contentChanges: 0 }
  return {
    ...recorded,
    get contentChanges() { return recorded.contentChanges },
    columns: 120,
    rows: 24,
    addChild(component) {
      recorded.added.push(component)
    },
    addBottomChild(component) {
      recorded.bottomAdded.push(component)
    },
    addDockChild(component, options) {
      recorded.dockAdded.push({ component, options })
    },
    removeChild(component) {
      recorded.removed.push(component)
    },
    setFocus(component) {
      recorded.focused.push(component)
    },
    showOverlay(component, options) {
      recorded.overlays.push(options === undefined ? { component } : { component, options })
      return handle
    },
    requestRender(force) {
      recorded.renders.push(force)
    },
    scrollContent(direction, amount) {
      recorded.scrolls.push({ direction, amount })
      return true
    },
    contentChanged() {
      recorded.contentChanges += 1
      return true
    },
    async suspend<T>(fn: () => Promise<T>): Promise<T> {
      const value = await fn()
      recorded.suspends.push(value)
      return value
    },
    setTitle(title) {
      recorded.titles.push(title)
    },
    stop: () => Promise.resolve(),
  }
}

const component: MayflyComponent = {
  render: () => ['row'],
  invalidate: () => {},
}

describe('MayflyScreenService', () => {
  it('registers as ctx.mayflyScreen and unregisters when the fiber disposes', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(MayflyScreenService, recordingRuntime())
    await fiber
    expect(ctx.get('mayflyScreen')).toBeInstanceOf(MayflyScreenService)
    await fiber.dispose()
    expect(ctx.get('mayflyScreen')).toBeUndefined()
  })

  it('delegates mounts, focus, overlays, and renders to the runtime', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const screen = ctx.mayflyScreen

    expect(screen.columns).toBe(120)
    expect(screen.rows).toBe(24)
    expect(runtime.added).toHaveLength(3)
    expect(runtime.bottomAdded).toHaveLength(2)
    expect(runtime.added.flatMap(child => child.render(20))).toEqual([])

    const content = screen.mountContentSlot('transcript.prelude', component)
    expect(content.disposed).toBe(false)
    expect(content.component.focused).toBe(false)
    expect(runtime.added[0]).toBe(content.component)
    expect(content.component.render(20)).toEqual(['row'])
    expect(() => screen.mountContentSlot('transcript.prelude', component)).toThrow('already mounted')
    content.replace(component)
    content.replace(null)
    expect(content.component.render(20)).toEqual([])
    content.focus()
    content.dispose()
    content.dispose()
    content.replace(component)
    content.focus()
    content.component.invalidate()
    content.component.handleInput?.('ignored')
    expect(content.disposed).toBe(true)
    expect(content.component.focused).toBe(false)
    expect(content.component.render(20)).toEqual([])
    expect(runtime.removed).toEqual([])
    const remounted = screen.mountContentSlot('transcript.prelude', component)
    expect(remounted.component).toBe(content.component)
    remounted.dispose()

    const local = screen.mountContentSlot('local.test', component)
    expect(() => screen.mountContentSlot('local.test', component)).toThrow('already mounted')
    expect(runtime.added).toHaveLength(3)
    expect(runtime.added[2]!.render(20)).toEqual(['row'])
    runtime.added[2]!.invalidate()
    local.dispose()
    expect(runtime.added[2]!.render(20)).toEqual([])
    local.component.focused = true
    expect(local.component.focused).toBe(false)
    local.component.invalidate()
    local.component.handleInput?.('ignored')

    const dock = screen.mountDockSlot('editor.prompt', component)
    expect(runtime.bottomAdded[0]).toBe(dock.component)
    dock.dispose()
    const footer = screen.mountDockSlot('status.footer', component, 'bottom')
    expect(runtime.bottomAdded[1]).toBe(footer.component)
    footer.dispose()
    expect(() => screen.mountDockSlot('dock', component)).toThrow('unknown dock slot')
    expect(() => screen.mountDockSlot('editor.prompt', component, 'bottom')).toThrow('fixed position')
    expect(runtime.removed).toEqual([])

    screen.setFocus(component)
    screen.setFocus(null)
    expect(runtime.focused).toEqual([component, null])

    const handle = screen.showOverlay(component, { width: '50%', anchor: 'top-center' })
    expect(handle.isFocused()).toBe(true)
    expect(runtime.overlays).toEqual([{ component, options: { width: '50%', anchor: 'top-center' } }])

    screen.requestRender()
    screen.requestRender(true)
    expect(runtime.renders.slice(-2)).toEqual([undefined, true])

    expect(screen.scrollContent('up', 3)).toBe(true)
    expect(runtime.scrolls).toEqual([{ direction: 'up', amount: 3 }])
    expect(screen.contentChanged()).toBe(true)
    expect(runtime.contentChanges).toBe(1)

    await expect(screen.suspend(async () => 'ok')).resolves.toBe('ok')
    expect(runtime.suspends).toEqual(['ok'])

    screen.setTitle('fix the login bug')
    expect(runtime.titles).toEqual(['fix the login bug'])
  })

  it('keeps focus on the stable slot while replacing focusable targets', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const first = {
      focused: false,
      render: vi.fn(() => ['first']),
      invalidate: vi.fn(),
      handleInput: vi.fn(),
    }
    const second = {
      focused: false,
      render: vi.fn(() => ['second']),
      invalidate: vi.fn(),
      handleInput: vi.fn(),
    }
    const slot = ctx.mayflyScreen.mountContentSlot('transcript.conversation', first)

    slot.focus()
    expect(runtime.focused).toEqual([slot.component])
    slot.component.focused = true
    expect(slot.component.focused).toBe(true)
    expect(first.focused).toBe(true)
    slot.component.invalidate()
    slot.component.handleInput?.('a')
    expect(first.invalidate).toHaveBeenCalledOnce()
    expect(first.handleInput).toHaveBeenCalledWith('a')

    slot.replace(second)
    expect(first.focused).toBe(false)
    expect(second.focused).toBe(true)
    expect(slot.component.render(20)).toEqual(['second'])
    slot.component.focused = false
    expect(second.focused).toBe(false)
    slot.component.focused = true
    slot.dispose()
    expect(runtime.focused.at(-1)).toBeNull()
    expect(second.focused).toBe(false)

    slot.component.focused = true
    expect(slot.component.focused).toBe(false)
    expect(slot.component.render(20)).toEqual([])
  })
})
