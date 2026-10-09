/** The arm delay: an overlay that opens unprompted swallows every key but `Esc` for `armMs`, and leaves no timer behind.
 * @module @ephemeral-ai/mayfly/core/tests/overlay-arm
 */
import { Context } from '@deepseek-ai/cordis'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply as applyApi } from '../../../ui/src/provider.ts'
import type { MayflyUiActionEvent, MayflyUiNode } from '../../../ui/src/contracts.ts'
import { patterns, ui } from '../../../ui/src/index.ts'
import { OverlayArm } from '../../src/core/overlay-arm.ts'
import { mountMayflySurfaceRenderer } from '../../src/core/surface-renderer.ts'
import { startMayflyTerminal, type MayflyTerminalRuntime } from '../../src/core/terminal.ts'
import type { MayflyComponents, MayflyFocusable, MayflyKeyAction, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { createFakeEditor } from './fake-editor.ts'
import { FakeTerminal } from './fake-terminal.ts'
import * as frontend from '../../src/frontend/index.ts'
import { MayflyScreenService } from '../../src/core/screen.ts'

const colors = new Proxy({}, { get: () => (text: string) => text }) as MayflySemanticColors
const components = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth, createEditor: createFakeEditor } as MayflyComponents

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

async function flush(turns = 8): Promise<void> { for (let index = 0; index < turns; index += 1) await Promise.resolve() }

const choices = (): MayflyUiNode => ui.list({
  id: 'decision', role: 'choose', numbered: true, selectedIds: [],
  items: [{ id: 'once', label: 'Allow once' }, { id: 'reject', label: 'Reject' }],
})

interface Bench {
  readonly root: Context
  readonly slot: { readonly component: MayflyFocusable }
  readonly chosen: string[]
  readonly dismissed: string[]
  readonly rows: () => string
  open(armMs: number | undefined, node?: MayflyUiNode): ReturnType<Context['mayflyOverlays']['open']>
  dispose(): Promise<void>
}

async function bench(): Promise<Bench> {
  const root = new Context()
  await root.plugin({ name: 'test-mayfly-ui-provider', apply: applyApi })
  await root.plugin(frontend)
  const terminal = new FakeTerminal(80, 24)
  const runtime: MayflyTerminalRuntime = await startMayflyTerminal(terminal, () => Promise.resolve(undefined))
  await root.plugin(MayflyScreenService, runtime)
  const owner = new Scope()
  Object.assign(owner, {
    mayflyPanes: root.mayflyPanes, mayflyOverlays: root.mayflyOverlays, mayflyUiInteraction: root.mayflyUiInteraction, mayflyScreen: root.mayflyScreen,
    mayflyComponents: components, mayflyTheme: { colors }, emit: root.emit.bind(root),
    mayflyKeymap: { register(_actions: MayflyKeyAction[]) { return () => {} }, matches: () => false, dispatch: () => false },
  })
  mountMayflySurfaceRenderer(owner as never, runtime, key => key)
  /* The editor is the prompt a stray key would otherwise land in; the overlay replaces it while a request is open. */
  const slot = root.mayflyScreen.mountDockSlot('editor.prompt', { focused: false, render: () => ['prompt'], invalidate() {}, handleInput() {} } as MayflyFocusable)
  slot.focus()
  const chosen: string[] = []
  const dismissed: string[] = []
  return {
    root, slot, chosen, dismissed,
    rows: () => slot.component.render(80).map(stripTerminalSequences).join('\n'),
    open: (armMs, node = choices()) => root.mayflyOverlays.open({
      id: 'request', title: 'Approve command', presentation: 'editor', capturing: true,
      ...(armMs === undefined ? {} : { armMs }),
      onEvent: { action: (event: MayflyUiActionEvent) => { if (event.kind === 'selection-accept') chosen.push(...event.selectedIds); if (event.kind === 'dismiss') dismissed.push(event.kind); return { kind: 'completed' } } },
    }, node),
    async dispose() { owner.dispose(); slot.dispose(); await runtime.stop(); await root.fiber.dispose() },
  }
}

describe('overlay arm delay', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('grants nothing for a stray 1 and Enter while a request opens, and chooses with the same keys afterwards', async () => {
    const b = await bench()
    try {
      const handle = b.open(300)
      await flush()
      expect(b.rows()).toContain('… ready in a moment')
      /* A republish repaints through the same arm, so the hint survives it. */
      handle.set(ui.list({ id: 'decision', role: 'choose', numbered: true, selectedIds: [], items: [{ id: 'once', label: 'Allow once' }, { id: 'reject', label: 'Reject now' }] }))
      await flush()
      expect(b.rows()).toContain('Reject now')
      expect(b.rows()).toContain('… ready in a moment')
      b.slot.component.handleInput?.('1')
      b.slot.component.handleInput?.('\r')
      vi.advanceTimersByTime(299)
      b.slot.component.handleInput?.('1')
      await flush()
      expect(b.chosen).toEqual([])
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(1)
      await flush()
      expect(vi.getTimerCount()).toBe(0)
      expect(b.rows()).not.toContain('ready in a moment')
      b.slot.component.handleInput?.('1')
      await flush()
      expect(b.chosen).toEqual(['once'])
      handle.close()
    } finally { await b.dispose() }
  })

  it('lets Esc dismiss while armed', async () => {
    const b = await bench()
    try {
      b.open(300)
      await flush()
      b.slot.component.handleInput?.('x')
      await flush()
      expect(b.dismissed).toEqual([])
      b.slot.component.handleInput?.('\x1b')
      await flush()
      expect(b.dismissed).toEqual(['dismiss'])
      expect(b.chosen).toEqual([])
    } finally { await b.dispose() }
  })

  it('does not arm an overlay without armMs, or with armMs 0', async () => {
    const b = await bench()
    try {
      b.open(undefined).close()
      await flush()
      b.open(0)
      await flush()
      expect(b.rows()).not.toContain('ready in a moment')
      b.slot.component.handleInput?.('1')
      await flush()
      expect(b.chosen).toEqual(['once'])
      expect(vi.getTimerCount()).toBe(0)
    } finally { await b.dispose() }
  })

  it('leaves no timer when the overlay closes or the renderer unloads during the delay', async () => {
    const b = await bench()
    try {
      const handle = b.open(300)
      await flush()
      expect(vi.getTimerCount()).toBe(1)
      handle.close()
      await flush()
      expect(vi.getTimerCount()).toBe(0)
      b.open(300)
      await flush()
      expect(vi.getTimerCount()).toBe(1)
    } finally { await b.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an armMs outside 0 to 2000 or not an integer', async () => {
    const b = await bench()
    try {
      for (const [index, armMs] of [-1, 2001, 1.5, Number.NaN, '300' as unknown as number].entries()) {
        expect(() => b.root.mayflyOverlays.open({ id: `bad-${String(index)}`, armMs }, ui.text('x'))).toThrow('armMs')
      }
      b.root.mayflyOverlays.open({ id: 'edge', armMs: 2000 }, ui.text('x')).close()
    } finally { await b.dispose() }
  })
})

describe('patterns.decisionPanel opened unprompted', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const decision = (instant: boolean): MayflyUiNode => patterns.decisionPanel({
    title: 'Approve command', instant, options: [{ id: 'once', label: 'Allow once' }, { id: 'reject', label: 'Reject' }],
  })

  it.each([true, false])('grants nothing for a 1 and Enter typed into the editor (instant %s), then the same keys choose', async instant => {
    const b = await bench()
    try {
      const handle = b.open(patterns.decisionArmMs, decision(instant))
      await flush()
      expect(b.rows()).toContain('Allow once')
      expect(b.rows()).toContain('ready in a moment')
      b.slot.component.handleInput?.('1')
      b.slot.component.handleInput?.('\r')
      b.slot.component.handleInput?.('2')
      await flush()
      expect(b.chosen).toEqual([])
      vi.advanceTimersByTime(patterns.decisionArmMs)
      await flush()
      expect(b.rows()).not.toContain('ready in a moment')
      b.slot.component.handleInput?.('\r')
      await flush()
      expect(b.chosen).toEqual(['once'])
      handle.close()
    } finally { await b.dispose() }
  })

  it('chooses by digit once armed, and Esc rejects while armed', async () => {
    const b = await bench()
    try {
      const handle = b.open(patterns.decisionArmMs, decision(true))
      await flush()
      b.slot.component.handleInput?.('\x1b')
      await flush()
      expect(b.dismissed).toEqual(['dismiss'])
      handle.close()
      const again = b.open(patterns.decisionArmMs, decision(true))
      await flush()
      vi.advanceTimersByTime(patterns.decisionArmMs)
      await flush()
      b.slot.component.handleInput?.('2')
      await flush()
      expect(b.chosen).toEqual(['reject'])
      again.close()
    } finally { await b.dispose() }
  })
})

describe('OverlayArm', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('opens once on the first focus, keeps the window after a later start, and stays armed once disposed', () => {
    const elapsed = vi.fn()
    const arm = new OverlayArm(300, elapsed)
    expect(arm.armed).toBe(true)
    expect(arm.hints()).toHaveLength(1)
    arm.start()
    vi.advanceTimersByTime(200)
    arm.start()
    vi.advanceTimersByTime(100)
    expect(elapsed).toHaveBeenCalledOnce()
    expect(arm.armed).toBe(false)
    expect(arm.hints()).toEqual([])
    expect(arm.swallows('1')).toBe(false)
    const disposed = new OverlayArm(300, elapsed)
    disposed.start()
    disposed.dispose()
    vi.advanceTimersByTime(1000)
    expect(elapsed).toHaveBeenCalledOnce()
    expect(disposed.swallows('1')).toBe(true)
    expect(disposed.swallows('\x1b')).toBe(false)
  })
})
