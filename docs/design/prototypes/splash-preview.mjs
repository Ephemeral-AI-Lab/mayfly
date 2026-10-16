#!/usr/bin/env node
/**
 * Terminal mockup of Mayfly's launch screen: logo, slogan, recent sessions and the input box, stacked top to
 * bottom and centered. It is a design sketch to agree the look, not shipped rendering: it draws its own colors,
 * imports nothing from Mayfly, and reads no real sessions.
 *
 * On a terminal it opens with the fly-in (`fly-in.mjs`): the mark enters from the left edge along an arc, beating
 * its wings and dropping a fading trail, slows into its slot, beats twice and rests, while the wordmark and slogan
 * fade in under it. The session list and the input box are there from the first frame, so nothing waits on it.
 *
 *   node docs/design/prototypes/splash-preview.mjs                 the launch screen with the fly-in (r replays, q quits)
 *   node docs/design/prototypes/splash-preview.mjs --static        the launch screen, printed once
 *   node docs/design/prototypes/splash-preview.mjs --frame 600     one frame of the fly-in, at that millisecond
 *   node docs/design/prototypes/splash-preview.mjs --logo sail     the launch screen with another logo (ids in logo-preview.mjs)
 *   node docs/design/prototypes/splash-preview.mjs --scale 2       the logo at double size
 *   node docs/design/prototypes/splash-preview.mjs --focus         the recent-sessions list holds the keyboard
 *   node docs/design/prototypes/splash-preview.mjs --empty         first run: no sessions yet
 *   node docs/design/prototypes/splash-preview.mjs --width 44      a narrow terminal (default: the terminal, else 80)
 *   node docs/design/prototypes/splash-preview.mjs --height 30     the viewport height used to center vertically
 *
 * The palette is the brand dark scheme of `packages/mayfly/src/core/theme-dark.ts`.
 *
 * @module docs/design/prototypes/splash-preview
 */

import { LOGOS, renderLogo, scaleRows, lift } from './logo-preview.mjs'
import { composite, flight, jitter, play, stamp, trail, wingsUp } from './fly-in.mjs'

// ======================================================================= args
const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback }
const WIDTH = Number(opt('width', process.stdout.columns || 80))
const HEIGHT = Number(opt('height', process.stdout.rows || 30))
const LOGO = opt('logo', 's10').toLowerCase()
const SCALE = Number(opt('scale', 1))

// ======================================================================= palette (theme-dark)
const C = {
  text: '#EDEDF2', strong: '#F5F5F7', muted: '#9AA3B8', faint: '#5C6476',
  accent: '#C9C0F0', primary: '#9A86E6', border: '#45406B', borderFocus: '#DCD7F2',
  success: '#4ec87e', selectedBg: '#2b2b30',
}
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const mix = (a, b, u) => `#${rgb(a).map((v, i) => Math.round(v + (rgb(b)[i] - v) * u).toString(16).padStart(2, '0')).join('')}`
const fg = (hex, s) => `\x1b[38;2;${rgb(hex).join(';')}m${s}\x1b[39m`
const bold = s => `\x1b[1m${s}\x1b[22m`
const onBg = (hex, s) => `\x1b[48;2;${rgb(hex).join(';')}m${s}\x1b[49m`
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '')
const cells = s => [...strip(s)].length
const padTo = (s, n) => s + ' '.repeat(Math.max(0, n - cells(s)))
const clip = (s, n) => (cells(s) <= n ? s : n <= 1 ? '…'.slice(0, n) : `${[...s].slice(0, n - 1).join('')}…`)
const center = (s, width) => ' '.repeat(Math.max(0, Math.floor((width - cells(s)) / 2))) + s
/** Left text and right text on one row of `n` cells; when both do not fit, the right text is dropped. */
const split = (left, right, n) => (cells(left) + cells(right) + 2 > n ? left : padTo(left, n - cells(right)) + right)

// ======================================================================= launch screen
const SESSIONS = [
  { title: 'Redesign the launch screen', project: 'mayfly', age: 'running', live: true },
  { title: 'Archive sessions without a rescan', project: 'mayfly', age: '2h ago' },
  { title: 'Fix the flaky scheduler test', project: 'harness', age: 'yesterday' },
  { title: 'Port the dock overlay to panes', project: 'mayfly-dock', age: '3d ago' },
]

function sessionRows(w, { focus }) {
  const wide = w >= 56
  const ageW = 9, projectW = wide ? 14 : 0
  return SESSIONS.map((s, i) => {
    const selected = focus && i === 0
    const dot = s.live ? fg(C.success, '●') : fg(C.faint, '○')
    const marker = selected ? fg(C.accent, '›') : ' '
    const title = clip(s.title, w - 4 - projectW - ageW - 1)
    const titleCell = selected ? bold(fg(C.strong, title)) : fg(C.text, title)
    const project = wide ? padTo(fg(C.faint, s.project), projectW) : ''
    const age = ' '.repeat(ageW - cells(s.age)) + fg(s.live ? C.success : C.faint, s.age)
    const row = `${marker} ${dot} ${padTo(titleCell, w - 4 - projectW - ageW)}${project}${age}`
    return selected ? onBg(C.selectedBg, row) : row
  })
}

function inputBox(w, { focus }) {
  // The input holds the keyboard unless the list does: a bright violet frame and a caret, else a quiet frame.
  const paint = text => fg(focus ? C.border : C.primary, text)
  const inner = w - 4
  const caret = focus ? '' : '\x1b[7m \x1b[27m'
  const prompt = `${fg(C.primary, '❯')} ${caret}${fg(C.faint, clip('Ask anything, or type / for commands', inner - 3))}`
  return [
    paint(`╭${'─'.repeat(w - 2)}╮`),
    `${paint('│')} ${padTo(prompt, inner)} ${paint('│')}`,
    paint(`╰${'─'.repeat(w - 2)}╯`),
  ]
}

/**
 * The launch screen.
 * @param animating - leave the logo's rows blank: the fly-in draws the mark.
 * @param wordmark - how far the wordmark and slogan have faded in, 0 (not yet) to 3 (fully).
 * @returns the lines, and the logo's pixel rows and resting pixel position for the fly-in.
 */
function launchScreen({ animating = false, wordmark = 3 } = {}) {
  const w = Math.min(WIDTH - 4, 64)
  const focus = flag('focus')
  const logo = LOGOS.find(l => l.id === LOGO) ?? LOGOS[0]
  const scale = WIDTH < 50 ? 1 : SCALE
  const body = []

  const art = renderLogo(logo.rows, scale).lines
  const artW = Math.max(...art.map(cells))
  const artLeft = Math.max(0, Math.floor((WIDTH - artW) / 2))
  body.push(...art.map(l => (animating ? '' : center(padTo(l, artW), WIDTH))))
  body.push('')
  const fade = hex => (wordmark >= 3 ? hex : mix(C.faint, hex, wordmark === 2 ? 0.5 : 0))
  body.push(wordmark ? center(bold(fg(fade(C.primary), 'mayfly')), WIDTH) : '')
  body.push(wordmark ? center(fg(fade(C.accent), 'ephemeral agents, enduring works'), WIDTH) : '')
  body.push('')

  const lead = ' '.repeat(Math.floor((WIDTH - w) / 2))
  const block = lines => lines.map(l => lead + l)

  if (flag('empty')) {
    body.push(...block([
      fg(C.muted, 'No sessions here yet'),
      fg(C.faint, clip('Describe a task below to start one.', w)),
      '',
    ]))
  } else {
    body.push(...block([
      split(fg(C.muted, 'Recent sessions'), fg(C.faint, focus ? '↵ resume · esc back' : '↑ browse · /sessions all'), w),
      ...sessionRows(w, { focus }),
      '',
    ]))
  }
  body.push(...block(inputBox(w, { focus })))
  body.push(...block([
    split(fg(C.faint, 'deepseek-chat · High'), fg(C.faint, '~/dev/mayfly · main'), w),
  ]))

  const top = Math.max(0, Math.floor((HEIGHT - body.length) / 2))
  const lines = [...Array(top).fill(''), ...body].slice(0, Math.max(body.length, HEIGHT - 1))
  const rows = scaleRows(logo.rows, scale)
  const beat = scaleRows(logo.beat ?? lift(logo.rows), scale)
  return { lines, mark: { rows, beat, x: artLeft * 2, y: top * 2, w: rows[0].length, h: rows.length } }
}

// ======================================================================= fly-in
const FLY = 1200
const TOTAL = 1700

/** One frame of the splash fly-in at `t` milliseconds. */
function splashFrame(t) {
  const wordmark = t < 950 ? 0 : t < 1050 ? 1 : t < 1150 ? 2 : 3
  const { lines, mark } = launchScreen({ animating: true, wordmark })
  const path = { from: [-mark.w - 4, mark.y + 8], to: [mark.x, mark.y], duration: FLY, arc: 6, bob: 1 }
  const canvas = new Map()
  const drops = trail(t, FLY, (ts, n) => {
    const p = flight(ts, path)
    return [
      [p.x - 2 - Math.round(jitter(n) * 2), p.y + Math.round(mark.h / 2) + Math.round(jitter(n + 3) * 3) - 1],
      [p.x - 4 - Math.round(jitter(n + 7) * 3), p.y + 2 + Math.round(jitter(n + 11) * (mark.h - 3))],
    ]
  })
  const under = new Map(drops.map(([x, y, ink]) => [`${x},${y}`, ink]))
  const p = flight(t, path)
  stamp(canvas, wingsUp(t, FLY) ? mark.beat : mark.rows, p.x, p.y)
  return composite(lines, canvas, WIDTH, { under })
}

// ======================================================================= main
if (flag('static')) process.stdout.write(`${launchScreen().lines.join('\n')}\n`)
else if (opt('frame', null) !== null) process.stdout.write(`${splashFrame(Number(opt('frame', 0))).join('\n')}\n`)
else play(splashFrame, TOTAL, { fullscreen: true })
