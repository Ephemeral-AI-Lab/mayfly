/** The prompt over the real pi-tui editor: kill ring, undo, paste folding, multi-line rows, and one caret through layout. */
import { Context } from '@deepseek-ai/cordis'
import { CURSOR_MARKER, TuiMainScreen, setCapabilities, type Component } from '@earendil-works/pi-tui'
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js'
import { afterEach, describe, expect, it } from 'vitest'
import { ui, type MayflyPromptNode, type MayflyUiEvent } from '../../../ui/src/index.ts'
import { MayflyComponentsService } from '../../src/core/components.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import type { MayflySemanticColors, MayflyTheme } from '../../src/core/types.ts'
import { PROBE_PALETTE } from '../design/parity.ts'
import { FakeTerminal } from './fake-terminal.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from './width-scan.ts'

const ROLES = Object.keys(PROBE_PALETTE) as (keyof MayflySemanticColors)[]
const identityTheme = (): MayflyTheme => ({ colors: Object.fromEntries(ROLES.map(role => [role, (text: string) => text])) as unknown as MayflySemanticColors })
const strip = (row: string): string => row.replaceAll(CURSOR_MARKER, '').replace(/\x1b\[[0-9;]*m/gu, '')
const KEY = { altEnter: '\x1b\r', ctrlA: '\x01', ctrlK: '\x0b', ctrlY: '\x19', undo: '\x1f', enter: '\r', paste: '\x1b[200~', pasteEnd: '\x1b[201~' } as const

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function open(prompt: Omit<MayflyPromptNode, 'kind' | 'id'> = {}, width = 40) {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false })
  const terminal = new FakeTerminal()
  const tui = new TuiMainScreen(terminal)
  tui.start()
  const components = new MayflyComponentsService(new Context(), { theme: identityTheme(), tui })
  const events: MayflyUiEvent[] = []
  const endpoint = { prepare: async (event: MayflyUiEvent) => { events.push(event); return { reply: { kind: 'completed' as const }, publish: () => true } } }
  const model = new UiSurfaceModel('real', {
    scope: { kind: 'app', targetId: 'p' }, source: [], revision: 1, update: { reason: 'data' },
    node: ui.prompt({ id: 'p', autofocus: true, ...prompt }), events: endpoint, definition: { onEvent: {} },
  } as never)
  const runtime = new MayflyUiSurfaceRuntime(model)
  const result = compileMayflyUiSurfaceNode(model.node!, { components, colors: PROBE_PALETTE, getViewport: () => ({ columns: width, rows: 20 }), screenMode: 'alternate', emit: () => {}, contextHints: { enabled: true }, surfaceRuntime: runtime })
  if (!result.ok) throw new Error(result.message)
  result.value.focusTarget!.focused = true
  cleanups.push(() => { runtime.dispose(); model.dispose(); tui.stop() })
  const draft = (): string => model.prompt({ pagePath: [], controlId: 'p' })!.text
  return {
    events, draft, surface: result.value,
    rows: (): string[] => result.value.component.render(width).map(strip),
    raw: (): string => result.value.component.render(width).join('\n'),
    press: (...keys: string[]): void => { for (const key of keys) result.value.focusTarget!.handleInput?.(key) },
  }
}

describe('the prompt over the real editor', () => {
  it('types, wraps a long line under the symbol, and breaks a line with Alt+Enter', () => {
    const prompt = open({}, 20)
    prompt.press(...'hello')
    prompt.press(KEY.altEnter)
    prompt.press(...'world')
    expect(prompt.draft()).toBe('hello\nworld')
    expect(prompt.rows().map(row => row.trimEnd()).slice(0, 2)).toEqual(['> hello', '  world'])
    const wrapped = open({ value: 'word '.repeat(10) }, 20)
    expect(wrapped.rows().length).toBeGreaterThan(2)
    for (const row of wrapped.rows()) expect(row.length).toBeLessThanOrEqual(20)
    expect(wrapped.rows()[1]!.startsWith('  ')).toBe(true)
  })

  it('keeps the kill ring and undo the editor\'s own', () => {
    const prompt = open()
    prompt.press(...'hello world')
    prompt.press(KEY.ctrlA, KEY.ctrlK)
    expect(prompt.draft()).toBe('')
    prompt.press(KEY.ctrlY)
    expect(prompt.draft()).toBe('hello world')
    // The first undo takes the yank back, the second the kill: both are the editor's own steps.
    prompt.press(KEY.undo)
    expect(prompt.draft()).toBe('')
    prompt.press(KEY.undo)
    expect(prompt.draft()).toBe('hello world')
  })

  it('folds a large paste in the editor while the draft keeps its full text', () => {
    const prompt = open()
    const lines = Array.from({ length: 12 }, (_, index) => `line ${String(index)}`)
    prompt.press(`${KEY.paste}${lines.join('\n')}${KEY.pasteEnd}`)
    expect(prompt.draft()).toBe(lines.join('\n'))
    expect(prompt.rows()[0]).toMatch(/^> \[paste #1 \+\d+ lines\]/u)
    prompt.press(KEY.enter)
    expect(prompt.events.at(-1)).toMatchObject({ kind: 'submit', submission: { forms: [{ fields: expect.arrayContaining([{ id: 'text', change: 'set', value: lines.join('\n') }]) }] } })
    expect(prompt.rows()[0]!.trim()).toBe('>')
  })

  it('reads a paste that arrives in chunks as one paste, and a lone Enter chunk inside it as text', () => {
    const prompt = open()
    prompt.press(`${KEY.paste}one`, '\r', 'two', `${KEY.pasteEnd}`)
    expect(prompt.events.filter(event => event.kind === 'submit')).toEqual([])
    expect(prompt.draft()).toBe('one\rtwo'.replace('\r', '\n'))
  })

  it('draws exactly one cursor marker through layout and replay, and none once focus leaves', () => {
    const prompt = open({ tokens: [{ id: 't', label: 'x' }], placeholder: 'Ask' }, 30)
    for (const width of [30, 12]) {
      const frame = renderLayoutFrame(prompt.surface.component as Component, width, 5, () => {}).lines.join('')
      expect(frame.match(new RegExp(CURSOR_MARKER, 'gu'))).toHaveLength(1)
    }
    expect(prompt.raw().match(new RegExp(CURSOR_MARKER, 'gu'))).toHaveLength(1)
    prompt.press(...'ab')
    expect(prompt.raw().match(new RegExp(CURSOR_MARKER, 'gu'))).toHaveLength(1)
    prompt.surface.focusTarget!.focused = false
    expect(prompt.raw()).not.toContain(CURSOR_MARKER)
    expect(prompt.raw()).not.toContain('\x1b[7m')
  })

  it('shows a recalled message with the cursor at its end and edits it in place', () => {
    const prompt = open({ recall: [{ kind: 'history', text: 'run the scan' }] })
    prompt.press('\x1b[A')
    expect(prompt.rows()[0]!.trimEnd()).toMatch(/^> run the scan\s+↑ history 1\/1$/u)
    prompt.press(...'!')
    expect(prompt.draft()).toBe('run the scan!')
  })

  it.each(ADVERSARIAL.map(({ name, text }) => [name, text] as const))('keeps every row of the real editor within the width over %s', (name, text) => {
    for (const width of SCAN_WIDTHS) {
      const prompt = open({ value: text, tokens: [{ id: 't', label: 'Image #1', size: '84 KB' }], recall: [{ kind: 'history', text }] }, width)
      expectLinesFit(`prompt/${name}`, prompt.surface.component.render(width), width)
      prompt.press('\x1b[A')
      expectLinesFit(`prompt-recall/${name}`, prompt.surface.component.render(width), width)
    }
  })
})
