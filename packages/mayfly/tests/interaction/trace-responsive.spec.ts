/** Real shared Trace/provider/core search, resize, detail, and reload lifetime regression. @module */
import { Context } from '@deepseek-ai/cordis'
import { isWireSnapshot, type MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import * as uiProvider from '@ephemeral-ai/mayfly-ui/provider'
import { describe, expect, it } from 'vitest'
import * as frontend from '../../src/frontend/index.ts'
import { tracePanelModel, type TraceItem, type TracePanelState } from '../../src/interaction/trace-model.ts'
import { flushRequests, renderRequest } from './request-fixture.ts'
import { expectLinesFit } from '../core/width-scan.ts'

const items: readonly TraceItem[] = Array.from({ length: 16 }, (_value, index) => ({
  seq: index, lastSeq: index, eventSeqs: [index], time: 1_000 + index, type: 'custom/event', surface: 'log-only' as const, title: 'Other event', summary: 'A separate event',
})).map((item, index) => index === 3
  ? { ...item, type: 'agent/inbox/spliced', summary: 'native Trace seed' }
  : index === 8
    ? { ...item, type: 'user/message', surface: 'current', title: 'User request', summary: 'native Trace seed' }
    : item)

describe('shared responsive Trace lifetime', () => {
  it('preserves one query/cursor through search stop/resume, 40–120 resizes, detail, and renderer reload', async () => {
    const ctx = new Context()
    await ctx.plugin(uiProvider)
    await ctx.plugin(frontend)
    const viewport = { columns: 80, rows: 24 }
    let state: TracePanelState = {}
    const opened: number[] = []
    const view = () => tracePanelModel('native-session', items, undefined, state)
    let handle: MayflyOverlayHandle
    handle = ctx.mayflyOverlays.open({ id: 'trace', capturing: true, presentation: 'editor', dismissal: 'discard', onEvent: { action: event => {
      if (event.kind === 'selection-accept') {
        const selected = items.find(item => String(item.seq) === event.selectedIds[0])!
        opened.push(selected.seq)
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
    const repaint = async () => {
      await flushRequests()
      renderer = renderRequest(model, viewport, runtime)
      renderer.component.render(viewport.columns)
      await flushRequests()
    }
    const key = async (data: string) => { renderer.input(data); await repaint() }
    const address = { pagePath: [], controlId: 'trace-events' }
    const paint = () => {
      const rows = renderer.component.render(viewport.columns)
      expectLinesFit('responsive Trace', rows, viewport.columns)
      expect(rows.join('\n')).not.toContain('Mayfly UI rejected')
      return rows.join('\n')
    }
    try {
      expect(paint()).toContain('Other event')
      await key('/')
      await key('native Trace seed')
      expect(model.choice(address)).toMatchObject({ query: 'native Trace seed', searching: true, focusedId: '3' })
      await key('\x1b')
      expect(model.choice(address)).toMatchObject({ query: 'native Trace seed', searching: false, focusedId: '3' })
      await key('/')
      await key('\x15')
      await key('/')
      await key('not_a_real_event')
      expect(paint()).toContain('No matches')
      await key('\x15')
      await key('/')
      await key('native Trace seed')
      await key('\x1b')
      await key('\x1b[F')
      for (const [columns, rows] of [[40, 16], [120, 40], [40, 16], [120, 40]] as const) {
        Object.assign(viewport, { columns, rows })
        await repaint()
        expect(paint()).toContain('User request')
        const revision = model.revision
        for (let frame = 0; frame < 3; frame += 1) {
          model.admitVisibleControls()
          await repaint()
          expect(model.revision).toBe(revision)
        }
        expect(renderer.focusTarget?.captureFocusIdentity?.()).toMatchObject({ controlId: 'trace-events', itemId: '8' })
        expect(model.choice(address)).toMatchObject({ query: 'native Trace seed', searching: false, focusedId: '8' })
      }
      await key('\r')
      await flushRequests()
      renderer = renderRequest(model, viewport, runtime)
      expect(opened).toEqual([8])
      expect(paint()).toContain('Type')
      expect(state.document).toBe(JSON.stringify({ type: 'user/message', data: { content: 'native Trace seed' } }))
      expect(paint()).toContain('user/message')
      expect(model.choice(address)).toMatchObject({ query: 'native Trace seed', focusedId: '8' })
      Object.assign(viewport, { columns: 40, rows: 16 })
      paint()
      await key('\r')
      await flushRequests()
      renderer = renderRequest(model, viewport, runtime)
      expect(paint()).toContain('user/message')
      for (const columns of [120, 40, 120, 40]) {
        viewport.columns = columns
        expect(paint()).toContain('user/message')
      }
      await key('\x1b')
      await flushRequests()
      renderer = renderRequest(model, viewport, runtime)
      expect(paint()).toContain('User request')
      expect(model.choice(address)).toMatchObject({ query: 'native Trace seed', searching: false, focusedId: '8' })
      runtime.deactivate()
      renderer = renderRequest(model, viewport, runtime)
      expect(paint()).toContain('User request')
      await key('\r')
      await flushRequests()
      renderer = renderRequest(model, viewport, runtime)
      expect(paint()).toContain('user/message')
    } finally {
      runtime.dispose()
      await ctx.fiber.dispose()
    }
  })
})
