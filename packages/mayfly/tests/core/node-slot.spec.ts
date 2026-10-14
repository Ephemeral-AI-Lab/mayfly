/**
 * The node slot on its real mounting path: the test host leases a status-shaped row, an editor-shaped surface, and a
 * stream-shaped list from an ordinary Fiber, and the surface renderer compiles them. Covers the key grammar and the hint
 * row, a core reload that keeps the slots' interaction state, stale leases, and staleness under a warm cache.
 */
import { Context } from '@deepseek-ai/cordis'
import { ui, type MayflyUiEvent } from '@ephemeral-ai/mayfly-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as frontend from '../../src/frontend/index.ts'
import { INTERACTION_KEY_ACTIONS } from '../../src/interaction/keys.ts'
import { visibleWidth } from '../../src/core/width.ts'
import { NodeSlotHost, type MayflyNodeSlotCompiler, type MayflyNodeSlotOptions } from '../../src/core/node-slot.ts'
import type { MayflyComponent, MayflyFocusable, MayflyKeymap, MayflyScreenSlot } from '../../src/core/types.ts'
import { UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import { createWorkCounters } from '../../src/core/ui-work-counters.ts'
import type { MayflyUiImageSource } from '../../src/core/ui-images.ts'
import {
  COMPONENTS,
  DIM_COLORS,
  EDITOR_SURFACE,
  PROMPT_SURFACE,
  PLAIN_COLORS,
  nodeSlotCore,
  nodeSlotHost,
  nodeSlotRuntime,
  nodeSlotTheme,
  statusRow,
  streamItems,
  streamList,
  type NodeSlotHostState,
  type NodeSlotRuntime,
} from './node-slot-host.ts'
import { flush } from '../helpers.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const DOWN = '\x1b[B'
const STREAM = { pagePath: [], controlId: 'stream' }
const PROMPT = { pagePath: [], formId: 'prompt' }

/** The three hosts a screen mounted on a runtime: the conversation, the prompt, and the footer. */
function hosts(terminal: NodeSlotRuntime): { readonly content: MayflyComponent, readonly editor: MayflyComponent, readonly footer: MayflyComponent } {
  return { content: terminal.added[1]!, editor: terminal.bottomAdded[0]!, footer: terminal.bottomAdded[1]! }
}

async function boot(images?: MayflyUiImageSource, editor: typeof EDITOR_SURFACE = EDITOR_SURFACE) {
  const terminal = nodeSlotRuntime()
  const root = new Context()
  cleanups.push(() => root.fiber.dispose())
  await root.plugin(frontend)
  const theme = await root.plugin(nodeSlotTheme(PLAIN_COLORS))
  const core = await root.plugin(nodeSlotCore(terminal.runtime, images))
  const state: NodeSlotHostState = { mounts: 0 }
  const host = await root.plugin(nodeSlotHost(state, () => ({ footer: statusRow(), editor, stream: streamList(streamItems(200)) })))
  await flush()
  const keys = (): (() => void) => root.mayflyKeymap.register([...INTERACTION_KEY_ACTIONS])
  return { terminal, root, theme, core, host, state, keys }
}

describe('node slot test host', () => {
  it('mounts the three shapes from an ordinary Fiber and drives them with the key grammar and the hint row', async () => {
    const tree = await boot()
    tree.keys()
    const { content, editor, footer } = hosts(tree.terminal)
    expect(tree.root.mayflyUiInteraction.list('slot').map(model => model.id)).toEqual(['status.footer', 'editor.prompt', 'transcript.conversation'])
    expect(footer.render(100).join('\n')).toContain('entry 11 0')
    expect(editor.render(100)).toEqual(['  Prompt: '])
    // An unfocused content slot is the content of the outer scroll: every item paints and the scroll windows them.
    const flowing = content.render(100)
    expect(flowing).toHaveLength(200)
    expect(flowing[0]).toContain('Item number 0')
    expect(flowing.join('\n')).not.toContain('(1/200)')

    tree.state.stream!.focus()
    expect(tree.terminal.focused()).toBe(content)
    content.handleInput!(DOWN)
    content.handleInput!(DOWN)
    const stream = tree.root.mayflyUiInteraction.get('slot', 'transcript.conversation')!
    expect(stream.choice(STREAM)?.focusedId).toBe('item-2')
    const rows = content.render(100)
    expect(rows[0]).toContain('(3/200)')
    expect(rows.at(-1)).toBe('  ↑/↓ options · Enter open')
    // Slots route no events yet: an accepted row settles without a handler.
    content.handleInput!('\r')
    await flush()
    expect(stream.operationSnapshot().map(operation => operation.phase)).toEqual(['succeeded'])

    tree.state.editor!.focus()
    expect(editor.render(100).at(-1)).toBe('  Enter edit')
    for (const key of ['\r', 'h', 'i']) editor.handleInput!(key)
    expect(editor.render(100)).toEqual(['→\x1b_pi:c\x07 \x1b[1mPrompt: \x1b[22mhi', '  Enter next · Esc done'])
    expect(tree.root.mayflyUiInteraction.get('slot', 'editor.prompt')!.form(PROMPT)?.fields.draft?.value).toBe('hi')

    // A footer publish republishes only the changed entry; the row is the status-shaped one.
    tree.state.footer!.set(statusRow(7))
    expect(footer.render(100).join('\n')).toContain('entry 11 7')
    // The footer has no controls, so focus reaches no control and input goes nowhere.
    tree.state.footer!.focus()
    footer.handleInput!(DOWN)
    expect(footer.render(100).join('\n')).not.toContain('↑/↓')
  })

  it('holds an editor-shaped prompt: it types, walks the recall, and keeps its draft through a core reload', async () => {
    const tree = await boot(undefined, PROMPT_SURFACE)
    tree.keys()
    const before = hosts(tree.terminal).editor
    const draft = (): string | undefined => tree.root.mayflyUiInteraction.get('slot', 'editor.prompt')!.prompt({ pagePath: [], controlId: 'composer' })?.text
    tree.state.editor!.focus()
    expect(tree.terminal.focused()).toBe(before)
    const rows = (component: MayflyComponent): string[] => component.render(60).map(row => row.replaceAll('\x1b_pi:c\x07', ''))
    expect(rows(before)[1]).toMatch(/^│ > \[Image #1 84 KB ×\] /u)
    for (const key of ['h', 'i']) before.handleInput!(key)
    expect(draft()).toBe('hi')
    expect(rows(before)[1]).toContain('hi')
    // Slots route no events yet: the keys that emit one settle quietly, and the draft is what the model holds.
    before.handleInput!('\r')
    await flush()
    expect(draft()).toBe('')
    before.handleInput!('\x1b[A')
    expect(draft()).toBe('also update the footer')
    expect(rows(before)[1]).toContain('↑ queued 1/2')
    await tree.core.dispose()
    const terminal = nodeSlotRuntime()
    await tree.root.plugin(nodeSlotCore(terminal.runtime))
    await flush()
    tree.keys()
    const after = hosts(terminal).editor
    expect(draft()).toBe('also update the footer')
    expect(rows(after)[1]).toContain('also update the footer')
    tree.state.editor!.focus()
    after.handleInput!('\x1b[A')
    expect(rows(after)[1]).toContain('↑ history 2/2')
  })

  it('keeps every slot\'s interaction state through a core reload, and the stale leases write nothing', async () => {
    const tree = await boot()
    tree.keys()
    const before = hosts(tree.terminal)
    tree.state.stream!.focus()
    for (let step = 0; step < 3; step += 1) before.content.handleInput!(DOWN)
    tree.state.editor!.focus()
    for (const key of ['\r', 'o', 'k']) before.editor.handleInput!(key)
    const models = tree.root.mayflyUiInteraction.list('slot')
    const stale = tree.state.stream!

    await tree.core.dispose()
    expect(tree.root.get('mayflyScreen')).toBeUndefined()
    expect(stale.disposed).toBe(true)
    expect(tree.root.mayflyUiInteraction.list('slot')).toEqual(models)

    const terminal = nodeSlotRuntime()
    await tree.root.plugin(nodeSlotCore(terminal.runtime))
    await flush()
    tree.keys()
    expect(tree.state.mounts).toBe(2)
    expect(tree.state.stream).not.toBe(stale)
    expect(tree.root.mayflyUiInteraction.list('slot')).toEqual(models)
    const after = hosts(terminal)
    expect(after.content.render(100)).toHaveLength(200)
    expect(tree.root.mayflyUiInteraction.get('slot', 'transcript.conversation')!.choice(STREAM)?.focusedId).toBe('item-3')
    expect(after.editor.render(100)[0]).toContain('Prompt: ok')
    expect(tree.root.mayflyUiInteraction.get('slot', 'editor.prompt')!.form(PROMPT)?.fields.draft?.value).toBe('ok')

    // A lease from before the reload is fenced: it neither publishes nor focuses nor releases the new slot's state.
    stale.set(streamList(streamItems(3)))
    stale.focus()
    stale.dispose()
    expect(after.content.render(100)).toHaveLength(200)
    tree.state.stream!.focus()
    after.content.handleInput!(DOWN)
    expect(tree.root.mayflyUiInteraction.get('slot', 'transcript.conversation')!.choice(STREAM)?.focusedId).toBe('item-4')

    // The host's own unload is an explicit dispose: the state goes with it.
    await tree.host.dispose()
    expect(tree.root.mayflyUiInteraction.list('slot')).toEqual([])
    expect(after.content.render(100)).toEqual([])
  })

  it('repaints a warm slot for a new theme, a rebound key, a new locale, and a new width', async () => {
    const tree = await boot()
    const { content } = hosts(tree.terminal)
    tree.state.stream!.focus()
    const warm = content.render(100)
    expect(content.render(100)).toBe(warm)
    // The keymap: the hint names no key until the actions are bound, and names them once they are.
    expect(warm.at(-1)).toBe('   options ·  open')
    tree.keys()
    expect(content.render(100).at(-1)).toBe('  ↑/↓ options · Enter open')
    content.handleInput!(DOWN)
    const cursor = content.render(100)
    expect(cursor[0]).toContain('(2/200)')

    // The locale: the same slot, the same model revision, new words.
    tree.root.mayflyLocale.setPreference('zh')
    expect(content.render(100).at(-1)).toBe('  ↑/↓ 选项 · Enter 打开')
    tree.root.mayflyLocale.setPreference(undefined)
    expect(content.render(100).at(-1)).toBe('  ↑/↓ options · Enter open')

    // The width: a narrower paint fits, and the wider one comes back.
    const narrow = content.render(20)
    expect(narrow.every(row => visibleWidth(row) <= 20)).toBe(true)
    expect(narrow).not.toEqual(cursor)
    expect(content.render(100)).toEqual(cursor)

    // The theme: the renderer reloads, the slot recompiles in the new palette, and the cursor stays.
    expect(cursor.join('')).not.toContain('\x1b[2m')
    await tree.theme.dispose()
    expect(content.render(100)).toEqual([])
    await tree.root.plugin(nodeSlotTheme(DIM_COLORS))
    await flush()
    const dimmed = content.render(100)
    expect(dimmed.join('')).toContain('\x1b[2m')
    expect(dimmed[0]).toContain('(2/200)')
  })

  it('hands the host tree\'s image source to a slot, as it does to a pane', async () => {
    const read = vi.fn<MayflyUiImageSource['read']>(() => ({ state: 'missing' }))
    const tree = await boot({ read })
    tree.state.stream!.set(ui.image({ attachmentId: 'att-1', alt: '[Image #1 84 KB]' }))
    const rows = hosts(tree.terminal).content.render(100).join('\n')
    expect(read).toHaveBeenCalledWith('att-1', expect.any(Function))
    expect(rows).toContain('[Image #1 84 KB]')
    // When the bytes arrive the source calls the painter back: the slot invalidates itself and asks for a frame.
    const renders = tree.terminal.renders()
    read.mock.calls.at(-1)![1]()
    expect(tree.terminal.renders()).toBe(renders + 1)
  })
})

const ESCAPE = '\x1b'
const ALT_DOWN = '\x1b[1;3B'
const CTRL_X = '\x18'
const CTRL_Y = '\x19'

/** An extra node slot beside the three the test host leases, in the content region (a local host of the screen). */
function extraSlot(tree: Awaited<ReturnType<typeof boot>>, id: string, options: Omit<MayflyNodeSlotOptions, 'region'> = {}) {
  const lease = tree.root.mayflyScreen.mountNodeSlot(id, { region: 'content', ...options })
  lease.set(streamList(streamItems(30)))
  /** The region the slot paints in; the keys go to the host the slot's focus() put the terminal's focus on. */
  const host = tree.terminal.added[2]!
  return { lease, host, keys: (data: string) => { tree.terminal.focused()!.handleInput!(data) } }
}

describe('node slot lease: focus, keys, and hints', () => {
  it('draws the key hint row unless its owner shows the keys somewhere else', async () => {
    const tree = await boot()
    tree.keys()
    const hinted = extraSlot(tree, 'local.hinted')
    hinted.lease.focus()
    expect(hinted.host.render(100).at(-1)).toBe('  ↑/↓ options · Enter open')
    hinted.lease.dispose()
    const quiet = extraSlot(tree, 'local.quiet', { hints: false })
    quiet.lease.focus()
    const rows = quiet.host.render(100)
    expect(rows.join('\n')).toContain('Item number 29')
    expect(rows.join('\n')).not.toContain('↑/↓')
  })

  it('reports focus gained and lost by any path, and release hands the keys back to the prompt', async () => {
    const changes: boolean[] = []
    let handed = 0
    const tree = await boot()
    tree.keys()
    const { lease } = extraSlot(tree, 'local.focus', { onFocusChange: (focused) => { changes.push(focused) }, onFocus: () => { handed += 1 } })
    lease.focus()
    expect(tree.terminal.focused()).not.toBe(hosts(tree.terminal).editor)
    expect(changes).toEqual([true])
    expect(handed).toBe(1)
    // Releasing moves focus to the prompt's host: the slot loses it.
    lease.release()
    expect(tree.terminal.focused()).toBe(hosts(tree.terminal).editor)
    expect(changes).toEqual([true, false])
    // The prompt took the focus from the slot, so a slot that is told it is unfocused again reports no change.
    lease.release()
    expect(changes).toEqual([true, false])
    // A disposed lease takes no focus and releases nothing.
    lease.dispose()
    lease.focus()
    lease.release()
    expect(handed).toBe(1)
    expect(tree.terminal.focused()).toBe(hosts(tree.terminal).editor)
  })

  it('gives Esc and Alt+Down to its owner while focused, and to the control when nobody leaves', async () => {
    const left: string[] = []
    const tree = await boot()
    tree.keys()
    const leaving = extraSlot(tree, 'local.leaving', { onLeave: () => { left.push('left') } })
    leaving.lease.focus()
    const model = tree.root.mayflyUiInteraction.get('slot', 'local.leaving')!
    leaving.keys(DOWN)
    expect(model.choice(STREAM)?.focusedId).toBe('item-1')
    leaving.keys(ESCAPE)
    leaving.keys(ALT_DOWN)
    expect(left).toEqual(['left', 'left'])
    expect(model.choice(STREAM)?.focusedId).toBe('item-1')
    leaving.lease.dispose()

    // No owner to leave to: the keys fall through to the focused control, which ignores them.
    const staying = extraSlot(tree, 'local.staying')
    staying.lease.focus()
    staying.keys(DOWN)
    staying.keys(ESCAPE)
    expect(tree.root.mayflyUiInteraction.get('slot', 'local.staying')!.choice(STREAM)?.focusedId).toBe('item-1')
    expect(left).toEqual(['left', 'left'])
  })

  it('answers its own keys as activate events of the control `keys`, and a replaced table forgets the old ones', async () => {
    const events: MayflyUiEvent[] = []
    const tree = await boot()
    tree.keys()
    const { lease, keys } = extraSlot(tree, 'local.keys', { keys: { 'ctrl+x': 'cut' }, onEvent: (event) => { events.push(event) } })
    lease.focus()
    keys(CTRL_X)
    expect(events).toEqual([{ kind: 'activate', pagePath: [], controlId: 'keys', actionId: 'cut' }])
    // The key is the owner's alone: the list never sees it.
    expect(tree.root.mayflyUiInteraction.get('slot', 'local.keys')!.choice(STREAM)?.focusedId).not.toBe('item-1')
    lease.setKeys({ 'ctrl+y': 'paste' })
    keys(CTRL_X)
    keys(CTRL_Y)
    expect(events.map(event => event.kind === 'activate' ? event.actionId : event.kind)).toEqual(['cut', 'paste'])
    lease.dispose()
    lease.setKeys({ 'ctrl+x': 'late' })
    expect(events).toHaveLength(2)
  })

  it('takes no input and paints nothing while no renderer holds it', () => {
    const host = bareHost()
    const { lease, component } = host.lease('transcript.conversation', { region: 'content', onLeave: () => { throw new Error('unreachable') } })
    lease.set(streamList(streamItems(3)))
    component.handleInput!(ESCAPE)
    component.invalidate()
    expect(component.render(80)).toEqual([])
    expect(lease.cursor('stream')).toBeUndefined()
    lease.focusRow('stream', 'item-1')
    expect(host.compiler.requests()).toBe(0)
  })
})

describe('node slot lease: spotlight, rows, and cursor', () => {
  it('draws as focused around its cursor while a search steps through it, without taking the keys', async () => {
    const tree = await boot()
    tree.keys()
    const { content } = hosts(tree.terminal)
    const stream = tree.state.stream!
    expect(content.render(100)).toHaveLength(200)
    const renders = tree.terminal.renders()
    stream.spotlight(true)
    expect(tree.terminal.renders()).toBe(renders + 1)
    expect(tree.terminal.focused()).not.toBe(content)
    const windowed = content.render(100)
    expect(windowed.length).toBeLessThan(200)
    expect(windowed[0]).toContain('(1/200)')
    // Spotlighting the way it already is changes nothing and asks for no frame.
    stream.spotlight(true)
    expect(tree.terminal.renders()).toBe(renders + 1)
    stream.spotlight(false)
    expect(content.render(100)).toHaveLength(200)
    stream.dispose()
    stream.spotlight(true)
    expect(content.render(100)).toEqual([])
  })

  it('stands the focus on a row of its list once compiled, so the key that follows acts on that row', async () => {
    const accepted: string[][] = []
    const tree = await boot()
    tree.keys()
    const { lease, keys } = extraSlot(tree, 'local.rows', { onEvent: (event) => { if (event.kind === 'selection-accept') accepted.push([...event.selectedIds]) } })
    lease.focus()
    const renders = tree.terminal.renders()
    lease.focusRow('stream', 'item-3')
    expect(tree.terminal.renders()).toBe(renders + 1)
    tree.terminal.added[2]!.render(100)
    keys('\r')
    await flush()
    expect(accepted).toEqual([['item-3']])
    // A row the list does not show keeps the request pending: the focus stays where it was.
    lease.focusRow('stream', 'item-999')
    tree.terminal.added[2]!.render(100)
    keys('\r')
    await flush()
    expect(accepted).toEqual([['item-3'], ['item-3']])
    lease.focusRow('stream', 'item-5')
    tree.terminal.added[2]!.render(100)
    keys('\r')
    await flush()
    expect(accepted.at(-1)).toEqual(['item-5'])
    lease.dispose()
    const settled = tree.terminal.renders()
    lease.focusRow('stream', 'item-1')
    expect(tree.terminal.renders()).toBe(settled)
  })

  it('reads the cursor of a list back, and nothing for a list the slot does not show', async () => {
    const tree = await boot()
    tree.keys()
    const stream = tree.state.stream!
    expect(stream.cursor('stream')).toBe('item-0')
    expect(stream.cursor('missing')).toBeUndefined()
    stream.focus()
    hosts(tree.terminal).content.handleInput!(DOWN)
    expect(stream.cursor('stream')).toBe('item-1')
    // A slot whose node has no such list, and a lease that ended, have no cursor.
    expect(tree.state.footer!.cursor('stream')).toBeUndefined()
    stream.dispose()
    expect(stream.cursor('stream')).toBeUndefined()
  })
})

describe('node slot lease: turns and the conversation', () => {
  it('reports the newest content turn once per change, and only for content slots', async () => {
    const tree = await boot()
    const screen = tree.root.mayflyScreen
    const heard: number[] = []
    const off = screen.onContentTurns(() => { heard.push(screen.contentTurns()) })
    expect(screen.contentTurns()).toBe(0)
    const stream = tree.state.stream!
    stream.setTurns(5)
    stream.setTurns(5)
    stream.setTurns(5.9)
    expect(heard).toEqual([5])
    stream.setTurns(-3)
    expect(heard).toEqual([5, 0])
    // The newest turn is the largest of the content slots; the dock and the footer do not count.
    const other = extraSlot(tree, 'local.turns').lease
    stream.setTurns(2)
    other.setTurns(4)
    tree.state.footer!.setTurns(9)
    tree.state.editor!.setTurns(9)
    expect(screen.contentTurns()).toBe(4)
    expect(heard).toEqual([5, 0, 2, 4])
    off()
    stream.setTurns(8)
    expect(heard).toHaveLength(4)
    expect(screen.contentTurns()).toBe(8)
    // A lease that ended reports nothing and no longer counts.
    stream.dispose()
    stream.setTurns(20)
    expect(screen.contentTurns()).toBe(4)
  })

  it('focuses the conversation only while a content slot shows something', async () => {
    const tree = await boot()
    tree.keys()
    const screen = tree.root.mayflyScreen
    const { content } = hosts(tree.terminal)
    const stream = tree.state.stream!
    expect(screen.focusConversation()).toBe(true)
    expect(tree.terminal.focused()).toBe(content)
    tree.state.editor!.focus()
    stream.set(null)
    expect(screen.focusConversation()).toBe(false)
    expect(tree.terminal.focused()).toBe(hosts(tree.terminal).editor)
    stream.set(streamList(streamItems(3)))
    expect(screen.focusConversation()).toBe(true)
    // A lease that ended shows nothing, and the dock and the footer are never the conversation.
    stream.dispose()
    expect(screen.focusConversation()).toBe(false)
  })
})

/** A node slot host without a screen: its slots are bare components, and a compiler lends the dependencies a renderer would. */
function bareHost(interaction?: UiInteractionService, extra: Partial<MayflyNodeSlotCompiler> = {}) {
  const root = new Context()
  cleanups.push(() => root.fiber.dispose())
  const service = interaction ?? new UiInteractionService(root)
  let requests = 0
  const compiler: MayflyNodeSlotCompiler & { readonly requests: () => number } = {
    interaction: service, components: COMPONENTS, colors: PLAIN_COLORS, keymap: { matches: () => false } as unknown as MayflyKeymap, mode: 'alternate',
    requestRender: () => { requests += 1 }, requests: () => requests, ...extra,
  }
  const prompts: number[] = []
  const slots = new Map<string, MayflyScreenSlot>()
  const host = new NodeSlotHost(
    (id, _region, component) => {
      let live = true
      const slot: MayflyScreenSlot = {
        id, get disposed() { return !live }, component: component as MayflyFocusable,
        replace() {}, focus() {}, dispose() { live = false },
      }
      slots.set(id, slot)
      return slot
    },
    () => ({ columns: 80, rows: 24 }),
    () => { prompts.push(prompts.length) },
  )
  return {
    host, compiler, service, prompts, slots,
    lease(id: string, options: MayflyNodeSlotOptions) {
      const lease = host.mount(id, options)
      return { lease, component: slots.get(id)!.component }
    },
  }
}

describe('node slot lease: routes and re-leases', () => {
  const context = (aborted = false) => ({ surfaceId: 'slot/1', source: [], revision: 1, operationId: 'op', signal: aborted ? AbortSignal.abort() : new AbortController().signal, report: vi.fn() })
  const dismiss: MayflyUiEvent = { kind: 'dismiss', pagePath: [] }

  it('answers an event without a reply and publishes nothing, and an aborted event is not heard', async () => {
    const heard: string[] = []
    const bare = bareHost()
    const { lease } = bare.lease('transcript.conversation', { region: 'content', onEvent: (event) => { heard.push(event.kind) } })
    lease.set(streamList(streamItems(3)))
    bare.host.bind(bare.compiler)
    const model = bare.service.get('slot', 'transcript.conversation')!
    const prepared = await model.endpoint.prepare(dismiss, context())
    expect(prepared.reply).toBeUndefined()
    expect(prepared.publish()).toBe(false)
    expect(heard).toEqual(['dismiss'])
    await model.endpoint.prepare(dismiss, context(true))
    expect(heard).toEqual(['dismiss'])
  })

  it('lets a stale lease go without taking the route from the lease that holds it now', async () => {
    const heard: string[] = []
    const interaction = bareHost().service
    const older = bareHost(interaction)
    const newer = bareHost(interaction)
    const first = older.lease('transcript.conversation', { region: 'content', onEvent: (event) => { heard.push(`older:${event.kind}`) } }).lease
    first.set(streamList(streamItems(3)))
    older.host.bind(older.compiler)
    const second = newer.lease('transcript.conversation', { region: 'content', onEvent: (event) => { heard.push(`newer:${event.kind}`) } }).lease
    second.set(streamList(streamItems(3)))
    newer.host.bind(newer.compiler)
    const model = interaction.get('slot', 'transcript.conversation')!
    await model.endpoint.prepare(dismiss, context())
    expect(heard).toEqual(['newer:dismiss'])
    // The older screen's teardown revokes its lease: the route stays with the newer one.
    older.host.dispose()
    await model.endpoint.prepare(dismiss, context())
    expect(heard).toEqual(['newer:dismiss', 'newer:dismiss'])
  })

  it('moves to a new route when its owner dropped the old one, and the old route hears nothing', async () => {
    const heard: string[] = []
    const bare = bareHost()
    const { lease } = bare.lease('transcript.conversation', { region: 'content', onEvent: (event) => { heard.push(event.kind) } })
    lease.set(streamList(streamItems(3)))
    bare.host.bind(bare.compiler)
    const before = bare.service.get('slot', 'transcript.conversation')!
    bare.service.remove('slot', 'transcript.conversation')
    lease.set(streamList(streamItems(4)))
    const after = bare.service.get('slot', 'transcript.conversation')!
    expect(after).not.toBe(before)
    await before.endpoint.prepare(dismiss, context())
    expect(heard).toEqual([])
    await after.endpoint.prepare(dismiss, context())
    expect(heard).toEqual(['dismiss'])
  })

  it('counts the work of a slot through the compiler\'s counters', async () => {
    const counters = createWorkCounters()
    const bare = bareHost(undefined, { counters })
    const { lease, component } = bare.lease('transcript.conversation', { region: 'content' })
    lease.set(streamList(streamItems(3)))
    bare.host.bind(bare.compiler)
    expect(component.render(80).join('')).toContain('Item number 0')
    expect(counters.nodesValidated).toBeGreaterThan(0)
    expect(counters.unitsCompiled).toBeGreaterThan(0)
  })

  it('shows a compile failure as an error row instead of throwing', () => {
    const bare = bareHost(undefined, { components: new Proxy(COMPONENTS, { get: () => { throw new Error('components unavailable') } }) })
    const { lease, component } = bare.lease('transcript.conversation', { region: 'content' })
    lease.set(streamList(streamItems(3)))
    bare.host.bind(bare.compiler)
    expect(component.render(80).join('')).toContain('Mayfly UI compilation failed safely')
  })
})
