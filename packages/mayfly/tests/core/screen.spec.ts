/**
 * `ctx.mayflyScreen` service: registration and disposal on the fiber, and
 * delegation of every `MayflyScreen` method to the terminal runtime.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ui } from '@ephemeral-ai/mayfly-ui'
import type { MayflyNodeSlotCompiler } from '../../src/core/node-slot.ts'
import { untranslated } from '../../src/core/ui-interaction-locale.ts'
import { MayflyScreenService } from '../../src/core/screen.ts'
import type { MayflyTerminalRuntime } from '../../src/core/terminal.ts'
import type { MayflyComponent, MayflyDockOptions, MayflyFocusable, MayflyKeymap, MayflyOverlayHandle } from '../../src/core/types.ts'
import { UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import { SurfaceManager } from '../../src/core/surface-manager.ts'
import { COMPONENTS, DIM_COLORS, PLAIN_COLORS, statusRow, streamItems, streamList } from './node-slot-host.ts'

interface Recorded {
  added: MayflyComponent[]
  bottomAdded: MayflyComponent[]
  dockAdded: { component: MayflyComponent, options: MayflyDockOptions | undefined }[]
  removed: MayflyComponent[]
  focused: (MayflyComponent | null)[]
  overlays: { component: MayflyComponent; options?: unknown }[]
  renders: (boolean | undefined)[]
  suspends: unknown[]
  titles: string[]
  scrolls: { direction: 'up' | 'down', amount: number | undefined }[]
  scrollHandlers: (((data: string) => boolean) | undefined)[]
}

function recordingRuntime(laneRows = 0): MayflyTerminalRuntime & Recorded {
  const handle: MayflyOverlayHandle = {
    hide: () => {},
    setHidden: () => {},
    isHidden: () => false,
    focus: () => {},
    unfocus: () => {},
    isFocused: () => true,
  }
  const recorded: Recorded = { added: [], bottomAdded: [], dockAdded: [], removed: [], focused: [], overlays: [], renders: [], suspends: [], titles: [], scrolls: [], scrollHandlers: [] }
  const runtime = {
    ...recorded,
    columns: 120,
    rows: 24,
    surfaceLaneRows: () => laneRows,
    dockRows: () => 0,
    surfaces: new SurfaceManager(),
    hasCapturingOverlay: () => false,
    addChild(component) {
      recorded.added.push(component)
    },
    addBottomChild(component) {
      recorded.bottomAdded.push(component)
    },
    addDockChild(component, options) {
      recorded.dockAdded.push({ component, options })
    },
    removeChild(component) {
      recorded.removed.push(component)
    },
    setFocus(component) {
      recorded.focused.push(component)
    },
    showOverlay(component, options) {
      recorded.overlays.push(options === undefined ? { component } : { component, options })
      return handle
    },
    requestRender(force) {
      recorded.renders.push(force)
    },
    scrollContent(direction, amount) {
      recorded.scrolls.push({ direction, amount })
      return true
    },
    setContentScrollbarColors() {},
    contentTail: () => undefined,
    watchContentTail: () => () => {},
    setContentScrollHandler(handler) {
      recorded.scrollHandlers.push(handler)
      return () => { recorded.scrollHandlers.push(undefined) }
    },
    async suspend<T>(fn: () => Promise<T>): Promise<T> {
      const value = await fn()
      recorded.suspends.push(value)
      return value
    },
    setTitle(title) {
      recorded.titles.push(title)
    },
    stop: () => Promise.resolve(),
  } satisfies Partial<MayflyTerminalRuntime> & Recorded
  // The screen reads only these members; the rest of a terminal runtime stays out of the fake.
  return runtime as unknown as MayflyTerminalRuntime & Recorded
}

const component: MayflyComponent = {
  render: () => ['row'],
  invalidate: () => {},
}

describe('MayflyScreenService', () => {
  it('keeps the editor replacement alive through prompt lease gaps and restores the prompt', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const screen = ctx.mayflyScreen
    const prompt = { focused: false, render: () => ['prompt'], invalidate: () => {}, handleInput: vi.fn() }
    const panel = { focused: false, render: () => ['panel'], invalidate: vi.fn(), handleInput: vi.fn() }
    const slot = screen.mountDockSlot('editor.prompt', prompt)
    slot.component.focused = true
    expect(screen.capturesInput).toBe(false)
    screen.mountDockSlot('status.footer', { render: () => ['footer'], invalidate() {} }, 'bottom')
    screen.setEditorReplacement(panel)
    expect(screen.capturesInput).toBe(true)
    expect(prompt.focused).toBe(false)
    expect(panel.focused).toBe(true)
    expect(slot.component.render(80)).toEqual(['panel'])
    slot.component.handleInput?.('x')
    expect(panel.handleInput).toHaveBeenCalledWith('x')
    expect(screen.editorViewport).toEqual({ columns: 120, rows: 22 })
    slot.dispose()
    expect(slot.component.render(80)).toEqual(['panel'])
    const restored = screen.mountDockSlot('editor.prompt', prompt)
    screen.setEditorReplacement(null)
    expect(screen.capturesInput).toBe(false)
    expect(restored.component.render(80)).toEqual(['prompt'])
    expect(prompt.focused).toBe(true)
    expect(panel.focused).toBe(false)
    await ctx.fiber.dispose()
  })

  it('subtracts the applied lane rows from the editor slot budget', async () => {
    const runtime = recordingRuntime(3)
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const screen = ctx.mayflyScreen
    screen.mountDockSlot('status.footer', { render: () => ['footer'], invalidate() {} }, 'bottom')
    expect(screen.editorViewport).toEqual({ columns: 120, rows: 19 })
    await ctx.fiber.dispose()
  })

  it('opens the panel of an entered view under the footer, and leaves it blank otherwise', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const screen = ctx.mayflyScreen
    // The editor, the footer, and, last, the views panel: it paints nothing until a view is entered.
    const panel = runtime.bottomAdded.at(-1)!
    expect(panel.render(40)).toEqual([])
    expect(screen.enterViews()).toBe(false)
    screen.leaveViews()
    const lane = runtime.surfaces.views
    const host = { focus: (component: { focused: boolean }) => { component.focused = true }, release: () => { lane.component.focused = false; lane.focusLost() }, requestRender: () => {}, viewport: () => ({ columns: 40, rows: 24 }), colors: new Proxy({}, { get: () => (text: string) => text }) as never }
    lane.bind(host)
    const target = { focused: false, render: () => ['panel row'], invalidate: () => {}, handleInput: () => {} }
    lane.register({ id: 'jobs', summary: { node: { kind: 'text', content: 'jobs' } } }).setPanel(target, target)
    expect(screen.enterViews()).toBe(true)
    expect(panel.render(40)).toEqual([' panel row'])  // inside the footer's one-column gutter
    expect(() => panel.invalidate()).not.toThrow()
    screen.leaveViews()
    expect(panel.render(40)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('registers as ctx.mayflyScreen and unregisters when the fiber disposes', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(MayflyScreenService, recordingRuntime())
    await fiber
    expect(ctx.get('mayflyScreen')).toBeInstanceOf(MayflyScreenService)
    await fiber.dispose()
    expect(ctx.get('mayflyScreen')).toBeUndefined()
  })

  it('delegates mounts, focus, overlays, and renders to the runtime', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const screen = ctx.mayflyScreen

    expect(screen.columns).toBe(120)
    expect(screen.rows).toBe(24)
    expect(runtime.added).toHaveLength(3)
    // The editor slot, the footer slot, and the views panel under the footer.
    expect(runtime.bottomAdded).toHaveLength(3)
    expect(runtime.added.flatMap(child => child.render(20))).toEqual([])

    const content = screen.mountContentSlot('transcript.prelude', component)
    expect(content.disposed).toBe(false)
    expect(content.component.focused).toBe(false)
    expect(runtime.added[0]).toBe(content.component)
    expect(content.component.render(20)).toEqual(['row'])
    expect(() => screen.mountContentSlot('transcript.prelude', component)).toThrow('already mounted')
    content.replace(component)
    content.replace(null)
    expect(content.component.render(20)).toEqual([])
    content.focus()
    content.dispose()
    content.dispose()
    content.replace(component)
    content.focus()
    content.component.invalidate()
    content.component.handleInput?.('ignored')
    expect(content.disposed).toBe(true)
    expect(content.component.focused).toBe(false)
    expect(content.component.render(20)).toEqual([])
    expect(runtime.removed).toEqual([])
    const remounted = screen.mountContentSlot('transcript.prelude', component)
    expect(remounted.component).toBe(content.component)
    remounted.dispose()

    const local = screen.mountContentSlot('local.test', component)
    expect(() => screen.mountContentSlot('local.test', component)).toThrow('already mounted')
    expect(runtime.added).toHaveLength(3)
    expect(runtime.added[2]!.render(20)).toEqual(['row'])
    runtime.added[2]!.invalidate()
    local.dispose()
    expect(runtime.added[2]!.render(20)).toEqual([])
    local.component.focused = true
    expect(local.component.focused).toBe(false)
    local.component.invalidate()
    local.component.handleInput?.('ignored')

    const dock = screen.mountDockSlot('editor.prompt', component)
    expect(runtime.bottomAdded[0]).toBe(dock.component)
    dock.dispose()
    const footer = screen.mountDockSlot('status.footer', component, 'bottom')
    expect(runtime.bottomAdded[1]).toBe(footer.component)
    footer.dispose()
    expect(() => screen.mountDockSlot('dock', component)).toThrow('unknown dock slot')
    expect(() => screen.mountDockSlot('editor.prompt', component, 'bottom')).toThrow('fixed position')
    expect(runtime.removed).toEqual([])

    screen.setFocus(component)
    screen.setFocus(null)
    expect(runtime.focused).toEqual([component, null])

    const handle = screen.showOverlay(component, { width: '50%', anchor: 'top-center' })
    expect(handle.isFocused()).toBe(true)
    expect(runtime.overlays).toEqual([{ component, options: { width: '50%', anchor: 'top-center' } }])

    screen.requestRender()
    screen.requestRender(true)
    expect(runtime.renders.slice(-2)).toEqual([undefined, true])

    expect(screen.scrollContent('up', 3)).toBe(true)
    expect(runtime.scrolls).toEqual([{ direction: 'up', amount: 3 }])

    const handler = (data: string): boolean => data === 'x'
    const unset = screen.setContentScrollHandler(handler)
    expect(runtime.scrollHandlers).toEqual([handler])
    unset()
    expect(runtime.scrollHandlers).toEqual([handler, undefined])

    await expect(screen.suspend(async () => 'ok')).resolves.toBe('ok')
    expect(runtime.suspends).toEqual(['ok'])

    screen.setTitle('fix the login bug')
    expect(runtime.titles).toEqual(['fix the login bug'])
  })

  it('returns identity-stable rows from empty hosts and a quiet local region', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const screen = ctx.mayflyScreen
    const [prelude, , region] = runtime.added as [MayflyComponent, MayflyComponent, MayflyComponent]

    // An unclaimed host and the empty region hand back one shared empty array.
    const empty = prelude.render(20)
    expect(empty).toEqual([])
    expect(prelude.render(20)).toBe(empty)
    expect(region.render(20)).toBe(empty)
    expect(Object.isFrozen(empty)).toBe(true)

    // One stable child: the region returns that child's array by identity.
    const first = ['echo one']
    const one = screen.mountContentSlot('local.one', { render: () => first, invalidate: () => {} })
    expect(region.render(20)).toBe(first)
    expect(region.render(20)).toBe(first)

    // Two stable children: the concatenation is computed once per change.
    const second = ['echo two', 'more']
    const two = screen.mountContentSlot('local.two', { render: () => second, invalidate: () => {} })
    const joined = region.render(20)
    expect(joined).toEqual(['echo one', 'echo two', 'more'])
    expect(region.render(20)).toBe(joined)
    expect(region.render(30)).not.toBe(joined)
    expect(region.render(30)).toEqual(joined)

    // A child handing back a new array recomputes; a removed child shrinks the set.
    let fresh = ['fresh']
    const three = screen.mountContentSlot('local.three', { render: () => fresh, invalidate: () => {} })
    const withFresh = region.render(20)
    expect(withFresh).toEqual(['echo one', 'echo two', 'more', 'fresh'])
    fresh = ['fresher']
    expect(region.render(20)).not.toBe(withFresh)
    expect(region.render(20).at(-1)).toBe('fresher')
    three.dispose()
    two.dispose()
    expect(region.render(20)).toBe(first)
    one.dispose()
    expect(region.render(20)).toBe(empty)
    await ctx.fiber.dispose()
  })

  it('keeps focus on the stable slot while replacing focusable targets', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const first = {
      focused: false,
      render: vi.fn(() => ['first']),
      invalidate: vi.fn(),
      handleInput: vi.fn(),
    }
    const second = {
      focused: false,
      render: vi.fn(() => ['second']),
      invalidate: vi.fn(),
      handleInput: vi.fn(),
    }
    const slot = ctx.mayflyScreen.mountContentSlot('transcript.conversation', first)

    slot.focus()
    expect(runtime.focused).toEqual([slot.component])
    slot.component.focused = true
    expect(slot.component.focused).toBe(true)
    expect(first.focused).toBe(true)
    slot.component.invalidate()
    slot.component.handleInput?.('a')
    expect(first.invalidate).toHaveBeenCalledOnce()
    expect(first.handleInput).toHaveBeenCalledWith('a')

    slot.replace(second)
    expect(first.focused).toBe(false)
    expect(second.focused).toBe(true)
    expect(slot.component.render(20)).toEqual(['second'])
    slot.component.focused = false
    expect(second.focused).toBe(false)
    slot.component.focused = true
    slot.dispose()
    expect(runtime.focused.at(-1)).toBeNull()
    expect(second.focused).toBe(false)

    slot.component.focused = true
    expect(slot.component.focused).toBe(false)
    expect(slot.component.render(20)).toEqual([])
  })
})

/** A compiler the way the surface renderer lends one, over fixture keys and a counted render request. */
function slotCompiler(ctx: Context, extra: Partial<MayflyNodeSlotCompiler> = {}): MayflyNodeSlotCompiler & { readonly requests: () => number } {
  let requests = 0
  const interaction = (ctx.get('mayflyUiInteraction') as UiInteractionService | undefined) ?? new UiInteractionService(ctx)
  return {
    interaction, components: COMPONENTS, colors: PLAIN_COLORS, keymap: {} as MayflyKeymap, mode: 'alternate',
    requestRender: () => { requests += 1 }, requests: () => requests, ...extra,
  }
}

const STREAM = { pagePath: [], controlId: 'stream' }

describe('MayflyScreenService node slots', () => {
  it('leases a node slot in each region, and an unknown or taken host throws and leaves nothing behind', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const screen = ctx.mayflyScreen
    expect(() => screen.mountNodeSlot('dock', { region: 'dock' })).toThrow('unknown dock slot')
    expect(() => screen.mountNodeSlot('status.footer', { region: 'dock' })).toThrow('fixed position')
    expect(() => screen.mountNodeSlot('editor.prompt', { region: 'footer' })).toThrow('fixed position')
    const local = screen.mountNodeSlot('local.node', { region: 'content' })
    expect(() => screen.mountNodeSlot('local.node', { region: 'content' })).toThrow('already mounted')
    const content = screen.mountNodeSlot('transcript.conversation', { region: 'content' })
    const dock = screen.mountNodeSlot('editor.prompt', { region: 'dock' })
    const footer = screen.mountNodeSlot('status.footer', { region: 'footer' })
    expect(() => screen.mountContentSlot('transcript.conversation', component)).toThrow('already mounted')
    for (const slot of [local, content, dock, footer]) slot.set(ui.text(`${slot.id} body`))
    // Without a renderer nothing compiles, and nothing paints.
    const [conversation, region] = [runtime.added[1]!, runtime.added[2]!]
    const [prompt, status] = runtime.bottomAdded as [MayflyComponent, MayflyComponent]
    expect([conversation, region, prompt, status].map(host => host.render(80))).toEqual([[], [], [], []])
    const compiler = slotCompiler(ctx)
    ctx.mayflyScreen.bindNodeSlots(compiler)
    expect(conversation.render(80).join('')).toContain('transcript.conversation body')
    expect(region.render(80).join('')).toContain('local.node body')
    expect(prompt.render(80).join('')).toContain('editor.prompt body')
    expect(status.render(80).join('')).toContain('status.footer body')
    expect(compiler.interaction.list('slot').map(model => model.id)).toEqual(['local.node', 'transcript.conversation', 'editor.prompt', 'status.footer'])
    await ctx.fiber.dispose()
  })

  it('publishes, replaces, and clears its node like a pane, and its dispose drops the interaction state', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const compiler = slotCompiler(ctx)
    ctx.mayflyScreen.bindNodeSlots(compiler)
    const slot = ctx.mayflyScreen.mountNodeSlot('transcript.conversation', { region: 'content' })
    const host = runtime.added[1]!
    // Bound but never published: the lease adopts nothing and paints nothing.
    expect(compiler.interaction.get('slot', slot.id)).toBeUndefined()
    expect(host.render(80)).toEqual([])
    host.invalidate()
    slot.set(ui.text('first'))
    const model = compiler.interaction.get('slot', slot.id)!
    expect(host.render(80).join('')).toContain('first')
    // A caller-owned node is frozen into a snapshot as a pane's set() freezes it.
    slot.set({ kind: 'text', content: 'second' })
    expect(host.render(80).join('')).toContain('second')
    expect(compiler.interaction.get('slot', slot.id)).toBe(model)
    expect(Object.isFrozen(model.node)).toBe(true)
    host.invalidate()
    // A node admission refuses keeps the last admitted one and reports why, as a pane does.
    slot.set(ui.text('not admitted', { tone: 'nope' as never }))
    expect(host.render(80).join('')).toBe('second✗ $.tone is invalid')
    slot.set(null)
    expect(model.node).toBeNull()
    expect(host.render(80)).toEqual([])
    host.invalidate()
    expect(compiler.requests()).toBeGreaterThan(0)

    slot.dispose()
    slot.dispose()
    expect(slot.disposed).toBe(true)
    expect(model.disposed).toBe(true)
    expect(compiler.interaction.get('slot', slot.id)).toBeUndefined()
    slot.set(ui.text('late'))
    slot.focus()
    expect(host.render(80)).toEqual([])
    expect(compiler.interaction.get('slot', slot.id)).toBeUndefined()
    const again = ctx.mayflyScreen.mountNodeSlot('transcript.conversation', { region: 'content' })
    again.set(ui.text('again'))
    expect(compiler.interaction.get('slot', slot.id)).not.toBe(model)
    await ctx.fiber.dispose()
    expect(again.disposed).toBe(true)
  })

  it('keeps its state across a renderer gap and a screen teardown, and an explicit dispose drops it without a renderer', async () => {
    const runtime = recordingRuntime()
    const root = new Context()
    const interaction = new UiInteractionService(root)
    const first = await root.plugin(MayflyScreenService, runtime)
    const slot = root.mayflyScreen.mountNodeSlot('transcript.conversation', { region: 'content' })
    const kept = root.mayflyScreen.mountNodeSlot('local.kept', { region: 'content' })
    const dropped = root.mayflyScreen.mountNodeSlot('local.dropped', { region: 'content' })
    const items = streamItems(40)
    slot.set(streamList(items))
    kept.set(ui.text('kept'))
    dropped.set(ui.text('dropped'))
    const unbind = root.mayflyScreen.bindNodeSlots(slotCompiler(root, { interaction }))
    const host = runtime.added[1]! as MayflyFocusable
    slot.focus()
    expect(runtime.focused).toEqual([host])
    host.focused = true
    expect(host.focused).toBe(true)
    host.handleInput!('\x1b[B')
    host.handleInput!('\x1b[B')
    const model = interaction.get('slot', slot.id)!
    expect(model.choice(STREAM)?.focusedId).toBe('item-2')
    expect(host.render(80).join('\n')).toContain('Item number 2')

    // A renderer gap: the compile state goes, the model stays, and a stale unbind leaves the newer renderer alone.
    unbind()
    unbind()
    expect(host.render(80)).toEqual([])
    host.handleInput!('\x1b[B')
    host.focused = false
    host.focused = true
    const unbindStale = root.mayflyScreen.bindNodeSlots(slotCompiler(root, { interaction }))
    expect(host.render(80).join('')).not.toContain('\x1b[2m')
    root.mayflyScreen.bindNodeSlots(slotCompiler(root, { interaction, colors: DIM_COLORS }))
    unbindStale()
    const rebound = host.render(80)
    expect(rebound.join('\n')).toContain('Item number 2')
    expect(rebound.join('')).toContain('\x1b[2m')
    expect(interaction.get('slot', slot.id)).toBe(model)

    // An explicit dispose during a gap still drops the state it adopted.
    root.mayflyScreen.bindNodeSlots(slotCompiler(root, { interaction }))()
    dropped.dispose()
    expect(interaction.get('slot', 'local.dropped')).toBeUndefined()

    // The screen's teardown revokes the leases and keeps every model for the next lease of its id.
    await first.dispose()
    expect(slot.disposed).toBe(true)
    expect(interaction.get('slot', slot.id)).toBe(model)
    expect(interaction.get('slot', 'local.kept')).toBeDefined()
    const next = recordingRuntime()
    await root.plugin(MayflyScreenService, next)
    const adopted = root.mayflyScreen.mountNodeSlot('transcript.conversation', { region: 'content' })
    adopted.set(streamList(items))
    // A lease that ends before any renderer holds its model drops that model at the next bind.
    root.mayflyScreen.mountNodeSlot('local.kept', { region: 'content' }).dispose()
    expect(interaction.get('slot', 'local.kept')).toBeDefined()
    root.mayflyScreen.bindNodeSlots(slotCompiler(root, { interaction }))
    expect(interaction.get('slot', 'local.kept')).toBeUndefined()
    expect(interaction.get('slot', adopted.id)).toBe(model)
    // The adopted lease is unfocused, so its content flows; the cursor the model kept is the focused window's.
    expect(next.added[1]!.render(80)).toHaveLength(40)
    await root.fiber.dispose()
  })

  it('routes a slot\'s events to the lease that holds its id, so a stale lease neither hears nor publishes', async () => {
    const root = new Context()
    const interaction = new UiInteractionService(root)
    const first = await root.plugin(MayflyScreenService, recordingRuntime())
    const heard: string[] = []
    const stale = root.mayflyScreen.mountNodeSlot('transcript.conversation', { region: 'content', onEvent: (event) => { heard.push(`stale:${event.kind}`) } })
    stale.set(streamList(streamItems(5)))
    root.mayflyScreen.bindNodeSlots(slotCompiler(root, { interaction }))
    const model = interaction.get('slot', stale.id)!
    const send = (): Promise<unknown> => model.endpoint.prepare({ kind: 'dismiss', pagePath: [] }, { surfaceId: model.id, source: [], revision: model.revision, operationId: 'op', signal: new AbortController().signal, report: vi.fn() })
    await send()
    expect(heard).toEqual(['stale:dismiss'])

    // The screen's teardown revokes the lease: the model stays, and its route has no listener until a lease holds the id again.
    await first.dispose()
    await send()
    expect(heard).toEqual(['stale:dismiss'])
    const next = recordingRuntime()
    await root.plugin(MayflyScreenService, next)
    const live = root.mayflyScreen.mountNodeSlot('transcript.conversation', { region: 'content', onEvent: (event) => { heard.push(`live:${event.kind}`) } })
    live.set(streamList(streamItems(5)))
    root.mayflyScreen.bindNodeSlots(slotCompiler(root, { interaction }))
    expect(interaction.get('slot', live.id)).toBe(model)
    expect(model.endpoint).toBe(interaction.get('slot', live.id)!.endpoint)
    await send()
    expect(heard).toEqual(['stale:dismiss', 'live:dismiss'])

    // The stale lease publishes nothing, hears nothing, and ending it again leaves the successor's route and model alone.
    const revision = model.revision
    stale.set(streamList(streamItems(2)))
    stale.dispose()
    await send()
    expect(model.revision).toBe(revision)
    expect(model.disposed).toBe(false)
    expect(heard).toEqual(['stale:dismiss', 'live:dismiss', 'live:dismiss'])
    await root.fiber.dispose()
  })

  it('compiles each region against its own viewport, a pending decision, an animation tick, and a paint epoch', async () => {
    vi.useFakeTimers()
    try {
      const runtime = recordingRuntime()
      const ctx = new Context()
      await ctx.plugin(MayflyScreenService, runtime)
      let revision = 0
      const compiler = slotCompiler(ctx, { contextHints: { revision: () => revision } })
      ctx.mayflyScreen.bindNodeSlots(compiler)
      const content = ctx.mayflyScreen.mountNodeSlot('transcript.conversation', { region: 'content' })
      const dock = ctx.mayflyScreen.mountNodeSlot('editor.prompt', { region: 'dock' })
      const footer = ctx.mayflyScreen.mountNodeSlot('status.footer', { region: 'footer' })
      footer.set(statusRow())
      const items = streamItems(60)
      content.set(streamList(items))
      dock.set(streamList(items))
      const [prompt, status] = runtime.bottomAdded as [MayflyFocusable, MayflyComponent]
      // An unfocused content region flows into the outer scroll (every row); a focused one keeps the terminal's rows as
      // its cursor window. The dock gets the editor viewport, below the footer.
      const footerRows = status.render(120).length
      const contentHost = runtime.added[1]! as MayflyFocusable
      expect(contentHost.render(120)).toHaveLength(60)
      contentHost.focused = true
      // The content region always flows into the outer scroll; focus adds its list hint row.
      expect(contentHost.render(120)).toHaveLength(61)
      contentHost.focused = false
      expect(contentHost.render(120)).toHaveLength(60)
      expect(prompt.render(120)).toHaveLength(ctx.mayflyScreen.editorViewport.rows)
      expect(ctx.mayflyScreen.editorViewport.rows).toBe(24 - footerRows - 1)

      // A confirmed action shows the shared decision in place of the node, then the node again.
      dock.set(ui.actions({ id: 'acts', items: [{ id: 'go', label: 'Go', confirm: 'Run it?' }] }))
      dock.focus()
      prompt.focused = true
      prompt.render(120)
      prompt.handleInput!('\r')
      expect(prompt.render(120).join('\n')).toContain('Run it?')
      compiler.interaction.get('slot', dock.id)!.answerDecision(true)
      expect(prompt.render(120).join('\n')).toContain('Go')

      // The hint revision repaints a slot whose model did not move; an unmoved revision serves the same frame.
      const before = prompt.render(120)
      expect(prompt.render(120)).toBe(before)
      revision += 1
      expect(prompt.render(120)).not.toBe(before)
      dock.set(null)
      prompt.render(120)
      revision += 1
      expect(prompt.render(120)).toEqual([])

      // A loader's tick asks the renderer for a frame through the slot.
      dock.set(ui.loader({ message: 'Working' }))
      prompt.render(120)
      const requests = compiler.requests()
      vi.advanceTimersByTime(200)
      expect(compiler.requests()).toBeGreaterThan(requests)
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('repaints a slot\'s translated strings when the hint revision moves, without a publish', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    let revision = 0
    const compiler = slotCompiler(ctx, {
      contextHints: {
        translate: (key, values) => revision === 0 ? untranslated(key, values) : `[zh] ${untranslated(key, values)}`,
        revision: () => revision,
      },
    })
    ctx.mayflyScreen.bindNodeSlots(compiler)
    const content = ctx.mayflyScreen.mountNodeSlot('transcript.conversation', { region: 'content' })
    content.set(ui.list({ id: 'stream', role: 'browse', filterable: true, selectedIds: [], items: streamItems(5) }))
    const host = runtime.added[1]!
    compiler.interaction.get('slot', content.id)!.updateChoice({ pagePath: [], controlId: 'stream' }, { kind: 'query', query: 'Item number 1' })
    const english = host.render(80).join('\n')
    expect(english).toContain('1 match')
    revision += 1
    const translated = host.render(80).join('\n')
    expect(translated).toContain('[zh] 1 match')
    await ctx.fiber.dispose()
  })
})

describe('MayflyScreenService search line', () => {
  const options = () => ({ prefix: '/' as const, onChange: vi.fn(), onAccept: vi.fn(), onAbandon: vi.fn() })

  it('mounts above the editor, takes the focus, and paints with the colors of the renderer once one is bound', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const heard = options()
    const lease = ctx.mayflyScreen.mountSearchLine(heard)
    const line = runtime.dockAdded[0]!.component as MayflyFocusable
    // Just above the editor, below the panes, and focused for typing.
    expect(runtime.dockAdded[0]!.options).toEqual({ priority: Number.MAX_SAFE_INTEGER - 1 })
    expect(runtime.focused.at(-1)).toBe(line)
    expect(lease.disposed).toBe(false)
    lease.set('2 matches')
    expect(line.render(40)).toHaveLength(2)
    expect(line.render(40)[1]).toContain('2 matches')
    // No renderer yet: the line paints plain and its keys come from the literal escape and enter.
    expect(line.render(40)[0]).toMatch(/^ {2}\/ /u)
    line.handleInput?.('\r')
    expect(heard.onAccept).toHaveBeenCalledOnce()

    // A bound renderer lends its colors and keymap.
    const compiler = slotCompiler(ctx, { colors: DIM_COLORS, keymap: { matches: (data: string) => data === 'Q' } as unknown as MayflyKeymap })
    ctx.mayflyScreen.bindNodeSlots(compiler)
    expect(line.render(40)[1]).toContain('\x1b[2m')
    line.handleInput?.('Q')
    expect(heard.onAbandon).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('freezes and edits again, and a closed line ignores every call', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const heard = options()
    const lease = ctx.mayflyScreen.mountSearchLine(heard)
    const line = runtime.dockAdded[0]!.component as MayflyFocusable
    lease.freeze()
    line.handleInput?.('a')
    expect(heard.onChange).not.toHaveBeenCalled()
    runtime.focused.length = 0
    lease.edit()
    expect(runtime.focused).toEqual([line])
    line.handleInput?.('a')
    expect(heard.onChange).toHaveBeenCalledWith('a')

    lease.dispose()
    expect(lease.disposed).toBe(true)
    expect(runtime.removed).toEqual([line])
    // Closed: nothing changes the status, the editability, or the focus, and closing again removes nothing twice.
    runtime.focused.length = 0
    lease.set('late')
    lease.edit()
    lease.freeze()
    lease.dispose()
    expect(runtime.focused).toEqual([])
    expect(runtime.removed).toEqual([line])
    expect(line.render(40)[1]).not.toContain('late')
    await ctx.fiber.dispose()
  })

  it('hands the focus back to the prompt only when the line held it', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const prompt = { focused: false, render: () => ['prompt'], invalidate: () => {} }
    const promptSlot = ctx.mayflyScreen.mountDockSlot('editor.prompt', prompt)
    const held = ctx.mayflyScreen.mountSearchLine(options())
    const heldLine = runtime.dockAdded[0]!.component as MayflyFocusable
    heldLine.focused = true
    runtime.focused.length = 0
    held.dispose()
    expect(runtime.focused).toEqual([promptSlot.component])

    // A line the focus already left (the conversation took it) does not steal it back.
    const left = ctx.mayflyScreen.mountSearchLine(options())
    runtime.focused.length = 0
    left.dispose()
    expect(runtime.focused).toEqual([])
    await ctx.fiber.dispose()
  })

  it('replaces the open line when another one opens, and the screen\'s teardown closes the open one', async () => {
    const runtime = recordingRuntime()
    const ctx = new Context()
    await ctx.plugin(MayflyScreenService, runtime)
    const first = ctx.mayflyScreen.mountSearchLine(options())
    const second = ctx.mayflyScreen.mountSearchLine(options())
    expect(first.disposed).toBe(true)
    expect(second.disposed).toBe(false)
    expect(runtime.removed).toEqual([runtime.dockAdded[0]!.component])
    // Closing the replaced lease again leaves the newer line open.
    first.dispose()
    expect(second.disposed).toBe(false)
    await ctx.fiber.dispose()
    expect(second.disposed).toBe(true)
    expect(runtime.removed).toEqual([runtime.dockAdded[0]!.component, runtime.dockAdded[1]!.component])
  })
})
