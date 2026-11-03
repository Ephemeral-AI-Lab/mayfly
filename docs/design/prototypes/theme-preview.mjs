#!/usr/bin/env node
/**
 * A specimen of each palette in `theme-palettes.mjs`: the welcome banner with the s10 mark, a stretch of conversation (a prompt, a
 * Markdown answer, an edit with its diff, a failed and a retried call), a command panel, the editor, and the status
 * row, each painted with the token its shipped component uses (`core/ui-list-paint.ts`, `core/ui-patterns.ts`,
 * `core/markdown-rows.ts`, `core/diff-align.ts`, `core/ui-loader-animation.ts`). Every cell is drawn on the
 * palette's canvas, so the specimen shows the palette as designed whatever the terminal's own background is.
 *
 *   node docs/design/prototypes/theme-preview.mjs                 every proposal, two side by side when the terminal is wide enough
 *   node docs/design/prototypes/theme-preview.mjs tide dusk       the named palettes
 *   node docs/design/prototypes/theme-preview.mjs --shipped       each shipped light, ocean, and paper palette beside its replacement
 *   node docs/design/prototypes/theme-preview.mjs --width 70      another specimen width (default 60)
 *   node docs/design/prototypes/theme-preview.mjs --columns 1     one specimen per row
 *
 * @module docs/design/prototypes/theme-preview
 */

import { LOGOS } from './logo-preview.mjs'
import { ALL, SHIPPED, mix, themeById } from './theme-palettes.mjs'

const argv = process.argv.slice(2)
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback }
const W = Number(opt('width', 60))
const TERM = process.stdout.columns || 200
const COLUMNS = Number(opt('columns', TERM >= W * 2 + 3 ? 2 : 1))
const GAP = '  '

// ======================================================================= paint
// A run is [text, style]: style names a token (`fg`), and optionally `bold`, `inverse`, a background token (`bg`), or
// a literal hex (`hex`, for derived shades). A line is a list of runs; `line()` pads it to the specimen width on the canvas.
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';')
const cells = s => [...s].length

function paintRun(theme, [text, style = {}], canvas) {
  const fg = style.hex ?? theme.foregrounds[style.fg ?? 'text']
  const bg = style.bg === undefined ? canvas : theme.backgrounds[style.bg] ?? style.bg
  const [ink, paper] = style.inverse ? [bg, fg] : [fg, bg]
  return `${style.bold ? '\x1b[1m' : ''}\x1b[38;2;${rgb(ink)};48;2;${rgb(paper)}m${text}\x1b[0m`
}

/** One specimen row: the runs, then canvas (or `fill`, a background token) to the specimen width. */
function line(theme, runs, fill) {
  const used = runs.reduce((n, [text]) => n + cells(text), 0)
  const pad = Math.max(0, W - used)
  const canvas = fill === undefined ? theme.canvas : theme.backgrounds[fill]
  const clipped = []
  let room = W
  for (const [text, style = {}] of runs) {
    if (room <= 0) break
    const chars = [...text]
    clipped.push([chars.slice(0, room).join(''), { ...(fill === undefined ? {} : { bg: fill }), ...style }])
    room -= Math.min(room, chars.length)
  }
  return clipped.map(run => paintRun(theme, run, canvas)).join('') + paintRun(theme, [' '.repeat(pad)], canvas)
}

// ======================================================================= the specimen
// The s10 mark (`logo-preview.mjs`) in quadrant blocks: two pixels per cell across and down, `B`/`T` in the body ink,
// `W` in the wing ink. A shipped palette has no inks, so its mark takes `primary` and `accent`.
const S10 = LOGOS.find(logo => logo.id === 's10').rows
const QUAD = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'

/** The mark as rows of cells, each `[glyph, hex]` or a blank. */
function mark(theme) {
  const [body, wing] = theme.logoInks ?? [theme.foregrounds.primary, theme.foregrounds.accent]
  const ink = { B: body, T: body, W: wing }
  const rows = []
  for (let y = 0; y < S10.length; y += 2) {
    const cellsOfRow = []
    for (let x = 0; x < S10[0].length; x += 2) {
      const quad = [S10[y][x], S10[y][x + 1], S10[y + 1][x], S10[y + 1][x + 1]].map(k => ink[k] ?? null)
      const hex = quad.find(Boolean)
      cellsOfRow.push(hex === undefined ? [' '] : [QUAD[quad.reduce((m, q, i) => (q === hex ? m | (1 << i) : m), 0)], { hex }])
    }
    rows.push(cellsOfRow)
  }
  return rows
}

/** The compact banner's lines beside the mark (PR 22 option B), as `transcript/banner.ts` paints them. */
const BANNER_LINES = [
  [['mayfly', { fg: 'primary', bold: true }], [' v0.1.3', { fg: 'textMuted' }]],
  [['ephemeral agents, enduring works', { fg: 'accent' }]],
  [['deepseek-chat · deepseek', { fg: 'modelHighlight' }]],
  [['~/dev/mayfly', { fg: 'muted' }]],
]

/** The breath loader's six shades: `primary` blended toward `textMuted` (`breathPaint`). */
const breath = theme => [0.15, 0.35, 0.55, 0.75, 0.9, 1].map(t => mix(theme.foregrounds.textMuted, theme.foregrounds.primary, t))

/** A code row through the highlighter's paints (`codePaints` in core/content-rows.ts). */
const code = (...runs) => runs.map(([text, kind]) => [text, { fg: { kw: 'primary', str: 'success', num: 'warning', type: 'accent', cmt: 'muted' }[kind] ?? 'text' }])

function specimen(theme) {
  const L = (runs, fill) => line(theme, runs, fill)
  const rows = []
  const blank = () => rows.push(L([]))

  // Title of the specimen, not part of the product.
  rows.push(L([[` ${theme.name}`, { fg: 'textStrong', bold: true }], [`  ${theme.dark ? 'dark' : 'light'} · ${theme.canvas}`, { fg: 'textMuted' }]]))
  blank()

  // Banner.
  mark(theme).forEach((cellsOfRow, i) => rows.push(L([[' '], ...cellsOfRow, ['  '], ...BANNER_LINES[i]])))
  blank()

  // Conversation.
  rows.push(L([[' › ', { fg: 'roleUser', bold: true }], ['Make the light theme match the default one.']]))
  blank()
  rows.push(L([[' ● '], ['The palette lives in '], ['theme-light.ts', { fg: 'mdCode' }], ['. '], ['Two', { fg: 'textStrong', bold: true }], [' steps:']]))
  rows.push(L([['   • ', { fg: 'mdListBullet' }], ['reuse the dark '], ['ladder', { fg: 'textStrong', bold: true }], [' of neutral inks']]))
  rows.push(L([['   • ', { fg: 'mdListBullet' }], ['follow '], ['the recipe', { fg: 'mdLink' }], [' (docs/design/prototypes)', { fg: 'mdLinkUrl' }]]))
  rows.push(L([['   │ ', { fg: 'mdQuoteBorder' }], ['Scarce violet ink: one primary per surface.', { fg: 'mdQuote' }]]))
  blank()
  rows.push(L([[' ✓ ', { fg: 'success' }], ['Edit', { fg: 'textStrong', bold: true }], ['(core/theme-light.ts)', { fg: 'muted' }], [' · '], ['+2', { fg: 'diffAdded' }], [' '], ['−1', { fg: 'diffRemoved' }]]))
  const diff = (n, sign, runs, band) => rows.push(L([[`   ${String(n).padStart(2)} `, { fg: 'muted' }], [sign === ' ' ? '  ' : `${sign} `, { fg: sign === '+' ? 'diffAdded' : 'diffRemoved' }], ...runs], band))
  diff(11, ' ', code(['export const ', 'kw'], ['LIGHT', 'type'], [' = {']))
  diff(12, '−', code(['  name: ', ''], ["'Light'", 'str'], [',']), 'diffRemovedBg')
  diff(12, '+', code(['  name: ', ''], ["'Mayfly Light'", 'str'], [',']), 'diffAddedBg')
  diff(13, '+', code(['  ', ''], ['// one hue, five tiers', 'cmt']), 'diffAddedBg')
  diff(14, ' ', code(['  steps: ', ''], ['4', 'num'], [',']))
  rows.push(L([[' ✗ ', { fg: 'error' }], ['Bash', { fg: 'textStrong', bold: true }], ['(pnpm test)', { fg: 'muted' }], [' · '], ['exit 1', { fg: 'error' }]]))
  rows.push(L([[' ⚠ ', { fg: 'warning' }], ['rate limited', { fg: 'warning' }], [' · retrying in 4s', { fg: 'muted' }]]))
  blank()

  // Command panel (overlay chrome): the brand rule, title, description, a choose list, the hint row.
  rows.push(L([['━'.repeat(W), { fg: 'primary' }]]))
  rows.push(L([['  '], ['Select a theme', { fg: 'textStrong', bold: true }]]))
  rows.push(L([['  '], ['The palette of the transcript, panels, and editor.', { fg: 'muted' }]]))
  blank()
  rows.push(L([['  '], ['→ ', { fg: 'primary', bold: true }], ['Tide', { fg: 'textStrong', bold: true }], ['  deep water, an aqua brand', { fg: 'muted' }]], 'selectedBg'))
  rows.push(L([['    '], [theme.name, { fg: 'primary' }], [' ✓', { fg: 'primary' }], ['  '], ['[current]', { fg: 'muted' }]]))
  rows.push(L([['    '], ['Linen'], ['  ink on paper', { fg: 'muted' }]]))
  rows.push(L([['    '], ['custom', { fg: 'muted' }], ['  — needs a palette file', { fg: 'muted' }]]))
  blank()
  rows.push(L([['  '], ['↑↓'], [' move', { fg: 'textMuted' }], [' · ', { fg: 'textMuted' }], ['Enter'], [' choose', { fg: 'textMuted' }], [' · ', { fg: 'textMuted' }], ['Esc'], [' close', { fg: 'textMuted' }]]))
  blank()

  // Editor (surface chrome) and the status row.
  const inner = W - 2
  const title = ' main '
  rows.push(L([['╭' + '─'.repeat(inner - cells(title) - 1), { fg: 'border' }], [title, { fg: 'textStrong', bold: true }], ['─╮', { fg: 'border' }]]))
  const prompt = [['› '], ['explain '], ['[', { fg: 'muted' }], ['Image #1', { fg: 'accent' }], [' 84 KB', { fg: 'muted' }], [' ×]', { fg: 'muted' }], [' the ladder'], [' ', { inverse: true }]]
  const promptCells = prompt.reduce((n, [t]) => n + cells(t), 0)
  rows.push(L([['│ ', { fg: 'border' }], ...prompt, [' '.repeat(Math.max(0, inner - 1 - promptCells)) + '│', { fg: 'border' }]]))
  rows.push(L([['╰' + '─'.repeat(inner) + '╯', { fg: 'border' }]]))
  const shades = breath(theme)
  rows.push(L([[' '], [' main ', { fg: 'primary', bold: true, inverse: true }], ['  '], ['deepseek-chat', { fg: 'modelHighlight' }], [' · ', { fg: 'textMuted' }], ...shades.map(hex => ['●', { hex }]), [' thinking 4s', { fg: 'muted' }], [' · ', { fg: 'textMuted' }], ['12%', { fg: 'muted' }]]))
  blank()

  // The scrollbar, the shell-mode frame, and the tone row, in one line each.
  rows.push(L([[' shell ', { fg: 'textMuted' }], ['╭─', { fg: 'shellMode' }], [' ! ', { fg: 'shellMode', bold: true }], ['git status', {}], [' ─╮', { fg: 'shellMode' }], ['   scroll ', { fg: 'textMuted' }], ['█', { fg: 'primary' }], ['│││││', { fg: 'muted' }]]))
  rows.push(L([[' tones ', { fg: 'textMuted' }], ['default ', {}], ['muted ', { fg: 'muted' }], ['primary ', { fg: 'primary' }], ['accent ', { fg: 'accent' }], ['user ', { fg: 'roleUser' }], ['ok ', { fg: 'success' }], ['warn ', { fg: 'warning' }], ['danger', { fg: 'error' }]]))
  return rows
}

// ======================================================================= main
function sideBySide(blocks) {
  const height = Math.max(...blocks.map(b => b.length))
  return Array.from({ length: height }, (_, i) => blocks.map(b => b[i] ?? ' '.repeat(W)).join(GAP))
}

const ids = argv.filter((a, i) => !a.startsWith('--') && !['--width', '--columns'].includes(argv[i - 1]))
let groups
if (argv.includes('--shipped')) {
  groups = SHIPPED.map(old => [old, themeById(old.replacedBy)])
} else {
  const themes = ids.length > 0 ? ids.map(themeById).filter(Boolean) : ALL
  groups = []
  for (let i = 0; i < themes.length; i += COLUMNS) groups.push(themes.slice(i, i + COLUMNS))
}
const out = []
for (const group of groups) {
  const blocks = group.map(specimen)
  if (COLUMNS >= group.length) out.push(...sideBySide(blocks), '')
  else for (const b of blocks) out.push(...b, '')
}
process.stdout.write(`${out.join('\n')}\n`)
