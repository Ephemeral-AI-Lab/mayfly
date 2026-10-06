/** The optional work-counter sink: validation, compilation, painting, and measuring report into it, and nothing needs it. */
import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { compileMayflyEditorShellNode, compileMayflyStatusNode, compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { admittedListItem, validateMayflyEditorShellNode, validateMayflyStatusNode, validateMayflyUiNode } from '../../src/core/ui-validator.ts'
import { countWork, createWorkCounters } from '../../src/core/ui-work-counters.ts'
import type { MayflyEditor, MayflySemanticColors } from '../../src/core/types.ts'
import { parityComponents } from '../design/parity.ts'
import { createFakeEditor } from './fake-editor.ts'

const identity = (value: string): string => value
const colors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as MayflySemanticColors
const base = { components: parityComponents(), colors, getViewport: () => ({ columns: 60, rows: 20 }), screenMode: 'alternate' as const }

describe('countWork', () => {
  it('adds to the named counter and ignores a missing sink', () => {
    const counters = createWorkCounters()
    countWork(counters, 'rowsPainted', 3)
    countWork(counters, 'rowsPainted')
    countWork(undefined, 'rowsPainted', 9)
    expect(counters).toEqual({ nodesValidated: 0, unitsCompiled: 0, rowsPainted: 4, stringsMeasured: 0 })
  })
})

describe('validation', () => {
  it('counts every admitted node and each list item', () => {
    const counters = createWorkCounters()
    const node = ui.stack.column([ui.child(ui.text('a')), ui.child(ui.list({ id: 'l', role: 'browse', selectedIds: [], items: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] }))])
    expect(validateMayflyUiNode(node, counters).ok).toBe(true)
    expect(counters.nodesValidated).toBe(5)
    expect(validateMayflyUiNode(node).ok).toBe(true)
    expect(counters.nodesValidated).toBe(5)
  })

  it('counts a lazy list item when it is first read, and a form option as it is admitted', () => {
    const counters = createWorkCounters()
    const items = Array.from({ length: 300 }, (_, index) => ({ id: `i${String(index)}`, label: `I ${String(index)}` }))
    const result = validateMayflyUiNode(ui.list({ id: 'big', role: 'browse', selectedIds: [], items }), counters)
    expect(result.ok && result.value.kind === 'list').toBe(true)
    const before = counters.nodesValidated
    if (result.ok && result.value.kind === 'list') {
      admittedListItem(result.value.items, 7)
      expect(counters.nodesValidated).toBe(before + 1)
      admittedListItem(result.value.items, 7)
      expect(counters.nodesValidated).toBe(before + 1)
    }
    const form = createWorkCounters()
    validateMayflyUiNode(ui.form({ id: 'f', fields: [{ kind: 'select', id: 's', label: 'S', value: null, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] }), form)
    expect(form.nodesValidated).toBe(3)
  })

  it('counts the status and editor-shell entry points', () => {
    const status = createWorkCounters()
    expect(validateMayflyStatusNode(ui.stack.row([ui.child(ui.text('a')), ui.child(ui.text('b'))]), status).ok).toBe(true)
    expect(status.nodesValidated).toBe(3)
    const shell = createWorkCounters()
    expect(validateMayflyEditorShellNode({ kind: 'editor-control' }, shell).ok).toBe(true)
    expect(shell.nodesValidated).toBe(1)
  })

  it('counts a surface model that is given a sink', () => {
    const counters = createWorkCounters()
    const events = { prepare: async () => ({ reply: { kind: 'completed' as const }, publish: () => true }) }
    const model = new UiSurfaceModel('counted', { id: 'counted', node: ui.text('hello'), revision: 1, source: [], scope: { kind: 'app', targetId: 'counted' }, update: { reason: 'data' }, events, definition: { onEvent: {} } } as never, { counters })
    expect(counters.nodesValidated).toBe(1)
    model.dispose()
  })
})

describe('compilation', () => {
  it('counts the units, the painted rows, and the strings measured while compiling and painting', () => {
    const counters = createWorkCounters()
    const result = compileMayflyUiNode(ui.surface({ title: 'T', chrome: 'overlay', child: ui.stack.column([ui.child(ui.text('one')), ui.child(ui.richText([{ text: 'two' }]))]) }), { ...base, emit: () => {}, counters })
    if (!result.ok) throw new Error(result.message)
    const compiled = counters.unitsCompiled
    expect(compiled).toBeGreaterThanOrEqual(4)
    expect(counters.nodesValidated).toBe(4)
    result.value.component.render(40)
    expect(counters.rowsPainted).toBeGreaterThan(0)
    expect(counters.stringsMeasured).toBeGreaterThan(0)
    const painted = counters.rowsPainted
    result.value.component.render(40)
    expect(counters.rowsPainted).toBeGreaterThanOrEqual(painted)
  })

  it('paints a pure row once per width and counts only the miss', () => {
    const counters = createWorkCounters()
    const result = compileMayflyUiNode(ui.text('memo'), { ...base, emit: () => {}, counters })
    if (!result.ok) throw new Error(result.message)
    result.value.component.render(30)
    const first = counters.rowsPainted
    result.value.component.render(30)
    expect(counters.rowsPainted).toBe(first)
    result.value.component.render(31)
    expect(counters.rowsPainted).toBeGreaterThan(first)
  })

  it('counts status and editor-shell compilation, and accepts no sink', () => {
    const counters = createWorkCounters()
    const status = compileMayflyStatusNode(ui.stack.row([ui.child(ui.text('a')), ui.child(ui.text('b'))]), { ...base, counters })
    if (!status.ok) throw new Error(status.message)
    status.value.component.render(40)
    expect(counters.nodesValidated).toBe(3)
    expect(counters.unitsCompiled).toBeGreaterThanOrEqual(3)
    expect(compileMayflyStatusNode(ui.text('plain'), base).ok).toBe(true)
    const editor: MayflyEditor = createFakeEditor()
    const shell = compileMayflyEditorShellNode({ kind: 'editor-control' }, { ...base, emit: () => {}, editor, counters })
    expect(shell.ok).toBe(true)
    expect(counters.nodesValidated).toBe(4)
  })
})
