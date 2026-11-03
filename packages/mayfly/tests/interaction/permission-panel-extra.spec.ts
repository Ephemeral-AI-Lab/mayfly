/** Additional `/permissions` panel decisions: unknown catalog entries, projection repaints, target changes,
 * non-Error write refusals, and the unavailable-command guard.
 * @module @ephemeral-ai/mayfly/tests/interaction/permission-panel-extra
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { PresetSpec } from '@deepseek-ai/dsh-permission-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  openPermissionPanel,
  registerPermissionsCommand,
  type PermissionPresetsService,
} from '../../src/interaction/permission-panel.ts'
import { mountUiRegistryObservers, UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import { fakeMayflyContext } from './fakes.ts'

const TABLE: readonly PresetSpec[] = [
  { name: 'read-only', sandbox: 'read-only', approval: 'ask' },
  { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
  { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
  { name: 'danger-ask', sandbox: 'danger-full-access', approval: 'ask' },
]

interface FakePresets extends PermissionPresetsService {
  currentValue: string
  readonly sets: { readonly session: unknown, readonly name: string }[]
}

function fakePresets(options: {
  current?: string
  extra?: readonly { readonly value: string, readonly name: string }[]
  refuse?: unknown
} = {}): FakePresets {
  const sets: { session: unknown, name: string }[] = []
  const options_: { readonly value: string, readonly name: string }[] = TABLE.map(preset => ({ value: preset.name!, name: preset.name! }))
  if (options.extra !== undefined) options_.push(...options.extra)
  const presets: FakePresets = {
    currentValue: options.current ?? 'workspace-write',
    sets,
    get names() { return options_.map(option => option.value) },
    get defaultPreset() { return 'workspace-write' },
    catalog: () => ({ options: options_, defaultOptions: options_, defaultPreset: 'workspace-write' }),
    current: () => presets.currentValue,
    resolve(name) {
      const preset = TABLE.find(candidate => candidate.name === name)
      if (preset === undefined) throw new Error(`unknown preset: ${name}`)
      return preset
    },
    optionOf: name => ({ value: name, name: name === 'custom' ? 'Custom' : name }),
    set(session, name) {
      if (options.refuse !== undefined) throw options.refuse
      sets.push({ session, name })
      presets.currentValue = name
    },
  }
  return presets
}

async function mount(presets: FakePresets = fakePresets()) {
  const { ctx } = fakeMayflyContext()
  const interaction = new UiInteractionService(ctx)
  mountUiRegistryObservers(ctx)
  await Promise.resolve()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('perm-extra'))
  const agent = { id: session.id, session, status: 'idle' } as unknown as Agent
  ctx.provide('testSession', { current: agent, modelRef: undefined })
  ctx.provide('permissionPresets', presets)
  const listeners: ((session: unknown, key: string) => void)[] = []
  vi.spyOn(ctx.sessionProjections, 'onChanged').mockImplementation(callback => {
    listeners.push(callback as never)
    return () => {}
  })
  const model = () => ctx.mayflyUiInteraction.get('overlay', 'mayfly.permission')!
  const notices = () => interaction.notificationSnapshot().map(item => item.message)
  return { ctx, agent, presets, interaction, listeners, model, notices }
}

describe('openPermissionPanel additional decisions', () => {
  it('lists a catalog option whose spec cannot be resolved without a knob description', async () => {
    const mounted = await mount(fakePresets({ extra: [{ value: 'ghost', name: 'Ghost' }] }))
    openPermissionPanel(mounted.ctx)
    const node = JSON.stringify(mounted.model().node)
    expect(node).toContain('"label":"Ghost"')
    expect(node).not.toContain('"label":"Ghost","detail"')
    expect(mounted.notices()).toEqual([])
  })

  it('repaints on the target session’s permissions projection only', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    const before = mounted.model().node
    mounted.presets.currentValue = 'read-only'
    mounted.listeners[0]!(mounted.agent.session, 'permissions')
    expect(JSON.stringify(mounted.model().node)).toContain('"id":"read-only","label":"read-only","detail":"sandbox read-only · approval ask","current":true')
    const after = mounted.model().node
    expect(after).not.toBe(before)
    mounted.listeners[0]!(mounted.agent.session, 'modelSelection')
    expect(mounted.model().node).toBe(after)
    mounted.listeners[0]!({ id: 'other' }, 'permissions')
    expect(mounted.model().node).toBe(after)
  })

  it('ignores a repaint after the picker closed and after the Agent was replaced', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    const open = mounted.model().node
    const replacement = { id: mounted.agent.id, session: mounted.agent.session, status: 'idle' } as unknown as Agent
    ;(mounted.ctx.get('testSession') as { current: Agent }).current = replacement
    mounted.listeners[0]!(mounted.agent.session, 'permissions')
    expect(mounted.model().node).toBe(open)
    mounted.ctx.mayflyOverlays.close('mayfly.permission')
    expect(() => mounted.listeners[0]!(mounted.agent.session, 'permissions')).not.toThrow()
  })

  it('asks a consequence-specific confirmation for full access that still prompts', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    mounted.presets.currentValue = 'custom'
    mounted.listeners[0]!(mounted.agent.session, 'permissions')
    const node = JSON.stringify(mounted.model().node)
    expect(node).toContain('"title":"Enable danger-ask?"')
    expect(node).toContain('Requests that require approval will still prompt.')
    expect(node).toContain('"title":"Enable danger-full-access?"')
    expect(node).toContain('Requests that still require approval will be rejected without prompting.')
  })

  it('reports a non-Error write refusal in words and stays open', async () => {
    const mounted = await mount(fakePresets({ refuse: 'write refused' }))
    openPermissionPanel(mounted.ctx)
    mounted.model().emit({ kind: 'selection-accept', pagePath: [], controlId: 'permissions', selectedIds: ['read-only'] })
    await vi.waitFor(() => { expect(mounted.notices()).toContain('permission dispatch failed: write refused') })
    expect(mounted.ctx.mayflyOverlays.list().some(entry => entry.id === 'mayfly.permission')).toBe(true)
  })
})

describe('registerPermissionsCommand without the native service', () => {
  it('answers with the unavailable message and registers the Mayfly name', async () => {
    const { ctx } = fakeMayflyContext()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('perm-missing-service'))
    ctx.provide('testSession', { current: { id: session.id, session, status: 'idle' } as unknown as Agent, modelRef: undefined })
    const off = registerPermissionsCommand(ctx)
    const agent = (ctx.get('testSession') as { current: Agent }).current
    expect(ctx.commands.find(agent, 'permissions')?.description).toBe('Choose the permission preset')
    const result = await ctx.commands.execute(agent, '/permissions', [], new AbortController().signal)
    expect(result?.result).toEqual({ kind: 'error', text: 'permission command is unavailable' })
    expect(ctx.mayflyOverlays.list()).toEqual([])
    off()
  })
})
