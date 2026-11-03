#!/usr/bin/env node
/**
 * Terminal mockup of the transcript's welcome banner with the s10 logo. The chosen layout is option B: the mark at
 * normal size beside four lines (brand and version, slogan, model, directory), the way the Claude Code header sits.
 * It copies the layout rules of `packages/mayfly/src/transcript/banner.ts` (one-column gutter, two-column gap
 * between logo and status column, every over-wide line truncated, nothing wrapped) but draws its own colors and
 * imports nothing from Mayfly.
 *
 * On a terminal it plays the fly-in (`fly-in.mjs`) in place, as the banner would at the top of the transcript: the
 * mark enters from the right edge, flies left over the status column, and the text appears in its wake; it lands in
 * its slot, beats twice and rests.
 *
 *   node docs/design/prototypes/banner-preview.mjs              option B with the fly-in (r replays, q quits)
 *   node docs/design/prototypes/banner-preview.mjs --frame 400  one frame of the fly-in, at that millisecond
 *   node docs/design/prototypes/banner-preview.mjs --compare    the shipped banner and options A, B and C, then at 52 columns
 *   node docs/design/prototypes/banner-preview.mjs --width 90   another width
 *   node docs/design/prototypes/banner-preview.mjs --logo a6    another logo id from logo-preview.mjs
 *
 * @module docs/design/prototypes/banner-preview
 */

import { LOGOS, renderLogo, lift } from './logo-preview.mjs'
import { composite, flight, jitter, play, stamp, trail, wingsUp } from './fly-in.mjs'

const argv = process.argv.slice(2)
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback }
const WIDTH = Number(opt('width', process.stdout.columns || 100))
const NARROW = 52
const LOGO = LOGOS.find(l => l.id === opt('logo', 's10')) ?? LOGOS.find(l => l.id === 's10')

// ======================================================================= palette (theme-dark)
const C = {
  text: '#EDEDF2', strong: '#F5F5F7', muted: '#9AA3B8', faint: '#5C6476',
  accent: '#C9C0F0', primary: '#9A86E6', highlight: '#E9E6F4', border: '#45406B',
}
const GRADIENT = ['#F5F5F7', '#E9E5F6', '#DBD3F0', '#C9BEEA', '#B2A1EC', '#9A86E6', '#8371D6', '#6C5BBF']
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';')
const fg = (hex, s) => `\x1b[38;2;${rgb(hex)}m${s}\x1b[39m`
const bold = s => `\x1b[1m${s}\x1b[22m`
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '')
const cells = s => [...strip(s)].length
const padTo = (s, n) => s + ' '.repeat(Math.max(0, n - cells(s)))

/** Styled runs truncated to `max` cells, with an ellipsis where a run is cut. */
function fit(runs, max) {
  let out = '', room = max
  for (const [text, paint] of runs) {
    if (room <= 0) break
    const chars = [...text]
    if (chars.length <= room) { out += paint(text); room -= chars.length; continue }
    out += paint(room === 1 ? '…' : `${chars.slice(0, room - 1).join('')}…`)
    room = 0
  }
  return out
}

// ======================================================================= facts
const F = { version: '0.1.3-rc.2', model: 'deepseek-chat', provider: 'deepseek', cwd: '~/dev/mayfly' }
const strong = s => bold(fg(C.primary, s))
const accent = s => fg(C.accent, s)
const muted = s => fg(C.muted, s)
const faint = s => fg(C.faint, s)
const text = s => fg(C.text, s)
const highlight = s => fg(C.highlight, s)

// The shipped status column, keyed by row against an eight-row logo.
const FULL_STATUS = new Map([
  [1, [['mayfly', strong]]],
  [2, [['ephemeral agents, enduring works', accent]]],
  [4, [['Send /help for help information.', muted]]],
  [5, [[`Directory: ${F.cwd}`, text]]],
  [6, [[`Model:     ${F.model} · ${F.provider}`, highlight]]],
  [7, [[`Version:   ${F.version}`, text]]],
])

// ======================================================================= logos
const BRAILLE = [
  '⠱⣦⣄⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣠⣴⠎',
  '⠀⠙⢿⣿⣿⣷⣶⣤⣀⣀⣴⣶⣦⣀⣀⣤⣶⣾⣿⣿⡿⠋⠀',
  '⠀⠀⠀⠈⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠁⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠉⠉⠁⢸⣿⡇⠈⠉⠉⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⣿⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣿⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⡠⠊⠀⠑⢄⠀⠀⠀⠀⠀⠀⠀⠀⠀',
].map((row, i) => fg(GRADIENT[i], row))

// ======================================================================= banner layout
/**
 * Lay a logo and a status column side by side, the way `composeBannerLines` does.
 * @param art - logo lines.
 * @param status - status runs keyed by row.
 * @param width - viewport width; one gutter column comes off each side.
 * @param labelWidth - columns the shipped layout reserves for the labels when it sizes the value column.
 */
function banner(art, status, width, labelWidth) {
  const inner = width - 2
  const logoW = Math.max(...art.map(cells))
  const max = Math.max(0, inner - logoW - 2 - labelWidth)
  const rows = Math.max(art.length, ...status.keys()) + (status.size ? 0 : 0)
  const out = []
  for (let i = 0; i < Math.max(rows, art.length); i++) {
    const runs = status.get(i)
    out.push(` ${padTo(art[i] ?? '', logoW)}${runs ? `  ${fit(runs, max)}` : ''}`.replace(/ +$/, ''))
  }
  return out
}

/** Option B, the chosen banner: the mark beside brand and version, slogan, model, directory. */
const compact = (art, w) => banner(art, new Map([
  [0, [['mayfly', strong], [` v${F.version}`, faint]]],
  [1, [['ephemeral agents, enduring works', accent]]],
  [2, [[`${F.model} · ${F.provider}`, highlight]]],
  [3, [[F.cwd, muted]]],
]), w, 0)

const OPTIONS = [
  {
    title: 'Now: the braille mark',
    note: 'The shipped banner, for comparison.',
    render: w => banner(BRAILLE, FULL_STATUS, w, 11),
  },
  {
    title: 'A  s10 at double size, same layout',
    note: 'The doubled mark is exactly eight rows, so it drops into the shipped layout unchanged. 26 columns of logo.',
    render: w => banner(renderLogo(LOGO.rows, 2).lines, FULL_STATUS, w, 11),
  },
  {
    title: 'B  s10 at normal size, compact',
    note: 'Four rows, the way the Claude Code header sits: brand and version, slogan, model, directory. No labels, no help line.',
    render: w => compact(renderLogo(LOGO.rows).lines, w),
  },
  {
    title: 'C  s10 at normal size, every fact',
    note: 'Four rows that keep all six facts: version beside the brand, the help hint beside the directory.',
    render: w => banner(renderLogo(LOGO.rows).lines, new Map([
      [0, [['mayfly', strong], [` v${F.version}`, faint]]],
      [1, [['ephemeral agents, enduring works', accent]]],
      [2, [[`${F.model} · ${F.provider}`, highlight]]],
      [3, [[F.cwd, muted], ['  ·  /help for help', faint]]],
    ]), w, 0),
  },
]

// ======================================================================= fly-in
const FLY = 1100
const TOTAL = 1550

/** One frame of the banner fly-in at `t` milliseconds, `width` columns wide. */
function bannerFrame(t, width) {
  const rows = LOGO.rows, beat = LOGO.beat ?? lift(rows)
  const w = rows[0].length, h = rows.length
  const lines = compact(Array(Math.ceil(h / 2)).fill(' '.repeat(Math.ceil(w / 2))), width)
  const path = { from: [width * 2 + 2, 0], to: [2, 0], duration: FLY }
  const p = flight(t, path)
  const canvas = new Map()
  const drops = trail(t, FLY, (ts, n) => {
    const q = flight(ts, path)
    return [
      [q.x + w + 1 + Math.round(jitter(n) * 2), q.y + 2 + Math.round(jitter(n + 3) * 3)],
      [q.x + w + 3 + Math.round(jitter(n + 7) * 3), q.y + 1 + Math.round(jitter(n + 11) * (h - 3))],
    ]
  })
  const under = new Map(drops.map(([x, y, ink]) => [`${x},${y}`, ink]))
  stamp(canvas, wingsUp(t, FLY) ? beat : rows, p.x, p.y)
  // The text shows only where the mark has already passed: right of its trailing edge.
  const wake = Math.floor((p.x + w) / 2)
  return composite(lines, canvas, width, { visible: cx => cx >= wake, under })
}

// ======================================================================= main
const rule = w => faint('─'.repeat(w))
if (argv.includes('--compare')) {
  const out = ['']
  for (const o of OPTIONS) {
    out.push(`  ${bold(fg(C.text, o.title))}`, `  ${muted(o.note)}`, '')
    out.push(...o.render(WIDTH), '')
    out.push(`  ${faint(`at ${NARROW} columns`)}`, ` ${rule(NARROW - 2)}`, ...o.render(NARROW), ` ${rule(NARROW - 2)}`, '', '')
  }
  process.stdout.write(`${out.join('\n')}\n`)
} else if (opt('frame', null) !== null) {
  process.stdout.write(`${bannerFrame(Number(opt('frame', 0)), WIDTH).join('\n')}\n`)
} else {
  // The block the transcript would show: the banner, a blank row, then where the conversation starts.
  play(t => [...bannerFrame(t, WIDTH), '', ` ${faint('r replays · q quits')}`], TOTAL)
}
