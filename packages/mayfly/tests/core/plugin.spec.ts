/**
 * REAL-composition test: boot the mayfly-core plugin plus the mayfly-theme-dark
 * entry through the real Loader from a cordis.yml in a temp directory,
 * asserting the terminal starts, all five services register, the global key
 * dispatcher consumes handler actions before focus routing, the
 * terminal-theme-changed broadcast fires, and unloading restores the
 * terminal and removes the services and the dispatcher listener.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { MayflyPaneRegistry } from '../../../ui/src/contracts.ts'
import { apply as uiProviderApply } from '../../../ui/src/provider.ts'
import { apply } from '../../src/core/index.ts'
import { apply as themeDarkApply } from '../../src/core/theme-dark.ts'
import { mkdtempTracked, registerTempDirCleanup } from './temp-dir.ts'


registerTempDirCleanup()

const disposers: (() => Promise<void>)[] = []

interface StartupPaneProbe {
  coreApplyStarted: boolean
  appliedBeforeCore: boolean
  appliedBeforeScreen: boolean
  registerOk: boolean
  renders: number
  gapRenders: number
  panes?: MayflyPaneRegistry
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  vi.restoreAllMocks()
})

/**
 * Boot a real Loader tree whose entries delegate to the source-plane
 * plugins already imported by this test (the Loader imports through Node's
 * resolver, which cannot reach tsconfig paths).
 * @returns the root context and the terminal output observed so far.
 */
async function bootMayflyCore(): Promise<{ ctx: Context; output: () => string; pane: StartupPaneProbe }> {
  const dir = mkdtempTracked('mayfly-core-')
  // The fixtures re-export the real plugins' namespace shape (name + apply)
  // so the Loader exercises the same unwrap path as a packaged install.
  writeFileSync(join(dir, 'mayfly-ui-provider.mjs'), `
export const name = 'mayfly-ui-provider'
export const apply = ctx => globalThis.__mayflyUiProviderApply(ctx)
`)
  writeFileSync(join(dir, 'mayfly-core.mjs'), `
await globalThis.__delayMayflyCoreImport()
export const name = 'mayfly-core'
export const apply = ctx => globalThis.__mayflyCoreApply(ctx)
`)
  writeFileSync(join(dir, 'mayfly-theme-dark.mjs'), `
export const name = 'mayfly-theme-dark'
export const apply = ctx => globalThis.__mayflyThemeDarkApply(ctx)
`)
  writeFileSync(join(dir, 'external-pane.mjs'), `
export const name = 'external-pane'
export const inject = ['mayflyPanes']
export const apply = ctx => globalThis.__externalPaneApply(ctx)
`)
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: mayfly-ui-provider',
    `  name: ${pathToFileURL(join(dir, 'mayfly-ui-provider.mjs')).href}`,
    '- id: external-pane',
    `  name: ${pathToFileURL(join(dir, 'external-pane.mjs')).href}`,
    '- id: mayfly-core',
    `  name: ${pathToFileURL(join(dir, 'mayfly-core.mjs')).href}`,
    '- id: mayfly-theme-dark',
    `  name: ${pathToFileURL(join(dir, 'mayfly-theme-dark.mjs')).href}`,
    '',
  ].join('\n'))
  const globals = globalThis as unknown as {
    __mayflyCoreApply: typeof apply
    __mayflyUiProviderApply: typeof uiProviderApply
    __delayMayflyCoreImport: () => Promise<void>
    __mayflyThemeDarkApply: typeof themeDarkApply
    __externalPaneApply: (ctx: Context) => void
  }
  const pane: StartupPaneProbe = { coreApplyStarted: false, appliedBeforeCore: false, appliedBeforeScreen: false, registerOk: false, renders: 0, gapRenders: 0 }
  globals.__mayflyUiProviderApply = uiProviderApply
  globals.__delayMayflyCoreImport = () => new Promise<void>(resolve => setTimeout(resolve, 50))
  globals.__mayflyCoreApply = (ctx) => {
    pane.coreApplyStarted = true
    return apply(ctx)
  }
  globals.__mayflyThemeDarkApply = themeDarkApply
  globals.__externalPaneApply = (ctx) => {
    pane.appliedBeforeCore = !pane.coreApplyStarted
    pane.appliedBeforeScreen = ctx.get('mayflyScreen') === undefined
    pane.panes = ctx.mayflyPanes
    ctx.mayflyPanes.register({
      id: 'startup-pane',
      placement: 'bottom',
    }, (() => {
      pane.renders += 1
      return { kind: 'text', content: 'startup-pane' }
    })())
    pane.registerOk = true
  }

  const chunks: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return { ctx, output: () => chunks.join(''), pane }
}

describe('mayfly-core plugin through the real Loader', () => {
  it('starts the terminal and registers the L1 services', async () => {
    const { ctx, output } = await bootMayflyCore()
    expect(ctx.get('mayflyScreen')).toBeDefined()
    expect(ctx.get('mayflyKeymap')).toBeDefined()
    expect(ctx.get('mayflyTerminalInfo')).toBeDefined()
    expect(ctx.get('mayflyComponents')).toBeDefined()
    expect(ctx.get('mayflyTheme')).toBeDefined()
    // ProcessTerminal.start enables bracketed paste; Mayfly's production entry
    // selects the alternate buffer with application-owned mouse handling.
    expect(output()).toContain('\x1b[?2004h')
    expect(output()).toContain('\x1b[?1049h')
    expect(output()).toContain('\x1b[?1002h')
  })

  it('renders direct panes registered before core import and replays them across renderer gaps', async () => {
    const { ctx, output, pane } = await bootMayflyCore()
    expect(pane.appliedBeforeCore).toBe(true)
    expect(pane.appliedBeforeScreen).toBe(true)
    expect(pane.registerOk).toBe(true)

    ctx.mayflyScreen.requestRender(true)
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    expect(pane.renders).toBeGreaterThan(0)
    expect(output()).toContain('startup-pane')

    const coreEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'mayfly-core')
    expect(coreEntry).toBeDefined()
    await ctx.loader.update(coreEntry!.id, { disabled: true })
    await ctx.loader.await()
    pane.panes!.register({
      id: 'during-renderer-gap',
      placement: 'bottom',
    }, (() => {
        pane.gapRenders += 1
        return { kind: 'text', content: 'renderer-gap-pane' }
      })())

    await ctx.loader.update(coreEntry!.id, { disabled: false })
    await ctx.loader.await()
    ctx.mayflyScreen.requestRender(true)
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    expect(pane.gapRenders).toBe(1)
    expect(output()).toContain('renderer-gap-pane')
  })

  it('broadcasts mayfly/terminal-theme-changed when the terminal reports a scheme', async () => {
    const { ctx } = await bootMayflyCore()
    const schemes: ('dark' | 'light')[] = []
    ctx.on('mayfly/terminal-theme-changed', scheme => schemes.push(scheme))
    // Simulate the terminal's mode 2031 report arriving on process stdin.
    process.stdin.emit('data', Buffer.from('\x1b[?997;2n', 'utf8'))
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    expect(schemes).toEqual(['light'])
  })

  it('routes input through the global dispatcher before the focused component', async () => {
    const { ctx } = await bootMayflyCore()
    const handler = vi.fn()
    ctx.mayflyKeymap.register([{ id: 'mayfly.transcript.toggle', keys: 'ctrl+o', handler }])

    const received: string[] = []
    const focused = {
      focused: false,
      render: () => ['probe'],
      invalidate: () => {},
      handleInput: (data: string) => received.push(data),
    }
    const slot = ctx.mayflyScreen.mountContentSlot('test.focused', focused)
    slot.focus()

    // A matching sequence is consumed by the handler before focus routing.
    process.stdin.emit('data', Buffer.from('\x0f', 'utf8'))
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(received).toEqual([])

    // A non-matching sequence passes through to the focused component.
    process.stdin.emit('data', Buffer.from('a', 'utf8'))
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    expect(received).toEqual(['a'])

    // Unloading removes the dispatcher listener with the fiber.
    await ctx.fiber.dispose()
    process.stdin.emit('data', Buffer.from('\x0f', 'utf8'))
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('stops the terminal and removes the services when the tree unloads', async () => {
    const { ctx, output } = await bootMayflyCore()
    await ctx.fiber.dispose()
    // TuiBase.stop shows the cursor; ProcessTerminal.stop disables bracketed paste.
    expect(output()).toContain('\x1b[?2004l')
    expect(output()).toContain('\x1b[?1002l')
    expect(output()).toContain('\x1b[?1049l')
    expect(ctx.get('mayflyScreen')).toBeUndefined()
    expect(ctx.get('mayflyKeymap')).toBeUndefined()
    expect(ctx.get('mayflyTerminalInfo')).toBeUndefined()
    expect(ctx.get('mayflyComponents')).toBeUndefined()
    expect(ctx.get('mayflyTheme')).toBeUndefined()
  })
})
