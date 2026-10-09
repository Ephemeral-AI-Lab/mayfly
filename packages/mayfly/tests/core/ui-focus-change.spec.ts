/**
 * `focus-change` (roadmap slice 1.5): focus moves reach observers as one fact per painted frame, with the newest
 * position, after the paint; the surface opening on a control is not a move; a report never cancels a `tab-change` in
 * flight; and a retired surface reports nothing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ui, type MayflyUiEvent, type MayflyUiNode } from '../../../ui/src/index.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { PROBE_PALETTE, parityComponents } from '../design/parity.ts'

const KEY = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C' } as const
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function open(node: MayflyUiNode, observer = true) {
  const events: MayflyUiEvent[] = []
  const model = new UiSurfaceModel('focus', {
    scope: { kind: 'app', targetId: 'focus' }, source: [], revision: 1, update: { reason: 'data' }, node: node as never,
    events: { prepare: async event => { events.push(event); return { reply: { kind: 'completed' as const }, publish: () => true } } },
    definition: observer ? { onEvent: {} } : {},
  } as never)
  const runtime = new MayflyUiSurfaceRuntime(model)
  const result = compileMayflyUiSurfaceNode(model.node!, {
    components: parityComponents(), colors: PROBE_PALETTE, getViewport: () => ({ columns: 80, rows: 40 }), screenMode: 'alternate',
    emit: () => {}, contextHints: { enabled: true }, surfaceRuntime: runtime,
  })
  if (!result.ok) throw new Error(result.message)
  const surface = result.value
  surface.focusTarget!.focused = true
  cleanups.push(() => { runtime.dispose(); model.dispose() })
  const frame = (): string[] => surface.component.render(80)
  const type = (...keys: string[]): void => { for (const key of keys) surface.focusTarget!.handleInput?.(key) }
  const reports = (): MayflyUiEvent[] => events.filter(event => event.kind === 'focus-change')
  const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }
  return { events, frame, type, reports, settle, dispose: () => { runtime.dispose(); model.dispose() }, disposeModel: () => { model.dispose() }, model }
}

const list = (): MayflyUiNode => ui.list({ id: 'rows', role: 'browse', selectedIds: [], items: ['a', 'b', 'c', 'd'].map(id => ({ id, label: id.toUpperCase() })) })

describe('focus-change', () => {
  it('does not report the surface opening on a control, or a frame in which focus did not move', async () => {
    const view = open(list())
    view.frame()
    view.frame()
    await view.settle()
    expect(view.reports()).toEqual([])
  })

  it('reports a burst of moves between two frames once, with the newest position', async () => {
    const view = open(list())
    view.frame()
    view.type(KEY.down, KEY.down, KEY.down)
    expect(view.reports()).toEqual([])
    view.frame()
    view.frame()
    await view.settle()
    expect(view.reports()).toEqual([{ kind: 'focus-change', pagePath: [], controlId: 'rows', itemId: 'd' }])
    view.type(KEY.up)
    view.frame()
    await view.settle()
    expect(view.reports().map(event => (event as { itemId?: string }).itemId)).toEqual(['d', 'c'])
  })

  it('reports nothing when focus returns to where the last frame left it', async () => {
    const view = open(list())
    view.frame()
    view.type(KEY.down, KEY.up)
    view.frame()
    await view.settle()
    expect(view.reports()).toEqual([])
  })

  it('leaves a tab-change in flight alone and reports the rail label that took focus', async () => {
    const rail = ui.stack.row([
      ui.child(ui.tabs({ id: 'rail', orientation: 'vertical', activeId: 'a', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }), { basis: 12, shrink: 0 }),
      ui.child(list(), { grow: 1 }),
    ])
    const view = open(ui.surface({ title: 'T', chrome: 'overlay', child: rail }))
    view.frame()
    view.type(KEY.down)
    view.frame()
    await view.settle()
    expect(view.events.map(event => event.kind)).toEqual(['tab-change', 'focus-change'])
    expect(view.reports()).toEqual([{ kind: 'focus-change', pagePath: [], controlId: 'rail', itemId: 'b' }])
    view.type(KEY.right)
    view.frame()
    await view.settle()
    expect(view.reports().at(-1)).toMatchObject({ controlId: 'rows' })
  })

  it('reports a form field, which has no item, by its control alone', async () => {
    const form = ui.form({ id: 'f', fields: [{ id: 'one', kind: 'input', label: 'One', value: '' }, { id: 'two', kind: 'toggle', label: 'Two', value: false }] })
    const view = open(ui.surface({ title: 'T', chrome: 'overlay', child: form }))
    view.frame()
    view.type(KEY.down)
    view.frame()
    await view.settle()
    expect(view.reports()).toEqual([{ kind: 'focus-change', pagePath: [], controlId: 'two' }])
  })

  it('reports nothing once the model is gone, even when asked directly', async () => {
    const view = open(list())
    view.frame()
    view.type(KEY.down)
    view.frame()
    view.disposeModel()
    await view.settle()
    view.model.observeFocus({ pagePath: [], controlId: 'rows', itemId: 'a' })
    await view.settle()
    expect(view.reports()).toEqual([])
  })

  it('reports nothing after the surface is retired, or to a registration that does not observe', async () => {
    const retired = open(list())
    retired.frame()
    retired.type(KEY.down)
    retired.frame()
    retired.dispose()
    await retired.settle()
    expect(retired.reports()).toEqual([])
    const silent = open(list(), false)
    silent.frame()
    silent.type(KEY.down)
    silent.frame()
    await silent.settle()
    expect(silent.events).toEqual([])
  })
})
