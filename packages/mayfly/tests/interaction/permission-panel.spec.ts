/**
 * Unit tests for the `/permission` preset picker: row construction from
 * the preset service, the current badge and derived `custom` row, the
 * danger-full-access Yes/No confirmation, dispatch through the real command
 * runtime, and the degraded guards. The panel mounts through the fake
 * D30 editor-slot swap (the FakeScreen overlay registry).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { openPermissionPanel, type PermissionPresetsService } from '../../src/interaction/permission-panel.ts'
import { fakeMayflyContext } from './fakes.ts'
import { KEY } from './fakes.ts'
import { mountUiRegistryObservers, UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import type { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { renderRequest } from './request-fixture.ts'
import * as uiProvider from '../../../ui/src/provider.ts'

/** The dsh-base three-preset table, with the display names bare keys get. */
const TABLE = [
  { name: 'read-only', sandbox: 'read-only', approval: 'ask' },
  { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
  { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
]

/**
 * The fake preset service: a fixed table, a switchable current value, and
 * the same derived-`custom` option shape the real service hardcodes.
 */
function fakePresets(behavior: { current?: string } = {}): PermissionPresetsService {
  const current = behavior.current ?? 'workspace-write'
  return {
    names: TABLE.map(entry => entry.name),
    current: () => current,
    resolve: name => {
      const entry = TABLE.find(row => row.name === name)
      if (entry === undefined) throw new Error(`unknown preset: ${name}`)
      return entry
    },
    optionOf: name => name === 'custom'
      ? { value: 'custom', name: 'Custom', description: 'derived state' }
      : { value: name, name },
  }
}

interface MountOptions {
  presets?: PermissionPresetsService
  /** What the spy /permission command returns for every dispatch. */
  outcome?: { kind: 'success', text: string } | { kind: 'error', text: string }
  /** Register the spy command (default); false leaves /permission absent. */
  registerCommand?: boolean
  /** Make the spy succeed with no result text. */
  textless?: boolean
  /** Make the spy handler throw (Error or bare string). */
  reject?: Error | string
}

async function mount(options: MountOptions = {}): Promise<{
  ctx: Context
  agent: Agent
  notices: string[]
  runs: string[]
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
  ctx.provide('permissionPresets', options.presets ?? fakePresets())
  const runs: string[] = []
  if (options.registerCommand !== false) {
    ctx.commands.register({
      name: 'permission',
      description: 'spy standing in for the upstream command',
      input: { hint: '<preset>' },
      handler: invocation => {
        runs.push(invocation.rawInput)
        // Mirror the upstream command: rawInput arrives with the leading
        // space; the result text names the trimmed preset.
        const name = invocation.rawInput.trim()
        if (options.textless === true) return { kind: 'success' as const }
        if (options.reject !== undefined) throw options.reject
        return options.outcome ?? { kind: 'success' as const, text: `preset ${name}` }
      },
    })
  }
  const notices: string[] = []
  interaction.subscribe(() => { notices.splice(0, notices.length, ...interaction.notificationSnapshot().map(item => item.message)) })
  const drivers = new WeakMap<UiSurfaceModel, { component: { render(width: number): string[], handleInput(data: string): void }, hidden: boolean }>()
  const overlays = () => ctx.mayflyOverlays.list().map(entry => {
    const model = interaction.get('overlay', entry.id)!
    const previous = drivers.get(model)
    if (previous !== undefined) return { ...previous, hidden: entry.hidden }
    let compiled = renderRequest(model)
    const sync = (width = 80) => {
      if (compiled.runtime.interaction?.revision !== model.revision) compiled = renderRequest(model, { columns: width, rows: 24 }, compiled.runtime)
      return compiled
    }
    const driver = { component: { render: (width: number) => sync(width).component.render(width), handleInput: (data: string) => sync().input(data) }, hidden: entry.hidden }
    drivers.set(model, driver)
    return driver
  })
  return { ctx, agent, notices, runs, get overlays() { return overlays() } }
}

/** The topmost non-hidden overlay's panel. */
function top(mounted: { overlays: { component: { render(width: number): string[], handleInput(data: string): void }, hidden: boolean }[] }) {
  const overlay = mounted.overlays.at(-1)
  if (overlay === undefined) throw new Error('no panel mounted')
  return overlay
}

describe('openPermissionPanel', () => {
  it('renders the table with derived knob descriptions and the current badge', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    const lines = top(mounted).component.render(80)
    expect(lines.join('\n')).toContain('Permissions')
    expect(lines.join('\n')).toContain('read-only')
    expect(lines.join('\n')).toContain('sandbox read-only · approval ask')
    expect(lines.join('\n')).toContain('sandbox danger-full-access · approval never')
    const currentRow = lines.find(line => line.includes('workspace-write')) ?? ''
    expect(currentRow).toContain('← current')
  })

  it('dispatches the selected preset through the command runtime', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    // The cursor seeds on the current preset: Enter switches straight off it.
    top(mounted).component.handleInput(KEY.enter)
    // The runtime hands the handler the raw input after the command name
    // (leading space included); the upstream command trims it itself.
    await vi.waitFor(() => { expect(mounted.runs).toEqual([' workspace-write']) })
    await vi.waitFor(() => { expect(mounted.notices).toContain('preset workspace-write') })
    expect(mounted.overlays).toEqual([])
  })

  it('paints an error result notice in error red', async () => {
    const mounted = await mount({ outcome: { kind: 'error', text: 'unknown preset "nope"' } })
    openPermissionPanel(mounted.ctx)
    top(mounted).component.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(mounted.notices).toContain('unknown preset "nope"') })
  })

  it('shows but skips the disabled derived custom row', async () => {
    const mounted = await mount({ presets: fakePresets({ current: 'custom' }) })
    openPermissionPanel(mounted.ctx)
    const frame = top(mounted).component.render(80).join('\n')
    expect(frame).toContain('Custom')
    // The disabled custom row is visible but not part of roving focus.
    top(mounted).component.handleInput(KEY.up)
    top(mounted).component.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(mounted.runs).toEqual([' read-only']) })
    expect(mounted.notices).not.toContain('?custom is the derived state — pick a preset?')
    expect(mounted.overlays).toEqual([])
  })

  it('rejects a forged selection event for the disabled derived row', async () => {
    const mounted = await mount({ presets: fakePresets({ current: 'custom' }) })
    openPermissionPanel(mounted.ctx)
    mounted.ctx.mayflyUiInteraction.get('overlay', 'mayfly.permission')!.emit({ kind: 'selection-accept', pagePath: [], controlId: 'permissions', selectedIds: ['custom'] })
    expect(mounted.notices).toEqual([])
    expect(mounted.runs).toEqual([])
    top(mounted).component.handleInput(KEY.escape)
  })

  it('gates danger-full-access behind Yes/No actions and returns to the list on Esc', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    // Seed is workspace-write (row 1); one Down reaches the danger row.
    top(mounted).component.handleInput(KEY.down)
    top(mounted).component.handleInput(KEY.enter)
    await vi.waitFor(() => expect(mounted.overlays).toHaveLength(2))
    const gate = top(mounted)
    expect(gate.component.render(80).join('\n')).toContain('Full access')
    // Esc pops the gate; the picker beneath is still live.
    gate.component.handleInput(KEY.escape)
    await vi.waitFor(() => expect(mounted.overlays).toHaveLength(1))
    expect(mounted.overlays[0]!.hidden).toBe(false)
    expect(mounted.runs).toEqual([])
  })

  it('defaults to No and dispatches only after selecting Yes', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    top(mounted).component.handleInput(KEY.down)
    top(mounted).component.handleInput(KEY.enter)
    await vi.waitFor(() => expect(mounted.overlays).toHaveLength(2))
    const gate = top(mounted)
    expect(gate.component.render(80).join('\n')).toContain('Yes')
    expect(gate.component.render(80).join('\n')).toContain('No')
    gate.component.handleInput('y')
    expect(mounted.runs).toEqual([])
    gate.component.handleInput(KEY.enter)
    await vi.waitFor(() => expect(mounted.overlays).toHaveLength(1))
    expect(mounted.runs).toEqual([])
    mounted.overlays[0]!.component.handleInput(KEY.enter)
    await vi.waitFor(() => expect(mounted.overlays).toHaveLength(2))
    top(mounted).component.handleInput(KEY.left)
    top(mounted).component.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(mounted.runs).toEqual([' danger-full-access']) })
    await vi.waitFor(() => { expect(mounted.notices).toContain('preset danger-full-access') })
    expect(mounted.overlays).toEqual([])
  })

  it('describes a custom full-access preset that still asks for approval', async () => {
    const presets = fakePresets()
    const mounted = await mount({ presets: {
      ...presets,
      resolve: name => ({ ...presets.resolve(name), approval: 'ask' }),
    } })
    openPermissionPanel(mounted.ctx)
    top(mounted).component.handleInput(KEY.down)
    top(mounted).component.handleInput(KEY.enter)
    await vi.waitFor(() => expect(mounted.overlays).toHaveLength(2))
    expect(top(mounted).component.render(120).join('\n')).toContain('will still prompt')
    top(mounted).component.handleInput(KEY.escape)
    expect(mounted.runs).toEqual([])
  })

  it('cancels back to the editor without dispatching', async () => {
    const mounted = await mount()
    openPermissionPanel(mounted.ctx)
    top(mounted).component.handleInput(KEY.escape)
    await vi.waitFor(() => expect(mounted.overlays).toEqual([]))
    expect(mounted.runs).toEqual([])
    expect(mounted.notices).toEqual([])
  })

  it('reports a dispatch against an unregistered command', async () => {
    const mounted = await mount({ registerCommand: false })
    openPermissionPanel(mounted.ctx)
    top(mounted).component.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(mounted.overlays).toEqual([]) })
    expect(mounted.notices).toEqual(['permission command is unavailable'])
  })

  it('stays silent for a success result without text', async () => {
    const mounted = await mount({ textless: true })
    openPermissionPanel(mounted.ctx)
    top(mounted).component.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(mounted.runs).toEqual([' workspace-write']) })
    await vi.waitFor(() => { expect(mounted.notices).toEqual([]) })
  })

  it('reports an Error dispatch rejection', async () => {
    const mounted = await mount({ reject: new Error('route exploded') })
    openPermissionPanel(mounted.ctx)
    top(mounted).component.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(mounted.notices).toEqual(['permission dispatch failed: route exploded']) })
  })

  it('renders a non-Error dispatch rejection through String()', async () => {
    const mounted = await mount({ reject: 'bare boom' })
    openPermissionPanel(mounted.ctx)
    top(mounted).component.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(mounted.notices).toEqual(['permission dispatch failed: bare boom']) })
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
    // The input-layer interception probes the service first; the panel
    // function's own guard keeps it inert if reached anyway.
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

  it('handles direct custom selection and focuses an existing danger confirmation', async () => {
    const mounted = await mount({ presets: fakePresets({ current: 'custom' }) })
    openPermissionPanel(mounted.ctx)
    const picker = mounted.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.permission')!
    const context = { surfaceId: picker.id, operationId: 'direct', source: picker.source, revision: picker.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await picker.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'permissions', selectedIds: ['custom'] }, context)).toEqual({ kind: 'completed' })
    expect(mounted.notices).toContain('custom is the derived state — pick a preset')
    await picker.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'permissions', selectedIds: ['danger-full-access'] }, context)
    const confirmation = mounted.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.permission.confirm')!
    const focus = confirmation.focusRevision
    await picker.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'permissions', selectedIds: ['danger-full-access'] }, context)
    expect(mounted.ctx.mayflyOverlays.list().find(entry => entry.id === confirmation.id)!.focusRevision).toBeGreaterThan(focus)
  })

})
