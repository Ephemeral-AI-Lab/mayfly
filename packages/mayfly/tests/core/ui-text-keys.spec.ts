/**
 * Text keys across the real surfaces and the real editor: every encoding of Backspace on every control that takes text
 * (through the terminal input boundary, as a live terminal delivers them), Backspace on a field that is not being edited,
 * the text row's caret, and the plain arrows of a wizard and of a focused strip.
 */
import { Context } from '@deepseek-ai/cordis'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { ui, type MayflyUiEvent, type MayflyUiNode } from '../../../ui/src/index.ts'
import { questionnaireView } from '../../src/app/interactions/questionnaire.ts'
import { planReviewCard } from '../../src/app/interactions/plan-review-panel.ts'
import { MayflyComponentsService } from '../../src/core/components.ts'
import { normalizeKeyInput } from '../../src/core/terminal.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { renamePanelModel } from '../../src/interaction/rename-model.ts'
import { FakeTerminal } from './fake-terminal.ts'
import { plainBlock, plainColors } from '../helpers.ts'

const BACKSPACES = ['\x7f', '\b', '\x1b[127u', '\x1b[127;1u', '\x1b[127;1:1u', '\x1b[127;1:2u', '\x1b[27;1;127~']
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const HOME = '\x1b[H'
const END = '\x1b[F'
const DELETE = '\x1b[3~'
const ESC = '\x1b'
const TAB = '\t'
const ALT_RIGHT = '\x1b[1;3C'
const ALT_UP = '\x1b[1;3A'
const CTRL_A = '\x01'
const CTRL_U = '\x15'
const CTRL_W = '\x17'
const CTRL_J = '\n'
const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`

const translate = (text: string): string => text
const QUESTIONS = [
  { id: 'q1', header: 'Auth', question: 'First question?', options: [{ label: 'A' }, { label: 'B' }] },
  { id: 'q2', header: 'Region', question: 'Second question?', options: [{ label: 'C' }, { label: 'D' }] },
]
const FIRST = [{ controlId: 'questions', itemId: 'q1' }]

const terminal = new FakeTerminal()
const tui = new TuiMainScreen(terminal)
tui.start()
const components = new MayflyComponentsService(new Context(), { theme: { colors: plainColors() }, tui } as never)
const colors = plainColors()
const models: UiSurfaceModel[] = []
afterEach(() => { for (const model of models.splice(0)) model.dispose() })
afterAll(() => { tui.stop() })

function open(node: MayflyUiNode, width = 90) {
  const model = new UiSurfaceModel('keys', {
    id: 'keys', revision: 0, source: [], scope: { kind: 'app', targetId: 'keys' }, update: { reason: 'data' }, node,
    events: { prepare: async () => ({ reply: { kind: 'completed' as const }, publish: () => true }) },
    definition: {},
  } as never, {})
  models.push(model)
  const compiled = compileMayflyUiSurfaceNode(model.node!, {
    components: components as never, colors, getViewport: () => ({ columns: width, rows: 40 }), screenMode: 'alternate',
    emit: (event: MayflyUiEvent) => model.emit(event), contextHints: { enabled: true }, surfaceRuntime: new MayflyUiSurfaceRuntime(model),
  } as never)
  if (!compiled.ok) throw new Error(compiled.message)
  const focus = compiled.value.focusTarget!
  focus.focused = true
  const render = (): string => plainBlock(compiled.value.component.render(width))
  render()
  return {
    model, render,
    renderRaw: (): readonly string[] => compiled.value.component.render(width),
    /** What the terminal input boundary hands on, as a live terminal delivers it. */
    press: async (...keys: readonly string[]): Promise<void> => {
      for (const key of keys) {
        focus.handleInput?.(normalizeKeyInput(key) ?? key)
        await new Promise(resolve => setTimeout(resolve, 1))
      }
    },
    hint: (): string => render().trimEnd().split('\n').at(-1)!.trim(),
  }
}
type Surface = ReturnType<typeof open>

const other = (surface: Surface): string => surface.model.choice({ pagePath: FIRST, controlId: 'options' })?.inputs?.['other'] ?? ''
const asked = (surface: Surface): string => /First question/u.test(surface.render()) ? 'q1' : /Second question/u.test(surface.render()) ? 'q2' : 'review'
const onOther = async (...keys: readonly string[]): Promise<Surface> => {
  const surface = open(questionnaireView(QUESTIONS, translate))
  await surface.press(DOWN, DOWN, ...keys)
  return surface
}
const field = (surface: Surface, id: string, formId: string): string => String(surface.model.form({ pagePath: [], formId })?.fields[id]?.value ?? '')
const fields = (id: string, kind: 'input' | 'number' | 'secret' | 'textarea', value: string | number | null): MayflyUiNode => ui.form({
  id: 'form', fields: [
    { id, kind, label: id, value } as never,
    { id: 'after', kind: 'input', label: 'after', value: '' },
  ],
})

describe('Backspace, however the terminal encodes it', () => {
  describe.each(BACKSPACES.map(data => [JSON.stringify(data), data] as const))('%s', (_name, backspace) => {
    it('edits the Other row of a question', async () => {
      expect(other(await onOther('a', 'b', 'c', backspace))).toBe('ab')
    })

    it('edits the text of a type-to-filter list and a slash-filter list', async () => {
      const items = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }]
      const typed = open(ui.list({ id: 'list', role: 'browse', selectedIds: [], filterable: true, items }))
      await typed.press('a', 'b', backspace)
      expect(typed.model.choice({ pagePath: [], controlId: 'list' })?.query).toBe('a')
      const slash = open(ui.list({ id: 'list', role: 'browse', selectedIds: [], filterable: true, filterMode: 'slash', items }))
      await slash.press('/', 'a', 'b', backspace)
      expect(slash.model.choice({ pagePath: [], controlId: 'list' })?.query).toBe('a')
    })

    it('starts editing a field that is not being edited', async () => {
      const rename = open(renamePanelModel('abc', translate))
      await rename.press(backspace)
      expect(field(rename, 'title', 'session-rename')).toBe('ab')
      const multi = open(fields('text', 'input', 'abc'))
      await multi.press(backspace, backspace)
      expect(field(multi, 'text', 'form')).toBe('a')
    })
  })

  it('edits the plan note after Esc left it', async () => {
    const plan = open(planReviewCard(translate))
    await plan.press(DOWN, DOWN, DOWN, 'a', 'b', 'c', ESC, '\x1b[127u')
    expect(plan.render()).toMatch(/\bab\b/u)
    expect(plan.render()).not.toMatch(/\babc\b/u)
  })

  it('begins an edit that Esc then ends, keeping what is left', async () => {
    const rename = open(renamePanelModel('abc', translate))
    expect(rename.hint()).toContain('Enter submit')
    await rename.press('\x7f')
    expect(rename.hint()).toContain('Esc done')
    await rename.press(ESC)
    expect(rename.hint()).toContain('Enter submit')
    expect(field(rename, 'title', 'session-rename')).toBe('ab')
  })

  it('takes number and secret fields too, and leaves an empty field empty', async () => {
    const number = open(fields('count', 'number', 123))
    await number.press('\x1b[127u')
    expect(number.render()).toMatch(/\b12\b/u)
    const secret = open(fields('key', 'secret', 'abc'))
    await secret.press('\x7f')
    expect(field(secret, 'key', 'form')).toBe('ab')
    const empty = open(fields('text', 'input', ''))
    await empty.press('\x7f')
    expect(field(empty, 'text', 'form')).toBe('')
  })

  it('types encoded printable keys wherever raw ones go', async () => {
    expect(other(await onOther('\x1b[97u', '\x1b[32u', '\x1b[27;1;98~'))).toBe('a b')
    const rename = open(renamePanelModel('abc', translate))
    await rename.press('\x1b[100u')
    expect(field(rename, 'title', 'session-rename')).toBe('abcd')
    const list = open(ui.list({ id: 'list', role: 'browse', selectedIds: [], filterable: true, items: [{ id: 'a', label: 'Alpha' }] }))
    await list.press('\x1b[97u')
    expect(list.model.choice({ pagePath: [], controlId: 'list' })?.query).toBe('a')
    const numbered = open(questionnaireView(QUESTIONS, translate))
    await numbered.press('\x1b[49u')
    expect(asked(numbered)).toBe('q2')
  })
})

describe('the text row is an editor', () => {
  it.each([
    ['moves the caret with ← before typing', [LEFT, 'X'], 'abXc'],
    ['moves the caret with → after ←', [LEFT, LEFT, RIGHT, 'X'], 'abXc'],
    ['takes Home and End for the caret', [HOME, 'X', END, 'Y'], 'XabcY'],
    ['takes Ctrl+A', [CTRL_A, 'X'], 'Xabc'],
    ['removes before the caret with Backspace', [LEFT, '\x7f'], 'ac'],
    ['removes under the caret with Delete', [LEFT, DELETE], 'ab'],
    ['clears up to the caret with Ctrl+U', [LEFT, CTRL_U], 'c'],
    ['keeps its text on Tab and Ctrl+J', [TAB, CTRL_J, '\x1b[Z'], 'abc'],
    ['keeps its caret at the end on →', [RIGHT, RIGHT, 'X'], 'abcX'],
  ])('%s', async (_name, keys, expected) => {
    expect(other(await onOther('a', 'b', 'c', ...keys))).toBe(expected)
  })

  it('removes a word with Ctrl+W', async () => {
    expect(other(await onOther('a', 'b', ' ', 'c', 'd', CTRL_W))).toBe('ab ')
  })

  it('removes a whole character, however many code units it takes', async () => {
    expect(other(await onOther(paste('a👍🏽b'), LEFT, '\x7f'))).toBe('ab')
  })

  it('keeps the line breaks of a paste and drops its control bytes', async () => {
    expect(other(await onOther('a', paste('l1\r\nl2\x07\x1b[31m!')))).toBe('al1\nl2!')
    expect(other(await onOther(paste('one\n'), LEFT, 'X'))).toBe('oneX\n')
  })

  it('inserts a paste at the caret', async () => {
    expect(other(await onOther('a', 'c', LEFT, paste('b')))).toBe('abc')
  })

  it('draws the caret on the character it stands on, and after the text at the end', async () => {
    const surface = await onOther('a', 'b', 'c')
    const painted = (): string => compiledRow(surface)
    expect(painted()).toContain('abc\x1b[7m \x1b[27m')
    await surface.press(LEFT)
    expect(painted()).toContain('ab\x1b[7mc\x1b[27m')
    await surface.press(HOME)
    expect(painted()).toContain('\x1b[7ma\x1b[27mbc')
  })

  it('wraps a long text so all of it stays in sight, within the width', async () => {
    const surface = open(questionnaireView(QUESTIONS, translate), 30)
    const long = 'word '.repeat(20).trim()
    await surface.press(DOWN, DOWN, paste(long))
    const rows = surface.render().split('\n')
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(30)
    expect(rows.join(' ').match(/word/gu)).toHaveLength(20)
  })

  it('wraps a pasted line break into a row of its own, and repaints the caret after it', async () => {
    const surface = await onOther(paste('one\ntwo'))
    const rows = surface.render().split('\n')
    expect(rows.some(row => row.includes('one'))).toBe(true)
    expect(rows.some(row => row.trim().startsWith('two'))).toBe(true)
    await surface.press(LEFT, LEFT, LEFT, LEFT)
    expect(compiledRow(surface)).toContain('one\x1b[7m \x1b[27m')
  })

  it('picks up a text the model changed, and survives a caret left past it', async () => {
    const surface = await onOther('a', 'b', 'c', LEFT)
    surface.model.updateChoice({ pagePath: FIRST, controlId: 'options' }, { kind: 'input', id: 'other', text: 'x' })
    surface.render()
    expect(compiledRow(surface)).toContain('x')
    await surface.press('y')
    expect(other(surface)).toBe('xy')
  })

  it('leaves the row with ↑/↓ and keeps the draft', async () => {
    const surface = await onOther('a', 'b')
    await surface.press(UP)
    expect(other(surface)).toBe('ab')
    await surface.press(DOWN, 'c')
    expect(other(surface)).toBe('abc')
  })
})

describe('the plain arrows of a wizard', () => {
  it('walk the questions from an option row, and name that in the hint', async () => {
    const surface = open(questionnaireView(QUESTIONS, translate))
    expect(surface.hint()).toContain('←/→ question')
    expect(surface.hint()).not.toContain('Alt+')
    await surface.press(RIGHT)
    expect(asked(surface)).toBe('q2')
    await surface.press(LEFT)
    expect(asked(surface)).toBe('q1')
    await surface.press(LEFT)
    expect(asked(surface)).toBe('q1')
  })

  it('walk them from the empty Other row', async () => {
    const surface = await onOther(RIGHT)
    expect(asked(surface)).toBe('q2')
  })

  it('belong to the caret once the row holds text; ← at its start and Alt+→ still go on', async () => {
    const surface = await onOther('a')
    expect(surface.hint()).toContain('Alt+←/→ question')
    await surface.press(RIGHT)
    expect(asked(surface)).toBe('q1')
    await surface.press(LEFT)
    expect(asked(surface)).toBe('q1')
    await surface.press(ALT_RIGHT)
    expect(asked(surface)).toBe('q2')
    await surface.press(LEFT)
    expect(asked(surface)).toBe('q1')
  })

  it('leave ordinary tabs to Alt from their rows', async () => {
    const list = ui.list({ id: 'rows', role: 'browse', selectedIds: [], autofocus: true, items: [{ id: 'a', label: 'Row' }] })
    const surface = open(ui.stack.column([
      ui.tabs({ id: 'pages', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.child(list, { tab: { controlId: 'pages', itemId: 'one' } }),
      ui.child(ui.text('Second page'), { tab: { controlId: 'pages', itemId: 'two' } }),
    ]))
    expect(surface.hint()).toContain('Alt+←/→ tabs')
    await surface.press(RIGHT)
    expect(surface.render()).not.toContain('Second page')
    await surface.press(ALT_RIGHT)
    expect(surface.render()).toContain('Second page')
  })

  it('move a focused strip, the hint keeping Alt', async () => {
    const list = ui.list({ id: 'rows', role: 'browse', selectedIds: [], autofocus: true, items: [{ id: 'a', label: 'Row' }] })
    const surface = open(ui.stack.column([
      ui.tabs({ id: 'pages', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.child(list, { tab: { controlId: 'pages', itemId: 'one' } }),
      ui.child(ui.text('Second page'), { tab: { controlId: 'pages', itemId: 'two' } }),
    ]))
    await surface.press(ALT_UP)
    expect(surface.hint()).toContain('Alt+←/→ tabs')
    await surface.press(RIGHT)
    expect(surface.render()).toContain('Second page')
    await surface.press(RIGHT)
    expect(surface.render()).toContain('Second page')
    await surface.press(LEFT)
    expect(surface.render()).not.toContain('Second page')
  })
})

/** The Other row's line(s) with their ANSI, which `plainBlock` strips: the caret is an attribute, not a character. */
function compiledRow(surface: Surface): string {
  return surface.renderRaw().join('\n')
}

