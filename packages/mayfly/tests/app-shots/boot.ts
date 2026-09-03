/**
 * Real-service whole-app boot for the app-level SVG shots. Unlike
 * `tests/e2e-boot.ts` (probe services over a Loader fixture), this boots the
 * REAL native dsh session services — `SessionStore`, `SessionProjectionRegistry`,
 * and the `dsh-commands` runtime — and mounts the genuine conversation,
 * transcript, status, pane, and interaction sub-plugins over a
 * `VtTerminal`, so a captured viewport is the real product surface, not a
 * demo node. Non-visual host services (`tools`, `jobs`, `permissionPresets`,
 * `sessionPersistence`, `sessionQuery`, `agents`, `sessionController`) stay
 * structural test doubles with fixed data; `status-git`, the banner, and the
 * updater are never mounted (nondeterministic sources). Every wall-clock read
 * that reaches the frame is pinned: `meta.createdAt` is explicit, event times
 * go through {@link appendAt}'s scoped `Date.now` stub, the pane clock uses
 * `setPaneAgentsClock`, and the spec stubs `process.cwd` to
 * {@link SHOT_CWD}.
 *
 * @module @ephemeral-ai/mayfly/tests/app-shots/boot
 */

import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type {
  Session,
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SessionHeader,
  SurfaceEventType,
  SurfaceIntent,
} from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import * as uiProviderPlugin from '../../../ui/src/provider.ts'
import * as appPlugin from '../../src/app/index.ts'
import {
  MayflyComponentsService,
  MayflyKeymapService,
  MayflyScreenService,
  MayflyTerminalInfoService,
} from '../../src/core/index.ts'
import { mountMayflySurfaceRenderer } from '../../src/core/surface-renderer.ts'
import { startMayflyTerminal } from '../../src/core/terminal.ts'
import * as themeDarkPlugin from '../../src/core/theme-dark.ts'
import * as conversationPlugin from '../../src/conversation/index.ts'
import * as commandsPlugin from '../../src/interaction/commands-plugin.ts'
import { PromptEditorController } from '../../src/interaction/editor-instance.ts'
import { EditorPanelController } from '../../src/interaction/editor-panel-controller.ts'
import { PromptSubmitPipeline } from '../../src/interaction/prompt-submit-pipeline.ts'
import * as inputPlugin from '../../src/interaction/input-plugin.ts'
import * as keysPlugin from '../../src/interaction/keys.ts'
import * as modeStatusPlugin from '../../src/interaction/mode-status.ts'
import type { PermissionPresetsService } from '../../src/interaction/permission-panel.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { SkillsCatalogService } from '../../src/interaction/skills-catalog.ts'
import { DEFAULT_SETTINGS as DEFAULT_MAYFLY_SETTINGS } from '../../src/interaction/settings.ts'
import * as transcriptPlugin from '../../src/transcript/index.ts'
import * as paneAgentsPlugin from '../../src/transcript/pane-agents.ts'
import { setPaneAgentsClock } from '../../src/transcript/pane-agents.ts'
import * as statusBasicPlugin from '../../src/transcript/status-basic-model.ts'
import * as statusContextPlugin from '../../src/transcript/status-context.ts'
import * as statusCwdPlugin from '../../src/transcript/status-cwd.ts'
import * as statusJobsPlugin from '../../src/transcript/status-jobs.ts'
import * as statusTitlePlugin from '../../src/transcript/status-title.ts'
import { pinTestTerminalCapabilities } from '../core/fake-terminal.ts'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'
import type { VtTerminal } from '../vt-terminal.ts'

registerTempDirCleanup()

/** The fixed working directory every shot session carries (stubs `process.cwd`). */
export const SHOT_CWD = '/home/mayfly/workspace'

/** Fixed epoch the scripted timeline starts at (2026-06-19T06:00:00Z). */
export const SHOT_EPOCH = 1_781_848_800_000

/** The main session id every scene boots into. */
export const SHOT_MAIN_ID = 'shot-main'

/** The `dsh-base` permission preset table, mirrored verbatim for determinism. */
const PRESET_TABLE: Record<string, { sandbox: string, approval: string, name: string, description: string }> = {
  'workspace-write': {
    sandbox: 'workspace-write',
    approval: 'ask',
    name: 'workspace-write',
    description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.',
  },
  'danger-full-access': {
    sandbox: 'danger-full-access',
    approval: 'never',
    name: 'danger-full-access',
    description: 'Full file access without approval prompts.',
  },
}

/**
 * Append one event with a scripted timestamp. `Session.append` stamps
 * `Date.now()` internally with no injection seam, so the stub is scoped to
 * the synchronous append call.
 */
export function appendAt<T extends SessionEventType>(
  session: Session,
  time: number,
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
): SessionEvent<T> {
  const realNow = Date.now
  Date.now = () => time
  try {
    return session.append(type, data, ...opts)
  } finally {
    Date.now = realNow
  }
}

/**
 * Run `run` with a pinned wall clock: `CommandRuntime.execute` logs
 * `command/run`/`command/done` with `Date.now()` stamps (and no injection
 * seam), so command executions that can reach a frame go through here.
 */
export async function withShotTime<T>(time: number, run: () => Promise<T>): Promise<T> {
  const realNow = Date.now
  Date.now = () => time
  try {
    return await run()
  } finally {
    Date.now = realNow
  }
}

/** One fake Agent driving a real store-owned Session. */
function shotAgent(session: Session): Agent {
  return {
    id: session.id,
    session,
    options: { model: 'deepseek-chat' },
    status: 'idle',
    inbox: { pending: [], steering: [] },
    followup() {},
    steer() {},
    cancel() {},
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
}

export interface AppShotTree {
  readonly ctx: Context
  readonly terminal: VtTerminal
  readonly exits: number[]
  /** Swap the headers the fake `sessionPersistence` lists (the `/sessions` scene). */
  setPersistedHeaders(headers: readonly SessionHeader[]): void
  /** Swap the titles the fake `sessionQuery` resolves (id → title). */
  setPersistedTitles(titles: ReadonlyMap<string, string>): void
  /** Resolve once startup has selected the main Agent. */
  currentAgent(): Promise<Agent>
  dispose(): Promise<void>
}

/**
 * Boot the shot tree: real session/projection/command services, the real
 * Mayfly plugin set, and fixed-data doubles for non-visual host services.
 */
export async function bootAppShot(options: { readonly terminal: VtTerminal }): Promise<AppShotTree> {
  pinTestTerminalCapabilities()
  mkdtempTracked('mayfly-app-shot-')
  const { terminal } = options
  const ctx = new Context()
  const exits: number[] = []
  const agents = new Map<string, Agent>()
  let persistedHeaders: readonly SessionHeader[] = []
  let persistedTitles: ReadonlyMap<string, string> = new Map()

  ctx.provide('appExit', (code: number) => { exits.push(code) })
  ctx.provide('mayflyStartup', { task: undefined, resume: undefined } as never)
  ctx.provide('agents', {
    get: (id: unknown) => agents.get(String(id)),
    list: () => [...agents.values()],
  } as never)
  ctx.provide('jobs', {
    list: () => [],
    onJobsChanged: () => () => {},
  } as never)
  // Non-visual host reads stay fixed-data structural doubles.
  ctx.provide('tools', {
    get: () => undefined,
    list: () => [],
    schemas: () => [],
  } as never)
  ctx.provide('permissionPresets', {
    names: Object.keys(PRESET_TABLE),
    current: () => 'workspace-write',
    resolve(name: string) {
      const spec = PRESET_TABLE[name]
      if (spec === undefined) throw new Error(`unknown permission preset: ${name}`)
      return spec
    },
    optionOf(name: string) {
      if (name === 'custom') {
        return { value: 'custom', name: 'Custom', description: 'Current sandbox and approval settings do not match a preset.' }
      }
      const spec = PRESET_TABLE[name]
      if (spec === undefined) throw new Error(`unknown permission preset: ${name}`)
      return { value: name, name: spec.name, description: spec.description }
    },
  } satisfies PermissionPresetsService as never)
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([...persistedHeaders]),
  } as never)
  ctx.provide('sessionQuery', {
    readSession: (id: unknown) => {
      const session = [...agents.values()].find(agent => String(agent.id) === String(id))?.session
      if (session === undefined) return Promise.reject(new Error(`unknown session ${String(id)}`))
      return Promise.resolve({ header: session.header, events: session.snapshotEvents() })
    },
    readTitleSnapshots: (ids: readonly unknown[]) => Promise.resolve(ids.map(id => ({
      status: 'fulfilled' as const,
      sessionId: id,
      value: {
        sessionId: id,
        title: persistedTitles.has(String(id)) ? { title: persistedTitles.get(String(id)) } : undefined,
      },
    }))),
    traceEvent: () => Promise.resolve({
      session: {}, target: undefined, replacementChain: [], replacedEventSeqs: [], sourceEventSeqs: [], derivedEventSeqs: [],
    }),
    readEvent: () => Promise.reject(new Error('readEvent is out of scope for app shots')),
  } as never)

  await ctx.plugin(CommandRuntime)
  // Command ids embed a per-instance random token (`cmd-<token>-<n>`); the
  // `/trace` timeline prints them, so pin the token for byte-stable frames.
  ;(ctx.commands as unknown as { instanceToken: string }).instanceToken = 'shotcmd0'
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)

  // The session controller is the one factory path the app plugin uses; it
  // creates REAL store sessions so projections, facts, and the transcript all
  // fold genuine events.
  ctx.provide('sessionController', {
    create: (input: { cwd?: string }) => {
      const session = ctx.sessions.create(SessionId(SHOT_MAIN_ID), {
        // The fixed parent lineage is invisible outside the `/sessions`
        // picker, where it places the live session under its scripted
        // ancestors.
        meta: { cwd: input.cwd ?? SHOT_CWD, createdAt: SHOT_EPOCH, parentSession: SessionId('shot-topic') },
      })
      const agent = shotAgent(session)
      agents.set(String(agent.id), agent)
      return Promise.resolve({ sessionId: agent.id })
    },
    resolveAgent: (id: unknown) => {
      const agent = agents.get(String(id))
      return Promise.resolve(agent === undefined ? { error: new Error(`unknown session ${String(id)}`) } : { agent })
    },
    fork: () => Promise.reject(new Error('fork is out of scope for app shots')),
  } as never)

  await ctx.plugin(uiProviderPlugin)
  await ctx.plugin(themeDarkPlugin)

  // Core mount, mirrored from tests/e2e-boot.ts (the direct-service tree).
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

  await ctx.plugin(appPlugin, {})
  await ctx.plugin(conversationPlugin)
  await ctx.plugin(transcriptPlugin)
  await ctx.plugin(statusBasicPlugin)
  await ctx.plugin(statusCwdPlugin)
  await ctx.plugin(statusTitlePlugin)
  await ctx.plugin(statusContextPlugin)
  await ctx.plugin(modeStatusPlugin)
  await ctx.plugin(statusJobsPlugin)
  await ctx.plugin(paneAgentsPlugin)

  const runtimeState = new InteractionStateService(ctx, DEFAULT_MAYFLY_SETTINGS)
  ctx.effect(() => () => runtimeState.dispose())
  const promptEditor = new PromptEditorController(ctx)
  ctx.effect(() => () => promptEditor.dispose())
  const editorPanels = new EditorPanelController(ctx)
  ctx.effect(() => () => editorPanels.dispose())
  const promptSubmissions = new PromptSubmitPipeline(ctx)
  ctx.effect(() => () => promptSubmissions.dispose())
  const skillsCatalog = new SkillsCatalogService(ctx)
  ctx.effect(() => () => skillsCatalog.dispose())
  await ctx.plugin(keysPlugin)
  await ctx.plugin(commandsPlugin, {})
  await ctx.plugin(inputPlugin)

  async function currentAgent(): Promise<Agent> {
    for (let turn = 0; turn < 100; turn += 1) {
      const agent = ctx.mayflyCurrentAgent.current()
      if (agent !== null) return agent
      await Promise.resolve()
    }
    throw new Error('app shot: Mayfly app did not select an Agent')
  }

  return {
    ctx,
    terminal,
    exits,
    setPersistedHeaders(headers) { persistedHeaders = headers },
    setPersistedTitles(titles) { persistedTitles = titles },
    currentAgent,
    async dispose() {
      setPaneAgentsClock(undefined)
      await ctx.fiber.dispose()
      terminal.dispose()
    },
  }
}
