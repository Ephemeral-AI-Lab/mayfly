/**
 * The node slot on its real mounting path: the test host leases a status-shaped row, an editor-shaped surface, and a
 * stream-shaped list from an ordinary Fiber, and the surface renderer compiles them. Covers the key grammar and the hint
 * row, a core reload that keeps the slots' interaction state, stale leases, and staleness under a warm cache.
 */
import { Context } from '@deepseek-ai/cordis'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as frontend from '../../src/frontend/index.ts'
import { INTERACTION_KEY_ACTIONS } from '../../src/interaction/keys.ts'
import { visibleWidth } from '../../src/core/width.ts'
import type { MayflyComponent } from '../../src/core/types.ts'
import type { MayflyUiImageSource } from '../../src/core/ui-images.ts'
import {
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

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })
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
    expect(content.render(100)[0]).toContain('(1/200)')

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
    expect(after.content.render(100)[0]).toContain('(4/200)')
    expect(after.editor.render(100)[0]).toContain('Prompt: ok')
    expect(tree.root.mayflyUiInteraction.get('slot', 'editor.prompt')!.form(PROMPT)?.fields.draft?.value).toBe('ok')

    // A lease from before the reload is fenced: it neither publishes nor focuses nor releases the new slot's state.
    stale.set(streamList(streamItems(3)))
    stale.focus()
    stale.dispose()
    expect(after.content.render(100)[0]).toContain('(4/200)')
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
  })
})
