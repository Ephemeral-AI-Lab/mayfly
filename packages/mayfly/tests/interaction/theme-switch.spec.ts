/**
 * Tests for the `/theme` command: the listing, provider swaps through the
 * real Cordis registry, file-backed custom palettes, and usage plus
 * mount-failure errors. The theme modules come from the package subpaths —
 * not relative core source paths — because the swap keys registry runtimes
 * by callback identity: only the module instance the command statically
 * imports shares a registry record with the provider it replaces. Module
 * state (`current` in theme-switch.ts) is shared across this file, so the
 * cases run sequentially and each leaves a known theme active.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as uiProvider from '../../../ui/src/provider.ts'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'
import * as themeDark from '../../src/core/theme-dark.ts'
import * as themeLight from '../../src/core/theme-light.ts'
import * as themeOcean from '../../src/core/theme-ocean.ts'
import { MayflyTerminalInfoService } from '../../src/core/terminal-info.ts'
import * as commandsPlugin from '../../src/interaction/commands-plugin.ts'
import { SkillsCatalogService } from '../../src/interaction/skills-catalog.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { DEFAULT_SETTINGS } from '../../src/interaction/settings.ts'
import { CURRENT_MARK } from '../../src/interaction/symbols.ts'

const USAGE = 'usage: /theme [dark|light|ocean|paper|auto|custom <path> [dark|light|ocean|paper]]'

registerTempDirCleanup()
const dir = mkdtempTracked('mayfly-theme-spec-')
const roots: Context[] = []
afterEach(async () => { for (const ctx of roots.splice(0).reverse()) await ctx.fiber.dispose() })

async function mount(): Promise<{
  ctx: Context
  agent: Agent
  fiber: { dispose(): Promise<void> }
}> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(uiProvider)
  new InteractionStateService(ctx, DEFAULT_SETTINGS)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('theme-spec'))
  const agent = { id: session.id, session } as unknown as Agent
  ctx.provide('mayflyCurrentAgent', {
    current: () => agent,
    revision: () => 0,
    subscribe: (listener: (current: Agent, revision: number) => void) => {
      listener(agent, 0)
      return () => {}
    },
  } as never)
  ctx.provide('sessionProjections', { snapshot: () => ({ asOfSeq: 0, values: {} }), onChanged: () => () => {} } as never)
  ctx.provide('sessionController', { selectModel: async () => { throw new Error('not used') } } as never)
  ctx.provide('tools', { schemas: () => [] } as never)
  new SkillsCatalogService(ctx)
  const fiber = await ctx.plugin(commandsPlugin)
  return { ctx, agent, fiber }
}

async function execute(ctx: Context, agent: Agent, line: string): Promise<CommandResult | undefined> {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  return execution?.result
}

/** Read the rows of the open `/theme` picker overlay. */
function pickerRows(ctx: Context): readonly { readonly id: string, readonly badge?: string }[] {
  const entry = ctx.mayflyOverlays.list().find(candidate => candidate.id === 'mayfly.theme')
  if (entry?.node.kind !== 'surface' || entry.node.child.kind !== 'list') throw new Error('the theme picker is not open')
  return entry.node.child.items
}

describe('/theme command', () => {
  it('opens the theme picker, marking the live row', async () => {
    const { ctx, agent } = await mount()
    const result = await execute(ctx, agent, '/theme')
    expect(result).toEqual({ kind: 'success' })
    const rows = pickerRows(ctx)
    expect(rows.map(row => row.id)).toEqual(['dark', 'light', 'ocean', 'paper', 'auto', 'custom'])
    expect(rows.find(row => row.id === 'dark')?.badge).toBe(CURRENT_MARK)
    expect(rows.filter(row => row.badge === CURRENT_MARK)).toHaveLength(1)
  })

  it('settles picker selections: current, custom hint, unknown, swap, and mount failure', async () => {
    const { ctx, agent, fiber } = await mount()
    await ctx.plugin(themeDark)
    expect(await execute(ctx, agent, '/theme')).toEqual({ kind: 'success' })
    const entry = ctx.mayflyOverlays.list().find(candidate => candidate.id === 'mayfly.theme')!
    const action = entry.definition.onEvent!.action!
    const context = { surfaceId: entry.id, operationId: 'pick', source: entry.source, revision: entry.revision, signal: new AbortController().signal, report: () => {} }
    const accept = (selectedIds: string[]) => action({ kind: 'selection-accept' as const, controlId: 'themes', selectedIds }, context as never)

    expect(await action({ kind: 'dismiss' }, context as never)).toEqual({ kind: 'completed' })
    expect(await accept([])).toEqual({ kind: 'completed', dismiss: true })
    expect(await accept(['dark'])).toEqual({ kind: 'completed', dismiss: true })
    expect(await accept(['custom'])).toEqual({ kind: 'completed', feedback: { severity: 'info', message: USAGE } })
    expect(await accept(['bogus'])).toEqual({ kind: 'failed', message: 'unknown theme "bogus"' })
    expect(await accept(['light'])).toEqual({ kind: 'completed', dismiss: true, feedback: { severity: 'success', message: 'switched to theme "light"' } })
    expect(ctx.get('mayflyTheme')?.colors).toBe(themeLight.LIGHT_COLORS)

    // A failed swap on the commands fiber's own context: the provider mount
    // rejects, dark is restored, and the picker replies 'failed'.
    const pluginCtx = (fiber as unknown as { ctx: Context }).ctx
    const original = pluginCtx.plugin.bind(pluginCtx)
    vi.spyOn(pluginCtx, 'plugin').mockImplementation(((plugin: unknown, config?: unknown) => plugin === themeOcean
      ? Promise.reject(new Error('simulated mount failure'))
      : original(plugin as never, config as never)) as never)
    const failed = await accept(['ocean'])
    expect(failed.kind).toBe('failed')
    if (failed.kind === 'failed') expect(failed.message).toContain('failed to apply theme "ocean"')
    expect(ctx.get('mayflyTheme')?.colors).toBe(themeDark.DARK_COLORS)
  })

  it('swaps built-in palettes through the real registry', async () => {
    const { ctx, agent } = await mount()
    await ctx.plugin(themeDark)
    expect(ctx.get('mayflyTheme')?.colors).toBe(themeDark.DARK_COLORS)
    const toLight = await execute(ctx, agent, '/theme light')
    expect(toLight).toEqual({ kind: 'success', text: 'switched to theme "light"' })
    expect(ctx.get('mayflyTheme')?.colors).toBe(themeLight.LIGHT_COLORS)
    const back = await execute(ctx, agent, '/theme dark')
    expect(back).toEqual({ kind: 'success', text: 'switched to theme "dark"' })
    expect(ctx.get('mayflyTheme')?.colors).toBe(themeDark.DARK_COLORS)
  })

  it('follows the probed terminal background with auto', async () => {
    const { ctx, agent } = await mount()
    await ctx.plugin(MayflyTerminalInfoService, { background: 'light', kittyKeyboard: false })
    const toAuto = await execute(ctx, agent, '/theme auto')
    expect(toAuto).toEqual({ kind: 'success', text: 'switched to theme "auto"' })
    expect(ctx.get('mayflyTheme')?.colors).toBe(themeLight.LIGHT_COLORS)
    // Back to the baseline: later cases start from dark.
    await execute(ctx, agent, '/theme dark')
    expect(ctx.get('mayflyTheme')?.colors).toBe(themeDark.DARK_COLORS)
  })

  it('loads a custom palette file over the dark base', async () => {
    const { ctx, agent } = await mount()
    const path = join(dir, 'custom-dark.json')
    await writeFile(path, JSON.stringify({ accent: '#ff0000' }))
    const result = await execute(ctx, agent, `/theme custom ${path}`)
    expect(result).toEqual({ kind: 'success', text: 'switched to theme "custom"' })
    const colors = ctx.get('mayflyTheme')?.colors
    expect(colors?.accent('x')).toBe('\x1b[38;2;255;0;0mx\x1b[39m')
    expect(colors?.text).toBe(themeDark.DARK_COLORS.text)
    expect(await execute(ctx, agent, '/theme')).toEqual({ kind: 'success' })
    expect(pickerRows(ctx).find(row => row.id === 'custom')?.badge).toBe(CURRENT_MARK)
    expect(await execute(ctx, agent, '/theme dark')).toEqual({ kind: 'success', text: 'switched to theme "dark"' })
  })

  it('falls back to dark when the remembered key is unknown', async () => {
    const { ctx, agent } = await mount()
    await ctx.plugin(themeDark)
    ctx.mayflyInteractionState.currentThemeKey = 'retired-theme'
    expect(await execute(ctx, agent, '/theme light')).toEqual({ kind: 'success', text: 'switched to theme "light"' })
    expect(ctx.get('mayflyTheme')?.colors).toBe(themeLight.LIGHT_COLORS)
    await execute(ctx, agent, '/theme dark')
  })

  it('loads a custom palette over the light base', async () => {
    const { ctx, agent } = await mount()
    const path = join(dir, 'custom-light.json')
    await writeFile(path, JSON.stringify({ accent: '#00ff00' }))
    const result = await execute(ctx, agent, `/theme custom ${path} light`)
    expect(result).toEqual({ kind: 'success', text: 'switched to theme "custom"' })
    const colors = ctx.get('mayflyTheme')?.colors
    expect(colors?.text).toBe(themeLight.LIGHT_COLORS.text)
    expect(colors?.accent('x')).toBe('\x1b[38;2;0;255;0mx\x1b[39m')
  })

  it('rejects malformed invocations with the usage text and keeps the live theme', async () => {
    const { ctx, agent } = await mount()
    expect(await execute(ctx, agent, '/theme bogus')).toEqual({ kind: 'error', text: USAGE })
    expect(await execute(ctx, agent, '/theme dark extra')).toEqual({ kind: 'error', text: USAGE })
    expect(await execute(ctx, agent, '/theme custom')).toEqual({ kind: 'error', text: USAGE })
    expect(await execute(ctx, agent, `/theme custom ${join(dir, 'x.json')} light extra`))
      .toEqual({ kind: 'error', text: USAGE })
    expect(await execute(ctx, agent, '/theme')).toEqual({ kind: 'success' })
    expect(pickerRows(ctx).find(row => row.id === 'dark')?.badge).toBe(CURRENT_MARK)
  })

  it('restores the dark palette when the custom mount fails validation', async () => {
    const { ctx, agent } = await mount()
    const path = join(dir, 'custom-bogus.json')
    await writeFile(path, '{}')
    const result = await execute(ctx, agent, `/theme custom ${path} bogus`)
    expect(result?.kind).toBe('error')
    if (result?.kind === 'error') expect(result.text).toContain('failed to apply theme "custom"')
    expect(ctx.get('mayflyTheme')?.colors).toBe(themeDark.DARK_COLORS)
    expect(await execute(ctx, agent, '/theme')).toEqual({ kind: 'success' })
    expect(pickerRows(ctx).find(row => row.id === 'dark')?.badge).toBe(CURRENT_MARK)
  })

  it('unregisters the command when the fiber disposes', async () => {
    const { ctx, agent, fiber } = await mount()
    expect(ctx.commands.find(agent, 'theme')).toBeDefined()
    await fiber.dispose()
    expect(ctx.commands.find(agent, 'theme')).toBeUndefined()
  })
})
