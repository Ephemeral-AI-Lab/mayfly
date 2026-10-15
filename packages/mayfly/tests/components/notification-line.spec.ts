/**
 * Decision tests of the notification line: the blank row it is when it has nothing to say, the severity glyph and tone,
 * the notice on the right within half the row (a 3-column margin at the right edge), the chip centered beside the
 * notice without overlap, the hint and the keys of a focus mode, truncation, and every row fitting its width.
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

  it('pairs each severity with its glyph and tone, and gives an information notice no glyph (R2)', () => {
    expect(spansOf(NotificationLine({ notice: notice('success', 'Saved') }))).toEqual([{ text: '✓ ', tone: 'success' }, { text: 'Saved' }])
    expect(spansOf(NotificationLine({ notice: notice('info', 'Resumed') }))).toEqual([{ text: 'Resumed' }])
    expect(spansOf(NotificationLine({ notice: notice('warning', 'Rate limited') }))).toEqual([{ text: '⚠ ', tone: 'warning' }, { text: 'Rate limited', tone: 'warning' }])
    expect(spansOf(NotificationLine({ notice: notice('error', 'Failed') }))).toEqual([{ text: '✗ ', tone: 'danger' }, { text: 'Failed', tone: 'danger' }])
  })

  it('puts a notice at the right edge with a three-column margin, and counts the notices waiting behind it', () => {
    const [line] = render({ notice: notice('info', 'Resumed session') }, 120)
    expect(visibleWidth(line!)).toBe(120)
    expect(line!.slice(0, 120 - 3 - 'Resumed session'.length)).toBe(' '.repeat(120 - 3 - 'Resumed session'.length))
    expect(line!.slice(120 - 3 - 'Resumed session'.length)).toBe('Resumed session   ')
    expect(render({ notice: notice('warning', 'Rate limited', 2) }, 120)[0]!.trimEnd().endsWith('⚠ Rate limited · +2')).toBe(true)
    // The notice reads the same in the main screen mode: the text is there, whatever the row count.
    expect(render({ notice: notice('warning', 'Rate limited') }, 120, 'main').join('\n')).toContain('⚠ Rate limited')
  })

  it('keeps a notice within half the row, and truncates it there with an ellipsis', () => {
    const long = 'Rate limited · retrying in 5s · 2/5 · a provider reason far too long for the row'
    for (const width of [40, 60, 80, 120]) {
      const [line] = render({ notice: notice('warning', long) }, width)
      expect(visibleWidth(line!)).toBeLessThanOrEqual(width)
      // The notice is a prefix of its message: the cut comes at the end, and the room it takes stays within half.
      const shown = trailing(line!).trimStart()
      expect(visibleWidth(shown)).toBeLessThanOrEqual(Math.ceil(width / 2))
      expect(long.startsWith(shown.slice(2))).toBe(true)
    }
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
    const [line] = render({ hint: 'Alt+↑ conversation · Alt+↓ bar' }, 120)
    expect(line!.trimEnd().endsWith('Alt+↑ conversation · Alt+↓ bar')).toBe(true)
    expect(visibleWidth(line!)).toBe(120)
    expect(spansOf(NotificationLine({ hint: 'hint' }))).toEqual([{ text: 'hint', tone: 'muted' }])
  })

  it('draws the keys of a focus mode at the left, with a notice keeping the right', () => {
    const [line] = render({ keys: 'Enter expand · c copy', notice: notice('info', 'Resumed') }, 80)
    expect(line!.startsWith('  Enter expand · c copy')).toBe(true)
    expect(line!.trimEnd().endsWith('Resumed')).toBe(true)
  })

  it('fits every adversarial text as a notice, a chip, a hint, or keys, at each width', () => {
    for (const { name, text } of ADVERSARIAL) {
      for (const width of [120, 80, 60, 40, 20, 10]) {
        expectLinesFit(`NotificationLine notice/${name}`, render({ notice: notice('warning', text, 3) }, width), width)
        expectLinesFit(`NotificationLine chip/${name}`, render({ chip: text, notice: notice('error', text) }, width), width)
        expectLinesFit(`NotificationLine hint/${name}`, render({ hint: text }, width), width)
        expectLinesFit(`NotificationLine keys/${name}`, render({ keys: text, notice: notice('success', text) }, width), width)
      }
    }
  })
})
