/** Shared direct-service whole-tree boot fixture.
 * @module @ephemeral-ai/mayfly/tests/e2e-boot
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as uiProviderPlugin from '../../ui/src/provider.ts'
import type {
  MayflyEditorExtensionRegistry,
  MayflyOverlayRegistry,
  MayflyPaneRegistry,
  MayflyStatusRegistry,
} from '../../ui/src/contracts.ts'
import * as appPlugin from '../src/app/index.ts'
import type { MayflyCurrentAgentService } from '../src/app/current-agent.ts'
import {
  MayflyComponentsService,
  MayflyKeymapService,
  MayflyScreenService,
  MayflyTerminalInfoService,
} from '../src/core/index.ts'
import { mountMayflySurfaceRenderer } from '../src/core/surface-renderer.ts'
import { startMayflyTerminal } from '../src/core/terminal.ts'
import type { MayflyTerminalRuntime } from '../src/core/terminal.ts'
import * as themeDarkPlugin from '../src/core/theme-dark.ts'
import { FakeTerminal } from './core/fake-terminal.ts'
import { mkdtempTracked, registerTempDirCleanup } from './core/temp-dir.ts'

registerTempDirCleanup()

interface CommandDefinitionProbe {
  readonly name: string
  readonly description: string
  readonly handler: () => unknown | Promise<unknown>
}

class CommandServiceProbe extends Service {
  private readonly entries = new Map<string, CommandDefinitionProbe>()
  constructor(ctx: Context) { super(ctx, 'commands') }
  register(definition: CommandDefinitionProbe): () => void {
    if (this.entries.has(definition.name)) throw new Error(`duplicate command ${definition.name}`)
    this.entries.set(definition.name, definition)
    return this.ctx.effect(() => () => { this.entries.delete(definition.name) })
  }
  find(name: string): CommandDefinitionProbe | undefined { return this.entries.get(name) }
  list(): readonly CommandDefinitionProbe[] { return [...this.entries.values()] }
}

class ProjectionServiceProbe extends Service {
  readonly calls: Array<{ readonly session: unknown, readonly keys: readonly string[] }> = []
  constructor(ctx: Context) { super(ctx, 'sessionProjections') }
  snapshot(session: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
    this.calls.push({ session, keys })
    return Object.freeze({})
  }
}

class ToolServiceProbe extends Service {
  readonly scopes: Agent[] = []
  constructor(ctx: Context) { super(ctx, 'tools') }
  schemas(agent: Agent): readonly unknown[] {
    this.scopes.push(agent)
    return []
  }
}

interface DirectContext extends Context {
  readonly commands: CommandServiceProbe
  readonly sessionProjections: ProjectionServiceProbe
  readonly tools: ToolServiceProbe
  readonly mayflyCurrentAgent: MayflyCurrentAgentService
  readonly mayflyPanes: MayflyPaneRegistry
  readonly mayflyStatus: MayflyStatusRegistry
  readonly mayflyOverlays: MayflyOverlayRegistry
  readonly mayflyEditorExtensions: MayflyEditorExtensionRegistry
}

interface FakeSession {
  readonly id: string
  readonly events: unknown[]
  readonly header: { readonly cwd: string }
  readonly surface: { readonly nodes: readonly unknown[] }
  requestHeader(): undefined
}

interface FakeAgent extends Agent {
  readonly session: FakeSession
}

function fakeAgent(id: string): FakeAgent {
  const session: FakeSession = {
    id,
    events: [],
    header: { cwd: process.cwd() },
    surface: { nodes: [] },
    requestHeader: () => undefined,
  }
  return {
    id: session.id,
    session,
    status: 'idle',
    options: {},
    followup() {},
    cancel() {},
  } as unknown as FakeAgent
}

export interface DirectObservations {
  readonly selectedAgents: Agent[]
  readonly selectedSessions: unknown[]
  readonly serviceVisibility: Record<string, boolean>
}

interface DirectHooks {
  readonly uiProviderApply: typeof uiProviderPlugin.apply
  readonly themeApply: typeof themeDarkPlugin.apply
  readonly appApply: typeof appPlugin.apply
  readonly appInject: typeof appPlugin.inject
  coreApply(ctx: Context): Promise<void>
  consumerApply(ctx: Context): void
}

export interface DirectMayflyTree {
  readonly ctx: Context
  readonly terminal: FakeTerminal
  readonly observations: DirectObservations
  readonly commands: CommandServiceProbe
  readonly projections: ProjectionServiceProbe
  readonly tools: ToolServiceProbe
  readonly controller: {
    readonly created: string[]
    readonly forks: Array<{ readonly sessionId: unknown, readonly atSeq?: number }>
  }
  readonly exits: number[]
}

export const disposers: Array<() => Promise<void>> = []

export async function resetDirectMayfly(): Promise<void> {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
}

/** Boot actual Mayfly API/app/theme/core code through a real Loader composition. */
export async function bootDirectMayfly(options: { readonly terminal?: FakeTerminal } = {}): Promise<DirectMayflyTree> {
  const dir = mkdtempTracked('mayfly-direct-e2e-')
  const terminal = options.terminal ?? new FakeTerminal(80, 24)
  const observations: DirectObservations = {
    selectedAgents: [],
    selectedSessions: [],
    serviceVisibility: {},
  }

  const hooks: DirectHooks = {
    uiProviderApply: uiProviderPlugin.apply,
    themeApply: themeDarkPlugin.apply,
    appApply: appPlugin.apply,
    appInject: appPlugin.inject,
    async coreApply(ctx) {
      const runtime = await startMayflyTerminal(terminal, () => Promise.resolve(undefined))
      const keymap = new MayflyKeymapService(ctx)
      ctx.effect(() => runtime.tui.addInputListener(data => (keymap.dispatch(data) ? { consume: true } : undefined)))
      ctx.plugin(MayflyTerminalInfoService, { background: runtime.background, kittyKeyboard: runtime.kittyKeyboard })
      ctx.plugin(MayflyScreenService, runtime)
      ctx.plugin({
        name: 'mayfly-components',
        inject: ['mayflyTheme'],
        apply(componentCtx: Context) {
          componentCtx.plugin(MayflyComponentsService, { theme: componentCtx.mayflyTheme, tui: runtime.tui })
        },
      })
      ctx.plugin({
        name: 'mayfly-surface-renderer',
        inject: ['mayflyPanes', 'mayflyOverlays', 'mayflyComponents', 'mayflyTheme', 'mayflyKeymap'],
        apply(rendererCtx: Context) {
          mountMayflySurfaceRenderer(rendererCtx as Parameters<typeof mountMayflySurfaceRenderer>[0], runtime)
        },
      })
      ctx.effect(() => () => runtime.stop())
    },
    consumerApply(ctx) {
      const direct = ctx as unknown as DirectContext
      for (const service of [
        'commands',
        'sessionProjections',
        'tools',
        'jobs',
        'subagents',
        'sessions',
        'mayflyCurrentAgent',
        'mayflyPanes',
        'mayflyStatus',
        'mayflyOverlays',
        'mayflyEditorExtensions',
      ]) observations.serviceVisibility[service] = ctx.get(service) !== undefined

      direct.mayflyPanes.register({
        id: 'e2e.direct-pane',
        title: 'Direct plugin',
        placement: 'bottom',
        size: { min: 2, preferred: 3, max: 4 },
      }, { kind: 'text', content: 'native dsh + Mayfly seam' })
      direct.mayflyStatus.register({
        id: 'e2e.direct-status',
      }, { kind: 'text', content: 'direct' })
      direct.mayflyEditorExtensions.register({ id: 'e2e.direct-editor' }, { hint: 'Direct extension' })
      direct.commands.register({
        name: 'direct-overlay',
        description: 'Open the direct overlay',
        handler: () => {
          direct.mayflyOverlays.close('e2e.direct-overlay')
          direct.mayflyOverlays.open({
            id: 'e2e.direct-overlay',
            title: 'Direct overlay',
            capturing: true,
          }, { kind: 'text', content: 'opened through the direct Mayfly service' })
          return { kind: 'success' }
        },
      })
      direct.mayflyCurrentAgent.subscribe(agent => {
        if (agent === null) return
        observations.selectedAgents.push(agent)
        observations.selectedSessions.push(agent.session)
        direct.sessionProjections.snapshot(agent.session, ['mayflyConversation'])
        direct.tools.schemas(agent)
      })
    },
  }
  ;(globalThis as unknown as { __mayflyDirectE2E: DirectHooks }).__mayflyDirectE2E = hooks

  const fixture = (file: string, source: string): string => {
    writeFileSync(join(dir, file), source)
    return pathToFileURL(join(dir, file)).href
  }
  const rows = [
    '- id: mayfly-ui-provider',
    `  name: ${fixture('mayfly-ui-provider.mjs', `
export const name = 'mayfly-ui-provider'
export const apply = ctx => globalThis.__mayflyDirectE2E.uiProviderApply(ctx)
`)}`,
    '- id: mayfly-theme-dark',
    `  name: ${fixture('mayfly-theme-dark.mjs', `
export const name = 'mayfly-theme-dark'
export const apply = ctx => globalThis.__mayflyDirectE2E.themeApply(ctx)
`)}`,
    '- id: mayfly-core',
    `  name: ${fixture('mayfly-core.mjs', `
export const name = 'mayfly-core'
export const apply = ctx => globalThis.__mayflyDirectE2E.coreApply(ctx)
`)}`,
    '- id: mayfly-app',
    `  name: ${fixture('mayfly-app.mjs', `
export const name = 'mayfly-app'
export const inject = globalThis.__mayflyDirectE2E.appInject
export const apply = ctx => globalThis.__mayflyDirectE2E.appApply(ctx, {})
`)}`,
    '- id: direct-sibling',
    `  name: ${fixture('direct-sibling.mjs', `
export const name = 'direct-sibling'
export const inject = ['commands', 'sessionProjections', 'tools', 'jobs', 'subagents', 'sessions', 'mayflyCurrentAgent', 'mayflyPanes', 'mayflyStatus', 'mayflyOverlays', 'mayflyEditorExtensions']
export const apply = ctx => globalThis.__mayflyDirectE2E.consumerApply(ctx)
`)}`,
    '',
  ]
  writeFileSync(join(dir, 'cordis.yml'), rows.join('\n'))

  const ctx = new Context()
  const exits: number[] = []
  const agents = new Map<string, FakeAgent>()
  let sequence = 0
  const created: string[] = []
  const forks: Array<{ sessionId: unknown, atSeq?: number }> = []
  const createAgent = (prefix: string): FakeAgent => {
    const agent = fakeAgent(`${prefix}-${String(++sequence)}`)
    agents.set(String(agent.id), agent)
    return agent
  }
  const controller = {
    created,
    forks,
    async create() {
      const agent = createAgent('session')
      created.push(String(agent.id))
      return { sessionId: agent.id }
    },
    async resolveAgent(id: unknown) {
      const agent = agents.get(String(id))
      return agent === undefined ? { error: new Error(`unknown session ${String(id)}`) } : { agent }
    },
    async fork(input: { sessionId: unknown, atSeq?: number }) {
      forks.push(input)
      const agent = createAgent('fork')
      return { sessionId: agent.id }
    },
  }
  ctx.provide('appExit', (code: number) => { exits.push(code) })
  ctx.provide('mayflyStartup', { task: undefined, resume: undefined } as never)
  ctx.provide('agents', { get: (id: unknown) => agents.get(String(id)), list: () => [...agents.values()] } as never)
  ctx.provide('jobs', {
    list: () => [],
    onJobsChanged: () => () => {},
  } as never)
  ctx.provide('subagents', { listDescendants: async () => [] } as never)
  ctx.provide('sessions', { list: () => [...agents.values()].map(agent => agent.session) } as never)
  ctx.provide('sessionController', controller as never)
  const commandFiber = await ctx.plugin(CommandServiceProbe)
  const projectionFiber = await ctx.plugin(ProjectionServiceProbe)
  const toolFiber = await ctx.plugin(ToolServiceProbe)
  const commands = ctx.get('commands') as unknown as CommandServiceProbe
  const projections = ctx.get('sessionProjections') as unknown as ProjectionServiceProbe
  const tools = ctx.get('tools') as unknown as ToolServiceProbe
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()

  disposers.push(async () => {
    await ctx.fiber.dispose()
    await Promise.all([commandFiber.dispose(), projectionFiber.dispose(), toolFiber.dispose()])
  })
  return { ctx, terminal, observations, commands, projections, tools, controller, exits }
}

/** Wait for app startup to select the exact live Agent. */
export async function currentAgent(tree: DirectMayflyTree): Promise<Agent> {
  let agent: Agent | null = null
  for (let turn = 0; turn < 100; turn += 1) {
    agent = (tree.ctx.get('mayflyCurrentAgent') as MayflyCurrentAgentService | undefined)?.current() ?? null
    if (agent !== null) return agent
    await Promise.resolve()
  }
  throw new Error('Mayfly app did not select an Agent')
}

/** Execute the fixture's ordinary native command definition. */
export async function executeDirectOverlay(tree: DirectMayflyTree): Promise<unknown> {
  const command = tree.commands.find('direct-overlay')
  if (command === undefined) throw new Error('direct-overlay command is not registered')
  return command.handler()
}

/** Expose renderer runtime typing to tests without a second renderer contract. */
export type { MayflyTerminalRuntime }
