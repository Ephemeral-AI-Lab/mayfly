/**
 * mayfly-core `apply` terminal ownership (P2-3): the owner effect is
 * registered before the probe acquires anything, so a fiber unloaded while
 * the probe awaits still restores whatever the resumed apply managed to
 * start, and a post-start failure stops the terminal exactly once.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { MayflyRgbColor } from '../../src/core/types.ts'
import type { FakeTerminal } from './fake-terminal.ts'

const hoisted = vi.hoisted(() => ({
  terminals: [] as FakeTerminal[],
  probe: vi.fn<(proc?: unknown) => Promise<MayflyRgbColor | undefined>>(),
  mountHints: vi.fn<() => void>(),
}))

vi.mock('@earendil-works/pi-tui', async importOriginal => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-tui')>()
  const { FakeTerminal } = await import('./fake-terminal.ts')
  return {
    ...actual,
    ProcessTerminal: class extends FakeTerminal {
      constructor() {
        super()
        hoisted.terminals.push(this)
      }
    },
  }
})

vi.mock('../../src/core/terminal-info.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/terminal-info.ts')>()
  return { ...actual, probeTerminalBackground: hoisted.probe }
})

vi.mock('../../src/core/context-hint-locale.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/context-hint-locale.ts')>()
  return { ...actual, mountContextHintLocale: hoisted.mountHints }
})

import * as corePlugin from '../../src/core/index.ts'

beforeEach(() => {
  hoisted.terminals.length = 0
  hoisted.probe.mockReset().mockResolvedValue(undefined)
  hoisted.mountHints.mockReset().mockImplementation(() => {})
})

describe('mayfly-core apply terminal ownership', () => {
  it('restores the terminal exactly once when the fiber unloads during the probe', async () => {
    const deferred = Promise.withResolvers<MayflyRgbColor | undefined>()
    hoisted.probe.mockReturnValue(deferred.promise)
    const ctx = new Context()
    const fiber = ctx.plugin(corePlugin)
    try {
      await vi.waitFor(() => expect(hoisted.probe).toHaveBeenCalledOnce())
      const unloading = fiber.dispose()
      deferred.resolve(undefined)
      await unloading
      await Promise.resolve(fiber).catch(() => undefined)
      // Cordis awaits the in-flight apply before unloading the fiber: the
      // resumed apply's first post-start registration throws on the inactive
      // context, and the already-registered owner effect still stops the
      // terminal it just started — the tty is restored exactly once.
      const terminal = hoisted.terminals[0]!
      expect(terminal).toBeDefined()
      expect(terminal.startCount).toBe(1)
      expect(terminal.stopCount).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stops the started terminal once when apply fails after the start', async () => {
    hoisted.mountHints.mockImplementation(() => { throw new Error('hint mount failed') })
    const ctx = new Context()
    const fiber = ctx.plugin(corePlugin)
    try {
      await expect(fiber).rejects.toThrow('hint mount failed')
      const terminal = hoisted.terminals[0]!
      expect(terminal).toBeDefined()
      expect(terminal.startCount).toBe(1)
      expect(terminal.stopCount).toBe(1)
      expect(terminal.drainCount).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stops the terminal once on a clean unload', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(corePlugin)
    try {
      await fiber
      const terminal = hoisted.terminals[0]!
      expect(terminal.startCount).toBe(1)
      await fiber.dispose()
      expect(terminal.stopCount).toBe(1)
      // A second caller of the memoized stop settles on the first teardown.
      expect(terminal.drainCount).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
