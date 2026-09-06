/** Native dsh projection and command-backed mode cycling tests.
 * @module @ephemeral-ai/mayfly/interaction/tests/mode-commands
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { cycleMode, sessionModeSnapshot } from '../../src/interaction/mode-commands.ts'
import { setSharedEditor } from '../../src/interaction/editor-instance.ts'
import type { PermissionPresetsService } from '../../src/interaction/permission-panel.ts'
import { fakeMayflyContext } from './fakes.ts'

let notices: string[] = []

afterEach(() => { notices = [] })

interface PlanState { active: boolean, pending: boolean }
interface MountOptions {
  readonly attached?: boolean
  readonly plan?: false | Partial<PlanState>
  readonly presets?: false | readonly { readonly name: string, readonly sandbox: string, readonly approval: string }[]
  readonly currentPreset?: string
  readonly registerPlan?: boolean
  readonly registerPermission?: boolean
  readonly resultFor?: (line: string) => { kind: 'success' | 'error', text?: string }
  readonly throws?: unknown
}

async function mount(options: MountOptions = {}) {
  const { ctx } = fakeMayflyContext()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('mode-spec'))
  const agent = { id: session.id, session, status: 'idle' } as unknown as Agent
  ctx.provide('testSession', { current: options.attached === false ? null : agent })
  const plan = options.plan === false ? undefined : { active: options.plan?.active === true, pending: options.plan?.pending === true }
  vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementation(() => ({
    asOfSeq: session.seq - 1,
    values: plan === undefined ? {} : { plan: { ...plan } },
  }))

  const presetRows = options.presets === false
    ? undefined
    : options.presets ?? [
      { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
      { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
    ]
  let currentPreset = options.currentPreset ?? 'workspace-write'
  if (presetRows !== undefined) {
    ctx.provide('permissionPresets', {
      names: presetRows.map(row => row.name),
      current: () => currentPreset,
      resolve: name => {
        const row = presetRows.find(entry => entry.name === name)
        if (row === undefined) throw new Error(`missing preset ${name}`)
        return row
      },
      optionOf: name => ({ value: name, name }),
    } satisfies PermissionPresetsService as never)
  }

  const runs: string[] = []
  const execute = (line: string) => {
    runs.push(line)
    if (options.throws !== undefined) throw options.throws
    const result = options.resultFor?.(line) ?? { kind: 'success' as const, text: `ran ${line}` }
    if (result.kind === 'success') {
      if (line === '/plan' && plan !== undefined) { plan.active = true; plan.pending = false }
      if (line === '/plan off' && plan !== undefined) { plan.active = false; plan.pending = false }
      if (line.startsWith('/permission ')) currentPreset = line.slice('/permission '.length)
    }
    return result
  }
  if (options.registerPlan !== false) {
    ctx.commands.register({
      name: 'plan', description: 'Toggle plan mode',
      handler: invocation => execute(`/plan${invocation.rawInput}`),
    })
  }
  if (options.registerPermission !== false) {
    ctx.commands.register({
      name: 'permission', description: 'Switch permission preset',
      handler: invocation => execute(`/permission${invocation.rawInput}`),
    })
  }
  setSharedEditor(ctx, {
    editor: { focused: false, render: () => [], invalidate: () => {} } as never,
    submitPrompt: () => {},
    notice: text => { notices.push(text) },
  })
  return { ctx, agent, plan, runs, currentPreset: () => currentPreset }
}

describe('cycleMode', () => {
  it('toggles normal and plan without changing permissions', async () => {
    const world = await mount()
    expect(sessionModeSnapshot(world.ctx, world.agent)).toEqual({ plan: { active: false, pending: false }, yolo: false })

    await cycleMode(world.ctx)
    expect(world.runs).toEqual(['/plan'])
    expect(sessionModeSnapshot(world.ctx, world.agent).plan?.active).toBe(true)

    await cycleMode(world.ctx)
    expect(world.runs).toEqual(['/plan', '/plan off'])
    expect(world.currentPreset()).toBe('workspace-write')
    expect(sessionModeSnapshot(world.ctx, world.agent).plan?.active).toBe(false)
    expect(notices).toEqual(['ran /plan', 'ran /plan off'])
  })

  it('preserves yolo while entering and leaving plan, until an explicit permission command', async () => {
    const world = await mount({ currentPreset: 'danger-full-access' })
    const execute = vi.spyOn(world.ctx.commands, 'execute')
    await cycleMode(world.ctx)
    expect(sessionModeSnapshot(world.ctx, world.agent)).toEqual({ plan: { active: true, pending: false }, yolo: true })
    await cycleMode(world.ctx)
    expect(world.runs).toEqual(['/plan', '/plan off'])
    expect(world.currentPreset()).toBe('danger-full-access')
    expect(sessionModeSnapshot(world.ctx, world.agent)).toEqual({ plan: { active: false, pending: false }, yolo: true })
    expect(execute.mock.calls.every(call => call[0] === world.agent)).toBe(true)

    await cycleMode(world.ctx)
    await world.ctx.commands.execute(world.agent, '/permission workspace-write', [], new AbortController().signal)
    expect(sessionModeSnapshot(world.ctx, world.agent)).toEqual({ plan: { active: true, pending: false }, yolo: false })
    await world.ctx.commands.execute(world.agent, '/permission danger-full-access', [], new AbortController().signal)
    expect(sessionModeSnapshot(world.ctx, world.agent)).toEqual({ plan: { active: true, pending: false }, yolo: true })
  })

  it.each([
    { active: false, pending: false, command: '/plan' },
    { active: false, pending: true, command: '/plan off' },
    { active: true, pending: false, command: '/plan off' },
    { active: true, pending: true, command: '/plan' },
  ])('toggles the selected state with active=$active pending=$pending', async ({ active, pending, command }) => {
    const world = await mount({ plan: { active, pending }, currentPreset: 'danger-full-access' })
    await cycleMode(world.ctx)
    expect(world.runs).toEqual([command])
    expect(world.currentPreset()).toBe('danger-full-access')
  })

  it('does not fall back to changing permissions when plan is unavailable', async () => {
    const permissionsOnly = await mount({ plan: false })
    await cycleMode(permissionsOnly.ctx)
    expect(permissionsOnly.runs).toEqual([])
    expect(notices).toEqual(['plan mode is unavailable'])
    expect(permissionsOnly.currentPreset()).toBe('workspace-write')

    notices = []
    const planOnly = await mount({ plan: { active: true }, presets: false })
    await cycleMode(planOnly.ctx)
    expect(planOnly.runs).toEqual(['/plan off'])

    notices = []
    const absent = await mount({ plan: false, presets: false })
    await cycleMode(absent.ctx)
    expect(notices).toEqual(['plan mode is unavailable'])
    expect(sessionModeSnapshot(absent.ctx, absent.agent)).toEqual({ plan: undefined, yolo: false })
  })

  it.each(['unconfined', 'alias', 'ask-full', 'custom'])('derives yolo from the selected preset bundle: %s', async currentPreset => {
    const world = await mount({ currentPreset, presets: [
      { name: 'unconfined', sandbox: 'danger-full-access', approval: 'never' },
      { name: 'alias', sandbox: 'danger-full-access', approval: 'never' },
      { name: 'ask-full', sandbox: 'danger-full-access', approval: 'ask' },
    ] })
    expect(sessionModeSnapshot(world.ctx, world.agent).yolo).toBe(currentPreset === 'unconfined' || currentPreset === 'alias')
    await cycleMode(world.ctx)
    expect(world.runs).toEqual(['/plan'])
    expect(world.currentPreset()).toBe(currentPreset)
  })

  it('publishes success, paints errors, and keeps textless success quiet', async () => {
    const failed = await mount({
      plan: { active: true },
      resultFor: () => ({ kind: 'error', text: 'denied' }),
    })
    await cycleMode(failed.ctx)
    expect(failed.runs).toEqual(['/plan off'])
    expect(failed.plan?.active).toBe(true)
    expect(notices).toEqual(['!denied!'])

    notices = []
    const textless = await mount({ resultFor: () => ({ kind: 'success' }) })
    await cycleMode(textless.ctx)
    expect(notices).toEqual([])
  })

  it('guards detached sessions and missing native commands', async () => {
    const detached = await mount({ attached: false })
    await cycleMode(detached.ctx)
    expect(notices).toEqual(['no session is live yet'])

    notices = []
    const missing = await mount({ registerPlan: false })
    await cycleMode(missing.ctx)
    expect(notices).toEqual(['mode command is unavailable: /plan'])
  })

  it('contains command dispatch failures in the logger', async () => {
    const world = await mount({ throws: new Error('dispatch failed') })
    const warn = vi.spyOn(world.ctx.logger, 'warn').mockImplementation(() => {})
    await cycleMode(world.ctx)
    expect(warn).toHaveBeenCalledWith('mode cycle dispatch failed: dispatch failed')

    const bare = await mount({ throws: 'bare failure' })
    const bareWarn = vi.spyOn(bare.ctx.logger, 'warn').mockImplementation(() => {})
    await cycleMode(bare.ctx)
    expect(bareWarn).toHaveBeenCalledWith('mode cycle dispatch failed: bare failure')
  })
})
