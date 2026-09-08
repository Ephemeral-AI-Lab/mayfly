/** Canonical compiler layout, focus, event, width, and failure containment. */
import { CURSOR_MARKER, HStack, ScrollView, stripTerminalSequences, type Component } from '@earendil-works/pi-tui'
import { renderLayoutFrame, type LayoutBox, type LayoutFrame } from '@earendil-works/pi-tui/dist/layout.js'
import { LAYOUT_NODE, type LayoutNode } from '@earendil-works/pi-tui/dist/layout-node.js'
import { describe, expect, it, vi } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import {
  MayflyUiSurfaceRuntime,
  compileMayflyEditorShellNode,
  compileMayflyStatusNode,
  compileMayflyUiSurfaceNode,
  compileMayflyUiNode,
  type MayflyEditorShellCompilerOptions,
  type MayflyStatusCompilerOptions,
  type MayflyUiCompilerOptions,
} from '../../src/core/ui-compiler.ts'
import type { MayflyComponents, MayflyEditor, MayflySemanticColors } from '../../src/core/types.ts'
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { ADVERSARIAL, expectLinesFit, SCAN_WIDTHS } from './width-scan.ts'

const identity = (value: string): string => value
const colors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as MayflySemanticColors

function createTestEditor(): MayflyEditor {
  let value = ''
  let cursor = 0
  const editor = {
    focused: false,
    onSubmit: undefined,
    onChange: undefined,
    onKey: undefined,
    disableSubmit: false,
    setSubmitBarrier: () => {},
    submit: () => { if (!editor.disableSubmit) editor.onSubmit?.(value) },
    getText: () => value,
    getExpandedText: () => value,
    setText: (text: string) => { value = text; cursor = text.length },
    renderContent: (width: number, masked = false) => {
      const shown = masked ? '•'.repeat(value.length) : value
      const row = `${shown.slice(0, cursor)}${editor.focused ? CURSOR_MARKER : ''}${shown.slice(cursor)}`
      return [truncateToWidth(row, width)]
    },
    handleInput: (data: string) => {
      if (editor.onKey?.(data) === true) return
      if (data === '\r') { if (!editor.disableSubmit) editor.onSubmit?.(value); return }
      if (data === '\x1b[D') { cursor = Math.max(0, cursor - 1); return }
      if (data === '\x1b[C') { cursor = Math.min(value.length, cursor + 1); return }
      if (data === '\x7f' || data === '\b') {
        if (cursor > 0) {
          const before = Array.from(value.slice(0, cursor))
          before.pop()
          const prefix = before.join('')
          value = `${prefix}${value.slice(cursor)}`
          cursor = prefix.length
          editor.onChange?.(value)
        }
        return
      }
      const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/u.exec(data)
      const inserted = paste?.[1] ?? (/^[^\x00-\x1f\x7f-\x9f]+$/u.test(data) ? data : '')
      if (inserted.length === 0) return
      value = `${value.slice(0, cursor)}${inserted}${value.slice(cursor)}`
      cursor += inserted.length
      editor.onChange?.(value)
    },
    addToHistory: () => {},
    getHistory: () => [],
    setBorderColor: () => {},
    setPromptSymbol: () => {},
    setBorderLabel: () => {},
    setConnectedAbove: () => {},
    setGhostHint: () => {},
    setAutocompleteProvider: () => {},
    isShowingAutocomplete: () => false,
    refreshAutocomplete: () => {},
    insertText: (text: string) => { value = `${value.slice(0, cursor)}${text}${value.slice(cursor)}`; cursor += text.length; editor.onChange?.(value) },
    render: (width: number) => editor.renderContent(width),
    invalidate: () => {},
  } as MayflyEditor
  return editor
}

const components = {
  visibleWidth,
  wrapText: wrapTextWithAnsi,
  truncateToWidth,
  createEditor: createTestEditor,
  createMarkdown: (options?: { text?: string }) => {
    let value = options?.text ?? ''
    return {
      setText: (text: string) => { value = text },
      render: (width: number) => wrapTextWithAnsi(value, width),
      invalidate: () => {},
    }
  },
} as MayflyComponents

function fixture(overrides: Partial<MayflyUiCompilerOptions> = {}): { options: MayflyUiCompilerOptions, events: unknown[], viewport: { columns: number, rows: number } } {
  const events: unknown[] = []
  const viewport = { columns: 80, rows: 20 }
  return {
    events,
    viewport,
    options: {
      components,
      colors,
      getViewport: () => viewport,
      screenMode: 'alternate',
      emit: event => events.push(event),
      ...overrides,
    },
  }
}

function compiled(value: unknown, options: MayflyUiCompilerOptions) {
  const result = compileMayflyUiNode(value, options)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

function compiledSurface(value: unknown, options: MayflyUiCompilerOptions, surfaceRuntime = new MayflyUiSurfaceRuntime()) {
  const result = compileMayflyUiSurfaceNode(value, { ...options, surfaceRuntime })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return { ...result.value, surfaceRuntime }
}

function statusOptions(overrides: Partial<MayflyStatusCompilerOptions> = {}): MayflyStatusCompilerOptions {
  return {
    components,
    colors,
    getViewport: () => ({ columns: 80, rows: 20 }),
    screenMode: 'alternate',
    ...overrides,
  }
}

function compiledStatus(value: unknown, options: MayflyStatusCompilerOptions = statusOptions()) {
  const result = compileMayflyStatusNode(value, options)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

function compiledEditorShell(value: unknown, editor: MayflyEditor, overrides: Partial<MayflyEditorShellCompilerOptions> = {}) {
  const base = fixture(overrides)
  const result = compileMayflyEditorShellNode(value, { ...base.options, editor, ...overrides })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return { ...base, result: result.value }
}

function layout(component: Component, columns: number, rows: number): LayoutFrame {
  return renderLayoutFrame(component, columns, rows, () => {})
}

function scrollViews(box: LayoutBox): ScrollView[] {
  return [...(box.scrollView === undefined ? [] : [box.scrollView]), ...box.children.flatMap(scrollViews)]
}

describe('compileMayflyUiNode', () => {
  it('compiles builders and equivalent handwritten nodes identically', () => {
    const built = ui.stack.row([ui.text('left'), ui.divider({ label: 'middle' }), ui.text('right')], { gap: 1 })
    const hand = { kind: 'stack', direction: 'row', gap: 1, children: [{ node: { kind: 'text', content: 'left' } }, { node: { kind: 'divider', label: 'middle' } }, { node: { kind: 'text', content: 'right' } }] }
    const a = fixture()
    const b = fixture()
    expect(compiled(built, a.options).component.render(60)).toEqual(compiled(hand, b.options).component.render(60))
  })

  it('compiles every structural node kind into width-safe rows', () => {
    const tree = ui.stack.column([
      ui.fields([{ label: 'field', value: [{ text: 'value' }] }]),
      ui.code('const x = 1'),
      ui.diff('before', 'after'),
      ui.sections([{ title: 'section', body: ui.text('body') }]),
      ui.richText([
        { text: 'rich', styles: ['strong'] },
        { text: ' italic', styles: ['italic'] },
        { text: ' strike', styles: ['strike'] },
      ]),
      ui.surface({ title: 'surface', child: ui.text('child'), footer: ui.text('footer') }),
      ui.tabs({ id: 'tabs', activeId: 'a', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', disabled: true }] }),
      ui.list({ id: 'list', role: 'browse', selectedIds: ['a'], items: [{ id: 'a', label: 'A' }] }),
      ui.form({ id: 'form', fields: [{ kind: 'secret', id: 'secret', label: 'Secret', value: 'value' }, { kind: 'toggle', id: 'toggle', label: 'Toggle', value: false }] }),
      ui.actions({ id: 'actions', items: [{ id: 'go', label: 'Go' }] }),
      ui.loader({ message: 'load', variant: 'braille', elapsedMs: 3, cancelActionId: 'cancel' }),
      ui.empty({ title: 'empty', description: 'description' }),
      ui.progress({ value: 1, max: 2 }),
      ui.spacer(),
      ui.divider(),
      ui.markdown('| A | B |\n| - | - |'),
      ui.diagram('graph LR; A --> B'),
      ui.chart({ chart: 'line', series: [{ id: 'series', points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }] }),
      ui.chart({ chart: 'sparkline', values: [1, 3, 2] }),
    ])
    const { options } = fixture()
    const result = compiled(tree, options)
    for (const width of [1, 2, 5, 20, 80]) {
      expect(result.component.render(width).every(row => visibleWidth(row.replaceAll(CURSOR_MARKER, '')) <= width)).toBe(true)
    }
    expect(result.focusTarget).not.toBeNull()
    result.component.invalidate()
  })

  it('routes document formats through the shared Markdown adapter', () => {
    const sources: string[] = []
    const markdownComponents = {
      ...components,
      createMarkdown: (options?: { text?: string }) => {
        sources.push(options?.text ?? '')
        return { setText: () => {}, render: () => ['document'], invalidate: () => {} }
      },
    } as MayflyComponents
    expect(compiled(ui.markdown('# Heading'), fixture({ components: markdownComponents }).options).component.render(20)).toEqual(['document'])
    expect(compiled(ui.diagram('graph TD\nA --> B'), fixture({ components: markdownComponents }).options).component.render(20)).toEqual(['document'])
    expect(compiled(ui.diagram('graph TD\nA[```] --> B'), fixture({ components: markdownComponents }).options).component.render(20)).toEqual(['document'])
    expect(sources[0]).toBe('# Heading')
    expect(sources[1]).toBe('```mermaid\ngraph TD\nA --> B\n```')
    expect(sources[2]).toBe('````mermaid\ngraph TD\nA[```] --> B\n````')
  })

  it('keeps complete wrapped leaf content in main mode', () => {
    const { options } = fixture({ screenMode: 'main' })
    const result = compiled(ui.richText([{ text: 'abcdefghij' }]), options)
    const rows = result.component.render(2)
    expect(rows).toEqual(['ab', 'cd', 'ef', 'gh', 'ij'])
    expect(rows.every(row => visibleWidth(row) <= 2)).toBe(true)
    expect(compiled(ui.stack.column([ui.text('abcdefgh'), ui.text('ok')]), options).component.render(2))
      .toEqual(['ab', 'cd', 'ef', 'gh', 'ok'])
  })

  it('keeps all renderer-owned Markdown rows', () => {
    const invalidate = vi.fn()
    const markdownComponents = {
      ...components,
      createMarkdown: () => ({
        setText: () => {},
        render: () => ['heading', 'list', 'fence', 'tail'],
        invalidate,
      }),
    } as MayflyComponents
    const result = compiled(ui.markdown('# heading\n- list\n```ts\nfence\n```'), fixture({ components: markdownComponents }).options)
    expect(result.component.render(20)).toEqual(['heading', 'list', 'fence', 'tail'])
    result.component.invalidate()
    expect(invalidate).toHaveBeenCalledOnce()
  })

  it('contains renderer-owned Markdown failures at the selected text leaf', () => {
    const markdownComponents = {
      ...components,
      createMarkdown: () => ({
        setText: () => {},
        render: () => { throw new Error('markdown failed') },
        invalidate: () => {},
      }),
    } as MayflyComponents
    const error = compiled(ui.markdown('# heading'), fixture({ components: markdownComponents }).options)
    expect(error.component.render(20).join('')).toContain('markdown failed')

    const unknownComponents = {
      ...components,
      createMarkdown: () => ({
        setText: () => {},
        render: () => { throw 'markdown failed' },
        invalidate: () => {},
      }),
    } as MayflyComponents
    const unknown = compiled(ui.markdown('# heading'), fixture({ components: unknownComponents }).options)
    expect(unknown.component.render(20).join('')).toContain('unknown')
  })

  it('renders all surface chrome content, rich emphasis, and explicit stack sizing', () => {
    const { options } = fixture()
    const tree = ui.stack.row([
      ui.child(ui.surface({ title: 'Title', subtitle: 'Subtitle', badges: [{ text: 'Badge', styles: ['strong'] }], padding: 1, child: ui.richText([{ text: 'Body', styles: ['strong'] }]), footer: ui.text('Footer') }), { basis: 'auto', grow: 1, shrink: 0, minSize: 2, maxSize: 100 }),
      ui.child(ui.text('hidden'), { when: { maxWidth: 10, minHeight: 30 } }),
    ], { align: 'end' })
    const rows = compiled(tree, options).component.render(80)
    expect(rows.join('\n')).toContain('Title')
    expect(rows.join('\n')).toContain('Subtitle')
    expect(rows.join('\n')).toContain('Badge')
    expect(rows.join('\n')).toContain('Body')
    expect(rows.join('\n')).toContain('Footer')
    expect(rows.join('\n')).not.toContain('hidden')
  })

  it('renders overlay chrome as one closed core-owned frame at wide and degenerate widths', () => {
    const overlay = compiled(ui.surface({
      chrome: 'overlay',
      title: 'Details',
      padding: 1,
      child: ui.text('body'),
    }), fixture().options)
    expect(overlay.component.render(20)).toEqual([
      '╭ Details ─────────╮',
      '│ body             │',
      '╰──────────────────╯',
    ])
    expect(overlay.component.render(8)).toEqual([
      '╭ Det ─╮',
      '│ body │',
      '╰──────╯',
    ])
    expect(() => overlay.component.invalidate()).not.toThrow()

    const degenerate = compiled(ui.surface({ chrome: 'overlay', title: 'Details', padding: 2, child: ui.text('x') }), fixture().options)
    expect(degenerate.component.render(2)).toEqual(['x'])
    expect(degenerate.component.render(1)).toEqual(['x'])
    expect(degenerate.component.render(Number.NaN)).toEqual(['x'])
  })

  it('preserves nested layout and scroll semantics inside closed overlay chrome', () => {
    const content = ui.stack.column(Array.from({ length: 10 }, (_, index) => ui.text(`line-${String(index)}`)))
    const overlay = compiled(ui.surface({
      chrome: 'overlay',
      title: 'Scrollable',
      padding: 1,
      child: ui.scroll(content, { scrollbar: true }),
    }), fixture({ getViewport: () => ({ columns: 20, rows: 5 }) }).options)
    const frame = layout(overlay.component as Component, 20, 5)

    expect(frame.lines[0]).toMatch(/^╭ Scrollable ─+╮$/u)
    expect(frame.lines.at(-1)).toBe('╰──────────────────╯')
    expect(frame.lines.map(stripTerminalSequences).slice(1, -1).every(row => /^│.*│$/u.test(row))).toBe(true)
    expect(scrollViews(frame.root)).toHaveLength(1)
    expect(frame.lines).toHaveLength(5)
    for (const width of [1, 2]) {
      const narrow = layout(overlay.component as Component, width, 5).lines
      expectLinesFit('closed overlay layout', narrow, width)
      expect(narrow.join('')).toContain('l')
    }
  })

  it('lays out alternate scroll with real start/end state and unwraps it in main mode', () => {
    const content = ui.stack.column(Array.from({ length: 10 }, (_, index) => ui.text(`line-${String(index)}`)))
    for (const follow of ['none', 'start'] as const) {
      const result = compiled(ui.scroll(content, { follow, scrollbar: true }), fixture().options)
      const frame = layout(result.component as Component, 20, 3)
      const [scroll] = scrollViews(frame.root)
      expect(frame.lines).toEqual(['line-0', 'line-1', 'line-2'])
      expect(scroll).toMatchObject({ primary: false, overscroll: 'contain', scrollTop: 0, viewportHeight: 3 })
    }

    const end = compiled(ui.scroll(content, { follow: 'end', scrollbar: true }), fixture().options)
    const endFrame = layout(end.component as Component, 20, 3)
    const [endScroll] = scrollViews(endFrame.root)
    expect(endFrame.lines).toEqual(['line-7', 'line-8', 'line-9'])
    expect(endScroll).toMatchObject({ primary: false, overscroll: 'contain', scrollTop: 7, viewportHeight: 3 })

    const mainFixture = fixture({ screenMode: 'main' })
    const main = compiled(ui.scroll(content, { follow: 'end' }), mainFixture.options)
    expect((main.component as unknown as { root: unknown }).root).not.toBeInstanceOf(ScrollView)
    expect(main.component.render(20)).toHaveLength(10)
  })

  it('leaves passive main-mode scrolling to the outer transcript viewport', () => {
    const result = compiled(ui.scroll(ui.text('abcdefgh')), fixture({ screenMode: 'main' }).options)
    expect(result.focusTarget).toBeNull()
    expect(result.component.render(2)).toEqual(['ab', 'cd', 'ef', 'gh'])
  })

  it('keeps a hidden scroll ready for deferred admission without rendering rows', () => {
    const result = compiled(ui.stack.column([
      ui.child(ui.scroll(ui.text('hidden')), { when: { minWidth: 100 } }),
    ]), fixture({ getViewport: () => ({ columns: 40, rows: 10 }) }).options)
    expect(result.focusTarget).not.toBeNull()
    expect(result.component.render(40)).toEqual([])
  })

  it('passes stack-allocated height to a nested scroll', () => {
    const content = ui.stack.column(Array.from({ length: 10 }, (_, index) => ui.text(`line-${String(index)}`)))
    const tree = ui.stack.column([
      ui.child(ui.text('header'), { basis: 1, shrink: 0 }),
      ui.child(ui.scroll(content, { follow: 'end' }), { basis: 0, grow: 1, minSize: 1 }),
    ])
    const frame = layout(compiled(tree, fixture().options).component as Component, 20, 4)
    const [scroll] = scrollViews(frame.root)
    expect(frame.lines).toEqual(['header', 'line-7', 'line-8', 'line-9'])
    expect(scroll).toMatchObject({ scrollTop: 7, viewportHeight: 3, primary: false })

    const padded = compiled(ui.surface({ padding: 1, child: ui.scroll(content, { follow: 'end' }) }), fixture().options)
    const paddedFrame = layout(padded.component as Component, 20, 3)
    const [paddedScroll] = scrollViews(paddedFrame.root)
    expect(paddedFrame.lines.join('\n')).toContain('line-7')
    expect(paddedFrame.lines.join('\n')).toContain('line-9')
    expect(paddedScroll).toMatchObject({ scrollTop: 7, viewportHeight: 3, primary: false })
  })

  it('restores active groups and scroll bindings after a persistent compile failure', () => {
    const runtime = new MayflyUiSurfaceRuntime()
    const f = fixture({ getViewport: () => ({ columns: 20, rows: 3 }) })
    const first = compileMayflyUiSurfaceNode(ui.stack.column([
      ui.scroll(ui.stack.column(Array.from({ length: 8 }, (_, index) => ui.text(`line-${index}`)))),
      ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run' }] }),
    ]), { ...f.options, surfaceRuntime: runtime })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.message)
    const focus = first.value.focusTarget!
    focus.focused = true
    renderLayoutFrame(first.value.component, 20, 3, () => {})
    const identity = focus.captureFocusIdentity?.()

    const failed = compileMayflyUiSurfaceNode(ui.markdown('broken markdown'), {
      ...fixture({ components: { ...components, createMarkdown: () => { throw new Error('setup failed') } } as MayflyComponents }).options,
      surfaceRuntime: runtime,
    })
    expect(failed.ok).toBe(false)
    expect(focus.captureFocusIdentity?.()).toEqual(identity)
    focus.handleInput?.('\x1b[6~')
    expect(renderLayoutFrame(first.value.component, 20, 3, () => {}).lines.join('\n')).toContain('line-3')
    runtime.dispose()
  })

  it('degrades row stacks into MainScreen document order', () => {
    const { options } = fixture({ screenMode: 'main' })
    const result = compiled(ui.stack.row([ui.text('first'), ui.text('second'), ui.text('third')]), options)
    expect(result.component.render(20)).toEqual(['first', 'second', 'third'])
  })

  it('keeps the complete linear document in MainScreen mode', () => {
    const { options } = fixture({ screenMode: 'main', getViewport: () => ({ columns: 20, rows: 2 }) })
    const result = compiled(ui.stack.column(Array.from({ length: 30 }, (_, index) => ui.text(`line-${String(index)}`))), options)
    expect(result.component.render(20)).toHaveLength(30)
    expect(result.component.render(20).at(-1)).toBe('line-29')
  })

  it('keeps stack sizing independent of the viewport at compile time', () => {
    const current = { columns: 40, rows: 20 }
    const { options } = fixture({ getViewport: () => current })
    const result = compiled(ui.stack.row([
      ui.child(ui.divider(), { basis: 80, shrink: 0 }),
      ui.child(ui.divider(), { basis: 40, shrink: 0 }),
    ]), options)
    current.columns = 120
    expect(visibleWidth(result.component.render(120)[0]!)).toBe(120)
  })

  it('uses one roving focus target, skips disabled controls, and keeps Tab inside one group', () => {
    const { options, events } = fixture()
    const result = compiled(ui.actions({ id: 'actions', items: [{ id: 'one', label: 'One' }, { id: 'disabled', label: 'Disabled', disabled: true }, { id: 'three', label: 'Three' }] }), options)
    const focus = result.focusTarget!
    expect(focus).toBe(result.component)
    focus.focused = true
    expect(focus.render(40).join('')).toContain(CURSOR_MARKER)
    focus.handleInput?.('\t')
    focus.handleInput?.('\x1b[C')
    focus.handleInput?.('\r')
    expect(events).toEqual([{ kind: 'activate', pagePath: [], controlId: 'three', actionId: 'three' }])
    focus.handleInput?.('\x1b[Z')
    focus.handleInput?.('\x1b[D')
    focus.handleInput?.(' ')
    expect(events.at(-1)).toEqual({ kind: 'activate', pagePath: [], controlId: 'one', actionId: 'one' })
  })

  it('reconciles focus deterministically when a responsive child disappears', () => {
    const { options, events, viewport } = fixture()
    const tree = ui.stack.row([
      ui.child(ui.actions({ id: 'left', items: [{ id: 'left-action', label: 'Left' }] })),
      ui.child(ui.actions({ id: 'right', items: [{ id: 'right-action', label: 'Right' }] }), { when: { minWidth: 60 } }),
    ])
    const result = compiled(tree, options)
    const focus = result.focusTarget!
    focus.focused = true
    focus.render(80)
    focus.handleInput?.('\t')
    viewport.columns = 40
    focus.render(40)
    focus.handleInput?.('\r')
    expect(events).toEqual([{ kind: 'activate', pagePath: [], controlId: 'left-action', actionId: 'left-action' }])
  })

  it('evaluates every viewport boundary against the live pane snapshot', () => {
    const { options, viewport } = fixture()
    const tree = ui.stack.column([
      ui.child(ui.text('bounded'), { when: { minWidth: 70, maxWidth: 90, minHeight: 10, maxHeight: 30 } }),
    ])
    expect(compiled(tree, options).component.render(80)).toEqual(['bounded'])
    viewport.rows = 31
    expect(compiled(tree, options).component.render(80)).toEqual([])
  })

  it('uses the height allocated by the layout engine for responsive children', () => {
    const { options } = fixture({ getViewport: () => ({ columns: 80, rows: 99 }) })
    const tree = ui.stack.column([
      ui.child(ui.text('short'), { when: { maxHeight: 9 } }),
      ui.child(ui.text('tall'), { when: { minHeight: 10 } }),
    ])
    expect(layout(compiled(tree, options).component as Component, 80, 9).lines).toContain('short')
    expect(layout(compiled(tree, options).component as Component, 80, 9).lines).not.toContain('tall')
    expect(layout(compiled(tree, options).component as Component, 80, 10).lines).toContain('tall')

    const responsive = compiled(ui.stack.column([
      ui.child(ui.actions({ id: 'short-actions', items: [{ id: 'short-action', label: 'Short action' }] }), { when: { maxHeight: 9 } }),
      ui.child(ui.actions({ id: 'tall-actions', items: [{ id: 'tall-action', label: 'Tall action' }] }), { when: { minHeight: 10 } }),
    ]), options)
    responsive.focusTarget!.focused = true
    const shortFrame = layout(responsive.component as Component, 80, 9).lines.join('')
    expect(shortFrame).toContain('Short action')
    expect(shortFrame.match(new RegExp(CURSOR_MARKER, 'gu'))).toHaveLength(1)
  })

  it('retains a structural focus target when every control starts hidden', () => {
    const { options, viewport } = fixture()
    viewport.columns = 40
    const result = compiled(ui.stack.column([ui.child(ui.actions({ id: 'later', items: [{ id: 'later-action', label: 'Later' }] }), { when: { minWidth: 60 } })]), options)
    expect(result.focusTarget).not.toBeNull()
    expect(result.component.render(40).join('')).not.toContain(CURSOR_MARKER)
    viewport.columns = 80
    result.focusTarget!.focused = true
    expect(result.component.render(80).join('').match(new RegExp(CURSOR_MARKER, 'gu'))).toHaveLength(1)
    viewport.columns = 40
    expect(result.component.render(40).join('')).not.toContain(CURSOR_MARKER)
    viewport.columns = 80
    expect(result.component.render(80).join('').match(new RegExp(CURSOR_MARKER, 'gu'))).toHaveLength(1)
  })

  it('preserves the roving index across overlay-style focused false -> true', () => {
    const { options, events } = fixture()
    const focus = compiled(ui.tabs({ id: 'tabs', activeId: 'a', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }), options).focusTarget!
    focus.focused = true
    focus.handleInput?.('\x1b[C')
    focus.focused = false
    expect(focus.render(20).join('')).not.toContain(CURSOR_MARKER)
    focus.focused = true
    expect(focus.render(20).join('')).toContain(CURSOR_MARKER)
    focus.handleInput?.('\r')
    expect(events).toEqual([{ kind: 'tab-change', pagePath: [], controlId: 'tabs', tabId: 'b' }])
  })

  it('keeps TokenLedger nested-tab focus through tree and item reorder', () => {
    const runtime = new MayflyUiSurfaceRuntime()
    const f = fixture()
    const first = compileMayflyUiSurfaceNode(ui.stack.column([
      ui.tabs({ id: 'ledger-view', activeId: 'projects', items: [
        { id: 'overview', label: 'Overview' },
        { id: 'projects', label: 'Projects' },
      ] }),
      ui.surface({ child: ui.stack.column([
        ui.text('usage ledger'),
        ui.tabs({ id: 'metric-view', activeId: 'cost', items: [
          { id: 'tokens', label: 'Tokens' },
          { id: 'cost', label: 'Cost' },
        ] }),
      ]) }),
    ]), { ...f.options, surfaceRuntime: runtime })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.message)
    const stale = first.value.focusTarget!
    stale.focused = true
    first.value.component.render(80)
    stale.handleInput?.('\r')
    stale.handleInput?.('\x1b[D')

    const reordered = compileMayflyUiSurfaceNode(ui.stack.column([
      ui.surface({ child: ui.stack.column([
        ui.tabs({ id: 'metric-view', activeId: 'cost', items: [
          { id: 'cost', label: 'Cost' },
          { id: 'tokens', label: 'Tokens' },
        ] }),
        ui.text('usage ledger'),
      ]) }),
      ui.tabs({ id: 'ledger-view', activeId: 'overview', items: [
        { id: 'projects', label: 'Projects' },
        { id: 'overview', label: 'Overview' },
      ] }),
    ]), { ...f.options, surfaceRuntime: runtime })
    expect(reordered.ok).toBe(true)
    if (!reordered.ok) throw new Error(reordered.message)
    const target = reordered.value.focusTarget!
    target.focused = true
    const rows = reordered.value.component.render(80).join('')
    expect(rows.match(new RegExp(CURSOR_MARKER, 'gu'))).toHaveLength(1)
    expect(target.captureFocusIdentity?.()).toMatchObject({ controlId: 'metric-view', itemId: 'tokens' })
    target.handleInput?.('\x1b[D')
    expect(f.events).toEqual([
      { kind: 'tab-change', pagePath: [], controlId: 'metric-view', tabId: 'tokens' },
      { kind: 'tab-change', pagePath: [], controlId: 'metric-view', tabId: 'cost' },
    ])
    stale.handleInput?.('\r')
    expect(f.events).toHaveLength(2)
  })

  it('restores responsive focus by semantic id but forgets controls that are removed', () => {
    const runtime = new MayflyUiSurfaceRuntime()
    const f = fixture()
    const tree = (disabled = false) => ui.stack.column([
      ui.child(ui.tabs({ id: 'modes', activeId: 'b', items: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta', disabled },
      ] }), { when: { minWidth: 60 } }),
      ui.actions({ id: 'fallback', items: [{ id: 'fallback', label: 'Fallback' }] }),
    ])
    const first = compileMayflyUiSurfaceNode(tree(), { ...f.options, surfaceRuntime: runtime })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.message)
    const firstFocus = first.value.focusTarget!
    firstFocus.focused = true
    firstFocus.handleInput?.('\x1b[D')
    firstFocus.handleInput?.('\x1b[C')
    expect(f.events.at(-1)).toEqual({ kind: 'tab-change', pagePath: [], controlId: 'modes', tabId: 'b' })

    f.viewport.columns = 40
    first.value.component.render(40)
    firstFocus.handleInput?.('\r')
    expect(f.events.at(-1)).toEqual({ kind: 'activate', pagePath: [], controlId: 'fallback', actionId: 'fallback' })

    f.viewport.columns = 80
    first.value.component.render(80)
    expect(firstFocus.captureFocusIdentity?.()).toMatchObject({ controlId: 'modes', itemId: 'b' })

    f.viewport.columns = 40
    first.value.component.render(40)
    const removed = compileMayflyUiSurfaceNode(tree(true), { ...f.options, surfaceRuntime: runtime })
    expect(removed.ok).toBe(true)
    if (!removed.ok) throw new Error(removed.message)
    removed.value.focusTarget!.focused = true
    removed.value.component.render(40)
    removed.value.focusTarget!.handleInput?.('\r')
    expect(f.events.at(-1)).toEqual({ kind: 'activate', pagePath: [], controlId: 'fallback', actionId: 'fallback' })

    const restored = compileMayflyUiSurfaceNode(tree(), { ...f.options, surfaceRuntime: runtime })
    expect(restored.ok).toBe(true)
    if (!restored.ok) throw new Error(restored.message)
    f.viewport.columns = 80
    restored.value.component.render(80)
    restored.value.focusTarget!.focused = true
    restored.value.focusTarget!.handleInput?.('\r')
    expect(f.events.at(-1)).toEqual({ kind: 'activate', pagePath: [], controlId: 'fallback', actionId: 'fallback' })
  })

  it('does not admit a responsive subtree until it becomes visible', () => {
    const f = fixture({ screenMode: 'main' })
    f.viewport.columns = 40
    const hidden = Object.defineProperty({ kind: 'text' }, 'content', {
      enumerable: true,
      get: () => 'must not run',
    })
    const result = compiled({
      kind: 'stack',
      direction: 'column',
      children: [
        { node: { kind: 'text', content: 'always' } },
        { node: hidden, when: { minWidth: 80 } },
      ],
    }, f.options)
    result.component.invalidate()
    expect(result.component.render(40).join('\n')).toContain('always')
    expect(result.component.render(40).join('\n')).not.toContain('rejected')

    f.viewport.columns = 100
    expect(result.component.render(100).join('\n')).toContain('must be data')
    expect(result.component.render(100).join('\n')).toContain('must be data')
  })

  it('owns editor state created by a deferred responsive form', () => {
    const runtime = new MayflyUiSurfaceRuntime()
    const editors: MayflyEditor[] = []
    const f = fixture({
      screenMode: 'main',
      components: {
        ...components,
        createEditor: () => {
          const editor = createTestEditor()
          editors.push(editor)
          return editor
        },
      } as MayflyComponents,
    })
    f.viewport.columns = 40
    const result = compiledSurface(ui.stack.column([
      ui.child(ui.form({ id: 'deferred-form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] }), { when: { minWidth: 80 } }),
    ]), f.options, runtime)
    result.component.render(40)
    expect(editors).toHaveLength(0)

    f.viewport.columns = 100
    result.component.render(100)
    expect(editors).toHaveLength(1)
    runtime.admit(result.node)
    result.focusTarget!.focused = true
    result.focusTarget!.handleInput?.('\r')
    result.component.render(100)
    expect(editors[0]!.focused).toBe(true)

    runtime.dispose()
    expect(editors[0]!.focused).toBe(false)
  })

  it('fences editor callbacks and every compiled facade across runtime generations', () => {
    const runtime = new MayflyUiSurfaceRuntime()
    const editors: MayflyEditor[] = []
    const localComponents = {
      ...components,
      createEditor: () => {
        const editor = createTestEditor()
        editors.push(editor)
        return editor
      },
    } as MayflyComponents
    const f = fixture({ components: localComponents })
    const input = { kind: 'input' as const, id: 'value', label: 'Value', value: '', placeholder: 'Type here' }
    const form = ui.form({ id: 'form', fields: [input] })
    const first = compiledSurface(form, f.options, runtime)
    const focus = first.focusTarget!
    focus.focused = true
    focus.render(40)
    expect(editors).toHaveLength(1)
    const editor = editors[0]!
    editor.submit()
    focus.handleInput?.('\x00')
    focus.handleInput?.('\x1b[200~pasted\x1b[201~')
    expect(editor.getExpandedText()).toBe('pasted')
    editor.submit()
    focus.handleInput?.(' typed')
    expect(editor.getExpandedText()).toBe(' typed')
    editor.submit()
    focus.handleInput?.('\r')
    expect(focus.captureFocusIdentity?.()).toMatchObject({ controlId: 'value', editing: true })

    const staleChange = editor.onChange!
    const staleSubmit = editor.onSubmit!
    const checkpoint = runtime.checkpointEditorFocus()
    const refreshed = compileMayflyUiSurfaceNode(form, { ...f.options, surfaceRuntime: runtime })
    expect(refreshed.ok).toBe(true)
    if (!refreshed.ok) throw new Error(refreshed.message)
    refreshed.value.component.render(40)
    staleChange()
    staleSubmit('stale')
    expect(editor.getExpandedText()).toBe('')
    runtime.state.setEditing(undefined)
    editor.onSubmit?.('fresh')

    const secondForm = ui.form({ id: 'other-form', fields: [{ kind: 'input', id: 'other-value', label: 'Other', value: '' }] })
    const second = compileMayflyUiSurfaceNode(secondForm, { ...f.options, surfaceRuntime: runtime })
    expect(second).toMatchObject({ ok: true })
    if (!second.ok) throw new Error(second.message)
    second.value.component.render(40)
    expect(editors).toHaveLength(2)
    checkpoint()

    const selectForm = ui.form({ id: 'form', fields: [{ kind: 'select', id: 'value', label: 'Value', value: null, options: [] }] })
    const replaced = compileMayflyUiSurfaceNode(selectForm, { ...f.options, surfaceRuntime: runtime })
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) throw new Error(replaced.message)
    expect(editor.onChange).toBeUndefined()
    expect(editor.onSubmit).toBeUndefined()

    expect(runtime.pagePath({})).toEqual([])
    expect(runtime.search(ui.list({ id: 'search', role: 'browse', selectedIds: [], items: [] })).text).toBe('')
    const state = runtime.state
    expect(state.field(input, 'missing').value).toBe('')
    state.setValue('missing', 'ignored')
    const select = { kind: 'select' as const, id: 'select', label: 'Select', value: null, options: [] }
    state.beginSelectEditing(select, 'missing')
    expect(state.finishSelectEditing(select, 'missing', false)).toBeNull()
    const list = ui.list({ id: 'list', role: 'browse', selectedIds: [], items: [] })
    for (const movement of ['home', 'end', 'up', 'down', 'page-up', 'page-down'] as const) {
      expect(runtime.moveList(list, 0, movement, 5)).toBeUndefined()
    }

    expect(refreshed.value.focusTarget!.restoreFocusIdentity?.({ controlId: 'missing' })).toBe(false)
    runtime.deactivate()
    expect(state.controls()).toEqual([])
    expect(state.allControls()).toEqual([])
    expect(() => state.textEditor(input, 'missing')).toThrow('inactive')
    runtime.dispose()
    runtime.dispose()
    runtime.deactivate()
    expect(() => state.emit({ kind: 'dismiss', pagePath: [] })).not.toThrow()
    const stale = refreshed.value.focusTarget!
    stale.focused = true
    expect(stale.captureFocusIdentity?.()).toBeUndefined()
    expect(stale.restoreFocusIdentity?.({ controlId: 'value' })).toBe(false)
    expect((stale as unknown as { [LAYOUT_NODE](): LayoutNode })[LAYOUT_NODE]()).toEqual({ type: 'vstack', entries: [], gap: 0, align: 'stretch' })
    expect(stale.render(40)).toEqual([])
    expect(() => stale.handleInput?.('x')).not.toThrow()
    expect(() => stale.invalidate()).not.toThrow()
    const disposedCompile = compileMayflyUiSurfaceNode(form, { ...f.options, surfaceRuntime: runtime })
    expect(disposedCompile).toMatchObject({ ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION' })
  })

  it('restores the owning nested tab group by semantic identity', () => {
    const result = compiledSurface(ui.stack.column([
      ui.tabs({ id: 'outer', activeId: 'one', items: [{ id: 'one', label: 'One' }] }),
      ui.child(ui.tabs({ id: 'inner', activeId: 'a', items: [{ id: 'a', label: 'A' }] }), { tab: { controlId: 'outer', itemId: 'one' } }),
    ]), fixture().options)
    expect(result.focusTarget!.restoreFocusIdentity?.({ controlId: 'missing' })).toBe(false)
    expect(result.focusTarget!.restoreFocusIdentity?.({ controlId: 'inner', itemId: 'a', pagePath: [{ controlId: 'outer', itemId: 'one' }], tabControlId: 'inner' })).toBe(true)
    expect(result.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'inner', tabControlId: 'inner' })
  })

  it('evicts active and editor-free field kinds through the same registration key', () => {
    const runtime = new MayflyUiSurfaceRuntime()
    const editors: MayflyEditor[] = []
    const f = fixture({ components: { ...components, createEditor: () => {
      const editor = createTestEditor()
      editors.push(editor)
      return editor
    } } as MayflyComponents })
    const input = compiledSurface(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'value', label: 'Value', value: '' }] }), f.options, runtime)
    input.focusTarget!.focused = true
    input.focusTarget!.handleInput?.('\r')
    input.component.render(40)
    expect(runtime.state.editingKey).toBeDefined()
    const select = compileMayflyUiSurfaceNode(ui.form({ id: 'form', fields: [{ kind: 'select', id: 'value', label: 'Value', value: null, options: [] }] }), { ...f.options, surfaceRuntime: runtime })
    expect(select.ok).toBe(true)
    expect(editors[0]!.onChange).toBeUndefined()
    expect(runtime.state.editingKey).toBeUndefined()
    const toggle = compileMayflyUiSurfaceNode(ui.form({ id: 'form', fields: [{ kind: 'toggle', id: 'value', label: 'Value', value: false }] }), { ...f.options, surfaceRuntime: runtime })
    expect(toggle.ok).toBe(true)
    runtime.dispose()
  })

  it('ends editing when an otherwise cached field leaves the current tree', () => {
    const runtime = new MayflyUiSurfaceRuntime()
    const f = fixture()
    const input = compiledSurface(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'value', label: 'Value', value: '' }] }), f.options, runtime)
    input.focusTarget!.focused = true
    input.focusTarget!.handleInput?.('\r')
    expect(runtime.state.editingKey).toBeDefined()
    const passive = compileMayflyUiSurfaceNode(ui.text('passive'), { ...f.options, surfaceRuntime: runtime })
    expect(passive.ok).toBe(true)
    expect(runtime.state.editingKey).toBeUndefined()
    runtime.dispose()
  })

  it('renders multiline fields through finite and non-finite internal width offers', () => {
    const editor = createTestEditor()
    editor.renderContent = (width: number) => ['first', 'second'].map(row => truncateToWidth(row, width))
    const result = compiled(ui.form({ id: 'form', fields: [{ kind: 'textarea', id: 'notes', label: 'Notes', value: '' }] }), fixture({
      components: { ...components, createEditor: () => editor } as MayflyComponents,
    }).options)
    const root = (result.component as unknown as { root: Component }).root
    expect(root.render(Number.NaN)).not.toEqual([])
    expect(root.render(40).join('\n')).toContain('second')
  })

  it('contains no-interaction empty list, select, passive, and tab edge input', () => {
    const emptyFixture = fixture()
    const empty = compiledSurface(ui.list({ id: 'empty', role: 'choose', filterable: true, selectedIds: [], items: [] }), emptyFixture.options)
    empty.focusTarget!.focused = true
    expect(empty.component.render(40)).not.toEqual([])
    empty.focusTarget!.handleInput?.('/')
    empty.focusTarget!.handleInput?.('\r')
    expect(emptyFixture.events.at(-1)).toEqual({ kind: 'selection-accept', pagePath: [], controlId: 'empty', selectedIds: [] })

    const select = compiledSurface(ui.form({ id: 'form', fields: [{ kind: 'select', id: 'value', label: 'Value', value: null, options: [] }] }), fixture().options)
    select.focusTarget!.focused = true
    select.focusTarget!.handleInput?.('x')
    select.focusTarget!.handleInput?.('\r')
    select.focusTarget!.handleInput?.('x')
    select.focusTarget!.handleInput?.('\x1b[C')

    const tabs = compiledSurface(ui.tabs({ id: 'tabs', activeId: 'a', items: [{ id: 'a', label: 'A' }] }), fixture().options)
    tabs.focusTarget!.focused = true
    tabs.focusTarget!.handleInput?.('\x1b[D')
    tabs.focusTarget!.handleInput?.('\x1b')

    const passive = compiledSurface(ui.text('passive'), fixture().options)
    const facade = passive.component as unknown as { handleInput(data: string): void }
    facade.handleInput('\t')
    facade.handleInput('x')
  })

  it('falls back to declared tabs and discovers controls in deferred empty content', () => {
    const runtime = new MayflyUiSurfaceRuntime()
    Object.defineProperty(runtime, 'activeTab', { value: () => undefined })
    const tabs = compiledSurface(ui.tabs({ id: 'tabs', activeId: 'a', items: [{ id: 'a', label: 'A' }] }), fixture().options, runtime)
    expect(tabs.component.render(40).join('\n')).toContain('A')

    const f = fixture({ screenMode: 'main' })
    f.viewport.columns = 120
    const deferred = compiledSurface(ui.stack.column([
      ui.tabs({ id: 'pages', activeId: 'one', items: [{ id: 'one', label: 'One' }] }),
      ui.child(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'value', label: 'Value', value: '' }] }), {
        tab: { controlId: 'pages', itemId: 'one' }, when: { minWidth: 100 },
      }),
    ]), f.options)
    expect(deferred.component.render(120).join('\n')).toContain('Value')

    const hidden = compiledSurface(ui.list({
      id: 'empty', role: 'browse', selectedIds: [], items: [],
      empty: ui.stack.column([ui.child(ui.form({ id: 'hidden', fields: [{ kind: 'input', id: 'value', label: 'Value', value: '' }] }), { when: { minWidth: 100 } })]),
    }), fixture().options)
    expect(hidden.focusTarget).not.toBeNull()
    runtime.dispose()
    deferred.surfaceRuntime.dispose()
    hidden.surfaceRuntime.dispose()
  })

  it('deactivates a scroll binding when its responsive branch becomes hidden', () => {
    const f = fixture()
    f.viewport.columns = 120
    const result = compiledSurface(ui.stack.column([
      ui.child(ui.scroll(ui.text('document')), { when: { minWidth: 100 } }),
    ]), f.options)
    result.focusTarget!.focused = true
    result.component.render(120)
    f.viewport.columns = 40
    expect(result.component.render(40)).toEqual([])
    result.surfaceRuntime.dispose()
  })

  it('fences an editor shell focus request after its private runtime is disposed', () => {
    const shell = compiledEditorShell({ kind: 'editor-control' }, createTestEditor()).result
    const runtime = (shell.component as unknown as { surfaceRuntime: MayflyUiSurfaceRuntime }).surfaceRuntime
    runtime.dispose()
    expect(() => shell.focusTarget.focusEditor?.()).not.toThrow()
  })

  it('contains a title that exceeds the canonical surface budget', () => {
    const result = compileMayflyUiSurfaceNode(ui.text('body'), {
      ...fixture().options,
      title: 'x'.repeat(20_001),
      surfaceRuntime: new MayflyUiSurfaceRuntime(),
    })
    expect(result).toMatchObject({ ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION' })
  })

  it('falls back to the preferred sibling when the selected semantic control is removed', () => {
    const runtime = new MayflyUiSurfaceRuntime()
    const f = fixture()
    const tabs = (withBeta: boolean) => ui.tabs({ id: 'modes', activeId: 'a', items: [
      { id: 'a', label: 'Alpha' },
      ...(withBeta ? [{ id: 'b', label: 'Beta' }] : []),
    ] })
    const first = compileMayflyUiSurfaceNode(tabs(true), { ...f.options, surfaceRuntime: runtime })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.message)
    first.value.focusTarget!.handleInput?.('\x1b[C')
    const removed = compileMayflyUiSurfaceNode(tabs(false), { ...f.options, surfaceRuntime: runtime })
    expect(removed.ok).toBe(true)
    if (!removed.ok) throw new Error(removed.message)
    expect(removed.value.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'modes', itemId: 'a' })

    const firstSiblingRuntime = new MayflyUiSurfaceRuntime()
    const firstSiblingFixture = fixture()
    const selected = compileMayflyUiSurfaceNode(ui.actions({ id: 'commands', items: [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
    ] }), { ...firstSiblingFixture.options, surfaceRuntime: firstSiblingRuntime })
    expect(selected.ok).toBe(true)
    if (!selected.ok) throw new Error(selected.message)
    selected.value.focusTarget!.handleInput?.('\x1b[C')
    const firstSibling = compileMayflyUiSurfaceNode(ui.actions({ id: 'commands', items: [
      { id: 'a', label: 'Alpha' },
    ] }), { ...firstSiblingFixture.options, surfaceRuntime: firstSiblingRuntime })
    expect(firstSibling.ok).toBe(true)
    if (!firstSibling.ok) throw new Error(firstSibling.message)
    firstSibling.value.focusTarget!.handleInput?.('\r')
    expect(firstSiblingFixture.events.at(-1)).toEqual({ kind: 'activate', pagePath: [], controlId: 'a', actionId: 'a' })
  })

  it('evicts the oldest inactive field after the registration cache reaches 64 entries', () => {
    const runtime = new MayflyUiSurfaceRuntime()
    const editors: MayflyEditor[] = []
    const localComponents = {
      ...components,
      createEditor: () => {
        const editor = createTestEditor()
        editors.push(editor)
        return editor
      },
    } as MayflyComponents
    const f = fixture({ components: localComponents })
    const field = (index: number) => ui.form({ id: 'profile', fields: [{ kind: 'input' as const, id: `field-${String(index)}`, label: `Field ${String(index)}`, value: '' }] })
    const compileField = (index: number) => {
      const result = compileMayflyUiSurfaceNode(field(index), { ...f.options, surfaceRuntime: runtime })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.message)
      result.value.component.render(40)
    }

    compileField(0)
    for (let index = 1; index <= 64; index += 1) compileField(index)
    expect(editors).toHaveLength(65)
    const oldestInactiveEditor = editors[1]!
    compileField(0)
    expect(editors).toHaveLength(65)
    compileField(65)
    expect(editors).toHaveLength(66)
    expect(oldestInactiveEditor.onChange).toBeUndefined()
    compileField(0)
    expect(editors).toHaveLength(66)
    compileField(1)
    expect(editors).toHaveLength(67)
  })

  it('inserts its marker only after HStack composition', () => {
    const upstream = new HStack([], { gap: 1 })
    upstream.addChild({ render: () => [`> ${CURSOR_MARKER}alpha`], invalidate: () => {} }, { basis: 7 })
    upstream.addChild({ render: () => ['beta'], invalidate: () => {} }, { basis: 4 })
    expect(upstream.render(10).join('')).not.toContain('alpha')

    const { options } = fixture()
    const focus = compiled(ui.actions({ id: 'actions', items: [{ id: 'alpha', label: 'alpha' }, { id: 'beta', label: 'beta' }] }), options).focusTarget!
    focus.focused = true
    const row = focus.render(40).join('')
    expect(row).toContain('alpha')
    expect(row).toContain('beta')
    expect(row.match(new RegExp(CURSOR_MARKER, 'gu'))).toHaveLength(1)
  })

  it('preserves focused HStack labels in layout and subsequent direct replay', () => {
    const { options } = fixture()
    const focus = compiled(ui.actions({ id: 'actions', items: [{ id: 'alpha', label: 'alpha' }, { id: 'beta', label: 'beta' }] }), options).focusTarget!
    focus.focused = true
    const frameRow = layout(focus as Component, 40, 3).lines.join('')
    expect(frameRow).toContain('alpha')
    expect(frameRow).toContain('beta')
    expect(frameRow.match(new RegExp(CURSOR_MARKER, 'gu'))).toHaveLength(1)

    const replay = focus.render(40).join('')
    expect(replay).toContain('alpha')
    expect(replay).toContain('beta')
    expect(replay.match(new RegExp(CURSOR_MARKER, 'gu'))).toHaveLength(1)
  })

  it('restores a stacked editor cursor without adding a label cursor', () => {
    const { options } = fixture()
    const focus = compiled(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Long label '.repeat(8), value: 'VALUE' }] }), options).focusTarget!
    focus.focused = true
    focus.render(20)
    expect(focus.restoreFocusIdentity?.({ controlId: 'name', editing: true })).toBe(true)
    const rows = focus.render(20)
    expect(rows.join('').split(CURSOR_MARKER)).toHaveLength(2)
    expect(rows.find(row => row.includes(CURSOR_MARKER))).toContain('VALUE')
  })

  it('preserves one focused editor marker in layout and subsequent direct replay', () => {
    const { options } = fixture()
    const focus = compiled(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: 'alpha' }] }), options).focusTarget!
    focus.focused = true
    for (const width of [40, 2]) {
      const frame = layout(focus as Component, width, 3).lines.join('')
      expect(frame).not.toContain('\uf8ff')
      expect(frame.match(new RegExp(CURSOR_MARKER, 'gu'))).toHaveLength(1)

      const replay = focus.render(width).join('')
      expect(replay).not.toContain('\uf8ff')
      expect(replay.match(new RegExp(CURSOR_MARKER, 'gu'))).toHaveLength(1)
    }
  })

  it('cannot be tricked into extra markers by canonical user text', () => {
    const { options } = fixture()
    const focus = compiled(ui.stack.column([
      ui.text(`fake \uf8ff ${CURSOR_MARKER}`),
      ui.actions({ id: 'actions', items: [{ id: 'real', label: 'Real' }] }),
    ]), options).focusTarget!
    focus.focused = true
    expect(focus.render(40).join('').match(new RegExp(CURSOR_MARKER, 'gu'))).toHaveLength(1)
    focus.focused = false
    expect(focus.render(40).join('')).not.toContain(CURSOR_MARKER)
  })

  it('ignores unrelated keys on toggle and submit controls', () => {
    const f = fixture()
    const focus = compiled(ui.form({
      id: 'form',
      fields: [{ kind: 'toggle', id: 'enabled', label: 'Enabled', value: false }],
      submitActionId: 'Save',
    }), f.options).focusTarget!
    focus.handleInput?.('x')
    focus.handleInput?.('\x1b[B')
    focus.handleInput?.('x')
    expect(f.events).toEqual([])
  })

  it('uses rendered geometry for non-wrapping movement across control groups', () => {
    const f = fixture()
    const grid = compiled(ui.stack.column([
      ui.stack.row([
        ui.actions({ id: 'top-left', items: [{ id: 'a', label: 'A' }] }),
        ui.actions({ id: 'top-right', items: [{ id: 'b', label: 'B' }] }),
      ]),
      ui.stack.row([
        ui.actions({ id: 'bottom-left', items: [{ id: 'c', label: 'C' }] }),
        ui.actions({ id: 'bottom-right', items: [{ id: 'd', label: 'D' }] }),
      ]),
    ]), f.options).focusTarget!
    expect(grid.captureFocusIdentity?.()).toMatchObject({ controlId: 'a' })
    grid.handleInput?.('\x1b[C')
    expect(grid.captureFocusIdentity?.()).toMatchObject({ controlId: 'b' })
    grid.handleInput?.('\x1b[B')
    expect(grid.captureFocusIdentity?.()).toMatchObject({ controlId: 'd' })
    grid.handleInput?.('\x1b[D')
    expect(grid.captureFocusIdentity?.()).toMatchObject({ controlId: 'c' })
    grid.handleInput?.('\x1b[A')
    expect(grid.captureFocusIdentity?.()).toMatchObject({ controlId: 'a' })
    grid.handleInput?.('\x1b[A')
    expect(grid.captureFocusIdentity?.()).toMatchObject({ controlId: 'a' })

    const main = compiled(ui.actions({ id: 'vertical', items: [{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }] }), fixture({ screenMode: 'main' }).options).focusTarget!
    main.handleInput?.('\x1b[B')
    main.handleInput?.('\r')
    expect(main.captureFocusIdentity?.()).toMatchObject({ controlId: 'second' })

    const clippedFixture = fixture()
    clippedFixture.viewport.rows = 1
    const clipped = compiled(ui.stack.column([
      ui.actions({ id: 'visible', items: [{ id: 'visible', label: 'Visible' }] }),
      ui.actions({ id: 'clipped', items: [{ id: 'clipped', label: 'Clipped' }] }),
    ]), clippedFixture.options).focusTarget!
    clipped.handleInput?.('\x1b[B')
    expect(clipped.captureFocusIdentity?.()).toMatchObject({ controlId: 'visible' })
    expect(clipped.restoreFocusIdentity?.({ controlId: 'clipped' })).toBe(true)
    clipped.handleInput?.('\x1b[B')
    expect(clipped.captureFocusIdentity?.()).toMatchObject({ controlId: 'clipped' })
  })

  it('renders optional and disabled control variants', () => {
    const tree = ui.stack.column([
      ui.surface({ child: ui.text('bare surface') }),
      ui.scroll(ui.text('plain scroll')),
      ui.tabs({ id: 'tabs', activeId: 'a', items: [{ id: 'a', label: 'A', count: 2 }] }),
      ui.list({ id: 'disabled-list', role: 'browse', selectedIds: [], items: [{ id: 'disabled', label: 'Disabled', disabled: true, detail: 'detail', badge: 'badge' }] }),
      ui.list({ id: 'single-list', role: 'browse', selectedIds: [], items: [{ id: 'single', label: 'Single' }] }),
      ui.list({ id: 'fallback-list', role: 'browse', selectedIds: [], items: [], empty: ui.actions({ id: 'fallback', items: [{ id: 'fallback-action', label: 'Fallback' }] }) }),
      ui.form({ id: 'form', fields: [
        { kind: 'input', id: 'input', label: 'Input', value: 'value', error: 'bad', disabled: true },
        { kind: 'toggle', id: 'enabled', label: 'Enabled', value: true },
      ] }),
      ui.actions({ id: 'actions', items: [{ id: 'go', label: 'Go' }] }),
      ui.loader({ message: 'tide', variant: 'tide' }),
      ui.progress({ label: 'done', value: 1, max: 2 }),
    ])
    const alternate = compiled(tree, fixture().options)
    expect(alternate.component.render(80).join('\n')).toContain('Fallback')

    const main = compiled(tree, fixture({ screenMode: 'main' }).options)
    expect(main.component.render(80).join('\n')).toContain('done')
  })

  it('width-scans every L2 pattern with adversarial canonical content', () => {
    for (const [adversarialIndex, { name, text }] of ADVERSARIAL.entries()) {
      const suffix = String(adversarialIndex)
      const content = text.slice(0, 700)
      const tree = ui.stack.column([
        ui.surface({ chrome: 'overlay', title: content, subtitle: content, badges: [{ text: content, tone: 'warning' }], child: ui.text(content), footer: ui.divider({ label: content }) }),
        ui.tabs({ id: `tabs-${suffix}`, activeId: 'a', items: [{ id: 'a', label: content, count: 123 }, { id: 'b', label: content }] }),
        ui.list({ id: `list-${suffix}`, role: 'choose', mode: 'multiple', selectedIds: ['a'], filter: content, items: [{ id: 'a', label: content, detail: content, detailSpans: [{ text: content, tone: 'accent', styles: ['strong'] }], badge: content, group: content }, { id: 'b', label: content }] }),
        ui.form({ id: `form-${suffix}`, fields: [{ kind: 'input', id: `field-${suffix}`, label: content, value: content, error: content }] }),
        ui.actions({ id: `actions-${suffix}`, items: [{ id: `action-${suffix}`, label: content, intent: 'danger', confirm: content }] }),
        ui.loader({ message: content, elapsedMs: 12 }),
        ui.empty({ title: content, description: content }),
        ui.progress({ label: content, value: 1, max: 3 }),
      ])
      const { options, viewport } = fixture()
      viewport.rows = 200
      const alternate = compiled(tree, options)
      alternate.focusTarget!.focused = true
      const main = compiled(tree, fixture({ screenMode: 'main', getViewport: () => ({ columns: 120, rows: 20 }) }).options)
      main.focusTarget!.focused = true
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`${name} alternate patterns`, alternate.component.render(width), width)
        expectLinesFit(`${name} layout patterns`, layout(alternate.component as Component, width, 20).lines, width)
        expectLinesFit(`${name} main patterns`, main.component.render(width), width)
      }
    }
  })

  it('renders loader frames without owning timers', () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const interval = vi.spyOn(globalThis, 'setInterval')
    try {
      const loader = compiled(ui.loader({ message: 'Loading', variant: 'braille', elapsedMs: 10 }), fixture().options)
      expect(loader.component.render(20)).toEqual(['⠋ Loading 10ms'])
      loader.component.invalidate()
      expect(timeout).not.toHaveBeenCalled()
      expect(interval).not.toHaveBeenCalled()
    } finally {
      timeout.mockRestore()
      interval.mockRestore()
    }
  })

  it('returns bounded error surfaces and contains render/event sink failures', () => {
    const invalid = compileMayflyUiNode({ kind: 'custom' }, fixture().options)
    expect(invalid).toMatchObject({ ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION' })
    if (invalid.ok) throw new Error('expected failure')
    for (const width of [1, 2, 10]) {
      const rows = invalid.errorComponent.render(width)
      expect(rows.length).toBeLessThanOrEqual(3)
      expect(rows.every(row => visibleWidth(row) <= width)).toBe(true)
    }

    const unicode = compileMayflyUiNode({ kind: '界🙂' }, fixture().options)
    if (unicode.ok) throw new Error('expected failure')
    const unicodeRows = unicode.errorComponent.render(20)
    expect(unicodeRows.join('')).toContain('界🙂')
    expect(unicodeRows.every(row => visibleWidth(row) <= 20)).toBe(true)
    expect(unicode.errorComponent.render(15).every(row => visibleWidth(row) <= 15)).toBe(true)

    const boundary = compileMayflyUiNode({ kind: `${'x'.repeat(19)}界` }, fixture().options)
    if (boundary.ok) throw new Error('expected failure')
    expect(boundary.errorComponent.render(20).every(row => visibleWidth(row) <= 20)).toBe(true)

    const throwingComponents = { ...components, wrapText: () => { throw new Error('render exploded') } } as MayflyComponents
    const rendered = compiled(ui.text('safe'), fixture({ components: throwingComponents }).options).component.render(12)
    expect(rendered.join('')).toContain('render')
    expect(rendered.every(row => visibleWidth(row) <= 12)).toBe(true)

    const event = compiled(ui.actions({ id: 'a', items: [{ id: 'go', label: 'Go' }] }), fixture({ emit: () => { throw new Error('sink') } }).options).focusTarget!
    expect(() => event.handleInput?.('\r')).not.toThrow()
    event.invalidate()

    const nonErrorComponents = { ...components, wrapText: () => { throw 'non-error' } } as MayflyComponents
    expect(compiled(ui.richText([{ text: 'x' }]), fixture({ components: nonErrorComponents }).options).component.render(12).join('')).toContain('unknown')
    expect(layout(compiled(ui.richText([{ text: 'x' }]), fixture({ components: nonErrorComponents }).options).component as Component, 12, 3).lines.join('')).toContain('unknown')

    const accessorError = Object.defineProperty({}, 'message', { get: () => { throw new Error('message getter escaped') } })
    const accessorComponents = { ...components, wrapText: () => { throw accessorError } } as MayflyComponents
    expect(compiled(ui.richText([{ text: 'x' }]), fixture({ components: accessorComponents }).options).component.render(12).join('')).toContain('unknown render')

    const emptyMessageComponents = { ...components, wrapText: () => { throw new Error('   ') } } as MayflyComponents
    expect(compiled(ui.richText([{ text: 'x' }]), fixture({ components: emptyMessageComponents }).options).component.render(12).join('')).toContain('unknown render')

    const revoked = Proxy.revocable({}, {})
    const hostileComponents = { ...components, wrapText: () => { throw revoked.proxy } } as MayflyComponents
    const hostile = compiled(ui.richText([{ text: 'x' }]), fixture({ components: hostileComponents }).options)
    revoked.revoke()
    expect(hostile.component.render(12).join('')).toContain('unknown render')

    const overwideComponents = { ...components, wrapText: () => ['overwide row'] } as MayflyComponents
    expect(compiled(ui.richText([{ text: 'x' }]), fixture({ components: overwideComponents }).options).component.render(4).every(row => visibleWidth(row) <= 4)).toBe(true)

    const brokenRoot = compiled(ui.stack.column([ui.text('x')]), fixture().options).component as unknown as { root: { render: (width: number) => string[] }, render: (width: number) => string[] }
    brokenRoot.root.render = () => { throw new Error('root exploded') }
    expect(brokenRoot.render(20).join('')).toContain('root exploded')
    brokenRoot.root.render = () => { throw 'root non-error' }
    expect(brokenRoot.render(20).join('')).toContain('unknown')
  })

  it('contains viewport and semantic paint failures', () => {
    const brokenColors = new Proxy(colors, { get: () => { throw new Error('paint') } })
    const { options } = fixture({ colors: brokenColors, getViewport: () => { throw new Error('viewport') } })
    const result = compileMayflyUiNode({ kind: 'custom' }, options)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(() => result.errorComponent.render(8)).not.toThrow()
    expect(result.errorComponent.render(8).every(row => visibleWidth(sliceByColumn(row, 0, 8, true)) <= 8)).toBe(true)
    result.errorComponent.invalidate()

    const invalidViewport = fixture({ getViewport: () => ({ columns: Number.NaN, rows: Number.POSITIVE_INFINITY }) })
    expect(compiled(ui.text('x'), invalidViewport.options).component.render(Number.NaN)).toHaveLength(1)

    const widePaint = new Proxy(colors, { get: (_target, key) => key === 'error' ? (value: string) => `${value}too-wide` : identity })
    const failed = compileMayflyUiNode({}, fixture({ colors: widePaint as MayflySemanticColors }).options)
    if (failed.ok) throw new Error('expected failure')
    expect(failed.errorComponent.render(2).every(row => visibleWidth(row) <= 2)).toBe(true)
    expect(failed.errorComponent.render(Number.NaN)).toHaveLength(3)

    const throwingViewport = fixture({ getViewport: () => { throw new Error('viewport') } })
    expect(compiled(ui.text('x'), throwingViewport.options).component.render(8)).toEqual(['x'])
  })

  it('contains compiler setup failures', () => {
    const base = fixture().options
    const options = new Proxy(base, { get: (target, key, receiver) => {
      if (key === 'getViewport') throw new Error('setup')
      return Reflect.get(target, key, receiver)
    } })
    expect(compileMayflyUiNode(ui.text('x'), options)).toMatchObject({ ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION', message: 'Mayfly UI compilation failed safely' })

    expect(compileMayflyUiSurfaceNode({ kind: 'not-mayfly' }, {
      ...fixture().options,
      surfaceRuntime: new MayflyUiSurfaceRuntime(),
    })).toMatchObject({ ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION' })
  })
})

describe('compileMayflyUiSurfaceNode contextual hints', () => {
  function focusedHint(value: unknown, inputs: readonly string[] = [], overrides: Partial<MayflyUiCompilerOptions> = {}, width = 120): string {
    const result = compiledSurface(value, fixture(overrides).options)
    const focus = result.focusTarget!
    focus.focused = true
    for (const input of inputs) focus.handleInput?.(input)
    return focus.render(width).at(-1) ?? ''
  }

  it('keeps hints on focused persistent plugin surfaces only', () => {
    const action = ui.actions({ id: 'commands', items: [{ id: 'run', label: 'Run' }] })
    const f = fixture()
    const persistent = compiledSurface(action, f.options)
    expect(persistent.component.render(80)).toHaveLength(1)
    persistent.focusTarget!.focused = true
    expect(persistent.component.render(80).at(-1)).toBe('  Enter run')

    const lane = compiledSurface(ui.surface({ chrome: 'lane', child: action }), fixture().options)
    lane.focusTarget!.focused = true
    expect(lane.component.render(80).at(-1)).toBe('  Enter run')

    const ordinary = compiled(action, f.options)
    ordinary.focusTarget!.focused = true
    expect(ordinary.component.render(80)).toHaveLength(1)
    expect(ordinary.component.render(80).join('')).not.toContain('Enter run')

    const passive = compiledSurface(ui.text('passive'), f.options)
    expect(passive.focusTarget).toBeNull()
    expect(passive.component.render(80)).toEqual(['passive'])

    const editor = createTestEditor()
    editor.setText('draft')
    const shell = compiledEditorShell({ kind: 'editor-control' }, editor).result
    shell.focusTarget.focused = true
    expect(shell.component.render(80).join('\n')).not.toContain('Enter finish')

    expect(compiledStatus(ui.text('status')).component.render(80)).toEqual(['status'])

    const replacement = compileMayflyUiSurfaceNode(ui.text('replacement'), {
      ...f.options,
      surfaceRuntime: persistent.surfaceRuntime,
    })
    expect(replacement.ok).toBe(true)
    expect(persistent.component.render(80)).toEqual([])
  })

  it('derives every navigation and activation hint from the active control state', () => {
    expect(focusedHint(ui.tabs({ id: 'tabs', activeId: 'a', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }), [], { onUnhandledEscape: () => {} }))
      .toBe('  ←/→ tabs · Enter open · Esc close')
    expect(focusedHint(ui.list({ id: 'list', role: 'browse', selectedIds: [], items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })))
      .toBe('  ↑/↓/←/→ options · Enter choose')
    expect(focusedHint(ui.loader({ message: 'Working', cancelActionId: 'cancel' })))
      .toBe('  Enter cancel')
    expect(focusedHint(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] })))
      .toBe('  Enter edit')
    expect(focusedHint(ui.form({ id: 'form', fields: [{ kind: 'select', id: 'theme', label: 'Theme', value: 'dark', options: [{ id: 'dark', label: 'Dark' }] }] })))
      .toBe('  Enter adjust')
    expect(focusedHint(ui.form({ id: 'form', fields: [{ kind: 'toggle', id: 'enabled', label: 'Enabled', value: false }] })))
      .toBe('  Space/Enter toggle')
    expect(focusedHint(ui.form({ id: 'form', fields: [], submitActionId: 'Save' })))
      .toBe('  Enter submit')
    expect(focusedHint(ui.actions({ id: 'commands', items: [{ id: 'run', label: 'Run' }] })))
      .toBe('  Enter run')

    const groups = ui.stack.column([
      ui.actions({ id: 'commands', items: [{ id: 'run', label: 'Run' }, { id: 'stop', label: 'Stop' }] }),
      ui.tabs({ id: 'tabs', activeId: 'a', items: [{ id: 'a', label: 'A' }] }),
    ])
    expect(focusedHint(groups)).toBe('  ↑/↓/←/→ actions · Enter run · Tab/Shift+Tab groups')

    const scrollGroups = ui.stack.column([
      ui.scroll(ui.text('abcdefgh')),
      ui.actions({ id: 'commands', items: [{ id: 'run', label: 'Run' }] }),
    ])
    expect(focusedHint(scrollGroups, [], { onUnhandledEscape: () => {} }))
      .toBe('  ↑/↓/PgUp/PgDn scroll · Esc back · Tab/Shift+Tab groups')
  })

  it('derives empty-list, passive, field, and explicit dismissal hints', () => {
    expect(focusedHint(ui.list({ id: 'empty', role: 'choose', filterable: true, selectedIds: [], items: [] }), [], { onUnhandledEscape: () => {} }))
      .toContain('Enter choose')
    expect(focusedHint(ui.list({ id: 'empty', role: 'browse', selectedIds: [], items: [] }))).toBe('')
    expect(focusedHint(ui.form({ id: 'form', fields: [
      { kind: 'toggle', id: 'one', label: 'One', value: false },
      { kind: 'toggle', id: 'two', label: 'Two', value: false },
    ] }))).toContain('fields')
    expect(focusedHint(ui.text('passive'), [], { contextHints: { focusWithoutControls: true }, onUnhandledEscape: () => {} }))
      .toContain('Esc close')
    expect(focusedHint(ui.text('passive'), [], { contextHints: { focusWithoutControls: true } })).not.toContain('Esc')
    expect(focusedHint(ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run' }] }), [], {
      contextHints: { extra: () => [{ id: 'dismiss', keys: 'D', label: 'dismiss', priority: 1000 }] },
    })).toContain('D dismiss')
  })

  it('keeps tab and multiple-list activation aligned with their hints', () => {
    const f = fixture()
    const result = compiledSurface(ui.stack.column([
      ui.tabs({ id: 'tabs', activeId: 'a', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
      ui.list({ id: 'list', role: 'choose', mode: 'multiple', selectedIds: [], items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
    ]), f.options)
    const focus = result.focusTarget!
    focus.focused = true

    expect(focus.render(120).at(-1)).toBe('  ←/→ tabs · Enter open')
    focus.handleInput?.(' ')
    expect(f.events).toEqual([])
    focus.handleInput?.('\r')
    expect(f.events).toEqual([])

    expect(focus.render(120).at(-1)).toBe('  ↑/↓/←/→ options · Space/Enter toggle / confirm · Tab/Shift+Tab groups')
    focus.handleInput?.('\r')
    expect(f.events).toEqual([{ kind: 'selection-accept', pagePath: [], controlId: 'list', selectedIds: [] }])
    focus.handleInput?.(' ')
    expect(f.events.at(-1)).toEqual({ kind: 'selection-toggle', pagePath: [], controlId: 'list', selectedIds: ['a'] })
  })

  it('switches hints for text editing, select adjustment, and confirmation', () => {
    const input = ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] })
    expect(focusedHint(input, ['\r'])).toBe('  Enter next · Esc leave')
    const editingLayout = compiledSurface(input, fixture().options)
    editingLayout.focusTarget!.focused = true
    editingLayout.focusTarget!.handleInput?.('\r')
    expect(layout(editingLayout.component as Component, 40, 3).lines.join('')).toContain(CURSOR_MARKER)

    const textareaGroups = ui.stack.column([
      ui.form({ id: 'form', fields: [{ kind: 'textarea', id: 'notes', label: 'Notes', value: '' }] }),
      ui.actions({ id: 'commands', items: [{ id: 'save', label: 'Save' }] }),
    ])
    expect(focusedHint(textareaGroups, ['\r']))
      .toBe('  Enter/Alt+Enter newline · Esc leave · Tab/Shift+Tab groups')

    const select = ui.form({ id: 'form', fields: [{ kind: 'select', id: 'theme', label: 'Theme', value: 'dark', options: [
      { id: 'dark', label: 'Dark' },
      { id: 'disabled', label: 'Disabled', disabled: true },
      { id: 'light', label: 'Light' },
    ] }] })
    expect(focusedHint(select, ['\r'])).toBe('  ←/→ options · Enter apply · Esc cancel')

    const fixedSelect = ui.form({ id: 'form', fields: [{ kind: 'select', id: 'theme', label: 'Theme', value: 'dark', options: [
      { id: 'dark', label: 'Dark' },
      { id: 'disabled', label: 'Disabled', disabled: true },
    ] }] })
    expect(focusedHint(fixedSelect, ['\r'])).toBe('  Enter apply · Esc cancel')

    const selectGroups = ui.stack.column([
      select,
      ui.actions({ id: 'commands', items: [{ id: 'save', label: 'Save' }] }),
    ])
    expect(focusedHint(selectGroups, ['\r']))
      .toBe('  ←/→ options · Enter apply · Esc cancel')

    const confirm = ui.actions({ id: 'commands', items: [{ id: 'delete', label: 'Delete', confirm: 'Delete?' }] })
    expect(focusedHint(confirm, ['\r'])).toBe('  Enter run')
  })

  it('filters unavailable controls and degrades through complete width-safe tokens', () => {
    const f = fixture({ onUnhandledEscape: () => {} })
    const tree = ui.stack.column([
      ui.actions({ id: 'commands', items: [
        { id: 'run', label: 'Run' },
        { id: 'disabled', label: 'Disabled', disabled: true },
        { id: 'busy', label: 'Busy', busy: true },
      ] }),
      ui.child(ui.list({ id: 'hidden', role: 'browse', selectedIds: [], items: [{ id: 'item', label: 'Item' }] }), { when: { minWidth: 100 } }),
    ])
    const result = compiledSurface(tree, f.options)
    result.focusTarget!.focused = true
    expect(result.component.render(80).at(-1)).toBe('  Enter run · Esc close')
    f.viewport.columns = 120
    expect(result.component.render(120).at(-1)).toBe('  ↑/↓/←/→ actions · Enter run · Tab/Shift+Tab groups')

    const wideTree = ui.stack.column([
      ui.actions({ id: 'commands', items: [{ id: 'run', label: 'Run' }, { id: 'stop', label: 'Stop' }] }),
      ui.tabs({ id: 'tabs', activeId: 'a', items: [{ id: 'a', label: 'A' }] }),
    ])
    const widths = compiledSurface(wideTree, fixture({ onUnhandledEscape: () => {} }).options)
    widths.focusTarget!.focused = true
    expect(widths.component.render(80).at(-1)).toBe('  ↑/↓/←/→ actions · Enter run · Tab/Shift+Tab groups')
    expect(widths.component.render(40).at(-1)).toBe('  ↑/↓/←/→ · Enter · Tab')
    expect(widths.component.render(18).at(-1)).toBe('  ↑/↓/←/→ · Enter')
    expect(widths.component.render(8).at(-1)).toBe('  Enter')
    expect(widths.component.render(6).join('\n')).not.toContain('Ent')

    const ansiColors = new Proxy({ logoGradient: [identity] }, {
      get: (target, key) => key === 'logoGradient'
        ? target.logoGradient
        : key === 'textMuted' ? (value: string) => `\u001b[2m${value}\u001b[22m` : identity,
    }) as MayflySemanticColors
    const ansi = compiledSurface(wideTree, fixture({ colors: ansiColors, onUnhandledEscape: () => {} }).options)
    ansi.focusTarget!.focused = true
    const ansiHint = ansi.component.render(40).at(-1)!
    expect(ansiHint).toContain('\u001b[2m')
    expect(visibleWidth(ansiHint)).toBeLessThanOrEqual(40)
  })

  it('merges semantic extras by id and contains hint provider and translator failures', () => {
    const action = ui.actions({ id: 'commands', items: [{ id: 'run', label: 'Run' }] })
    expect(focusedHint(action, [], {
      contextHints: {
        translate: key => {
          if (key === 'fallback') throw new Error('translator unavailable')
          return `translated:${key}`
        },
        extra: () => [
          { id: '', keys: 'ignored' },
          { id: 'ignored', keys: '' },
          { id: 'activate', keys: 'Ctrl+R', label: 'refresh', compact: 'R', priority: 110 },
          { id: 'activate', keys: 'Ctrl+L', label: 'launch', priority: 105 },
          { id: 'fallback', keys: 'F', label: 'fallback' },
        ],
      },
    })).toBe('  Ctrl+L translated:launch · Enter translated:run · F fallback')

    expect(focusedHint(action, [], {
      contextHints: { extra: () => { throw new Error('hint provider unavailable') } },
    })).toBe('  Enter run')

    expect(focusedHint(action, [], {
      contextHints: {
        suppressAuto: true,
        extra: () => [
          { id: 'confirm', keys: 'C', label: 'confirm', priority: 90 },
          { id: 'first', keys: 'F', priority: 80 },
          { id: 'second', keys: 'S', priority: 80 },
        ],
      },
    })).toBe('  F · S · C confirm')
  })

  it('supports automatic-hint suppression and focusable controller-only surfaces', () => {
    const action = ui.actions({ id: 'commands', items: [{ id: 'run', label: 'Run' }] })
    expect(focusedHint(action, [], {
      contextHints: {
        suppressAuto: true,
        extra: () => [{ id: 'custom', keys: 'R', label: 'run' }],
      },
    })).toBe('  R run')
    const suppressed = compiledSurface(action, fixture({ contextHints: { suppressAuto: true } }).options)
    suppressed.focusTarget!.focused = true
    expect(suppressed.component.render(40)).toHaveLength(1)
    expect(suppressed.component.render(40).join('')).not.toContain('Enter run')

    const official = compiled(ui.text('Details'), fixture({
      contextHints: { enabled: true, focusWithoutControls: true },
      onUnhandledEscape: () => {},
    }).options)
    expect(official.focusTarget).not.toBeNull()
    official.focusTarget!.focused = true
    expect(official.component.render(40)).toEqual(['Details', '  Esc close'])

    const passive = compiledSurface(ui.text('Details'), fixture({
      contextHints: { focusWithoutControls: true },
      onUnhandledEscape: () => {},
    }).options)
    expect(passive.focusTarget).not.toBeNull()
    passive.focusTarget!.focused = true
    expect(passive.component.render(40)).toEqual(['Details', '  Esc close'])
  })

  it('keeps the hint inside overlay chrome in direct and height-bounded layout renders', () => {
    const overlay = compiledSurface(ui.surface({
      chrome: 'overlay',
      title: 'Details',
      padding: 1,
      child: ui.actions({ id: 'commands', items: [{ id: 'run', label: 'Run' }] }),
    }), fixture({ getViewport: () => ({ columns: 20, rows: 4 }), onUnhandledEscape: () => {} }).options)
    overlay.focusTarget!.focused = true

    const direct = overlay.component.render(20).map(stripTerminalSequences)
    expect(direct).toHaveLength(4)
    expect(direct.at(-2)).toMatch(/^│\s+Enter · Esc\s+│$/u)
    expect(direct.at(-1)).toBe('╰──────────────────╯')

    const frame = layout(overlay.component as Component, 20, 4).lines.map(stripTerminalSequences)
    expect(frame).toHaveLength(4)
    expect(frame.at(-2)).toMatch(/^│\s+Enter · Esc\s+│$/u)
    expect(frame.at(-1)).toBe('╰──────────────────╯')
    for (const width of SCAN_WIDTHS) {
      expectLinesFit('context hints direct', overlay.component.render(width), width)
      expectLinesFit('context hints layout', layout(overlay.component as Component, width, 4).lines, width)
    }
  })
})

describe('compileMayflyEditorShellNode', () => {
  it('reuses the injected editor through focus, input, layout, and direct rendering', () => {
    const editor = createTestEditor()
    editor.setText('draft')
    const shell = {
      kind: 'stack',
      direction: 'column',
      children: [
        { node: ui.text('before') },
        { node: { kind: 'editor-control' } },
        { node: ui.actions({ id: 'actions', items: [{ id: 'apply', label: 'Apply' }] }) },
      ],
    }
    const { events, result } = compiledEditorShell(shell, editor)
    expect(Object.isFrozen(result.node)).toBe(true)
    expect(result.focusTarget).toBe(result.component)
    result.focusTarget.focused = true

    for (const width of [40, 2, 1]) {
      const direct = result.component.render(width)
      expectLinesFit('editor shell direct', direct.map(row => row.replaceAll(CURSOR_MARKER, '')), width)
      const frame = layout(result.component as Component, width, 8).lines
      expectLinesFit('editor shell layout', frame.map(row => row.replaceAll(CURSOR_MARKER, '')), width)
    }
    expect(editor.focused).toBe(true)
    result.focusTarget.handleInput?.('!')
    expect(editor.getText()).toBe('draft!')

    result.focusTarget.handleInput?.('\t')
    result.component.render(40)
    expect(editor.focused).toBe(false)
    result.focusTarget.handleInput?.('\r')
    expect(events).toEqual([{ kind: 'activate', pagePath: [], controlId: 'apply', actionId: 'apply' }])

    result.focusTarget.handleInput?.('\x1b[Z')
    result.component.render(40)
    expect(editor.focused).toBe(true)
    result.focusTarget.focused = false
    expect(editor.focused).toBe(false)
    result.component.invalidate()
  })

  it('delegates Tab completion in an editor-only shell while multi-control shells keep roving', () => {
    const editorOnly = createTestEditor()
    const editorOnlyInput = vi.spyOn(editorOnly, 'handleInput')
    const root = compiledEditorShell({ kind: 'editor-control' }, editorOnly).result
    root.focusTarget.focused = true
    root.component.render(40)

    root.focusTarget.handleInput?.('\t')
    root.focusTarget.handleInput?.('\x1b[Z')

    expect(editorOnlyInput).toHaveBeenNthCalledWith(1, '\t')
    expect(editorOnlyInput).toHaveBeenNthCalledWith(2, '\x1b[Z')
    expect(editorOnly.focused).toBe(true)

    const rovingEditor = createTestEditor()
    const rovingInput = vi.spyOn(rovingEditor, 'handleInput')
    const shell = compiledEditorShell({
      kind: 'stack',
      direction: 'column',
      children: [
        { node: { kind: 'editor-control' } },
        { node: ui.actions({ id: 'actions', items: [{ id: 'apply', label: 'Apply' }] }) },
      ],
    }, rovingEditor).result
    shell.focusTarget.focused = true

    shell.focusTarget.handleInput?.('\t')

    expect(rovingInput).not.toHaveBeenCalled()
    shell.component.render(40)
    expect(rovingEditor.focused).toBe(false)
  })

  it('reports checked failures, preserves dry-run focus, and restores the editor roving target', () => {
    const editor = createTestEditor()
    editor.setText('draft')
    const shell = {
      kind: 'stack',
      direction: 'column',
      children: [
        { node: { kind: 'editor-control' } },
        { node: ui.actions({ id: 'actions', items: [{ id: 'apply', label: 'Apply' }] }) },
      ],
    }
    const { events, result } = compiledEditorShell(shell, editor)

    result.focusTarget.focused = true
    result.component.render(20)
    expect(editor.focused).toBe(true)
    result.focusTarget.handleInput?.('\t')
    result.component.render(20)
    expect(editor.focused).toBe(false)

    const checked = result.component.renderChecked(2, { dryRun: true })
    expectLinesFit('editor shell checked dry render', checked.rows, 2)
    expect(result.focusTarget.focused).toBe(true)
    expect(editor.focused).toBe(false)
    result.focusTarget.handleInput?.('\r')
    expect(events).toEqual([{ kind: 'activate', pagePath: [], controlId: 'apply', actionId: 'apply' }])

    result.focusTarget.focused = false
    result.focusTarget.focusEditor()
    expect(result.focusTarget.focused).toBe(false)
    expect(editor.focused).toBe(false)
    result.focusTarget.focused = true
    result.focusTarget.handleInput?.('!')
    expect(editor.getText()).toBe('draft!')

    const candidate = compiledEditorShell(shell, editor).result
    editor.focused = true
    expect(candidate.focusTarget.focused).toBe(false)
    candidate.component.renderChecked(20, { dryRun: true })
    expect(candidate.focusTarget.focused).toBe(false)
    expect(editor.focused).toBe(true)

    const broken = createTestEditor()
    broken.render = () => { throw new Error('checked editor exploded') }
    const brokenShell = compiledEditorShell({ kind: 'editor-control' }, broken).result.component
    const failed = brokenShell.renderChecked(20)
    expect(failed.runtimeFailure).toBe('checked editor exploded')
    expect(failed.rows.join('')).toContain('checked editor exploded')
    expectLinesFit('editor shell checked runtime failure', failed.rows, 20)
    broken.focused = true
    const failedDry = brokenShell.renderChecked(20, { dryRun: true })
    expect(failedDry.runtimeFailure).toBe('checked editor exploded')
    expect(broken.focused).toBe(true)
  })

  it('restores pooled form editor focus after responsive dry runs', () => {
    const shell = {
      kind: 'stack',
      direction: 'column',
      children: [
        { node: { kind: 'editor-control' } },
        {
          node: ui.form({ id: 'profile', fields: [{ kind: 'input', id: 'name', label: 'Name', value: 'Mayfly' }] }),
          when: { minWidth: 60 },
        },
      ],
    }
    const pooled: MayflyEditor[] = []
    const localComponents = {
      ...components,
      createEditor: () => {
        const editor = createTestEditor()
        pooled.push(editor)
        return editor
      },
    } as MayflyComponents
    const current = compiledEditorShell(shell, createTestEditor(), { components: localComponents })
    current.result.focusTarget.focused = true
    current.result.component.render(80)
    current.result.focusTarget.handleInput?.('\t')
    current.result.focusTarget.handleInput?.('\r')
    current.result.component.render(80)
    expect(pooled).toHaveLength(1)
    expect(pooled[0]!.focused).toBe(true)

    current.viewport.columns = 40
    current.result.component.renderChecked(40, { dryRun: true })
    expect(pooled[0]!.focused).toBe(true)
    current.viewport.columns = 80
    current.result.component.renderChecked(80, { dryRun: true })
    expect(pooled[0]!.focused).toBe(true)
    current.result.component.render(80)
    expect(pooled[0]!.focused).toBe(true)

    const emptyRuntime = new MayflyUiSurfaceRuntime()
    const restoreEmptyFocus = emptyRuntime.checkpointEditorFocus()
    restoreEmptyFocus()
    restoreEmptyFocus()

    const createdDuringDryRun: MayflyEditor[] = []
    const lateComponents = {
      ...components,
      createEditor: () => {
        const editor = createTestEditor()
        createdDuringDryRun.push(editor)
        return editor
      },
    } as MayflyComponents
    const late = compiledEditorShell(shell, createTestEditor(), { components: lateComponents })
    late.viewport.columns = 40
    late.result.focusTarget.focused = true
    late.result.component.render(40)
    expect(createdDuringDryRun).toEqual([])
    late.viewport.columns = 80
    late.result.component.renderChecked(80, { dryRun: true })
    expect(createdDuringDryRun).toHaveLength(1)
    expect(createdDuringDryRun[0]!.focused).toBe(false)

    const resolved = createTestEditor()
    resolved.focused = true
    const resolvedLate = compiledEditorShell(shell, createTestEditor(), {
      resolveTextEditor: () => resolved,
    })
    resolvedLate.viewport.columns = 40
    resolvedLate.result.component.render(40)
    resolvedLate.viewport.columns = 80
    resolvedLate.result.component.renderChecked(80, { dryRun: true })
    expect(resolved.focused).toBe(true)

    const shared = createTestEditor()
    shared.focused = true
    const sharedResolver = compiledEditorShell({
      kind: 'stack',
      direction: 'column',
      children: [
        { node: { kind: 'editor-control' } },
        { node: ui.form({ id: 'shared', fields: [
          { kind: 'input', id: 'name', label: 'Name', value: 'Mayfly' },
          { kind: 'input', id: 'alias', label: 'Alias', value: 'Dsh' },
        ] }) },
      ],
    }, createTestEditor(), { resolveTextEditor: () => shared })
    sharedResolver.result.component.renderChecked(80, { dryRun: true })
    expect(shared.focused).toBe(true)
  })

  it('compiles a root slot and contains validation, setup, and editor render failures', () => {
    const editor = createTestEditor()
    editor.setText('same object')
    const root = compiledEditorShell({ kind: 'editor-control' }, editor).result
    root.focusTarget.focused = true
    expect(root.component.render(20).join('')).toContain('same object')

    const invalid = compileMayflyEditorShellNode(ui.text('missing'), { ...fixture().options, editor })
    expect(invalid).toMatchObject({ ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION' })
    if (invalid.ok) throw new Error('expected failure')
    for (const width of [1, 2, 10]) expectLinesFit('editor shell rejection', invalid.errorComponent.render(width), width)

    expect(compileMayflyEditorShellNode({ kind: 'editor-control' }, {
      ...fixture().options,
      editor: undefined as never,
    })).toMatchObject({
      ok: false,
      code: 'MAYFLY_INVALID_CONTRIBUTION',
      message: 'Mayfly editor shell compilation failed safely',
    })

    const broken = createTestEditor()
    broken.render = () => { throw new Error('editor exploded') }
    const contained = compiledEditorShell({ kind: 'editor-control' }, broken).result.component.render(20)
    expect(contained.join('')).toContain('editor exploded')
    expectLinesFit('editor shell runtime failure', contained, 20)

    const base = { ...fixture().options, editor }
    const options = new Proxy(base, { get: (target, key, receiver) => {
      if (key === 'getViewport') throw new Error('setup')
      return Reflect.get(target, key, receiver)
    } })
    expect(compileMayflyEditorShellNode({ kind: 'editor-control' }, options)).toMatchObject({
      ok: false,
      code: 'MAYFLY_INVALID_CONTRIBUTION',
      message: 'Mayfly editor shell compilation failed safely',
    })
  })
})

describe('compileMayflyStatusNode', () => {
  it('uses the narrowed validator and exposes no focus, input, or event surface', () => {
    const invalid = compileMayflyStatusNode(ui.actions({ id: 'bad', items: [] }), statusOptions({ maxRows: 2 }))
    expect(invalid).toMatchObject({ ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION' })
    if (invalid.ok) throw new Error('expected failure')
    expect(invalid.errorComponent.renderStatus(8).rows.length).toBeLessThanOrEqual(2)
    expect(invalid.errorComponent.render(8).length).toBeLessThanOrEqual(2)

    const status = compiledStatus(ui.text('ready'))
    expect(status.node).toEqual({ kind: 'text', content: 'ready' })
    expect(status.component.render(20)).toEqual(['ready'])
    expect('focused' in status.component).toBe(false)
    expect('handleInput' in status.component).toBe(false)
    status.component.invalidate()
  })

  it('keeps compact row stacks spatial in main mode', () => {
    const status = compiledStatus(ui.stack.row([
      ui.child(ui.text('left'), { basis: 4, grow: 0, shrink: 0 }),
      ui.child(ui.text('right'), { basis: 5, grow: 0, shrink: 0 }),
    ], { gap: 1 }), statusOptions({ screenMode: 'main' }))
    const rows = status.component.render(20)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('left')
    expect(rows[0]).toContain('right')
  })

  it('bounds status height and reports row and column overflow', () => {
    const status = compiledStatus(ui.stack.column([
      ui.text('first'),
      ui.text('second'),
      ui.text('third'),
    ]), statusOptions({ maxRows: 2 }))
    expect(status.component.renderStatus(20)).toEqual({ rows: ['first', 'second'], overflowed: true })
    expect(status.component.render(20)).toEqual(['first', 'second'])

    const narrow = compiledStatus(ui.richText([{ text: 'abcdefghij' }]), statusOptions({ maxRows: 1 }))
    const rendered = narrow.component.renderStatus(4)
    expect(rendered.rows).toHaveLength(1)
    expect(rendered.overflowed).toBe(true)
    expectLinesFit('status overflow', rendered.rows, 4)

    const clamped = compiledStatus(ui.stack.column([ui.text('one'), ui.text('two')]), statusOptions({ maxRows: 99 as never }))
    expect(clamped.component.renderStatus(20)).toEqual({ rows: ['one'], overflowed: true })
  })

  it('evaluates status breakpoints against the allocated surface dimensions', () => {
    const status = compiledStatus({
      kind: 'stack',
      direction: 'column',
      children: [
        { node: { kind: 'text', content: 'wide' }, when: { minWidth: 20 } },
        { node: { kind: 'text', content: 'tall' }, when: { minHeight: 4 } },
        { node: { kind: 'text', content: 'compact' }, when: { maxWidth: 19, maxHeight: 3 } },
      ],
    }, statusOptions({ viewport: { columns: 80, rows: 24 }, maxRows: 3 }))
    expect(status.component.renderStatus(18)).toEqual({ rows: ['compact'], overflowed: false })
    expect(status.component.renderStatus(20)).toEqual({ rows: ['wide'], overflowed: false })
  })

  it('contains validation, setup, and render failures in the status budget', () => {
    const invalid = compileMayflyStatusNode({ kind: 'unknown' }, statusOptions({ maxRows: 1 }))
    if (invalid.ok) throw new Error('expected failure')
    const rejected = invalid.errorComponent.renderStatus(3)
    expect(rejected.rows.length).toBeLessThanOrEqual(1)
    expectLinesFit('status validation failure', rejected.rows, 3)
    invalid.errorComponent.invalidate()

    const throwingComponents = { ...components, wrapText: () => { throw new Error('status exploded') } } as MayflyComponents
    const rendered = compiledStatus(ui.richText([{ text: 'safe' }]), statusOptions({ components: throwingComponents, maxRows: 2 })).component.renderStatus(12)
    expect(rendered.rows.join('')).toContain('Mayfly UI rejected')
    expect(rendered.rows.length).toBeLessThanOrEqual(2)
    expect(rendered.runtimeFailure).toBe('status exploded')

    const broken = compiledStatus(ui.text('safe'), statusOptions({ maxRows: 2 })).component as unknown as {
      surface: { root: { render(width: number): string[] } }
      renderStatus(width: number): { rows: string[], overflowed: boolean, runtimeFailure?: string }
    }
    broken.surface.root.render = () => { throw new Error('status root exploded') }
    const failed = broken.renderStatus(12)
    expect(failed.rows.join('')).toContain('Mayfly UI rejected')
    expect(failed.runtimeFailure).toBe('status root exploded')

    const base = statusOptions()
    const options = new Proxy(base, { get: (target, key, receiver) => {
      if (key === 'getViewport') throw new Error('setup')
      return Reflect.get(target, key, receiver)
    } })
    expect(compileMayflyStatusNode(ui.text('x'), options)).toMatchObject({ ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION', message: 'Mayfly status compilation failed safely' })
  })
})
