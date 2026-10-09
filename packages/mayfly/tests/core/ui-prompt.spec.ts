/** The prompt painter: placeholder ladder, token strip, recall corner, buffer rows, completions, and the editor adapter. */
import { CURSOR_MARKER } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { ui, type MayflyPromptNode } from '../../../ui/src/index.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { createPromptModel, reducePrompt, type UiPromptIntent, type UiPromptModel } from '../../src/core/ui-interaction-prompt.ts'
import { UiPromptEditor, paintPrompt, paintTokenStrip, pickPlaceholder, placeholderLadder, type PromptPaint } from '../../src/core/ui-prompt.ts'
import { validateMayflyUiNode } from '../../src/core/ui-validator.ts'
import { truncateToWidth, visibleWidth } from '../../src/core/width.ts'
import { createFakeEditor } from './fake-editor.ts'

/** A palette in which every token is its own SGR color, so a row's tones can be read back and its width is the text's. */
const codes = new Map<string, number>()
const tone = (key: string, value: string): string => {
  if (!codes.has(key)) codes.set(key, 30 + codes.size)
  return `\x1b[${String(codes.get(key))}m${value}\x1b[39m`
}
const colors = new Proxy({}, { get: (_target, key) => (value: string) => tone(String(key), value) }) as MayflySemanticColors
const components = { visibleWidth, truncateToWidth, createEditor: createFakeEditor } as unknown as MayflyComponents
const plain = (rows: readonly string[]): string[] => rows.map(row => row.replaceAll(CURSOR_MARKER, '').replace(/\x1b\[[0-9;]*m/gu, ''))

const admit = (node: Omit<MayflyPromptNode, 'kind'>): MayflyPromptNode => {
  const result = validateMayflyUiNode(ui.prompt(node))
  if (!result.ok) throw new Error(result.message)
  return result.value as MayflyPromptNode
}
const address = { pagePath: [], controlId: 'p' }
const draw = (node: Omit<MayflyPromptNode, 'kind'>, width: number, options: { readonly model?: UiPromptIntent[] | false, readonly focused?: boolean, readonly buffer?: (width: number) => string[], readonly glyphs?: 'ascii' } = {}): string[] => {
  const admitted = admit(node)
  let model: UiPromptModel | undefined = options.model === false ? undefined : createPromptModel(address, admitted)
  if (model !== undefined) for (const intent of options.model ?? []) model = reducePrompt(model, intent).model
  const paint: PromptPaint = {
    node: admitted, model, width, focused: options.focused ?? true, colors, components,
    glyphs: options.glyphs, translate: key => key,
    buffer: options.buffer ?? (rowWidth => [truncateToWidth(model?.text ?? '', rowWidth, '')]),
  }
  return paintPrompt(paint)
}
const LADDER = ['Ask anything · / commands · @ files · # skills · ! shell', 'Ask anything · / commands · @ files · # skills', 'Ask anything · / commands · @ files', 'Ask anything']
const TOKENS = [{ id: 't1', label: 'Image #1', size: '84 KB' }, { id: 't2', label: 'notes.md', size: '2 KB' }]
const RECALL = [{ kind: 'queued', text: 'also update the footer' }, { kind: 'history', text: 'run the width scan again' }] as const

describe('the placeholder ladder', () => {
  it('uses the caller\'s ladder as given and degrades a plain string by whole triggers', () => {
    expect(placeholderLadder(LADDER)).toBe(LADDER)
    expect(placeholderLadder(undefined)).toEqual([])
    expect(placeholderLadder('Ask anything · / commands · @ files')).toEqual(['Ask anything · / commands · @ files', 'Ask anything · / commands', 'Ask anything'])
    expect(placeholderLadder('Ask anything')).toEqual(['Ask anything'])
  })

  it('picks the longest variant that fits, and cuts only the last one', () => {
    const fits = (room: number) => pickPlaceholder(LADDER, room, components)
    expect(fits(70)).toBe(LADDER[0])
    expect(fits(52)).toBe(LADDER[1])
    expect(fits(35)).toBe(LADDER[2])
    expect(fits(20)).toBe(LADDER[3])
    expect(fits(12)).toBe('Ask anything')
    expect(plain([fits(8)])[0]).toBe('Ask any…')
    expect(fits(0)).toBe('')
    expect(pickPlaceholder([], 20, components)).toBe('')
  })

  it('never cuts inside a trigger at any width from 24 to 140 columns', () => {
    for (let width = 24; width <= 140; width += 1) {
      const row = plain(draw({ id: 'p', placeholder: LADDER }, width))[0]!
      const shown = row.slice(3).trimEnd()
      expect(LADDER.concat('Ask anything'), `${String(width)} columns: ${shown}`).toContain(shown)
      expect(visibleWidth(row)).toBeLessThanOrEqual(width)
    }
  })
})

describe('the first row', () => {
  it('paints the symbol, the caret, and the placeholder of an empty prompt', () => {
    const [row] = draw({ id: 'p', placeholder: LADDER }, 96)
    expect(row).toBe(`${tone('text', '> ')}${CURSOR_MARKER}\x1b[7m \x1b[0m${tone('textMuted', LADDER[0])}`)
    expect(plain([row!])[0]).toBe(`> ${' '}${LADDER[0]}`)
    expect(draw({ id: 'p', placeholder: 'Ask' }, 40, { focused: false })[0]).toBe(`${tone('text', '> ')}${tone('textMuted', 'Ask')}`)
    expect(draw({ id: 'p' }, 40)[0]).toBe(`${tone('text', '> ')}${CURSOR_MARKER}\x1b[7m \x1b[0m`)
  })

  it('paints the symbol strong in its tone, and a default symbol in the text color', () => {
    expect(draw({ id: 'p', symbol: '! ', symbolTone: 'accent' }, 40, { focused: false })[0]).toBe(`\x1b[1m${tone('accent', '! ')}\x1b[22m`)
    expect(draw({ id: 'p', symbol: '$ ' }, 40, { focused: false })[0]).toBe(tone('text', '$ '))
  })

  it('draws the buffer after the symbol, wider symbols pushing it right', () => {
    expect(plain(draw({ id: 'p', value: 'hello' }, 40))[0]).toBe('> hello')
    expect(plain(draw({ id: 'p', value: 'hello', symbol: '❯❯ ' }, 40))[0]).toBe('❯❯ hello')
  })

  it('writes the tokens before the buffer, and the selected one inverse', () => {
    const [row] = draw({ id: 'p', tokens: TOKENS, value: 'explain' }, 96)
    expect(row).toBe(`${tone('text', '> ')}${tone('muted', '[')}${tone('accent', 'Image #1')}${tone('muted', ' 84 KB')}${tone('muted', ' ×]')} ${tone('muted', '[')}${tone('accent', 'notes.md')}${tone('muted', ' 2 KB')}${tone('muted', ' ×]')} explain`)
    const selected = draw({ id: 'p', tokens: TOKENS }, 96, { model: [{ kind: 'backspace' }] })[0]
    expect(selected).toContain('\x1b[7m[notes.md 2 KB ×]\x1b[0m')
    expect(plain([selected!])[0]).toBe('> [Image #1 84 KB ×] [notes.md 2 KB ×] ')
    expect(plain(draw({ id: 'p', tokens: [{ id: 't', label: 'x' }] }, 40))[0]).toBe('> [x ×] ')
  })

  it('folds tokens that do not fit behind +N and keeps the selected one', () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ id: `t${String(index)}`, label: `file${String(index)}.md`, size: '2 KB' }))
    const strip = (selected: string | undefined, room: number) => plain([paintTokenStrip(admit({ id: 'p', tokens: many }), selected, room, colors, components).text])[0]
    expect(strip(undefined, 200)).toBe('[file0.md 2 KB ×] [file1.md 2 KB ×] [file2.md 2 KB ×] [file3.md 2 KB ×] [file4.md 2 KB ×] ')
    expect(strip(undefined, 60)).toBe('+2 [file2.md 2 KB ×] [file3.md 2 KB ×] [file4.md 2 KB ×] ')
    expect(strip('t0', 60)).toBe('+2 [file0.md 2 KB ×] [file3.md 2 KB ×] [file4.md 2 KB ×] ')
    expect(strip(undefined, 40)).toBe('+4 [file4.md 2 KB ×] ')
    expect(strip(undefined, 4)).toBe('+4 [file4.md 2 KB ×] ')
    expect(paintTokenStrip(admit({ id: 'p' }), undefined, 40, colors, components)).toEqual({ text: '', width: 0 })
    const measured = paintTokenStrip(admit({ id: 'p', tokens: many }), undefined, 60, colors, components)
    expect(measured.width).toBe(visibleWidth(plain([measured.text])[0]!))
    expect(plain(draw({ id: 'p', tokens: many }, 40))[0]).toMatch(/^> \+\d \[/u)
  })

  it('shows the recall position in the right corner, queued entries by their kind', () => {
    const walk = (count: number) => draw({ id: 'p', recall: RECALL }, 96, { model: Array.from({ length: count }, () => ({ kind: 'recall', direction: 'older' }) as const) })[0]!
    expect(plain([walk(1)])[0]).toBe(`> also update the footer${' '.repeat(96 - 2 - 22 - 12)}↑ queued 1/2`)
    expect(visibleWidth(plain([walk(2)])[0]!)).toBe(96)
    expect(plain([walk(2)])[0]!.endsWith('↑ history 2/2')).toBe(true)
    expect(plain(draw({ id: 'p', recall: RECALL, recallLabel: 'earlier' }, 96, { model: [{ kind: 'recall', direction: 'older' }, { kind: 'recall', direction: 'older' }] }))[0]!.endsWith('↑ earlier 2/2')).toBe(true)
    expect(draw({ id: 'p', recall: RECALL }, 60, { model: [{ kind: 'recall', direction: 'older' }], glyphs: 'ascii' })[0]).toContain('^ queued 1/2')
    // The corner never pushes the buffer off the row.
    expect(visibleWidth(plain(draw({ id: 'p', recall: [{ kind: 'history', text: 'x'.repeat(200) }] }, 30, { model: [{ kind: 'recall', direction: 'older' }], buffer: rowWidth => ['y'.repeat(rowWidth)] }))[0]!)).toBe(30)
  })

  it('translates the corner words through the host catalog', () => {
    const admitted = admit({ id: 'p', recall: RECALL })
    const model = reducePrompt(createPromptModel(address, admitted), { kind: 'recall', direction: 'older' }).model
    const [row] = paintPrompt({ node: admitted, model, width: 80, focused: true, colors, components, glyphs: undefined, translate: key => `<${key}>`, buffer: () => [model.text] })
    expect(row).toContain('<queued>')
  })

  it('paints a prompt outside an interactive surface from its value, one row a line', () => {
    expect(plain(draw({ id: 'p', value: 'one\ntwo', placeholder: 'x' }, 40, { model: false })).map(row => row.trimEnd())).toEqual(['> one', '  two'])
    expect(plain(draw({ id: 'p', placeholder: 'Ask' }, 40, { model: false, focused: false }))).toEqual(['> Ask'])
  })
})

describe('the buffer and the completion list', () => {
  it('lays later buffer rows under the symbol\'s indent', () => {
    const rows = draw({ id: 'p', value: 'a\nb\nc' }, 40, { buffer: () => ['a', 'b', 'c'] })
    expect(plain(rows)).toEqual(['> a', '  b', '  c'])
    expect(draw({ id: 'p', value: 'x' }, 10, { buffer: () => ['y'.repeat(30), 'z'.repeat(30)] }).map(row => visibleWidth(plain([row])[0]!))).toEqual([10, 10])
  })

  it('shows up to five completion rows, the focused one marked and bold, details muted', () => {
    const items = Array.from({ length: 8 }, (_, index) => ({ id: `c${String(index)}`, label: `/command${String(index)}`, detail: `detail ${String(index)}` }))
    const rows = draw({ id: 'p', value: '/', completions: { items } }, 60)
    expect(plain(rows)).toEqual(['> /', '→ /command0 — detail 0', '  /command1 — detail 1', '  /command2 — detail 2', '  /command3 — detail 3', '  /command4 — detail 4'])
    expect(rows[1]).toBe(`${tone('primary', '\x1b[1m→\x1b[22m')} \x1b[1m${tone('text', '/command0')}\x1b[22m${tone('muted', ' — detail 0')}`)
    expect(rows[2]).toBe(`  ${tone('text', '/command1')}${tone('muted', ' — detail 1')}`)
    const scrolled = draw({ id: 'p', value: '/', completions: { items } }, 60, { model: Array.from({ length: 7 }, () => ({ kind: 'complete-move', delta: 1 }) as const) })
    expect(plain(scrolled).slice(1)).toEqual(['  /command3 — detail 3', '  /command4 — detail 4', '  /command5 — detail 5', '  /command6 — detail 6', '→ /command7 — detail 7'])
    expect(draw({ id: 'p', value: '/', completions: { items } }, 60, { glyphs: 'ascii' })[1]).toContain('>')
  })

  it('draws a row with only a label', () => {
    expect(plain(draw({ id: 'p', value: '#', completions: { items: [{ id: 's', label: '#review' }, { id: 't', label: '#test' }] } }, 40))).toEqual(['> #', '→ #review', '  #test'])
  })

  it('aligns an item\'s key at the right edge when it fits, and drops it when it does not', () => {
    const items = [{ id: 'c', label: '/model', detail: 'switch model', right: 'Ctrl+M' }]
    const [, wide] = plain(draw({ id: 'p', value: '/', completions: { items } }, 40))
    expect(wide).toBe(`→ /model — switch model${' '.repeat(40 - 23 - 6)}Ctrl+M`)
    const [, tight] = plain(draw({ id: 'p', value: '/', completions: { items } }, 24))
    expect(tight).toBe('→ /model — switch model')
    const [, cut] = plain(draw({ id: 'p', value: '/', completions: { items } }, 12))
    expect(cut).toBe('→ /model — …')
    expect(visibleWidth(cut!)).toBeLessThanOrEqual(12)
  })

  it('draws no list for a prompt without a model, or after the list was dismissed', () => {
    const items = [{ id: 'c', label: '/model' }]
    expect(draw({ id: 'p', value: '/', completions: { items } }, 40, { model: false })).toHaveLength(1)
    expect(draw({ id: 'p', value: '/', completions: { items } }, 40, { model: [{ kind: 'complete-dismiss' }] })).toHaveLength(1)
  })
})

describe('the editor adapter', () => {
  it('mirrors the model into the editor without reporting it back, and reports the editor\'s own edits', () => {
    const editor = new UiPromptEditor(components)
    const edits: string[] = []
    editor.onChange(value => edits.push(value))
    editor.sync('recalled')
    expect(edits).toEqual([])
    expect(editor.render(20, true)).toEqual(['recalled'])
    editor.handleInput('!')
    expect(edits).toEqual(['recalled!'])
    editor.sync('recalled!')
    editor.sync('')
    expect(editor.render(20, false)).toEqual([''])
    expect(edits).toEqual(['recalled!'])
  })

  it('keeps reporting after a sync that throws, and inserts newlines through the editor', () => {
    const failing = createFakeEditor()
    failing.setText = () => { throw new Error('boom') }
    const editor = new UiPromptEditor({ createEditor: () => failing } as never)
    const edits: string[] = []
    editor.onChange(value => edits.push(value))
    expect(() => { editor.sync('x') }).toThrow('boom')
    editor.handleInput('a')
    expect(edits).toEqual(['a'])
    editor.newline()
    expect(edits.at(-1)).toBe('a\n')
  })

  it('tracks a bracketed paste from its first marker to its last', () => {
    const editor = new UiPromptEditor(components)
    expect(editor.pending).toBe(false)
    editor.handleInput('\x1b[200~first')
    expect(editor.pending).toBe(true)
    editor.handleInput('middle chunk')
    expect(editor.pending).toBe(true)
    editor.handleInput('last\x1b[201~')
    expect(editor.pending).toBe(false)
    editor.handleInput('\x1b[200~whole\x1b[201~')
    expect(editor.pending).toBe(false)
    editor.handleInput('\x1b[200~a\x1b[201~b\x1b[200~c')
    expect(editor.pending).toBe(true)
  })

  it('never submits on its own, and lets go of its callbacks and buffer on release', () => {
    const created = createFakeEditor()
    const editor = new UiPromptEditor({ createEditor: () => created } as never)
    expect(created.disableSubmit).toBe(true)
    const listener = vi.fn()
    editor.onChange(listener)
    editor.focused = true
    expect(created.focused).toBe(true)
    editor.handleInput('a')
    editor.invalidate()
    editor.release()
    expect(created.focused).toBe(false)
    expect(created.getText()).toBe('')
    expect(created.onChange).toBeUndefined()
    editor.handleInput('b')
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('a prompt without an interaction model', () => {
  it('compiles to a read-only row set that follows the glyph mode', () => {
    const compile = (glyphs: 'unicode' | 'ascii') => {
      const result = compileMayflyUiNode(ui.prompt({ id: 'p', value: 'draft', tokens: [{ id: 't', label: 'x' }], completions: { items: [{ id: 'c', label: '/model' }] } }), {
        components: { ...components, presentation: { glyphs, monochrome: false, reducedMotion: false } } as never,
        colors,
        getViewport: () => ({ columns: 40, rows: 10 }),
        screenMode: 'alternate',
      })
      if (!result.ok) throw new Error(result.message)
      return plain(result.value.component.render(40))
    }
    expect(compile('unicode')).toEqual(['> [x ×] draft'])
    const placeholder = compileMayflyUiNode(ui.prompt({ id: 'p', placeholder: 'Ask anything' }), { components, colors, getViewport: () => ({ columns: 40, rows: 10 }), screenMode: 'alternate' })
    expect(placeholder.ok && plain(placeholder.value.component.render(40))).toEqual(['> Ask anything'])
  })
})
