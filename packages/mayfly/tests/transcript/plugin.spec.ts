/** Real Loader composition coverage for the direct transcript services.
 * @module @ephemeral-ai/mayfly/transcript/tests/plugin
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MayflyConversationView } from '../../src/app/conversation-views.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { MayflyStatusService } from '../../../ui/src/provider.ts'
import type { MayflyComponent, MayflyKeyAction, MayflyKeymap, MayflyOverlayHandle, MayflyScreen } from '../../src/core/types.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'
import { ACTION_TOGGLE_COLLAPSE, apply, inject } from '../../src/transcript/index.ts'
import { LiveAssistantStreamService } from '../../src/conversation/live-stream.ts'
import { SessionFactsService, type ChildSessionFacts } from '../../src/transcript/session-facts.ts'
import * as statusBasicModel from '../../src/transcript/status-basic-model.ts'
import { assistantEvent, fakeMayflyComponents, imageBlock, reasoningDelta, resetSeq, stepStart, subagentCallEvent, textDelta, toolCallEvent, toolResultEvent, turnStart, userEvent } from './helpers.ts'
import { fakeAgent, plainColors } from '../helpers.ts'
import { FakeProjectionService } from './pane-fakes.ts'
import { mountFakeScreenSlot } from '../core/fake-screen-slot.ts'
import { setClipboardOsc52Emitter, setClipboardTextWriter } from '../../src/interaction/clipboard-write.ts'
import { MayflyUiImagesService } from '../../src/core/ui-images.ts'
import { initialConversationFacts } from '../../src/conversation/facts.ts'
import { STREAM } from '../../src/components/transcript-view.ts'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

registerTempDirCleanup()

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

const COLORS = plainColors()

class FakeScreen implements MayflyScreen {
  readonly children: MayflyComponent[] = []
  readonly bottomChildren: MayflyComponent[] = []
  readonly renderRequests: Array<boolean | undefined> = []
  readonly columns = 80
  readonly rows = 24
  get editorViewport(): { readonly columns: number, readonly rows: number } { return { columns: this.columns, rows: this.rows } }
  mountContentSlot(id: string, component: MayflyComponent | null) {
    return mountFakeScreenSlot(id, component, shell => this.addChild(shell), target => this.setFocus(target), () => this.requestRender())
  }
  /** The nodes published into node slots, by slot id; `null` once a slot is cleared. */
  readonly nodes = new Map<string, MayflyUiNode | null>()
  /** The options each node slot was mounted with: the events a stream answers arrive through `onEvent`. */
  readonly slotOptions = new Map<string, { readonly onEvent: (event: unknown) => void }>()
  /** The views lane's read-only window the footer reads: no view is registered in this tree. */
  readonly views = { statusEntries: () => [] as never[], isEntered: false, active: undefined as string | undefined, subscribe: () => () => {} }
  /** The row the stream's cursor stands on, read by the controller when it copies or opens a row. */
  cursorRow: string | undefined
  mountNodeSlot(id: string, options: { readonly region: 'content' | 'dock' | 'footer', readonly onEvent?: (event: never) => void }) {
    if (options.onEvent !== undefined) this.slotOptions.set(id, options as unknown as { readonly onEvent: (event: unknown) => void })
    const slot = {
      id,
      disposed: false,
      cursor: () => this.cursorRow,
      set: (node: MayflyUiNode | null) => { this.nodes.set(id, node); this.requestRender() },
      setTurns: () => {},
      track: () => {},
      trackedRow: () => undefined,
      setMarked: () => {},
      focus: () => {},
      release: () => {},
      setKeys: () => {},
      spotlight: () => {},
      focusRow: () => {},
      dispose: () => { slot.disposed = true; this.nodes.delete(id) },
    }
    return slot
  }
  mountDockSlot(id: string, component: MayflyComponent | null) {
    return mountFakeScreenSlot(id, component, shell => this.addBottomChild(shell), target => this.setFocus(target), () => this.requestRender())
  }
  addChild(component: MayflyComponent): () => void {
    this.children.push(component)
    return () => { this.removeChild(component) }
  }
  addBottomChild(component: MayflyComponent): () => void {
    this.bottomChildren.push(component)
    return () => {
      const index = this.bottomChildren.indexOf(component)
      if (index !== -1) this.bottomChildren.splice(index, 1)
    }
  }
  removeChild(component: MayflyComponent): void {
    const index = this.children.indexOf(component)
    if (index !== -1) this.children.splice(index, 1)
  }
  setFocus(_component: MayflyComponent | null): void {}
  showOverlay(): MayflyOverlayHandle { throw new Error('overlays are out of scope') }
  requestRender(force?: boolean): void { this.renderRequests.push(force) }
  follows = 0
  followContent(): void { this.follows += 1 }
  suspend<T>(fn: () => Promise<T>): Promise<T> { return fn() }
  setTitle(): void {}
  scrollContent(): boolean { return false }
  setContentScrollHandler(): () => void { return () => {} }
  watchContentTail(_listener: () => void): () => void { return () => {} }
  contentTail(): undefined { return undefined }
  scrollContentTo(): void {}
  contentMarked(): boolean { return false }
  onContentTurns(_listener: () => void): () => void { return () => {} }
  setContentScrollbarColors(): void {}
}

class FakeKeymap implements MayflyKeymap {
  readonly actions: MayflyKeyAction[] = []
  readonly unregistered: MayflyKeyAction[][] = []
  register(actions: MayflyKeyAction[]): () => void {
    this.actions.push(...actions)
    return () => {
      this.unregistered.push(actions)
      for (const action of actions) {
        const index = this.actions.indexOf(action)
        if (index !== -1) this.actions.splice(index, 1)
      }
    }
  }
  matches(): boolean { return false }
  dispatch(): boolean { return false }
  getKeys(): string[] { return [] }
  list(): readonly MayflyKeyAction[] { return this.actions }
}

interface FakeAgent {
  id: string
  status: 'idle' | 'running'
  options: { model: string, provider: string }
  session: Session & { events: SessionEvent[] }
}

const fakeParent = (events: SessionEvent[]): FakeAgent =>
  fakeAgent('parent-1', { events, model: 'deepseek-chat', provider: 'deepseek' }) as unknown as FakeAgent

interface Harness {
  readonly ctx: Context
  readonly screen: FakeScreen
  readonly keymap: FakeKeymap
  readonly select: (agent: FakeAgent | null) => void
  readonly selectAuxiliary: (agent: FakeAgent, historyFloorSeq: number) => void
  readonly showReadonlyChild: (agent: FakeAgent) => void
  readonly setMayflySettings: (value: unknown) => void
  readonly projections: FakeProjectionService
  /** The feedback the transcript reports on its notification owner, in order. */
  readonly reports: Array<{ readonly id: string, readonly feedback: { readonly message: string, readonly severity?: string, readonly detail?: string } }>
}

function fixtureApply(ctx: Context): void {
  ctx.mayflyStatus.register({
    id: 'fixture.status', priority: 30,
  }, { kind: 'text', content: 'fixture-entry', tone: 'muted' })
}

async function bootTranscript(
  initial: FakeAgent | null = null,
  options: {
    readonly fixture?: boolean
    readonly settings?: Record<string, unknown>
    readonly attachments?: { readImage(ref: unknown): Promise<{ data: Uint8Array }> }
    readonly tools?: { get(name: string, agent?: Agent): unknown }
    /** Provide the real image byte source, so the stream's image rows can be loaded through it. */
    readonly images?: boolean
    /** Boot without the session facts bridge, as a host that publishes none. */
    readonly withoutSessionFacts?: boolean
    /** Provide the interaction notification owner, so the transcript's reports are observable. */
    readonly interaction?: boolean
    /** Replace the children feed of the session facts with one the spec drives: `emit` publishes the facts of the displayed Agent's children. */
    readonly children?: { emit: ((list: readonly ChildSessionFacts[]) => void) | undefined }
  } = {},
): Promise<Harness> {
  const dir = mkdtempTracked('mayfly-transcript-')
  const entries = [
    {
      file: 'transcript.mjs', name: 'mayfly-transcript',
      inject,
      global: '__mayflyTranscriptApply',
    },
    {
      file: 'status.mjs', name: 'mayfly-status-basic-model',
      inject: ['mayflyStatus', 'mayflySessionFacts'], global: '__mayflyStatusBasicApply',
    },
  ]
  if (options.fixture === true) entries.push({
    file: 'fixture.mjs', name: 'mayfly-status-fixture', inject: ['mayflyStatus'], global: '__mayflyStatusFixtureApply',
  })
  for (const entry of entries) {
    writeFileSync(join(dir, entry.file), [
      `export const name = '${entry.name}'`,
      `export const inject = ${JSON.stringify(entry.inject)}`,
      `export const apply = ctx => globalThis.${entry.global}(ctx)`,
      '',
    ].join('\n'))
  }
  writeFileSync(join(dir, 'cordis.yml'), entries.flatMap(entry => [
    `- id: ${entry.name}`,
    `  name: ${pathToFileURL(join(dir, entry.file)).href}`,
  ]).concat('').join('\n'))

  const globals = globalThis as unknown as Record<string, (ctx: Context) => void>
  globals.__mayflyTranscriptApply = apply
  globals.__mayflyStatusBasicApply = statusBasicModel.apply
  globals.__mayflyStatusFixtureApply = fixtureApply

  const ctx = new Context()
  const screen = new FakeScreen()
  const keymap = new FakeKeymap()
  const projections = new FakeProjectionService()
  const reports: Harness['reports'] = []
  void new MayflyStatusService(ctx)
  if (options.images === true) new MayflyUiImagesService(ctx)
  if (options.interaction === true) {
    ctx.reflect.provide('mayflyUiInteraction', {
      createNotificationOwner: () => ({
        report: (id: string, _scope: unknown, feedback: Harness['reports'][number]['feedback']) => { reports.push({ id, feedback }) },
        clear: () => {},
        clearAll: () => {},
        dispose: () => {},
      }),
    })
  }
  let active = initial
  let revision = 0
  // The displayed conversation: the primary, or a BTW with its history floor.
  let primary = initial
  let btw: { readonly agent: FakeAgent, readonly view: MayflyConversationView } | null = null
  const showReadonlyChild = (agent: FakeAgent): void => {
    // A readonly child drives no Agent: current() is null while it is displayed.
    active = null
    btw = {
      agent,
      view: {
        kind: 'subagent', id: `session:${String(agent.id)}`, sessionId: String(agent.id), parentSessionId: 'parent-1',
        label: 'worker', mode: 'one-shot', access: 'readonly', residency: 'displayed',
      },
    }
    revision += 1
    for (const listener of listeners) listener(null, revision)
  }
  const listeners = new Set<(agent: Agent | null, revision: number) => void>()
  const currentAgent = {
    current: () => active as unknown as Agent | null,
    revision: () => revision,
    subscribe(listener: (agent: Agent | null, nextRevision: number) => void) {
      listeners.add(listener)
      listener(active as unknown as Agent | null, revision)
      return () => { listeners.delete(listener) }
    },
  }
  const primaryView = (): MayflyConversationView | null => primary === null ? null : {
    kind: 'primary', id: `session:${String(primary.id)}`, sessionId: String(primary.id), access: 'interactive', residency: btw === null ? 'displayed' : 'retained',
  }
  const conversations = {
    primary: () => primary as unknown as Agent | null,
    displayed: (): MayflyConversationView | null => btw?.view ?? primaryView(),
    snapshot: () => {
      const main = primaryView()
      const views = [...main === null ? [] : [main], ...btw === null ? [] : [btw.view]]
      const displayedId = btw?.view.id ?? main?.id ?? null
      return { primaryId: main?.id ?? null, displayedId, recent: views.map(view => view.id).reverse(), views, revision }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      listener()
      return () => { listeners.delete(listener) }
    },
  }
  const select = (agent: FakeAgent | null): void => {
    active = agent
    primary = agent
    btw = null
    revision += 1
    for (const listener of listeners) listener(agent as unknown as Agent | null, revision)
  }
  const selectAuxiliary = (agent: FakeAgent, historyFloorSeq: number): void => {
    active = agent
    btw = {
      agent,
      view: {
        kind: 'btw',
        id: `session:${String(agent.id)}`,
        sessionId: String(agent.id),
        parentSessionId: 'parent-1',
        label: 'side question',
        historyFloorSeq,
        access: 'interactive',
        residency: 'displayed',
      },
    }
    revision += 1
    for (const listener of listeners) listener(agent as unknown as Agent, revision)
  }
  // The tree-scoped settings source stands in for the `mayfly` patch row:
  // the transcript reads it on every `settings/document-updated` commit.
  const mayflyState = { settings: options.settings?.['mayfly'] }
  const services: Record<string, unknown> = {
    mayflyScreen: screen,
    mayflyTheme: { colors: COLORS },
    mayflyComponents: fakeMayflyComponents(),
    mayflyKeymap: keymap,
    mayflyCurrentAgent: currentAgent,
    mayflyConversations: conversations,
    agents: { get: (id: unknown) => [primary, btw?.agent].find(agent => agent != null && String(agent.id) === String(id)) },
    mayflyInteractionState: { settingsSource: () => mayflyState.settings },
    sessionProjections: projections,
    // The host's one-second tick: the spec never advances it, so no time-dependent row republishes on its own.
    mayflyTick: { subscribe: () => () => {} },
    sessions: { list: () => active === null ? [] : [active.session] },
    mayflyConversationReady: { key: 'mayflyConversation' },
    // Lazy start: the transcript boots after the app marks the launch settled.
    mayflySessionStart: { onBooted: (listener: () => void) => { listener(); return () => {} }, ensure: async () => active as unknown as Agent },
    tools: options.tools ?? { get: () => undefined },
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
  }
  for (const [name, value] of Object.entries(services)) ctx.reflect.provide(name, value)
  ctx.on('session/event', (session, event) => projections.emit(session, event))
  const liveStream = new LiveAssistantStreamService(ctx)
  if (options.withoutSessionFacts !== true) {
    const facts = new SessionFactsService(ctx, liveStream)
    const feed = options.children
    if (feed !== undefined) {
      facts.subscribeChildren = (listener) => {
        feed.emit = listener
        listener([])
        return () => { feed.emit = undefined }
      }
    }
    ctx.effect(() => () => facts.dispose())
  }
  ctx.effect(() => () => liveStream.dispose())

  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return { ctx, screen, keymap, select, selectAuxiliary, showReadonlyChild, setMayflySettings: value => { mayflyState.settings = value }, projections, reports }
}

function stripGutter(lines: string[]): string[] {
  return lines.map(line => line === ' ' ? '' : line.slice(1))
}

/** One node compiled the way a mounted slot paints it at 80 columns. */
function paint(node: MayflyUiNode | null | undefined, screenMode: 'main' | 'alternate' = 'main'): string[] {
  if (node === null || node === undefined) return []
  const compiled = compileMayflyUiNode(node, {
    components: fakeMayflyComponents(),
    colors: COLORS,
    getViewport: () => ({ columns: 80, rows: 1000 }),
    screenMode,
    emit: () => {},
  })
  return (compiled.ok ? compiled.value.component : compiled.errorComponent).render(80)
}

/** The rows of the nodes published into node slots, except the footer, which has its own reader. */
function nodeLines(screen: FakeScreen): string[] {
  return [...screen.nodes].filter(([id]) => id !== 'status.footer').flatMap(([, node]) => paint(node))
}

function contentLines(screen: FakeScreen): string[] {
  return [...stripGutter(screen.children.flatMap(component => component.render(80))), ...nodeLines(screen)]
}

/** The footer: the status row the transcript publishes into the footer node slot, and the bottom children besides it. */
function footerLines(screen: FakeScreen): string[] {
  return [...paint(screen.nodes.get('status.footer'), 'alternate'), ...stripGutter(screen.bottomChildren.flatMap(component => component.render(80)))]
}

describe('mayfly-transcript through the real Loader', () => {
  it('boots against direct Cordis services and renders a pre-existing Agent', async () => {
    resetSeq()
    const agent = fakeParent([userEvent('remember me'), assistantEvent(1, 1, [{ type: 'text', text: 'answer' }])])
    const { ctx, screen } = await bootTranscript(agent)
    expect(ctx.mayflyCurrentAgent.current()).toBe(agent)
    expect(contentLines(screen).join('\n')).toContain('remember me')
    expect(contentLines(screen).join('\n')).toContain('answer')
    ctx.emit('tools/change')
    expect(contentLines(screen).join('\n')).toContain('answer')
    expect(footerLines(screen)[0]).toContain('deepseek-chat')
  })

  it('switches exact Agents and follows native projection updates only for the selected session', async () => {
    resetSeq()
    const { ctx, screen, select } = await bootTranscript(null, {
      settings: { mayfly: { transcriptView: 'verbose' } },
    })
    const agent = fakeParent([userEvent('work'), toolCallEvent(1, 1, 'c1', 'bash', '{"command":"ls"}')])
    select(agent)
    expect(contentLines(screen).join('\n')).toContain('work')

    const baseline = screen.renderRequests.length
    const other = fakeParent([])
    Object.assign(other.session, { id: 'other' })
    ctx.emit('session/event', other.session, textDelta(2, 1, 'foreign'))
    expect(screen.renderRequests.length).toBe(baseline)

    ctx.emit('session/event', agent.session, textDelta(2, 1, 'partial'))
    await vi.waitFor(() => { expect(contentLines(screen).join('\n')).toContain('partial') })
    ctx.emit('session/event', agent.session, assistantEvent(2, 1, [{ type: 'text', text: 'final' }]))
    ctx.emit('session/event', agent.session, toolResultEvent(2, 1, 'c1', 'file.txt'))
    await vi.waitFor(() => { expect(contentLines(screen).join('\n')).toContain('final') })
    select(null)
    expect(contentLines(screen)).toEqual([])
  })

  it('hides inherited BTW history while preserving it when returning to the main session', async () => {
    resetSeq()
    const main = fakeParent([
      userEvent('main history'),
      assistantEvent(1, 1, [{ type: 'text', text: 'main answer' }]),
    ])
    resetSeq()
    const btw = fakeParent([
      userEvent('inherited main history'),
      assistantEvent(1, 1, [{ type: 'text', text: 'inherited main answer' }]),
      userEvent('BTW question'),
      assistantEvent(2, 1, [{ type: 'text', text: 'BTW answer' }]),
    ])
    btw.id = 'btw-child'
    Object.assign(btw.session, { id: 'btw-child' })
    const { ctx, screen, select, selectAuxiliary } = await bootTranscript(main)
    expect(contentLines(screen).join('\n')).toContain('main history')

    selectAuxiliary(btw, 2)
    // A different conversation opens at its newest content.
    expect(screen.follows).toBe(1)
    const side = contentLines(screen).join('\n')
    expect(side).toContain('BTW question')
    expect(side).toContain('BTW answer')
    expect(side).not.toContain('inherited main history')
    expect(side).not.toContain('inherited main answer')

    select(main)
    const restored = contentLines(screen).join('\n')
    expect(restored).toContain('main history')
    expect(restored).toContain('main answer')
    expect(restored).not.toContain('BTW answer')
    await ctx.fiber.dispose()
  })

  it('shows a readonly child in the main pane with its own running header', async () => {
    resetSeq()
    const main = fakeParent([userEvent('main history')])
    resetSeq()
    const worker = fakeParent([turnStart(1), stepStart(1, 1), userEvent('child question'), reasoningDelta(1, 1, 'child thought')])
    worker.id = 'worker-1'
    Object.assign(worker.session, { id: 'worker-1' })
    const { screen, showReadonlyChild, select } = await bootTranscript(main)
    showReadonlyChild(worker)
    const child = contentLines(screen).join('\n')
    expect(child).toContain('child question')
    expect(child).not.toContain('main history')
    // No activity row follows a readonly child, so its transcript keeps the running header.
    expect(child).toMatch(/▾ Deep diving/u)
    select(main)
    expect(contentLines(screen).join('\n')).toContain('main history')
  })

  it('isolates populated sessions whose transcript ids and revisions collide', async () => {
    resetSeq()
    const first = fakeParent([
      userEvent('session A prompt'),
      assistantEvent(1, 1, [{ type: 'text', text: 'session A answer' }]),
    ])
    resetSeq()
    const second = fakeParent([
      userEvent('session B prompt'),
      assistantEvent(1, 1, [{ type: 'text', text: 'session B answer' }]),
    ])
    second.id = 'parent-2'
    Object.assign(second.session, { id: 'parent-2' })
    const { screen, select } = await bootTranscript(first)
    expect(contentLines(screen).join('\n')).toContain('session A answer')

    select(second)
    const switched = contentLines(screen).join('\n')
    expect(switched).toContain('session B prompt')
    expect(switched).toContain('session B answer')
    expect(switched).not.toContain('session A')
  })

  it('uses exact-Agent tool presenters and admits definitions without presenters', async () => {
    resetSeq()
    const presentCall = vi.fn(() => ({ card: 'generic', title: 'Presented call' }))
    const presentResult = vi.fn(() => ({ card: 'generic', title: 'Presented result' }))
    const get = vi.fn((toolName: string) => toolName === 'presented'
      ? { presentCall, presentResult }
      : toolName === 'plain' ? {} : undefined)
    const agent = fakeParent([
      userEvent('tools'),
      toolCallEvent(1, 1, 'presented-call', 'presented', '{}'),
      toolResultEvent(1, 1, 'presented-call', 'done'),
      toolCallEvent(1, 1, 'plain-call', 'plain', '{}'),
    ])
    const { screen } = await bootTranscript(agent, {
      tools: { get },
      settings: { mayfly: { transcriptView: 'verbose' } },
    })
    contentLines(screen)
    expect(get).toHaveBeenCalledWith('presented', agent)
    expect(get).toHaveBeenCalledWith('plain', agent)
    expect(presentCall).toHaveBeenCalled()
    expect(presentResult).toHaveBeenCalled()
  })

  it('keeps live status out of the main transcript: no running header, caption, or live title', async () => {
    const live = async (view: string): Promise<string> => {
      resetSeq()
      // The fake projection re-seeds from every logged event but the last.
      const agent = fakeParent([userEvent('think'), turnStart(1)])
      const harness = await bootTranscript(agent, { settings: { mayfly: { transcriptView: view } } })
      harness.ctx.emit('session/event', agent.session, reasoningDelta(1, 1, 'working'))
      await new Promise(resolve => setTimeout(resolve, 60))
      return contentLines(harness.screen).join('\n')
    }
    // Compact draws the reasoning still in flight as its own line, with no text of it: the activity row names the phase.
    const compact = await live('compact')
    expect(compact).toContain('think')
    expect(compact).toMatch(/● Thinking/u)
    expect(compact).not.toMatch(/working|Deep diving|Analyzing the request/u)
    // Standard draws the reasoning in flight under its pending label, with its latest text under it.
    const standard = await live('standard')
    expect(standard).toMatch(/● Thinking\n\s+working/u)
    expect(standard).not.toMatch(/Deep diving|Running/u)
    // Detailed shows the reasoning in flight under its label too; Verbose grows the same block.
    const detailed = await live('detailed')
    expect(detailed).toContain('think')
    expect(detailed).toMatch(/● Thinking\n\s+working/u)
    expect(detailed).not.toMatch(/Deep diving|Running/u)
    const verbose = await live('verbose')
    expect(verbose).toMatch(/● Thinking\n\s+working/u)
    expect(verbose).not.toMatch(/Deep diving/u)
  })

  it('renders a sibling plugin registration from the same direct mayflyStatus service', async () => {
    const { screen } = await bootTranscript(fakeParent([]), { fixture: true })
    const footer = footerLines(screen).join('\n')
    expect(footer).toContain('deepseek-chat')
    expect(footer).toContain('fixture-entry')
  })

  it('labels attached images on the prompt row without reading their bytes', async () => {
    const readImage = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]) }))
    const agent = fakeParent([userEvent('images', [
      imageBlock({ attachmentId: 'image-ok', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } as never),
      imageBlock({ attachmentId: 'image-missing', mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'shot.png' } as never),
    ])])
    const { screen } = await bootTranscript(agent, { attachments: { readImage } })
    const rendered = contentLines(screen).join('\n')
    expect(rendered).toContain('[image] 1 · 1×1 · 1 KB')
    expect(rendered).toContain('[image] 2 · shot.png · 1×1 · 1 KB')
    expect(readImage).not.toHaveBeenCalled()
  })

  it('applies settings, reprojects locale copy, and unloads every Fiber-owned registration', async () => {
    const { ctx, screen, keymap, setMayflySettings } = await bootTranscript(null, {
      settings: { mayfly: { transcriptView: 'verbose', expandTurns: 2, userFoldLines: 12 } },
    })
    const settingsBaseline = screen.renderRequests.length
    setMayflySettings({ expandTurns: 4, userFoldChars: 700 })
    ctx.emit('settings/document-updated', 'mayfly' as SettingsNamespace, 1)
    expect(screen.renderRequests.length).toBeGreaterThan(settingsBaseline)
    ctx.emit('settings/document-updated', 'mayfly' as SettingsNamespace, 2)
    ctx.emit('settings/document-updated', 'other' as SettingsNamespace, 1)

    const toggle = keymap.actions.find(action => action.id === ACTION_TOGGLE_COLLAPSE)
    const baseline = screen.renderRequests.length
    toggle?.handler!()
    expect(screen.renderRequests.length).toBeGreaterThan(baseline)
    expect(screen.renderRequests.at(-1)).toBe(true)

    const localeFiber = await ctx.plugin({
      name: 'transcript-test-locale',
      apply(localeCtx: Context) {
        const locale = new MayflyLocaleService(localeCtx, { systemLocale: 'en' })
        localeCtx.effect(() => () => locale.dispose())
      },
    })
    await Promise.resolve()
    expect(keymap.actions.find(action => action.id === ACTION_TOGGLE_COLLAPSE)?.description)
      .toBe('Toggle detail expansion (tool output, long messages)')
    ctx.mayflyLocale.setPreference('zh')
    expect(keymap.actions.find(action => action.id === ACTION_TOGGLE_COLLAPSE)?.description)
      .toBe('切换详细内容展开状态（工具输出、长消息）')
    await localeFiber.dispose()

    await ctx.fiber.dispose()
    disposers.length = 0
    expect(screen.children).toEqual([])
    expect(screen.bottomChildren).toEqual([])
    expect(keymap.actions).toEqual([])
    expect(keymap.unregistered.flat().map(action => action.id)).toContain(ACTION_TOGGLE_COLLAPSE)
  })
})

describe('mayfly-transcript queued messages, facts, images, and row actions', () => {
  const queuedMessage = (text: string): UserMessage => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const inboxOf = (agent: FakeAgent): { nextStep: UserMessage[], nextTurn: UserMessage[] } =>
    (agent as unknown as { inbox: { nextStep: UserMessage[], nextTurn: UserMessage[] } }).inbox

  it('shows the selected Agent\'s queued messages, and follows only that Agent\'s inbox events', async () => {
    resetSeq()
    const agent = fakeParent([userEvent('work')])
    const other = fakeParent([])
    Object.assign(other.session, { id: 'other-inbox' })
    const { ctx, screen, select } = await bootTranscript(null)
    select(agent)
    inboxOf(agent).nextStep.push(queuedMessage('after this step'))
    inboxOf(agent).nextTurn.push(queuedMessage('after the turn'))
    ctx.emit('agent/inbox/inserted', { agent: agent as unknown as Agent, message: queuedMessage('queued') })
    await vi.waitFor(() => {
      const queued = contentLines(screen).join('\n')
      expect(queued).toContain('after this step')
      expect(queued).toContain('after the turn')
    })

    const baseline = screen.renderRequests.length
    inboxOf(other).nextTurn.push(queuedMessage('elsewhere'))
    ctx.emit('agent/inbox/claimed', { agent: other as unknown as Agent, message: queuedMessage('elsewhere'), turn: 1 })
    expect(screen.renderRequests.length).toBe(baseline)

    inboxOf(agent).nextStep.length = 0
    ctx.emit('agent/inbox/claimed', { agent: agent as unknown as Agent, message: queuedMessage('claimed'), turn: 1 })
    await vi.waitFor(() => {
      const claimed = contentLines(screen).join('\n')
      expect(claimed).not.toContain('after this step')
      expect(claimed).toContain('after the turn')
    })
    inboxOf(agent).nextTurn.length = 0
    ctx.emit('agent/inbox/discarded', { agent: agent as unknown as Agent, message: queuedMessage('discarded') })
    await vi.waitFor(() => { expect(contentLines(screen).join('\n')).not.toContain('after the turn') })
  })

  it('republishes the stream when the displayed conversation\'s compactions or approvals change, and only then', async () => {
    resetSeq()
    const agent = fakeParent([userEvent('work')])
    const { screen, projections } = await bootTranscript(agent)
    const facts = { ...initialConversationFacts(), compactions: [{ id: 'c1', before: 900, after: 300, window: 1000 }] }
    const compacted = screen.renderRequests.length
    projections.emitFacts(agent.session, facts)
    await vi.waitFor(() => { expect(screen.renderRequests.length).toBeGreaterThan(compacted) })

    // A facts value that keeps the same marks and window does not repaint the stream.
    const steady = screen.renderRequests.length
    projections.emitFacts(agent.session, { ...facts, phase: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(screen.renderRequests.length).toBe(steady)

    projections.emitFacts(agent.session, { ...facts, approvals: [{ id: 'a1', callId: 'call-1', outcome: 'allowed-once' }] })
    await vi.waitFor(() => { expect(screen.renderRequests.length).toBeGreaterThan(steady) })
  })

  it('makes a spawn line follow its child: running in background while it works, then settled with its end', async () => {
    resetSeq()
    const agent = fakeParent([
      userEvent('audit it'),
      subagentCallEvent(1, 1, 'spawn-1', 'subagent', 'Audit the facts', 'audit it', { time: 1_700_000_000_100 }),
      toolResultEvent(1, 1, 'spawn-1', 'started subagent child-1', { time: 1_700_000_000_200 }),
    ])
    const children: { emit: ((list: readonly ChildSessionFacts[]) => void) | undefined } = { emit: undefined }
    const { screen } = await bootTranscript(agent, { children })
    const child = (extra: Partial<ChildSessionFacts>): ChildSessionFacts => ({ id: 'child-1', phase: 'running', tokens: 0, inputTokens: 0, outputTokens: 0, toolCount: 0, ...extra })
    expect(contentLines(screen).join('\n')).not.toContain('running in background')
    children.emit!([child({})])
    await vi.waitFor(() => { expect(contentLines(screen).join('\n')).toContain('running in background') })
    // Streamed counters of the running child are the Agents item's, not the stream's: the same state republishes nothing.
    await new Promise(resolve => setTimeout(resolve, 60))
    const before = screen.renderRequests.length
    children.emit!([child({ liveChars: 4_000, toolCount: 2 })])
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(screen.renderRequests.length).toBe(before)
    // A child found by its prompt, with an end, a failure, and the user's stop, each says its own word.
    children.emit!([child({ phase: 'failed', promptText: 'audit it', endedAt: 1_700_000_005_000 })])
    await vi.waitFor(() => { expect(contentLines(screen).join('\n')).toContain('failed') })
    children.emit!([child({ phase: 'failed', stopped: true, endedAt: 1_700_000_005_000 })])
    await vi.waitFor(() => { expect(contentLines(screen).join('\n')).toContain('stopped') })
    children.emit!([child({ phase: 'completed', promptText: 'audit it' }), child({ id: 'child-2', phase: 'running', promptText: 'audit it' })])
    await vi.waitFor(() => { expect(contentLines(screen).join('\n')).not.toContain('running in background') })
  })

  it('keeps the transcript working when the host publishes no session facts', async () => {
    resetSeq()
    const agent = fakeParent([userEvent('still here'), assistantEvent(1, 1, [{ type: 'text', text: 'answered' }])])
    const { ctx, screen, projections } = await bootTranscript(agent, { withoutSessionFacts: true })
    const rendered = contentLines(screen).join('\n')
    expect(rendered).toContain('still here')
    expect(rendered).toContain('answered')
    projections.emitFacts(agent.session, { ...initialConversationFacts(), compactions: [] })
    ctx.emit('tools/change')
    expect(contentLines(screen).join('\n')).toContain('answered')
  })

  it('loads an attached image through the attachment store for a reference the stream holds, and answers missing otherwise', async () => {
    resetSeq()
    const readImage = vi.fn(async (ref: unknown) => {
      if ((ref as { attachmentId: string }).attachmentId === 'image-bad') throw new Error('attachment gone')
      return { data: new Uint8Array([7, 7]) }
    })
    const agent = fakeParent([userEvent('pictures', [
      imageBlock({ attachmentId: 'image-ok', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } as never),
      imageBlock({ attachmentId: 'image-bad', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } as never),
    ])])
    const { ctx } = await bootTranscript(agent, { attachments: { readImage }, images: true })
    const images = ctx.mayflyUiImages
    expect(images.read('image-ok', () => {})).toEqual({ state: 'pending' })
    await vi.waitFor(() => expect(images.read('image-ok', () => {})).toEqual({ state: 'ready', image: { data: new Uint8Array([7, 7]), mediaType: 'image/png' } }))
    expect(readImage).toHaveBeenCalledWith({ attachmentId: 'image-ok', mediaType: 'image/png' })
    // A reference the stream does not hold is never read.
    images.read('image-unknown', () => {})
    await vi.waitFor(() => expect(images.read('image-unknown', () => {})).toEqual({ state: 'missing' }))
    expect(readImage).not.toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'image-unknown' }))
    // A byte read that throws answers missing, not an error.
    images.read('image-bad', () => {})
    await vi.waitFor(() => expect(images.read('image-bad', () => {})).toEqual({ state: 'missing' }))
  })

  it('answers missing for a stream image when the host has no attachment store', async () => {
    resetSeq()
    const agent = fakeParent([userEvent('pictures', [imageBlock({ attachmentId: 'image-x', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } as never)])])
    const { ctx } = await bootTranscript(agent, { images: true })
    const images = ctx.mayflyUiImages
    images.read('image-x', () => {})
    await vi.waitFor(() => expect(images.read('image-x', () => {})).toEqual({ state: 'missing' }))
  })

  it('copies the row under the cursor as text or model JSON and reports the outcome', async () => {
    resetSeq()
    const agent = fakeParent([userEvent('hello'), assistantEvent(1, 1, [{ type: 'text', text: 'an answer' }])])
    const { screen, reports } = await bootTranscript(agent, { interaction: true })
    const writes: string[] = []
    setClipboardTextWriter(async (text) => { writes.push(text) })
    setClipboardOsc52Emitter(() => false)
    try {
      screen.cursorRow = 'assistant:1:1'
      const press = (actionId: string) => screen.slotOptions.get('transcript.conversation')!.onEvent({ kind: 'activate', controlId: STREAM.keys, actionId })
      press(STREAM.copy)
      await vi.waitFor(() => expect(reports.at(-1)?.feedback.message).toBe('Copied 9 characters'))
      expect(writes).toEqual(['an answer'])
      press(STREAM.copyRaw)
      await vi.waitFor(() => expect(reports.at(-1)?.feedback.message).toMatch(/^Copied \d+ characters of JSON$/u))
      expect(writes.at(-1)).toContain('"transcript-assistant"')
      expect(reports.at(-1)?.feedback.severity).toBe('success')
    } finally {
      setClipboardTextWriter(undefined)
      setClipboardOsc52Emitter(undefined)
    }
  })

  it('reports an unverified copy when only the terminal escape delivered it, and a failed copy with its detail', async () => {
    resetSeq()
    const agent = fakeParent([userEvent('hello'), assistantEvent(1, 1, [{ type: 'text', text: 'an answer' }])])
    const { screen, reports } = await bootTranscript(agent, { interaction: true })
    const press = (actionId: string) => screen.slotOptions.get('transcript.conversation')!.onEvent({ kind: 'activate', controlId: STREAM.keys, actionId })
    screen.cursorRow = 'assistant:1:1'
    try {
      setClipboardTextWriter(async () => { throw new Error('no tool') })
      setClipboardOsc52Emitter(() => true)
      press(STREAM.copy)
      await vi.waitFor(() => expect(reports.at(-1)?.feedback.message).toBe('Copied 9 characters (unverified)'))
      press(STREAM.copyRaw)
      await vi.waitFor(() => expect(reports.at(-1)?.feedback.message).toMatch(/\(unverified\)$/u))

      setClipboardOsc52Emitter(() => false)
      press(STREAM.copy)
      await vi.waitFor(() => expect(reports.at(-1)).toMatchObject({ feedback: { message: 'Could not copy', severity: 'error', detail: 'no tool' } }))

      // A writer that rejects with something other than an Error still reports, with its text.
      setClipboardTextWriter(async () => { throw 'pipe closed' })
      press(STREAM.copy)
      await vi.waitFor(() => expect(reports.at(-1)).toMatchObject({ feedback: { message: 'Could not copy', detail: 'pipe closed' } }))
    } finally {
      setClipboardTextWriter(undefined)
      setClipboardOsc52Emitter(undefined)
    }
  })

  it('leaves the reports quiet when the editor opens and closes the row', async () => {
    resetSeq()
    const agent = fakeParent([userEvent('hello'), assistantEvent(1, 1, [{ type: 'text', text: 'an answer' }])])
    const { screen, reports } = await bootTranscript(agent, { interaction: true, settings: { mayfly: {} } })
    screen.cursorRow = 'assistant:1:1'
    vi.stubEnv('VISUAL', '')
    vi.stubEnv('EDITOR', 'true')
    try {
      screen.slotOptions.get('transcript.conversation')!.onEvent({ kind: 'activate', controlId: STREAM.keys, actionId: STREAM.open })
      await vi.waitFor(() => expect(reports).toEqual([]))
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(reports).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('announces the conversation and prompt focus modes as the stream gains and loses focus', async () => {
    resetSeq()
    const agent = fakeParent([userEvent('hello')])
    const { ctx, screen } = await bootTranscript(agent)
    const modes: string[] = []
    ctx.on('mayfly/focus-mode-changed', mode => { modes.push(mode) })
    const options = screen.slotOptions.get('transcript.conversation') as unknown as { readonly onFocusChange: (focused: boolean) => void }
    options.onFocusChange(true)
    options.onFocusChange(false)
    expect(modes).toEqual(['conversation', 'prompt'])
  })

  it('reports a failed open in the editor, and sends nothing when no row is under the cursor', async () => {
    resetSeq()
    const agent = fakeParent([userEvent('hello'), assistantEvent(1, 1, [{ type: 'text', text: 'an answer' }])])
    const { screen, reports } = await bootTranscript(agent, { interaction: true, settings: { mayfly: {} } })
    const press = (actionId: string) => screen.slotOptions.get('transcript.conversation')!.onEvent({ kind: 'activate', controlId: STREAM.keys, actionId })
    vi.stubEnv('VISUAL', '')
    vi.stubEnv('EDITOR', '')
    try {
      press(STREAM.open)
      screen.cursorRow = undefined
      press(STREAM.open)
      expect(reports).toEqual([])
      screen.cursorRow = 'assistant:1:1'
      press(STREAM.open)
      await vi.waitFor(() => expect(reports.at(-1)).toMatchObject({ id: 'open', feedback: { severity: 'error' } }))
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
