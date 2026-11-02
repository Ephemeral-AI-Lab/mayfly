/** Real shared Trace/provider/core search, resize, detail, and reload lifetime regression. @module */
import { Context } from '@deepseek-ai/cordis'
import { isWireSnapshot, type MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import * as uiProvider from '@ephemeral-ai/mayfly-ui/provider'
import { describe, expect, it } from 'vitest'
import * as frontend from '../../src/frontend/index.ts'
import { tracePanelModel, type TraceItem, type TracePanelState } from '../../src/interaction/trace-model.ts'
import { flushRequests, renderRequest } from './request-fixture.ts'
import { expectLinesFit } from '../core/width-scan.ts'

const items: readonly TraceItem[] = [
  { seq: 10, lastSeq: 10, eventSeqs: [10], time: 1_000, type: 'turn/start', surface: 'current', title: 'Turn started', summary: 'A separate event' },
  { seq: 20, lastSeq: 20, eventSeqs: [20], time: 2_000, type: 'user/message', surface: 'current', title: 'User request', summary: 'native Trace seed' },
  { seq: 30, lastSeq: 30, eventSeqs: [30], time: 3_000, type: 'turn/end', surface: 'current', title: 'Turn ended', summary: 'Settled event' },
]

describe('shared responsive Trace lifetime', () => {
  it('preserves one query/cursor through search stop/resume, 40–120 resizes, detail, and renderer reload', async () => {
    const ctx = new Context()
    await ctx.plugin(uiProvider)
    await ctx.plugin(frontend)
    const viewport = { columns: 80, rows: 24 }
    let state: TracePanelState = {}
    const view = () => tracePanelModel('native-session', items, undefined, state)
    let handle: MayflyOverlayHandle
    handle = ctx.mayflyOverlays.open({ id: 'trace', capturing: true, presentation: 'editor', dismissal: 'discard', onEvent: { action: event => {
      if (event.kind === 'selection-accept') {
        const selected = items.find(item => String(item.seq) === event.selectedIds[0])!
        state = { selected, document: JSON.stringify({ type: selected.type, data: { content: selected.summary } }), narrow: viewport.columns < 100 ? 'detail' : 'list' }
        handle.set(view())
      } else if (event.kind === 'dismiss' && state.narrow === 'detail' && viewport.columns < 100) {
        state = { ...state, narrow: 'list' }
        handle.set(view())
        return { kind: 'completed', dismiss: false }
      }
      return { kind: 'completed' }
    } } }, view())
    await flushRequests()
    const model = ctx.mayflyUiInteraction.get('overlay', 'trace')!
    expect(isWireSnapshot(model.registration.node)).toBe(true)
    let renderer = renderRequest(model, viewport)
    const runtime = renderer.runtime
    const address = { pagePath: [], controlId: 'trace-events' }
    const paint = () => {
      const rows = renderer.component.render(viewport.columns)
      expectLinesFit('responsive Trace', rows, viewport.columns)
      expect(rows.join('\n')).not.toContain('Mayfly UI rejected')
      return rows.join('\n')
    }
    try {
      expect(paint()).toContain('Turn started')
      renderer.input('/')
      renderer.input('native Trace seed')
      expect(model.choice(address)).toMatchObject({ query: 'native Trace seed', searching: true, focusedId: '20' })
      renderer.input('\x1b')
      expect(model.choice(address)).toMatchObject({ query: 'native Trace seed', searching: false, focusedId: '20' })
      renderer.input('/')
      renderer.input('\x15')
      renderer.input('/')
      renderer.input('not_a_real_event')
      expect(paint()).toContain('No matches')
      renderer.input('\x15')
      renderer.input('/')
      renderer.input('native Trace seed')
      renderer.input('\x1b')
      renderer.input('\x1b[F')
      for (const [columns, rows] of [[40, 16], [120, 40], [40, 16], [120, 40]] as const) {
        Object.assign(viewport, { columns, rows })
        expect(paint()).toContain('User request')
        expect(model.choice(address)).toMatchObject({ query: 'native Trace seed', searching: false, focusedId: '20' })
      }
      renderer.input('\r')
      await flushRequests()
      renderer = renderRequest(model, viewport, runtime)
      expect(paint()).toContain('user/message')
      expect(model.choice(address)).toMatchObject({ query: 'native Trace seed', focusedId: '20' })
      Object.assign(viewport, { columns: 40, rows: 16 })
      paint()
      renderer.input('\r')
      await flushRequests()
      renderer = renderRequest(model, viewport, runtime)
      expect(paint()).toContain('user/message')
      for (const columns of [120, 40, 120, 40]) {
        viewport.columns = columns
        expect(paint()).toContain('user/message')
      }
      renderer.input('\x1b')
      await flushRequests()
      renderer = renderRequest(model, viewport, runtime)
      expect(paint()).toContain('User request')
      expect(model.choice(address)).toMatchObject({ query: 'native Trace seed', searching: false, focusedId: '20' })
      runtime.deactivate()
      renderer = renderRequest(model, viewport, runtime)
      expect(paint()).toContain('User request')
      renderer.input('\r')
      await flushRequests()
      renderer = renderRequest(model, viewport, runtime)
      expect(paint()).toContain('user/message')
    } finally {
      runtime.dispose()
      await ctx.fiber.dispose()
    }
  })
})
