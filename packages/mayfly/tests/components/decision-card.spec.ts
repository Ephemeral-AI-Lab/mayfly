/** The decision card's frames: the approval and plan states at 120 and 40 columns, the queue, and the arm window.
 * @module @ephemeral-ai/mayfly/tests/components/decision-card
 */
import { Context } from '@deepseek-ai/cordis'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply as applyApi } from '../../../ui/src/provider.ts'
import type { MayflyUiActionEvent } from '../../../ui/src/contracts.ts'
import { DECISION, DecisionCard, type DecisionCardFacts } from '../../src/components/decision-card.ts'
import { mountMayflySurfaceRenderer } from '../../src/core/surface-renderer.ts'
import { startMayflyTerminal, type MayflyTerminalRuntime } from '../../src/core/terminal.ts'
import type { MayflyComponents, MayflyFocusable, MayflyKeyAction, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import * as frontend from '../../src/frontend/index.ts'
import { MayflyScreenService } from '../../src/core/screen.ts'
import { createFakeEditor } from '../core/fake-editor.ts'
import { FakeTerminal } from '../core/fake-terminal.ts'
import { flush } from '../helpers.ts'

const colors = new Proxy({}, { get: () => (text: string) => text }) as MayflySemanticColors
const components = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth, createEditor: createFakeEditor } as MayflyComponents

/** The approval card as the plugin builds it for an edit, a command, and a generic tool. */
const approval = (tool: string, change: boolean, queue?: string): DecisionCardFacts => ({
  title: 'Decide',
  ...queue === undefined ? {} : { queue },
  options: [
    { id: 'allow-once', label: 'Allow once' },
    { id: 'allow-session', label: `Allow ${tool} for this session` },
    { id: 'reject', label: 'Reject' },
  ],
  note: { label: 'Feedback', placeholder: 'type to explain…' },
  keys: [{ id: 'open', semantic: 'external', label: change ? 'Open diff' : 'Open command', hintLabel: change ? 'open diff' : 'open command' }],
})

/** The plan card as the plugin builds it. */
const plan: DecisionCardFacts = {
  title: 'Decide',
  options: [
    { id: 'approve', label: 'Approve and start' },
    { id: 'keep', label: 'Keep planning…' },
    { id: 'reject', label: 'Reject' },
  ],
  note: { label: 'Revise', placeholder: 'type the revision in place' },
  keys: [
    { id: 'copy', semantic: 'copy', label: 'Copy plan', hintLabel: 'copy plan' },
    { id: 'open', semantic: 'external', label: 'Open plan', hintLabel: 'open plan' },
  ],
}

class Scope {
  private readonly cleanups: Array<() => void> = []
  effect(callback: () => void | (() => void)): () => void {
    const cleanup = callback()
    if (typeof cleanup !== 'function') return () => {}
    this.cleanups.push(cleanup)
    return cleanup
  }
  dispose(): void { for (const cleanup of this.cleanups.splice(0).reverse()) cleanup() }
}

interface Bench {
  readonly root: Context
  readonly slot: { readonly component: MayflyFocusable }
  readonly events: MayflyUiActionEvent[]
  frame(): string
  open(facts: DecisionCardFacts, armMs?: number): ReturnType<Context['mayflyOverlays']['open']>
  dispose(): Promise<void>
}

/** A real overlay host and surface renderer on a terminal of the given width, the card opened as the request does. */
async function bench(columns: number): Promise<Bench> {
  const root = new Context()
  await root.plugin({ name: 'test-mayfly-ui-provider', apply: applyApi })
  await root.plugin(frontend)
  const terminal = new FakeTerminal(columns, 40)
  const runtime: MayflyTerminalRuntime = startMayflyTerminal(terminal)
  await root.plugin(MayflyScreenService, runtime)
  const owner = new Scope()
  Object.assign(owner, {
    mayflyPanes: root.mayflyPanes, mayflyOverlays: root.mayflyOverlays, mayflyUiInteraction: root.mayflyUiInteraction, mayflyScreen: root.mayflyScreen,
    mayflyComponents: components, mayflyTheme: { colors }, emit: root.emit.bind(root),
    mayflyKeymap: { register(_actions: MayflyKeyAction[]) { return () => {} }, matches: () => false, dispatch: () => false },
  })
  mountMayflySurfaceRenderer(owner as never, runtime, { translate: key => key, revision: () => 0 })
  /* The editor is the prompt the card replaces while a request is open. */
  const slot = root.mayflyScreen.mountDockSlot('editor.prompt', { focused: false, render: () => ['prompt'], invalidate() {}, handleInput() {} } as MayflyFocusable)
  slot.focus()
  const events: MayflyUiActionEvent[] = []
  return {
    root, slot, events,
    frame: () => slot.component.render(columns).map(line => stripTerminalSequences(line).trimEnd()).join('\n'),
    open: (facts, armMs) => root.mayflyOverlays.open({
      id: 'request', presentation: 'editor', capturing: true, dismissal: 'discard', contentScroll: true,
      ...(armMs === undefined ? {} : { armMs }),
      onEvent: { action: (event: MayflyUiActionEvent) => { events.push(event); return { kind: 'completed' } } },
    }, DecisionCard(facts)),
    async dispose() { owner.dispose(); slot.dispose(); await runtime.stop(); await root.fiber.dispose() },
  }
}

describe('decision card frames', () => {
  let open: Bench | undefined
  afterEach(async () => { await open?.dispose(); open = undefined })
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('shows the edit approval in the lane at 120 columns exactly: the rule, the numbered choices, the note, the hint row', async () => {
    open = await bench(120)
    open.open(approval('edit', true))
    await flush(8)
    const rows = open.frame().split('\n')
    expect(rows).toHaveLength(6)
    expect(rows[0]).toMatch(/^── Decide ─+$/u)
    expect(visibleWidth(rows[0]!)).toBe(120)
    expect(rows.slice(1)).toEqual([
      '→ 1. Allow once',
      '  2. Allow edit for this session',
      '  3. Reject',
      '  Feedback: type to explain…',
      '  ↑/↓ options · 1-3 choose · Enter choose · Ctrl+G open diff · Esc reject',
    ])
  })

  it.each([
    ['bash', approval('bash', false), 'Ctrl+G open command', 'Allow bash for this session'],
    ['generic', approval('read', false), 'Ctrl+G open command', 'Allow read for this session'],
  ] as const)('words the %s approval with its own grant and command key at 120 columns', async (_name, facts, hint, grant) => {
    open = await bench(120)
    open.open(facts)
    await flush(8)
    const frame = open.frame()
    expect(frame).toContain(`  2. ${grant}`)
    expect(frame).toContain(hint)
    expect(frame).toContain('3. Reject')
    for (const line of frame.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(120)
  })

  it('shows the approval at 40 columns with the queue on the rule and every row inside the width', async () => {
    open = await bench(40)
    open.open(approval('edit', true, '1 of 3 waiting'))
    await flush(8)
    const rows = open.frame().split('\n')
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40)
    expect(rows[0]).toBe('── Decide ─────────────── 1 of 3 waiting')
    // The row keeps its labels and gives up the least important part (the open key) before it gives up a label.
    expect(rows.at(-1)).toBe('  Enter choose · Esc reject')
  })

  it('shows the plan review at 120 and 40 columns with the fixed rows and the revision note', async () => {
    open = await bench(120)
    open.open(plan)
    await flush(8)
    const wide = open.frame().split('\n')
    expect(wide.slice(1)).toEqual([
      '→ 1. Approve and start',
      '  2. Keep planning…',
      '  3. Reject',
      '  Revise: type the revision in place',
      '  ↑/↓ options · 1-3 choose · Enter choose · c copy plan · Ctrl+G open plan · Esc reject',
    ])
    await open.dispose()
    open = await bench(40)
    open.open(plan)
    await flush(8)
    for (const row of open.frame().split('\n')) expect(visibleWidth(row)).toBeLessThanOrEqual(40)
  })

  it('shows the queue count on the lane rule only when requests wait', async () => {
    open = await bench(120)
    open.open(approval('bash', false, '1 of 3 waiting'))
    await flush(8)
    expect(open.frame().split('\n')[0]).toContain('1 of 3 waiting')
    await open.dispose()
    open = await bench(120)
    open.open(approval('bash', false))
    await flush(8)
    expect(open.frame().split('\n')[0]).not.toContain('waiting')
  })

  it('opens unarmed without the arm hint, and armed with the hint that clears when the window closes', async () => {
    open = await bench(120)
    const unarmed = open.open(approval('bash', false))
    await flush(8)
    expect(open.frame()).not.toContain('ready in a moment')
    unarmed.close()
    await flush(8)
    await open.dispose()

    open = await bench(120)
    open.open(approval('bash', false), 300)
    await flush(8)
    expect(open.frame()).toContain('… ready in a moment')
    vi.advanceTimersByTime(300)
    await flush(8)
    expect(open.frame()).not.toContain('ready in a moment')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('grants nothing for a stray digit or Enter inside the window and chooses with the same keys after it', async () => {
    open = await bench(120)
    open.open(approval('bash', false), 300)
    await flush(8)
    open.slot.component.handleInput?.('1')
    open.slot.component.handleInput?.('\r')
    vi.advanceTimersByTime(299)
    open.slot.component.handleInput?.('1')
    await flush(8)
    expect(open.events).toEqual([])
    vi.advanceTimersByTime(1)
    await flush(8)
    open.slot.component.handleInput?.('1')
    await flush(8)
    /* A digit on the numbered list runs the card's accept action, which reads the chosen row back from the selections. */
    expect(open.events.at(-1)).toMatchObject({ kind: 'activate', controlId: DECISION.choose, actionId: DECISION.choose })
  })

  it('lets Esc reach the card inside the window', async () => {
    open = await bench(120)
    open.open(approval('bash', false), 300)
    await flush(8)
    open.slot.component.handleInput?.('\x1b')
    await flush(8)
    expect(open.events).toEqual([{ kind: 'dismiss', pagePath: [] }])
  })
})
