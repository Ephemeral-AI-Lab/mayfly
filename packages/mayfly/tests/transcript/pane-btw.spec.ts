/**
 * `mayfly-pane-btw` plugin: the side-question view and its `/btw` command.
 * Covers the command's error branches (no session, creation failure, missing
 * display services), the seeded side-agent creation, the streaming/finalize
 * reply rendering with the thinking row, dismissal and single-slot
 * replacement, the editor-slot mount, the view's own input (follow-up
 * buffer, close, scroll), and the unloaded-mid-creation guard. The view owns
 * its frame and height budget; core separately owns width truth.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as btw from '../../src/transcript/pane-btw.ts'
import { BtwView } from '../../src/transcript/pane-btw.ts'
import type { MayflyFocusable } from '../../src/core/index.ts'
import {
  assistantEvent,
  fakeMayflyComponents,
  reasoningDelta,
  resetSeq,
  textDelta,
  userEvent,
} from './helpers.ts'
import { bootPanePlugin, PaneFakeCommands, PaneFakeScreen, type PanePluginHarness } from './pane-fakes.ts'
import { COLORS, fakeAgent, type FakeAgent } from './status-fakes.ts'
import { expectLinesFit } from '../core/width-scan.ts'
import { MayflyKeymapService } from '../../src/core/keymap.ts'
import { INTERACTION_KEY_ACTIONS } from '../../src/interaction/keys.ts'

const ANSI_OR_OSC = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/gu

/** A real keymap carrying the shared interaction batch; the pane fake's `matches` throws. */
function realKeymap(): MayflyKeymapService {
  const keymap = new MayflyKeymapService(new Context())
  keymap.register([...INTERACTION_KEY_ACTIONS])
  return keymap
}

/** Records editor-slot mounts; the unmount callback removes the entry. */
class FakeEditorPanels {
  readonly mounted: MayflyFocusable[] = []

  mount(component: MayflyFocusable): () => void {
    this.mounted.push(component)
    let done = false
    return () => {
      if (done) return
      done = true
      const index = this.mounted.indexOf(component)
      if (index !== -1) this.mounted.splice(index, 1)
    }
  }
}

/** One opaque fake side session plus its action handle and captures. */
interface FakeSide {
  projectionSession: { events: SessionEvent[] }
  handle: AgentHandle
  followups: string[]
  disposed: number
  holdDispose: boolean
  failDispose: unknown
  resolveDispose: () => void
}

/** Build one fake side-session action handle. */
function makeSide(seed: SessionEvent[] = []): FakeSide {
  const side = {
    projectionSession: { events: [...seed] },
    followups: [],
    disposed: 0,
    holdDispose: false,
    failDispose: undefined,
    resolveDispose: () => {},
  } as FakeSide
  side.handle = {
    agent: {
      session: side.projectionSession,
      status: 'running',
      followup: (message: { readonly content?: readonly { readonly type: string, readonly text?: string }[] }) => {
        side.followups.push(message.content?.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('\n') ?? '')
      },
    },
    dispose: () => {
      side.disposed += 1
      if (side.failDispose !== undefined) return Promise.reject(side.failDispose)
      if (side.holdDispose) return new Promise<void>(resolve => { side.resolveDispose = resolve })
      return Promise.resolve()
    },
  } as unknown as AgentHandle
  return side
}

/** Fake native agents service: records creations; can fail or hold the next one. */
class FakeAgents {
  readonly creates: true[] = []
  readonly sides: FakeSide[] = []
  failure: unknown
  available = true
  hold = false
  seed: SessionEvent[] = []
  ctx?: Context
  setup?: (ctx: Context) => Promise<void>
  agentOptions?: { readonly reasoningEffort?: string }
  private pendingResolve: (() => void) | undefined

  get pending(): boolean {
    return this.pendingResolve !== undefined
  }

  create(request?: {
    readonly setup?: (ctx: Context) => Promise<void>
    readonly agentOptions?: { readonly reasoningEffort?: string }
  }): Promise<AgentHandle | undefined> {
    if (!this.available) return Promise.resolve(undefined)
    this.setup = request?.setup
    this.agentOptions = request?.agentOptions
    this.creates.push(true)
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const side = makeSide(this.seed)
    this.sides.push(side)
    if (this.hold) {
      return new Promise((resolve) => {
        this.pendingResolve = () => resolve(side.handle)
      })
    }
    return Promise.resolve(side.handle)
  }

  /** Publish one admitted status transition to a side handle. */
  emitStatus(side: FakeSide, status: 'running' | 'idle'): void {
    ;(side.handle.agent as { status: string }).status = status
    this.ctx?.emit('agent/status', { agent: side.handle.agent, status })
  }

  /** Fulfill the held creation. */
  resolvePending(): void {
    const resolve = this.pendingResolve
    this.pendingResolve = undefined
    resolve?.()
  }
}

interface BtwHarness extends PanePluginHarness {
  panels: FakeEditorPanels
}

/**
 * Boot the plugin with the fake agents service and a recording editor-slot
 * host.
 */
async function boot(current: FakeAgent | null, actions: FakeAgents, extras: Record<string, unknown> = {}): Promise<BtwHarness> {
  actions.available = current !== null
  const panels = new FakeEditorPanels()
  const harness = await bootPanePlugin(btw, current, { agents: actions, mayflyEditorPanels: panels, mayflyKeymap: realKeymap(), ...extras })
  actions.ctx = harness.ctx
  return { ...harness, panels }
}

/** Invoke `/btw` with the given raw input. */
function run(commands: PaneFakeCommands, rawInput: string): Promise<unknown> {
  return Promise.resolve(commands.run('btw', rawInput))
}

/** The live view mounted in the editor slot. */
function view(harness: BtwHarness): BtwView {
  const mounted = harness.panels.mounted.at(-1)
  if (mounted === undefined) throw new Error('expected a mounted btw view')
  return mounted as BtwView
}

/** The view's rendered rows, ANSI-stripped. */
function lines(harness: BtwHarness, width = 80): string[] {
  return view(harness).render(width).map(line => line.replace(ANSI_OR_OSC, ''))
}

/** Exchange rows only: no top rule, prompt, guidance, or padding rows. */
function content(harness: BtwHarness, width = 80): string[] {
  return lines(harness, width)
    .filter(line => !line.startsWith('╭'))
    .map(line => line.replace(/^│/u, '').replace(/│$/u, '').trim())
    .filter(line => line !== '' && !line.startsWith('›') && line !== 'Enter follow up · Esc close')
}

describe('mayfly-pane-btw', () => {
  it('registers the /btw command and mounts nothing until asked', async () => {
    const agents = new FakeAgents()
    const { commands, panels, dispose } = await boot(fakeAgent([]), agents)
    expect(btw.name).toBe('mayfly-pane-btw')
    const definition = commands.definitions.get('btw')
    expect(definition?.description).toBe('Ask a side question in a forked session')
    expect(definition?.input).toEqual({ hint: '<question>' })
    expect(panels.mounted).toHaveLength(0)
    await dispose()
    expect(commands.definitions.size).toBe(0)
    expect(panels.mounted).toHaveLength(0)
  })

  it('errors without an active session', async () => {
    const agents = new FakeAgents()
    const { commands, panels, dispose } = await boot(null, agents)
    expect(await run(commands, 'hello')).toEqual({
      kind: 'error',
      text: 'no active session for a side question',
    })
    expect(agents.creates).toHaveLength(0)
    expect(panels.mounted).toHaveLength(0)
    await dispose()
  })

  it('errors when any display service is missing', async () => {
    for (const missing of ['mayflyScreen', 'mayflyComponents', 'mayflyTheme', 'mayflyEditorPanels', 'mayflyKeymap']) {
      const agents = new FakeAgents()
      const ctx = new Context()
      const commands = new PaneFakeCommands()
      ctx.reflect.provide('commands', commands)
      ctx.reflect.provide('mayflyCurrentAgent', { current: () => null, revision: () => 0, subscribe: () => () => {} })
      ctx.reflect.provide('agents', agents)
      ctx.reflect.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
      ctx.reflect.provide('agentPresets', { mount: () => Promise.resolve() })
      ctx.reflect.provide('sessionProjections', { snapshot: () => ({ asOfSeq: 0, values: {} }), onChanged: () => () => {} })
      const display: Record<string, unknown> = {
        mayflyScreen: new PaneFakeScreen(),
        mayflyComponents: fakeMayflyComponents(),
        mayflyTheme: { colors: COLORS },
        mayflyEditorPanels: new FakeEditorPanels(),
        mayflyKeymap: realKeymap(),
        [missing]: undefined,
      }
      for (const [service, value] of Object.entries(display)) ctx.reflect.provide(service, value)
      const fiber = await ctx.plugin(btw)
      expect(await run(commands, 'q?')).toEqual({
        kind: 'error',
        text: 'btw panel is unavailable: the Mayfly screen is not mounted',
      })
      expect(agents.creates).toHaveLength(0)
      await fiber.dispose()
    }
  })

  it('reports creation failures, Error or not', async () => {
    const agents = new FakeAgents()
    const { commands, panels, dispose } = await boot(fakeAgent([]), agents)
    agents.failure = new Error('no adapter')
    expect(await run(commands, 'hello')).toEqual({
      kind: 'error',
      text: 'could not start the side session: no adapter',
    })
    agents.failure = 'plain rejection'
    expect(await run(commands, 'hello')).toEqual({
      kind: 'error',
      text: 'could not start the side session: plain rejection',
    })
    expect(panels.mounted).toHaveLength(0)
    await dispose()
  })

  it('asks through the fork, streams the projection, finalizes, and settles', async () => {
    resetSeq()
    const current = fakeAgent([userEvent('parent work')], { cwd: '/repo' })
    const agents = new FakeAgents()
    const harness = await boot(current, agents)
    const { ctx, commands, screen, dispose } = harness

    expect(await run(commands, 'what is x?')).toEqual({ kind: 'success', text: 'asked the side question' })
    expect(agents.creates).toHaveLength(1)
    const side = agents.sides[0]!
    expect(side.followups).toEqual(['what is x?'])
    // The view owns a complete frame: top rule, `│`-framed rows, prompt, guidance.
    expect(lines(harness)[0]).toMatch(/^╭ BTW ─ ● running ─+╮$/u)
    expect(lines(harness).slice(1).every(row => /^│.*│$/u.test(row))).toBe(true)
    expect(lines(harness).at(-2)).toContain('› ▌ Ask a follow-up…')
    expect(lines(harness).at(-1)).toContain('Enter follow up · Esc close')
    expect(content(harness)).toEqual(['> what is x?', 'thinking...'])

    // Text deltas accumulate; other sessions, reasoning deltas, and
    // non-assistant events are ignored. Once reply bytes exist, the waiting
    // loader yields to the partial answer (kimi parity).
    const session = side.projectionSession
    ctx.emit('session/event', session, textDelta(1, 1, 'x is '))
    ctx.emit('session/event', session, textDelta(1, 1, 'a letter'))
    expect(content(harness)).toEqual(['> what is x?', 'x is a letter'])
    const baseline = screen.renderRequests.length
    ctx.emit('session/event', fakeAgent([]).session as never, textDelta(1, 1, 'stray'))
    ctx.emit('session/event', session, reasoningDelta(1, 1, 'hmm'))
    ctx.emit('session/event', session, userEvent('echo'))
    expect(screen.renderRequests.length).toBe(baseline)

    // The finalize rewrites the accumulation authoritatively, dropping
    // non-text blocks.
    ctx.emit('session/event', session, assistantEvent(1, 1, [
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: 'x is the 24th letter' },
    ]))
    expect(content(harness)).toEqual(['> what is x?', 'x is the 24th letter'])

    // The admitted status transitions drive the top-rule indicator.
    agents.emitStatus(side, 'running')
    expect(content(harness)).toEqual(['> what is x?', 'x is the 24th letter'])
    agents.emitStatus(side, 'idle')
    expect(lines(harness)[0]).toMatch(/^╭ BTW ─ ○ idle ─+╮$/u)

    // Unloading disposes the live side agent and unmounts the view.
    await dispose()
    expect(side.disposed).toBe(1)
    expect(harness.panels.mounted).toHaveLength(0)
  })

  it('does not paint inherited fork replies into a new question', async () => {
    resetSeq()
    const inherited = [
      userEvent('old question'),
      assistantEvent(1, 1, [{ type: 'text', text: 'old answer' }]),
    ]
    const agents = new FakeAgents()
    agents.seed = inherited
    const harness = await boot(fakeAgent(inherited), agents)
    const { ctx, commands, dispose } = harness

    expect(await run(commands, 'new question')).toEqual({ kind: 'success', text: 'asked the side question' })
    expect(content(harness)).toEqual(['> new question', 'thinking...'])

    const session = agents.sides[0]!.projectionSession
    ctx.emit('session/event', session, reasoningDelta(2, 1, 'working'))
    expect(content(harness)).toEqual(['> new question', 'thinking...'])
    ctx.emit('session/event', session, textDelta(2, 1, 'new answer'))
    expect(content(harness)).toEqual(['> new question', 'new answer'])
    await dispose()
  })

  it('dismisses with bare /btw and refuses a second dismiss', async () => {
    resetSeq()
    const agents = new FakeAgents()
    const harness = await boot(fakeAgent([]), agents)
    const { ctx, commands, screen, panels, dispose } = harness
    await run(commands, 'first?')
    const side = agents.sides[0]!
    expect(content(harness)).toEqual(['> first?', 'thinking...'])

    expect(await run(commands, '')).toEqual({ kind: 'success', text: 'dismissed the side question' })
    expect(side.disposed).toBe(1)
    expect(panels.mounted).toHaveLength(0)

    // The dismissed agent's subscriptions are unbound.
    const baseline = screen.renderRequests.length
    ctx.emit('session/event', side.projectionSession as never, textDelta(1, 1, 'late'))
    agents.emitStatus(side, 'idle')
    expect(screen.renderRequests.length).toBe(baseline)

    expect(await run(commands, '   ')).toEqual({ kind: 'error', text: 'no side question is open' })
    await dispose()
  })

  it('replaces the open side question on a new /btw without remounting', async () => {
    resetSeq()
    const current = fakeAgent([userEvent('parent work')])
    const agents = new FakeAgents()
    const harness = await boot(current, agents)
    const { commands, panels, dispose } = harness
    await run(commands, 'first?')
    expect(await run(commands, 'second?')).toEqual({ kind: 'success', text: 'asked the side question' })

    expect(agents.creates).toHaveLength(2)
    expect(agents.sides[0]!.disposed).toBe(1)
    expect(agents.sides[1]!.followups).toEqual(['second?'])
    expect(panels.mounted).toHaveLength(1)
    expect(content(harness)).toEqual(['> second?', 'thinking...'])
    await dispose()
  })

  it('replaces the visible answer while side creation is still pending', async () => {
    resetSeq()
    const agents = new FakeAgents()
    const harness = await boot(fakeAgent([]), agents)
    const { ctx, commands, dispose } = harness
    await run(commands, 'first?')
    const first = agents.sides[0]!
    ctx.emit('session/event', first.projectionSession, textDelta(1, 1, 'old answer'))
    agents.emitStatus(first, 'idle')
    expect(content(harness)).toEqual(['> first?', 'old answer'])

    agents.hold = true
    const pending = run(commands, 'second?')
    await vi.waitFor(() => {
      expect(agents.pending).toBe(true)
    })
    expect(content(harness)).toEqual(['> second?', 'thinking...'])

    agents.resolvePending()
    expect(await pending).toEqual({ kind: 'success', text: 'asked the side question' })
    await dispose()
  })

  it('ignores a follow-up submit while creation is still pending', async () => {
    resetSeq()
    const agents = new FakeAgents()
    agents.hold = true
    const harness = await boot(fakeAgent([]), agents)
    const { commands, dispose } = harness
    const pending = run(commands, 'first?')
    await vi.waitFor(() => {
      expect(agents.pending).toBe(true)
    })
    view(harness).handleInput('x')
    view(harness).handleInput('\r')
    expect(agents.sides[0]!.followups).toHaveLength(0)
    expect(content(harness)).toEqual(['> first?', 'thinking...'])

    agents.resolvePending()
    expect(await pending).toEqual({ kind: 'success', text: 'asked the side question' })
    await dispose()
  })

  it('settles a side question on an explicit idle status event', async () => {
    const agents = new FakeAgents()
    const harness = await boot(fakeAgent([]), agents)
    expect(await run(harness.commands, 'status settle?')).toEqual({ kind: 'success', text: 'asked the side question' })
    agents.emitStatus(agents.sides[0]!, 'idle')
    expect(lines(harness)[0]).toContain('○ idle')
    agents.emitStatus(agents.sides[0]!, 'running')
    expect(lines(harness)[0]).toContain('● running')
    await harness.dispose()
  })

  it('ignores an invalid side-session projection shape', async () => {
    const agents = new FakeAgents()
    let snapshots = 0
    const panels = new FakeEditorPanels()
    const harness = await bootPanePlugin(btw, fakeAgent([]), {
      agents,
      mayflyEditorPanels: panels,
      sessionProjections: {
        snapshot: () => ({ asOfSeq: 0, values: { mayflyConversation: snapshots++ === 0 ? null : {} } }),
        onChanged: () => () => {},
      },
    })
    agents.ctx = harness.ctx
    expect(await run(harness.commands, 'invalid projection?')).toEqual({ kind: 'success', text: 'asked the side question' })
    expect(await run(harness.commands, 'invalid projection again?')).toEqual({ kind: 'success', text: 'asked the side question' })
    await harness.dispose()
  })

  it('forwards the latest preset, optional effort, setup callback, and ignores unrelated events', async () => {
    const agents = new FakeAgents()
    const mountPreset = vi.fn(() => Promise.resolve())
    const current = fakeAgent([{
      type: 'agent-preset/selected',
      seq: 1,
      time: 1,
      data: { agentPreset: 'minimal' },
    } as SessionEvent])
    const harness = await bootPanePlugin(btw, current, {
      agents,
      mayflyEditorPanels: new FakeEditorPanels(),
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'mock', model: 'mock', reasoningEffort: 'high' }),
      },
      agentPresets: { mount: mountPreset },
    })
    agents.ctx = harness.ctx
    expect(await run(harness.commands, 'inspect this')).toEqual({ kind: 'success', text: 'asked the side question' })
    expect(agents.agentOptions).toMatchObject({ reasoningEffort: 'high' })
    await agents.setup?.(harness.ctx)
    expect(mountPreset).toHaveBeenCalledWith(harness.ctx, 'minimal')
    harness.ctx.emit('agent/status', { agent: {} as never, status: 'idle' })
    await harness.dispose()
  })

  it('disposes the fresh handle when the fiber unloaded mid-creation', async () => {
    resetSeq()
    const agents = new FakeAgents()
    agents.hold = true
    const { commands, dispose } = await boot(fakeAgent([]), agents)
    const pending = run(commands, 'late?')
    await vi.waitFor(() => {
      expect(agents.pending).toBe(true)
    })
    await dispose()
    agents.resolvePending()
    expect(await pending).toEqual({ kind: 'error', text: 'the side-question plugin was unloaded' })
    expect(agents.sides[0]!.disposed).toBe(1)
  })

  it('continues the side conversation from the view prompt while idle', async () => {
    resetSeq()
    const agents = new FakeAgents()
    const harness = await boot(fakeAgent([]), agents)
    const { ctx, commands, dispose } = harness
    await run(commands, 'first?')
    const side = agents.sides[0]!
    const session = side.projectionSession
    ctx.emit('session/event', session, textDelta(1, 1, 'first reply'))
    agents.emitStatus(side, 'idle')
    expect(side.followups).toHaveLength(1)

    // Typing into the view prompt and pressing Enter posts a follow-up to
    // the SAME side agent (no second creation); a blank separator divides
    // the turns.
    for (const char of 'and then?') view(harness).handleInput(char)
    expect(lines(harness).at(-2)).toContain('› and then?▌')
    view(harness).handleInput('\r')
    expect(agents.creates).toHaveLength(1)
    expect(side.followups).toEqual(['first?', 'and then?'])
    expect(content(harness)).toEqual(['> first?', 'first reply', '> and then?', 'thinking...'])

    ctx.emit('session/event', session, reasoningDelta(2, 1, 'working'))
    expect(content(harness)).toEqual(['> first?', 'first reply', '> and then?', 'thinking...'])
    ctx.emit('session/event', session, assistantEvent(2, 1, [{ type: 'text', text: 'second reply' }]))
    agents.emitStatus(side, 'idle')
    expect(content(harness)).toEqual(['> first?', 'first reply', '> and then?', 'second reply'])
    await dispose()
  })

  it('keeps the draft and refuses Enter while the side agent is answering', async () => {
    resetSeq()
    const agents = new FakeAgents()
    const harness = await boot(fakeAgent([]), agents)
    const { commands, screen, dispose } = harness
    await run(commands, 'first?')
    const side = agents.sides[0]!

    view(harness).handleInput('n')
    view(harness).handleInput('o')
    const baseline = screen.renderRequests.length
    view(harness).handleInput('\r')
    expect(side.followups).toHaveLength(1)
    expect(screen.renderRequests.length).toBe(baseline)
    expect(lines(harness).at(-2)).toContain('› no▌')

    // Whitespace-only drafts do not submit either.
    view(harness).handleInput('\x03')
    expect(lines(harness).at(-2)).toContain('› ▌ Ask a follow-up…')
    view(harness).handleInput(' ')
    view(harness).handleInput('\r')
    expect(side.followups).toHaveLength(1)
    await dispose()
  })

  it('closes from the view on q with an empty buffer and on Esc', async () => {
    resetSeq()
    const agents = new FakeAgents()
    const harness = await boot(fakeAgent([]), agents)
    const { commands, panels, dispose } = harness
    await run(commands, 'q?')
    const side = agents.sides[0]!

    // q with a draft is literal text; with an empty buffer it closes.
    view(harness).handleInput('x')
    view(harness).handleInput('q')
    expect(panels.mounted).toHaveLength(1)
    view(harness).handleInput('\x7f')
    view(harness).handleInput('\x7f')
    view(harness).handleInput('q')
    // The view unmounts synchronously; the side-agent drain follows.
    expect(panels.mounted).toHaveLength(0)
    await vi.waitFor(() => {
      expect(side.disposed).toBe(1)
    })

    await run(commands, 'again?')
    view(harness).handleInput('\x1b')
    expect(panels.mounted).toHaveLength(0)
    await vi.waitFor(() => {
      expect(agents.sides[1]!.disposed).toBe(1)
    })
    await dispose()
  })

  it('unmounts the view synchronously while side disposal is still pending', async () => {
    resetSeq()
    const agents = new FakeAgents()
    const harness = await boot(fakeAgent([]), agents)
    const { commands, panels, dispose } = harness
    await run(commands, 'slow dispose?')
    const side = agents.sides[0]!
    side.holdDispose = true

    // Esc feedback is immediate: the view unmounts before the side agent's
    // loop-exit drain resolves.
    view(harness).handleInput('\x1b')
    expect(panels.mounted).toHaveLength(0)
    await vi.waitFor(() => {
      expect(side.disposed).toBe(1)
    })
    side.resolveDispose()
    await dispose()
  })

  it('still closes the view when side disposal fails', async () => {
    resetSeq()
    const agents = new FakeAgents()
    const harness = await boot(fakeAgent([]), agents)
    const { commands, panels, dispose } = harness
    await run(commands, 'failing dispose?')
    const side = agents.sides[0]!
    side.failDispose = new Error('dispose boom')

    view(harness).handleInput('\x1b')
    expect(panels.mounted).toHaveLength(0)
    await vi.waitFor(() => {
      expect(side.disposed).toBe(1)
    })
    await dispose()
  })

  it('closes on the kitty CSI-u and legacy escape encodings alike', async () => {
    resetSeq()
    const agents = new FakeAgents()
    const harness = await boot(fakeAgent([]), agents)
    const { commands, panels, dispose } = harness
    await run(commands, 'kitty esc?')
    // Kitty disambiguate mode reports the Escape key as CSI 27 u.
    view(harness).handleInput('\x1b[27u')
    expect(panels.mounted).toHaveLength(0)

    await run(commands, 'legacy esc?')
    view(harness).handleInput('\x1b')
    expect(panels.mounted).toHaveLength(0)
    await dispose()
  })

  it('scrolls long exchanges and clamps the offset across replacement', async () => {
    resetSeq()
    const agents = new FakeAgents()
    const harness = await boot(fakeAgent([]), agents)
    const { ctx, commands, screen, dispose } = harness
    screen.rows = 8
    await run(commands, 'q?')
    const side = agents.sides[0]!
    const session = side.projectionSession
    const long = Array.from({ length: 5 }, (_, index) => `line${String(index + 1)}`).join('\n')
    ctx.emit('session/event', session, assistantEvent(1, 1, [{ type: 'text', text: long }]))

    // Budget: floor(8 / 2) - 2 = 2, raised to the 3-row minimum; the window
    // follows the tail.
    const frame = lines(harness)
    expect(frame).toHaveLength(6)
    expect(content(harness)).toEqual(['line3', 'line4', 'line5'])

    // Scroll up, then growth (an authoritative finalize adding a row) keeps
    // the pinned window on the same rows.
    view(harness).handleInput('\x1b[A')
    expect(content(harness)).toEqual(['line2', 'line3', 'line4'])
    ctx.emit('session/event', session, assistantEvent(1, 1, [{ type: 'text', text: `${long}\nline6` }]))
    expect(content(harness)).toEqual(['line2', 'line3', 'line4'])
    // The kitty arrow encoding scrolls exactly like the legacy byte form.
    view(harness).handleInput('\x1b[1;1A')
    expect(content(harness)).toEqual(['line1', 'line2', 'line3'])
    // At the top edge the offset saturates; Page Down returns to the tail in
    // budget-1 steps. At the bottom edge a further Down is a no-op scroll and
    // requests no render.
    view(harness).handleInput('\x1b[5~')
    expect(content(harness)[0]).toBe('> q?')
    view(harness).handleInput('\x1b[6~')
    view(harness).handleInput('\x1b[6~')
    const baseline = screen.renderRequests.length
    view(harness).handleInput('\x1b[B')
    expect(screen.renderRequests.length).toBe(baseline)
    expect(content(harness).at(-1)).toBe('line6')

    // A replacement question shrinks the exchange: the offset clamps back.
    view(harness).handleInput('\x1b[A')
    expect(await run(commands, 'second?')).toEqual({ kind: 'success', text: 'asked the side question' })
    expect(content(harness)).toEqual(['> second?', 'thinking...'])
    await dispose()
  })

  it('renders nothing below the minimum width and fits every wider row', async () => {
    resetSeq()
    const agents = new FakeAgents()
    const harness = await boot(fakeAgent([]), agents)
    const { commands, dispose } = harness
    await run(commands, 'a considerably longer side question that must wrap cleanly inside the frame')
    expect(view(harness).render(4)).toEqual([])
    for (const width of [5, 10, 20, 47, 80]) {
      expectLinesFit('btw view', view(harness).render(width), width)
      for (const row of lines(harness, width).slice(1)) expect(row).toMatch(/^│.*│$/u)
    }
    await dispose()
  })
})

describe('BtwView', () => {
  function makeView(options: {
    turns?: { question: string, reply: string, thinking: boolean, afterSeq: number }[]
    busy?: boolean
    rows?: number
  } = {}) {
    const screen = new PaneFakeScreen()
    screen.rows = options.rows ?? 24
    const state = { turns: options.turns ?? [] }
    const submitted: string[] = []
    let closed = 0
    const view = new BtwView({
      screen,
      components: fakeMayflyComponents(),
      colors: COLORS,
      keymap: realKeymap(),
      turns: () => state.turns,
      busy: () => options.busy ?? false,
      onSubmit: text => { submitted.push(text) },
      onClose: () => { closed += 1 },
    })
    return { screen, state, view, submitted, closed: () => closed }
  }

  const plain = (view: BtwView, width = 80): string[] => view.render(width).map(line => line.replace(ANSI_OR_OSC, ''))

  it('renders the idle frame with a placeholder and no turns', () => {
    const { view } = makeView()
    const rows = plain(view)
    expect(rows[0]).toMatch(/^╭ BTW ─ ○ idle ─+╮$/u)
    expect(rows.at(-2)).toContain('› ▌ Ask a follow-up…')
    expect(rows.at(-1)).toContain('Enter follow up · Esc close')
    expect(rows.slice(1).every(row => /^│.*│$/u.test(row))).toBe(true)
  })

  it('disposes into an inert component', () => {
    const { screen, view } = makeView({ busy: true })
    view.dispose()
    expect(view.render(80)).toEqual([])
    const baseline = screen.renderRequests.length
    view.handleInput('x')
    view.handleInput('\r')
    view.invalidate()
    expect(screen.renderRequests.length).toBe(baseline)
  })

  it('falls back to the minimum body height on degenerate screen rows', () => {
    for (const rows of [Number.NaN, 0]) {
      const { view } = makeView({ rows })
      // 1 top rule + 3 body rows + prompt + guidance.
      expect(plain(view)).toHaveLength(6)
    }
  })

  it('ignores escape sequences and control characters as input', () => {
    const { screen, view } = makeView()
    const baseline = screen.renderRequests.length
    view.handleInput('\x1b[Z')
    view.handleInput('\x01')
    view.handleInput('\r')
    expect(screen.renderRequests.length).toBe(baseline)
  })

  it('clears a draft on Ctrl+C and submits the trimmed buffer on Enter', () => {
    const { screen, view, submitted } = makeView()
    view.handleInput('a')
    view.handleInput('b')
    view.handleInput('\x03')
    expect(plain(view).at(-2)).toContain('› ▌ Ask a follow-up…')
    // Ctrl+C on an empty buffer requests no render.
    const baseline = screen.renderRequests.length
    view.handleInput('\x03')
    expect(screen.renderRequests.length).toBe(baseline)

    view.handleInput('c')
    view.handleInput('\r')
    expect(submitted).toEqual(['c'])
    expect(plain(view).at(-2)).toContain('› ▌ Ask a follow-up…')
  })
})
