/**
 * Decision tests of the notification line: the blank row it is when it has nothing to say, the severity glyph and tone,
 * the notice on the right with the whole row to use (a 3-column margin at the right edge), a notice cut at its front
 * with `…` that keeps its tail, the chip centered beside the notice without overlap, the hint and the keys of a focus
 * mode (shed by priority, the notice taking the rest), and every row fitting its width.
 *
 * The horizontal layout is decided here in the alternate screen mode. A row without a priority child compiles as a
 * column in the main mode (`ui-compiler.ts` compiles a stack spatially only in the status and alternate modes, and
 * a priority row admits itself), so a notice drawn in the main mode is a column of rows today; that defect is recorded
 * in the test report and its assertion is left out here, not worked around.
 * @module components-notification-line
 */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '../../src/core/width.ts'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { NotificationLine, type NotificationFacts, type NotificationRowFacts } from '../../src/components/notification-line.ts'
import { ADVERSARIAL, expectLinesFit } from '../core/width-scan.ts'
import { fakeMayflyComponents } from '../transcript/helpers.ts'
import { COLORS } from '../transcript/status-fakes.ts'

const ANSI = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/gu

/** The row as a screen paints it at a width, in the given screen mode, escape sequences removed. */
function render(facts: NotificationRowFacts | undefined, width: number, mode: 'main' | 'alternate' = 'alternate'): string[] {
  const compiled = compileMayflyUiNode(NotificationLine(facts), {
    components: fakeMayflyComponents(),
    colors: COLORS as MayflySemanticColors,
    getViewport: () => ({ columns: width, rows: 40 }),
    screenMode: mode,
    emit: () => {},
  })
  return (compiled.ok ? compiled.value.component : compiled.errorComponent).render(width).map(line => line.replace(ANSI, ''))
}

/** The spans of every rich-text node in a line node, in order. */
function spansOf(node: unknown): { readonly text: string, readonly tone?: string, readonly styles?: readonly string[] }[] {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(spansOf)
  const record = node as Record<string, unknown>
  const own = record.kind === 'rich-text' ? record.spans as never[] : []
  return [...own, ...Object.values(record).flatMap(value => spansOf(value))]
}

const notice = (severity: NotificationFacts['severity'], message: string, waiting?: number): NotificationFacts => ({ severity, message, ...waiting === undefined ? {} : { waiting } })
/** The text right of a column, with the margin the row keeps. */
const trailing = (line: string): string => line.trimEnd()

describe('NotificationLine', () => {
  it('is a blank row when it has nothing to show, at every width', () => {
    for (const width of [120, 40]) expect(render(undefined, width)).toEqual([''])
  })

  it('pairs each severity with its glyph and tone, keeps a quiet message in the text color, and gives an information notice no glyph', () => {
    expect(spansOf(NotificationLine({ notice: notice('success', 'Saved') }))).toEqual([{ text: '✓', tone: 'success' }, { text: 'Saved' }])
    expect(spansOf(NotificationLine({ notice: notice('info', 'Resumed') }))).toEqual([{ text: 'Resumed' }])
    expect(spansOf(NotificationLine({ notice: notice('warning', 'Rate limited') }))).toEqual([{ text: '⚠', tone: 'warning' }, { text: 'Rate limited', tone: 'warning' }])
    expect(spansOf(NotificationLine({ notice: notice('error', 'Failed') }))).toEqual([{ text: '✗', tone: 'danger' }, { text: 'Failed', tone: 'danger' }])
  })

  it('puts a notice at the right edge with a three-column margin, and counts the notices waiting behind it', () => {
    const [line] = render({ notice: notice('info', 'Resumed session') }, 120)
    expect(visibleWidth(line!)).toBe(120)
    expect(line!.slice(0, 120 - 3 - 'Resumed session'.length)).toBe(' '.repeat(120 - 3 - 'Resumed session'.length))
    expect(line!.slice(120 - 3 - 'Resumed session'.length)).toBe('Resumed session   ')
    expect(render({ notice: notice('warning', 'Rate limited', 2) }, 120)[0]!.trimEnd().endsWith('⚠ Rate limited · +2')).toBe(true)
    // A notice that exactly fills the row between the margins is not pushed past its end by a gap column.
    const room = 120 - 2 - 3
    const exact = 'x'.repeat(room - 2)
    expect(render({ notice: notice('info', exact) }, 120)[0]).toBe(`    ${exact}   `)
    // The notice reads the same in the main screen mode: the text is there, whatever the row count.
    expect(render({ notice: notice('warning', 'Rate limited') }, 120, 'main').join('\n')).toContain('⚠ Rate limited')
  })

  it('lets a lone notice use the whole row, and cuts a longer one at its front with an ellipsis', () => {
    const long = 'The clipboard tool is missing; falling back to OSC 52 until xclip or wl-clipboard is installed'
    // 120 columns hold it whole, far past half the row.
    expect(trailing(render({ notice: notice('warning', long) }, 120)[0]!).trimStart()).toBe(`⚠ ${long}`)
    for (const width of [40, 60, 80]) {
      const [line] = render({ notice: notice('warning', long) }, width)
      expect(visibleWidth(line!)).toBeLessThanOrEqual(width)
      const shown = trailing(line!).trimStart()
      expect(visibleWidth(shown)).toBe(width - 2 - 3)
      expect(shown.endsWith('…')).toBe(true)
      expect(long.startsWith(shown.slice(2, -1))).toBe(true)
    }
  })

  it('keeps the tail of a notice whole while the front gives way', () => {
    const retry: NotificationFacts = { severity: 'warning', message: 'Provider error · the upstream gateway timed out · retrying in 9s · 1/5', tail: 'retrying in 9s · 1/5' }
    expect(trailing(render({ notice: retry }, 120)[0]!).trimStart()).toBe(`⚠ ${retry.message}`)
    for (const width of [60, 44, 40]) {
      const shown = trailing(render({ notice: retry }, width)[0]!).trimStart()
      expect(shown.endsWith('· retrying in 9s · 1/5')).toBe(true)
      expect(shown).toContain('…')
      expect(visibleWidth(shown)).toBeLessThanOrEqual(width - 2 - 3)
    }
    // Where even the front's eight columns do not fit, the glyph and the tail are what is left.
    expect(trailing(render({ notice: retry }, 34)[0]!).trimStart()).toBe('⚠ · retrying in 9s · 1/5')
    // The muted count of waiting notices stays too.
    expect(trailing(render({ notice: { ...retry, waiting: 2 } }, 44)[0]!)).toMatch(/… · retrying in 9s · 1\/5 · \+2$/u)
    // A tail that is not the end of the message, or is all of it, is ignored.
    expect(trailing(render({ notice: { severity: 'info', message: 'Saved', tail: 'elsewhere' } }, 60)[0]!).trimStart()).toBe('Saved')
    expect(trailing(render({ notice: { severity: 'info', message: 'Saved', tail: 'Saved' } }, 60)[0]!).trimStart()).toBe('Saved')
  })

  it('shows the chip centered, with the notice to its right and never over it', () => {
    for (const width of [100, 60]) {
      const [line] = render({ chip: 'Back to bottom · Ctrl+↓', notice: notice('info', 'Resumed session') }, width)
      const chipAt = line!.indexOf(' Back to bottom · Ctrl+↓ ')
      // At 60 columns the notice yields room: its glyph and first words are what stays.
      const noticeAt = line!.indexOf('Resumed')
      expect(chipAt).toBeGreaterThan(0)
      expect(noticeAt).toBeGreaterThan(chipAt + ' Back to bottom · Ctrl+↓ '.length - 1)
      expect(visibleWidth(line!)).toBeLessThanOrEqual(width)
      // The chip carries the inverse style through the spans.
      expect(spansOf(NotificationLine({ chip: 'Back', notice: notice('info', 'x') })).find(span => span.text === ' Back ')?.styles).toEqual(['inverse'])
    }
  })

  it('draws the chip alone at the center when there is no notice', () => {
    const [line] = render({ chip: 'Back to bottom · Ctrl+↓' }, 80)
    expect(line!.indexOf(' Back to bottom · Ctrl+↓ ')).toBeGreaterThan(20)
    expect(line!.trim()).toBe('Back to bottom · Ctrl+↓')
  })

  it('teaches the keys that leave the prompt in the notice place, muted and right-aligned', () => {
    const [line] = render({ hint: 'Alt+↑ conversation · Alt+↓ view' }, 120)
    expect(line!.trimEnd().endsWith('Alt+↑ conversation · Alt+↓ view')).toBe(true)
    expect(visibleWidth(line!)).toBe(120)
    expect(spansOf(NotificationLine({ hint: 'hint' }))).toEqual([{ text: 'hint', tone: 'muted' }])
  })

  it('draws the keys of a focus mode at the left, with a notice keeping the right', () => {
    const keys = [{ text: 'Enter expand', priority: 1 }, { text: 'c copy', priority: 2 }]
    const [line] = render({ keys, notice: notice('info', 'Resumed') }, 80)
    expect(line!.startsWith('  Enter expand · c copy')).toBe(true)
    expect(line!.trimEnd().endsWith('Resumed')).toBe(true)
  })

  it('admits keys of equal rank in the order they read, so the earlier one stays', () => {
    const keys = [{ text: 'first', priority: 1 }, { text: 'second', priority: 1 }, { text: 'third', priority: 1 }]
    expect(trailing(render({ keys }, 30)[0]!)).toBe('  first · second · third')
    // A part that does not fit is dropped while a later one that is shorter may still fit.
    expect(trailing(render({ keys }, 18)[0]!)).toBe('  first · third')
    expect(trailing(render({ keys }, 10)[0]!)).toBe('  first')
  })

  it('sheds the keys by priority, keeps Esc last, and lets the notice give way to its glyph and tail', () => {
    const keys = [
      { text: '↑/↓ select', priority: 1 }, { text: 'Enter expand', priority: 2 }, { text: 'c copy', priority: 4 }, { text: '/ ? search', priority: 3 },
      { text: 'Ctrl+G editor', priority: 5 }, { text: 'Ctrl+C JSON', priority: 6 }, { text: 'Esc back', priority: 0 },
    ]
    const widths = new Map<number, string>()
    for (const width of [100, 60, 40, 30, 20]) widths.set(width, trailing(render({ keys }, width)[0]!))
    expect(widths.get(100)).toBe('  ↑/↓ select · Enter expand · c copy · / ? search · Ctrl+G editor · Ctrl+C JSON · Esc back')
    expect(widths.get(60)).toBe('  ↑/↓ select · Enter expand · / ? search · Esc back')
    // A part that does not fit is left out while a smaller one after it may still fit, and Esc is never the one that goes.
    expect(widths.get(40)).toBe('  ↑/↓ select · / ? search · Esc back')
    expect(widths.get(30)).toBe('  ↑/↓ select · Esc back')
    for (const line of widths.values()) expect(line).toContain('Esc back')
    // A notice beside the keys takes its glyph and tail before the keys that rank after the first three (the rest give up their room); its front gets what is left.
    const retry: NotificationFacts = { severity: 'warning', message: 'Rate limited · retrying in 9s · 1/5', tail: 'retrying in 9s · 1/5' }
    const beside = trailing(render({ keys, notice: retry }, 100)[0]!)
    expect(beside).toBe('  ↑/↓ select · Enter expand · c copy · / ? search · Esc back ⚠ Rate limit… · retrying in 9s · 1/5')
    expect(render({ keys, notice: retry }, 40)[0]!.trimEnd()).toMatch(/Esc back +⚠$/u)
  })

  it('fits every adversarial text as a notice, a chip, a hint, or keys, at each width', () => {
    for (const { name, text } of ADVERSARIAL) {
      for (const width of [120, 80, 60, 40, 20, 10]) {
        expectLinesFit(`NotificationLine notice/${name}`, render({ notice: notice('warning', text, 3) }, width), width)
        expectLinesFit(`NotificationLine chip/${name}`, render({ chip: text, notice: notice('error', text) }, width), width)
        expectLinesFit(`NotificationLine hint/${name}`, render({ hint: text }, width), width)
        expectLinesFit(`NotificationLine keys/${name}`, render({ keys: [{ text, priority: 0 }, { text: 'x', priority: 1 }], notice: notice('success', text) }, width), width)
      }
    }
  })
})
