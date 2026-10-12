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
import { SessionFactsService } from '../../src/transcript/session-facts.ts'
import * as statusBasicModel from '../../src/transcript/status-basic-model.ts'
import { assistantEvent, fakeMayflyComponents, imageBlock, reasoningDelta, resetSeq, stepStart, textDelta, toolCallEvent, toolResultEvent, turnStart, userEvent } from './helpers.ts'
import { fakeAgent, plainColors } from '../helpers.ts'
import { FakeProjectionService } from './pane-fakes.ts'
import { mountFakeScreenSlot } from '../core/fake-screen-slot.ts'

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
  mountNodeSlot(id: string, _options: { readonly region: 'content' | 'dock' | 'footer' }) {
    const slot = {
      id,
      disposed: false,
      set: (node: MayflyUiNode | null) => { this.nodes.set(id, node); this.requestRender() },
      focus: () => {},
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
  contentChanged(): boolean { this.requestRender(); return false }
  follows = 0
  followContent(): void { this.follows += 1 }
  suspend<T>(fn: () => Promise<T>): Promise<T> { return fn() }
  setTitle(): void {}
  scrollContent(): boolean { return false }
  setContentScrollHandler(): () => void { return () => {} }
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
  void new MayflyStatusService(ctx)
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
    sessions: { list: () => active === null ? [] : [active.session] },
    mayflyConversationReady: { key: 'mayflyConversation' },
    tools: options.tools ?? { get: () => undefined },
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
  }
  for (const [name, value] of Object.entries(services)) ctx.reflect.provide(name, value)
  ctx.on('session/event', (session, event) => projections.emit(session, event))
  const liveStream = new LiveAssistantStreamService(ctx)
  const facts = new SessionFactsService(ctx, liveStream)
  ctx.effect(() => () => facts.dispose())
  ctx.effect(() => () => liveStream.dispose())

  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return { ctx, screen, keymap, select, selectAuxiliary, showReadonlyChild, setMayflySettings: value => { mayflyState.settings = value } }
}

function stripGutter(lines: string[]): string[] {
  return lines.map(line => line === ' ' ? '' : line.slice(1))
}

/** The rows of the nodes published into node slots, compiled the way a mounted slot paints them at 80 columns. */
function nodeLines(screen: FakeScreen): string[] {
  return [...screen.nodes.values()].flatMap((node) => {
    if (node === null) return []
    const compiled = compileMayflyUiNode(node, {
      components: fakeMayflyComponents(),
      colors: COLORS,
      getViewport: () => ({ columns: 80, rows: 1000 }),
      screenMode: 'main',
      emit: () => {},
    })
    return (compiled.ok ? compiled.value.component : compiled.errorComponent).render(80)
  })
}

function contentLines(screen: FakeScreen): string[] {
  return [...stripGutter(screen.children.flatMap(component => component.render(80))), ...nodeLines(screen)]
}

function footerLines(screen: FakeScreen): string[] {
  return stripGutter(screen.bottomChildren.flatMap(component => component.render(80)))
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
    expect(contentLines(screen).join('\n')).toContain('partial')
    ctx.emit('session/event', agent.session, assistantEvent(2, 1, [{ type: 'text', text: 'final' }]))
    ctx.emit('session/event', agent.session, toolResultEvent(2, 1, 'c1', 'file.txt'))
    const text = contentLines(screen).join('\n')
    expect(text).toContain('final')
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
      return contentLines(harness.screen).join('\n')
    }
    // Compact and Standard leave a reasoning-only group untitled: the activity row says Thinking.
    for (const view of ['compact', 'standard']) {
      const text = await live(view)
      expect(text).toContain('think')
      expect(text).not.toMatch(/working|Deep diving|Thinking|Analyzing the request/u)
    }
    // Detailed shows the latest line of the reasoning, captionless; Verbose grows the text under a `Thinking` header.
    const detailed = await live('detailed')
    expect(detailed).toContain('think')
    expect(detailed).toMatch(/✻ .*working/u)
    expect(detailed).not.toMatch(/Deep diving|Thinking/u)
    const verbose = await live('verbose')
    expect(verbose).toMatch(/✻ Thinking\n\s+.*working/u)
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
