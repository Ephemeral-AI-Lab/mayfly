/**
 * REAL-composition test: boot mayfly-core, the real command runtime and
 * user-questions service, and the mayfly-interaction plugin through the real
 * Loader from a cordis.yml in a temp directory. Asserts the key batch, the
 * built-in commands, and the user-questions answerer register, and that
 * unloading the tree removes every contribution.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as mayflyCore from '../../src/core/index.ts'
import * as themeDark from '../../src/core/theme-dark.ts'
import { apply } from '../../src/interaction/index.ts'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'


registerTempDirCleanup()

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).__mayflyInteractionFixtures
})

/**
 * Boot a real Loader tree with mayfly-core, commands, user-questions, and
 * mayfly-interaction. Fixtures re-export the source-plane plugins through
 * globals because the Loader resolves through Node, not tsconfig paths.
 * @returns the root context and the terminal output observed so far.
 */
async function bootInteraction(): Promise<{ ctx: Context; output: () => string }> {
  const dir = mkdtempTracked('mayfly-interaction-')
  ;(globalThis as Record<string, unknown>).__mayflyInteractionFixtures = {
    coreApply: mayflyCore.apply,
    themeDarkApply: themeDark.apply,
    commands: CommandRuntime,
    userQuestions: UserQuestionService,
    interactionApply: apply,
  }
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: mayfly-core',
    `  name: ${pathToFileURL(join(dir, 'core.mjs')).href}`,
    // mayflyTheme moved out of mayfly-core into the theme-dark subpath plugin;
    // interaction's inject on mayflyTheme needs this row to activate.
    '- id: mayfly-theme-dark',
    `  name: ${pathToFileURL(join(dir, 'theme-dark.mjs')).href}`,
    '- id: commands',
    `  name: ${pathToFileURL(join(dir, 'commands.mjs')).href}`,
    '- id: user-questions',
    `  name: ${pathToFileURL(join(dir, 'user-questions.mjs')).href}`,
    '- id: mayfly-interaction',
    `  name: ${pathToFileURL(join(dir, 'interaction.mjs')).href}`,
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'core.mjs'), `
export const name = 'mayfly-core'
export const apply = ctx => globalThis.__mayflyInteractionFixtures.coreApply(ctx)
`)
  writeFileSync(join(dir, 'theme-dark.mjs'), `
export const name = 'mayfly-theme-dark'
export const apply = ctx => globalThis.__mayflyInteractionFixtures.themeDarkApply(ctx)
`)
  writeFileSync(join(dir, 'commands.mjs'), `
export default globalThis.__mayflyInteractionFixtures.commands
`)
  writeFileSync(join(dir, 'user-questions.mjs'), `
export default globalThis.__mayflyInteractionFixtures.userQuestions
`)
  writeFileSync(join(dir, 'interaction.mjs'), `
export const name = 'mayfly-interaction'
export const inject = ['mayflyCurrentAgent', 'skills']
export const apply = ctx => globalThis.__mayflyInteractionFixtures.interactionApply(ctx)
`)

  const chunks: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })

  const ctx = new Context()
  ctx.provide('mayflyCurrentAgent', {
    current: () => null,
    revision: () => 0,
    subscribe: (listener: (agent: null, revision: number) => void) => {
      listener(null, 0)
      return () => {}
    },
  } as never)
  ctx.provide('skills', { snapshot: async () => ({ complete: true, skills: [] }) } as never)
  ctx.provide('sessionProjections', {
    snapshot: () => ({ asOfSeq: 0, values: {} }),
    onChanged: () => () => {},
  } as never)
  ctx.provide('sessionController', { selectModel: async () => { throw new Error('no session') } } as never)
  ctx.provide('sessions', { list: () => [], flush: async () => false } as never)
  ctx.provide('tools', { schemas: () => [] } as never)
  ctx.provide('mayflyRequests', {
    sessionEpoch: 0,
    active: () => undefined,
    begin: () => ({ sessionEpoch: 0, requestEpoch: 1, scope: 'main' }),
    transition: () => {},
    interrupt: () => {},
    commitSession: () => 0,
  } as never)
  ctx.provide('mayflyRetractions', { tryRetract: () => false })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return { ctx, output: () => chunks.join('') }
}

/** A bare-agent stand-in for registry lookups (no command execution). */
function lookupAgent(): Agent {
  return { id: 'lookup' } as unknown as Agent
}

describe('mayfly-interaction through the real Loader', () => {
  it('registers the key batch, the built-in commands, and the questions answerer', async () => {
    const { ctx } = await bootInteraction()
    expect(ctx.get('mayflyKeymap')?.getKeys('mayfly.interaction.submit')).toEqual(['enter'])
    expect(ctx.get('mayflyKeymap')?.getKeys('mayfly.interaction.interrupt')).toEqual(['ctrl+c'])
    expect(ctx.get('mayflyKeymap')?.getKeys('mayfly.interaction.steer')).toEqual(['ctrl+s'])
    expect(ctx.commands.find(lookupAgent(), 'quit')).toBeDefined()
    expect(ctx.commands.find(lookupAgent(), 'sessions')).toBeDefined()
    const controller = new AbortController()
    const pending = ctx.userQuestions.ask({
      questions: [{ id: 'loaded', question: 'Loaded?' }],
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })

  it('removes every contribution when the tree unloads', async () => {
    const { ctx, output } = await bootInteraction()
    await ctx.fiber.dispose()
    expect(ctx.get('mayflyKeymap')?.getKeys('mayfly.interaction.submit') ?? []).toEqual([])
    expect(ctx.get('mayflyKeymap')?.getKeys('mayfly.interaction.interrupt') ?? []).toEqual([])
    expect(ctx.get('commands')).toBeUndefined()
    expect(ctx.get('userQuestions')).toBeUndefined()
    // ProcessTerminal.stop disables bracketed paste on the real stdout.
    expect(output()).toContain('\x1b[?2004l')
  })
})
