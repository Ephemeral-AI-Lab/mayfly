/**
 * The content scroll's extent: it lays out against the rows it paints, not against an estimate. A lazy document reports an
 * estimated length until its rows are read, the layout reads the length before it reads any row, and nothing may leave the
 * last rows out of reach: the window is painted before the layout settles, a length that moves while the frame paints gets
 * its own frame, and a scroll the content cannot take lays out again.
 * @module @ephemeral-ai/mayfly/core/tests/tail-extent
 */
import { describe, expect, it } from 'vitest'
import { startMayflyTerminal } from '../../src/core/terminal.ts'
import { virtualRows, type RowSource } from '../../src/core/ui-rows.ts'
import { AltScreenTerminal } from './alt-screen-terminal.ts'
import { waitForRender } from './fake-terminal.ts'

/** A lazy document: `length` is an estimate until the rows are painted, as a segmented source's is. */
function lazyDocument(estimate: number, painted: number, options: { readonly prepares: boolean }) {
  const state = { settled: false, prepared: 0 }
  const source: RowSource = {
    get length() { return state.settled ? painted : estimate },
    get revision() { return state.settled ? 1 : 0 },
    row(index) {
      // Reading a row paints its segment, which replaces the estimate: no source tells the layout.
      state.settled = true
      return `row-${String(index)}`
    },
    ...(options.prepares ? { prepare() { state.prepared += 1; state.settled = true } } : {}),
  }
  return { state, rows: virtualRows(source) }
}

async function bench(rows: () => string[]) {
  const terminal = new AltScreenTerminal(40, 10)
  const runtime = startMayflyTerminal(terminal, { screenMode: 'alternate' })
  runtime.addChild({ render: rows, invalidate: () => {} })
  runtime.requestRender(true)
  await waitForRender()
  await waitForRender()
  return { runtime, terminal }
}

describe('the content scroll extent', () => {
  it('paints the window before it settles on a height, so follow-end lands on the last painted row', async () => {
    const document = lazyDocument(40, 60, { prepares: true })
    const { runtime } = await bench(() => document.rows)
    const tail = runtime.contentTail()!
    expect(document.state.prepared).toBeGreaterThan(0)
    expect(tail.top + tail.viewport).toBe(60)
    expect(tail.away).toBe(false)
  })

  it('lays out again when the rows it painted moved the length, though no source said so', async () => {
    const document = lazyDocument(40, 60, { prepares: false })
    const { runtime } = await bench(() => document.rows)
    const tail = runtime.contentTail()!
    expect(tail.top + tail.viewport).toBe(60)
  })

  it('lays out again when a scroll cannot move, so a stale height is not a wall', async () => {
    const state = { length: 30 }
    const { runtime } = await bench(() => Array.from({ length: state.length }, (_, index) => `row-${String(index)}`))
    const before = runtime.contentTail()!
    expect(before.top + before.viewport).toBe(30)
    // The content grew with no frame requested, as a lazy source's corrected count can.
    state.length = 50
    expect(runtime.scrollContent('down', 1)).toBe(false)
    await waitForRender()
    const after = runtime.contentTail()!
    expect(after.top + after.viewport).toBe(50)
  })
})
