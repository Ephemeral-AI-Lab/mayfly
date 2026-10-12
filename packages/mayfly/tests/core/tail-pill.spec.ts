/**
 * The tail chip: on the alternate screen a view scrolled away from the tail keeps a chip on the content region's last row,
 * `N new turns · Ctrl+↓` with the turns of the agent loop that began below it, and `Back to bottom · Ctrl+↓`, the way back, when
 * none did. It shows nothing while the view follows the tail.
 * @module @ephemeral-ai/mayfly/core/tests/tail-pill
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply as applyApi } from '../../../ui/src/provider.ts'
import { mountMayflySurfaceRenderer } from '../../src/core/surface-renderer.ts'
import { startMayflyTerminal } from '../../src/core/terminal.ts'
import { MayflyScreenService } from '../../src/core/screen.ts'
import type { MayflyComponents, MayflyKeyAction, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import * as frontend from '../../src/frontend/index.ts'
import { AltScreenTerminal } from './alt-screen-terminal.ts'
import { waitForRender } from './fake-terminal.ts'

const colors = new Proxy({}, { get: () => (text: string) => text }) as MayflySemanticColors
const components = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as MayflyComponents

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

const WHEEL_UP = '\x1b[<64;1;1M'

/** A terminal and a renderer over content whose height and newest turn the test moves. */
async function bench(keys: string[] = []) {
  const root = new Context()
  await root.plugin({ name: 'test-mayfly-ui-provider', apply: applyApi })
  await root.plugin(frontend)
  const terminal = new AltScreenTerminal(40, 10)
  const runtime = startMayflyTerminal(terminal, { screenMode: 'alternate' })
  await root.plugin(MayflyScreenService, runtime)
  const owner = new Scope()
  Object.assign(owner, {
    mayflyPanes: root.mayflyPanes, mayflyUiInteraction: root.mayflyUiInteraction, mayflyOverlays: root.mayflyOverlays, mayflyScreen: root.mayflyScreen,
    mayflyComponents: components, mayflyTheme: { colors }, emit: root.emit.bind(root),
    mayflyKeymap: { register(_actions: MayflyKeyAction[]) { return () => {} }, matches: () => false, dispatch: () => false, getKeys: () => keys },
  })
  mountMayflySurfaceRenderer(owner as never, runtime, { translate: (key, values) => key.replace('{count}', String(values?.count)).replace('{key}', String(values?.key)), revision: () => 0 })
  const slot = root.mayflyScreen.mountNodeSlot('transcript.conversation', { region: 'content' })
  const state = { length: 30 }
  runtime.addChild({ render: () => Array.from({ length: state.length }, (_, index) => `row-${String(index)}`), invalidate: () => {} })
  runtime.requestRender(true)
  await waitForRender()
  return {
    runtime, terminal, state, slot,
    /** The viewport's last row: the terminal keeps its own last row free, so it is the one above it. */
    lastRow: async (): Promise<string | undefined> => (await terminal.screen()).at(-2),
    paint: async (): Promise<void> => { runtime.requestRender(); await waitForRender() },
    scrollUp: async (): Promise<void> => { terminal.sendInput(WHEEL_UP); await waitForRender() },
    dispose: async (): Promise<void> => { owner.dispose(); await runtime.stop(); terminal.dispose() },
  }
}

describe('the tail chip', () => {
  it('shows nothing at the tail, the way back once scrolled away, and the turns that began below the view', async () => {
    const { runtime, terminal, state, slot, lastRow, paint, scrollUp, dispose } = await bench()
    slot.setTurns(3)
    // Following the tail: rows scroll in and no chip shows.
    state.length += 5
    await paint()
    expect(await lastRow()).not.toMatch(/Ctrl/u)

    // Scrolled away with nothing new below: the chip stays, as the way back to the bottom.
    await scrollUp()
    expect(runtime.contentTail()).toMatchObject({ away: true })
    expect(await lastRow()).toMatch(/ Back to bottom · Ctrl\+↓ $/u)

    // Rows arrive inside the same turn: still no new turn.
    state.length += 4
    await paint()
    expect(await lastRow()).toMatch(/ Back to bottom · Ctrl\+↓ $/u)

    // Two turns of the agent loop begin below the view: the chip counts turns, at the right edge, once.
    state.length += 7
    slot.setTurns(5)
    await paint()
    expect(await lastRow()).toMatch(/ 2 new turns · Ctrl\+↓ $/u)
    expect((await terminal.screen()).filter(row => row.includes('Ctrl+↓'))).toHaveLength(1)

    // Following the tail takes the chip away.
    runtime.followContent()
    await waitForRender()
    expect((await terminal.screen()).filter(row => row.includes('Ctrl+↓'))).toHaveLength(0)
    await dispose()
  })

  it('names the keys the keymap binds to the follow action', async () => {
    const { state, lastRow, paint, scrollUp, dispose } = await bench(['ctrl+down', 'end'])
    await scrollUp()
    state.length += 4
    await paint()
    expect(await lastRow()).toMatch(/ Back to bottom · Ctrl\+↓\/End $/u)
    await dispose()
  })

  it('keeps a reader away through a frame in which the content shrinks, and restores their place', async () => {
    const terminal = new AltScreenTerminal(40, 10)
    const runtime = startMayflyTerminal(terminal, { screenMode: 'alternate' })
    let length = 40
    runtime.addChild({ render: () => Array.from({ length }, (_, index) => `row-${String(index)}`), invalidate: () => {} })
    runtime.requestRender(true)
    await waitForRender()
    terminal.sendInput(WHEEL_UP)
    await waitForRender()
    const first = (await terminal.screen())[0]
    expect(runtime.contentTail()).toMatchObject({ away: true })

    // A live draft settling rewrites its rows: for one frame the content is shorter than the reader's place.
    length = 12
    runtime.requestRender()
    await waitForRender()
    length = 50
    runtime.requestRender()
    await waitForRender()
    expect(runtime.contentTail()).toMatchObject({ away: true })
    expect((await terminal.screen())[0]).toBe(first)

    // Their own scroll to the end ends the hold.
    runtime.followContent()
    await waitForRender()
    expect(runtime.contentTail()).toMatchObject({ away: false })
    await runtime.stop()
    terminal.dispose()
  })
})
