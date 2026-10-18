/**
 * The launch screen's pure layout: the mark tiers (tiny, narrow, medium,
 * wide), row budgets that drop the list, slogan, then mark, the recent-session
 * row shapes (project/age/state/selection), the heading split, the fly-in's
 * delayed wordmark, and the locale-free version label.
 */

import { describe, expect, it } from 'vitest'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import { FLY_IN_TOTAL_MS, markColumns, scaleRows } from '../../src/core/quad-mark.ts'
import { MARK_ROWS } from '../../src/transcript/banner-art.ts'
import {
  SPLASH_LIST_MAX,
  SPLASH_MIN_WIDTH,
  SPLASH_RECENT_MAX,
  SPLASH_ROW_PROJECT_WIDTH,
  SPLASH_WIDE_WIDTH,
  composeSplashLines,
  type SplashContent,
  type SplashDeps,
  type SplashLabels,
  type SplashSession,
} from '../../src/transcript/splash.ts'
import { truncateToWidth, visibleWidth } from '../../src/core/width.ts'
import { plainColors } from '../helpers.ts'

const LABELS: SplashLabels = {
  slogan: 'ephemeral agents, enduring works',
  recent: 'Recent sessions',
  more: '\u2191 browse \u00b7 /sessions for all',
  moreFocused: '\u21b5 resume \u00b7 esc back',
  empty: 'No sessions here yet',
  emptyHint: 'Describe a task below to start one.',
}

function session(id: string, over: Partial<SplashSession> = {}): SplashSession {
  return { id, title: `Session ${id}`, project: 'mayfly', age: '2m ago', live: false, ...over }
}

function deps(over: Partial<SplashDeps> = {}): SplashDeps {
  return {
    colors: plainColors(),
    strong: text => text,
    truncate: truncateToWidth,
    visibleWidth,
    ...over,
  }
}

function content(over: Partial<SplashContent> = {}): SplashContent {
  return {
    version: '1.2.3',
    labels: LABELS,
    recent: [session('a'), session('b', { live: true }), session('c', { project: 'web', age: '3h ago' }), session('d')],
    ...over,
  }
}

const QUADRANT = /[▘▝▀▖▌▞▛▗▚▐▜▄▙▟█]/u

/** Remove ANSI styling so ellipsis text is readable. */
function plain(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/gu, '')
}

/** Rows around the widest list block, for width-bound assertions. */
function assertWidths(rows: readonly string[], width: number): void {
  for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
}

describe('composeSplashLines', () => {
  it('renders nothing for a non-positive width or row count', () => {
    expect(composeSplashLines(deps(), content(), 0, 20)).toEqual([])
    expect(composeSplashLines(deps(), content(), 60, 0)).toEqual([])
    expect(composeSplashLines(deps(), content(), -1, -1)).toEqual([])
  })

  it('drops the mark, list, and chrome to the wordmark and slogan below the minimum width', () => {
    const rows = composeSplashLines(deps(), content(), SPLASH_MIN_WIDTH - 1, 12)
    // Five blank rows center the two-line block on twelve.
    expect(rows).toHaveLength(7)
    expect(rows.join('\n')).toContain('mayfly v1.2.3')
    expect(rows.join('\n')).toContain('ephemeral agents, enduring works')
    expect(rows.join('\n')).not.toContain('Recent sessions')
    expect(QUADRANT.test(rows.join('\n'))).toBe(false)
    assertWidths(rows, SPLASH_MIN_WIDTH - 1)
  })

  it('drops the stage on a one-row screen with no room for the mark', () => {
    const rows = composeSplashLines(deps(), content(), 30, 1)
    expect(rows).toEqual([`${' '.repeat(8)}mayfly v1.2.3`])
    expect(QUADRANT.test(rows[0]!)).toBe(false)
  })

  it('centers a one-column screen without ever measuring below zero', () => {
    const rows = composeSplashLines(deps(), content(), 1, 3)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('mayfly')
    expect(rows[1]).toContain('.')
    expect(visibleWidth(rows[1]!)).toBeLessThanOrEqual(1)
  })

  it('draws the small mark and a title/age list from the minimum width', () => {
    const rows = composeSplashLines(deps(), content(), SPLASH_MIN_WIDTH, 14)
    const text = rows.join('\n')
    expect(text).toContain('Recent sessions')
    expect(text).toContain('Session a')
    expect(text).toContain('2m ago')
    expect(text).not.toContain('mayfly web')
    expect(QUADRANT.test(text)).toBe(true)
    // The heading's right hint does not fit beside the left label at 36 list columns.
    expect(text).not.toContain(LABELS.more)
    expect(rows).toHaveLength(13)
    assertWidths(rows, SPLASH_MIN_WIDTH)
  })

  it('shows the focused key hint and the selected pointer when the list has the keyboard', () => {
    const rows = composeSplashLines(deps(), content({ focus: 1 }), SPLASH_MIN_WIDTH, 14)
    const text = rows.join('\n')
    expect(text).toContain(LABELS.moreFocused)
    expect(text).toContain('\u203a')
    const selected = rows.find(row => row.includes('Session b'))
    expect(selected).toBeDefined()
    expect(selected).toContain('\u203a')
    expect(selected).toContain('\u25cf')
    // The list is 36 columns wide, centered in the 40-column screen (a 2-column lead each side).
    expect(visibleWidth(selected!)).toBe(SPLASH_MIN_WIDTH - 2)
  })

  it('centers the wider list and adds the project and age cells from the project width', () => {
    const rows = composeSplashLines(deps(), content({ focus: 0 }), 70, 14)
    const text = rows.join('\n')
    expect(text).toContain('Session c')
    expect(text).toContain('web')
    expect(text).toContain('3h ago')
    const first = rows.find(row => row.includes('Session a'))!
    expect(first.startsWith('   ')).toBe(true)
    // The 64-column list sits three columns in on a 70-column screen.
    expect(visibleWidth(first)).toBe(3 + SPLASH_LIST_MAX)
    // The selected row pads to the list width; the unselected rows keep the age at its right edge.
    expect(first.endsWith('2m ago')).toBe(true)
  })

  it('draws the double-size mark on a wide, tall screen and centers the block', () => {
    const rows = composeSplashLines(deps(), content(), 100, 22)
    // The 17-row block is centered in 22 rows: two blank rows above, three below.
    expect(rows).toHaveLength(19)
    expect(rows[0]).toBe('')
    expect(rows[1]).toBe('')
    // 8 pixel rows doubled make 8 cell rows; the mark is twice as wide and starts at the centered slot.
    const doubled = markColumns(scaleRows(MARK_ROWS, 2))
    expect(doubled).toBe(26)
    const firstMark = rows[2]!
    expect(firstMark.slice(0, Math.floor((100 - doubled) / 2))).toBe(' '.repeat(Math.floor((100 - doubled) / 2)))
    expect(visibleWidth(firstMark)).toBeGreaterThan(doubled)
    assertWidths(rows, 100)
  })

  it('keeps the small mark when the tall screen is too narrow for the double size', () => {
    const rows = composeSplashLines(deps(), content(), SPLASH_WIDE_WIDTH - 1, 24)
    expect(markColumns(MARK_ROWS)).toBe(13)
    expect(rows.some(row => QUADRANT.test(row))).toBe(true)
  })

  it('keeps the small mark when the wide screen lacks the rows for the double size', () => {
    const rows = composeSplashLines(deps(), content(), 100, 21)
    expect(rows.some(row => QUADRANT.test(row))).toBe(true)
  })

  it('leaves the list out while the catalog is still unread', () => {
    const unread = composeSplashLines(deps(), content({ recent: undefined }), 70, 20)
    expect(unread.join('\n')).not.toContain('Recent sessions')
    expect(unread.join('\n')).toContain('mayfly v1.2.3')
    expect(unread).toHaveLength(13)
    const read = composeSplashLines(deps(), content(), 70, 20)
    expect(read).toHaveLength(16)
  })

  it('shows the empty notice and its hint when the directory has no sessions', () => {
    const rows = composeSplashLines(deps(), content({ recent: [] }), 70, 18)
    const text = rows.join('\n')
    expect(text).toContain(LABELS.empty)
    expect(text).toContain(LABELS.emptyHint)
    expect(text).not.toContain('Recent sessions')
    // The empty notice is centered with the list block.
    const notice = rows.find(row => row.includes(LABELS.empty))!
    expect(notice.startsWith('   ')).toBe(true)
  })

  it('truncates the empty notice to the list width', () => {
    const labels = { ...LABELS, empty: 'x'.repeat(120), emptyHint: 'y'.repeat(120) }
    const rows = composeSplashLines(deps(), content({ labels, recent: [] }), 70, 18)
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(70)
    expect(plain(rows.join('\n'))).toContain('...')
    expect(rows.join('\n')).not.toContain('x'.repeat(120))
  })

  it('drops the slogan before the mark and the mark before the wordmark when rows run out', () => {
    const six = composeSplashLines(deps(), content(), SPLASH_MIN_WIDTH, 6)
    expect(six.join('\n')).toContain('mayfly')
    expect(six.join('\n')).not.toContain('ephemeral agents')
    expect(QUADRANT.test(six.join('\n'))).toBe(true)
    expect(six).toHaveLength(6)

    const five = composeSplashLines(deps(), content(), SPLASH_MIN_WIDTH, 5)
    expect(five.join('\n')).toContain('mayfly')
    expect(five.join('\n')).not.toContain('ephemeral agents')
    expect(QUADRANT.test(five.join('\n'))).toBe(false)
    expect(five[0]).toBe('')
    expect(five[1]).toBe('')
    expect(five).toHaveLength(3)

    const seven = composeSplashLines(deps(), content(), SPLASH_MIN_WIDTH, 7)
    expect(seven.join('\n')).toContain('ephemeral agents')
    expect(seven.join('\n')).not.toContain('Recent sessions')
    expect(seven).toHaveLength(7)
  })

  it('lists at most four sessions and never more rows than the budget', () => {
    const many = Array.from({ length: 8 }, (_, index) => session(String(index)))
    const rows = composeSplashLines(deps(), content({ recent: many }), 70, 20)
    const text = rows.join('\n')
    for (let index = 0; index < SPLASH_RECENT_MAX; index += 1) expect(text).toContain(`Session ${String(index)}`)
    expect(text).not.toContain('Session 4')
    expect(rows.length).toBeLessThanOrEqual(20)
  })

  it('leaves the list out when there is no room for its heading and one row', () => {
    const nine = composeSplashLines(deps(), content(), 70, 9)
    expect(nine.join('\n')).not.toContain('Recent sessions')
    // Seven header rows are centered in nine: one blank above and below.
    expect(nine).toHaveLength(8)
    // Ten rows leave one row for a session under the heading.
    const ten = composeSplashLines(deps(), content(), 70, 10)
    expect(ten.join('\n')).toContain('Recent sessions')
    expect(ten.join('\n')).toContain('Session a')
    expect(ten.join('\n')).not.toContain('Session b')
    expect(ten).toHaveLength(10)
  })

  it('keeps the wordmark off screen until the mark is most of the way in', () => {
    const before = composeSplashLines(deps(), content(), 70, 20, FLY_IN_TOTAL_MS * 0.55 - 1)
    expect(before.join('\n')).not.toContain('mayfly v1.2.3')
    expect(before.join('\n')).toContain('Recent sessions')
    const after = composeSplashLines(deps(), content(), 70, 20, FLY_IN_TOTAL_MS * 0.55)
    expect(after.join('\n')).toContain('mayfly v1.2.3')
    const rest = composeSplashLines(deps(), content(), 70, 20, FLY_IN_TOTAL_MS)
    expect(rest).toEqual(composeSplashLines(deps(), content(), 70, 20))
    assertWidths(before, 70)
  })

  it('draws the fly-in mark at the flight start and in flight without escaping the width', () => {
    const start = composeSplashLines(deps(), content(), 70, 20, 0)
    expect(start.join('\n')).not.toContain('mayfly v1.2.3')
    const flying = composeSplashLines(deps(), content(), 70, 20, 650)
    expect(QUADRANT.test(flying.join('\n'))).toBe(true)
    assertWidths(start, 70)
    assertWidths(flying, 70)
  })

  it('truncates long titles and projects while padding every row to the list width', () => {
    const long = content({
      recent: [
        session('long', { title: 't'.repeat(200), project: 'p'.repeat(80), age: '2m ago' }),
        session('short', { title: 'short', project: 'ok' }),
      ],
    })
    const rows = composeSplashLines(deps(), long, 70, 20)
    const text = plain(rows.join('\n'))
    expect(text).toContain('...')
    expect(text).not.toContain('t'.repeat(80))
    expect(text).not.toContain('p'.repeat(20))
    const titleRow = rows.find(row => row.includes('t'.repeat(10)))!
    expect(visibleWidth(titleRow)).toBe(3 + SPLASH_LIST_MAX)
  })

  it('uses ASCII state dots and pointers in ASCII glyph mode', () => {
    const rows = composeSplashLines(deps({ ascii: true }), content({ focus: 1 }), 70, 16)
    const text = rows.join('\n')
    expect(text).toContain('*')
    expect(text).toContain('-')
    expect(text).toContain('>')
    expect(text).not.toContain('\u25cf')
    expect(text).not.toContain('\u25cb')
    expect(QUADRANT.test(text)).toBe(false)
  })

  it('truncates a left heading whose right hint does not fit, and keeps both with one column to spare', () => {
    const tight = composeSplashLines(deps(), content({ recent: [] }), 32, 12)
    // Below the minimum, the list disappears with the mark; a 36-column list drops the hint.
    expect(tight.join('\n')).not.toContain('Recent sessions')
    const dropped = composeSplashLines(deps(), content(), 40, 14)
    expect(dropped.join('\n')).toContain('Recent sessions')
    expect(dropped.join('\n')).not.toContain(LABELS.more)
    // 64 columns of list and the focused hint leave room for both sides.
    const kept = composeSplashLines(deps(), content({ focus: 0 }), 70, 14)
    expect(kept.join('\n')).toContain(LABELS.moreFocused)
  })

  it('keeps a non-release identity unprefixed', () => {
    expect(composeSplashLines(deps(), content({ version: 'nightly' }), 70, 8).join('\n')).toContain('mayfly nightly')
    expect(composeSplashLines(deps(), content({ version: '1.2.3' }), 70, 8).join('\n')).toContain('mayfly v1.2.3')
  })

  it('uses the theme paints for the mark, the wordmark, and a selected row', () => {
    const colors: MayflySemanticColors = {
      ...plainColors(),
      primary: text => `<p>${text}</p>`,
      textMuted: text => `<m>${text}</m>`,
      selectedBg: text => `<bg>${text}</bg>`,
      accent: text => `<a>${text}</a>`,
      textStrong: text => `<s>${text}</s>`,
      success: text => `<ok>${text}</ok>`,
      logoInks: [text => `<B>${text}</B>`, text => `<W>${text}</W>`, text => `<a>${text}</a>`, text => `<b>${text}</b>`, text => `<c>${text}</c>`],
    }
    const painted = composeSplashLines(deps({ colors }), content({ focus: 0 }), 70, 14).join('\n')
    expect(painted).toContain('<p>mayfly</p>')
    expect(painted).toContain('<bg>')
    expect(painted).toContain('<ok>')
    expect(painted).toContain('<B>')
  })

  it('never asks a row for more columns than the screen has', () => {
    for (const width of [SPLASH_MIN_WIDTH, SPLASH_ROW_PROJECT_WIDTH, 70, 100, 240]) {
      for (const rows of [6, 12, 22, 40]) {
        assertWidths(composeSplashLines(deps(), content(), width, rows), width)
      }
    }
  })
})
