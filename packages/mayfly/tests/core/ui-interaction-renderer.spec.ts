/** Real compiler input trajectories over frontend-owned form and choice state.
 * @module @ephemeral-ai/mayfly/tests/core/ui-interaction-renderer
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import * as provider from '../../../ui/src/provider.ts'
import type { MayflyUiEventHandlers, MayflyUiNode } from '../../../ui/src/contracts.ts'
import * as frontend from '../../src/frontend/index.ts'
import { compileMayflyUiSurfaceNode, MayflyUiSurfaceRuntime } from '../../src/core/ui-compiler.ts'
import type { MayflyComponents, MayflyKeymap, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { createFakeEditor } from './fake-editor.ts'
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js'
import { ScrollView } from '@earendil-works/pi-tui'
import type { LayoutBox } from '@earendil-works/pi-tui/dist/layout.js'
import { ACTION_CANCEL, ACTION_SUBMIT } from '../../src/core/key-actions.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const identity = (value: string) => value
const colors = new Proxy({ logoGradient: [identity] }, { get: (_target, key) => key === 'logoGradient' ? [identity] : identity }) as MayflySemanticColors
const components = { createEditor: createFakeEditor, visibleWidth, truncateToWidth, wrapText: wrapTextWithAnsi } as MayflyComponents
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })
const scrollViews = (box: LayoutBox): ScrollView[] => [
  ...(box.scrollView === undefined ? [] : [box.scrollView]),
  ...box.children.flatMap(scrollViews),
]

async function setup(node: MayflyUiNode, onEvent?: MayflyUiEventHandlers, screenMode: 'main' | 'alternate' = 'alternate', keymap?: MayflyKeymap) {
  const ctx = new Context()
  const api = await ctx.plugin(provider)
  cleanups.push(() => api.dispose())
  const front = await ctx.plugin(frontend)
  cleanups.push(() => front.dispose())
  await flush()
  const handle = ctx.mayflyOverlays.open({ id: 'editor', capturing: true, ...(onEvent === undefined ? {} : { onEvent }) }, node)
  const model = ctx.mayflyUiInteraction.get('overlay', 'editor')!
  const viewport = { columns: 80, rows: 20 }
  const compile = () => {
    const runtime = new MayflyUiSurfaceRuntime(model)
    const result = compileMayflyUiSurfaceNode(model.decisionNode ?? model.node, { surfaceRuntime: runtime, components, colors, getViewport: () => viewport, screenMode, ...(keymap === undefined ? {} : { keymap }), emit: event => model.emit(event), onUnhandledEscape: () => model.emit({ kind: 'dismiss', pagePath: [] }) })
    if (!result.ok) throw new Error(result.message)
    const compiled = result.value
    compiled.focusTarget!.focused = true
    return { runtime, compiled, input: (data: string) => compiled.focusTarget!.handleInput!(data) }
  }
  return { ctx, handle, model, viewport, compile }
}

describe('shared interaction compiler', () => {
  it.each(['main', 'alternate'] as const)('allocates a scrollable document beside decisions in %s mode', async mode => {
    const { compile, viewport } = await setup(ui.stack.column([
      ui.text('Review'),
      ui.child(ui.scroll(ui.text(Array.from({ length: 100 }, (_, index) => `Plan step ${index}`).join('\n')), { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 }),
      ui.tabs({ id: 'pages', activeId: 'decision', items: [{ id: 'decision', label: 'Decision' }] }),
      ui.child(ui.actions({ id: 'actions', items: [{ id: 'reject', label: 'Reject', defaultFocus: true }, { id: 'accept', label: 'Accept' }] }), { tab: { controlId: 'pages', itemId: 'decision' } }),
    ]), undefined, mode)
    const renderer = compile()
    const frame = () => renderLayoutFrame(renderer.compiled.component, viewport.columns, viewport.rows, () => {}).lines
    expect(frame().join('\n')).toContain('Plan step 0')
    expect(frame().join('\n')).toContain('Reject')
    renderer.input('\x1b[Z')
    renderer.input('\x1b[Z')
    renderer.input('\x1b[6~')
    expect(frame().join('\n')).not.toContain('Plan step 0')
    renderer.input('\x1b[A')
    renderer.input('\x1b[5~')
    expect(frame().join('\n')).toContain('Plan step 0')
    renderer.input('\x1b[F')
    expect(frame().join('\n')).toContain('Plan step 99')
    renderer.input('\x1b[H')
    expect(frame().join('\n')).toContain('Plan step 0')
    for (const columns of [80, 20, 5]) for (const rows of [20, 7, 3]) {
      viewport.columns = columns
      viewport.rows = rows
      const lines = frame()
      expect(lines.length).toBeLessThanOrEqual(rows)
      expect(lines.every(line => visibleWidth(line) <= columns)).toBe(true)
    }
    renderer.runtime.dispose()
  })

  it('restores a semantic document anchor across data updates, width changes, and renderer rebuilds', async () => {
    const view = (prefix = false) => ui.scroll(ui.stack.column([
      ...(prefix ? [ui.child(ui.text('prepended'), { id: 'prefix' })] : []),
      ui.child(ui.text('0123456789abcdefghij'), { id: 'body' }),
      ui.child(ui.text('tail'), { id: 'tail' }),
    ]), { id: 'document', scrollbar: true })
    const { compile, handle, model, viewport } = await setup(view())
    viewport.columns = 5
    viewport.rows = 3
    let renderer = compile()
    const frame = () => renderLayoutFrame(renderer.compiled.component, viewport.columns, viewport.rows, () => {}).lines
    frame()
    renderer.input('\x1b[B')
    renderer.input('\x1b[B')
    frame()
    expect(model.document({ pagePath: [], controlId: 'document' })!.anchor).toMatchObject({ blockId: JSON.stringify(['body']), offset: 10, follow: 'none' })

    handle.set(view(true), { reason: 'data' })
    renderer.runtime.dispose()
    viewport.columns = 10
    renderer = compile()
    expect(frame().join('\n')).toContain('abcdefghi')
    expect(frame().join('\n')).not.toContain('prepended')
    renderer.runtime.dispose()
  })

  it('keeps follow-end documents attached to appended content after rebuild', async () => {
    const view = (tail: string) => ui.scroll(ui.stack.column([
      ui.child(ui.text('head'), { id: 'head' }),
      ui.child(ui.text(tail), { id: 'tail' }),
    ]), { id: 'log', follow: 'end', scrollbar: true })
    const { compile, handle, model, viewport } = await setup(view('old tail'))
    viewport.rows = 2
    let renderer = compile()
    const frame = () => renderLayoutFrame(renderer.compiled.component, 20, viewport.rows, () => {}).lines
    expect(frame().join('\n')).toContain('old tail')
    expect(model.document({ pagePath: [], controlId: 'log' })!.anchor?.follow).toBe('end')
    handle.set(view('new tail'))
    renderer.runtime.dispose()
    renderer = compile()
    expect(frame().join('\n')).toContain('new tail')
    renderer.runtime.dispose()
  })

  it('synchronizes semantic anchors for direct scroll commands and removed documents', async () => {
    const content = ui.stack.column(Array.from({ length: 8 }, (_, index) => ui.child(ui.text(`line ${index}`), { id: `line-${index}` })))
    const { compile, handle, model, viewport } = await setup(ui.scroll(content, { id: 'document', follow: 'end', scrollbar: true }))
    viewport.rows = 3
    const renderer = compile()
    const frame = renderLayoutFrame(renderer.compiled.component, 20, viewport.rows, () => {})
    const [scroll] = scrollViews(frame.root)
    expect(scroll).toBeDefined()
    scroll!.scrollTo(2, { disableFollow: true })
    expect(model.document({ pagePath: [], controlId: 'document' })!.anchor).toMatchObject({ follow: 'none' })
    scroll!.scrollToStart()
    expect(model.document({ pagePath: [], controlId: 'document' })!.anchor).toMatchObject({ blockId: JSON.stringify(['line-0']) })
    scroll!.scrollToEnd()
    expect(model.document({ pagePath: [], controlId: 'document' })!.anchor).toMatchObject({ follow: 'end' })
    handle.set(ui.text('document removed'))
    expect(() => scroll!.scrollBy(1)).not.toThrow()
    renderer.runtime.dispose()
  })

  it('leaves an empty deferred document without a synthetic semantic anchor', async () => {
    const { compile, viewport, model } = await setup(ui.scroll(ui.stack.column([
      ui.child(ui.text('wide only'), { id: 'wide', when: { minWidth: 100 } }),
    ]), { id: 'document' }))
    viewport.columns = 40
    viewport.rows = 3
    const renderer = compile()
    const frame = renderLayoutFrame(renderer.compiled.component, viewport.columns, viewport.rows, () => {})
    const [scroll] = scrollViews(frame.root)
    expect(model.document({ pagePath: [], controlId: 'document' })!.blocks).toEqual([])
    expect(() => scroll!.scrollToStart()).not.toThrow()
    renderer.runtime.dispose()
  })

  it('contains a document withdrawn before its first semantic layout', async () => {
    const { compile, handle, viewport } = await setup(ui.scroll(ui.text('document'), { id: 'document' }))
    const renderer = compile()
    handle.set(ui.text('withdrawn'))
    expect(() => renderLayoutFrame(renderer.compiled.component, viewport.columns, viewport.rows, () => {})).not.toThrow()
    renderer.runtime.dispose()
  })

  it('deactivates a semantic scroll when focus moves to another group', async () => {
    const { compile, viewport } = await setup(ui.stack.column([
      ui.scroll(ui.text('document'), { id: 'document' }),
      ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run' }] }),
    ]))
    const renderer = compile()
    renderLayoutFrame(renderer.compiled.component, viewport.columns, viewport.rows, () => {})
    renderer.input('\t')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'run' })
    renderer.runtime.dispose()
  })

  it('allocates flexible lane content when a surface has interaction state', async () => {
    const { compile } = await setup(ui.surface({ chrome: 'lane', child: ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run' }] }) }))
    const renderer = compile()
    expect(renderer.compiled.component.render(40).join('\n')).toContain('Run')
    renderer.runtime.dispose()
  })

  it('routes typed search ahead of actions and keeps an empty search reachable', async () => {
    const acted = vi.fn()
    const { compile, model } = await setup(ui.list({ id: 'searchable', role: 'browse', filterable: true, selectedIds: [], items: [{ id: 'install', label: 'Install' }, { id: 'update', label: 'Update' }] }), { action: event => { if (event.kind === 'selection-accept') acted(event.selectedIds); return { kind: 'completed' } } })
    const renderer = compile()
    for (const character of 'install') renderer.input(character)
    expect(acted).not.toHaveBeenCalled()
    expect(model.choice({ pagePath: [], controlId: 'searchable' })!.query).toBe('install')
    expect(renderer.compiled.component.render(80).join('\n')).toContain('/ install')
    renderer.input('missing')
    expect(renderer.compiled.component.render(80).join('\n')).toContain('No matches')
    renderer.input('\x1b')
    expect(model.choice({ pagePath: [], controlId: 'searchable' })!.searching).toBe(false)
    renderer.input('\x15')
    expect(model.choice({ pagePath: [], controlId: 'searchable' })!.query).toBe('')
    renderer.input('\r')
    await flush()
    expect(acted).toHaveBeenCalledOnce()
    renderer.runtime.dispose()
  })

  it('routes slash search, empty acceptance, tree expansion, and every list edge movement', async () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ id: `item-${index}`, label: `Item ${index}` }))
    const large = await setup(ui.list({ id: 'large', role: 'browse', filterable: true, selectedIds: [], items }))
    let renderer = large.compile()
    renderer.input('/')
    expect(large.model.choice({ pagePath: [], controlId: 'large' })!.searching).toBe(true)
    renderer.input('\x1b')
    renderer.input('\x1b[6~')
    expect(large.model.choice({ pagePath: [], controlId: 'large' })!.focusedIndex).toBeGreaterThan(0)
    renderer.input('\x1b[5~')
    renderer.input('\x1b[F')
    expect(large.model.choice({ pagePath: [], controlId: 'large' })!.focusedId).toBe('item-29')
    renderer.input('\x1b[H')
    expect(large.model.choice({ pagePath: [], controlId: 'large' })!.focusedId).toBe('item-0')
    renderer.runtime.dispose()

    const tree = await setup(ui.list({ id: 'tree', role: 'browse', tree: true, selectedIds: [], items: [
      { id: 'root', label: 'Root' },
      { id: 'child', label: 'Child', parentId: 'root' },
    ] }))
    renderer = tree.compile()
    renderer.input(' ')
    expect(tree.model.choice({ pagePath: [], controlId: 'tree' })!.expandedIds).toEqual(['root'])
    renderer.runtime.dispose()

    const accepted = vi.fn()
    const empty = await setup(ui.list({ id: 'empty', role: 'choose', selectedIds: [], items: [] }), { action: event => {
      if (event.kind === 'selection-accept') accepted(event.selectedIds)
      return { kind: 'completed' }
    } })
    renderer = empty.compile()
    renderer.input('\r')
    await flush()
    expect(accepted).toHaveBeenCalledWith([])
    renderer.runtime.dispose()
  })

  it('closes from any tab depth instead of stopping on tab strips', async () => {
    const { compile, handle } = await setup(ui.stack.column([
      ui.tabs({ id: 'outer', activeId: 'one', items: [{ id: 'one', label: 'One' }] }),
      ui.child(ui.stack.column([
        ui.tabs({ id: 'inner', activeId: 'a', items: [{ id: 'a', label: 'A' }] }),
        ui.child(ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run' }] }), { tab: { controlId: 'inner', itemId: 'a' } }),
      ]), { tab: { controlId: 'outer', itemId: 'one' } }),
    ]))
    const renderer = compile()
    renderer.input('\t')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'inner' })
    renderer.input('\t')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'run' })
    expect(renderer.compiled.component.render(120).at(-1)).toContain('Esc close')
    renderer.input('\x1b')
    await vi.waitFor(() => expect(handle.closed).toBe(true))
    renderer.runtime.dispose()
  })

  it('keeps Delete and Ctrl-D inside a field instead of activating an entity action', async () => {
    const deleted = vi.fn()
    const { compile, model } = await setup(ui.stack.column([
      ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: 'draft' }] }),
      ui.actions({ id: 'actions', items: [{ id: 'delete', label: 'Delete' }] }),
    ]), { action: event => { if (event.kind === 'activate' && event.actionId === 'delete') deleted(); return { kind: 'completed' } } })
    const renderer = compile()
    renderer.compiled.component.render(80)
    renderer.input('\x04')
    renderer.input('\x1b[3~')
    await flush()
    expect(deleted).not.toHaveBeenCalled()
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.name!.value).toBe('draft')
    renderer.runtime.dispose()
  })

  it('uses the live keymap for both action dispatch and contextual hints', async () => {
    const bindings = new Map([[ACTION_SUBMIT, ['r']], [ACTION_CANCEL, ['x']]])
    const keymap: MayflyKeymap = {
      register: () => () => {},
      matches: (data, action) => bindings.get(action)?.includes(data) ?? false,
      dispatch: () => false,
      getKeys: action => [...(bindings.get(action) ?? [])],
      list: () => [],
    }
    const acted = vi.fn()
    const { compile } = await setup(ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run' }] }), { action: () => { acted(); return { kind: 'completed' } } }, 'alternate', keymap)
    const renderer = compile()
    expect(renderer.compiled.component.render(80).at(-1)).toContain('R run')
    renderer.input('\r')
    await flush()
    expect(acted).not.toHaveBeenCalled()
    renderer.input('r')
    await flush()
    expect(acted).toHaveBeenCalledOnce()
    bindings.set(ACTION_SUBMIT, ['z'])
    expect(renderer.compiled.component.render(80).at(-1)).toContain('Z run')
    renderer.input('r')
    await flush()
    expect(acted).toHaveBeenCalledOnce()
    renderer.input('z')
    await flush()
    expect(acted).toHaveBeenCalledTimes(2)
    renderer.runtime.dispose()
  })

  it('edits on focus, traverses fields without saving, and submits only from Save', async () => {
    const fields = (a: string, b: string) => ui.form({ id: 'form', fields: [
      { kind: 'input', id: 'a', label: 'First', value: a }, { kind: 'input', id: 'b', label: 'Second', value: b },
    ], submitActionId: 'save', cancelActionId: 'cancel' })
    const saved = vi.fn()
    const { model, compile } = await setup(fields('', ''), { action: event => {
      if (event.kind !== 'submit') return { kind: 'completed' }
      saved(event.submission)
      return { kind: 'accepted', node: fields('one', 'two'), source: [] }
    } })
    const renderer = compile()
    renderer.compiled.component.render(80)
    renderer.input('one')
    renderer.input('\t')
    renderer.input('two')
    renderer.input('\t')
    expect(saved).not.toHaveBeenCalled()
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.b!.value).toBe('two')
    renderer.input('\r')
    renderer.input('\r')
    await flush()
    expect(saved).toHaveBeenCalledOnce()
    expect(saved.mock.calls[0]![0].forms[0].fields.map((field: { value: string }) => field.value)).toEqual(['one', 'two'])
    expect(model.dirty).toBe(false)
    renderer.runtime.dispose()
  })

  it('retains per-tab fields and restores the semantic focus in a new renderer', async () => {
    const { model, compile } = await setup(ui.stack.column([
      ui.tabs({ id: 'tabs', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.child(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'First tab', value: '' }] }), { tab: { controlId: 'tabs', itemId: 'one' } }),
      ui.child(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Second tab', value: '' }] }), { tab: { controlId: 'tabs', itemId: 'two' } }),
    ]))
    let renderer = compile()
    renderer.input('\t')
    renderer.compiled.component.render(80)
    renderer.input('first')
    const first = { pagePath: [{ controlId: 'tabs', itemId: 'one' }], formId: 'form' }
    expect(model.form(first)!.fields.name!.value).toBe('first')
    renderer.runtime.dispose()
    renderer = compile()
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'name', pagePath: first.pagePath })
    renderer.compiled.component.render(80)
    renderer.input(' continued')
    expect(model.form(first)!.fields.name!.value).toBe('first continued')
    renderer.input('\x1b[Z')
    renderer.input('\x1b[C')
    renderer.input('\t')
    renderer.compiled.component.render(80)
    renderer.input('second')
    expect(model.form({ pagePath: [{ controlId: 'tabs', itemId: 'two' }], formId: 'form' })!.fields.name!.value).toBe('second')
    expect(model.form(first)!.fields.name!.value).toBe('first continued')
    renderer.runtime.dispose()
  })

  it('uses shared multi-selection and never substitutes the cursor for an empty set', async () => {
    const accepted = vi.fn()
    const { model, compile } = await setup(ui.list({ id: 'choices', role: 'choose', mode: 'multiple', selectedIds: [], items: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }], minSelected: 0 }), { action: event => {
      if (event.kind === 'selection-accept') accepted(event.selectedIds)
      return { kind: 'completed' }
    } })
    const renderer = compile()
    renderer.input('\r')
    await flush()
    expect(accepted).toHaveBeenLastCalledWith([])
    renderer.input(' ')
    renderer.input('\x1b[B')
    renderer.input(' ')
    renderer.input('\r')
    await flush()
    expect(accepted).toHaveBeenLastCalledWith(['a', 'b'])
    expect(model.choice({ pagePath: [], controlId: 'choices' })!.focusedId).toBe('b')
    renderer.runtime.dispose()
  })

  it('presents one default-No confirmation instead of an inline second-Enter state', async () => {
    const action = vi.fn()
    const { model, compile } = await setup(ui.actions({ id: 'actions', items: [{ id: 'remove', label: 'Remove', confirm: 'Remove configuration?' }] }), { action: event => {
      if (event.kind === 'activate') action()
      return { kind: 'completed' }
    } })
    let renderer = compile()
    renderer.input('\r')
    expect(action).not.toHaveBeenCalled()
    expect(model.decisionNode).toBeDefined()
    renderer.runtime.dispose()
    renderer = compile()
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'mayfly.decision.no' })
    renderer.input('\r')
    expect(model.decisionNode).toBeUndefined()
    expect(action).not.toHaveBeenCalled()
    renderer.runtime.dispose()
  })

  it('uses the same choice reducer for field pickers and preserves their drafts across renderer rebuild', async () => {
    const { compile, model } = await setup(ui.form({ id: 'form', fields: [
      { kind: 'select', id: 'one', label: 'Protocol', value: null, options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] },
      { kind: 'multiselect', id: 'many', label: 'Levels', value: [], minSelected: 1, options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
    ], submitActionId: 'save' }))
    let renderer = compile()
    renderer.input('\r')
    renderer.input('\x1b[B')
    renderer.input('\x1b[A')
    renderer.input('\x1b[B')
    expect(renderer.compiled.component.render(80).join('\n')).toContain('Beta')
    renderer.input('\r')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.one!.value).toBe('b')
    renderer.input('\t')
    renderer.input('\r')
    expect(renderer.compiled.component.render(80).join('\n')).toContain('Select at least')
    renderer.input(' ')
    renderer.input('\x1b[B')
    renderer.runtime.dispose()
    renderer = compile()
    renderer.input(' ')
    renderer.input('\r')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.many!.value).toEqual(['low', 'high'])
    renderer.input('\r')
    renderer.input(' ')
    renderer.input('\x1b')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.many!.value).toEqual(['low', 'high'])
    renderer.runtime.dispose()
  })

  it('cycles a select with left and right while up and down keep navigating fields', async () => {
    const { compile, model } = await setup(ui.form({ id: 'form', fields: [
      { kind: 'select', id: 'effort', label: 'Thinking effort', value: 'default', options: [
        { id: 'default', label: 'Provider default' }, { id: 'low', label: 'low' }, { id: 'off', label: 'off', disabled: true }, { id: 'high', label: 'high' },
      ] },
      { kind: 'select', id: 'unset', label: 'Unset', value: null, options: [{ id: 'first', label: 'First' }, { id: 'last', label: 'Last' }] },
    ] }))
    const value = (field: string) => model.form({ pagePath: [], formId: 'form' })!.fields[field]!.value
    const renderer = compile()
    renderer.compiled.component.render(80)
    renderer.input('\x1b[C')
    expect(value('effort')).toBe('low')
    renderer.input('\x1b[C')
    expect(value('effort')).toBe('high')
    renderer.input('\x1b[C')
    expect(value('effort')).toBe('high')
    renderer.input('\x1b[B')
    expect(value('effort')).toBe('high')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'unset' })
    renderer.input('\x1b[C')
    expect(value('unset')).toBe('first')
    model.updateForm({ pagePath: [], formId: 'form' }, { kind: 'edit', fieldId: 'unset', value: null })
    renderer.input('\x1b[D')
    expect(value('unset')).toBe('last')
    renderer.input('\x1b[A')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'effort' })
    renderer.runtime.dispose()
  })

  it('opens a multiselect picker only on request and commits its toggles on Tab', async () => {
    const { compile, model } = await setup(ui.form({ id: 'form', fields: [
      { kind: 'multiselect', id: 'efforts', label: 'Efforts', value: [], options: [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }] },
      { kind: 'input', id: 'tail', label: 'Tail', value: '' },
    ] }))
    const renderer = compile()
    renderer.input('\x1b[B')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'tail' })
    renderer.input('\x1b[A')
    renderer.input(' ')
    expect(renderer.compiled.component.render(80).at(-1)).toContain('Space toggle')
    renderer.input(' ')
    renderer.input('\x1b[B')
    renderer.input(' ')
    renderer.input('\t')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.efforts!.value).toEqual(['low', 'high'])
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'tail' })
    renderer.runtime.dispose()
  })

  it('keeps form focus navigable while arrows adjust a select', async () => {
    const { compile, model } = await setup(ui.form({ id: 'form', fields: [
      { kind: 'input', id: 'name', label: 'Name', value: '' },
      { kind: 'select', id: 'mode', label: 'Mode', value: 'a', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { kind: 'input', id: 'tail', label: 'Tail', value: '' },
    ] }))
    const renderer = compile()
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'name' })
    expect(renderer.runtime.state.editingKey).toBeUndefined()
    renderer.input('\x1b[Z')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'name' })
    renderer.input('\x1b[B')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'mode' })
    renderer.input('\x1b[C')
    renderer.input('\t')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.mode!.value).toBe('b')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'tail' })
    renderer.input('\x1b[Z')
    renderer.input('\x1b[Z')
    renderer.input('\r')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'name', editing: true })
    renderer.input('\x1b\r')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.name!.value).toBe('')
    renderer.input('Ada')
    renderer.input('\r')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.name!.value).toBe('Ada')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'mode' })
    renderer.input('\x1b[C')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.mode!.value).toBe('b')
    renderer.runtime.dispose()
  })

  it('renders an authoritative conflict without forcing the focused field into editing', async () => {
    const form = (value: string, error?: string) => ui.form({ id: 'form', fields: [{ kind: 'input' as const, id: 'name', label: 'Name', value, ...(error === undefined ? {} : { error }) }] })
    const { compile, handle, model } = await setup(form('source', 'Server error'))
    const renderer = compile()
    expect(renderer.compiled.component.render(80).join('\n')).toContain('Server error')
    renderer.input('draft')
    handle.set(form('remote'), { reason: 'data' })
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.name).toMatchObject({ value: 'sourcedraft', conflict: true })
    expect(renderer.compiled.component.render(80).join('\n')).toContain('Resolve the changed value before saving')
    renderer.runtime.dispose()
  })

  it('labels Escape as back while editing a field on a returnable page', async () => {
    const { compile } = await setup(ui.stack.column([
      ui.tabs({ id: 'pages', activeId: 'two', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two', backId: 'one' }] }),
      ui.child(ui.text('First'), { tab: { controlId: 'pages', itemId: 'one' } }),
      ui.child(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] }), { tab: { controlId: 'pages', itemId: 'two' } }),
    ]))
    const renderer = compile()
    renderer.input('\r')
    renderer.input('\r')
    expect(renderer.compiled.component.render(120).at(-1)).toContain('Esc done')
    renderer.input('\x1b')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'name' })
    expect(renderer.compiled.component.render(120).at(-1)).toContain('Esc back')
    renderer.runtime.dispose()
  })

  it('accepts the row the cursor shows after moving past a disabled tail', async () => {
    const accepted: string[] = []
    const { compile } = await setup(ui.list({ id: 'presets', role: 'choose', numbered: true, selectedIds: [], items: [
      { id: 'read-only', label: 'Read only' },
      { id: 'workspace', label: 'Workspace' },
      { id: 'custom', label: 'Custom', disabled: true },
    ] }), { action: event => { if (event.kind === 'selection-accept') accepted.push(event.selectedIds[0]!); return { kind: 'completed' } } })
    const renderer = compile()
    renderer.input('\x1b[F')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'presets', itemId: 'workspace' })
    renderer.input('\x1b[B')
    renderer.input('\r')
    await vi.waitFor(() => expect(accepted).toEqual(['workspace']))
    renderer.input('3')
    renderer.input('9')
    await flush()
    expect(accepted).toEqual(['workspace'])
    renderer.runtime.dispose()
  })

  it('moves to a numbered decision without accepting it when digits only focus', async () => {
    const accepted: string[] = []
    const { compile } = await setup(ui.list({ id: 'decision', role: 'choose', numbered: 'focus', selectedIds: ['reject'], items: [
      { id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' },
    ] }), { action: event => { if (event.kind === 'selection-accept') accepted.push(event.selectedIds[0]!); return { kind: 'completed' } } })
    const renderer = compile()
    expect(renderer.compiled.component.render(80).join('\n')).toContain('1. Approve')
    expect(renderer.compiled.component.render(80).at(-1)).toContain('1-2 focus')
    renderer.input('1')
    await flush()
    expect(accepted).toEqual([])
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ itemId: 'approve' })
    renderer.input('\r')
    await vi.waitFor(() => expect(accepted).toEqual(['approve']))
    renderer.runtime.dispose()
  })

  it('opens and closes tree branches with right and left', async () => {
    const { compile, model } = await setup(ui.list({ id: 'tree', role: 'browse', tree: true, selectedIds: [], items: [
      { id: 'root', label: 'Root' }, { id: 'leaf', label: 'Leaf', parentId: 'root' }, { id: 'other', label: 'Other' },
    ] }))
    const expanded = () => model.choice({ pagePath: [], controlId: 'tree' })!.expandedIds
    const renderer = compile()
    renderer.input('\x1b[D')
    expect(expanded()).toEqual([])
    renderer.input('\x1b[C')
    expect(expanded()).toEqual(['root'])
    renderer.input('\x1b[C')
    expect(expanded()).toEqual(['root'])
    renderer.input('\x1b[B')
    renderer.input('\x1b[C')
    expect(expanded()).toEqual(['root'])
    renderer.input('\x1b[A')
    renderer.input('\x1b[D')
    expect(expanded()).toEqual([])
    renderer.input(' ')
    expect(expanded()).toEqual(['root'])
    renderer.runtime.dispose()
  })

  it('ignores Space in a multiselect picker with nothing to focus', async () => {
    const { compile, model } = await setup(ui.form({ id: 'form', fields: [{ kind: 'multiselect', id: 'none', label: 'None', value: [], options: [] }] }))
    const renderer = compile()
    renderer.input('\r')
    renderer.input(' ')
    renderer.input('\r')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.none!.value).toEqual([])
    renderer.runtime.dispose()
  })

  it('keeps modifier accelerators live while filtering and printable keys in the query', async () => {
    const activated: string[] = []
    const { compile, model } = await setup(ui.stack.column([
      ui.list({ id: 'models', role: 'browse', filterable: true, selectedIds: [], items: [{ id: 'alpha', label: 'alpha' }, { id: 'beta', label: 'beta' }] }),
      ui.actions({ id: 'actions', items: [{ id: 'session', label: 'Use for this session', key: 'alt+enter', selections: [{ pagePath: [], controlId: 'models' }] }] }),
    ]), { action: event => { if (event.kind === 'activate') activated.push(`${event.actionId}:${event.inputs?.selections?.[0]?.selectedIds.join()}`); return { kind: 'completed' } } })
    const renderer = compile()
    const choice = () => model.choice({ pagePath: [], controlId: 'models' })!
    renderer.input('\x7f')
    expect(choice().searching).toBe(false)
    renderer.input('b')
    expect(choice()).toMatchObject({ searching: true, query: 'b', focusedId: 'beta' })
    expect(renderer.compiled.component.render(120).at(-1)).toContain('Esc end search')
    renderer.input('\x1b\r')
    await vi.waitFor(() => expect(activated).toEqual(['session:beta']))
    renderer.input('\x1b')
    expect(choice()).toMatchObject({ searching: false, query: 'b' })
    expect(renderer.compiled.component.render(120).at(-1)).toContain('Esc close')
    renderer.runtime.dispose()
  })

  it('treats Ctrl+C as the outermost Escape, including the dirty-form confirmation', async () => {
    const { compile, model } = await setup(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] }))
    const renderer = compile()
    renderer.input('draft')
    renderer.input('\x03')
    expect(model.decisionNode).toMatchObject({ title: 'Discard unsaved changes?' })
    renderer.runtime.dispose()
  })

  it('toggles a multi-select row with Space even while its filter is being typed', async () => {
    const { compile, model } = await setup(ui.list({ id: 'models', role: 'choose', mode: 'multiple', filterable: true, selectedIds: [], items: [
      { id: 'gpt-a', label: 'gpt a' }, { id: 'gpt-b', label: 'gpt b' }, { id: 'other', label: 'other' },
    ] }))
    const renderer = compile()
    renderer.input('gpt')
    renderer.input(' ')
    const choice = model.choice({ pagePath: [], controlId: 'models' })!
    expect(choice).toMatchObject({ query: 'gpt', searching: true, selectedIds: ['gpt-a'] })
    renderer.runtime.dispose()
  })

  it('numbers visible rows from the top of the collection while the window scrolls', async () => {
    const { compile, viewport } = await setup(ui.list({ id: 'levels', role: 'choose', numbered: true, selectedIds: [], items: Array.from({ length: 9 }, (_, index) => ({ id: `level-${String(index + 1)}`, label: `Level ${String(index + 1)}` })) }))
    viewport.rows = 4
    const renderer = compile()
    renderer.input('\x1b[F')
    const rows = renderer.compiled.component.render(40).join('\n')
    expect(rows).toContain('9. Level 9')
    expect(rows).not.toContain('1. Level 9')
    expect(renderer.compiled.component.render(80).at(-1)).toContain('1-9 choose')
    renderer.runtime.dispose()
  })

  it('skips an empty choose list when restoring focus after wizard navigation', async () => {
    const { compile, model } = await setup(ui.stack.column([
      ui.tabs({ id: 'pages', mode: 'wizard', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.child(ui.stack.column([
        ui.form({ id: 'a', fields: [
          { kind: 'input', id: 'x', label: 'X', value: '' },
          { kind: 'input', id: 'y', label: 'Y', value: '' },
        ] }),
        ui.form({ id: 'b', fields: [{ kind: 'input', id: 'z', label: 'Z', value: '' }] }),
        ui.actions({ id: 'nav', items: [{ id: 'next', label: 'Next', read: [
          { pagePath: [{ controlId: 'pages', itemId: 'one' }], formId: 'a' },
          { pagePath: [{ controlId: 'pages', itemId: 'one' }], formId: 'b' },
        ], navigate: [{ controlId: 'pages', itemId: 'two' }] }] }),
      ]), { tab: { controlId: 'pages', itemId: 'one' } }),
      ui.child(ui.stack.column([
        ui.list({ id: 'empty', role: 'choose', selectedIds: [], filter: 'nomatch', items: [{ id: 'x', label: 'X', disabled: true }] }),
        ui.form({ id: 'c', fields: [{ kind: 'input', id: 'w', label: 'W', value: '' }] }),
      ]), { tab: { controlId: 'pages', itemId: 'two' } }),
    ]))
    const renderer = compile()
    renderer.compiled.component.render(80)
    model.invoke('next', [{ controlId: 'pages', itemId: 'one' }])
    expect(model.activeTab({ pagePath: [], controlId: 'pages' })).toBe('two')
    expect(model.completedSteps({ pagePath: [], controlId: 'pages' })).toEqual(['one'])
    expect(model.focus).toMatchObject({ pagePath: [{ controlId: 'pages', itemId: 'two' }], controlId: 'w' })
    renderer.runtime.dispose()
  })

  it('pins the chrome frame of a surface root and compiles empty-node actions', async () => {
    const { compile, model, viewport } = await setup(ui.surface({ chrome: 'surface', title: 'Panel', child: ui.stack.column([
      ...Array.from({ length: 30 }, (_, index) => ui.text(`row ${index}`)),
      ui.empty({ title: 'Nothing', actions: ui.actions({ id: 'acts', items: [{ id: 'retry', label: 'Retry' }] }) }),
    ]) }))
    viewport.rows = 3
    const renderer = compile()
    const frame = renderer.compiled.component.render(80)
    expect(frame.at(0)).toContain('Panel')
    expect(frame.length).toBeLessThanOrEqual(3)
    model.invoke('retry')
    expect(model.feedback).toBeUndefined()
    renderer.runtime.dispose()
  })

  it('handles textarea newlines, pending fields, disabled options, and select Tab commits', async () => {
    const view = ui.form({ id: 'form', fields: [
      { kind: 'textarea', id: 'notes', label: 'Notes', value: '' },
      { kind: 'select', id: 'mode', label: 'Mode', value: 'a', options: [
        { id: 'a', label: 'A' },
        { id: 'disabled', label: 'Disabled', disabled: true },
        { id: 'c', label: 'C' },
      ] },
      { kind: 'input', id: 'tail', label: 'Tail', value: '' },
    ] })
    const { compile, model } = await setup(view)
    const renderer = compile()
    renderer.input('line')
    renderer.input('\x1b\r')
    renderer.input('\r')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.notes!.value).toBe('line\n\n')
    model.updateForm({ pagePath: [], formId: 'form' }, { kind: 'submit', operationId: 'manual' })
    renderer.input('ignored')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.notes!.value).toBe('line\n\n')
    model.updateForm({ pagePath: [], formId: 'form' }, { kind: 'release', operationId: 'manual' })
    renderer.input('\t')
    renderer.input('\r')
    renderer.input('\x1b[C')
    renderer.input('\r')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.mode!.value).toBe('c')
    renderer.input('\x1b[D')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.mode!.value).toBe('a')
    renderer.input('\r')
    renderer.input('\x1b[B')
    renderer.input('x')
    renderer.input('\t')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.mode!.value).toBe('c')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'tail' })
    renderer.compiled.focusTarget!.restoreFocusIdentity?.({ pagePath: [], controlId: 'mode' })
    const key = renderer.runtime.state.activeKey!
    renderer.runtime.state.setEditing(key)
    renderer.input('\x1b[C')
    renderer.runtime.dispose()
  })

  it('executes inherited field tools only on Enter or Space', async () => {
    const { compile, model } = await setup(ui.form({ id: 'form', fields: [
      { kind: 'input', id: 'name', label: 'Name', value: 'base', origin: 'inherited', resetValue: 'base' },
    ] }))
    const renderer = compile()
    expect(renderer.compiled.component.render(80).join('\n')).toContain('Set override')
    expect(renderer.runtime.state.controls().map(control => ({ kind: control.kind, identity: control.identity }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'field-action', identity: expect.objectContaining({ itemId: 'override' }) }),
    ]))
    expect(renderer.compiled.focusTarget!.restoreFocusIdentity?.({ pagePath: [], controlId: 'name', itemId: 'override' })).toBe(true)
    expect(renderer.compiled.component.render(80).at(-1)).toContain('Enter apply')
    expect(renderer.compiled.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'name', itemId: 'override' })
    renderer.input('x')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.name!.change).toBe('unchanged')
    renderer.input('\r')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.name!.change).toBe('set')
    renderer.runtime.dispose()
  })

  it('ignores Alt+Enter in a single-line field', async () => {
    const { compile, model } = await setup(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] }))
    const renderer = compile()
    renderer.input('\x1b\r')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.name!.value).toBe('')
    renderer.runtime.dispose()
  })

  it('sorts concurrent feedback and renders warning and informational severity', async () => {
    const { compile, model } = await setup(ui.actions({ id: 'actions', items: [
      { id: 'info', label: 'Info' },
      { id: 'warning', label: 'Warning' },
      { id: 'error', label: 'Error' },
    ] }), { action: event => ({
      kind: 'completed',
      feedback: { severity: event.kind === 'activate' ? event.actionId as 'info' | 'warning' | 'error' : 'info', message: event.kind === 'activate' ? event.actionId : 'info' },
    }) })
    const renderer = compile()
    model.invoke('info')
    await flush()
    expect(renderer.compiled.component.render(80).at(-1)).toContain('info')
    model.invoke('warning')
    await flush()
    expect(renderer.compiled.component.render(80).at(-1)).toContain('warning')
    model.invoke('error')
    await flush()
    expect(renderer.compiled.component.render(80).at(-1)).toContain('error')
    expect(model.feedbackSnapshot()).toHaveLength(3)
    renderer.runtime.dispose()
  })

  it('keeps Save reachable in a short viewport and renders failed-operation feedback while the form stays open', async () => {
    const { compile, viewport, model } = await setup(ui.form({ id: 'form', fields: Array.from({ length: 8 }, (_, index) => ({ kind: 'input' as const, id: `field-${index}`, label: `Field ${index}`, value: '' })), submitActionId: 'save', cancelActionId: 'cancel' }), { action: event => event.kind === 'submit' ? { kind: 'failed', message: 'Settings are unavailable' } : { kind: 'completed' } })
    viewport.rows = 4
    const renderer = compile()
    renderer.input('draft')
    for (let index = 0; index < 8; index += 1) renderer.input('\t')
    expect(renderer.compiled.component.render(80).join('\n')).toContain('save')
    renderer.input('\r')
    await flush()
    const rows = renderer.compiled.component.render(80)
    expect(rows.length).toBeLessThanOrEqual(4)
    expect(rows.join('\n')).toContain('Settings are unavailable')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields['field-0']!.value).toBe('draft')
    renderer.runtime.dispose()
  })

  it('keeps a framed long form intact while its focus window moves down and back up', async () => {
    const { compile, viewport } = await setup(ui.surface({ title: 'Long form', chrome: 'overlay', child: ui.form({
      id: 'form', fields: Array.from({ length: 8 }, (_, index) => ({ kind: 'input' as const, id: `field-${index}`, label: `Field ${index}`, value: '' })),
    }) }))
    viewport.rows = 5
    const renderer = compile()
    for (let index = 0; index < 7; index += 1) {
      renderer.input('\x1b[B')
      renderer.compiled.component.render(80)
    }
    expect(renderer.compiled.component.render(80).join('\n')).toContain('Field 7')
    for (let index = 0; index < 7; index += 1) renderer.input('\x1b[A')
    const rows = renderer.compiled.component.render(80)
    expect(rows[0]).toMatch(/^╭ Long form/u)
    expect(rows.join('\n')).toContain('Field 0')
    expect(rows.at(-1)).toMatch(/^╰/u)
    renderer.runtime.dispose()
  })

  it.each([20, 40, 80, 160])('keeps typed fields and errors within %i columns', async width => {
    const { compile, viewport, model } = await setup(ui.form({ id: 'form', fields: [
      { kind: 'number', id: 'count', label: 'Context window', value: 1000, min: 1, unit: 'tokens' },
      { kind: 'multiselect', id: 'levels', label: 'Reasoning levels', value: [], options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
    ], submitActionId: 'save', cancelActionId: 'cancel' }))
    viewport.columns = width
    viewport.rows = 10
    const renderer = compile()
    const before = model.inspect()
    const rows = renderer.compiled.component.render(width)
    expect(rows.join('\n')).toContain('Context window')
    expect(rows.join('\n')).not.toContain('rejected')
    for (const line of rows) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
    expect(model.inspect()).toEqual(before)
    renderer.runtime.dispose()
  })
})
