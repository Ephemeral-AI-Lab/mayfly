/**
 * Unit tests for the Mayfly-only `/permissions` panel: catalog row
 * construction, the projection-derived current mark and `custom` row, the
 * danger-full-access Yes/No confirmation, native `set()` writes (never the
 * native `/permission` command), the `/permissions` registration name, and
 * the degraded guards. The panel mounts through the fake editor-slot swap
 * (the FakeScreen overlay registry).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { openPermissionPanel, registerPermissionsCommand, type PermissionPresetsService } from '../../src/interaction/permission-panel.ts'
import { fakeMayflyContext } from './fakes.ts'
import { KEY } from './fakes.ts'
import { mountUiRegistryObservers, UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import type { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { renderRequest } from './request-fixture.ts'
import * as uiProvider from '../../../ui/src/provider.ts'

/** The dsh-base preset table, with the display names bare keys get. */
const TABLE = [
  { name: 'read-only', sandbox: 'read-only', approval: 'ask' },
  { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
  { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
] as const

interface FakePresets extends PermissionPresetsService {
  readonly sets: { readonly session: unknown, readonly name: string }[]
  currentValue: string
}

/**
 * The fake preset service: the native catalog/projection surface without the
 * native write internals. `set` records the exact Session the panel names.
 */
function fakePresets(behavior: { current?: string, throwOnSet?: boolean } = {}): FakePresets {
  const sets: { session: unknown, name: string }[] = []
  const presets: FakePresets = {
    currentValue: behavior.current ?? 'workspace-write',
    sets,
    get names() { return TABLE.map(entry => entry.name) },
    get defaultPreset() { return 'workspace-write' },
    catalog() {
      return {
        options: TABLE.map(entry => ({ value: entry.name, name: entry.name })),
        defaultOptions: TABLE.map(entry => ({ value: entry.name, name: entry.name })),
        defaultPreset: 'workspace-write',
      }
    },
    current() { return presets.currentValue },
    resolve(name) {
      const entry = TABLE.find(row => row.name === name)
      if (entry === undefined) throw new Error(`unknown preset: ${name}`)
      return entry
    },
    optionOf(name) {
      return name === 'custom'
        ? { value: 'custom', name: 'Custom', description: 'derived state' }
        : { value: name, name }
    },
    set(session, name) {
      if (behavior.throwOnSet === true) throw new Error('write refused')
      sets.push({ session, name })
      presets.currentValue = name
    },
  }
  return presets
}

async function mount(presets: FakePresets = fakePresets()): Promise<{
  ctx: Context
  agent: Agent
  presets: FakePresets
  notices: string[]
  nativeRuns: string[]
  overlays: { component: { render(width: number): string[], handleInput(data: string): void }, hidden: boolean }[]
}> {
  const { ctx } = fakeMayflyContext()
  const interaction = new UiInteractionService(ctx)
  mountUiRegistryObservers(ctx)
  await Promise.resolve()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('perm-spec'))
  const agent = { id: session.id, session, status: 'idle' } as unknown as Agent
  ctx.provide('testSession', { current: agent, modelRef: undefined })
  ctx.provide('permissionPresets', presets)
  /* The native command stays registered; the panel must never dispatch it. */
  const nativeRuns: string[] = []
  ctx.commands.register({
    name: 'permission',
    description: 'native permission command',
    input: { hint: '<preset>' },
    handler: invocation => { nativeRuns.push(String(invocation.rawInput)); return { kind: 'success' as const } },
  })
  const notices: string[] = []
  interaction.subscribe(() => { notices.splice(0, notices.length, ...interaction.notificationSnapshot().map(item => item.message)) })
  const drivers = new WeakMap<UiSurfaceModel, { component: { render(width: number): string[], handleInput(data: string): void }, hidden: boolean }>()
  const overlays = () => ctx.mayflyOverlays.list().map(entry => {
    const model = interaction.get('overlay', entry.id)!
    const previous = drivers.get(model)
    if (previous !== undefined) return { ...previous, hidden: entry.hidden }
    // The surface renderer recompiles on every model revision; mirror that here.
    let compiled = renderRequest(model)
    let compiledRevision = model.revision
    const sync = (width = 80) => {
      if (compiledRevision !== model.revision) {
        compiled = renderRequest(model, { columns: width, rows: 24 }, compiled.runtime)
        compiledRevision = model.revision
      }
      return compiled
    }
    const driver = { component: { render: (width: number) => sync(width).component.render(width), handleInput: (data: string) => sync().input(data) }, hidden: entry.hidden }
    drivers.set(model, driver)
    return driver
  })
  return { ctx, agent, presets, notices, nativeRuns, get overlays() { return overlays() } }
}

/** The topmost non-hidden overlay's panel. */
function top(mounted: { overlays: { component: { render(width: number): string[], handleInput(data: string): void }, hidden: boolean }[] }) {
  const overlay = mounted.overlays.at(-1)
  if (overlay === undefined) throw new Error('no panel mounted')
  return overlay
}

describe('openPermissionPanel', () => {
  it('renders the native catalog with derived knob descriptions and the current mark', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    const lines = top(mounted).component.render(80)
    expect(lines.join('\n')).toContain('Permissions')
    expect(lines.join('\n')).toContain('read-only')
    expect(lines.join('\n')).toContain('sandbox read-only · approval ask')
    expect(lines.join('\n')).toContain('sandbox danger-full-access · approval never')
    const currentRow = lines.find(line => line.includes('workspace-write')) ?? ''
    expect(currentRow).toContain('✓')
  })

  it('writes the selected preset through permissionPresets.set, not the native command', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    // The cursor seeds on the current preset: Up reaches read-only.
    top(mounted).component.handleInput(KEY.up)
    top(mounted).component.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(mounted.presets.sets).toEqual([{ session: mounted.agent.session, name: 'read-only' }]) })
    await vi.waitFor(() => { expect(mounted.notices).toContain('Permission preset: read-only') })
    expect(mounted.nativeRuns).toEqual([])
    expect(mounted.overlays).toEqual([])
  })

  it('paints a native write refusal as an error notice and stays on the panel', async () => {
    const mounted = await mount(fakePresets({ throwOnSet: true }))
    openPermissionPanel(mounted.ctx)
    top(mounted).component.handleInput(KEY.up)
    top(mounted).component.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(mounted.notices).toContain('permission dispatch failed: write refused') })
    expect(mounted.presets.sets).toEqual([])
    expect(mounted.overlays).toHaveLength(1)
  })

  it('shows but skips the disabled derived custom row', async () => {
    const mounted = await mount(fakePresets({ current: 'custom' }))
    openPermissionPanel(mounted.ctx)
    const frame = top(mounted).component.render(80).join('\n')
    expect(frame).toContain('Custom')
    top(mounted).component.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(mounted.presets.sets).toEqual([{ session: mounted.agent.session, name: 'read-only' }]) })
    expect(mounted.overlays).toEqual([])
  })

  it('rejects a forged selection event for the disabled derived row', async () => {
    const mounted = await mount(fakePresets({ current: 'custom' }))
    openPermissionPanel(mounted.ctx)
    mounted.ctx.mayflyUiInteraction.get('overlay', 'mayfly.permission')!.emit({ kind: 'selection-accept', pagePath: [], controlId: 'permissions', selectedIds: ['custom'] })
    expect(mounted.presets.sets).toEqual([])
    top(mounted).component.handleInput(KEY.escape)
  })

  it('asks the shared No-first decision before a full-access write', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    const node = JSON.stringify(mounted.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.permission')!.node)
    expect(node).toContain('"id":"danger-full-access"')
    expect(node).toContain('"title":"Enable danger-full-access?"')
    expect(node).toContain('rejected without prompting')
    top(mounted).component.handleInput(KEY.escape)
    expect(mounted.presets.sets).toEqual([])
  })

  it('writes a confirmed full-access selection through the native service', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    const picker = mounted.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.permission')!
    const context = { surfaceId: picker.id, operationId: 'confirmed', source: picker.source, revision: picker.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await picker.definition.onEvent!.action!(
      { kind: 'selection-accept', pagePath: [], controlId: 'permissions', selectedIds: ['danger-full-access'] },
      context,
    )).toMatchObject({ kind: 'completed', dismiss: true })
    expect(mounted.presets.sets).toEqual([{ session: mounted.agent.session, name: 'danger-full-access' }])
  })

  it('cancels a write after the selected Agent is replaced', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    const replacement = { id: mounted.agent.id, session: mounted.agent.session, status: 'idle' } as unknown as Agent
    ;(mounted.ctx.get('testSession') as { current: Agent | null }).current = replacement
    mounted.ctx.mayflyUiInteraction.get('overlay', 'mayfly.permission')!.emit({ kind: 'selection-accept', pagePath: [], controlId: 'permissions', selectedIds: ['read-only'] })
    await vi.waitFor(() => expect(mounted.overlays).toEqual([]))
    expect(mounted.presets.sets).toEqual([])
    await vi.waitFor(() => expect(mounted.notices).toContain('permission target changed; action cancelled'))
  })

  it('cancels back to the editor without dispatching', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    top(mounted).component.handleInput(KEY.escape)
    await vi.waitFor(() => expect(mounted.overlays).toEqual([]))
    expect(mounted.presets.sets).toEqual([])
    expect(mounted.notices).toEqual([])
  })

  it('reports and does nothing when the Mayfly UI registry is not mounted', async () => {
    const bare = new Context()
    const interaction = new UiInteractionService(bare)
    await bare.plugin(SessionStore)
    await bare.plugin(CommandRuntime)
    bare.sessions.create(SessionId('perm-bare'))
    bare.provide('permissionPresets', fakePresets())
    openPermissionPanel(bare)
    expect(interaction.notificationSnapshot().map(item => item.message)).toEqual(['permission picker is unavailable: the Mayfly UI registry is not mounted'])
  })

  it('is a silent no-op without the preset service', async () => {
    const { ctx } = fakeMayflyContext()
    await ctx.plugin(SessionStore)
    ctx.sessions.create(SessionId('perm-noservice'))
    openPermissionPanel(ctx)
    expect(ctx.mayflyOverlays.list()).toHaveLength(0)
  })

  it('is a silent no-op without a current Agent', async () => {
    const mounted = await mount()
    ;(mounted.ctx.get('testSession') as { current: Agent | null }).current = null
    openPermissionPanel(mounted.ctx)
    expect(mounted.overlays).toHaveLength(0)
  })

  it('is a silent no-op without the current-Agent service', async () => {
    const ctx = new Context()
    await ctx.plugin(uiProvider)
    ctx.provide('permissionPresets', fakePresets())
    openPermissionPanel(ctx)
    expect(ctx.mayflyOverlays.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('explains the derived custom row, ignores direct custom selection, and closes for a replaced Agent', async () => {
    const mounted = await mount(fakePresets({ current: 'custom' }))
    openPermissionPanel(mounted.ctx)
    expect(top(mounted).component.render(120).join('\n')).toContain('custom is the derived state — pick a preset')
    const picker = mounted.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.permission')!
    const context = { surfaceId: picker.id, operationId: 'direct', source: picker.source, revision: picker.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await picker.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'permissions', selectedIds: ['custom'] }, context)).toEqual({ kind: 'completed' })
    expect(await picker.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'x', actionId: 'x' }, context)).toEqual({ kind: 'completed' })
    expect(mounted.presets.sets).toEqual([])
    const replacement = { id: mounted.agent.id, session: mounted.agent.session, status: 'idle' } as unknown as Agent
    ;(mounted.ctx.get('testSession') as { current: Agent | null }).current = replacement
    mounted.ctx.emit('test/session-changed', replacement)
    await vi.waitFor(() => expect(mounted.overlays).toEqual([]))
  })
})

describe('registerPermissionsCommand', () => {
  it('registers the Mayfly-owned /permissions name and leaves the native /permission command alone', async () => {
    const { ctx } = fakeMayflyContext()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('perm-register'))
    ctx.provide('testSession', { current: { id: session.id, session, status: 'idle' } as unknown as Agent, modelRef: undefined })
    ctx.provide('permissionPresets', fakePresets())
    const register = vi.spyOn(ctx.mayflyInteractionState.sessionless, 'register')
    const native = ctx.commands.register({ name: 'permission', description: 'native', handler: () => ({ kind: 'success' as const }) })
    const off = registerPermissionsCommand(ctx)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'permissions' }))
    const agent = (ctx.get('testSession') as { current: Agent }).current
    expect(ctx.commands.find(agent, 'permission')?.description).toBe('native')
    expect(ctx.commands.find(agent, 'permissions')?.description).toBe('Choose the permission preset')
    await ctx.commands.execute(agent, '/permissions', [], new AbortController().signal)
    expect(ctx.mayflyOverlays.list().some(entry => entry.id === 'mayfly.permission')).toBe(true)
    off()
    native()
  })
})
