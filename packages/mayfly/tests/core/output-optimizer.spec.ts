/**
 * Alternate-screen output optimizer: frame grammar, no-op and changed-row
 * filtering, scroll-region shifts, pass-through safety, a real pi-tui frame
 * pin, and a deterministic grid property against two headless xterms.
 */

import { describe, expect, it } from 'vitest'
import { TuiAltScreen } from '@earendil-works/pi-tui'
import { createOutputOptimizer } from '../../src/core/output-optimizer.ts'
import { FakeTerminal } from './fake-terminal.ts'
import { VtAltTerminal } from './vt-alt-terminal.ts'

const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'
const HIDE = '\x1b[?25l'
const SHOW = '\x1b[?25h'
const ERASE = '\x1b[2K'
const OSC8_CLOSE = '\x1b]8;;\x07'
const ROW_WRITE = /\x1b\[\d+;1H\x1b\[2K/g

const row = (number: number, line: string): string => `\x1b[${String(number)};1H${ERASE}${line}`
const frame = (body: readonly string[], tail = HIDE): string => `${BSU}${body.join('')}${tail}${ESU}`
const fullFrame = (lines: readonly string[], tail = HIDE): string => {
  return frame([`\x1b[2J`, ...lines.map((line, index) => row(index + 1, line))], tail)
}
const rowWrites = (output: string): number => [...output.matchAll(ROW_WRITE)].length

function primed(columns: number, lines: readonly string[]): { readonly host: FakeTerminal, readonly optimizer: ReturnType<typeof createOutputOptimizer> } {
  const host = new FakeTerminal(columns, lines.length)
  const optimizer = createOutputOptimizer(host)
  optimizer.write(fullFrame(lines))
  return { host, optimizer }
}

describe('createOutputOptimizer', () => {
  it('invalidates the shadow when a direct screen mutation writes outside the frame grammar', () => {
    const { host, optimizer } = primed(20, ['alpha', 'beta'])
    const mark = host.written.length
    optimizer.clearLine()
    expect(optimizer.diagnostics.shadow).toEqual([])
    // The next partial frame is not reconstructed from a screen the clear changed: it passes through untouched.
    optimizer.write(frame([row(1, 'changed')], HIDE))
    expect(host.written.slice(mark).join('')).toContain('changed')
    expect(optimizer.diagnostics.shadow).toEqual([])
    // A frame that rewrites every row starts a new trusted screen.
    optimizer.write(fullFrame(['one', 'two']))
    expect(optimizer.diagnostics.shadow).toEqual(['one', 'two'])
  })

  it('drops a no-op frame without writing a row, and drops an empty one entirely', () => {
    const lines = ['alpha', 'beta', 'gamma', 'delta']
    const { host, optimizer } = primed(20, lines)
    expect(optimizer.diagnostics.shadow).toEqual(lines)

    const mark = host.written.length
    optimizer.write(frame([], HIDE))
    const noop = host.written.slice(mark).join('')
    expect(noop).not.toMatch(ROW_WRITE)
    expect(noop).toContain(HIDE)
    expect(optimizer.diagnostics.noopFrames).toBe(1)

    const beforeDrop = host.written.length
    optimizer.write(`${BSU}${ESU}`)
    expect(host.written.length).toBe(beforeDrop)
    expect(optimizer.diagnostics.noopFrames).toBe(2)
  })

  it('writes no row when a repeated row write leaves the screen identical, but keeps the cursor', () => {
    const lines = ['alpha', 'beta', 'gamma', 'delta']
    const { host, optimizer } = primed(20, lines)
    const mark = host.written.length
    optimizer.write(frame([row(2, 'beta')], HIDE))
    const output = host.written.slice(mark).join('')
    expect(rowWrites(output)).toBe(0)
    // beta is four cells wide: the renderer's last row write would leave the cursor at 1;5H.
    expect(output).toContain('\x1b[2;5H')
    expect(optimizer.diagnostics.noopFrames).toBe(1)
  })

  it('writes exactly the one changed row', () => {
    const lines = ['alpha', 'beta', 'gamma', 'delta']
    const { host, optimizer } = primed(20, lines)
    const mark = host.written.length
    optimizer.write(frame([row(3, 'changed')], HIDE))
    const output = host.written.slice(mark).join('')
    expect(rowWrites(output)).toBe(1)
    expect(output).toContain(row(3, 'changed'))
    expect(optimizer.diagnostics.changedFrames).toBe(1)
    expect(optimizer.diagnostics.shadow[2]).toBe('changed')
  })

  it('turns a scroll-up band into a region shift plus the new bottom row', () => {
    const previous = ['header', 'a', 'b', 'c', 'd', 'e', 'f', 'footer']
    const next = ['header', 'b', 'c', 'd', 'e', 'f', 'g', 'footer']
    const { host, optimizer } = primed(20, previous)
    const mark = host.written.length
    optimizer.write(frame(next.slice(1, 7).map((line, index) => row(index + 2, line)), HIDE))
    const output = host.written.slice(mark).join('')
    expect(output).toContain('\x1b[2;7r\x1b[1S\x1b[r')
    expect(rowWrites(output)).toBe(1)
    expect(output).toContain(row(7, 'g'))
    expect(output).not.toContain(row(2, 'b'))
    expect(optimizer.diagnostics.shiftedFrames).toBe(1)
    expect(optimizer.diagnostics.shadow).toEqual(next)
  })

  it('turns a scroll-down band into a region shift plus the new top row', () => {
    const previous = ['header', 'a', 'b', 'c', 'd', 'e', 'f', 'footer']
    const next = ['header', 'z', 'a', 'b', 'c', 'd', 'e', 'footer']
    const { host, optimizer } = primed(20, previous)
    const mark = host.written.length
    optimizer.write(frame(next.slice(1, 7).map((line, index) => row(index + 2, line)), HIDE))
    const output = host.written.slice(mark).join('')
    expect(output).toContain('\x1b[2;7r\x1b[1T\x1b[r')
    expect(rowWrites(output)).toBe(1)
    expect(output).toContain(row(2, 'z'))
    expect(output).not.toContain(row(7, 'e'))
    expect(optimizer.diagnostics.shiftedFrames).toBe(1)
    expect(optimizer.diagnostics.shadow).toEqual(next)
  })

  it('reproduces a hidden pending-wrap cursor when the shift moves the last written row', async () => {
    const naive = new VtAltTerminal(10, 6)
    const optimized = new VtAltTerminal(10, 6)
    const optimizer = createOutputOptimizer(optimized)
    const startup = '\x1b[?7l\x1b[2J'
    naive.write(startup)
    optimized.write(startup)
    const previous = ['hdr.......', 'aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd', 'ftr.......']
    const full = fullFrame(previous, HIDE)
    naive.write(full)
    optimizer.write(full)
    // The scroll-down moves the renderer's last written row (row 5) down; the
    // new top row is shorter. The hidden cursor still lands one column past
    // the last cell, so the optimizer replays the last row write to restore it.
    const next = ['hdr.......', 'newtop...', 'aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'ftr.......']
    const partial = frame(next.slice(1, 5).map((line, index) => row(index + 2, line)), HIDE)
    naive.write(partial)
    optimizer.write(partial)
    expect(await optimized.activeRows()).toEqual(await naive.activeRows())
    expect(await optimized.activeCursor()).toEqual(await naive.activeCursor())
    expect(await optimized.activeCursor()).toEqual({ x: 10, y: 4 })
    expect(optimizer.diagnostics.shiftedFrames).toBe(1)
    naive.dispose()
    optimized.dispose()
  })

  it('passes unknown OSC bytes through unchanged and invalidates the shadow', () => {
    const { host, optimizer } = primed(20, ['one', 'two', 'three', 'four'])
    const image = '\x1b]1337;File=inline=1;base64,AAAA\x07'
    const mark = host.written.length
    optimizer.write(image)
    expect(host.written.slice(mark).join('')).toBe(image)
    expect(optimizer.diagnostics.shadow).toEqual([])
    expect(optimizer.diagnostics.passthroughFrames).toBe(1)

    // An untrusted shadow cannot be patched by a partial frame: it passes too.
    const partial = frame([row(1, 'patched')], HIDE)
    const partialMark = host.written.length
    optimizer.write(partial)
    expect(host.written.slice(partialMark).join('')).toBe(partial)
    expect(optimizer.diagnostics.passthroughFrames).toBe(2)
  })

  it('passes DCS, other private modes, and unknown CSI through unchanged', () => {
    const { host, optimizer } = primed(20, ['one', 'two', 'three', 'four'])
    for (const unknown of ['\x1bP1;2;3qpayload\x1b\\', '\x1b[?1049h', '\x1b[99X']) {
      const mark = host.written.length
      optimizer.write(unknown)
      expect(host.written.slice(mark).join('')).toBe(unknown)
      expect(optimizer.diagnostics.shadow).toEqual([])
    }
  })

  it('passes a 2J full repaint through and rebuilds the shadow', () => {
    const { host, optimizer } = primed(20, ['one', 'two', 'three', 'four'])
    optimizer.write('\x1b]0;title\x07')
    expect(optimizer.diagnostics.shadow).toEqual([])
    const lines = ['red', 'green', 'blue', 'black']
    const full = fullFrame(lines, SHOW)
    const mark = host.written.length
    optimizer.write(full)
    expect(host.written.slice(mark).join('')).toBe(full)
    expect(optimizer.diagnostics.shadow).toEqual(lines)
    expect(optimizer.diagnostics.fullRepaintFrames).toBe(2)
  })

  it('accepts the exact frame shape the alternate-screen renderer emits', () => {
    const record = new FakeTerminal(40, 6)
    const tui = new TuiAltScreen(record)
    tui.children.push({ render: () => ['row one', 'row two'], invalidate: () => {} })
    tui.start()
    tui.renderNow(true)
    tui.stop()
    const captured = record.written.find(write => write.includes(BSU) && write.includes('\x1b[2J'))
    expect(captured).toBeDefined()
    // Pin the pieces the parser relies on: if the renderer changes any of
    // them, this capture (or the optimized change below) fails loudly.
    expect(captured).toContain(BSU)
    expect(captured).toContain(ESU)
    expect(captured).toMatch(/\x1b\[\d+;1H\x1b\[2K/)
    expect(captured).toMatch(/\x1b\[\?25[hl]/)
    expect(captured).toContain(OSC8_CLOSE)

    const host = new FakeTerminal(40, 6)
    const optimizer = createOutputOptimizer(host)
    optimizer.write(captured!)
    expect(optimizer.diagnostics.fullRepaintFrames).toBe(1)
    expect(optimizer.diagnostics.passthroughFrames).toBe(0)
    expect(optimizer.diagnostics.shadow).toHaveLength(6)
    expect(optimizer.diagnostics.shadow[0]).toContain('row one')
    expect(optimizer.diagnostics.shadow[1]).toContain('row two')

    const mark = host.written.length
    optimizer.write(`${BSU}${row(1, 'row one')}${row(1, 'row one changed')}${HIDE}${ESU}`)
    const output = host.written.slice(mark).join('')
    expect(rowWrites(output)).toBe(1)
    expect(output).toContain(row(1, 'row one changed'))
  })

  it('passes a write through when the terminal reports no valid height', () => {
    const host = new FakeTerminal(20, 4)
    const optimizer = createOutputOptimizer(host)
    host.resize(20, 0)
    optimizer.write('anything')
    expect(optimizer.diagnostics.passthroughFrames).toBe(1)
    expect(host.written.at(-1)).toBe('anything')
  })

  it('delegates the terminal lifecycle and facade reads', async () => {
    const host = new FakeTerminal(20, 4)
    const optimizer = createOutputOptimizer(host)
    optimizer.start(() => {}, () => {})
    expect(host.startCount).toBe(1)
    await optimizer.drainInput(10, 2)
    expect(host.drainCount).toBe(1)
    expect(optimizer.columns).toBe(20)
    expect(optimizer.rows).toBe(4)
    expect(optimizer.kittyProtocolActive).toBe(false)
    optimizer.moveBy(2)
    optimizer.hideCursor()
    optimizer.showCursor()
    optimizer.clearLine()
    optimizer.clearFromCursor()
    optimizer.clearScreen()
    optimizer.setTitle('title')
    optimizer.setProgress(true)
    optimizer.stop()
    expect(host.stopCount).toBe(1)
  })

  it('passes writes outside the frame grammar through and invalidates the shadow', () => {
    const host = new FakeTerminal(20, 4)
    const optimizer = createOutputOptimizer(host)
    const writes = [
      '',
      `${BSU}${row(1, 'a')}`,
      `${row(1, 'a')}${ESU}`,
      frame(['plain']),
      `${BSU}abc${ESU}`,
      `${BSU}abc\x1b[99X${ESU}`,
      `${BSU}\x1b[${ESU}`,
      `${BSU}${HIDE}${row(1, 'a')}${ESU}`,
      `${BSU}${row(0, 'a')}${ESU}`,
      `${BSU}${row(5, 'a')}${ESU}`,
      `${BSU}${row(1, 'a')}\x1b[2J${ESU}`,
      `${BSU}${HIDE}\x1b[2J${ESU}`,
      `${BSU}text\x1b[2J${ESU}`,
    ]
    for (const write of writes) optimizer.write(write)
    expect(optimizer.diagnostics.passthroughFrames).toBe(writes.length)
    expect(host.written.join('')).toBe(writes.join(''))
    expect(optimizer.diagnostics.shadow).toEqual([])
  })

  it('rebuilds a lost shadow from a frame that writes every row, and passes a partial frame through', () => {
    const host = new FakeTerminal(20, 4)
    const optimizer = createOutputOptimizer(host)
    const lines = ['one', 'two', 'three', 'four']
    const complete = frame(lines.map((line, index) => row(index + 1, line)))
    optimizer.write(complete)
    expect(optimizer.diagnostics.fullRepaintFrames).toBe(1)
    expect(optimizer.diagnostics.passthroughFrames).toBe(0)
    expect(optimizer.diagnostics.shadow).toEqual(lines)
    expect(host.written.at(-1)).toBe(complete)

    // The terminal grew without a repaint: the shadow no longer matches and a
    // partial frame cannot start a new one.
    host.resize(20, 5)
    const partial = frame([row(1, 'patched')])
    optimizer.write(partial)
    expect(optimizer.diagnostics.passthroughFrames).toBe(1)
    expect(host.written.at(-1)).toBe(partial)
    expect(optimizer.diagnostics.shadow).toEqual([])

    const empty = `${BSU}${ESU}`
    optimizer.write(empty)
    expect(optimizer.diagnostics.passthroughFrames).toBe(2)
    expect(optimizer.diagnostics.shadow).toEqual([])
  })

  it('shifts a band with no unexplained rows through a scroll region alone', () => {
    const previous = ['a', 'b', 'c', '']
    const { host, optimizer } = primed(20, previous)
    const mark = host.written.length
    optimizer.write(frame([row(1, 'b'), row(2, 'c'), row(3, '')], HIDE))
    const output = host.written.slice(mark).join('')
    expect(output).toContain('\x1b[1;3r\x1b[1S\x1b[r')
    expect(rowWrites(output)).toBe(0)
    expect(optimizer.diagnostics.shiftedFrames).toBe(1)
    expect(optimizer.diagnostics.shadow).toEqual(['b', 'c', '', ''])
  })

  it('keeps a pending-wrap cursor on an unchanged wide row without replaying it', () => {
    const wide = 'x'.repeat(10)
    const { host, optimizer } = primed(10, [wide, 'b', 'c', 'd'])
    const mark = host.written.length
    optimizer.write(frame([row(1, wide)], HIDE))
    const output = host.written.slice(mark).join('')
    expect(rowWrites(output)).toBe(0)
    expect(output).toBe(`${BSU}${HIDE}${ESU}`)
    expect(optimizer.diagnostics.noopFrames).toBe(1)
  })

  it('accepts the OSC 8 close in both terminators and rejects malformed OSC sequences', () => {
    const host = new FakeTerminal(20, 4)
    const optimizer = createOutputOptimizer(host)
    optimizer.write(fullFrame(['one', 'two', 'three', 'four']))
    const stClose = `\x1b]8;;\x1b\\`
    optimizer.write(frame([row(1, `linked${stClose}`)], HIDE))
    expect(optimizer.diagnostics.shadow[0]).toBe(`linked${stClose}`)

    for (const bad of [`${BSU}${row(1, 'x\x1b]8;;a\x1bZ')}${ESU}`, `${BSU}${row(1, 'x\x1b]8;;unterminated')}${ESU}`, `${BSU}\x1b]8;;\x07${ESU}`]) {
      const before = optimizer.diagnostics.passthroughFrames
      optimizer.write(bad)
      expect(optimizer.diagnostics.passthroughFrames).toBe(before + 1)
    }
  })
})

const WIDTH = 120
const HEIGHT = 40
const ITERATIONS = 200
const GLYPHS = ['a', 'b', 'c', 'd', 'e', 'f', ' ', '|', '-', '界', '語', '中', '日']

/** Deterministic PRNG (mulberry32): every run paints the same 200 frames. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** One screen row: ASCII, wide CJK, SGR, and the pi-tui line-reset shape (at most 98 cells). */
function makeLine(index: number, salt: number): string {
  const length = 8 + ((index * 13 + salt * 7) % 42)
  let text = ''
  for (let position = 0; position < length; position += 1) {
    text += GLYPHS[(index + salt + position * 3) % GLYPHS.length]
  }
  const bold = index % 4 === 0 ? '1;' : ''
  const underline = index % 6 === 0 ? '4;' : ''
  const foreground = 30 + (index % 8)
  const background = 40 + ((index + salt) % 8)
  return `\x1b[${bold}${underline}${foreground};${background}m${text}\x1b[0m${OSC8_CLOSE}`
}

/** The next screen: a row edit, a shift up/down inside a band, an append, or a no-op. */
function mutate(screen: readonly string[], random: () => number, salt: number): string[] {
  const next = [...screen]
  const operation = Math.floor(random() * 5)
  if (operation === 0) {
    const count = 1 + Math.floor(random() * 4)
    for (let index = 0; index < count; index += 1) {
      const target = Math.floor(random() * HEIGHT)
      next[target] = makeLine(target, salt)
    }
    return next
  }
  const top = Math.floor(random() * 6)
  const bottom = HEIGHT - 1 - Math.floor(random() * 6)
  const distance = 1 + Math.floor(random() * 5)
  if (operation === 1 || operation === 2) {
    if (bottom - top <= distance) return next
    if (operation === 1) {
      for (let line = top; line <= bottom - distance; line += 1) next[line] = screen[line + distance]!
      for (let line = bottom - distance + 1; line <= bottom; line += 1) next[line] = makeLine(line, salt)
    } else {
      for (let line = bottom; line >= top + distance; line -= 1) next[line] = screen[line - distance]!
      for (let line = top; line < top + distance; line += 1) next[line] = makeLine(line, salt)
    }
  } else if (operation === 3) {
    if (bottom <= top) return next
    for (let line = top; line < bottom; line += 1) next[line] = screen[line + 1]!
    next[bottom] = makeLine(bottom, salt)
  }
  return next
}

/** One pi-tui-shaped frame: a synchronized wrapper, an optional full clear, changed rows, and a cursor tail. */
function renderFrame(
  next: readonly string[],
  previous: readonly string[],
  full: boolean,
  random: () => number,
): string {
  const writes: string[] = []
  if (full) {
    writes.push('\x1b[2J')
    for (let line = 0; line < HEIGHT; line += 1) writes.push(row(line + 1, next[line]!))
  } else {
    for (let line = 0; line < HEIGHT; line += 1) {
      if (next[line] !== previous[line]) writes.push(row(line + 1, next[line]!))
    }
  }
  const roll = random()
  const cursor = `\x1b[${String(1 + Math.floor(random() * HEIGHT))};${String(1 + Math.floor(random() * WIDTH))}H`
  const tail = roll < 0.3 ? `${cursor}${SHOW}` : roll < 0.6 ? `${cursor}${HIDE}` : HIDE
  return frame(writes, tail)
}

describe('output optimizer grid property', () => {
  it('matches the naive renderer on 200 deterministic random frames', async () => {
    const random = mulberry32(0x5eed)
    const naive = new VtAltTerminal(WIDTH, HEIGHT)
    const optimized = new VtAltTerminal(WIDTH, HEIGHT)
    const optimizer = createOutputOptimizer(optimized)
    // The alternate screen disables autowrap; both terminals must see the
    // same startup bytes before the first synchronized frame.
    const startup = '\x1b[?1049h\x1b[?7l\x1b[2J'
    naive.write(startup)
    optimized.write(startup)

    let screen = Array.from({ length: HEIGHT }, (_, index) => makeLine(index, 0))
    let previous = screen
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const full = iteration === 0 || iteration % 47 === 0
      const next = iteration === 0 ? screen : mutate(screen, random, iteration + 1)
      const bytes = renderFrame(next, previous, full, random)
      naive.write(bytes)
      optimizer.write(bytes)
      const expected = await naive.snapshot()
      const actual = await optimized.snapshot()
      expect(actual.type, `buffer at ${String(iteration)}`).toBe('alternate')
      expect(actual.rows, `rows at ${String(iteration)}`).toEqual(expected.rows)
      expect(actual.cells, `cells at ${String(iteration)}`).toEqual(expected.cells)
      expect(actual.cursor, `cursor at ${String(iteration)}`).toEqual(expected.cursor)
      screen = next
      previous = next
    }
    expect(optimizer.diagnostics.passthroughFrames).toBe(0)
    expect(optimizer.diagnostics.shiftedFrames).toBeGreaterThan(0)
    expect(optimizer.diagnostics.noopFrames).toBeGreaterThan(0)
    naive.dispose()
    optimized.dispose()
  }, 30_000)
})
