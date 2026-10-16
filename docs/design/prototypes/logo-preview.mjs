#!/usr/bin/env node
/**
 * Logo candidates for Mayfly, drawn the way the Claude Code mark is drawn: flat pixel art in quadrant blocks
 * (`▘▝▀▖▌▞▛▗▚▐▜▄▙▟█`), where each character cell holds 2×2 pixels and the eyes are holes left in the body.
 * One pixel is half a column wide and half a row tall, so a pixel is twice as tall as it is wide.
 *
 *   node docs/design/prototypes/logo-preview.mjs           the current round: s7 and s10 and their variants, header size and splash size
 *   node docs/design/prototypes/logo-preview.mjs --all     every candidate from every round
 *   node docs/design/prototypes/logo-preview.mjs <id>      one candidate
 *   node docs/design/prototypes/logo-preview.mjs --animate [id]   play the wing beat (q or Ctrl+C quits)
 *   node docs/design/prototypes/logo-preview.mjs --check   report cells that quadrant blocks cannot draw exactly
 *
 * @module docs/design/prototypes/logo-preview
 */

import { pathToFileURL } from 'node:url'

// ======================================================================= palette
const INK = {
  B: '#9A86E6', // body: the theme primary
  W: '#CFC6F5', // wings: a pale, glassy tint of the body
  T: '#9A86E6', // tails
  a: '#7D6BCB', // dissolving pixels, nearest to farthest
  b: '#5F519F',
  c: '#433A73',
  M: '#9A86E6', // wings in the body color, for the one-color variant
}

// ======================================================================= candidates
// Grids are pixel rows: a palette key per pixel, `.` for empty. Heights are even so the rows pair into cells.
const SAIL = [
  'T..............WW.........',
  'T.............WWWW........',
  '.T...........WWWWW........',
  '.T..T.......WWWWWW........',
  '..T..T.....WWWWWWW........',
  '...T..T...WWWWWWWW...BBB..',
  '....TTTTBBBBBBBBBBBBBBBBB.',
  '.......BBBBBBBBBBBBBBB.BBB',
  '..........BBBBBBBBBBBBBBB.',
  '...........B.B.....B.B....',
]

/** The wing beat's second frame: every wing pixel one row higher. */
export const lift = rows => rows.map((r, y) => [...r].map((c, x) => {
  const below = rows[y + 1]?.[x]
  if (below === 'W' || below === 'M') return below
  return c === 'W' || c === 'M' ? '.' : c
}).join(''))

export const LOGOS = [
  {
    id: 'hover',
    name: 'Hover',
    idea: 'Front view mid-flight: a squat body with big eyes, wings drawn as speed lines.',
    rows: [
      '........BBBBBBBB........',
      'WWWWWW.BBBBBBBBBB.WWWWWW',
      '.......BB.BBBB.BB.......',
      '..WWWW.BB.BBBB.BB.WWWW..',
      '.......BBBBBBBBBB.......',
      '....WW..BBBBBBBB..WW....',
      '.........T....T.........',
      '........T......T........',
    ],
    beat: [
      'WWWWWW..BBBBBBBB..WWWWWW',
      '.......BBBBBBBBBB.......',
      '..WWWW.BB.BBBB.BB.WWWW..',
      '.......BB.BBBB.BB.......',
      '....WW.BBBBBBBBBB.WW....',
      '........BBBBBBBB........',
      '.........T....T.........',
      '........T......T........',
    ],
  },
  {
    id: 'flicker',
    name: 'Flicker',
    idea: 'Hover whose wings fade out into pixels at the tips: in motion, and here for a moment.',
    rows: [
      '........BBBBBBBB........',
      'b.aaWW.BBBBBBBBBB.WWaa.b',
      '.......BB.BBBB.BB.......',
      '..b.WW.BB.BBBB.BB.WW.b..',
      '.......BBBBBBBBBB.......',
      '....WW..BBBBBBBB..WW....',
      '.........T....T.........',
      '........T......T........',
    ],
    beat: [
      'b.aaWW..BBBBBBBB..WWaa.b',
      '.......BBBBBBBBBB.......',
      '..b.WW.BB.BBBB.BB.WW.b..',
      '.......BB.BBBB.BB.......',
      '....WW.BBBBBBBBBB.WW....',
      '........BBBBBBBB........',
      '.........T....T.........',
      '........T......T........',
    ],
  },
  {
    id: 'hover-s',
    name: 'Hover S',
    idea: 'Hover cut to three rows, the same footprint as the Claude Code mark.',
    rows: [
      '......BBBBBBBBBB......',
      'WWWWW.BB.BBBB.BB.WWWWW',
      '......BB.BBBB.BB......',
      '..WWW.BBBBBBBBBB.WWW..',
      '.......BBBBBBBB.......',
      '........T....T........',
    ],
    beat: [
      'WWWWW.BBBBBBBBBB.WWWWW',
      '......BB.BBBB.BB......',
      '..WWW.BB.BBBB.BB.WWW..',
      '......BBBBBBBBBB......',
      '.......BBBBBBBB.......',
      '........T....T........',
    ],
  },
  {
    id: 'sail',
    name: 'Sail',
    idea: 'Side view at rest: wings folded upright like a sail, two long tails sweeping up behind.',
    rows: SAIL,
  },
  {
    id: 'trail',
    name: 'Trail',
    idea: 'Sail whose tails come apart into drifting pixels: ephemeral agents, enduring works.',
    rows: [
      'c..............WW.........',
      '...b..........WWWW........',
      '.c...........WWWWW........',
      '.....a......WWWWWW........',
      'c..b...a...WWWWWWW........',
      '..........WWWWWWWW...BBB..',
      '..b..a..BBBBBBBBBBBBBBBBB.',
      '........BBBBBBBBBBBBBB.BBB',
      '..........BBBBBBBBBBBBBBB.',
      '...........B.B.....B.B....',
    ],
  },
  // ----------------------------------------------------------------- round 4: Hover S with a wider face
  ...[
    {
      id: 's1', name: 'Wide', idea: 'The face widened from 10 to 14 pixels; slit eyes set apart.',
      rows: [
        '......BBBBBBBBBBBBBB......',
        'WWWWW.BBB.BBBBBB.BBB.WWWWW',
        '......BBB.BBBBBB.BBB......',
        '..WWW.BBBBBBBBBBBBBB.WWW..',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
    {
      id: 's2', name: 'Square eyes', idea: 's1 with eyes two pixels wide: squarer, rounder-looking eyes.',
      rows: [
        '......BBBBBBBBBBBBBB......',
        'WWWWW.BB..BBBBBB..BB.WWWWW',
        '......BB..BBBBBB..BB......',
        '..WWW.BBBBBBBBBBBBBB.WWW..',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
    {
      id: 's3', name: 'Low eyes', idea: 's1 with the eyes dropped a pixel: a taller forehead, a younger face.',
      rows: [
        '......BBBBBBBBBBBBBB......',
        'WWWWW.BBBBBBBBBBBBBB.WWWWW',
        '......BBB.BBBBBB.BBB......',
        '..WWW.BBB.BBBBBB.BBB.WWW..',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
    {
      id: 's4', name: 'Close eyes', idea: 's1 with the eyes drawn in toward the middle.',
      rows: [
        '......BBBBBBBBBBBBBB......',
        'WWWWW.BBBBB.BB.BBBBB.WWWWW',
        '......BBBBB.BB.BBBBB......',
        '..WWW.BBBBBBBBBBBBBB.WWW..',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
    {
      id: 's5', name: 'Oval', idea: 's1 with the top and bottom pulled in: a rounder, softer head.',
      rows: [
        '........BBBBBBBBBB........',
        'WWWWW.BBB.BBBBBB.BBB.WWWWW',
        '......BBB.BBBBBB.BBB......',
        '..WWW.BBBBBBBBBBBBBB.WWW..',
        '........BBBBBBBBBB........',
        '..........T....T..........',
      ],
    },
    {
      id: 's6', name: 'Chunky', idea: 'Wider still, 16 pixels, with square eyes: the boldest silhouette.',
      rows: [
        '.....BBBBBBBBBBBBBBBB.....',
        'WWWW.BBB..BBBBBB..BBB.WWWW',
        '.....BBB..BBBBBB..BBB.....',
        '.WWW.BBBBBBBBBBBBBBBB.WWW.',
        '......BBBBBBBBBBBBBB......',
        '........T........T........',
      ],
    },
    {
      id: 's7', name: 'Attached', idea: 's1 with the speed lines joined to the body, the way the Claude mark joins its arms.',
      rows: [
        '......BBBBBBBBBBBBBB......',
        'WWWWWWBBB.BBBBBB.BBBWWWWWW',
        '......BBB.BBBBBB.BBB......',
        '...WWWBBBBBBBBBBBBBBWWW...',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
    {
      id: 's8', name: 'One color', idea: 's1 in a single flat color, wings and all, like the Claude mark.',
      rows: [
        '......BBBBBBBBBBBBBB......',
        'MMMMM.BBB.BBBBBB.BBB.MMMMM',
        '......BBB.BBBBBB.BBB......',
        '..MMM.BBBBBBBBBBBBBB.MMM..',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
    {
      id: 's9', name: 'Smile', idea: 's1 with a small mouth under the eyes.',
      rows: [
        '......BBBBBBBBBBBBBB......',
        'WWWWW.BBB.BBBBBB.BBB.WWWWW',
        '......BBB.BBBBBB.BBB......',
        '..WWW.BBBBBB..BBBBBB.WWW..',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
    {
      id: 's10', name: 'Antennae', idea: 's1 with two short antennae: one row taller, more plainly an insect.',
      rows: [
        '........T........T........',
        '.......T..........T.......',
        '......BBBBBBBBBBBBBB......',
        'WWWWW.BBB.BBBBBB.BBB.WWWWW',
        '......BBB.BBBBBB.BBB......',
        '..WWW.BBBBBBBBBBBBBB.WWW..',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
  ].map(v => ({ ...v, round: 4, beat: lift(v.rows) })),
  // ----------------------------------------------------------------- round 5: s7's joined wings with s10's antennae
  ...[
    {
      id: 'a1', name: 'Base', idea: 's7 and s10 together: joined speed-line wings, antennae leaning in.',
      rows: [
        '........T........T........',
        '.......T..........T.......',
        '......BBBBBBBBBBBBBB......',
        'WWWWWWBBB.BBBBBB.BBBWWWWWW',
        '......BBB.BBBBBB.BBB......',
        '...WWWBBBBBBBBBBBBBBWWW...',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
    {
      id: 'a2', name: 'Compact', idea: 'a1 cut to three rows, the Claude mark footprint: the antennae become two short nubs.',
      rows: [
        '.......T..........T.......',
        '......BBBBBBBBBBBBBB......',
        'WWWWWWBBB.BBBBBB.BBBWWWWWW',
        '......BBB.BBBBBB.BBB......',
        '...WWWBBBBBBBBBBBBBBWWW...',
        '.........T......T.........',
      ],
    },
    {
      id: 'a3', name: 'Curled', idea: 'a1 with the antennae rising straight, then curling outward at the tips.',
      rows: [
        '.......TT........TT.......',
        '.........T......T.........',
        '......BBBBBBBBBBBBBB......',
        'WWWWWWBBB.BBBBBB.BBBWWWWWW',
        '......BBB.BBBBBB.BBB......',
        '...WWWBBBBBBBBBBBBBBWWW...',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
    {
      id: 'a4', name: 'Splayed', idea: 'a1 with the antennae flaring outward instead of leaning in.',
      rows: [
        '.....TT............TT.....',
        '.......T..........T.......',
        '......BBBBBBBBBBBBBB......',
        'WWWWWWBBB.BBBBBB.BBBWWWWWW',
        '......BBB.BBBBBB.BBB......',
        '...WWWBBBBBBBBBBBBBBWWW...',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
    {
      id: 'a5', name: 'Raised wings', idea: 'a1 with the upper wing swept up at the tips, mid-beat.',
      rows: [
        '........T........T........',
        '.......T..........T.......',
        'WW....BBBBBBBBBBBBBB....WW',
        '..WWWWBBB.BBBBBB.BBBWWWW..',
        '......BBB.BBBBBB.BBB......',
        '...WWWBBBBBBBBBBBBBBWWW...',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
    {
      id: 'a6', name: 'Square eyes', idea: 'a1 with eyes two pixels wide.',
      rows: [
        '........T........T........',
        '.......T..........T.......',
        '......BBBBBBBBBBBBBB......',
        'WWWWWWBB..BBBBBB..BBWWWWWW',
        '......BB..BBBBBB..BB......',
        '...WWWBBBBBBBBBBBBBBWWW...',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
    {
      id: 'a7', name: 'Low eyes', idea: 'a1 with the eyes a pixel lower: more forehead under the antennae.',
      rows: [
        '........T........T........',
        '.......T..........T.......',
        '......BBBBBBBBBBBBBB......',
        'WWWWWWBBBBBBBBBBBBBBWWWWWW',
        '......BBB.BBBBBB.BBB......',
        '...WWWBBB.BBBBBB.BBBWWW...',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
    {
      id: 'a8', name: 'Chunky', idea: 'a1 on the 16-pixel body of s6, with square eyes.',
      rows: [
        '.........T........T.........',
        '........T..........T........',
        '......BBBBBBBBBBBBBBBB......',
        'WWWWWWBBB..BBBBBB..BBBWWWWWW',
        '......BBB..BBBBBB..BBB......',
        '...WWWBBBBBBBBBBBBBBBBWWW...',
        '.......BBBBBBBBBBBBBB.......',
        '.........T........T.........',
      ],
    },
    {
      id: 'a9', name: 'One color', idea: 'a1 in a single flat color, wings and all.',
      rows: [
        '........T........T........',
        '.......T..........T.......',
        '......BBBBBBBBBBBBBB......',
        'MMMMMMBBB.BBBBBB.BBBMMMMMM',
        '......BBB.BBBBBB.BBB......',
        '...MMMBBBBBBBBBBBBBBMMM...',
        '.......BBBBBBBBBBBB.......',
        '.........T......T.........',
      ],
    },
  ].map(v => ({ ...v, round: 5, beat: lift(v.rows) })),
]

// ======================================================================= rendering
const QUAD = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';')

/** Repeat every pixel `scale` times in both directions; 2 doubles the mark for the splash. */
export const scaleRows = (rows, scale = 1) => (scale > 1
  ? rows.flatMap(r => Array(scale).fill([...r].map(c => c.repeat(scale)).join('')))
  : rows)

/**
 * Draw one character cell from its four pixels.
 * @param keys - palette keys for the upper-left, upper-right, lower-left and lower-right pixel (`.` for none).
 * @returns `{ ch, style, miss }` with `style` an SGR parameter list, or `null` for an empty cell; `miss` marks a cell
 *   that mixes two inks with an empty pixel, which quadrant blocks cannot draw exactly.
 */
export function quadCell(keys) {
  const quad = keys.map(k => INK[k] ?? null)
  const inks = [...new Set(quad.filter(Boolean))]
  const mask = color => quad.reduce((m, q, i) => (q === color ? m | (1 << i) : m), 0)
  const count = m => m.toString(2).split('1').length - 1
  if (inks.length === 0) return null
  if (inks.length === 1) return { ch: QUAD[mask(inks[0])], style: `38;2;${rgb(inks[0])}` }
  if (inks.length === 2 && !quad.includes(null)) return { ch: QUAD[mask(inks[0])], style: `38;2;${rgb(inks[0])};48;2;${rgb(inks[1])}` }
  const top = [...inks].sort((p, q) => count(mask(q)) - count(mask(p)))[0]
  return { ch: QUAD[mask(top)], style: `38;2;${rgb(top)}`, miss: true }
}

/**
 * Render a pixel grid as quadrant-block lines.
 * @param rows - pixel rows.
 * @param scale - pixel repeat; 2 doubles the mark for the splash.
 * @returns `{ lines, misses }`, misses being the cells that mix two inks with an empty pixel.
 */
export function renderLogo(rows, scale = 1) {
  const grid = scaleRows(rows, scale)
  const width = Math.max(...grid.map(r => r.length))
  const at = (x, y) => grid[y]?.[x] ?? '.'
  const lines = [], misses = []
  for (let y = 0; y < grid.length; y += 2) {
    let line = ''
    for (let x = 0; x < width; x += 2) {
      const cell = quadCell([at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)])
      if (cell?.miss) misses.push(`row ${y / 2} col ${x / 2}`)
      line += cell ? `\x1b[${cell.style}m${cell.ch}\x1b[39;49m` : ' '
    }
    lines.push(line.replace(/ +$/, ''))
  }
  return { lines, misses }
}

// ======================================================================= gallery
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '')
const cells = s => [...strip(s)].length
const padTo = (s, n) => s + ' '.repeat(Math.max(0, n - cells(s)))
const fg = (hex, s) => `\x1b[38;2;${rgb(hex)}m${s}\x1b[39m`
const bold = s => `\x1b[1m${s}\x1b[22m`

function entry(logo, n, frame = 0) {
  const rows = frame % 2 && logo.beat ? logo.beat : logo.rows
  const small = renderLogo(rows).lines
  const large = renderLogo(rows, 2).lines
  // Header size beside the identity text, as the Claude Code header sets its mark; splash size to the right.
  const text = [bold(fg('#F5F5F7', 'mayfly')) + fg('#5C6476', ' v0.1.3'), fg('#9AA3B8', 'deepseek-chat · High'), fg('#9AA3B8', '~/dev/mayfly')]
  const smallW = Math.max(...small.map(cells))
  const left = Array.from({ length: Math.max(small.length, text.length) }, (_, i) => `${padTo(small[i] ?? '', smallW)}  ${text[i] ?? ''}`)
  const leftW = Math.max(42, ...left.map(cells)) + 4
  const out = [`  ${fg('#9A86E6', logo.id.padEnd(8))}${bold(fg('#EDEDF2', logo.name))}  ${fg('#9AA3B8', logo.idea)}`, '']
  for (let i = 0; i < Math.max(left.length, large.length); i++) out.push(`     ${padTo(left[i] ?? '', leftW)}${large[i] ?? ''}`)
  out.push('')
  return out
}

/** The candidates a gallery shows: one by id, every round with `--all`, else Hover S and the latest round. */
const shown = arg => (arg === '--all' ? LOGOS : arg ? LOGOS.filter(l => l.id === arg) : LOGOS.filter(l => l.id === 's7' || l.id === 's10' || l.round === 5))

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2]
  if (arg === '--check') {
    for (const logo of LOGOS) {
      const misses = [logo.rows, logo.beat].filter(Boolean).flatMap(rows => renderLogo(rows).misses)
      console.log(`${logo.id.padEnd(10)} ${misses.length ? `inexact cells: ${misses.join(', ')}` : 'exact'}`)
    }
  } else if (arg === '--animate') {
    // A wing beat is two frames; the beat runs fast for a moment, then the wings rest, as a hovering insect does.
    const picked = shown(process.argv[3]).filter(l => l.beat)
    const BEAT = [1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    let tick = 0
    process.stdout.write('\x1b[?1049h\x1b[?25l')
    const quit = () => { process.stdout.write('\x1b[?25h\x1b[?1049l'); process.exit(0) }
    process.on('SIGINT', quit)
    process.on('SIGTERM', quit)
    if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.on('data', d => (d[0] === 3 || d[0] === 113 ? quit() : null)) }
    setInterval(() => {
      const frame = BEAT[tick++ % BEAT.length]
      const lines = ['', ...picked.flatMap(l => entry(l, LOGOS.indexOf(l) + 1, frame)), '  q or Ctrl+C quits']
      process.stdout.write(`\x1b[H\x1b[2J${lines.join('\n')}`)
    }, 70)
  } else {
    const picked = shown(arg)
    const lines = ['', ...picked.flatMap(l => entry(l, LOGOS.indexOf(l) + 1))]
    process.stdout.write(`${lines.join('\n')}\n`)
  }
}
