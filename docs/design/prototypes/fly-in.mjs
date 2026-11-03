/**
 * The fly-in shared by the splash and banner mockups. The mark enters from outside its block, beating its wings,
 * slows into its slot along an eased path, beats twice and rests; a short trail of pixels fades behind it.
 *
 * A frame is a pure function of the time since the start, so any moment can be printed on its own (`--frame <ms>`)
 * and a replay is exact. The mark is drawn on a pixel canvas over the text: two pixels per cell across and down,
 * so it moves in half-cell steps.
 *
 * @module docs/design/prototypes/fly-in
 */

import { quadCell } from './logo-preview.mjs'

// ======================================================================= cells
const SGR_OR_CHAR = /\x1b\[([0-9;]*)m|([^\x1b])/gu

/**
 * Split an ANSI line into cells, each carrying its own SGR parameters.
 * @param line - the line, with truecolor SGR runs.
 * @param width - the cell count to pad or cut to.
 * @returns `{ ch, style }` per cell.
 */
export function toCells(line, width) {
  const out = []
  let fg = '', bg = '', bold = false, dim = false, inv = false
  for (const m of line.matchAll(SGR_OR_CHAR)) {
    if (m[2] !== undefined) {
      out.push({ ch: m[2], style: [bold && '1', dim && '2', inv && '7', fg, bg].filter(Boolean).join(';') })
      continue
    }
    const p = m[1] === '' ? [0] : m[1].split(';').map(Number)
    for (let i = 0; i < p.length; i++) {
      const v = p[i]
      if (v === 0) { fg = bg = ''; bold = dim = inv = false }
      else if (v === 1) bold = true
      else if (v === 2) dim = true
      else if (v === 22) bold = dim = false
      else if (v === 7) inv = true
      else if (v === 27) inv = false
      else if (v === 39) fg = ''
      else if (v === 49) bg = ''
      else if ((v === 38 || v === 48) && p[i + 1] === 2) {
        const color = `${v};2;${p.slice(i + 2, i + 5).join(';')}`
        if (v === 38) fg = color
        else bg = color
        i += 4
      }
    }
  }
  while (out.length < width) out.push({ ch: ' ', style: '' })
  return out.slice(0, width)
}

/** Join cells into a line, writing an SGR run only where the style changes and dropping trailing blanks. */
export function joinCells(cells) {
  let end = cells.length
  while (end > 0 && cells[end - 1].ch === ' ' && cells[end - 1].style === '') end--
  let out = '', last = ''
  for (const c of cells.slice(0, end)) {
    if (c.style !== last) { out += `\x1b[0m${c.style ? `\x1b[${c.style}m` : ''}`; last = c.style }
    out += c.ch
  }
  return last ? `${out}\x1b[0m` : out
}

// ======================================================================= canvas
/** Draw pixel rows onto a canvas (a Map of `x,y` to palette key) with the upper-left pixel at `(x0, y0)`. */
export function stamp(canvas, rows, x0, y0) {
  rows.forEach((row, y) => [...row].forEach((k, x) => { if (k !== '.') canvas.set(`${x0 + x},${y0 + y}`, k) }))
}

/**
 * Lay pixels over text lines.
 * @param lines - the text.
 * @param canvas - pixels drawn on top of the text; pixels outside the lines are dropped.
 * @param width - the viewport width in cells.
 * @param visible - which text cells show, as `(col, row) => boolean`; the rest are blank.
 * @param under - pixels drawn only where no text shows, so a trail never covers a letter.
 */
export function composite(lines, canvas, width, { visible = () => true, under = new Map() } = {}) {
  const quad = (layer, cx, cy) => {
    const keys = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => layer.get(`${2 * cx + dx},${2 * cy + dy}`) ?? '.')
    return keys.some(k => k !== '.') ? quadCell(keys) : null
  }
  return lines.map((line, cy) => {
    const cells = toCells(line, width)
    for (let cx = 0; cx < width; cx++) {
      if (!visible(cx, cy)) cells[cx] = { ch: ' ', style: '' }
      const sprite = quad(canvas, cx, cy) ?? (cells[cx].ch === ' ' ? quad(under, cx, cy) : null)
      if (sprite) cells[cx] = sprite
    }
    return joinCells(cells)
  })
}

// ======================================================================= motion
const easeOut = u => 1 - (1 - u) ** 2

/**
 * Where the mark is at time `t`: an ease-out from `from` to `to`, lifted by `arc` pixels mid-flight, bobbing by
 * `bob` pixels while it is fast. Positions are whole pixels.
 */
export function flight(t, { from, to, duration, arc = 0, bob = 0 }) {
  const u = Math.min(1, Math.max(0, t / duration))
  const e = easeOut(u)
  const x = from[0] + (to[0] - from[0]) * e
  const y = from[1] + (to[1] - from[1]) * e - arc * Math.sin(Math.PI * e) + bob * Math.sin(t / 45) * (1 - e)
  return { x: Math.round(x), y: Math.round(y) }
}

/** Whether the wings are up at time `t`: a fast beat in flight, then two slow beats after landing, then rest. */
export function wingsUp(t, duration) {
  if (t < duration) return Math.floor(t / 55) % 2 === 1
  const after = t - duration
  return (after >= 110 && after < 190) || (after >= 300 && after < 380)
}

const jitter = n => (((n * 9301 + 49297) % 233280) + 233280) % 233280 / 233280

/**
 * The fading trail: pixels dropped at fixed points along the path, each fading through three inks and gone after
 * four steps. Points are sampled at fixed times, so a dropped pixel stays put while the mark moves on.
 * @param t - time since the start.
 * @param duration - the flight time; the trail stops a little before landing.
 * @param emit - `(time, n) => [[x, y], …]`, the pixels dropped at a sample time; `n` seeds their scatter.
 * @returns `[x, y, ink]` per pixel.
 */
export function trail(t, duration, emit) {
  const STEP = 45
  const now = Math.floor(t / STEP)
  const out = []
  for (let k = 1; k <= 4; k++) {
    const ts = (now - k) * STEP
    if (ts < 0 || ts >= duration * 0.65) continue
    const ink = k === 1 ? 'a' : k === 2 ? 'b' : 'c'
    for (const [x, y] of emit(ts, now - k)) out.push([x, y, ink])
  }
  return out
}
export { jitter }

// ======================================================================= player
/**
 * Play frames in the terminal. A full-screen player draws on the alternate screen; an inline one redraws its block
 * in place, the way the banner sits in the transcript. After the last frame, `r` replays and `q` quits.
 * Without a terminal, prints the last frame and returns.
 * @param frameAt - `t => lines`; every frame has the same line count.
 * @param total - the animation length in milliseconds.
 * @param fullscreen - alternate screen instead of inline.
 */
export function play(frameAt, total, { fullscreen = false } = {}) {
  const out = process.stdout
  if (!out.isTTY || !process.stdin.isTTY) { out.write(`${frameAt(total).join('\n')}\n`); return }
  let drawn = 0, start = 0, timer = null
  const draw = lines => {
    const head = fullscreen ? '\x1b[H' : drawn ? `\x1b[${drawn}A\r` : ''
    out.write(`${head}${lines.map(l => `\x1b[2K${l}`).join('\n')}${fullscreen ? '\x1b[J' : '\n'}`)
    drawn = lines.length
  }
  const run = () => {
    clearInterval(timer)
    start = Date.now()
    timer = setInterval(() => {
      const t = Math.min(total, Date.now() - start)
      draw(frameAt(t))
      if (t >= total) clearInterval(timer)
    }, 33)
  }
  const quit = () => {
    clearInterval(timer)
    out.write(`\x1b[0m\x1b[?25h${fullscreen ? '\x1b[?1049l' : ''}`)
    process.stdin.setRawMode(false)
    process.exit(0)
  }
  out.write(`${fullscreen ? '\x1b[?1049h' : ''}\x1b[?25l`)
  process.stdin.setRawMode(true)
  process.stdin.on('data', d => { const k = d.toString(); if (k === 'r') run(); else if (k === 'q' || k === '\x03') quit() })
  process.on('SIGTERM', quit)
  run()
}
